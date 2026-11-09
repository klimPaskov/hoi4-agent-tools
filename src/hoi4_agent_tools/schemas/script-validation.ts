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
    /** Snippet mode: an effect or trigger body checked under `scope`; a missing `kind` is inferred. */
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
    /**
     * Whole-mod closure: count the references of the mod's own sources that resolve, do not
     * resolve, or cannot be decided, per target kind, and give a verdict (`incomplete` whenever
     * anything is unknown). Replaces `source` and `path`.
     */
    closure: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const modes = [
      value.source !== undefined,
      value.path !== undefined,
      value.closure === true,
    ].filter(Boolean).length;
    if (modes !== 1)
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message:
          'Provide either source with kind and scope, a mod file path, or closure: true for the whole mod',
      });
    if (
      value.closure === true &&
      (value.kind !== undefined || value.scope !== undefined || value.bindings.length > 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['closure'],
        message: 'A closure check covers the whole mod and takes no kind, scope or bindings',
      });
    if (value.source !== undefined && value.scope === undefined)
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'A snippet check requires a scope, such as country or state',
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
    checksPerformed: z.array(
      z.enum([
        'syntax',
        'command_kind',
        'declared_scope',
        'player_text',
        'event_popups',
        'known_mistakes',
        'identifier_arguments',
        'closure',
      ]),
    ),
    /**
     * Identifier arguments (ideas, events, decisions, focuses, technologies) were checked against
     * the workspace's definitions. Other argument values are not checked.
     */
    parametersChecked: z.boolean(),
    /** Absent for a closure check, which reads no documentation. */
    documentation: z
      .object({
        source: z.enum(['game_doc', 'script_doc']),
        revision: z.string().regex(/^[a-f0-9]{64}$/u),
        effectCount: z.number().int().min(0),
        triggerCount: z.number().int().min(0),
        skippedSources: z.number().int().min(0),
      })
      .strict()
      .optional(),
    findings: z
      .array(
        z
          .object({
            code: z.string().max(80),
            status: z.enum(['supported', 'error', 'unresolved', 'warning']),
            command: z.string().max(256),
            kind: z.enum(['effect', 'trigger', 'text', 'definition']),
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
    /** What made the result partial when `valid` is null, one plain sentence each. */
    partialReasons: z.array(z.string().max(600)).max(5).optional(),
    /** The whole-mod closure (`closure: true`). */
    closure: z
      .object({
        verdict: z.enum(['closed', 'unresolved', 'incomplete']),
        /** The scan revision, as `hoi4.source_lookup` reports it. */
        revision: z.string().regex(/^[a-f0-9]{64}$/u),
        /** False when a source was skipped, so a definition may be missing. */
        complete: z.boolean(),
        /** False when the semantic scan skipped a source or reached a ceiling. */
        semanticComplete: z.boolean(),
        skippedSourceCount: z.number().int().min(0),
        /** Mod-owned sources whose references were counted. */
        sources: z.number().int().min(0),
        totals: z
          .object({
            resolved: z.number().int().min(0),
            unresolved: z.number().int().min(0),
            unknown: z.number().int().min(0),
          })
          .strict(),
        kinds: z
          .array(
            z
              .object({
                kind: z.string().max(64),
                resolved: z.number().int().min(0),
                unresolved: z.number().int().min(0),
                unknown: z.number().int().min(0),
              })
              .strict(),
          )
          .max(64),
      })
      .strict()
      .optional(),
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
