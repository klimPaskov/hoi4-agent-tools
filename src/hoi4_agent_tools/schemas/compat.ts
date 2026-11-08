import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';

/** `hoi4.compat_check`: how the mod fits another mod, and what a game patch changed under its overrides. */
export const COMPAT_DEFAULT_LIMIT = 10;
export const COMPAT_MAX_LIMIT = 50;

const buildSchema = z.string().min(1).max(64);

export const compatCheckRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** mod: the mod against another mod, in both load orders. patch: the mod's overrides across game builds. */
    mode: z.enum(['mod', 'patch']),
    /** mod only: the other mod's folder name or workspace id. */
    other: z.string().min(1).max(128).optional(),
    /** patch only: the older stored game build; default is the newest stored build other than `to`. */
    from: buildSchema.optional(),
    /** patch only: the newer game build; default is the installed build. */
    to: buildSchema.optional(),
    /** Items listed per list; the counts are always complete. */
    limit: z.number().int().min(1).max(COMPAT_MAX_LIMIT).default(COMPAT_DEFAULT_LIMIT),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === 'mod' && input.other === undefined)
      context.addIssue({ code: 'custom', path: ['other'], message: 'mode mod needs other' });
    if (input.mode === 'patch' && input.other !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['other'],
        message: 'other belongs to mode mod',
      });
    if (input.mode === 'mod' && (input.from !== undefined || input.to !== undefined))
      context.addIssue({
        code: 'custom',
        path: [input.from === undefined ? 'to' : 'from'],
        message: 'from and to belong to mode patch',
      });
  });

const modRefSchema = z.object({ id: z.string().max(64), name: z.string().max(256) }).strict();

const findingSchema = z
  .object({
    code: z.string().max(64),
    severity: z.enum(['error', 'warning', 'info']),
    subject: z.string().max(256).nullable(),
    layer: z.string().max(256),
    path: z.string().max(512),
    message: z.string().max(400),
  })
  .strict();

const listSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      count: z.number().int().min(0),
      omitted: z.number().int().min(0),
      items: z.array(item).max(COMPAT_MAX_LIMIT),
    })
    .strict();

const loadOrderSchema = z
  .object({
    /** Loads first; its files lose a clash. */
    first: modRefSchema,
    /** Loads last; its files win a clash. */
    second: modRefSchema,
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
    sameFile: listSchema(
      z.object({ path: z.string().max(512), winner: z.string().max(256) }).strict(),
    ),
    duplicateDefinitions: listSchema(findingSchema),
    dropped: listSchema(findingSchema),
    replacePathDrops: listSchema(
      z
        .object({
          folder: z.string().max(512),
          fileCount: z.number().int().min(1),
          files: z.array(z.string().max(512)).max(5),
        })
        .strict(),
    ),
  })
  .strict();

export const compatModDataSchema = z
  .object({
    mode: z.literal('mod'),
    workspace: modRefSchema,
    other: modRefSchema,
    verdict: z.enum(['no_conflicts', 'conflicts']),
    /** The load order that loses less, from its error and warning counts against the other order; null when they match. */
    lessLoss: z
      .object({
        loadsLast: modRefSchema,
        errors: z.number().int().min(0),
        warnings: z.number().int().min(0),
        otherOrderErrors: z.number().int().min(0),
        otherOrderWarnings: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    summary: z.string().max(600),
    loadOrders: z.array(loadOrderSchema).length(2),
    notes: z.array(z.string().max(400)).max(8),
    durationMs: z.number().int().min(0),
  })
  .strict();

const hunkFileSchema = z
  .object({
    path: z.string().max(512),
    layer: z.string().max(256),
    change: z.enum(['changed', 'added', 'removed']),
    binary: z.boolean(),
    oldLines: z.number().int().min(0).nullable(),
    newLines: z.number().int().min(0).nullable(),
    linesAdded: z.number().int().min(0).nullable(),
    linesRemoved: z.number().int().min(0).nullable(),
    firstHunk: z.string().max(2400).nullable(),
  })
  .strict();

const snapshotInfoSchema = z
  .object({
    build: z.string().max(64),
    files: z.number().int().min(0),
    copiedFiles: z.number().int().min(0),
    uncopiedFiles: z.number().int().min(0),
    bytes: z.number().int().min(0),
  })
  .strict();

export const compatPatchDataSchema = z
  .object({
    mode: z.literal('patch'),
    workspace: modRefSchema,
    /** The installed build; null when only stored snapshots were compared. */
    installedBuild: z.string().max(64).nullable(),
    /** The snapshot this call stored; null when only stored snapshots were compared. */
    recorded: snapshotInfoSchema.nullable(),
    pruned: z.array(z.string().max(64)).max(16),
    stored: z.array(snapshotInfoSchema).max(8),
    comparison: z
      .object({
        from: z.string().max(64),
        to: z.string().max(64),
        changed: z.number().int().min(0),
        added: z.number().int().min(0),
        removed: z.number().int().min(0),
        unchanged: z.number().int().min(0),
        /** Overridden in the older snapshot, gone from the newer one, and no longer shipped by the mod. */
        noLongerOverridden: z.number().int().min(0),
        omitted: z.number().int().min(0),
        files: z.array(hunkFileSchema).max(COMPAT_MAX_LIMIT),
      })
      .strict()
      .nullable(),
    summary: z.string().max(600),
    durationMs: z.number().int().min(0),
  })
  .strict();

export const compatCheckDataSchema = z.discriminatedUnion('mode', [
  compatModDataSchema,
  compatPatchDataSchema,
]);

export type CompatCheckRequest = z.infer<typeof compatCheckRequestSchema>;
export type CompatModData = z.infer<typeof compatModDataSchema>;
export type CompatPatchData = z.infer<typeof compatPatchDataSchema>;
export type CompatCheckData = z.infer<typeof compatCheckDataSchema>;
