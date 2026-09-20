import { z } from 'zod/v4';
import { DecisionAnalyzer } from '../decision/service.js';
import { ImpactAnalyzer } from '../impact/service.js';
import { decisionInspectRequestSchema, impactInspectRequestSchema } from '../schemas/analysis.js';
import type { CoreEngine } from './engine.js';
import type { JobOperations } from './job-executor.js';
import { errorResult, toolResult } from './operation-result.js';
import { ServiceError } from './result.js';

const wireResult = z.record(z.string(), z.json());

/** Registers the two read-only analysis services for durable ordinary and native tasks. */
export function registerAnalysisJobs(operations: JobOperations, engine: CoreEngine): void {
  const impact = new ImpactAnalyzer(engine);
  const decision = new DecisionAnalyzer(engine);
  const register = <Input extends { workspaceId: string }>(
    name: string,
    schema: z.ZodType<Input>,
    execute: (input: Input & { principal?: string; signal?: AbortSignal }) => Promise<
      {
        data: { sourceRevision: string };
      } & Parameters<typeof toolResult>[0]
    >,
    progressMessage: string,
  ) => {
    operations.registerRead(name, schema, async (input, context) => {
      try {
        if (input.workspaceId !== 'current' && input.workspaceId !== context.workspaceId)
          throw new ServiceError(
            'JOB_ARGUMENT_SCOPE_MISMATCH',
            'The request workspace does not match the authorized job workspace',
          );
        await context.progress({ completed: 0, total: 2, message: progressMessage });
        const result = await execute({
          ...input,
          workspaceId: context.workspaceId,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: context.signal,
        });
        await context.progress({ completed: 2, total: 2, message: 'Analysis complete' });
        const wire = wireResult.parse(JSON.parse(JSON.stringify(toolResult(result))) as unknown);
        await context.stageResult(wire, { sourceRevision: result.data.sourceRevision });
        return wire;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return wireResult.parse(
          JSON.parse(JSON.stringify(errorResult(error, context.workspaceId))) as unknown,
        );
      }
    });
  };
  register(
    'hoi4.impact_inspect',
    impactInspectRequestSchema,
    (input) => impact.inspect(input),
    'Tracing cross-system impact',
  );
  register(
    'hoi4.decision_inspect',
    decisionInspectRequestSchema,
    (input) => decision.inspect(input),
    'Analyzing decisions and missions',
  );
}
