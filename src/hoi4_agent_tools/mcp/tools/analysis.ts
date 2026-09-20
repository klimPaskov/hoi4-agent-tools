import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  decisionInspectRequestSchema,
  impactInspectRequestSchema,
} from '../../schemas/analysis.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';
import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';

const impactOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: z.enum(['inspect', 'compare']),
      sourceRevision: sha256Schema,
      proposedRevision: sha256Schema.optional(),
      reportHash: sha256Schema,
      complete: z.boolean(),
      definitions: nonNegativeIntegerSchema,
      directConsumers: nonNegativeIntegerSchema,
      transitiveConsumers: nonNegativeIntegerSchema,
      affectedFiles: nonNegativeIntegerSchema,
      cycles: nonNegativeIntegerSchema,
      scenarioSuites: nonNegativeIntegerSchema,
      affectedCases: nonNegativeIntegerSchema,
      unresolved: nonNegativeIntegerSchema,
      addedConsumers: nonNegativeIntegerSchema.optional(),
      removedConsumers: nonNegativeIntegerSchema.optional(),
    })
    .strict(),
);

const decisionOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: z.enum(['inventory', 'inspect', 'compare']),
      sourceRevision: sha256Schema,
      proposedRevision: sha256Schema.optional(),
      reportHash: sha256Schema,
      complete: z.boolean(),
      decisions: nonNegativeIntegerSchema,
      categories: nonNegativeIntegerSchema,
      overrides: nonNegativeIntegerSchema,
      scenarios: nonNegativeIntegerSchema,
      unresolvedDefinitions: nonNegativeIntegerSchema,
    })
    .strict(),
);

const readOnlyAnalysisTool = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const analysisTaskTools = [
  {
    name: 'hoi4.impact_inspect',
    title: 'Inspect cross-system impact',
    description:
      'Trace definitions and consumers of symbols or changed source across HOI4 systems. Proposed sources are analyzed in memory; full revision-bound evidence is linked.',
    inputSchema: impactInspectRequestSchema,
    outputSchema: impactOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.decision_inspect',
    title: 'Inspect decisions and missions',
    description:
      'Inventory decisions or evaluate declared actor and target scenarios for gates, payment, lifecycle, and proposed-source differences. Full evidence is linked.',
    inputSchema: decisionInspectRequestSchema,
    outputSchema: decisionOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerAnalysisTools(server: McpServer): void {
  registerLegacyTaskTools(server, analysisTaskTools);
}
