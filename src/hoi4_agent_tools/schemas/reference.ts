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

export const sourceLookupRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    symbol: z.string().trim().min(1).max(256),
    kind: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/u)
      .optional(),
    includeReferences: z.boolean().default(true),
    maxDefinitions: z.number().int().min(1).max(3).default(3),
    maxReferences: z.number().int().min(0).max(20).default(10),
    maxLines: z.number().int().min(1).max(80).default(30),
    fromLine: z.number().int().min(1).optional(),
    fromColumn: z.number().int().min(1).optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const line = z.number().int().min(1);
const count = z.number().int().min(0);
const coverage = z
  .object({
    files: count,
    sections: count,
    unavailable: z.boolean(),
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
    omittedSources: z.array(z.string().max(256)).max(32),
    missing: z.array(z.string().max(256)).max(32),
    coverage: coverageBySource,
    skipped: count,
  })
  .strict();
export const sourceLookupDataSchema = z
  .object({
    revision: hash,
    complete: z.boolean(),
    skippedSourceCount: count,
    definitionCount: count,
    referencesIncluded: z.boolean(),
    referenceCount: count,
    referencesTruncated: z.boolean(),
    referencesComplete: z.boolean(),
    unresolvedReferenceCount: count,
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
