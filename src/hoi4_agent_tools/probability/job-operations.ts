import { z } from 'zod/v4';
import type { CoreEngine } from '../core/engine.js';
import { IdleCacheLifetime } from '../core/idle-cache-lifetime.js';
import type { JobOperations } from '../core/job-executor.js';
import { errorResult, toolResult } from '../core/operation-result.js';
import { ServiceError, type ServiceResult } from '../core/result.js';
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
  compareProbabilities,
  evaluateProbabilities,
  inspectProbabilities,
  normalizeProbabilityCompareRequest,
  normalizeProbabilityEvaluateRequest,
  normalizeProbabilityInspectRequest,
  normalizeProbabilityRenderRequest,
  normalizeProbabilitySequenceRequest,
  normalizeProbabilitySimulateRequest,
  normalizeProbabilitySweepRequest,
  renderProbabilities,
  sequenceProbabilities,
  simulateProbabilities,
  sweepProbabilities,
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
    'Inspecting weighted source',
  );
  register(
    'hoi4.probability_evaluate',
    probabilityEvaluateRequestSchema,
    normalizeProbabilityEvaluateRequest,
    evaluateProbabilities,
    'Evaluating weighted scenarios',
  );
  register(
    'hoi4.probability_sweep',
    probabilitySweepRequestSchema,
    normalizeProbabilitySweepRequest,
    sweepProbabilities,
    'Evaluating parameter sweep',
  );
  register(
    'hoi4.probability_simulate',
    probabilitySimulateRequestSchema,
    normalizeProbabilitySimulateRequest,
    simulateProbabilities,
    'Sampling uncertain scenarios',
  );
  register(
    'hoi4.probability_sequence',
    probabilitySequenceRequestSchema,
    normalizeProbabilitySequenceRequest,
    sequenceProbabilities,
    'Analyzing declared sequence',
  );
  register(
    'hoi4.probability_compare',
    probabilityCompareRequestSchema,
    normalizeProbabilityCompareRequest,
    compareProbabilities,
    'Comparing weighted source',
  );
  register(
    'hoi4.probability_render',
    probabilityRenderRequestSchema,
    normalizeProbabilityRenderRequest,
    renderProbabilities,
    'Rendering analysis resources',
  );
}
