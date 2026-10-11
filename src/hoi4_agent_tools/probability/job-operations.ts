import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import type { JobOperations } from '../core/job-executor.js';
import { errorResult, toolResult } from '../core/operation-result.js';
import { ServiceError, type ServiceResult } from '../core/result.js';
import {
  probabilityAnalyzeRequestSchema,
  probabilityInspectRequestSchema,
} from '../schemas/probability-requests.js';
import {
  analyzeProbabilities,
  inspectProbabilities,
  normalizeProbabilityAnalyzeRequest,
  normalizeProbabilityInspectRequest,
  type ProbabilityOperationContext,
} from './operations.js';
import { ProbabilityAnalyzer } from './service.js';

const wireResult = z.record(z.string(), z.json());

/** Registers probability operations without invoking transport handlers. */
export function registerProbabilityJobs(operations: JobOperations, engine: CoreEngine): void {
  const analyzer = new ProbabilityAnalyzer(engine);
  const lifetime = new IdleCacheLifetime(() => analyzer.clearCaches());
  function register<Input extends { workspaceId: string }, Request extends { workspaceId: string }>(
    name: string,
    schema: z.ZodType<Input>,
    normalize: (input: unknown) => Request,
    execute: (
      analyzer: ProbabilityAnalyzer,
      input: Request,
      context: ProbabilityOperationContext,
    ) => Promise<ServiceResult<unknown>>,
    message: string,
  ): void {
    operations.registerRead(name, schema, async (input, context) => {
      const release = lifetime.begin();
      try {
        if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
          throw new ServiceError(
            'JOB_ARGUMENT_SCOPE_MISMATCH',
            'The request workspace does not match the authorized job workspace',
          );
        await context.progress({ completed: 0, total: 3, message });
        const result = await execute(analyzer, normalize(input), {
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
        });
        await context.progress({
          completed: 3,
          total: 3,
          message: 'Probability operation complete',
        });
        const wire = wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
        const revision =
          result.data !== null &&
          typeof result.data === 'object' &&
          'sourceRevision' in result.data &&
          typeof result.data.sourceRevision === 'string'
            ? result.data.sourceRevision
            : undefined;
        if (revision !== undefined) await context.stageResult(wire, { sourceRevision: revision });
        return wire;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return wireResult.parse(
          JSON.parse(JSON.stringify(errorResult(error, context.workspaceId))) as unknown,
        );
      } finally {
        release();
      }
    });
  }
  register(
    'hoi4.probability_inspect',
    probabilityInspectRequestSchema,
    normalizeProbabilityInspectRequest,
    inspectProbabilities,
    'Inspecting and evaluating weighted source',
  );
  register(
    'hoi4.probability_analyze',
    probabilityAnalyzeRequestSchema,
    normalizeProbabilityAnalyzeRequest,
    analyzeProbabilities,
    'Analyzing weighted source',
  );
}
