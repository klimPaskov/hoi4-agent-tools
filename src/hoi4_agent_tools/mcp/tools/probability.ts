import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  probabilityPrompt,
  probabilityPromptArguments,
  probabilityPromptDefinition,
} from '../prompts/probability.js';

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

export const probabilityTaskTools = [
  {
    name: 'hoi4.probability_inspect',
    title: 'Inspect AI and MTTH weighted logic',
    description: 'Discover weighted adapters, candidates, provenance, and required inputs.',
    inputSchema: probabilityInspectRequestSchema,
    outputSchema: inspectOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_evaluate',
    title: 'Evaluate AI and MTTH scenarios',
    description: 'Evaluate weights and probabilities under explicit scenarios.',
    inputSchema: probabilityEvaluateRequestSchema,
    outputSchema: analysisOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_sweep',
    title: 'Sweep AI and MTTH parameters',
    description: 'Evaluate declared ranges, breakpoints, and rank reversals.',
    inputSchema: probabilitySweepRequestSchema,
    outputSchema: analysisOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_simulate',
    title: 'Simulate uncertain weighted scenarios',
    description: 'Run seeded simulations with distributions and confidence intervals.',
    inputSchema: probabilitySimulateRequestSchema,
    outputSchema: analysisOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_sequence',
    title: 'Analyze a declared weighted sequence',
    description: 'Analyze a manifest-declared dynamic weighted sequence.',
    inputSchema: probabilitySequenceRequestSchema,
    outputSchema: analysisOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_compare',
    title: 'Compare weighted source patches',
    description: 'Compare sources or declared pools under identical scenarios.',
    inputSchema: probabilityCompareRequestSchema,
    outputSchema: analysisOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_render',
    title: 'Render AI and MTTH analysis',
    description: 'Render retained probability analysis as deterministic resources.',
    inputSchema: probabilityRenderRequestSchema,
    outputSchema: analysisOutput,
    annotations: readOnly,
  },
] satisfies readonly TaskToolDefinition[];

export function registerProbabilityTools(server: McpServer): void {
  registerLegacyTaskTools(server, probabilityTaskTools);

  const { name, ...metadata } = probabilityPromptDefinition;
  server.registerPrompt(
    name,
    { ...metadata, argsSchema: probabilityPromptArguments.shape },
    probabilityPrompt,
  );
}
