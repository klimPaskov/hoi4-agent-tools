import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

export const ideaWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operation: z.enum(['add', 'replace', 'remove']),
    /** The idea to add, replace or remove. */
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/u),
    /** The category block of the file that holds the idea: country, hidden_ideas, an advisor slot. */
    category: z.string().min(1).max(128).optional(),
    /** add only: create the category block when the file has none. Without it a missing category is refused, so a typo is not silently made into one. */
    createCategory: z.boolean().optional(),
    /** add only: create the file named by file when the mod has no such common/ideas file. */
    createFile: z.boolean().optional(),
    /** The text between the idea braces. Required by add and replace, refused by remove. */
    body: z.string().max(32_000).optional(),
    /** The common/ideas file. Omit it for replace and remove, and for an add into a category that one file defines. */
    file: workspaceRelativePathSchema.max(512).optional(),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

export type IdeaWriteRequest = z.infer<typeof ideaWriteRequestSchema>;

export const ideaWriteDataSchema = z
  .object({
    operation: z.enum(['add', 'replace', 'remove']),
    id: z.string().max(256),
    category: z.string().max(128),
    path: z.string().max(1024),
    applied: z.boolean(),
    /** The unified diff of the file, cut at a line when it is long. */
    diff: z.string().max(12_000),
    diffTruncated: z.boolean(),
    /** The other definitions of the file, checked to be byte for byte as they were. */
    untouchedDefinitions: z.number().int().min(0),
    /** What the idea refers to and the mod does not define. The write still happens. */
    missing: z
      .object({
        localisation: z.array(z.string().max(256)).max(20),
        picture: z.array(z.string().max(256)).max(5),
      })
      .strict(),
  })
  .strict();

export type IdeaWriteData = z.infer<typeof ideaWriteDataSchema>;
