import { z } from 'zod/v4';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { workspaceIdSchema, workspaceRelativePathSchema } from './common.js';
import { helperExpansionRequestSchema, validateHelperExpansionMode } from './helper-expansion.js';

export const technologyIdSchema = z.string().min(1).max(512);
export const technologyDirectionSchema = z.enum(['prerequisites', 'descendants', 'both']);
export const technologyUnlockKindSchema = z.enum([
  'equipment',
  'equipment_module',
  'sub_unit',
  'building',
  'ability',
  'tactic',
  'other',
]);
export const technologyDefectClassSchema = z.enum([
  'confirmed_error',
  'probable_defect',
  'design_warning',
  'unresolved_analysis',
]);
export const technologyRenderViewSchema = z.enum([
  'summary',
  'folder',
  'dependencies',
  'technology',
  'doctrine',
  'exclusive',
  'memberships',
  'bonuses',
  'grants',
  'unlocks',
  'metadata',
  'assets',
  'unresolved',
  'comparison',
]);
export const technologyImpactSchema = z
  .object({
    kind: z.enum(['technology', 'category', 'folder', 'unlock_target']),
    id: technologyIdSchema,
    operation: z.enum(['remove', 'rename']),
    replacementId: technologyIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === 'rename' && value.replacementId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['replacementId'],
        message: 'Rename requires replacementId',
      });
  });
export const technologyGraphReferenceSchema = z
  .object({
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    artifactUri: z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^hoi4-agent:\/\//u)
      .optional(),
  })
  .strict()
  .refine(
    ({ revision, artifactUri }) =>
      Number(revision !== undefined) + Number(artifactUri !== undefined) === 1,
    'Provide exactly one revision or artifact URI',
  );
export const technologyProposedSourceSchema = z
  .object({
    relativePath: workspaceRelativePathSchema,
    source: z.string().max(SOURCE_MAX_BYTES).nullable(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

export const technologyAnalysisModeSchema = z.enum([
  'scan',
  'folders',
  'trace',
  'explain',
  'unlocks',
  'bonus_coverage',
  'lint',
  'impact',
  'helper_expansion',
]);

export function validateTechnologyInspectRequest(
  value: { mode: string; technologyId?: unknown; impact?: unknown },
  context: z.RefinementCtx,
): void {
  validateHelperExpansionMode(value, context);
  if ((value.mode === 'trace' || value.mode === 'explain') && value.technologyId === undefined)
    context.addIssue({
      code: 'custom',
      path: ['technologyId'],
      message: `${value.mode} requires technologyId`,
    });
  if (value.mode === 'impact' && value.impact === undefined)
    context.addIssue({
      code: 'custom',
      path: ['impact'],
      message: 'Impact mode requires impact',
    });
}

export const technologyRenderRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    view: technologyRenderViewSchema.exclude(['comparison']),
    folderId: technologyIdSchema.optional(),
    technologyId: technologyIdSchema.optional(),
    categoryId: technologyIdSchema.optional(),
    targetId: technologyIdSchema.optional(),
    maxNodes: z.number().int().min(1).max(2_000).optional(),
    scenario: z
      .object({
        year: z.number().int().min(1).max(9999),
        researchedTechnologyIds: z.array(technologyIdSchema).max(25_000),
      })
      .strict()
      .optional(),
    includeHtml: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine(validateTechnologyRenderRequest);

/** Shared by the request schema and the published tool input, so clients see the same rule. */
export function validateTechnologyRenderRequest(
  value: { view: string; folderId?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (value.view === 'folder' && value.folderId === undefined)
    context.addIssue({
      code: 'custom',
      path: ['folderId'],
      message: 'Folder view requires folderId',
    });
}

export function validateTechnologyCompareRequest(
  value: { after?: unknown; proposedSources?: unknown },
  context: z.RefinementCtx,
): void {
  if (value.after !== undefined && value.proposedSources !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['after'],
      message: 'after conflicts with proposedSources',
    });
}

export const technologyCompareRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    before: technologyGraphReferenceSchema.optional(),
    after: technologyGraphReferenceSchema.optional(),
    proposedSources: z.array(technologyProposedSourceSchema).min(1).max(128).optional(),
    render: z.boolean().optional(),
    maxRenderNodes: z.number().int().min(1).max(2_000).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine(validateTechnologyCompareRequest);

export const technologyInspectToolModeSchema = z.enum([
  ...technologyAnalysisModeSchema.options,
  'compare',
]);

const technologyCompareOnlyFields = [
  'before',
  'after',
  'proposedSources',
  'render',
  'maxRenderNodes',
] as const;
const technologyInspectOnlyFields = [
  'folderId',
  'technologyId',
  'categoryId',
  'targetKind',
  'targetId',
  'direction',
  'maxDepth',
  'maxNodes',
  'includeSubTechnologies',
  'classifications',
  'codes',
  'impact',
  'helperExpansion',
] as const;

/** Inspection and graph comparison share one tool; mode compare selects the comparison. */
export const technologyInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: technologyInspectToolModeSchema,
    folderId: technologyIdSchema.optional(),
    technologyId: technologyIdSchema.optional(),
    categoryId: technologyIdSchema.optional(),
    targetKind: technologyUnlockKindSchema.optional(),
    targetId: technologyIdSchema.optional(),
    direction: technologyDirectionSchema.optional(),
    maxDepth: z.number().int().min(1).max(256).optional(),
    maxNodes: z.number().int().min(1).max(25_000).optional(),
    includeSubTechnologies: z.boolean().optional(),
    classifications: z.array(technologyDefectClassSchema).max(4).optional(),
    codes: z.array(z.string().min(1).max(256)).max(100).optional(),
    impact: technologyImpactSchema.optional(),
    helperExpansion: helperExpansionRequestSchema.optional(),
    before: technologyGraphReferenceSchema.optional(),
    after: technologyGraphReferenceSchema.optional(),
    proposedSources: z.array(technologyProposedSourceSchema).min(1).max(128).optional(),
    render: z.boolean().optional(),
    maxRenderNodes: z.number().int().min(1).max(2_000).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine(validateTechnologyInspectToolRequest);

export function validateTechnologyInspectToolRequest(
  value: Record<string, unknown> & { mode: string },
  context: z.RefinementCtx,
): void {
  const compare = value.mode === 'compare';
  for (const field of compare ? technologyInspectOnlyFields : technologyCompareOnlyFields)
    if (value[field] !== undefined)
      context.addIssue({
        code: 'custom',
        path: [field],
        message: compare
          ? `${field} is not used by mode compare`
          : `${field} is used only by mode compare`,
      });
  if (compare)
    validateTechnologyCompareRequest(
      value as Parameters<typeof validateTechnologyCompareRequest>[0],
      context,
    );
  else validateTechnologyInspectRequest(value, context);
}

/** Split an inspect request into a comparison or an analysis of the current graph. */
export function splitTechnologyInspectRequest(
  input: z.infer<typeof technologyInspectRequestSchema>,
):
  | { compare: true; request: z.infer<typeof technologyCompareRequestSchema> }
  | { compare: false; request: Record<string, unknown> } {
  if (input.mode !== 'compare') return { compare: false, request: input };
  const request: Record<string, unknown> = { workspaceId: input.workspaceId };
  for (const field of [...technologyCompareOnlyFields, 'refresh'] as const)
    if (input[field] !== undefined) request[field] = input[field];
  return { compare: true, request: technologyCompareRequestSchema.parse(request) };
}
