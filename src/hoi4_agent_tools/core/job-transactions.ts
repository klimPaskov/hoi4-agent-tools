import { z } from 'zod/v4';
import type { CoreEngine } from './engine.js';
import type { JobOutput } from './job-executor.js';
import type { JobRecord } from './job-store.js';
import type { JobService } from './job-service.js';
import { ServiceError } from './result.js';
import {
  executePlannedTransaction,
  type TransactionExecutionResult,
} from './transaction-execution.js';
import type { TransactionManifest } from './transactions.js';

export type JobWriteCompletion = (
  execution: TransactionExecutionResult,
  reconciled: boolean,
  recipe: JobOutput | undefined,
) => Promise<JobOutput>;

const jsonObject = z.record(z.string(), z.json());

const defaultCompletion: JobWriteCompletion = (execution, reconciled) =>
  Promise.resolve(
    jsonObject.parse({
      execution: execution.outcome,
      reconciled,
      validationPassed: execution.transaction.validation.passed,
      artifacts: [
        ...execution.artifacts,
        ...(execution.transaction.executionArtifacts ?? []),
        ...execution.transaction.artifacts,
      ],
      changedFiles:
        execution.outcome === 'applied'
          ? execution.transaction.files.map(({ relativePath }) => relativePath)
          : [],
    }),
  );

/** One shared write boundary for background execution and interrupted-outcome reconciliation. */
export class JobTransactions {
  constructor(
    private readonly engine: CoreEngine,
    private readonly jobs: JobService,
  ) {}

  async execute(
    workspaceId: string,
    id: string,
    ownerToken: string,
    transaction: TransactionManifest,
    principal?: string,
    signal?: AbortSignal,
    recipe?: JobOutput,
    completion: JobWriteCompletion = defaultCompletion,
  ): Promise<JobRecord> {
    const job = await this.owned(workspaceId, id, ownerToken, principal, signal);
    this.assertTransaction(job, transaction);
    if (job.transaction !== undefined) {
      if (
        job.transaction.transactionId !== transaction.transactionId ||
        job.transaction.planHash !== transaction.planHash
      )
        throw new ServiceError(
          'JOB_TRANSACTION_CONFLICT',
          'The retry does not match the job transaction binding',
        );
      return this.reconcile(workspaceId, id, ownerToken, principal, signal, true, completion);
    }
    return this.apply(job, ownerToken, transaction, principal, signal, recipe, completion);
  }

  async reconcile(
    workspaceId: string,
    id: string,
    ownerToken: string,
    principal?: string,
    signal?: AbortSignal,
    resumePlanned = true,
    completion: JobWriteCompletion = defaultCompletion,
  ): Promise<JobRecord> {
    const job = await this.owned(workspaceId, id, ownerToken, principal, signal);
    if (job.transaction === undefined)
      throw new ServiceError(
        'JOB_TRANSACTION_UNBOUND',
        'No persisted transaction binding exists for this job',
      );
    const transaction = await this.engine.transactions.recoverTransaction(
      workspaceId,
      job.transaction.transactionId,
      principal,
      signal,
    );
    this.assertTransaction(job, transaction);
    if (transaction.planHash !== job.transaction.planHash)
      throw new ServiceError(
        'JOB_TRANSACTION_CONFLICT',
        'The recorded transaction plan does not match the job binding',
      );
    if (transaction.state === 'applied')
      return this.complete(
        job,
        ownerToken,
        { transaction, outcome: 'applied', artifacts: [] },
        true,
        principal,
        job.writeRecipe,
        completion,
      );
    if (transaction.state === 'planned') {
      if (resumePlanned)
        return this.apply(
          job,
          ownerToken,
          transaction,
          principal,
          signal,
          job.writeRecipe,
          completion,
        );
      if (job.cancelRequested)
        return this.jobs.store.updateOwned(
          this.jobs.scope(workspaceId, principal),
          id,
          ownerToken,
          { status: 'cancelled', cancelRequested: true },
        );
      return this.fail(
        job,
        ownerToken,
        'JOB_REWRITE_NOT_APPLIED',
        'Execution stopped before source application; the plan was not replayed',
        principal,
      );
    }
    if (transaction.state === 'rolled_back' || transaction.state === 'failed')
      return this.fail(
        job,
        ownerToken,
        transaction.rollbackStatus === 'applied'
          ? 'JOB_REWRITE_RESTORED'
          : 'JOB_REWRITE_RECOVERY_REQUIRED',
        transaction.rollbackStatus === 'applied'
          ? 'The interrupted rewrite was restored; it was not replayed'
          : 'The transaction could not establish a completed or restored outcome',
        principal,
      );
    throw new ServiceError(
      'JOB_TRANSACTION_UNRESOLVED',
      'The transaction has no stable outcome after recovery',
    );
  }

  private async owned(
    workspaceId: string,
    id: string,
    ownerToken: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<JobRecord> {
    const job = await this.jobs.get(workspaceId, id, principal, signal);
    if (job.owner?.token !== ownerToken)
      throw new ServiceError('JOB_OWNER_CHANGED', 'The job is owned by another execution attempt');
    if (!job.request.mutation || !['running', 'reconciling'].includes(job.status))
      throw new ServiceError('JOB_STATE_CONFLICT', 'An active rewrite job is required');
    return job;
  }

  private assertTransaction(job: JobRecord, transaction: TransactionManifest): void {
    if (
      transaction.workspaceId !== job.scope.workspaceId ||
      (transaction.principal ?? null) !== job.scope.principal ||
      transaction.rootFingerprint !== job.scope.rootFingerprint
    )
      throw new ServiceError(
        'JOB_TRANSACTION_SCOPE_MISMATCH',
        'The transaction does not belong to the authorized job scope',
      );
  }

  private async apply(
    job: JobRecord,
    ownerToken: string,
    transaction: TransactionManifest,
    principal?: string,
    signal?: AbortSignal,
    recipe?: JobOutput,
    completion: JobWriteCompletion = defaultCompletion,
  ): Promise<JobRecord> {
    try {
      const execution = await executePlannedTransaction(
        this.engine,
        transaction,
        principal,
        signal,
        {
          beforeApply: async (planned) => {
            const bound = await this.jobs.store.updateOwned(
              this.jobs.scope(job.scope.workspaceId, principal),
              job.id,
              ownerToken,
              {
                transaction: { transactionId: planned.transactionId, planHash: planned.planHash },
                ...(recipe === undefined ? {} : { writeRecipe: recipe }),
              },
              signal,
            );
            if (bound.cancelRequested)
              throw new DOMException(
                'Job cancellation was requested before application',
                'AbortError',
              );
          },
        },
      );
      return await this.complete(job, ownerToken, execution, false, principal, recipe, completion);
    } catch (error) {
      // Publication of the job result can fail after the source commit. Consult the journal,
      // never replay the write merely because the caller did not receive its result.
      const current = await this.jobs.get(job.scope.workspaceId, job.id, principal);
      if (current.status === 'completed') return current;
      if (current.owner?.token !== ownerToken)
        throw new ServiceError(
          'JOB_OWNER_CHANGED',
          'The job is owned by another execution attempt',
        );
      if (current.transaction !== undefined) {
        const outcome = await this.engine.transactions.recoverTransaction(
          job.scope.workspaceId,
          current.transaction.transactionId,
          principal,
        );
        this.assertTransaction(current, outcome);
        if (outcome.state === 'applied')
          return this.complete(
            current,
            ownerToken,
            { transaction: outcome, outcome: 'applied', artifacts: [] },
            true,
            principal,
            current.writeRecipe ?? recipe,
            completion,
          );
        if (outcome.state === 'rolled_back')
          return this.fail(
            current,
            ownerToken,
            'JOB_REWRITE_RESTORED',
            'The rewrite failed and its original source was restored',
            principal,
          );
        if (outcome.state === 'failed')
          return this.fail(
            current,
            ownerToken,
            'JOB_REWRITE_RECOVERY_REQUIRED',
            'The transaction could not establish a completed or restored outcome',
            principal,
          );
      }
      if ((error as Error).name === 'AbortError') {
        return this.jobs.store.updateOwned(
          this.jobs.scope(job.scope.workspaceId, principal),
          job.id,
          ownerToken,
          { status: 'cancelled', cancelRequested: true },
        );
      }
      return this.fail(
        current,
        ownerToken,
        error instanceof ServiceError ? error.code : 'JOB_REWRITE_FAILED',
        error instanceof ServiceError
          ? error.message
          : 'The rewrite failed before a committed outcome could be recorded',
        principal,
      );
    }
  }

  private async complete(
    job: JobRecord,
    ownerToken: string,
    execution: TransactionExecutionResult,
    reconciled: boolean,
    principal?: string,
    recipe?: JobOutput,
    completion: JobWriteCompletion = defaultCompletion,
  ): Promise<JobRecord> {
    const result = await completion(execution, reconciled, recipe);
    return this.jobs.store.updateOwned(
      this.jobs.scope(job.scope.workspaceId, principal),
      job.id,
      ownerToken,
      {
        status: 'completed',
        result,
      },
    );
  }

  private fail(
    job: JobRecord,
    ownerToken: string,
    code: string,
    message: string,
    principal?: string,
  ): Promise<JobRecord> {
    return this.jobs.store.updateOwned(
      this.jobs.scope(job.scope.workspaceId, principal),
      job.id,
      ownerToken,
      { status: 'failed', failure: { code, message } },
    );
  }
}
