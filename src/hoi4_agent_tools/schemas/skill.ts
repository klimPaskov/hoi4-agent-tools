import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
/** A file inside one skill folder, such as SKILL.md or references/events.md. */
export const SKILL_FILE_PATTERN = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;
/** The most text one call returns; a longer file continues from nextOffset. */
export const SKILL_TEXT_BYTES = 20_000;

export const skillRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** Omit to list the mod's skills; name one to load it. */
    name: z.string().regex(SKILL_NAME_PATTERN).optional(),
    /** A file inside the skill folder; SKILL.md by default. */
    file: z.string().regex(SKILL_FILE_PATTERN).default('SKILL.md'),
    /** Byte offset to continue a long file from, as returned in nextOffset. */
    offset: z.number().int().min(0).max(16_000_000).default(0),
    /** Serve a file whose bytes differ from the kit version the mod pins. */
    acceptLocalEdits: z.boolean().default(false),
  })
  .strict();

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/**
 * pinned: the installed bytes match the kit version in the mod's Setup lock.
 * edited: the installed bytes differ from it. missing: the lock names a file that is gone.
 * unpinned: the mod has no Setup lock, so no kit version can be checked.
 */
const skillStateSchema = z.enum(['pinned', 'edited', 'missing', 'unpinned']);

export const skillDataSchema = z
  .object({
    /** The kit release HOI4 Mod Setup installed, or null when the mod has no Setup lock. */
    kit: z
      .object({
        repository: z.string().max(200),
        revision: z.string().max(64),
        release: z.string().max(64).nullable(),
        manifestSha256: sha256,
      })
      .strict()
      .nullable(),
    skills: z
      .array(
        z
          .object({
            name: z.string().max(64),
            description: z.string().max(300),
            files: z.number().int().min(0),
            state: skillStateSchema,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    skill: z
      .object({
        name: z.string().max(64),
        file: z.string().max(200),
        path: z.string().max(300),
        state: skillStateSchema,
        sha256,
        /** The hash the Setup lock records for this file; null when unpinned. */
        pinnedSha256: sha256.nullable(),
        bytes: z.number().int().min(0),
        offset: z.number().int().min(0),
        nextOffset: z.number().int().min(0).nullable(),
        text: z.string(),
        /** Other files of this skill, such as references, loadable with file. */
        otherFiles: z.array(z.string().max(200)).max(64),
      })
      .strict()
      .optional(),
    /** Skills with an edited or missing file. */
    drifted: z.number().int().min(0),
  })
  .strict();

export type SkillRequest = z.infer<typeof skillRequestSchema>;
export type SkillData = z.infer<typeof skillDataSchema>;
