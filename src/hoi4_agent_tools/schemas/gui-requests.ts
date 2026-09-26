import { z } from 'zod/v4';
import {
  renderDimensionViolation,
  RenderBudget,
  RENDER_MAX_DIMENSION,
} from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { GUI_TEXT_PACKAGE_MAX_FILES, GuiHelperDocumentSchema } from '../gui/index.js';
import { GuiGeneratedScenarioOptionsSchema, GuiPreviewScenarioSchema } from '../gui/scenario.js';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

function compact<T extends z.ZodType>(schema: T, description: string): z.ZodPipe<z.ZodUnknown, T> {
  return z.unknown().describe(description).pipe(schema);
}

const compactGuiScenarioSchema = compact(
  GuiPreviewScenarioSchema,
  'GUI preview scenario; optional date and controls {stateId: controllerTag}.',
);
const compactGeneratedScenarioOptionsSchema = compact(
  GuiGeneratedScenarioOptionsSchema,
  'GUI generated-scenario options.',
);
const compactGuiHelperSchema = compact(GuiHelperDocumentSchema, 'GUI helper document.');

export const guiPreviewStateSchema = z.enum([
  'normal',
  'hover',
  'selected',
  'locked',
  'disabled',
  'warning',
  'active',
  'completed',
  'empty-list',
  'full-list',
  'minimum-value',
  'maximum-value',
  'long-text',
  'missing-localisation',
]);

export const guiInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    windowName: z.string().min(1).max(256).optional(),
    scenario: compactGuiScenarioSchema.optional(),
    relatedScenarios: z.array(compactGuiScenarioSchema).max(32).optional(),
    generatedScenarios: compactGeneratedScenarioOptionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.windowName === undefined) !== (value.scenario === undefined))
      context.addIssue({
        code: 'custom',
        message: 'windowName and scenario must be provided together',
      });
    if (value.relatedScenarios !== undefined && value.scenario === undefined)
      context.addIssue({
        code: 'custom',
        path: ['relatedScenarios'],
        message: 'relatedScenarios requires a window scenario',
      });
    if (value.generatedScenarios !== undefined && value.scenario === undefined)
      context.addIssue({
        code: 'custom',
        path: ['generatedScenarios'],
        message: 'generatedScenarios requires a window scenario',
      });
  });

export const guiResolutionSchema = z
  .object({
    width: z.number().int().min(320).max(RENDER_MAX_DIMENSION),
    height: z.number().int().min(200).max(RENDER_MAX_DIMENSION),
    uiScale: z
      .number()
      .min(0.25)
      .max(4)
      .optional()
      .describe(
        'In-game UI scale for this resolution. Use 1 at 1920x1080; do not use it to enlarge an artifact.',
      ),
  })
  .strict()
  .superRefine(({ width, height }, context) => {
    const violation = renderDimensionViolation(width, height, 'GUI matrix resolution');
    if (violation !== undefined)
      context.addIssue({ code: 'custom', message: `${violation.code}: ${violation.message}` });
  });

export const guiRenderRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    windowName: z.string().min(1).max(256),
    scenario: compactGuiScenarioSchema,
    states: z.array(guiPreviewStateSchema).max(14).optional(),
    resolutions: z.array(guiResolutionSchema).min(1).max(16).optional(),
    relatedScenarios: z.array(compactGuiScenarioSchema).max(32).optional(),
    generatedScenarios: compactGeneratedScenarioOptionsSchema.optional(),
    comparisonScenario: compactGuiScenarioSchema.optional(),
    sourceBaseline: z
      .object({
        relativePath: workspaceRelativePathSchema,
        source: z.string().max(SOURCE_MAX_BYTES),
      })
      .strict()
      .optional()
      .describe(
        'Previous mod-owned .gui source for a matched source comparison using the requested scenario.',
      ),
  })
  .strict()
  .superRefine(
    ({ scenario, states, resolutions, relatedScenarios, generatedScenarios }, context) => {
      const budget = new RenderBudget();
      try {
        const stateCount = states?.length ?? 14;
        for (let index = 0; index < 9 + stateCount; index += 1)
          budget.reserve(
            scenario.resolution.width,
            scenario.resolution.height,
            'GUI request variant',
          );
        for (const resolution of resolutions ?? [
          { width: 1280, height: 720 },
          { width: 1920, height: 1080 },
          { width: 2560, height: 1440 },
          { width: 1920, height: 1080 },
        ])
          budget.reserve(resolution.width, resolution.height, 'GUI resolution variant');
        const generatedCount =
          generatedScenarios?.enabled === false ? 0 : (generatedScenarios?.count ?? 1);
        const scenarioCount =
          generatedCount === 0
            ? 1 + (relatedScenarios?.length ?? 0)
            : generatedCount +
              (generatedScenarios?.preservePlaceholder === false ? 0 : 1) +
              (relatedScenarios?.length ?? 0);
        const stateColumns = Math.min(3, Math.max(1, stateCount));
        const stateRows = Math.max(1, Math.ceil(stateCount / stateColumns));
        budget.reserve(stateColumns * 420, 46 + stateRows * 280, 'GUI state gallery');
        const resolutionCount = resolutions?.length ?? 4;
        const resolutionColumns = Math.min(3, Math.max(1, resolutionCount));
        const resolutionRows = Math.max(1, Math.ceil(resolutionCount / resolutionColumns));
        budget.reserve(
          resolutionColumns * 420,
          46 + resolutionRows * 280,
          'GUI resolution gallery',
        );
        const scenarioBudget = new RenderBudget();
        const scenarioColumns = Math.min(3, Math.max(1, scenarioCount));
        const scenarioRows = Math.max(1, Math.ceil(scenarioCount / scenarioColumns));
        scenarioBudget.reserve(
          scenarioColumns * 420,
          46 + scenarioRows * 280,
          'GUI scripted scenario gallery',
        );
      } catch (error) {
        if (error instanceof ServiceError) {
          context.addIssue({ code: 'custom', message: `${error.code}: ${error.message}` });
          return;
        }
        throw error;
      }
    },
  );

export const guiRewriteRequestSchema = z
  .object({
    mode: z.enum(['source', 'helpers', 'patches']),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    windowName: z.string().min(1).max(256),
    scenario: compactGuiScenarioSchema,
    requestKey: backgroundRequestKeySchema.optional(),
    source: z.string().max(SOURCE_MAX_BYTES).optional(),
    helper: compactGuiHelperSchema.optional(),
    additionalFiles: z
      .array(
        z
          .object({
            relativePath: workspaceRelativePathSchema,
            source: z.string().max(SOURCE_MAX_BYTES),
          })
          .strict(),
      )
      .max(GUI_TEXT_PACKAGE_MAX_FILES - 1)
      .optional(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    patches: z
      .array(
        z
          .object({
            start: z.number().int().min(0),
            end: z.number().int().min(0),
            expectedText: z.string().max(5_000_000),
            text: z.string().max(5_000_000),
            description: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(1000)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'source' && value.source === undefined)
      context.addIssue({ code: 'custom', message: 'source is required in source mode' });
    if (value.mode === 'helpers' && value.helper === undefined)
      context.addIssue({ code: 'custom', message: 'helper is required in helpers mode' });
    if (
      value.mode === 'patches' &&
      (value.patches === undefined || value.expectedSourceHash === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'patches and expectedSourceHash are required in patches mode',
      });
    if (value.mode === 'source' && value.helper !== undefined)
      context.addIssue({ code: 'custom', message: 'helper is forbidden in source mode' });
    if (value.mode === 'helpers' && value.source !== undefined)
      context.addIssue({ code: 'custom', message: 'source is forbidden in helpers mode' });
    if (
      value.mode !== 'patches' &&
      (value.patches !== undefined || value.expectedSourceHash !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'patch fields are accepted only in patches mode',
      });
    if (
      value.mode === 'patches' &&
      (value.source !== undefined ||
        value.helper !== undefined ||
        value.additionalFiles !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'source, helper, and additionalFiles are forbidden in patches mode',
      });
  });

export type GuiInspectToolRequest = z.infer<typeof guiInspectRequestSchema>;
export type GuiRenderToolRequest = z.infer<typeof guiRenderRequestSchema>;
export type GuiRewriteToolRequest = z.infer<typeof guiRewriteRequestSchema>;
