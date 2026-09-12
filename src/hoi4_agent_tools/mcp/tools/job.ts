import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import type { CoreEngine } from '../../core/engine.js';
import { JobService } from '../../core/job-service.js';
import type { JobRecord } from '../../core/job-store.js';
import { emptyServiceResult, ServiceError } from '../../core/result.js';
import { workspaceIdSchema } from '../../schemas/common.js';
import { nonNegativeIntegerSchema } from '../server/output-schemas.js';
import { errorResult, strictOperationResultSchema, toolResult } from '../server/result.js';
import {
  requireServerScope,
  resolveServerWorkspaceId,
  type ServerContext,
} from '../server/base-tools.js';

const jobIdSchema = z.string().regex(/^job_[a-f0-9]{64}$/u);
const jobReferenceSchema = z
  .object({ workspaceId: workspaceIdSchema, jobId: jobIdSchema })
  .strict();
const jobStatusDataSchema = z
  .object({
    jobId: jobIdSchema,
    toolName: z.string().max(256),
    status: z.enum(['queued', 'running', 'reconciling', 'completed', 'cancelled', 'failed']),
    revision: nonNegativeIntegerSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cancelRequested: z.boolean(),
    resultReady: z.boolean(),
    progress: z
      .object({
        completed: z.number().nonnegative(),
        total: z.number().nonnegative().optional(),
        message: z.string().max(4096),
      })
      .strict()
      .optional(),
    failure: z
      .object({ code: z.string().max(256), message: z.string().max(4096) })
      .strict()
      .optional(),
  })
  .strict();
const jobStatusOutputSchema = strictOperationResultSchema(jobStatusDataSchema);

function statusResult(record: JobRecord) {
  const result = emptyServiceResult(record.scope.workspaceId, {
    jobId: record.id,
    toolName: record.request.toolName,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cancelRequested: record.cancelRequested,
    resultReady: record.result !== undefined,
    ...(record.progress === undefined ? {} : { progress: record.progress }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  });
  result.code = record.status === 'failed' ? 'JOB_FAILED' : 'JOB_STATUS';
  if (record.status === 'failed') {
    result.status = 'error';
    result.validation.passed = false;
    result.blockers = [record.failure!];
  } else if (record.status === 'cancelled') {
    result.status = 'blocked';
    result.code = 'JOB_CANCELLED';
    result.validation.passed = false;
  }
  return result;
}

/** Compatibility controls for clients that retrieve durable jobs outside native task requests. */
export function registerJobTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
  service?: Promise<JobService>,
): void {
  let jobsPromise = service;
  const jobs = (): Promise<JobService> => {
    jobsPromise ??= JobService.create(engine.resolver);
    return jobsPromise;
  };
  server.registerTool(
    'hoi4.job_inspect',
    {
      title: 'Inspect persistent job',
      description:
        'Inspect a durable background operation. A completed job returns the original tool result; active and terminal non-result states return bounded status evidence.',
      inputSchema: jobReferenceSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      let workspaceId = input.workspaceId;
      try {
        workspaceId = await resolveServerWorkspaceId(
          engine,
          context,
          input.workspaceId,
          extra.signal,
        );
        const record = await (
          await jobs()
        ).get(workspaceId, input.jobId, context.principal, extra.signal);
        if (record.status === 'completed') {
          if (record.result === undefined)
            throw new ServiceError(
              'JOB_RESULT_MISSING',
              'Completed job has no authenticated result',
            );
          const completed = CallToolResultSchema.parse(record.result);
          return {
            ...completed,
            _meta: {
              ...completed._meta,
              'io.github.klimPaskov/hoi4-agent-tools/job': {
                jobId: record.id,
                status: record.status,
                revision: record.revision,
              },
            },
          };
        }
        return toolResult(statusResult(record));
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.job_cancel',
    {
      title: 'Cancel persistent job',
      description:
        'Durably request cancellation of an authorized background operation. Completed results remain completed.',
      inputSchema: jobReferenceSchema,
      outputSchema: jobStatusOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      let workspaceId = input.workspaceId;
      try {
        workspaceId = await resolveServerWorkspaceId(
          engine,
          context,
          input.workspaceId,
          extra.signal,
        );
        const service = await jobs();
        const record = await service.get(workspaceId, input.jobId, context.principal, extra.signal);
        if (record.request.mutation) requireServerScope(context, 'hoi4:write');
        return toolResult(
          statusResult(
            await service.cancel(workspaceId, input.jobId, context.principal, extra.signal),
          ),
        );
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}
