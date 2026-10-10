import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';

export const errorLogCategorySchema = z.enum([
  'syntax',
  'duplicate',
  'localisation',
  'effect',
  'trigger',
  'scope',
  'graphics',
  'interface',
  'map',
  'missing_reference',
  'other',
]);

export const errorLogRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** mod: entries located in the mod's own files; unlocated: entries naming no file. */
    scope: z.enum(['all', 'mod', 'unlocated']).default('all'),
    category: errorLogCategorySchema.optional(),
    query: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export const errorLogDataSchema = z
  .object({
    log: z
      .object({
        path: z.string().max(64),
        modifiedAt: z.string().max(64),
        bytes: z.number().int().min(0),
        truncated: z.boolean(),
        entries: z.number().int().min(0),
      })
      .strict(),
    scope: z.enum(['all', 'mod', 'unlocated']),
    totalEntries: z.number().int().min(0),
    distinctEntries: z.number().int().min(0),
    modEntries: z.number().int().min(0),
    changedSinceLog: z.number().int().min(0),
    categories: z.array(
      z
        .object({
          category: errorLogCategorySchema,
          entries: z.number().int().min(0),
          distinct: z.number().int().min(0),
          hint: z.string().max(300),
        })
        .strict(),
    ),
    /** Messages that differ only in names, numbers and paths, grouped by their shape. */
    patterns: z
      .array(
        z
          .object({
            pattern: z.string().max(300),
            category: errorLogCategorySchema,
            distinct: z.number().int().min(0),
            entries: z.number().int().min(0),
            example: z.string().max(600),
          })
          .strict(),
      )
      .max(8),
    /** Compared with the previous launch's log this server read, when there was one. */
    sinceLastLaunch: z
      .object({
        previousLogAt: z.string().max(64),
        newEntries: z.number().int().min(0),
        persistingEntries: z.number().int().min(0),
        resolvedEntries: z.number().int().min(0),
        resolvedExamples: z
          .array(
            z
              .object({
                category: errorLogCategorySchema,
                message: z.string().max(300),
                relativePath: z.string().max(1024).optional(),
              })
              .strict(),
          )
          .max(5),
      })
      .strict()
      .optional(),
    entries: z
      .array(
        z
          .object({
            category: errorLogCategorySchema,
            module: z.string().max(128),
            message: z.string().max(600),
            count: z.number().int().min(1),
            firstLogLine: z.number().int().min(1),
            time: z.string().max(16).optional(),
            /** Absent from the previous launch's log. */
            new: z.boolean().optional(),
            source: z
              .object({
                relativePath: z.string().max(1024),
                line: z.number().int().min(0).optional(),
                layer: z.enum(['mod', 'dependency', 'game', 'unknown']),
                changedSinceLog: z.boolean(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(50),
    offset: z.number().int().min(0),
    nextOffset: z.number().int().min(0).optional(),
  })
  .strict();

export const modIndexRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: z.enum(['overview', 'next_id']).default('overview'),
    /** overview: the mod's own files, or every layer. */
    layer: z.enum(['mod', 'all']).default('mod'),
    /** next_id: the symbol kind whose numbered identifiers are counted. */
    kind: z.enum(['event', 'focus', 'decision', 'idea', 'leader', 'technology']).default('event'),
    prefix: z.string().min(1).max(256).optional(),
    namespace: z.string().min(1).max(256).optional(),
  })
  .strict();

export const modIndexDataSchema = z
  .object({
    mode: z.enum(['overview', 'next_id']),
    complete: z.boolean(),
    layer: z.enum(['mod', 'all']).optional(),
    /** The mod's descriptor.mod metadata. */
    descriptor: z
      .object({
        name: z.string().max(256).optional(),
        version: z.string().max(256).optional(),
        supportedVersion: z.string().max(256).optional(),
        remoteFileId: z.string().max(256).optional(),
        tags: z.array(z.string().max(256)).max(64),
        dependencies: z.array(z.string().max(256)).max(64),
        replacePaths: z.array(z.string().max(256)).max(64),
      })
      .strict()
      .optional(),
    files: z.number().int().min(0).optional(),
    kinds: z
      .array(z.object({ kind: z.string().max(64), count: z.number().int().min(0) }).strict())
      .optional(),
    folders: z
      .array(
        z
          .object({
            folder: z.string().max(256),
            files: z.number().int().min(0),
            bytes: z.number().int().min(0),
          })
          .strict(),
      )
      .optional(),
    namespaces: z
      .array(
        z
          .object({
            namespace: z.string().max(256),
            events: z.number().int().min(0),
            lowest: z.number().int().min(0),
            highest: z.number().int().min(0),
            files: z.number().int().min(0),
          })
          .strict(),
      )
      .optional(),
    omittedNamespaces: z.number().int().min(0).optional(),
    next: z
      .object({
        kind: z.string().max(64),
        prefix: z.string().max(256),
        used: z.number().int().min(0),
        highest: z.number().int().min(0).optional(),
        nextId: z.string().max(300),
        firstGapId: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
