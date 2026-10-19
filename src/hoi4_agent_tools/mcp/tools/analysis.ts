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
      affectedFilePaths: z.array(z.string().max(1024)).max(64).optional(),
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
      'Named mechanic, package or inspection cases. See docs/mechanics.md.',
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
    title: 'Find what a script change affects',
    description:
      'Find what a script change affects across focuses, events, decisions, ideas, windows and helpers. Trace definitions and their uses, including proposed source. Example: {"symbols":[{"kind":"scripted_effect","id":"my_effect"}]}. Returns consumer counts inline; the revision-bound graph is a linked resource.',
    inputSchema: impactInspectRequestSchema,
    outputSchema: impactOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.decision_inspect',
    title: 'Inspect decisions and missions',
    description:
      'Explain why a decision or mission is hidden, unavailable or unaffordable. Inspect conditions, costs and lifecycle for declared actors and targets, or compare proposed source. Example: {"mode":"inspect","id":"my_decision","scenarios":[{"id":"base","actor":"GER","state":{}}]}. Returns each scenario outcome inline; full evidence is linked.',
    inputSchema: decisionInspectRequestSchema,
    outputSchema: decisionOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.mechanic_test',
    title: 'Test scripted effects',
    description:
      'Test what an effect, event option, decision or focus reward does to a declared state. Run steps and check assertions; unsupported effects stay unresolved. See docs/mechanics.md. Example: {"test":{"id":"t","scenario":{"schemaVersion":"1.0","id":"t","state":{"treasury":10}},"steps":[...],"assertions":[...]}}.',
    inputSchema: mechanicInputSchema,
    outputSchema: mechanicOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.package_check',
    title: 'Check package connections',
    description:
      'Find missing pieces of a feature by checking its package manifest against definitions, calls, registrations, localisation, assets and required test cases. Example: {"manifest":{"schemaVersion":"1.0","id":"my_package","definitions":[{"kind":"scripted_effect","id":"my_effect"}]}}. Returns present, absent, shadowed and unresolved counts inline.',
    inputSchema: packageInputSchema,
    outputSchema: packageOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
  {
    name: 'hoi4.scenario_test',
    title: 'Run scenario suite',
    description:
      'Run named mechanic, package or inspection cases from a suite or workspace file. Continue unfinished batches and report failures and unresolved cases. Example: {"suitePath":"tests/my_suite.json","maxCases":20}. Returns completed, failed, unresolved and pending counts, and a continuation while cases remain.',
    inputSchema: scenarioInputSchema,
    outputSchema: scenarioOutputSchema,
    annotations: readOnlyAnalysisTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerAnalysisTools(server: McpServer): void {
  registerLegacyTaskTools(server, analysisTaskTools);
}
