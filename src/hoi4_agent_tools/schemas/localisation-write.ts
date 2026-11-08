import { z } from 'zod/v4';
import {
  backgroundRequestKeySchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from './common.js';

/** The languages the game ships (`localisation/languages.yml`). */
export const LOCALISATION_LANGUAGES = [
  'english',
  'french',
  'german',
  'spanish',
  'polish',
  'russian',
  'braz_por',
  'japanese',
  'simp_chinese',
  'korean',
] as const;
export const localisationLanguageSchema = z.enum(LOCALISATION_LANGUAGES);
export type LocalisationLanguage = z.infer<typeof localisationLanguageSchema>;

export const LOCALISATION_FIXES = ['bom', 'quotes', 'missing_languages'] as const;
export const localisationFixSchema = z.enum(LOCALISATION_FIXES);
export type LocalisationFix = z.infer<typeof localisationFixSchema>;

export const LOCALISATION_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/u;
// A value is one line: no line break, tab or other control character.
const FORBIDDEN_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export const localisationEntrySchema = z
  .object({
    key: z.string().regex(LOCALISATION_KEY_PATTERN),
    text: z
      .string()
      .max(2000)
      .refine((value) => !FORBIDDEN_TEXT.test(value), {
        message: 'text must be one line; write a line break as \\n',
      }),
  })
  .strict();

export const localisationWriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: z.enum(['add', 'fix']),
    apply: z
      .boolean()
      .default(false)
      .describe('false returns the diff and writes nothing; true makes the same change.'),
    entries: z.array(localisationEntrySchema).min(1).max(200).optional(),
    language: localisationLanguageSchema.default('english'),
    file: workspaceRelativePathSchema.max(512).optional(),
    replace: z.boolean().default(false),
    fixes: z
      .array(localisationFixSchema)
      .min(1)
      .max(3)
      .default([...LOCALISATION_FIXES]),
    paths: z.array(workspaceRelativePathSchema.max(512)).min(1).max(200).optional(),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const misplaced = (field: string): void =>
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} belongs to the other mode`,
      });
    if (value.mode === 'add') {
      if (value.entries === undefined)
        context.addIssue({ code: 'custom', path: ['entries'], message: 'mode add needs entries' });
      else {
        const seen = new Set<string>();
        for (const [index, entry] of value.entries.entries()) {
          if (seen.has(entry.key))
            context.addIssue({
              code: 'custom',
              path: ['entries', index, 'key'],
              message: `${entry.key} appears twice in entries`,
            });
          seen.add(entry.key);
        }
      }
      if (value.paths !== undefined) misplaced('paths');
    } else {
      if (value.entries !== undefined) misplaced('entries');
      if (value.file !== undefined) misplaced('file');
      if (value.replace) misplaced('replace');
    }
  });

export type LocalisationWriteRequest = z.infer<typeof localisationWriteRequestSchema>;

const countSchema = z.number().int().min(0);
const changeKindSchema = z.enum([
  'add_key',
  'replace_key',
  'override_key',
  'create_file',
  'add_bom',
  'reencode_utf16',
  'fix_quote',
  'copy_missing_key',
]);

export const localisationWriteDataSchema = z
  .object({
    mode: z.enum(['add', 'fix']),
    applied: z.boolean(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(1024),
            action: z.enum(['create', 'update']),
            diff: z.string().max(12_000),
            diffTruncated: z.boolean(),
            changes: z
              .array(
                z
                  .object({
                    kind: changeKindSchema,
                    key: z.string().max(256).optional(),
                    line: z.number().int().min(1).optional(),
                  })
                  .strict(),
              )
              .max(8),
            changesOmitted: countSchema,
          })
          .strict(),
      )
      .max(12),
    skipped: z
      .array(z.object({ key: z.string().max(256), reason: z.string().max(300) }).strict())
      .max(20),
    unfixable: z
      .array(
        z
          .object({
            kind: z.string().max(64),
            path: z.string().max(1024).optional(),
            key: z.string().max(256).optional(),
            reason: z.string().max(300),
          })
          .strict(),
      )
      .max(20),
    notes: z.array(z.string().max(400)).max(10),
    counts: z
      .object({
        filesChanged: countSchema,
        filesCreated: countSchema,
        filesOmitted: countSchema,
        keysAdded: countSchema,
        keysReplaced: countSchema,
        keysOverridden: countSchema,
        keysSkipped: countSchema,
        skippedOmitted: countSchema,
        bomsAdded: countSchema,
        quotesFixed: countSchema,
        keysCopied: countSchema,
        unfixable: countSchema,
        unfixableOmitted: countSchema,
      })
      .strict(),
  })
  .strict();

export type LocalisationWriteData = z.infer<typeof localisationWriteDataSchema>;
