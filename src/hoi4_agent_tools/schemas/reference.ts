import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';

export const referenceSourceSchema = z.enum(['game_doc', 'wiki', 'script_doc']);
export const referenceSurfaceSchema = z.enum([
  'general',
  'event',
  'decision',
  'idea',
  'focus',
  'technology',
  'gui',
  'map',
  'localisation',
  'ai',
]);

export const referenceSearchRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    query: z.string().trim().min(2).max(160),
    sources: z.array(referenceSourceSchema).min(1).max(3).optional(),
    limit: z.number().int().min(1).max(12).default(6),
  })
  .strict();

export const referenceReadRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    source: referenceSourceSchema.optional(),
    startLine: z.number().int().min(1).optional(),
    startColumn: z.number().int().min(1).optional(),
    maxLines: z.number().int().min(1).max(80).default(40),
  })
  .strict();

export const referenceContextRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    surface: referenceSurfaceSchema,
    question: z.string().trim().min(2).max(160).optional(),
    limit: z.number().int().min(1).max(24).default(16),
  })
  .strict();

export const sourceKeyPathSchema = z
  .array(
    z.union([
      z
        .object({
          key: z.string().min(1).max(1024),
          occurrence: z.number().int().min(0).max(100_000).optional(),
        })
        .strict(),
      z.object({ index: z.number().int().min(0).max(100_000) }).strict(),
    ]),
  )
  .max(24);

export const sourceLookupRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    symbol: z.string().trim().min(1).max(256).optional(),
    /** Locate mode: a scanned source path (`mod:events/a.txt`, `events/a.txt`, or absolute). */
    path: z.string().trim().min(1).max(4096).optional(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    kind: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/u)
      .optional(),
    includeReferences: z.boolean().default(true),
    maxDefinitions: z.number().int().min(1).max(3).default(3),
    maxReferences: z.number().int().min(0).max(20).default(10),
    maxLines: z.number().int().min(1).max(80).default(30),
    keyPath: sourceKeyPathSchema.optional(),
    view: z.enum(['source', 'structure']).default('source'),
    maxChildren: z.number().int().min(1).max(40).default(20),
    childOffset: z.number().int().min(0).max(100_000).default(0),
    fromLine: z.number().int().min(1).optional(),
    fromColumn: z.number().int().min(1).optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const locating = value.path !== undefined || value.line !== undefined;
    if (locating === (value.symbol !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['symbol'],
        message: 'Provide either symbol, or path and line to locate a source position',
      });
    if (locating && (value.path === undefined || value.line === undefined))
      context.addIssue({
        code: 'custom',
        path: ['line'],
        message: 'Locating a source position requires both path and line',
      });
    if (!locating && value.column !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['column'],
        message: 'column applies only with path and line',
      });
    if (
      locating &&
      (value.keyPath !== undefined ||
        value.view === 'structure' ||
        value.fromLine !== undefined ||
        value.fromColumn !== undefined ||
        value.expectedRevision !== undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Navigation options apply to a symbol lookup; locate first, then pass its keyPath',
      });
  });

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const line = z.number().int().min(1);
const count = z.number().int().min(0);
const coverage = z
  .object({
    files: count,
    sections: count,
    unavailable: z.boolean(),
    included: z.boolean(),
  })
  .strict();
const coverageBySource = z
  .object({ game_doc: coverage, wiki: coverage, script_doc: coverage })
  .strict();
export const referenceSectionSchema = z
  .object({
    id: hash,
    revision: hash,
    source: referenceSourceSchema,
    title: z.string().max(512),
    heading: z.string().max(512),
    path: z.string().max(4096),
    startLine: line,
    endLine: line,
    excerpt: z.string().max(300),
    authority: z.string().max(80),
  })
  .strict();
export const referenceSearchDataSchema = z
  .object({
    results: z.array(referenceSectionSchema.extend({ score: z.number() })).max(12),
    total: count,
    omitted: count,
    limitedByBytes: z.boolean(),
    coverage: coverageBySource,
    skipped: count,
  })
  .strict();
export const referenceReadDataSchema = referenceSectionSchema
  .extend({
    sectionStartLine: line,
    sectionEndLine: line,
    startColumn: line,
    text: z.string().max(8000),
    nextLine: line.nullable(),
    nextColumn: line.nullable(),
  })
  .strict();
export const referenceContextDataSchema = z
  .object({
    surface: referenceSurfaceSchema,
    sections: z.array(referenceSectionSchema).max(24),
    omitted: count,
    limitedByBytes: z.boolean(),
    omittedSources: z.array(z.string().max(256)).max(32),
    missing: z.array(z.string().max(256)).max(32),
    coverage: coverageBySource,
    skipped: count,
  })
  .strict();
export const sourceLookupDataSchema = z
  .object({
    sourceScope: z.enum([
      'workspace_index',
      'event_definitions',
      'event_consumers',
      'helper_definitions',
      'source_location',
    ]),
    revision: hash,
    complete: z.boolean(),
    skippedSourceCount: count,
    definitionCount: count,
    definitionsTruncated: z.boolean(),
    referencesIncluded: z.boolean(),
    referenceCount: count,
    referencesTruncated: z.boolean(),
    referencesComplete: z.boolean(),
    unresolvedReferenceCount: count,
    location: z
      .object({
        path: z.string().max(4096),
        rootKind: z.string().max(32),
        loadOrder: count,
        shadowed: z.boolean(),
        line,
        column: line,
        text: z.string().max(300),
        owners: z
          .array(
            z
              .object({
                kind: z.string().max(64),
                id: z.string().max(1024),
                startLine: line,
                endLine: line,
                overridden: z.boolean(),
              })
              .strict(),
          )
          .max(8),
        chain: z
          .array(
            z
              .object({
                key: z.string().max(128).nullable(),
                occurrence: count,
                index: count,
                startLine: line,
                endLine: line,
              })
              .strict(),
          )
          .max(24),
        chainTruncated: z.boolean(),
        keyPath: sourceKeyPathSchema.nullable(),
        structureAvailable: z.boolean(),
      })
      .strict()
      .optional(),
    definitions: z
      .array(
        z
          .object({
            kind: z.string().max(64),
            id: z.string().max(1024),
            path: z.string().max(4096),
            rootKind: z.string().max(32),
            loadOrder: count,
            overridden: z.boolean(),
            sourceShadowed: z.boolean(),
            startLine: line.nullable(),
            endLine: line.nullable(),
            fromLine: line.nullable(),
            toLine: line.nullable(),
            nextLine: line.nullable(),
            nextColumn: line.nullable(),
            text: z.string().max(2000),
            navigation: z
              .object({
                keyPath: sourceKeyPathSchema,
                startLine: line,
                startColumn: line,
                endLine: line,
                endColumn: line,
                children: z
                  .array(
                    z
                      .object({
                        key: z.string().max(1024).nullable(),
                        index: count,
                        keyTruncated: z.boolean(),
                        occurrence: count,
                        kind: z.enum(['scalar', 'block']),
                        value: z.string().max(120).nullable(),
                        valueTruncated: z.boolean(),
                        startLine: line,
                        endLine: line,
                        childCount: count,
                      })
                      .strict(),
                  )
                  .max(40),
                omittedChildren: count,
                nextChildOffset: count.nullable(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(3),
    references: z
      .array(
        z
          .object({
            kind: z.string().max(64),
            from: z.string().max(1024),
            toKind: z.string().max(64),
            path: z.string().max(4096),
            line: line.nullable(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
