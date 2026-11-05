import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';

/** `hoi4.localisation_inspect`, answered by `hoi4-engine localisation` (ADR 0074). */
export const localisationInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** key: one key in every language. audit: the mod's problems. coverage: keys per language. */
    mode: z.enum(['key', 'audit', 'coverage']).default('audit'),
    key: z.string().min(1).max(256).optional(),
    /** Restricts audit and coverage to one language, for example `german`. */
    language: z
      .string()
      .regex(/^[a-z_]{2,32}$/u)
      .optional(),
    /** key: mentions listed. audit: examples kept per problem code. */
    limit: z.number().int().min(1).max(50).default(5),
  })
  .strict()
  .refine((input) => input.mode !== 'key' || input.key !== undefined, {
    message: 'mode key needs a key',
    path: ['key'],
  });

const definitionSchema = z
  .object({
    language: z.string().max(64),
    text: z.string().max(2400),
    path: z.string().max(1024),
    line: z.number().int().min(0),
    layer: z.string().max(256),
    layerKind: z.enum(['game', 'dlc', 'dependency', 'mod']),
    replace: z.boolean(),
  })
  .strict();

const problemSchema = z
  .object({
    code: z.string().max(64),
    severity: z.enum(['warning', 'info']),
    key: z.string().max(256).nullable(),
    language: z.string().max(64).nullable(),
    path: z.string().max(1024),
    line: z.number().int().min(0),
    message: z.string().max(1200),
  })
  .strict();

/** The engine's answer, checked as it arrives. */
export const localisationEngineResponseSchema = z
  .object({
    mode: z.enum(['key', 'audit', 'coverage']),
    shippedLanguages: z.array(z.string().max(64)).max(64),
    supportedLanguages: z.array(z.string().max(64)).max(64),
    mainLanguage: z.string().max(64).nullable(),
    filesRead: z.number().int().min(0),
    key: z
      .object({
        key: z.string().max(256),
        found: z.boolean(),
        definitions: z.array(definitionSchema).max(512),
        missingLanguages: z.array(z.string().max(64)).max(64),
        mentions: z
          .array(
            z
              .object({ path: z.string().max(1024), line: z.number().int(), layer: z.string() })
              .strict(),
          )
          .max(200),
        mentionsTruncated: z.boolean(),
        suggestions: z.array(z.string().max(256)).max(3).optional(),
      })
      .strict()
      .optional(),
    audit: z
      .object({
        counts: z.record(z.string(), z.number().int().min(0)),
        problems: z.array(problemSchema).max(4000),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
    coverage: z
      .array(
        z
          .object({
            language: z.string().max(64),
            files: z.number().int().min(0),
            keys: z.number().int().min(0),
            missing: z.number().int().min(0),
            supported: z.boolean(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();

export type LocalisationEngineResponse = z.infer<typeof localisationEngineResponseSchema>;

/** The tool's data: the engine's answer with the problem examples bounded for the inline reply. */
export const localisationInspectDataSchema = localisationEngineResponseSchema.extend({
  durationMs: z.number().int().min(0),
});
