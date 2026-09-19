import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';
import type { CoreEngine } from './engine.js';
import type { JobService } from './job-service.js';
import { currentJobOwner, type JobRecord } from './job-store.js';
import { JobTransactions } from './job-transactions.js';
import { ServiceError } from './result.js';
import type { TransactionManifest } from './transactions.js';
import type { TransactionExecutionResult } from './transaction-execution.js';
import { PACKAGE_VERSION } from '../version.js';
import { hashCanonical } from './canonical.js';
import { jobAnalysisCheckpoints, withAnalysisCheckpoints } from './analysis-checkpoints.js';

const jsonObject = z.record(z.string(), z.json());
export type JobOutput = z.infer<typeof jsonObject>;
export interface JobExecutionContext {
  engine: CoreEngine;
  workspaceId: string;
  principal: string | undefined;
  signal: AbortSignal;
  checkpoint: JobRecord['checkpoint'];
  progress(value: NonNullable<JobRecord['progress']>): Promise<void>;
  saveCheckpoint(value: NonNullable<JobRecord['checkpoint']>): Promise<void>;
  stageResult(
    result: JobOutput,
    value: Omit<NonNullable<JobRecord['checkpoint']>, 'cursor' | 'resultHash'>,
  ): Promise<void>;
}
type Operation =
  | { mutation: false; run(input: unknown, context: JobExecutionContext): Promise<JobOutput> }
  | {
      mutation: true;
      prepare(input: unknown, context: JobExecutionContext): Promise<ValidatedPreparedJobWrite>;
      complete(
        input: unknown,
        execution: TransactionExecutionResult,
        reconciled: boolean,
        recipe: JobOutput | undefined,
        context: JobExecutionContext,
      ): Promise<JobOutput>;
    };

export interface PreparedJobWrite {
  transaction: TransactionManifest;
  recipe?: unknown;
}

interface ValidatedPreparedJobWrite {
  transaction: TransactionManifest;
  recipe?: JobOutput;
}

function defaultWriteResult(execution: TransactionExecutionResult, reconciled: boolean): JobOutput {
  const artifacts = [
    ...execution.artifacts,
    ...(execution.transaction.executionArtifacts ?? []),
    ...execution.transaction.artifacts,
  ];
  return jsonObject.parse({
    execution: execution.outcome,
    reconciled,
    validationPassed: execution.transaction.validation.passed,
    artifacts,
    changedFiles:
      execution.outcome === 'applied'
        ? execution.transaction.files.map(({ relativePath }) => relativePath)
        : [],
  });
}

/** Typed core operations shared by a worker host, never MCP handlers or command strings. */
export class JobOperations {
  private readonly operations = new Map<string, Operation>();

  registerRead<Input>(
    name: string,
    schema: z.ZodType<Input>,
    run: (input: Input, context: JobExecutionContext) => Promise<JobOutput>,
  ): void {
    this.add(name, { mutation: false, run: (input, context) => run(schema.parse(input), context) });
  }

  registerWrite<Input>(
    name: string,
    schema: z.ZodType<Input>,
    prepare: (
      input: Input,
      context: JobExecutionContext,
    ) => Promise<TransactionManifest | PreparedJobWrite>,
    complete: (
      input: Input,
      execution: TransactionExecutionResult,
      reconciled: boolean,
      recipe: JobOutput | undefined,
      context: JobExecutionContext,
    ) => Promise<JobOutput> = (_input, execution, reconciled) =>
      Promise.resolve(defaultWriteResult(execution, reconciled)),
  ): void {
    this.add(name, {
      mutation: true,
      prepare: async (input, context) => {
        const prepared = await prepare(schema.parse(input), context);
        if (!('transaction' in prepared)) return { transaction: prepared };
        return {
          transaction: prepared.transaction,
          ...(prepared.recipe === undefined ? {} : { recipe: jsonObject.parse(prepared.recipe) }),
        };
      },
      complete: (input, execution, reconciled, recipe, context) =>
        complete(schema.parse(input), execution, reconciled, recipe, context),
    });
  }

  get(name: string): Operation {
    const operation = this.operations.get(name);
    if (operation === undefined)
      throw new ServiceError(
        'JOB_OPERATION_UNAVAILABLE',
        'No typed core operation is registered for this job',
      );
    return operation;
  }

  private add(name: string, operation: Operation): void {
    if (this.operations.has(name)) throw new Error(`Duplicate job operation: ${name}`);
    this.operations.set(name, operation);
  }
}

/** Durable execution coordination; CPU/process isolation is supplied by its worker host. */
export class JobExecutor {
  private readonly admissionOwner = {};
  constructor(
    private readonly engine: CoreEngine,
    private readonly jobs: JobService,
    private readonly operations: JobOperations,
  ) {}

  async run(workspaceId: string, id: string, principal?: string): Promise<JobRecord> {
    const initial = await this.jobs.get(workspaceId, id, principal);
    if (['completed', 'failed', 'cancelled'].includes(initial.status)) return initial;
    const operation = this.operations.get(initial.request.toolName);
    if (operation.mutation !== initial.request.mutation)
      throw new ServiceError(
        'JOB_OPERATION_MISMATCH',
        'The registered operation does not match the persisted write policy',
      );
    if (initial.toolVersion !== PACKAGE_VERSION)
      throw new ServiceError(
        'JOB_VERSION_MISMATCH',
        'This job requires its recorded tool version for execution',
      );
    const scope = this.jobs.scope(workspaceId, principal);
    const owner = currentJobOwner();
    let claimed;
    try {
      claimed = await this.jobs.store.claim(scope, id, owner);
    } catch (error) {
      if (
        error instanceof ServiceError &&
        ['JOB_OWNER_ACTIVE', 'JOB_TERMINAL'].includes(error.code)
      )
        return this.jobs.get(workspaceId, id, principal);
      throw error;
    }
    if (claimed.record.status === 'cancelled') return claimed.record;
    if (
      !operation.mutation &&
      claimed.record.result !== undefined &&
      claimed.record.checkpoint?.cursor === 'result-ready' &&
      claimed.record.checkpoint.resultHash === hashCanonical(claimed.record.result)
    )
      return this.jobs.store.updateOwned(scope, id, owner.token, {
        status: 'completed',
        result: claimed.record.result,
      });
    const controller = new AbortController();
    const watchStop = new AbortController();
    let watchFailure: unknown;
    const watch = (async () => {
      while (!watchStop.signal.aborted) {
        const current = await this.jobs.get(workspaceId, id, principal);
        if (current.cancelRequested) {
          controller.abort(new DOMException('Job cancelled', 'AbortError'));
          return;
        }
        if (current.owner?.token !== owner.token)
          throw new ServiceError('JOB_OWNER_CHANGED', 'The execution attempt lost ownership');
        await delay(250, undefined, { signal: watchStop.signal });
      }
    })().catch((error: unknown) => {
      if (watchStop.signal.aborted) return;
      watchFailure = error;
      controller.abort(error);
    });
    const context: JobExecutionContext = {
      engine: this.engine,
      workspaceId,
      principal,
      signal: controller.signal,
      checkpoint: claimed.record.checkpoint,
      progress: async (progress) => {
        await this.jobs.store.updateOwned(scope, id, owner.token, { progress }, controller.signal);
      },
      saveCheckpoint: async (checkpoint) => {
        await this.jobs.store.updateOwned(
          scope,
          id,
          owner.token,
          { checkpoint },
          controller.signal,
        );
      },
      stageResult: async (result, checkpoint) => {
        await this.jobs.store.updateOwned(
          scope,
          id,
          owner.token,
          {
            result,
            checkpoint: {
              ...checkpoint,
              cursor: 'result-ready',
              resultHash: hashCanonical(result),
            },
          },
          controller.signal,
        );
      },
    };
    try {
      return await this.engine.requests.run(
        this.admissionOwner,
        Buffer.byteLength(JSON.stringify(initial.request)),
        controller.signal,
        () =>
          this.engine.sharedRequests.run(controller.signal, async () => {
            if (operation.mutation) {
              const writes = new JobTransactions(this.engine, this.jobs);
              if (claimed.record.transaction !== undefined)
                return writes.reconcile(
                  workspaceId,
                  id,
                  owner.token,
                  principal,
                  undefined,
                  true,
                  (execution, reconciled, recipe) =>
                    operation.complete(
                      initial.request.arguments,
                      execution,
                      reconciled,
                      recipe,
                      context,
                    ),
                );
              const prepared = await operation.prepare(initial.request.arguments, context);
              return writes.execute(
                workspaceId,
                id,
                owner.token,
                prepared.transaction,
                principal,
                controller.signal,
                prepared.recipe,
                (execution, reconciled, recipe) =>
                  operation.complete(
                    initial.request.arguments,
                    execution,
                    reconciled,
                    recipe,
                    context,
                  ),
              );
            }
            const result = jsonObject.parse(
              await withAnalysisCheckpoints(jobAnalysisCheckpoints(context), () =>
                operation.run(initial.request.arguments, context),
              ),
            );
            controller.signal.throwIfAborted();
            return this.jobs.store.updateOwned(scope, id, owner.token, {
              status: 'completed',
              result,
            });
          }),
      );
    } catch (error) {
      const current = await this.jobs.get(workspaceId, id, principal);
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
      if (current.owner?.token !== owner.token) throw error;
      if (operation.mutation && current.transaction !== undefined)
        return await new JobTransactions(this.engine, this.jobs).reconcile(
          workspaceId,
          id,
          owner.token,
          principal,
          undefined,
          false,
          (execution, reconciled, recipe) =>
            operation.complete(initial.request.arguments, execution, reconciled, recipe, context),
        );
      if (current.cancelRequested && watchFailure === undefined)
        return await this.jobs.store.updateOwned(scope, id, owner.token, {
          status: 'cancelled',
          cancelRequested: true,
        });
      const cause = watchFailure ?? error;
      return await this.jobs.store.updateOwned(scope, id, owner.token, {
        status: 'failed',
        failure: {
          code: cause instanceof ServiceError ? cause.code : 'JOB_EXECUTION_FAILED',
          message:
            cause instanceof ServiceError
              ? cause.message
              : 'The typed operation failed; no completed result was recorded',
        },
      });
    } finally {
      watchStop.abort();
      await watch;
    }
  }
}
