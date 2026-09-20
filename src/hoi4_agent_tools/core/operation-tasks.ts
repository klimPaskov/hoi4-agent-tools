import { z } from 'zod/v4';
import { decisionInspectRequestSchema, impactInspectRequestSchema } from '../schemas/analysis.js';
import {
  mechanicTestRequestSchema,
  packageCheckRequestSchema,
  scenarioTestRequestSchema,
} from '../schemas/scenarios.js';
import {
  eventCompareRequestSchema,
  eventInspectRequestSchema,
  eventRenderRequestSchema,
} from '../schemas/event.js';
import {
  focusInspectRequestSchema,
  focusRenderRequestSchema,
  focusRewriteRequestSchema,
} from '../schemas/focus-requests.js';
import {
  guiInspectRequestSchema,
  guiRenderRequestSchema,
  guiRewriteRequestSchema,
} from '../schemas/gui-requests.js';
import {
  mapInspectRequestSchema,
  mapRenderRequestSchema,
  mapRewriteRequestSchema,
} from '../schemas/map-requests.js';
import {
  probabilityCompareRequestSchema,
  probabilityEvaluateRequestSchema,
  probabilityInspectRequestSchema,
  probabilityRenderRequestSchema,
  probabilitySequenceRequestSchema,
  probabilitySimulateRequestSchema,
  probabilitySweepRequestSchema,
} from '../schemas/probability-requests.js';
import {
  technologyCompareRequestSchema,
  technologyInspectRequestSchema,
  technologyRenderRequestSchema,
} from '../schemas/technology.js';
import type { CoreEngine } from './engine.js';
import {
  currentJobOwner,
  jobOwnerLiveness,
  jobRetentionExpired,
  type JobRecord,
  type JobRequest,
} from './job-store.js';
import { JobService } from './job-service.js';
import { JobWorkerHost } from './job-worker-host.js';
import { compareCodeUnits, hashCanonical, secureId } from './canonical.js';
import { ServiceError } from './result.js';
import { errorResult } from './operation-result.js';
import {
  requireOperationScope,
  resolveOperationWorkspaceForSource,
  resolveOperationWorkspaceId,
  type OperationContext,
} from './operation-context.js';

const TASK_POLL_INTERVAL = 250;
const TASK_PAGE_SIZE = 10;
const TASK_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000;
const TASK_RETENTION_MIN_MS = 60 * 1000;
const TASK_RETENTION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const wireResultSchema = z.record(z.string(), z.json());
const taskIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}:job_[a-f0-9]{64}$/u);
const authenticatedTaskIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}:job_[a-f0-9]{64}\.[a-f0-9]{64}$/u);
export const operationTaskCallSchema = z
  .object({
    name: z.enum([
      'hoi4.impact_inspect',
      'hoi4.decision_inspect',
      'hoi4.mechanic_test',
      'hoi4.package_check',
      'hoi4.scenario_test',
      'hoi4.event_inspect',
      'hoi4.event_render',
      'hoi4.event_compare',
      'hoi4.tech_inspect',
      'hoi4.tech_render',
      'hoi4.tech_compare',
      'hoi4.probability_inspect',
      'hoi4.probability_evaluate',
      'hoi4.probability_sweep',
      'hoi4.probability_simulate',
      'hoi4.probability_sequence',
      'hoi4.probability_compare',
      'hoi4.probability_render',
      'hoi4.map_inspect',
      'hoi4.map_render',
      'hoi4.map_rewrite',
      'hoi4.gui_inspect',
      'hoi4.gui_render',
      'hoi4.gui_rewrite',
      'hoi4.focus_inspect',
      'hoi4.focus_render',
      'hoi4.focus_raster',
      'hoi4.focus_rewrite',
    ]),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
export type OperationTaskCall = z.infer<typeof operationTaskCallSchema>;
const taskArgumentSchemas: Record<OperationTaskCall['name'], z.ZodType<Record<string, unknown>>> = {
  'hoi4.impact_inspect': impactInspectRequestSchema,
  'hoi4.decision_inspect': decisionInspectRequestSchema,
  'hoi4.mechanic_test': mechanicTestRequestSchema,
  'hoi4.package_check': packageCheckRequestSchema,
  'hoi4.scenario_test': scenarioTestRequestSchema,
  'hoi4.event_inspect': eventInspectRequestSchema,
  'hoi4.event_render': eventRenderRequestSchema,
  'hoi4.event_compare': eventCompareRequestSchema,
  'hoi4.tech_inspect': technologyInspectRequestSchema,
  'hoi4.tech_render': technologyRenderRequestSchema,
  'hoi4.tech_compare': technologyCompareRequestSchema,
  'hoi4.probability_inspect': probabilityInspectRequestSchema,
  'hoi4.probability_evaluate': probabilityEvaluateRequestSchema,
  'hoi4.probability_sweep': probabilitySweepRequestSchema,
  'hoi4.probability_simulate': probabilitySimulateRequestSchema,
  'hoi4.probability_sequence': probabilitySequenceRequestSchema,
  'hoi4.probability_compare': probabilityCompareRequestSchema,
  'hoi4.probability_render': probabilityRenderRequestSchema,
  'hoi4.map_inspect': mapInspectRequestSchema,
  'hoi4.map_render': mapRenderRequestSchema,
  'hoi4.map_rewrite': mapRewriteRequestSchema,
  'hoi4.gui_inspect': guiInspectRequestSchema,
  'hoi4.gui_render': guiRenderRequestSchema,
  'hoi4.gui_rewrite': guiRewriteRequestSchema,
  'hoi4.focus_inspect': focusInspectRequestSchema,
  'hoi4.focus_render': focusRenderRequestSchema,
  'hoi4.focus_raster': focusRenderRequestSchema,
  'hoi4.focus_rewrite': focusRewriteRequestSchema,
};

const sourceResolvingTools = new Set([
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_raster',
  'hoi4.focus_rewrite',
]);

const mutationTools = new Set(['hoi4.gui_rewrite', 'hoi4.map_rewrite', 'hoi4.focus_rewrite']);

export function isMutationTask(name: string): boolean {
  return mutationTools.has(name);
}

export interface OperationTaskOptions {
  background: boolean;
  requestId: string | number;
  sessionId?: string;
  ttlMs?: number | null;
  signal?: AbortSignal;
}

function taskRetention(ttl: number | null | undefined): number {
  if (ttl === undefined || ttl === null) return TASK_RETENTION_DEFAULT_MS;
  return Math.max(TASK_RETENTION_MIN_MS, Math.min(TASK_RETENTION_MAX_MS, ttl));
}

export function operationTaskId(record: JobRecord): string {
  return `${record.scope.workspaceId}:${record.id}`;
}

function taskReferencePayload(record: JobRecord) {
  return { kind: 'operation-task-reference.v1', scope: record.scope, id: record.id };
}

export function parseOperationTaskId(value: string): { workspaceId: string; jobId: string } {
  const parsed = taskIdSchema.parse(value);
  const separator = parsed.indexOf(':');
  return { workspaceId: parsed.slice(0, separator), jobId: parsed.slice(separator + 1) };
}

export function operationTaskStatus(
  record: JobRecord,
): 'working' | 'completed' | 'cancelled' | 'failed' {
  if (record.status === 'completed') return 'completed';
  if (record.status === 'cancelled') return 'cancelled';
  if (record.status === 'failed') return 'failed';
  return 'working';
}

export function operationTaskMessage(record: JobRecord): string | undefined {
  if (record.failure !== undefined) return `${record.failure.code}: ${record.failure.message}`;
  if (record.progress !== undefined) return record.progress.message;
  if (record.cancelRequested) return 'Cancellation requested';
  return undefined;
}

/** Protocol-independent task execution, ownership, retention, and recovery over durable jobs. */
export class OperationTaskService {
  private jobsPromise?: Promise<JobService>;
  private workerPromise?: Promise<JobWorkerHost>;
  private readonly launches = new Map<string, Promise<void>>();

  constructor(private readonly engine: CoreEngine) {}

  private jobs(): Promise<JobService> {
    this.jobsPromise ??= JobService.create(this.engine.resolver);
    return this.jobsPromise;
  }

  private worker(): Promise<JobWorkerHost> {
    this.workerPromise ??= this.jobs().then((jobs) => JobWorkerHost.create(this.engine, jobs));
    return this.workerPromise;
  }

  async submit(
    input: OperationTaskCall,
    context: OperationContext,
    options: OperationTaskOptions,
  ): Promise<JobRecord> {
    const parsed = operationTaskCallSchema.parse(input);
    const validatedArguments = taskArgumentSchemas[parsed.name].parse(parsed.arguments);
    const requestSignal = options.signal;
    const mutation = isMutationTask(parsed.name);
    const explicitTask = options.background;
    const callerRequestKey =
      typeof validatedArguments.requestKey === 'string' ? validatedArguments.requestKey : undefined;
    if (mutation && explicitTask && callerRequestKey === undefined)
      throw new ServiceError(
        'JOB_REQUEST_KEY_REQUIRED',
        'Native background rewrites require a caller-stable requestKey',
      );
    const requestedWorkspaceId =
      typeof validatedArguments.workspaceId === 'string'
        ? validatedArguments.workspaceId
        : 'current';
    let workspaceId: string;
    try {
      requestSignal?.throwIfAborted();
      if (mutation) requireOperationScope(context, 'hoi4:write');
      workspaceId = sourceResolvingTools.has(parsed.name)
        ? await resolveOperationWorkspaceForSource(
            this.engine,
            context,
            requestedWorkspaceId,
            typeof validatedArguments.relativePath === 'string'
              ? validatedArguments.relativePath
              : undefined,
            requestSignal,
          )
        : await resolveOperationWorkspaceId(
            this.engine,
            context,
            requestedWorkspaceId,
            requestSignal,
          );
      this.engine.resolver.get(workspaceId, context.principal);
      requestSignal?.throwIfAborted();
    } catch (error) {
      if (error instanceof ServiceError) {
        return this.completeRejectedTask(
          parsed.name,
          wireResultSchema.parse(validatedArguments),
          requestedWorkspaceId,
          context,
          options,
          error,
        );
      }
      throw error;
    }
    const arguments_ = { ...validatedArguments, workspaceId };
    const jobs = await this.jobs();
    const { record } = await jobs.submit(
      workspaceId,
      {
        toolName: parsed.name,
        arguments: arguments_,
        mutation,
        ...(mutation
          ? {
              requestKey:
                callerRequestKey ??
                `foreground:${hashCanonical({
                  sessionId: options.sessionId ?? secureId('call'),
                  requestId: options.requestId,
                })}`,
            }
          : {}),
        protocolTask: {
          ttl: taskRetention(options.ttlMs),
          pollInterval: TASK_POLL_INTERVAL,
        },
      },
      context.principal,
      requestSignal,
    );
    if (!explicitTask && requestSignal !== undefined) {
      if (requestSignal.aborted) {
        return jobs.cancel(workspaceId, record.id, context.principal);
      }
      const cancel = (): void => {
        void jobs.cancel(workspaceId, record.id, context.principal).catch(() => undefined);
      };
      requestSignal.addEventListener('abort', cancel, { once: true });
    }
    await this.ensureExecution(record, context.principal);
    return record;
  }

  async get(
    value: string,
    context: OperationContext,
    options: { resume?: boolean } = {},
  ): Promise<JobRecord | null> {
    const record = await this.find(value, context);
    return this.resume(record, context, options);
  }

  /** A durable opaque reference, including for retained pre-hardening receipt identities. */
  authenticatedTaskId(record: JobRecord): string {
    const state = this.engine.resolver.serverState();
    if (state === undefined)
      throw new ServiceError('JOB_STORAGE_UNAVAILABLE', 'Persistent tasks require server state');
    return `${operationTaskId(record)}.${state.authenticateJournal(taskReferencePayload(record))}`;
  }

  async getAuthenticatedTask(
    value: string,
    context: OperationContext,
    options: { resume?: boolean } = {},
  ): Promise<JobRecord | null> {
    if (!authenticatedTaskIdSchema.safeParse(value).success) return null;
    const separator = value.lastIndexOf('.');
    const record = await this.find(value.slice(0, separator), context);
    if (
      record === null ||
      this.engine.resolver
        .serverState()
        ?.verifyJournal(taskReferencePayload(record), value.slice(separator + 1)) !== true
    )
      return null;
    // Verify before resuming: a malformed or guessed reference must not admit execution.
    return this.resume(record, context, options);
  }

  private async resume(
    record: JobRecord | null,
    context: OperationContext,
    options: { resume?: boolean },
  ): Promise<JobRecord | null> {
    if (record?.request.protocolTask === undefined) return null;
    if (options.resume === false) return record;
    // Reading a retained rewrite must not resume it under a credential that lost write scope.
    if (
      record.request.mutation &&
      context.scopes !== undefined &&
      !context.scopes.includes('hoi4:write')
    )
      return record;
    await this.ensureExecution(record, context.principal);
    return record;
  }

  async assertPublishedResult(
    value: string,
    status: 'completed' | 'failed',
    result: Record<string, unknown>,
    context: OperationContext,
  ): Promise<void> {
    const record = await this.find(value, context);
    if (record?.request.protocolTask === undefined)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    if (
      status !== operationTaskStatus(record) ||
      JSON.stringify(record.result) !== JSON.stringify(result)
    )
      throw new ServiceError(
        'TASK_RESULT_IMMUTABLE',
        'Protocol task results are published only by the authenticated job executor',
      );
  }

  async result(value: string, context: OperationContext): Promise<Record<string, unknown>> {
    let record = await this.find(value, context);
    if (record?.request.protocolTask === undefined)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    const launch = this.launches.get(value);
    if (launch !== undefined) {
      await launch;
      record = await this.find(value, context);
      if (record?.request.protocolTask === undefined)
        throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    }
    if (record.status === 'completed' && record.result !== undefined) return record.result;
    if (record.status === 'failed')
      return errorResult(
        new ServiceError(
          record.failure?.code ?? 'JOB_FAILED',
          record.failure?.message ?? 'The background operation failed',
        ),
        record.scope.workspaceId,
      );
    if (record.status === 'cancelled')
      return errorResult(
        new ServiceError('JOB_CANCELLED', 'The background operation was cancelled'),
        record.scope.workspaceId,
      );
    throw new ServiceError(
      'TASK_RESULT_PENDING',
      'The protocol task has not reached a terminal state',
    );
  }

  async cancel(value: string, context: OperationContext): Promise<JobRecord> {
    const record = await this.find(value, context);
    if (record?.request.protocolTask === undefined)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    if (record.request.mutation) requireOperationScope(context, 'hoi4:write');
    return (await this.jobs()).cancel(record.scope.workspaceId, record.id, context.principal);
  }

  async list(
    context: OperationContext,
    cursor?: string,
  ): Promise<{ records: JobRecord[]; nextCursor?: string }> {
    const workspaces = this.engine.resolver.list(context.principal);
    const after = cursor === undefined ? undefined : parseOperationTaskId(cursor);
    if (after !== undefined && !workspaces.some(({ id }) => id === after.workspaceId))
      throw new ServiceError(
        'TASK_CURSOR_INVALID',
        'The task cursor is invalid for this principal',
      );
    const jobs = await this.jobs();
    const tasks: JobRecord[] = [];
    for (const workspace of workspaces) {
      if (after !== undefined && compareCodeUnits(workspace.id, after.workspaceId) < 0) continue;
      let jobCursor = after?.workspaceId === workspace.id ? after.jobId : undefined;
      while (tasks.length <= TASK_PAGE_SIZE) {
        const page = await jobs.list(workspace.id, context.principal, {
          ...(jobCursor === undefined ? {} : { after: jobCursor }),
          limit: Math.min(100, TASK_PAGE_SIZE + 1 - tasks.length),
        });
        for (const record of page.records) {
          if (record.request.protocolTask !== undefined && !jobRetentionExpired(record))
            tasks.push(record);
          if (tasks.length > TASK_PAGE_SIZE) break;
        }
        if (tasks.length > TASK_PAGE_SIZE || page.next === undefined) break;
        jobCursor = page.next;
      }
      if (tasks.length > TASK_PAGE_SIZE) break;
    }
    const selected = tasks.slice(0, TASK_PAGE_SIZE);
    return {
      records: selected,
      ...(tasks.length > TASK_PAGE_SIZE ? { nextCursor: operationTaskId(selected.at(-1)!) } : {}),
    };
  }

  private async find(value: string, context: OperationContext): Promise<JobRecord | null> {
    let reference: ReturnType<typeof parseOperationTaskId>;
    try {
      reference = parseOperationTaskId(value);
    } catch {
      return null;
    }
    try {
      const record = await (
        await this.jobs()
      ).get(reference.workspaceId, reference.jobId, context.principal);
      return jobRetentionExpired(record) ? null : record;
    } catch (error) {
      if (
        error instanceof ServiceError &&
        ['JOB_NOT_FOUND', 'WORKSPACE_INACCESSIBLE', 'WORKSPACE_NOT_REGISTERED'].includes(error.code)
      )
        return null;
      throw error;
    }
  }

  /** Preserve the ordinary tool-error envelope when authorization fails before submission. */
  private async completeRejectedTask(
    toolName: OperationTaskCall['name'],
    arguments_: JobRequest['arguments'],
    requestedWorkspaceId: string,
    context: OperationContext,
    options: OperationTaskOptions,
    error: ServiceError,
  ): Promise<JobRecord> {
    const fallback = this.engine.resolver.list(context.principal)[0];
    if (fallback === undefined) throw error;
    const jobs = await this.jobs();
    const { record } = await jobs.submit(
      fallback.id,
      {
        toolName,
        arguments: arguments_,
        mutation: false,
        requestKey: `rejected:${secureId('request')}`,
        protocolTask: {
          ttl: taskRetention(options.ttlMs),
          pollInterval: TASK_POLL_INTERVAL,
        },
      },
      context.principal,
    );
    const owner = currentJobOwner();
    await jobs.store.claim(jobs.scope(fallback.id, context.principal), record.id, owner);
    const completed = await jobs.store.updateOwned(
      jobs.scope(fallback.id, context.principal),
      record.id,
      owner.token,
      {
        status: 'completed',
        result: wireResultSchema.parse(errorResult(error, requestedWorkspaceId)),
      },
    );
    return completed;
  }

  private async ensureExecution(record: JobRecord, principal?: string): Promise<void> {
    if (['completed', 'failed', 'cancelled'].includes(record.status)) return;
    if (
      record.status !== 'queued' &&
      (record.owner === undefined || jobOwnerLiveness(record.owner) !== 'dead')
    )
      return;
    const key = operationTaskId(record);
    if (this.launches.has(key)) return;
    const worker = await this.worker();
    const launched = worker
      .run(record.scope.workspaceId, record.id, principal)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        const jobs = await this.jobs();
        await jobs.failInterrupted(
          record.scope.workspaceId,
          record.id,
          {
            code: error instanceof ServiceError ? error.code : 'JOB_WORKER_FAILED',
            message:
              error instanceof ServiceError
                ? error.message
                : 'The isolated worker could not be started',
          },
          principal,
        );
      })
      .finally(() => {
        this.launches.delete(key);
      });
    this.launches.set(key, launched);
    void launched.catch(() => undefined);
  }
}
