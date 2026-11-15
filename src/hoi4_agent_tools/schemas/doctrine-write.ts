import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

const doctrineKindSchema = z.enum(['grand_doctrine', 'track', 'subdoctrine']);

export const doctrineWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operation: z.enum(['add', 'replace', 'remove']),
    /** The doctrine to add, replace or remove. */
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/u),
    /** add only: what the doctrine is, which decides the folder it goes in. Not needed when file names an existing file or a path under one of the three folders. */
    kind: doctrineKindSchema.optional(),
    /** add only: create the file named by file when the mod has no such doctrine file. */
    createFile: z.boolean().optional(),
    /** The text between the doctrine braces. Required by add and replace, refused by remove. */
    body: z.string().max(32_000).optional(),
    /** The doctrine file under common/doctrines/grand_doctrines, tracks or subdoctrines. Omit it for replace and remove, and for an add when the mod has one file of that kind. */
    file: workspaceRelativePathSchema.max(512).optional(),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

export type DoctrineWriteRequest = z.infer<typeof doctrineWriteRequestSchema>;

export const doctrineWriteDataSchema = z
  .object({
    operation: z.enum(['add', 'replace', 'remove']),
    id: z.string().max(256),
    kind: doctrineKindSchema,
    path: z.string().max(1024),
    applied: z.boolean(),
    /** The unified diff of the file, cut at a line when it is long. */
    diff: z.string().max(12_000),
    diffTruncated: z.boolean(),
    /** The other doctrines of the file, checked to be byte for byte as they were. */
    untouchedDefinitions: z.number().int().min(0),
    /** What the doctrine refers to and the mod does not define. The write still happens. */
    missing: z
      .object({
        localisation: z.array(z.string().max(256)).max(5),
        icon: z.array(z.string().max(256)).max(1),
        folder: z.array(z.string().max(256)).max(1),
        track: z.array(z.string().max(256)).max(20),
      })
      .strict(),
  })
  .strict();

export type DoctrineWriteData = z.infer<typeof doctrineWriteDataSchema>;
