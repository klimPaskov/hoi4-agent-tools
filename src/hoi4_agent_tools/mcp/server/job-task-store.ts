import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  CallToolResultSchema,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from '@modelcontextprotocol/sdk/types.js';
import type { CoreEngine } from '../../core/engine.js';
import { jobTaskTiming, type JobRecord } from '../../core/job-store.js';
import {
  OperationTaskService,
  operationTaskCallSchema,
  operationTaskId,
  operationTaskMessage,
  operationTaskStatus,
} from '../../core/operation-tasks.js';
import { ServiceError } from '../../core/result.js';
import type { ServerContext } from './base-tools.js';
import { currentTaskRequestSignal } from './task-request-context.js';

function legacyTask(record: JobRecord): Task {
  if (record.request.protocolTask === undefined)
    throw new ServiceError('TASK_NOT_FOUND', 'The requested protocol task does not exist');
  const message = operationTaskMessage(record);
  const timing = jobTaskTiming(record);
  return {
    taskId: operationTaskId(record),
    status: operationTaskStatus(record),
    createdAt: record.createdAt,
    lastUpdatedAt: timing.lastUpdatedAt,
    ttl: timing.ttl,
    pollInterval: record.request.protocolTask.pollInterval,
    ...(message === undefined ? {} : { statusMessage: message }),
  };
}

/** 2025 MCP task wire projection; execution and authorization live in the shared core. */
export class PersistentJobTaskStore implements TaskStore {
  private readonly tasks: OperationTaskService;

  constructor(
    engine: CoreEngine,
    private readonly context: () => ServerContext,
  ) {
    this.tasks = new OperationTaskService(engine);
  }

  async createTask(
    taskParams: { ttl?: number | null; pollInterval?: number; context?: Record<string, unknown> },
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    if (request.method !== 'tools/call')
      throw new ServiceError('TASK_METHOD_UNSUPPORTED', 'Only tool calls support background tasks');
    const call = operationTaskCallSchema.parse({
      name: request.params?.name,
      arguments: request.params?.arguments,
    });
    const signal = currentTaskRequestSignal();
    return legacyTask(
      await this.tasks.submit(call, this.context(), {
        background: request.params?.task !== undefined,
        requestId,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(taskParams.ttl === undefined ? {} : { ttlMs: taskParams.ttl }),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }

  async getTask(value: string, _sessionId?: string): Promise<Task | null> {
    const record = await this.tasks.get(value, this.context());
    return record === null ? null : legacyTask(record);
  }

  async storeTaskResult(
    value: string,
    status: 'completed' | 'failed',
    result: Result,
    _sessionId?: string,
  ): Promise<void> {
    await this.tasks.assertPublishedResult(value, status, result, this.context());
  }

  async getTaskResult(value: string, _sessionId?: string): Promise<Result> {
    return CallToolResultSchema.parse(await this.tasks.result(value, this.context()));
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
    await this.tasks.cancel(value, this.context());
  }

  async listTasks(
    cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const page = await this.tasks.list(this.context(), cursor);
    return {
      tasks: page.records.map(legacyTask),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }
}
