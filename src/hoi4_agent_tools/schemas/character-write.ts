import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

export const characterWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operation: z.enum(['add', 'replace', 'remove']),
    /** The character to add, replace or remove. */
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/u),
    /** add only: create the file named by file when the mod has no such common/characters file. */
    createFile: z.boolean().optional(),
    /** The text between the character braces. Required by add and replace, refused by remove. */
    body: z.string().max(32_000).optional(),
    /** The common/characters file. Omit it for replace and remove, and for an add when the mod has one characters file. */
    file: workspaceRelativePathSchema.max(512).optional(),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

export type CharacterWriteRequest = z.infer<typeof characterWriteRequestSchema>;

export const characterWriteDataSchema = z
  .object({
    operation: z.enum(['add', 'replace', 'remove']),
    id: z.string().max(256),
    path: z.string().max(1024),
    applied: z.boolean(),
    /** The unified diff of the file, cut at a line when it is long. */
    diff: z.string().max(12_000),
    diffTruncated: z.boolean(),
    /** The other characters of the file, checked to be byte for byte as they were. */
    untouchedDefinitions: z.number().int().min(0),
    /** What the character refers to and the mod does not define. The write still happens. */
    missing: z
      .object({
        localisation: z.array(z.string().max(256)).max(20),
        portrait: z.array(z.string().max(256)).max(10),
      })
      .strict(),
  })
  .strict();

export type CharacterWriteData = z.infer<typeof characterWriteDataSchema>;
