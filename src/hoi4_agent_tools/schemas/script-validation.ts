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
    source: z.string().min(1).max(64_000),
    kind: z.enum(['effect', 'trigger']),
    scope,
    documentation: z.enum(['game_doc', 'script_doc']).default('game_doc'),
    bindings: z
      .array(z.object({ name: z.string().min(1).max(256), scope }).strict())
      .max(16)
      .default([]),
    limit: z.number().int().min(1).max(32).default(12),
  })
  .strict();

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
  })
  .strict();
