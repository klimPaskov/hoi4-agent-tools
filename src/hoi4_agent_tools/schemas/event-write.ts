import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

const eventKindSchema = z.enum([
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
]);

export const eventWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operation: z.enum(['add', 'replace', 'remove']),
    /** The event id, a namespace, a dot and a number. */
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}\.[0-9]{1,9}$/u),
    /** add only: the kind of event block. Defaults to country_event; replace and remove keep the event's own kind. */
    kind: eventKindSchema.optional(),
    /** add only: write add_namespace for the id's namespace when no mod file declares it. Without it that is refused, so a typo is not silently made into a namespace. */
    createNamespace: z.boolean().optional(),
    /** Also report what the edit does to the event chains: events added, removed or cut off, calls removed, new issues. Needs a scan of the mod and the game, so it is slow on a first call. */
    chain: z.boolean().optional(),
    /** add only: create the file named by file when the mod has no such events file. */
    createFile: z.boolean().optional(),
    /** The text between the event braces, without the id line. Required by add and replace, refused by remove. */
    body: z.string().max(32_000).optional(),
    /** The events file. Omit it for replace and remove, and for an add when one file holds the namespace. */
    file: workspaceRelativePathSchema.max(512).optional(),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

const eventIdList = z.array(z.string().max(256)).max(20);

/** What an edit does to the event chains, from a comparison of the mod's graph before and after it. */
export const eventChainReportSchema = z
  .object({
    /** False when the comparison could not run; reason says why. The write is not affected. */
    computed: z.boolean(),
    reason: z.string().max(300).optional(),
    /** False when either graph was cut short, so the counts may be low. */
    complete: z.boolean().optional(),
    addedEvents: eventIdList.optional(),
    removedEvents: eventIdList.optional(),
    changedEvents: eventIdList.optional(),
    changedOptions: z.number().int().min(0).optional(),
    addedCalls: z.number().int().min(0).optional(),
    removedCalls: z.number().int().min(0).optional(),
    /** Events that have fewer callers after the edit. */
    eventsLosingCallers: eventIdList.optional(),
    newIssues: z
      .array(z.object({ code: z.string().max(128), message: z.string().max(300) }).strict())
      .max(10)
      .optional(),
    resolvedIssues: z.number().int().min(0).optional(),
    /** Events that no root reached through a call before and none reaches now. */
    newlyUnreachable: eventIdList.optional(),
    /** True when a list above was cut at its limit. */
    truncated: z.boolean().optional(),
  })
  .strict();

export type EventChainReport = z.infer<typeof eventChainReportSchema>;

export type EventWriteRequest = z.infer<typeof eventWriteRequestSchema>;

export const eventWriteDataSchema = z
  .object({
    operation: z.enum(['add', 'replace', 'remove']),
    id: z.string().max(256),
    kind: eventKindSchema,
    path: z.string().max(1024),
    applied: z.boolean(),
    /** The unified diff of the file, cut at a line when it is long. */
    diff: z.string().max(12_000),
    diffTruncated: z.boolean(),
    /** The other events of the file, checked to be byte for byte as they were. */
    untouchedDefinitions: z.number().int().min(0),
    /** True when the edit also wrote an add_namespace line. */
    namespaceAdded: z.boolean(),
    /** The effect on the event chains. Present only when chain was asked for. */
    chain: eventChainReportSchema.optional(),
    /** What the event refers to and the mod does not define. The write still happens. */
    missing: z
      .object({
        localisation: z.array(z.string().max(256)).max(20),
        picture: z.array(z.string().max(256)).max(5),
      })
      .strict(),
  })
  .strict();

export type EventWriteData = z.infer<typeof eventWriteDataSchema>;
