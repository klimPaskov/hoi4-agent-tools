import { z } from 'zod/v4';
import type { CoreEngine } from './engine.js';
import { JobService } from './job-service.js';
import type { JobRecord } from './job-store.js';
import { emptyServiceResult, ServiceError } from './result.js';
import { errorResult, strictOperationResultSchema, toolResult } from './operation-result.js';
import {
  requireOperationScope,
  resolveOperationWorkspaceId,
  type OperationContext,
} from './operation-context.js';
import { workspaceIdSchema } from '../schemas/common.js';

const jobIdSchema = z.string().regex(/^job_[a-f0-9]{64}$/u);
export const jobReferenceSchema = z
  .object({ workspaceId: workspaceIdSchema, jobId: jobIdSchema })
  .strict();
const jobStatusDataSchema = z
  .object({
    jobId: jobIdSchema,
    toolName: z.string().max(256),
    status: z.enum(['queued', 'running', 'reconciling', 'completed', 'cancelled', 'failed']),
    revision: z.number().int().min(0),
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
export const jobStatusOutputSchema = strictOperationResultSchema(jobStatusDataSchema);
export type JobControlName = 'hoi4.job_inspect' | 'hoi4.job_cancel';

export function isJobControlTool(name: string): name is JobControlName {
  return name === 'hoi4.job_inspect' || name === 'hoi4.job_cancel';
}

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

/** Bounded control traffic never acquires execution capacity or starts a worker. */
export class JobControlService {
  constructor(
    private readonly engine: CoreEngine,
    private jobsPromise?: Promise<JobService>,
  ) {}

  async call(
    name: JobControlName,
    input: unknown,
    context: OperationContext,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const parsed = jobReferenceSchema.parse(input);
    let workspaceId = parsed.workspaceId;
    try {
      signal?.throwIfAborted();
      workspaceId = await resolveOperationWorkspaceId(
        this.engine,
        context,
        parsed.workspaceId,
        signal,
      );
      this.jobsPromise ??= JobService.create(this.engine.resolver);
      const jobs = await this.jobsPromise;
      const record = await jobs.get(workspaceId, parsed.jobId, context.principal, signal);
      if (name === 'hoi4.job_cancel') {
        if (record.request.mutation) requireOperationScope(context, 'hoi4:write');
        return toolResult(
          statusResult(await jobs.cancel(workspaceId, record.id, context.principal, signal)),
        );
      }
      if (record.status !== 'completed') return toolResult(statusResult(record));
      if (record.result === undefined)
        throw new ServiceError('JOB_RESULT_MISSING', 'Completed job has no authenticated result');
      return {
        ...record.result,
        _meta: {
          ...z.record(z.string(), z.json()).parse(record.result._meta ?? {}),
          'io.github.klimPaskov/hoi4-agent-tools/job': {
            jobId: record.id,
            status: record.status,
            revision: record.revision,
          },
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return errorResult(error, workspaceId);
    }
  }
}
