import { z } from 'zod/v4';
import { declaredConditionScenarioSchema } from './analysis.js';
import { workspaceIdSchema, workspaceRelativePathSchema } from './common.js';

const identifier = z.string().min(1).max(512);
const manifestToken = z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/u);
const sourceSelector = z
  .object({
    kind: z.enum(['scripted_effect', 'event_option', 'decision', 'focus_reward']),
    id: identifier,
    option: identifier.optional(),
  })
  .strict();

export const sharedScenarioSchema = declaredConditionScenarioSchema.safeExtend({
  schemaVersion: z.literal('1.0'),
  globalFlags: z.array(identifier).max(10_000).optional(),
  scopeCatalogs: z
    .record(
      identifier,
      z
        .object({
          complete: z.boolean(),
          members: z.array(identifier).max(2_048),
        })
        .strict(),
    )
    .optional(),
});

const assertionPath = z
  .object({
    scope: identifier.default('ROOT'),
    key: identifier,
  })
  .strict();

const scalar = z.union([z.string().max(4_096), z.number(), z.boolean(), z.null()]);
export const mechanicAssertionSchema = z.discriminatedUnion('kind', [
  z
    .object({ id: identifier, kind: z.literal('equals'), path: assertionPath, expected: scalar })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('conservation'),
      paths: z.array(assertionPath).min(2).max(64),
      tolerance: z.number().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('array_alignment'),
      paths: z.array(assertionPath).min(2).max(32),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('affordability'),
      balance: assertionPath,
      cost: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('single_payment'),
      balance: assertionPath,
      cost: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('repeated_setup'),
      firstStep: z.number().int().nonnegative(),
      secondStep: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('exclusive_flags'),
      scope: identifier.default('ROOT'),
      flags: z.array(identifier).min(2).max(64),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal('cleanup'),
      scope: identifier.default('ROOT'),
      flags: z.array(identifier).max(64).default([]),
      targets: z.array(identifier).max(64).default([]),
    })
    .strict(),
  z
    .object({ id: identifier, kind: z.literal('end_state'), path: assertionPath, expected: scalar })
    .strict(),
]);

export const mechanicCaseSchema = z
  .object({
    id: identifier,
    scenario: sharedScenarioSchema,
    steps: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('effect'),
              source: sourceSelector,
              repeat: z.number().int().min(1).max(8).default(1),
            })
            .strict(),
          z
            .object({ kind: z.literal('advance_days'), days: z.number().int().min(0).max(36_500) })
            .strict(),
        ]),
      )
      .min(1)
      .max(128),
    assertions: z.array(mechanicAssertionSchema).min(1).max(256),
  })
  .strict();

export const mechanicTestRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    test: mechanicCaseSchema,
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    refresh: z.boolean().default(false),
  })
  .strict();

const manifestItem = z.object({ kind: manifestToken, id: manifestToken }).strict();
export const packageManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: manifestToken,
    definitions: z.array(manifestItem).max(2_048).default([]),
    calls: z
      .array(z.object({ from: manifestItem, to: manifestItem }).strict())
      .max(2_048)
      .default([]),
    registrations: z
      .array(z.object({ path: workspaceRelativePathSchema, token: manifestToken }).strict())
      .max(2_048)
      .default([]),
    localisation: z.array(manifestToken).max(2_048).default([]),
    assets: z.array(workspaceRelativePathSchema).max(2_048).default([]),
    requiredCases: z
      .array(z.object({ suite: workspaceRelativePathSchema, caseId: manifestToken }).strict())
      .max(512)
      .default([]),
  })
  .strict();

export const packageCheckRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    manifest: packageManifestSchema,
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    refresh: z.boolean().default(false),
  })
  .strict();

const readOnlySuiteTool = z.enum([
  'hoi4.impact_inspect',
  'hoi4.decision_inspect',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.tech_inspect',
  'hoi4.tech_render',
  'hoi4.probability_inspect',
  'hoi4.probability_evaluate',
  'hoi4.probability_render',
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.map_inspect',
  'hoi4.map_render',
]);
const suiteCaseMetadata = {
  sourceSelectors: z.array(manifestItem).max(64).default([]),
  assertions: z
    .array(
      z
        .object({
          id: identifier,
          path: z.array(identifier).min(1).max(16),
          expected: scalar,
        })
        .strict(),
    )
    .max(64)
    .default([]),
  views: z
    .array(z.enum(['summary', 'artifacts', 'diagnostics']))
    .max(3)
    .default(['summary']),
};
export const scenarioSuiteSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: identifier,
    cases: z
      .array(
        z.discriminatedUnion('domain', [
          z
            .object({
              domain: z.literal('mechanic'),
              id: identifier,
              test: mechanicCaseSchema,
              ...suiteCaseMetadata,
            })
            .strict(),
          z
            .object({
              domain: z.literal('package'),
              id: identifier,
              manifest: packageManifestSchema,
              ...suiteCaseMetadata,
            })
            .strict(),
          z
            .object({
              domain: z.literal('tool'),
              id: identifier,
              tool: readOnlySuiteTool,
              arguments: z.record(z.string().max(256), z.json()),
              ...suiteCaseMetadata,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((suite, context) => {
    const ids = new Set<string>();
    for (const [index, item] of suite.cases.entries()) {
      if (ids.has(item.id))
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'id'],
          message: 'Suite case ids must be unique',
        });
      ids.add(item.id);
    }
  });

export const scenarioTestRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    suite: scenarioSuiteSchema.optional(),
    suitePath: workspaceRelativePathSchema.optional(),
    continuation: z.string().max(4_096).optional(),
    maxCases: z.number().int().min(1).max(256).default(32),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    refresh: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.suite === undefined) === (input.suitePath === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Specify exactly one inline suite or suitePath',
      });
  });

export type MechanicCase = z.infer<typeof mechanicCaseSchema>;
export type MechanicAssertion = z.infer<typeof mechanicAssertionSchema>;
export type MechanicTestRequest = z.infer<typeof mechanicTestRequestSchema>;
export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type PackageCheckRequest = z.infer<typeof packageCheckRequestSchema>;
export type ScenarioSuite = z.infer<typeof scenarioSuiteSchema>;
export type ScenarioTestRequest = z.infer<typeof scenarioTestRequestSchema>;
