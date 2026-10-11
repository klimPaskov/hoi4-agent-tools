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
      unresolvedSample: z
        .array(z.object({ id: z.string(), path: z.string(), reason: z.string() }).strict())
        .max(8)
        .optional(),
      outcomes: z
        .array(
          z
            .object({
              scenarioId: z.string(),
              found: z.boolean(),
              eligible: z.string().optional(),
              visible: z.string().nullable().optional(),
              available: z.string().optional(),
              unresolved: z
                .array(z.object({ code: z.string(), message: z.string() }).strict())
                .max(5)
                .optional(),
            })
            .strict(),
        )
        .max(16)
        .optional(),
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
      'Trace where symbols are defined and consumed across focuses, events, decisions, ideas, GUI and helpers, or what a changed file affects; proposed sources are analyzed in memory. Example: {"symbols":[{"kind":"scripted_effect","id":"my_effect"}]}. Returns consumer counts inline; the revision-bound graph is a linked resource.',
    inputSchema: impactInspectRequestSchema,
    outputSchema: impactOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.decision_inspect',
    title: 'Inspect decisions and missions',
    description:
      'Inventory decisions and missions, or evaluate one under declared actor and target scenarios: visibility, availability, payment, lifecycle and proposed-source differences. Example: {"mode":"inspect","id":"my_decision","scenarios":[{"id":"base","actor":"GER","state":{}}]}. Returns each scenario outcome inline; full evidence is linked.',
    inputSchema: decisionInspectRequestSchema,
    outputSchema: decisionOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.mechanic_test',
    title: 'Test declared mechanic steps',
    description:
      'Interpret source-backed effect steps (scripted effect, event option, decision, focus reward) on a declared state and check typed assertions; unsupported effects stay unresolved and no source changes. Example: {"test":{"id":"t","scenario":{"schemaVersion":"1.0","id":"t","state":{"treasury":10}},"steps":[...],"assertions":[...]}}. See docs/mechanics.md.',
    inputSchema: mechanicInputSchema,
    outputSchema: mechanicOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.package_check',
    title: 'Check package connections',
    description:
      'Check a declarative package manifest against active definitions, calls, registrations, localisation, assets and required suite cases. Example: {"manifest":{"schemaVersion":"1.0","id":"my_package","definitions":[{"kind":"scripted_effect","id":"my_effect"}]}}. Returns present, absent, shadowed and unresolved counts inline.',
    inputSchema: packageInputSchema,
    outputSchema: packageOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.scenario_test',
    title: 'Run scenario suite',
    description:
      'Run a suite of named mechanic, package or read-only tool cases, inline or from a workspace file, in resumable revision-bound batches. Example: {"suitePath":"tests/my_suite.json","maxCases":20}. Returns completed, failed, unresolved and pending counts, and a continuation while cases remain.',
    inputSchema: scenarioInputSchema,
    outputSchema: scenarioOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerAnalysisTools(server: McpServer): void {
  registerLegacyTaskTools(server, analysisTaskTools);
}
