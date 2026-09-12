import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  ToolTaskHandler,
} from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import {
  probabilityCompareRequestSchema,
  probabilityEvaluateRequestSchema,
  probabilityInspectRequestSchema,
  probabilityRenderRequestSchema,
  probabilitySequenceRequestSchema,
  probabilitySimulateRequestSchema,
  probabilitySweepRequestSchema,
} from '../../schemas/probability-requests.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

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
    scopePools: nonNegativeIntegerSchema.optional(),
    scopePoolCandidates: nonNegativeIntegerSchema.optional(),
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
    requestedAdapter: z.string().max(256).optional(),
    suggestedAdapter: z.string().max(256).optional(),
    discoveryReason: z
      .enum([
        'source_inventory',
        'requested_adapter_empty',
        'identifier_not_found',
        'candidate_pool_not_found',
        'no_weighted_surfaces',
      ])
      .optional(),
    sourceRevision: sha256Schema.optional(),
    sourceHash: sha256Schema.optional(),
    candidates: nonNegativeIntegerSchema,
    availableCandidates: nonNegativeIntegerSchema,
    availableAdapters: z
      .array(
        z
          .object({
            adapterId: z.string().max(256),
            candidates: nonNegativeIntegerSchema,
            identifierMatches: nonNegativeIntegerSchema,
            candidatePoolMatches: nonNegativeIntegerSchema,
          })
          .strict(),
      )
      .max(10),
    candidateExamples: z.array(z.string().max(512)).max(10),
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

function probabilityTaskHandler(schema: z.ZodType) {
  return {
    createTask: async (input: unknown, extra: CreateTaskRequestHandlerExtra) => {
      schema.parse(input);
      return CreateTaskResultSchema.parse({
        task: await extra.taskStore.createTask({
          ttl: extra.taskRequestedTtl ?? null,
          pollInterval: 250,
        }),
      });
    },
    getTask: async (_input: unknown, extra: TaskRequestHandlerExtra) =>
      GetTaskResultSchema.parse(await extra.taskStore.getTask(extra.taskId)),
    getTaskResult: async (_input: unknown, extra: TaskRequestHandlerExtra) =>
      CallToolResultSchema.parse(await extra.taskStore.getTaskResult(extra.taskId)),
  };
}

export function registerProbabilityTools(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_inspect',
    {
      title: 'Inspect AI and MTTH weighted logic',
      description: 'Discover weighted adapters, candidates, provenance, and required inputs.',
      inputSchema: probabilityInspectRequestSchema,
      outputSchema: inspectOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilityInspectRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilityInspectRequestSchema
    >,
  );
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_evaluate',
    {
      title: 'Evaluate AI and MTTH scenarios',
      description: 'Evaluate weights and probabilities under explicit scenarios.',
      inputSchema: probabilityEvaluateRequestSchema,
      outputSchema: analysisOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilityEvaluateRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilityEvaluateRequestSchema
    >,
  );
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_sweep',
    {
      title: 'Sweep AI and MTTH parameters',
      description: 'Evaluate declared ranges, breakpoints, and rank reversals.',
      inputSchema: probabilitySweepRequestSchema,
      outputSchema: analysisOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilitySweepRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilitySweepRequestSchema
    >,
  );
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_simulate',
    {
      title: 'Simulate uncertain weighted scenarios',
      description: 'Run seeded simulations with distributions and confidence intervals.',
      inputSchema: probabilitySimulateRequestSchema,
      outputSchema: analysisOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilitySimulateRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilitySimulateRequestSchema
    >,
  );
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_sequence',
    {
      title: 'Analyze a declared weighted sequence',
      description: 'Analyze a manifest-declared dynamic weighted sequence.',
      inputSchema: probabilitySequenceRequestSchema,
      outputSchema: analysisOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilitySequenceRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilitySequenceRequestSchema
    >,
  );
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_compare',
    {
      title: 'Compare weighted source patches',
      description: 'Compare sources or declared pools under identical scenarios.',
      inputSchema: probabilityCompareRequestSchema,
      outputSchema: analysisOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilityCompareRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilityCompareRequestSchema
    >,
  );
  server.experimental.tasks.registerToolTask(
    'hoi4.probability_render',
    {
      title: 'Render AI and MTTH analysis',
      description: 'Render retained probability analysis as deterministic resources.',
      inputSchema: probabilityRenderRequestSchema,
      outputSchema: analysisOutput,
      annotations: readOnly,
      execution: { taskSupport: 'optional' },
    },
    probabilityTaskHandler(probabilityRenderRequestSchema) as unknown as ToolTaskHandler<
      typeof probabilityRenderRequestSchema
    >,
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
