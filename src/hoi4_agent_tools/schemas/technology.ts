import { z } from 'zod/v4';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { workspaceRelativePathSchema } from './common.js';

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
