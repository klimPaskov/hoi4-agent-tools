import { z } from 'zod/v4';
import { sourceLocationSchema } from './common.js';

const rawBlockSchema = z
  .object({
    text: z.string(),
    referencedFocusIds: z.array(z.string()).max(20_000),
    sourceLocation: sourceLocationSchema.optional(),
  })
  .strict();

const rawEntrySchema = z
  .object({
    kind: z.enum(['assignment', 'scalar', 'block']),
    key: z.string().optional(),
    order: z.number().int().min(0),
    text: z.string(),
    sourceLocation: sourceLocationSchema.optional(),
  })
  .strict();

const prerequisitesSchema = z
  .object({
    operator: z.literal('and'),
    groups: z
      .array(
        z
          .object({
            operator: z.literal('or'),
            focusIds: z.array(z.string()).min(1).max(10_000),
            rawPassthrough: z.array(rawEntrySchema).max(10_000),
            sourceLocation: sourceLocationSchema.optional(),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

const positionSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('fixed'),
      x: z.number().int().min(-100_000).max(100_000),
      y: z.number().int().min(-100_000).max(100_000),
      pinned: z.boolean(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('relative'),
      x: z.number().int().min(-100_000).max(100_000),
      y: z.number().int().min(-100_000).max(100_000),
      relativeTo: z.string().min(1),
      pinned: z.boolean(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('auto'),
      pinned: z.literal(false),
      preferredX: z.number().int().min(-100_000).max(100_000).optional(),
      preferredY: z.number().int().min(-100_000).max(100_000).optional(),
    })
    .strict(),
]);

const routeLockSchema = z
  .object({
    id: z.string().min(1),
    field: z.enum(['available', 'allow_branch']).optional(),
    mode: z.enum(['all', 'any']),
    requiredFocusIds: z.array(z.string()).max(10_000),
    excludedFocusIds: z.array(z.string()).max(10_000),
    alwaysImpossible: z.boolean().optional(),
    sourceLocation: sourceLocationSchema.optional(),
  })
  .strict();

const iconSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('static'),
      sprite: z.string().min(1),
      sourceLocation: sourceLocationSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dynamic'),
      sprite: z.string().min(1),
      trigger: rawBlockSchema.optional(),
      sourceLocation: sourceLocationSchema.optional(),
    })
    .strict(),
]);

const focusNodeSchema = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().max(1024),
    branchId: z.string().optional(),
    laneId: z.string().optional(),
    prerequisites: prerequisitesSchema,
    mutuallyExclusive: z.array(z.string()).max(10_000),
    routeLocks: z.array(routeLockSchema).max(10_000),
    availability: rawBlockSchema.optional(),
    bypass: rawBlockSchema.optional(),
    allowBranch: rawBlockSchema.optional(),
    position: positionSchema,
    visibility: z.enum(['normal', 'hidden', 'crisis', 'conditional']),
    reveal: z
      .object({
        kind: z.enum(['allow_branch', 'event', 'decision', 'scripted_trigger', 'manual']),
        references: z.array(z.string()).max(10_000),
        description: z.string().optional(),
        trigger: rawBlockSchema.optional(),
      })
      .strict()
      .optional(),
    convergence: z.boolean(),
    sharedSupport: z.boolean(),
    continuous: z.literal(false).optional(),
    icons: z.array(iconSchema).max(100),
    localisation: z
      .object({
        titleKey: z.string(),
        descriptionKey: z.string(),
        workingLabel: z.string().optional(),
      })
      .strict(),
    ai: z
      .object({
        raw: rawBlockSchema.optional(),
        majorRoute: z.boolean(),
        strategyIds: z.array(z.string()).max(10_000),
      })
      .strict(),
    filters: z.array(z.string()).max(1000),
    links: z
      .array(
        z
          .object({
            kind: z.enum([
              'decision',
              'decision_category',
              'event',
              'idea',
              'leader',
              'formable',
              'helper',
            ]),
            target: z.string().min(1),
            sourceLocation: sourceLocationSchema.optional(),
          })
          .strict(),
      )
      .max(10_000),
    cost: z.number().optional(),
    completionReward: rawBlockSchema.optional(),
    payoff: z.string().optional(),
    terminalKind: z
      .enum(['capstone', 'convergence', 'failure', 'route_lock', 'formable', 'side_payoff'])
      .optional(),
    rawPassthrough: z.array(rawEntrySchema).max(20_000),
    sourceLocation: sourceLocationSchema.optional(),
  })
  .strict();

export const focusTreePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(256),
    countryAssignment: z
      .object({
        raw: rawBlockSchema,
        countryTags: z.array(z.string()).max(1000),
      })
      .strict()
      .optional(),
    default: z.boolean(),
    branchGroups: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string(),
            family: z.string(),
            focusIds: z.array(z.string()).max(10_000),
            laneId: z.string().optional(),
            major: z.boolean(),
            hidden: z.boolean(),
            crisis: z.boolean(),
            conditional: z.boolean(),
            aiStrategyIds: z.array(z.string()).max(10_000),
          })
          .strict(),
      )
      .max(10_000),
    laneGroups: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string(),
            order: z.number().int(),
            minimumX: z.number().int().optional(),
            maximumX: z.number().int().optional(),
          })
          .strict()
          .superRefine((lane, context) => {
            if (
              lane.minimumX !== undefined &&
              lane.maximumX !== undefined &&
              lane.minimumX > lane.maximumX
            ) {
              context.addIssue({
                code: 'custom',
                path: ['minimumX'],
                message: 'minimumX must be less than or equal to maximumX',
              });
            }
          }),
      )
      .max(10_000),
    entryFocusIds: z.array(z.string()).max(10_000),
    focuses: z.array(focusNodeSchema).min(1).max(10_000),
    sharedFocusIds: z.array(z.string()).max(10_000),
    continuousFocusPaletteIds: z.array(z.string()).max(10_000),
    continuousFocusIds: z.array(z.string()).max(10_000),
    continuousFocusPosition: z
      .object({ x: z.number().int(), y: z.number().int() })
      .strict()
      .optional(),
    initialShowPosition: rawBlockSchema.optional(),
    runtimeAssignment: z
      .object({
        replacesExistingCountryTree: z.boolean(),
        eventCreatedGuard: z.string().optional(),
      })
      .strict()
      .optional(),
    rawPassthrough: z.array(rawEntrySchema).max(20_000),
    provenance: z
      .object({
        sourcePath: z.string().min(1),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
        importedPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    sourceLocation: sourceLocationSchema.optional(),
  })
  .strict();

const focusLocalisationSchema = z
  .object({
    titleKey: z.string(),
    descriptionKey: z.string(),
    workingLabel: z.string().optional(),
  })
  .strict();

const countryAssignmentSchema = z
  .object({
    raw: rawBlockSchema,
    countryTags: z.array(z.string()).max(1000),
  })
  .strict();

export const continuousFocusPaletteSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(256),
    countryAssignment: countryAssignmentSchema.optional(),
    default: z.boolean(),
    resetOnCivilWar: z.boolean().optional(),
    position: z.object({ x: z.number().int(), y: z.number().int() }).strict().optional(),
    focuses: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          icons: z.array(iconSchema).max(100),
          localisation: focusLocalisationSchema,
          rawPassthrough: z.array(rawEntrySchema).max(20_000),
          sourceLocation: sourceLocationSchema.optional(),
        })
        .strict(),
    ),
    rawPassthrough: z.array(rawEntrySchema).max(20_000),
    provenance: z
      .object({
        sourcePath: z.string().min(1),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
        importedPlanHash: z.string().min(1),
      })
      .strict(),
    sourceLocation: sourceLocationSchema.optional(),
  })
  .strict();

export const focusPlanningSidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    treeId: z.string().min(1),
    sourcePath: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    branchGroups: focusTreePlanSchema.shape.branchGroups,
    laneGroups: focusTreePlanSchema.shape.laneGroups,
    entryFocusIds: z.array(z.string()),
    continuousFocusPaletteIds: z.array(z.string()),
    continuousFocusIds: z.array(z.string()),
    runtimeAssignment: focusTreePlanSchema.shape.runtimeAssignment,
    focuses: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string(),
          branchId: z.string().optional(),
          laneId: z.string().optional(),
          pinned: z.boolean(),
          visibility: z.enum(['normal', 'hidden', 'crisis', 'conditional']),
          reveal: focusNodeSchema.shape.reveal,
          convergence: z.boolean(),
          sharedSupport: z.boolean(),
          workingLabel: z.string().optional(),
          aiMajorRoute: z.boolean(),
          aiStrategyIds: z.array(z.string()),
          payoff: z.string().optional(),
          terminalKind: focusNodeSchema.shape.terminalKind,
        })
        .strict(),
    ),
  })
  .strict();

export const focusLayoutDecisionSchema = z
  .object({
    focusId: z.string(),
    kind: z.enum([
      'preserved',
      'relative',
      'placed',
      'moved_for_collision',
      'moved_for_mutual_exclusion',
      'moved_to_reduce_crossings',
    ]),
    message: z.string(),
  })
  .strict();

export const focusLayoutSchema = z
  .object({
    treeId: z.string(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          x: z.number().int(),
          y: z.number().int(),
          laneId: z.string(),
          preserved: z.boolean(),
          sourceMode: z.enum(['fixed', 'relative', 'auto']),
        })
        .strict(),
    ),
    decisions: z.array(focusLayoutDecisionSchema),
    diagnostics: z.array(z.unknown()),
    layoutHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
