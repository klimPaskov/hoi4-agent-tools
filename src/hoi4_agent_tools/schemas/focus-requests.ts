import { z } from 'zod/v4';
import { FOCUS_RENDER_MAX_OUTPUT_SCALE, FOCUS_RENDER_MIN_OUTPUT_SCALE } from '../focus/index.js';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';
import { continuousFocusPaletteSchema, focusLayoutSchema, focusTreePlanSchema } from './focus.js';

function compact<T extends z.ZodType>(schema: T, description: string): z.ZodPipe<z.ZodUnknown, T> {
  return z.unknown().describe(description).pipe(schema);
}

const compactFocusLayoutSchema = compact(
  focusLayoutSchema,
  'Prior deterministic focus layout used to stabilize unchanged positions.',
);
const compactFocusPlanSchema = compact(
  z.union([focusTreePlanSchema, continuousFocusPaletteSchema]),
  'Complete national or continuous focus plan.',
);

export const focusInspectRequestSchema = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema.optional(),
    treeId: z.string().min(1).max(256).optional(),
    paletteId: z.string().min(1).max(256).optional(),
    previous: compactFocusLayoutSchema.optional(),
    laneSpacing: z.number().int().min(1).max(100).optional(),
    nodeSpacing: z.number().int().min(1).max(100).optional(),
    scenario: z
      .object({ completedFocusIds: z.array(z.string().min(1).max(256)).max(10_000) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? 'national';
    if (mode === 'national' && value.paletteId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['paletteId'],
        message: 'paletteId is only valid in continuous mode',
      });
    if (mode === 'continuous' && value.treeId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['treeId'],
        message: 'treeId is only valid in national mode',
      });
    if (mode === 'continuous') {
      for (const field of ['previous', 'laneSpacing', 'nodeSpacing', 'scenario'] as const) {
        if (value[field] !== undefined)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is only valid in national mode`,
          });
      }
    }
    if (value.previous !== undefined && value.treeId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['previous'],
        message: 'previous requires treeId so it applies to exactly one tree',
      });
    if (value.scenario !== undefined && value.treeId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['scenario'],
        message: 'scenario requires treeId so it applies to exactly one tree',
      });
  });

export const focusRenderRequestSchema = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    treeId: z.string().min(1).max(256).optional(),
    paletteId: z.string().min(1).max(256).optional(),
    horizontalSpacing: z.number().int().min(80).max(1000).optional(),
    verticalSpacing: z.number().int().min(60).max(1000).optional(),
    reviewScale: z
      .number()
      .min(FOCUS_RENDER_MIN_OUTPUT_SCALE)
      .max(FOCUS_RENDER_MAX_OUTPUT_SCALE)
      .optional(),
    cropFocusIds: z.array(z.string().min(1).max(256)).max(16).optional(),
    columns: z.number().int().min(1).max(12).optional(),
    padding: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? 'national';
    const invalid =
      mode === 'national'
        ? ([
            ['paletteId', value.paletteId],
            ['columns', value.columns],
          ] as const)
        : ([
            ['treeId', value.treeId],
            ['horizontalSpacing', value.horizontalSpacing],
            ['verticalSpacing', value.verticalSpacing],
            ['reviewScale', value.reviewScale],
            ['cropFocusIds', value.cropFocusIds],
          ] as const);
    for (const [field, fieldValue] of invalid) {
      if (fieldValue !== undefined)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not valid in ${mode} mode`,
        });
    }
    if (mode === 'continuous' && value.padding !== undefined && value.padding < 24)
      context.addIssue({
        code: 'custom',
        path: ['padding'],
        message: 'continuous focus padding must be at least 24 pixels',
      });
  });

export const focusRewriteRequestSchema = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    treeId: z.string().min(1).max(256).optional(),
    layoutMode: z.enum(['authored', 'compact']).default('authored'),
    compactFocusIds: z.array(z.string().min(1).max(256)).min(1).max(10_000).optional(),
    pinnedFocusIds: z.array(z.string().min(1).max(256)).max(10_000).optional(),
    symmetryGroups: z
      .array(
        z
          .object({
            centerFocusId: z.string().min(1).max(256),
            pairs: z
              .array(
                z
                  .object({
                    leftFocusId: z.string().min(1).max(256),
                    rightFocusId: z.string().min(1).max(256),
                  })
                  .strict(),
              )
              .min(1)
              .max(10_000),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    plan: compactFocusPlanSchema.optional(),
    createIfMissing: z.boolean().default(false),
    horizontalSpacing: z.number().int().min(80).max(1000).optional(),
    verticalSpacing: z.number().int().min(60).max(1000).optional(),
    padding: z.number().int().min(0).max(1000).optional(),
    reviewScale: z
      .number()
      .min(FOCUS_RENDER_MIN_OUTPUT_SCALE)
      .max(FOCUS_RENDER_MAX_OUTPUT_SCALE)
      .optional(),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.layoutMode !== 'compact')
      for (const field of ['compactFocusIds', 'pinnedFocusIds', 'symmetryGroups'] as const)
        if (value[field] !== undefined)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} requires compact layout mode`,
          });
    const mode = value.mode ?? 'national';
    const schema = mode === 'continuous' ? continuousFocusPaletteSchema : focusTreePlanSchema;
    if (value.plan !== undefined && !schema.safeParse(value.plan).success)
      context.addIssue({
        code: 'custom',
        path: ['plan'],
        message: `plan must be a ${mode} focus plan`,
      });
    if (mode === 'continuous') {
      if (value.plan === undefined)
        context.addIssue({
          code: 'custom',
          path: ['plan'],
          message: 'plan is required in continuous mode',
        });
      if (value.treeId !== undefined)
        context.addIssue({
          code: 'custom',
          path: ['treeId'],
          message: 'treeId is only valid in national mode',
        });
      if (value.layoutMode !== 'authored')
        context.addIssue({
          code: 'custom',
          path: ['layoutMode'],
          message: 'compact layout mode is only valid in national mode',
        });
      for (const [field, fieldValue] of [
        ['horizontalSpacing', value.horizontalSpacing],
        ['verticalSpacing', value.verticalSpacing],
        ['padding', value.padding],
        ['reviewScale', value.reviewScale],
      ] as const)
        if (fieldValue !== undefined)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is only valid for national focus review renders`,
          });
    } else {
      if (value.plan === undefined && value.layoutMode !== 'compact')
        context.addIssue({
          code: 'custom',
          path: ['plan'],
          message: 'plan is required unless layoutMode is compact',
        });
      if (value.plan === undefined && value.treeId === undefined)
        context.addIssue({
          code: 'custom',
          path: ['treeId'],
          message: 'treeId is required for plan-free compact reflow',
        });
      if (value.plan === undefined && value.createIfMissing)
        context.addIssue({
          code: 'custom',
          path: ['createIfMissing'],
          message: 'plan-free compact reflow requires an existing focus source',
        });
      if (
        value.plan !== undefined &&
        value.treeId !== undefined &&
        'id' in value.plan &&
        value.plan.id !== value.treeId
      )
        context.addIssue({
          code: 'custom',
          path: ['treeId'],
          message: 'treeId must match the supplied national focus plan',
        });
    }
  });

export type FocusInspectToolRequest = z.infer<typeof focusInspectRequestSchema>;
export type FocusRenderToolRequest = z.infer<typeof focusRenderRequestSchema>;
export type FocusRewriteToolRequest = z.infer<typeof focusRewriteRequestSchema>;
