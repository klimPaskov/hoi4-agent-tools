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
  probabilityAnalyzeRequestSchema,
  probabilityInspectRequestSchema,
} from '../../schemas/probability-requests.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

const rankedCandidateSchema = z
  .object({
    id: z.string().max(512),
    eligible: z.enum(['true', 'false', 'unresolved']),
    weight: z.number().nullable(),
    weightRange: z.array(z.number().nullable()).length(2).optional(),
    probability: z.number().nullable(),
    mtthDays: z.number().nullable().optional(),
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
    eligibleCandidates: nonNegativeIntegerSchema,
    excludedCandidates: nonNegativeIntegerSchema,
    unresolvedCandidates: nonNegativeIntegerSchema,
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
    ranking: z
      .array(
        z
          .object({
            scenarioId: z.string().max(512),
            poolComplete: z.boolean(),
            candidates: z.array(rankedCandidateSchema).max(12),
            omittedCandidates: nonNegativeIntegerSchema.optional(),
          })
          .strict(),
      )
      .max(4),
    missingInputs: z.array(z.string().max(1024)).max(16),
    changes: z
      .array(
        z
          .object({
            scenarioId: z.string().max(512),
            candidateId: z.string().max(512),
            weightDelta: z.number().nullable().optional(),
            probabilityDelta: z.number().nullable().optional(),
            eligibility: z.string().max(64).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
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
    requiredInputPaths: z.array(z.string().max(1024)).max(32),
    requiredInputPathsTruncated: z.boolean(),
    adapterRequiredInputPaths: z.array(z.string().max(1024)).max(32).optional(),
    unresolved: nonNegativeIntegerSchema,
  })
  .strict();

const analysisOutput = strictOperationResultSchema(analysisDataSchema);
const inspectOutput = strictOperationResultSchema(z.union([analysisDataSchema, inspectDataSchema]));
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const probabilityTaskTools = [
  {
    name: 'hoi4.probability_inspect',
    title: 'Inspect and evaluate AI weights and MTTH',
    description:
      "Find weighted logic (ai_will_do, ai_chance, MTTH, random_list, strategy factors) by path, ID, or candidate IDs and return each candidate's weight and probability under the given scenarios, or under no declared facts, with the facts still missing.",
    inputSchema: probabilityInspectRequestSchema,
    outputSchema: inspectOutput,
    annotations: readOnly,
  },
  {
    name: 'hoi4.probability_analyze',
    title: 'Compare, sweep, simulate, or sequence weighted logic',
    description:
      'Deeper weighted analysis: compare before/after source under the same scenarios, sweep input ranges for breakpoints and rank reversals, simulate uncertain inputs, analyze a declared pool over time, or render a retained analysis.',
    inputSchema: probabilityAnalyzeRequestSchema,
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
