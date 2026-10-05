import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';
import { referenceSectionSchema } from './reference.js';

const scope = z.enum([
  'country',
  'state',
  'character',
  'combatant',
  'ace',
  'strategic_region',
  'operation',
  'industrial_org',
  'purchase_contract',
  'raid_instance',
  'special_project',
  'faction',
]);
export const scriptValidateRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** Snippet mode: an effect or trigger body checked under `kind` and `scope`. */
    source: z.string().min(1).max(64_000).optional(),
    /** File mode: a scanned mod file whose blocks are checked under the scope its structure fixes. */
    path: z.string().trim().min(1).max(4096).optional(),
    kind: z.enum(['effect', 'trigger']).optional(),
    scope: scope.optional(),
    documentation: z.enum(['game_doc', 'script_doc']).default('game_doc'),
    bindings: z
      .array(z.object({ name: z.string().min(1).max(256), scope }).strict())
      .max(16)
      .default([]),
    limit: z.number().int().min(1).max(32).default(12),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.source === undefined) === (value.path === undefined))
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Provide either source with kind and scope, or a mod file path',
      });
    if (value.source !== undefined && (value.kind === undefined || value.scope === undefined))
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'A snippet check requires kind and scope',
      });
    if (
      value.path !== undefined &&
      (value.kind !== undefined || value.scope !== undefined || value.bindings.length > 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'A file check infers kinds and scopes from the file structure',
      });
  });

export const scriptValidateDataSchema = z
  .object({
    valid: z.boolean().nullable(),
    checksPerformed: z.array(z.enum(['syntax', 'command_kind', 'declared_scope'])),
    parametersChecked: z.literal(false),
    documentation: z
      .object({
        source: z.enum(['game_doc', 'script_doc']),
        revision: z.string().regex(/^[a-f0-9]{64}$/u),
        effectCount: z.number().int().min(0),
        triggerCount: z.number().int().min(0),
        skippedSources: z.number().int().min(0),
      })
      .strict(),
    findings: z
      .array(
        z
          .object({
            code: z.string().max(80),
            status: z.enum(['supported', 'error', 'unresolved']),
            command: z.string().max(256),
            kind: z.enum(['effect', 'trigger']),
            scope: z.string().max(64),
            line: z.number().int().min(1),
            column: z.number().int().min(1),
            message: z.string().max(500),
            suggestions: z.array(z.string().max(256)).max(3),
            reference: referenceSectionSchema.optional(),
          })
          .strict(),
      )
      .max(32),
    totalFindings: z.number().int().min(0),
    omittedFindings: z.number().int().min(0),
    checkedCommands: z.number().int().min(0),
    unresolvedCount: z.number().int().min(0),
    truncated: z.boolean(),
    argumentBlocksUnchecked: z.number().int().min(0),
    file: z
      .object({
        path: z.string().max(4096),
        family: z.string().max(64),
        roots: z.number().int().min(0),
        unknownScopeRoots: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();
