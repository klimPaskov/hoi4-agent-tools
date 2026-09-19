import { setTimeout as delay } from 'node:timers/promises';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { jobTaskTiming, type JobRecord } from '../../core/job-store.js';
import type { OperationContext } from '../../core/operation-context.js';
import {
  isMutationTask,
  type OperationTaskService,
  operationTaskCallSchema,
  operationTaskId,
  operationTaskMessage,
  operationTaskStatus,
  type OperationTaskOptions,
} from '../../core/operation-tasks.js';
import { ServiceError } from '../../core/result.js';
import { taskToolCatalog } from './task-tool-catalog.js';

/** Stable 2026-07-28 Tasks extension, not the deprecated SDK TaskSchema. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const capabilitySchema = z
  .object({
    extensions: z.object({ [TASKS_EXTENSION]: z.object({}).loose() }).loose(),
  })
  .loose();
const taskReferenceSchema = z.object({ taskId: z.string().min(1).max(256) }).strict();
const taskUpdateSchema = taskReferenceSchema
  .extend({
    inputResponses: z
      .record(z.string().max(1024), z.record(z.string(), z.json()))
      .refine((value) => Object.keys(value).length <= 1024, 'Too many input responses'),
  })
  .strict();
const taskFields = {
  taskId: z.string().min(1).max(256),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  statusMessage: z.string().max(8192).optional(),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
  ttlMs: z.number().int().nonnegative().nullable(),
  pollIntervalMs: z.number().int().nonnegative().optional(),
};
export const modernCreateTaskResultSchema = z
  .object({
    ...taskFields,
    resultType: z.literal('task'),
  })
  .strict();
export const modernGetTaskResultSchema = z.discriminatedUnion('status', [
  z
    .object({ ...taskFields, resultType: z.literal('complete'), status: z.literal('working') })
    .strict(),
  z
    .object({
      ...taskFields,
      resultType: z.literal('complete'),
      status: z.literal('completed'),
      result: z.record(z.string(), z.json()),
    })
    .strict(),
  z
    .object({ ...taskFields, resultType: z.literal('complete'), status: z.literal('cancelled') })
    .strict(),
]);
export type ModernCreateTaskResult = z.infer<typeof modernCreateTaskResultSchema>;

export function hasModernTaskCapability(capabilities: unknown): boolean {
  return capabilitySchema.safeParse(capabilities).success;
}

function requireCapability(capabilities: unknown): void {
  if (!hasModernTaskCapability(capabilities))
    throw new ProtocolError(
      ProtocolErrorCode.MissingRequiredClientCapability,
      'Missing required client capability',
      {
        requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      },
    );
}

function taskFieldsFor(record: JobRecord, taskId: string) {
  if (record.request.protocolTask === undefined)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');
  const message = operationTaskMessage(record);
  const timing = jobTaskTiming(record);
  return {
    taskId,
    // Stored job failures are ordinary tool errors, not JSON-RPC failures.
    status: record.status === 'failed' ? ('completed' as const) : operationTaskStatus(record),
    createdAt: record.createdAt,
    lastUpdatedAt: timing.lastUpdatedAt,
    ttlMs: timing.ttl,
    pollIntervalMs: record.request.protocolTask.pollInterval,
    ...(message === undefined ? {} : { statusMessage: message }),
  };
}

/** Projects the same authenticated job result onto the modern result vocabulary. */
function modernToolResult(record: JobRecord, result: Record<string, unknown>) {
  const parsed = CallToolResultSchema.parse(result);
  const definition = taskToolCatalog.find(({ name }) => name === record.request.toolName);
  if (definition === undefined)
    throw new ServiceError('TASK_TOOL_UNSUPPORTED', 'The task tool is not registered');
  if (!parsed.isError || parsed.structuredContent !== undefined)
    definition.outputSchema.parse(parsed.structuredContent);
  return { ...parsed, resultType: 'complete' as const, ttlMs: 0, cacheScope: 'private' as const };
}

/** Per-request negotiated wire adapter. It never accepts ownership or grants from client metadata. */
export class ModernTaskAdapter {
  constructor(private readonly tasks: OperationTaskService) {}

  async call(
    input: unknown,
    capabilities: unknown,
    context: OperationContext,
    options: Omit<OperationTaskOptions, 'background' | 'ttlMs'>,
  ): Promise<Record<string, unknown>> {
    const parsed = operationTaskCallSchema.safeParse(input);
    if (!parsed.success)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid tool call');
    // Capability advertisement is not a request to background a rewrite without a retry key.
    const background =
      hasModernTaskCapability(capabilities) &&
      (!isMutationTask(parsed.data.name) || typeof parsed.data.arguments.requestKey === 'string');
    const record = await this.tasks.submit(parsed.data, context, { ...options, background });
    const taskId = this.tasks.authenticatedTaskId(record);
    if (background)
      return modernCreateTaskResultSchema.parse({
        resultType: 'task',
        ...taskFieldsFor(record, taskId),
      });
    let latest = record;
    while (operationTaskStatus(latest) === 'working') {
      options.signal?.throwIfAborted();
      await delay(100, undefined, { signal: options.signal });
      latest = await this.known(taskId, context);
    }
    return modernToolResult(latest, await this.tasks.result(operationTaskId(record), context));
  }

  async handle(
    method: string,
    params: unknown,
    capabilities: unknown,
    context: OperationContext,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!['tasks/get', 'tasks/update', 'tasks/cancel'].includes(method))
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found');
    requireCapability(capabilities);
    signal?.throwIfAborted();
    const parsed = (method === 'tasks/update' ? taskUpdateSchema : taskReferenceSchema).safeParse(
      params,
    );
    if (!parsed.success)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid task parameters');
    try {
      const record = await this.known(parsed.data.taskId, context, method === 'tasks/get');
      signal?.throwIfAborted();
      if (method === 'tasks/cancel') {
        await this.tasks.cancel(operationTaskId(record), context);
        return { resultType: 'complete' };
      }
      // These offline operations never solicit input during execution. Unknown/satisfied keys
      // are acknowledged without changing state, as required by the extension.
      if (method === 'tasks/update') return { resultType: 'complete' };
      const fields = taskFieldsFor(record, parsed.data.taskId);
      return modernGetTaskResultSchema.parse({
        ...fields,
        resultType: 'complete',
        ...(fields.status !== 'completed'
          ? {}
          : {
              result: modernToolResult(
                record,
                await this.tasks.result(operationTaskId(record), context),
              ),
            }),
      });
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (error instanceof ServiceError && error.code === 'TASK_NOT_FOUND')
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');
      if (error instanceof ServiceError && error.code === 'AUTH_SCOPE_REQUIRED')
        throw new ProtocolError(-32000, 'The operation requires write authorization', {
          code: error.code,
        });
      if (signal?.aborted) throw error;
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'The task operation could not be completed',
      );
    }
  }

  private async known(value: string, context: OperationContext, resume = true): Promise<JobRecord> {
    const record = await this.tasks.getAuthenticatedTask(value, context, { resume });
    if (record === null) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');
    return record;
  }
}
