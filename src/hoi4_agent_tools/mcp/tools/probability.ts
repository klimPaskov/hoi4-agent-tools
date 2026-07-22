import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { CoreEngine } from '../../core/engine.js';
import { emptyServiceResult } from '../../core/result.js';
import {
  ProbabilityAnalyzer,
  type ProbabilityAnalysisRequest,
  type ProbabilityCompareRequest,
  type ProbabilityRenderRequest,
  type ProbabilitySequenceRequest,
  type ProbabilitySimulationRequest,
  type ProbabilitySweepRequest,
} from '../../probability/service.js';
import {
  customWeightedPoolManifestSchema,
  probabilityAcceptanceBandSchema,
  probabilityAdapterIdSchema,
  probabilityDiagnosticThresholdsSchema,
  probabilityMetricSchema,
  probabilityOutputSchema,
  probabilityRenderFilterSchema,
  probabilityScenarioSetSchema,
  probabilitySamplingMethodSchema,
  probabilitySourceSchema,
} from '../../schemas/probability.js';
import { workspaceIdSchema } from '../../schemas/common.js';
import type { ServerContext } from '../server/base-tools.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';

const nestedSource = compactValidatedInputSchema(
  probabilitySourceSchema,
  'Source selector or proposed source.',
);
const nestedScenarios = compactValidatedInputSchema(
  probabilityScenarioSetSchema,
  'Explicit world-state scenarios.',
);
const nestedManifest = compactValidatedInputSchema(
  customWeightedPoolManifestSchema,
  'Declared custom weighted pool and state transitions.',
);
const nestedRenderFilter = compactValidatedInputSchema(
  probabilityRenderFilterSchema,
  'Optional scenario, candidate, metric, diagnostic, source, and page filter.',
);
const nestedAcceptanceBands = compactValidatedInputSchema(
  z.array(probabilityAcceptanceBandSchema).max(100_000),
  'Optional named metric acceptance bands.',
);
const nestedDiagnosticThresholds = compactValidatedInputSchema(
  probabilityDiagnosticThresholdsSchema,
  'Optional diagnostic thresholds.',
);
const candidatePool = z.array(z.string().min(1).max(512)).max(100_000).optional();
const outputs = z.array(probabilityOutputSchema).max(10).optional();
const commonShape = {
  workspaceId: workspaceIdSchema,
  adapter: probabilityAdapterIdSchema,
  source: nestedSource,
  scenarioSet: nestedScenarios,
  candidatePool,
  horizonDays: z.number().positive().max(1_000_000).optional(),
  metrics: z.array(probabilityMetricSchema).min(1).max(4).optional(),
  acceptanceBands: nestedAcceptanceBands.optional(),
  diagnosticThresholds: nestedDiagnosticThresholds.optional(),
  outputs,
  refresh: z.boolean().optional(),
} as const;
const inspectInput = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema.optional(),
    source: nestedSource.optional(),
    candidatePool,
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.adapter === undefined) !== (value.source === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Provide adapter and source together, or omit both to list adapters',
      });
  });
const evaluateInput = z.object(commonShape).strict();
const sweepInput = z
  .object({
    ...commonShape,
    sweep: z
      .object({
        paths: z.array(z.string().min(1).max(1024)).min(1).max(32),
        steps: z.number().int().min(2).max(10_000).default(25),
        pairwise: z.boolean().default(false),
        findRankReversals: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();
const simulateInput = z
  .object({
    ...commonShape,
    samples: z.number().int().min(100).max(10_000_000).default(100_000),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(1),
    confidenceLevel: z.number().min(0.5).max(0.9999).default(0.95),
    samplingMethod: probabilitySamplingMethodSchema.default('latin_hypercube'),
  })
  .strict();
const sequenceInput = z
  .object({
    workspaceId: workspaceIdSchema,
    scenarioSet: nestedScenarios,
    customPoolManifest: nestedManifest,
    horizonDays: z.number().positive().max(1_000_000),
    maxSteps: z.number().int().min(1).max(100_000).default(1_000),
    samples: z.number().int().min(100).max(10_000_000).default(100_000),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(1),
    confidenceLevel: z.number().min(0.5).max(0.9999).default(0.95),
    acceptanceBands: nestedAcceptanceBands.optional(),
    diagnosticThresholds: nestedDiagnosticThresholds.optional(),
    outputs,
  })
  .strict();
const compareInput = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema,
    before: nestedSource,
    after: nestedSource,
    scenarioSet: nestedScenarios,
    candidatePool,
    horizonDays: z.number().positive().max(1_000_000).optional(),
    acceptanceBands: nestedAcceptanceBands.optional(),
    diagnosticThresholds: nestedDiagnosticThresholds.optional(),
    outputs,
    refresh: z.boolean().optional(),
  })
  .strict();
const renderInput = z
  .object({
    workspaceId: workspaceIdSchema,
    analysisId: z.string().min(1).max(256),
    expectedScenarioHash: sha256Schema.optional(),
    outputs: z.array(probabilityOutputSchema).min(1).max(10),
    includeHtml: z.boolean().default(false),
    filter: nestedRenderFilter.optional(),
  })
  .strict();

const analysisDataSchema = z
  .object({
    operation: z.enum(['evaluate', 'sweep', 'simulate', 'sequence', 'compare', 'render']),
    analysisId: z.string().max(256),
    analysisStatus: z.enum(['complete', 'partial', 'blocked', 'cancelled', 'stale']),
    adapterId: z.string().max(256),
    sourceRevision: sha256Schema,
    sourceHash: sha256Schema,
    scenarioHash: sha256Schema,
    cacheKey: sha256Schema,
    scenarios: nonNegativeIntegerSchema,
    candidates: nonNegativeIntegerSchema,
    unresolved: nonNegativeIntegerSchema,
    diagnostics: nonNegativeIntegerSchema,
    sweepPoints: nonNegativeIntegerSchema.optional(),
    samples: nonNegativeIntegerSchema.optional(),
    sequenceMethod: z
      .enum(['exact_state_distribution', 'bounded_beam', 'seeded_monte_carlo'])
      .optional(),
    comparisonChanges: nonNegativeIntegerSchema.optional(),
    visualResources: nonNegativeIntegerSchema.optional(),
  })
  .strict();

const inspectDataSchema = z
  .object({
    adapters: nonNegativeIntegerSchema,
    adapterId: z.string().max(256).optional(),
    sourceRevision: sha256Schema.optional(),
    sourceHash: sha256Schema.optional(),
    candidates: nonNegativeIntegerSchema,
    poolComplete: z.boolean().optional(),
    requiredInputs: nonNegativeIntegerSchema,
    unresolved: nonNegativeIntegerSchema,
  })
  .strict();

const analysisOutput = strictOperationResultSchema(analysisDataSchema);
const inspectOutput = strictOperationResultSchema(inspectDataSchema);

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function requestContext(
  engine: CoreEngine,
  context: ServerContext,
  workspaceId: string,
  refresh: boolean | undefined,
  signal: AbortSignal,
) {
  return {
    workspaceId: engine.resolver.resolveWorkspaceId(workspaceId, context.principal),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(refresh === undefined ? {} : { refresh }),
    signal,
  };
}

function analysisData(result: Awaited<ReturnType<ProbabilityAnalyzer['evaluate']>>) {
  return {
    operation: result.operation,
    analysisId: result.analysisId,
    analysisStatus: result.status,
    adapterId: result.adapter.id,
    sourceRevision: result.metadata.sourceRevision,
    sourceHash: result.metadata.sourceHash,
    scenarioHash: result.metadata.scenarioHash,
    cacheKey: result.metadata.cacheKey,
    scenarios: result.scenarios.length,
    candidates: result.scenarios.reduce((sum, scenario) => sum + scenario.candidates.length, 0),
    unresolved: result.unresolved.length,
    diagnostics: result.diagnostics.length,
    ...(result.sweep === undefined ? {} : { sweepPoints: result.sweep.points.length }),
    ...(result.metadata.samples === undefined ? {} : { samples: result.metadata.samples }),
    ...(result.sequence === undefined ? {} : { sequenceMethod: result.sequence.method }),
    ...(result.comparison === undefined
      ? {}
      : { comparisonChanges: result.comparison.scenarioChanges.length }),
    visualResources: result.resources.filter(({ mimeType }) => mimeType.startsWith('image/'))
      .length,
  };
}

function analysisServiceResult(
  workspaceId: string,
  result: Awaited<ReturnType<ProbabilityAnalyzer['evaluate']>>,
) {
  const output = emptyServiceResult(workspaceId, analysisData(result));
  output.code =
    result.status === 'complete'
      ? 'PROBABILITY_ANALYZED'
      : result.status === 'stale'
        ? result.diagnostics.some(({ code }) => code === 'PROBABILITY_SCENARIO_STALE')
          ? 'PROBABILITY_SCENARIO_STALE'
          : 'PROBABILITY_ANALYSIS_STALE'
        : 'PROBABILITY_ANALYZED_PARTIAL';
  output.artifacts = result.resources;
  output.diagnostics = result.diagnostics;
  output.validation = {
    passed: result.status !== 'blocked' && result.status !== 'cancelled',
    checks: [
      {
        id: 'uncertainty-visible',
        passed: true,
        message: `${result.unresolved.length} unresolved or bounded analysis item(s) are explicit`,
      },
    ],
  };
  return output;
}

export function registerProbabilityTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const analyzer = new ProbabilityAnalyzer(engine);

  server.registerTool(
    'hoi4.probability_inspect',
    {
      title: 'Inspect AI and MTTH weighted logic',
      description:
        'List versioned adapters or discover weighted blocks, candidate pools, capabilities, provenance, and unsupported constructs.',
      inputSchema: inspectInput,
      outputSchema: inspectOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(
        engine,
        context,
        input.workspaceId,
        input.refresh,
        progress.signal,
      );
      try {
        await progress.report(0, 2, 'Inspecting weighted source');
        const inspected = await analyzer.inspect(
          base,
          input.adapter,
          input.source as ProbabilityAnalysisRequest['source'] | undefined,
          input.candidatePool,
        );
        const result = emptyServiceResult(base.workspaceId, {
          adapters: inspected.adapters.length,
          ...(inspected.surface === undefined
            ? {}
            : {
                adapterId: inspected.surface.adapter.id,
                sourceRevision: inspected.surface.sourceRevision,
                sourceHash: inspected.surface.sourceHash,
                poolComplete: inspected.surface.poolComplete,
              }),
          candidates: inspected.surface?.candidateCount ?? 0,
          requiredInputs: inspected.surface?.requiredInputs.length ?? 0,
          unresolved: inspected.surface?.unsupported.length ?? 0,
        });
        result.code =
          inspected.surface === undefined
            ? 'PROBABILITY_ADAPTERS_LISTED'
            : 'PROBABILITY_SOURCE_INSPECTED';
        result.artifacts = inspected.artifacts;
        setInlineFilesScanned(result, inspected.filesScanned);
        await progress.report(2, 2, 'Weighted source inspection complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.probability_evaluate',
    {
      title: 'Evaluate AI and MTTH scenarios',
      description:
        'Evaluate eligibility, modifier traces, exact values, proven probabilities, MTTH timing, bounds, and unresolved inputs.',
      inputSchema: evaluateInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(
        engine,
        context,
        input.workspaceId,
        input.refresh,
        progress.signal,
      );
      try {
        await progress.report(0, 3, 'Scanning and evaluating weighted source');
        const request = {
          ...base,
          ...input,
          workspaceId: base.workspaceId,
        } as unknown as ProbabilityAnalysisRequest;
        const analyzed = await analyzer.evaluate(request);
        await progress.report(3, 3, 'Scenario evaluation complete');
        return toolResult(analysisServiceResult(base.workspaceId, analyzed));
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.probability_sweep',
    {
      title: 'Sweep AI and MTTH parameters',
      description:
        'Evaluate declared ranges, sensitivity, breakpoints, and rank reversals without inventing world state.',
      inputSchema: sweepInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(
        engine,
        context,
        input.workspaceId,
        input.refresh,
        progress.signal,
      );
      try {
        await progress.report(0, 3, 'Evaluating parameter sweep');
        const request = {
          ...base,
          ...input,
          workspaceId: base.workspaceId,
        } as unknown as ProbabilitySweepRequest;
        const analyzed = await analyzer.sweep(request);
        await progress.report(3, 3, 'Parameter sweep complete');
        return toolResult(analysisServiceResult(base.workspaceId, analyzed));
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.probability_simulate',
    {
      title: 'Simulate uncertain weighted scenarios',
      description:
        'Run reproducible seeded Monte Carlo analysis with distributions, supported correlations, and confidence intervals.',
      inputSchema: simulateInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(
        engine,
        context,
        input.workspaceId,
        input.refresh,
        progress.signal,
      );
      try {
        await progress.report(0, input.samples, 'Sampling uncertain scenarios');
        const request = {
          ...base,
          ...input,
          workspaceId: base.workspaceId,
        } as unknown as ProbabilitySimulationRequest;
        const analyzed = await analyzer.simulate(request);
        await progress.report(input.samples, input.samples, 'Seeded simulation complete');
        return toolResult(analysisServiceResult(base.workspaceId, analyzed));
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.probability_sequence',
    {
      title: 'Analyze a declared weighted sequence',
      description:
        'Analyze only manifest-declared recovery, caps, cooldowns, removals, resets, timers, and terminal states.',
      inputSchema: sequenceInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(engine, context, input.workspaceId, undefined, progress.signal);
      try {
        await progress.report(0, input.maxSteps, 'Analyzing declared sequence');
        const request = {
          ...base,
          ...input,
          workspaceId: base.workspaceId,
        } as unknown as ProbabilitySequenceRequest;
        const analyzed = await analyzer.sequence(request);
        await progress.report(input.maxSteps, input.maxSteps, 'Sequence analysis complete');
        return toolResult(analysisServiceResult(base.workspaceId, analyzed));
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.probability_compare',
    {
      title: 'Compare weighted source patches',
      description:
        'Compare real or proposed source under identical scenarios with modifier, score, probability, timing, and rank attribution.',
      inputSchema: compareInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(
        engine,
        context,
        input.workspaceId,
        input.refresh,
        progress.signal,
      );
      try {
        await progress.report(0, 4, 'Comparing weighted source');
        const request = {
          ...base,
          ...input,
          workspaceId: base.workspaceId,
        } as unknown as ProbabilityCompareRequest;
        const analyzed = await analyzer.compare(request);
        await progress.report(4, 4, 'Weighted source comparison complete');
        return toolResult(analysisServiceResult(base.workspaceId, analyzed));
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.probability_render',
    {
      title: 'Render AI and MTTH analysis',
      description:
        'Render cached analysis data as deterministic ranking, matrix, waterfall, timing, sensitivity, sequence, comparison, or unresolved resources.',
      inputSchema: renderInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const progress = progressReporter(extra);
      const base = requestContext(engine, context, input.workspaceId, undefined, progress.signal);
      try {
        await progress.report(0, input.outputs.length, 'Rendering analysis resources');
        const request = {
          ...base,
          ...input,
          workspaceId: base.workspaceId,
          outputs: input.outputs.filter(
            (output: z.infer<typeof probabilityOutputSchema>) => output !== 'json',
          ),
        } as unknown as ProbabilityRenderRequest;
        const analyzed = await analyzer.render(request);
        await progress.report(
          input.outputs.length,
          input.outputs.length,
          'Analysis rendering complete',
        );
        return toolResult(analysisServiceResult(base.workspaceId, analyzed));
      } catch (error) {
        return errorResult(error, base.workspaceId);
      }
    },
  );

  server.registerPrompt(
    'hoi4.probability_analysis',
    {
      title: 'Analyze HOI4 weighted logic',
      description:
        'Plan one source-linked AI, MTTH, random, or declared-pool analysis and return to the owning modding workflow.',
      argsSchema: {
        objective: z.string().min(1).max(4096),
        sourceHint: z.string().max(1024).optional(),
      },
    },
    ({ objective, sourceHint }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze this HOI4 weighted-logic task: ${objective}${sourceHint === undefined ? '' : `\nSource hint: ${sourceHint}`}\nIdentify the exact weighted surface and adapter, declare representative world-state scenarios and every required candidate or external factor, inspect first, run the narrowest useful evaluate/sweep/simulate/sequence/compare operation, review linked uncertainty and provenance, then return the findings to the normal owning modding workflow. Do not infer missing state, execute effects, or edit source through probability tools.`,
          },
        },
      ],
    }),
  );
}
