import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';

/** `hoi4.idea_inspect`, answered by `hoi4-engine ideas` (ADR 0074). */
export const ideaInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** idea: a national spirit, law or advisor idea. character: a leader, advisor or commander. */
    kind: z.enum(['idea', 'character']).default('idea'),
    /** The idea or character to inspect. Leave it out with audit. */
    id: z.string().min(1).max(256).optional(),
    /** Check every idea or character the mod defines instead of one. */
    audit: z.boolean().default(false),
    /** One: mentions listed. Audit: examples kept per problem code. */
    limit: z.number().int().min(1).max(50).default(5),
  })
  .strict()
  .refine((input) => input.audit || input.id !== undefined, {
    message: 'pass an id, or audit: true',
    path: ['id'],
  });

const placeSchema = z
  .object({
    path: z.string().max(1024),
    line: z.number().int().min(0),
    layer: z.string().max(256),
    layerKind: z.enum(['game', 'dlc', 'dependency', 'mod']),
  })
  .strict();

const fieldSchema = z
  .object({ name: z.string().max(128), text: z.string().max(2400), line: z.number().int() })
  .strict();

const problemSchema = z
  .object({
    code: z.string().max(64),
    severity: z.enum(['warning', 'info']),
    message: z.string().max(1200),
    line: z.number().int().min(0),
  })
  .strict();

const textSchema = z
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

/** One idea or character, as the engine answers it. */
export const ideaEngineInspectionSchema = z
  .object({
    kind: z.enum(['idea', 'character']),
    id: z.string().max(256),
    found: z.boolean(),
    definitions: z.array(placeSchema).max(256),
    category: z.string().max(128).optional(),
    picture: z
      .object({
        sprite: z.string().max(512),
        defined: z.boolean(),
        texture: z.string().max(1024).nullable(),
        textureExists: z.boolean().nullable(),
      })
      .strict()
      .optional(),
    modifiers: z
      .array(
        z
          .object({
            block: z.string().max(64),
            key: z.string().max(256),
            value: z.string().max(256),
            known: z.boolean(),
            line: z.number().int(),
          })
          .strict(),
      )
      .max(512)
      .optional(),
    fields: z.array(fieldSchema).max(128).optional(),
    roles: z
      .array(
        z
          .object({
            role: z.string().max(64),
            instance: z.number().int().min(0).nullable(),
            fields: z.array(fieldSchema).max(64),
            traits: z
              .array(z.object({ name: z.string().max(256), known: z.boolean() }).strict())
              .max(64),
            line: z.number().int(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    portraits: z
      .array(
        z
          .object({ slot: z.string().max(64), value: z.string().max(1024), exists: z.boolean() })
          .strict(),
      )
      .max(128)
      .optional(),
    advisorOf: z.string().max(256).optional(),
    texts: z
      .array(z.object({ key: z.string().max(256), texts: z.array(textSchema).max(64) }).strict())
      .max(4),
    mentions: z
      .array(
        z
          .object({ path: z.string().max(1024), line: z.number().int(), layer: z.string() })
          .strict(),
      )
      .max(100),
    mentionsTruncated: z.boolean(),
    problems: z.array(problemSchema).max(256),
    suggestions: z.array(z.string().max(256)).max(3).optional(),
  })
  .strict();

/** Every idea or character of the mod, as the engine answers an audit. */
export const ideaEngineAuditSchema = z
  .object({
    kind: z.enum(['idea', 'character']),
    checked: z.number().int().min(0),
    counts: z.record(z.string(), z.number().int().min(0)),
    problems: z
      .array(
        z
          .object({
            code: z.string().max(64),
            severity: z.enum(['warning', 'info']),
            id: z.string().max(256),
            path: z.string().max(1024),
            line: z.number().int().min(0),
            message: z.string().max(1200),
          })
          .strict(),
      )
      .max(1000),
    truncated: z.boolean(),
  })
  .strict();

export const ideaInspectDataSchema = z
  .object({
    inspection: ideaEngineInspectionSchema.optional(),
    audit: ideaEngineAuditSchema.optional(),
    durationMs: z.number().int().min(0),
  })
  .strict();
