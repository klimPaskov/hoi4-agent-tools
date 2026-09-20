import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  decisionInspectRequestSchema,
  impactInspectRequestSchema,
} from '../../schemas/analysis.js';
import {
  mechanicCaseSchema,
  mechanicTestRequestSchema,
  packageManifestSchema,
  packageCheckRequestSchema,
  scenarioSuiteSchema,
  scenarioTestRequestSchema,
} from '../../schemas/scenarios.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
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

const mechanicOutputSchema = strictOperationResultSchema(
  z
    .object({
      sourceRevision: sha256Schema,
      reportHash: sha256Schema,
      status: z.enum(['passed', 'failed', 'unresolved']),
      assertions: nonNegativeIntegerSchema,
      passed: nonNegativeIntegerSchema,
      failed: nonNegativeIntegerSchema,
      unresolved: nonNegativeIntegerSchema,
      steps: nonNegativeIntegerSchema,
    })
    .strict(),
);

const packageOutputSchema = strictOperationResultSchema(
  z
    .object({
      sourceRevision: sha256Schema,
      reportHash: sha256Schema,
      complete: z.boolean(),
      items: nonNegativeIntegerSchema,
      present: nonNegativeIntegerSchema,
      absent: nonNegativeIntegerSchema,
      shadowed: nonNegativeIntegerSchema,
      unresolved: nonNegativeIntegerSchema,
    })
    .strict(),
);

const scenarioOutputSchema = strictOperationResultSchema(
  z
    .object({
      sourceRevision: sha256Schema,
      suiteHash: sha256Schema,
      reportHash: sha256Schema,
      start: nonNegativeIntegerSchema,
      end: nonNegativeIntegerSchema,
      total: nonNegativeIntegerSchema,
      completed: nonNegativeIntegerSchema,
      failed: nonNegativeIntegerSchema,
      unresolved: nonNegativeIntegerSchema,
      pending: nonNegativeIntegerSchema,
      continuation: z.string().optional(),
    })
    .strict(),
);

const mechanicInputSchema = z
  .object({
    ...mechanicTestRequestSchema.shape,
    test: compactValidatedInputSchema(
      mechanicCaseSchema,
      'Versioned declared scenario, explicit effect steps, and typed assertions. See docs/mechanics.md.',
    ),
  })
  .strict();

const packageInputSchema = z
  .object({
    ...packageCheckRequestSchema.shape,
    manifest: compactValidatedInputSchema(
      packageManifestSchema,
      'Declarative definitions, calls, registrations, localisation, assets, and required cases. See docs/mechanics.md.',
    ),
  })
  .strict();

const scenarioInputSchema = z
  .object({
    ...scenarioTestRequestSchema.shape,
    suite: compactValidatedInputSchema(
      scenarioSuiteSchema,
      'Named mechanic, package, or fixed read-only tool cases. See docs/mechanics.md.',
    ).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.suite === undefined) === (input.suitePath === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Specify exactly one inline suite or suitePath',
      });
  });

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
  {
    name: 'hoi4.mechanic_test',
    title: 'Test declared mechanic steps',
    description:
      'Interpret bounded, source-backed effect steps on isolated declared state and check typed invariants. Unsupported effects remain unresolved; no game or mod source is changed.',
    inputSchema: mechanicInputSchema,
    outputSchema: mechanicOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.package_check',
    title: 'Check package connections',
    description:
      'Check a declarative package manifest against active definitions, references, registrations, localisation, assets, and required suite cases.',
    inputSchema: packageInputSchema,
    outputSchema: packageOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.scenario_test',
    title: 'Run scenario suite',
    description:
      'Run named inline or workspace-relative cases through bounded typed read-only domain services. Large suites return an authenticated continuation.',
    inputSchema: scenarioInputSchema,
    outputSchema: scenarioOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerAnalysisTools(server: McpServer): void {
  registerLegacyTaskTools(server, analysisTaskTools);
}
