import { z } from 'zod/v4';
import { workspaceIdSchema, workspaceRelativePathSchema } from './common.js';
import { ConditionControlMapSchema } from '../core/condition-schema.js';

const symbolKindSchema = z.enum([
  'focus_tree',
  'focus',
  'continuous_focus_palette',
  'continuous_focus',
  'decision',
  'decision_category',
  'event',
  'idea',
  'leader',
  'formable',
  'scripted_effect',
  'scripted_trigger',
  'script_constant',
  'mtth_variable',
  'ai_strategy',
  'ai_strategy_plan',
  'sprite',
  'texture',
  'gui_element',
  'scripted_gui',
  'technology',
  'technology_folder',
  'technology_category',
  'technology_tag',
  'equipment',
  'equipment_module',
  'sub_unit',
  'unit_category',
  'building',
  'ability',
  'combat_tactic',
  'doctrine_folder',
  'grand_doctrine',
  'doctrine_track',
  'subdoctrine',
  'localisation',
  'variable',
  'flag',
  'event_target',
  'state',
  'province',
  'province_color',
  'strategic_region',
  'adjacency',
  'supply_node',
  'railway',
]);

export const impactSymbolSelectorSchema = z
  .object({
    kind: symbolKindSchema,
    id: z.string().min(1).max(512),
  })
  .strict();

const sourceDisplayPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    const separator = value.indexOf(':');
    if (separator < 1) return false;
    const root = value.slice(0, separator);
    if (!/^(?:mod|game|fixture|dependency-[0-9]+)$/u.test(root)) return false;
    return workspaceRelativePathSchema.safeParse(value.slice(separator + 1)).success;
  }, 'Use a scanned source display path under an authorized workspace root');

export const proposedAnalysisSourceSchema = z
  .object({
    relativePath: workspaceRelativePathSchema,
    content: z
      .string()
      .max(8 * 1024 * 1024)
      .nullable(),
  })
  .strict();

const scenarioScalarSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const scenarioValueSchema = z.union([
  scenarioScalarSchema,
  z.array(scenarioScalarSchema).max(10_000),
]);
const scenarioStateSchema = z
  .record(z.string().min(1).max(1024), scenarioValueSchema)
  .refine((state) => Object.keys(state).length <= 10_000, 'Scenario state has too many keys');
const scopeBindingSchema = z
  .object({
    id: z.string().min(1).max(512),
    type: z
      .enum([
        'country',
        'state',
        'character',
        'unit_leader',
        'operative',
        'strategic_region',
        'province',
        'unknown',
      ])
      .optional(),
    actor: z.string().max(256).optional(),
    state: scenarioStateSchema,
    flags: z.array(z.string().min(1).max(512)).max(10_000).optional(),
    eventTargets: z.record(z.string().max(512), z.string().max(512)).optional(),
    weight: z.union([z.number(), z.string().max(1024)]).optional(),
  })
  .strict();

export const declaredConditionScenarioSchema = z
  .object({
    id: z.string().min(1).max(512),
    actor: z.string().max(256).optional(),
    date: z.string().max(64).optional(),
    controls: ConditionControlMapSchema.optional(),
    state: scenarioStateSchema,
    flags: z.array(z.string().min(1).max(512)).max(10_000).optional(),
    eventTargets: z.record(z.string().max(512), z.string().max(512)).optional(),
    scopes: z
      .record(z.string().min(1).max(128), scopeBindingSchema)
      .refine((scopes) => Object.keys(scopes).length <= 64, 'Too many declared scopes')
      .optional(),
    candidateOverrides: z.record(z.string().max(512), z.boolean()).optional(),
    closedFlags: z.boolean().optional(),
  })
  .strict();

export const impactInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    symbols: z.array(impactSymbolSelectorSchema).max(64).default([]),
    changedFiles: z.array(sourceDisplayPathSchema).max(64).default([]),
    scenarioSuites: z
      .array(
        workspaceRelativePathSchema.refine(
          (value) => value.toLowerCase().endsWith('.json'),
          'Scenario suite path must name a JSON file',
        ),
      )
      .max(32)
      .default([]),
    proposedSources: z.array(proposedAnalysisSourceSchema).min(1).max(64).optional(),
    maxNodes: z.number().int().min(1).max(50_000).optional(),
    maxEdges: z.number().int().min(1).max(100_000).optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    refresh: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.symbols.length === 0 &&
      input.changedFiles.length === 0 &&
      input.proposedSources === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Impact inspection requires a symbol, changed file, or proposed source',
      });
  });

export const decisionInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: z.enum(['inventory', 'inspect', 'compare']).default('inventory'),
    id: z.string().min(1).max(512).optional(),
    scenarios: z.array(declaredConditionScenarioSchema).max(64).default([]),
    proposedSources: z.array(proposedAnalysisSourceSchema).min(1).max(64).optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    refresh: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = new Set<string>();
    for (const [index, scenario] of input.scenarios.entries()) {
      if (ids.has(scenario.id))
        context.addIssue({
          code: 'custom',
          path: ['scenarios', index, 'id'],
          message: 'Scenario IDs must be unique',
        });
      ids.add(scenario.id);
    }
    if (input.mode === 'inventory') {
      if (input.proposedSources !== undefined)
        context.addIssue({
          code: 'custom',
          path: ['proposedSources'],
          message: 'Inventory mode does not accept proposed sources',
        });
      return;
    }
    if (input.id === undefined)
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Decision inspection requires an identifier',
      });
    if (input.scenarios.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['scenarios'],
        message: 'Decision inspection requires declared scenarios',
      });
    if (input.mode === 'compare' && input.proposedSources === undefined)
      context.addIssue({
        code: 'custom',
        path: ['proposedSources'],
        message: 'Decision comparison requires proposed sources',
      });
    if (input.mode === 'inspect' && input.proposedSources !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['proposedSources'],
        message: 'Use compare mode for proposed sources',
      });
  });

export type ImpactInspectRequest = z.infer<typeof impactInspectRequestSchema>;
export type DecisionInspectRequest = z.infer<typeof decisionInspectRequestSchema>;

/** A reference projection of future scenario suites; Stage 3 reads but never executes it. */
export const impactScenarioSuiteReferenceSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1).max(512),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
            sourceSelectors: z.array(impactSymbolSelectorSchema).max(64).default([]),
            sourceFiles: z.array(sourceDisplayPathSchema).max(64).default([]),
          })
          .loose(),
      )
      .max(1_000),
  })
  .loose();
