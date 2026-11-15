import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

export const techWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operation: z.enum(['add', 'replace', 'remove']),
    /** The technology to add, replace or remove. */
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/u),
    /** Also report what the edit does to the technology trees: moves, overlaps, new or removed paths, techs left unreachable. Needs a scan of the mod and the game, so it is slow on a first call. */
    placement: z.boolean().optional(),
    /** add only: create the file named by file when the mod has no such common/technologies file. */
    createFile: z.boolean().optional(),
    /** The text between the technology braces. Required by add and replace, refused by remove. */
    body: z.string().max(32_000).optional(),
    /** The common/technologies file. Omit it for replace and remove, and for an add when the mod has one technologynologies file. */
    file: workspaceRelativePathSchema.max(512).optional(),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

const technologyIdList = z.array(z.string().max(256)).max(20);

/** What an edit does to the technology trees, from a comparison of the graph before and after it. */
export const techWritePlacementReportSchema = z
  .object({
    /** False when the comparison could not run; reason says why. The write is not affected. */
    computed: z.boolean(),
    reason: z.string().max(300).optional(),
    /** False when either graph was cut short, so the counts may be low. */
    complete: z.boolean().optional(),
    addedTechnologies: technologyIdList.optional(),
    removedTechnologies: technologyIdList.optional(),
    /** Technologies whose fields other than the placement changed. */
    changedTechnologies: technologyIdList.optional(),
    moved: z
      .array(
        z
          .object({
            technologyId: z.string().max(256),
            from: z.array(z.string().max(300)).max(4),
            to: z.array(z.string().max(300)).max(4),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    addedPaths: z.number().int().min(0).optional(),
    removedPaths: z.number().int().min(0).optional(),
    newIssues: z
      .array(z.object({ code: z.string().max(128), message: z.string().max(300) }).strict())
      .max(10)
      .optional(),
    resolvedIssues: z.number().int().min(0).optional(),
    /** Technologies no start reaches through a path any more. */
    newlyOrphaned: technologyIdList.optional(),
    newlyReachable: technologyIdList.optional(),
    /** True when a list above was cut at its limit. */
    truncated: z.boolean().optional(),
  })
  .strict();

export type TechWritePlacementReport = z.infer<typeof techWritePlacementReportSchema>;

export type TechWriteRequest = z.infer<typeof techWriteRequestSchema>;

export const techWriteDataSchema = z
  .object({
    operation: z.enum(['add', 'replace', 'remove']),
    id: z.string().max(256),
    path: z.string().max(1024),
    applied: z.boolean(),
    /** The unified diff of the file, cut at a line when it is long. */
    diff: z.string().max(12_000),
    diffTruncated: z.boolean(),
    /** The other technologies of the file, checked to be byte for byte as they were. */
    untouchedDefinitions: z.number().int().min(0),
    /** The effect on the technology trees. Present only when placement was asked for. */
    placement: techWritePlacementReportSchema.optional(),
    /** What the technology refers to and the mod does not define. The write still happens. */
    missing: z
      .object({
        localisation: z.array(z.string().max(256)).max(20),
        sprite: z.array(z.string().max(256)).max(1),
        unlock: z.array(z.string().max(256)).max(20),
        folder: z.array(z.string().max(256)).max(1),
      })
      .strict(),
  })
  .strict();

export type TechWriteData = z.infer<typeof techWriteDataSchema>;
