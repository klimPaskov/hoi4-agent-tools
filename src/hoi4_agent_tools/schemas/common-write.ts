import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

/** The kinds `hoi4.common_write` writes; each is one descriptor in the engine (`hoi4-script-write`, ADR 0089). */
export const COMMON_WRITE_KINDS = ['bop', 'ai_strategy', 'ai_strategy_plan', 'on_action'] as const;

export const commonWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    kind: z.enum(COMMON_WRITE_KINDS),
    operation: z.enum(['add', 'replace', 'remove']),
    /** The definition: a top-level key of the file, or the on_action name for kind on_action. */
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/u),
    /** The text between the braces of the definition (for on_action, of the on_action key). Required by add and replace, refused by remove. Raw script: it must parse, and it is written byte for byte. */
    body: z.string().max(64_000).optional(),
    /** on_action only: the child block of the on_action key that replace or remove acts on, counted from 0. */
    blockIndex: z.number().int().min(0).max(10_000).optional(),
    /** add only: create the file named by file when the mod has no such file. */
    createFile: z.boolean().optional(),
    /** The file under the kind's folder. Omit it to use the mod file that defines the id; add into a folder with one file also needs no name. */
    file: workspaceRelativePathSchema.max(512).optional(),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

export type CommonWriteRequest = z.infer<typeof commonWriteRequestSchema>;

export const commonWriteDataSchema = z
  .object({
    operation: z.enum(['add', 'replace', 'remove']),
    kind: z.enum(COMMON_WRITE_KINDS),
    id: z.string().max(256),
    path: z.string().max(1024),
    applied: z.boolean(),
    /** The unified diff of the file, cut at a line when it is long. */
    diff: z.string().max(12_000),
    diffTruncated: z.boolean(),
    /** The other definitions of the file, checked to be byte for byte as they were. */
    untouchedDefinitions: z.number().int().min(0),
    /** What the kind's check found that does not stop the write. */
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['warning']),
            code: z.string().max(128),
            message: z.string().max(1024),
          })
          .strict(),
      )
      .max(50),
    /** What the definition refers to and the mod does not define. The write still happens. */
    missing: z
      .object({
        localisation: z.array(z.string().max(256)).max(50),
        sprites: z.array(z.string().max(256)).max(20),
        categories: z.array(z.string().max(256)).max(5),
        focuses: z.array(z.string().max(256)).max(100),
      })
      .strict(),
  })
  .strict();

export type CommonWriteData = z.infer<typeof commonWriteDataSchema>;
