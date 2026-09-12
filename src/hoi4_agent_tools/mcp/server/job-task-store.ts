import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  CallToolResultSchema,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import {
  eventCompareRequestSchema,
  eventInspectRequestSchema,
  eventRenderRequestSchema,
} from '../../schemas/event.js';
import {
  focusInspectRequestSchema,
  focusRenderRequestSchema,
  focusRewriteRequestSchema,
} from '../../schemas/focus-requests.js';
import {
  guiInspectRequestSchema,
  guiRenderRequestSchema,
  guiRewriteRequestSchema,
} from '../../schemas/gui-requests.js';
import {
  mapInspectRequestSchema,
  mapRenderRequestSchema,
  mapRewriteRequestSchema,
} from '../../schemas/map-requests.js';
import {
  probabilityCompareRequestSchema,
  probabilityEvaluateRequestSchema,
  probabilityInspectRequestSchema,
  probabilityRenderRequestSchema,
  probabilitySequenceRequestSchema,
  probabilitySimulateRequestSchema,
  probabilitySweepRequestSchema,
} from '../../schemas/probability-requests.js';
import {
  technologyCompareRequestSchema,
  technologyInspectRequestSchema,
  technologyRenderRequestSchema,
} from '../../schemas/technology.js';
import type { CoreEngine } from '../../core/engine.js';
import {
  currentJobOwner,
  jobOwnerLiveness,
  jobRetentionExpired,
  type JobRecord,
  type JobRequest,
} from '../../core/job-store.js';
import { JobService } from '../../core/job-service.js';
import { JobWorkerHost } from '../../core/job-worker-host.js';
import { compareCodeUnits, hashCanonical, secureId } from '../../core/canonical.js';
import { ServiceError } from '../../core/result.js';
import { errorResult } from './result.js';
import {
  requireServerScope,
  resolveServerWorkspaceForSource,
  resolveServerWorkspaceId,
  type ServerContext,
} from './base-tools.js';
import { currentTaskRequestSignal } from './task-request-context.js';

const TASK_POLL_INTERVAL = 250;
const TASK_PAGE_SIZE = 10;
const TASK_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000;
const TASK_RETENTION_MIN_MS = 60 * 1000;
const TASK_RETENTION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const wireResultSchema = z.record(z.string(), z.json());
const taskIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}:job_[a-f0-9]{64}$/u);
const taskToolRequestSchema = z
  .object({
    method: z.literal('tools/call'),
    params: z
      .object({
        name: z.enum([
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
      .loose(),
  })
  .loose();
const taskArgumentSchemas: Record<
  z.infer<typeof taskToolRequestSchema>['params']['name'],
  z.ZodType<Record<string, unknown>>
> = {
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

function taskRetention(ttl: number | null | undefined): number {
  if (ttl === undefined || ttl === null) return TASK_RETENTION_DEFAULT_MS;
  return Math.max(TASK_RETENTION_MIN_MS, Math.min(TASK_RETENTION_MAX_MS, ttl));
}

function taskId(record: JobRecord): string {
  return `${record.scope.workspaceId}:${record.id}`;
}

function parseTaskId(value: string): { workspaceId: string; jobId: string } {
  const parsed = taskIdSchema.parse(value);
  const separator = parsed.indexOf(':');
  return { workspaceId: parsed.slice(0, separator), jobId: parsed.slice(separator + 1) };
}

function taskStatus(record: JobRecord): Task['status'] {
  if (record.status === 'completed') return 'completed';
  if (record.status === 'cancelled') return 'cancelled';
  if (record.status === 'failed') return 'failed';
  return 'working';
}

function taskMessage(record: JobRecord): string | undefined {
  if (record.failure !== undefined) return `${record.failure.code}: ${record.failure.message}`;
  if (record.progress !== undefined) return record.progress.message;
  if (record.cancelRequested) return 'Cancellation requested';
  return undefined;
}

function asTask(record: JobRecord): Task {
  if (record.request.protocolTask === undefined)
    throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
  return {
    taskId: taskId(record),
    status: taskStatus(record),
    createdAt: record.createdAt,
    lastUpdatedAt: record.updatedAt,
    ttl: record.request.protocolTask.ttl,
    pollInterval: record.request.protocolTask.pollInterval,
    ...(taskMessage(record) === undefined ? {} : { statusMessage: taskMessage(record)! }),
  };
}

/** Durable MCP task projection over authenticated persistent jobs. */
export class PersistentJobTaskStore implements TaskStore {
  private jobsPromise?: Promise<JobService>;
  private workerPromise?: Promise<JobWorkerHost>;
  private readonly launches = new Map<string, Promise<void>>();

  constructor(
    private readonly engine: CoreEngine,
    private readonly context: () => ServerContext,
  ) {}

  private jobs(): Promise<JobService> {
    this.jobsPromise ??= JobService.create(this.engine.resolver);
    return this.jobsPromise;
  }

  private worker(): Promise<JobWorkerHost> {
    this.workerPromise ??= this.jobs().then((jobs) => JobWorkerHost.create(this.engine, jobs));
    return this.workerPromise;
  }

  async createTask(
    taskParams: { ttl?: number | null; pollInterval?: number; context?: Record<string, unknown> },
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    const parsed = taskToolRequestSchema.parse(request);
    const validatedArguments = taskArgumentSchemas[parsed.params.name].parse(
      parsed.params.arguments,
    );
    const context = this.context();
    const requestSignal = currentTaskRequestSignal();
    const mutation = mutationTools.has(parsed.params.name);
    const explicitTask = 'task' in parsed.params && parsed.params.task !== undefined;
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
      if (mutation) requireServerScope(context, 'hoi4:write');
      workspaceId = sourceResolvingTools.has(parsed.params.name)
        ? await resolveServerWorkspaceForSource(
            this.engine,
            context,
            requestedWorkspaceId,
            typeof validatedArguments.relativePath === 'string'
              ? validatedArguments.relativePath
              : undefined,
            requestSignal,
          )
        : await resolveServerWorkspaceId(this.engine, context, requestedWorkspaceId, requestSignal);
      this.engine.resolver.get(workspaceId, context.principal);
      requestSignal?.throwIfAborted();
    } catch (error) {
      if (error instanceof ServiceError) {
        return this.completeRejectedTask(
          parsed.params.name,
          wireResultSchema.parse(validatedArguments),
          requestedWorkspaceId,
          taskParams,
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
        toolName: parsed.params.name,
        arguments: arguments_,
        mutation,
        ...(mutation
          ? {
              requestKey:
                callerRequestKey ??
                `foreground:${hashCanonical({
                  sessionId: sessionId ?? secureId('call'),
                  requestId,
                })}`,
            }
          : {}),
        protocolTask: {
          ttl: taskRetention(taskParams.ttl),
          pollInterval: TASK_POLL_INTERVAL,
        },
      },
      context.principal,
      requestSignal,
    );
    if (!explicitTask && requestSignal !== undefined) {
      if (requestSignal.aborted) {
        return asTask(await jobs.cancel(workspaceId, record.id, context.principal));
      }
      const cancel = (): void => {
        void jobs.cancel(workspaceId, record.id, context.principal).catch(() => undefined);
      };
      requestSignal.addEventListener('abort', cancel, { once: true });
    }
    await this.ensureExecution(record, context.principal);
    return asTask(record);
  }

  async getTask(value: string, _sessionId?: string): Promise<Task | null> {
    const record = await this.find(value);
    if (record?.request.protocolTask === undefined) return null;
    await this.ensureExecution(record, this.context().principal);
    return asTask(record);
  }

  async storeTaskResult(
    value: string,
    status: 'completed' | 'failed',
    result: Result,
    _sessionId?: string,
  ): Promise<void> {
    const record = await this.find(value);
    if (record?.request.protocolTask === undefined)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    if (status !== taskStatus(record) || JSON.stringify(record.result) !== JSON.stringify(result))
      throw new ServiceError(
        'TASK_RESULT_IMMUTABLE',
        'Protocol task results are published only by the authenticated job executor',
      );
  }

  async getTaskResult(value: string, _sessionId?: string): Promise<Result> {
    const reference = parseTaskId(value);
    let record = await this.find(value);
    if (record?.request.protocolTask === undefined)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    const launch = this.launches.get(value);
    if (launch !== undefined) {
      await launch;
      record = await this.find(value);
      if (record?.request.protocolTask === undefined)
        throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    }
    if (record.status === 'completed' && record.result !== undefined)
      return CallToolResultSchema.parse(record.result);
    if (record.status === 'failed')
      return errorResult(
        new ServiceError(
          record.failure?.code ?? 'JOB_FAILED',
          record.failure?.message ?? 'The background operation failed',
        ),
        reference.workspaceId,
      );
    if (record.status === 'cancelled')
      return errorResult(
        new ServiceError('JOB_CANCELLED', 'The background operation was cancelled'),
        reference.workspaceId,
      );
    throw new ServiceError(
      'TASK_RESULT_PENDING',
      'The protocol task has not reached a terminal state',
    );
  }

  async updateTaskStatus(
    value: string,
    status: Task['status'],
    _statusMessage?: string,
    _sessionId?: string,
  ): Promise<void> {
    if (status !== 'cancelled')
      throw new ServiceError(
        'TASK_STATUS_IMMUTABLE',
        'Protocol task state is controlled by the authenticated job executor',
      );
    const reference = parseTaskId(value);
    const jobs = await this.jobs();
    const record = await this.find(value);
    if (record === null)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    if (record.request.protocolTask === undefined)
      throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
    await jobs.cancel(reference.workspaceId, reference.jobId, this.context().principal);
  }

  async listTasks(
    cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const context = this.context();
    const workspaces = this.engine.resolver.list(context.principal);
    const after = cursor === undefined ? undefined : parseTaskId(cursor);
    if (after !== undefined && !workspaces.some(({ id }) => id === after.workspaceId))
      throw new ServiceError(
        'TASK_CURSOR_INVALID',
        'The task cursor is invalid for this principal',
      );
    const jobs = await this.jobs();
    const tasks: Task[] = [];
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
            tasks.push(asTask(record));
          if (tasks.length > TASK_PAGE_SIZE) break;
        }
        if (tasks.length > TASK_PAGE_SIZE || page.next === undefined) break;
        jobCursor = page.next;
      }
      if (tasks.length > TASK_PAGE_SIZE) break;
    }
    const selected = tasks.slice(0, TASK_PAGE_SIZE);
    return {
      tasks: selected,
      ...(tasks.length > TASK_PAGE_SIZE ? { nextCursor: selected.at(-1)!.taskId } : {}),
    };
  }

  private async find(value: string): Promise<JobRecord | null> {
    let reference: ReturnType<typeof parseTaskId>;
    try {
      reference = parseTaskId(value);
    } catch {
      return null;
    }
    try {
      const record = await (
        await this.jobs()
      ).get(reference.workspaceId, reference.jobId, this.context().principal);
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
    toolName: z.infer<typeof taskToolRequestSchema>['params']['name'],
    arguments_: JobRequest['arguments'],
    requestedWorkspaceId: string,
    taskParams: { ttl?: number | null; pollInterval?: number; context?: Record<string, unknown> },
    error: ServiceError,
  ): Promise<Task> {
    const context = this.context();
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
          ttl: taskRetention(taskParams.ttl),
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
        result: wireResultSchema.parse(
          CallToolResultSchema.parse(errorResult(error, requestedWorkspaceId)),
        ),
      },
    );
    return asTask(completed);
  }

  private async ensureExecution(record: JobRecord, principal?: string): Promise<void> {
    if (['completed', 'failed', 'cancelled'].includes(record.status)) return;
    if (
      record.status !== 'queued' &&
      (record.owner === undefined || jobOwnerLiveness(record.owner) !== 'dead')
    )
      return;
    const key = taskId(record);
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
