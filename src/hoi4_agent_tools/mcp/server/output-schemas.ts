import { z } from 'zod/v4';
import { artifactLinkSchema } from '../../schemas/transaction.js';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const transactionIdSchema = z.string().regex(/^txn_[0-9a-f-]{36}$/u);
export const nonNegativeIntegerSchema = z.number().int().min(0);
export const WORKSPACE_INLINE_REPLACE_PATHS = 20;
export const WORKSPACE_INLINE_OWNER_PATHS = 10;
export const WORKSPACE_MAX_REPLACEMENT_OWNERS = 17;

export const indexSkippedSourceSchema = z
  .object({
    path: z.string().max(4096),
    relativePath: z.string().max(1024),
    rootKind: z.string().max(64),
    loadOrder: nonNegativeIntegerSchema,
    sha256: sha256Schema,
    reasonCodes: z.array(z.string().max(256)).max(16),
    possibleSymbolKinds: z.array(z.string().max(256)).max(32),
  })
  .strict();

export const workspaceStatusSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().max(1024),
    kind: z.string().max(64),
    writeEnabled: z.boolean(),
    writePolicy: z.enum(['read-only', 'transactions', 'autonomous']),
    rootKinds: z.array(z.string().max(64)).max(16),
    dependencyCount: nonNegativeIntegerSchema,
    replacePathCount: nonNegativeIntegerSchema,
    replacePaths: z.array(z.string().max(1024)).max(WORKSPACE_INLINE_REPLACE_PATHS),
    replacePathsTruncated: z.boolean(),
    replacementOwners: z
      .array(
        z
          .object({
            rootKind: z.string().max(64),
            loadOrder: nonNegativeIntegerSchema,
            pathCount: nonNegativeIntegerSchema,
            paths: z.array(z.string().max(1024)).max(WORKSPACE_INLINE_OWNER_PATHS),
            pathsTruncated: z.boolean(),
          })
          .strict(),
      )
      .max(WORKSPACE_MAX_REPLACEMENT_OWNERS),
    generatedDirectory: z.literal('.hoi4-agent'),
  })
  .strict();

export const renderHashesSchema = z
  .object({
    html: sha256Schema,
    svg: sha256Schema,
    png: sha256Schema,
    json: sha256Schema,
  })
  .strict();

export const bitmapRenderHashesSchema = z
  .object({ png: sha256Schema, json: sha256Schema, html: sha256Schema })
  .strict();

export const transactionStateSchema = z.enum([
  'planned',
  'applying',
  'applied',
  'rolling_back',
  'rolled_back',
  'failed',
]);

export const transactionStateDataSchema = z
  .object({
    state: transactionStateSchema,
    failure: z
      .object({ code: z.string().max(256), message: z.string().max(4096) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const artifactProvenanceSummarySchema = z
  .object({
    kind: z.string().max(256),
    toolVersion: z.string().max(64),
    schemaVersion: z.string().max(64),
    sourceHashCount: nonNegativeIntegerSchema,
    sourceHashes: z
      .array(z.object({ path: z.string().max(4096), sha256: sha256Schema }).strict())
      .max(100),
    sourceHashesTruncated: z.boolean(),
    hasRenderProfile: z.boolean(),
    hasMetadata: z.boolean(),
  })
  .strict();

export const artifactDescriptionSchema = artifactLinkSchema
  .extend({
    provenanceHash: sha256Schema,
    provenance: artifactProvenanceSummarySchema,
    descriptionTruncated: z.boolean(),
  })
  .strict();

export const allocationEvidenceSchema = z
  .object({
    kind: z.enum(['state-id', 'province-id', 'province-color']),
    allocated: z.union([z.number(), z.string().max(64)]),
    strategy: z.string().max(256),
    highestObserved: z.number().optional(),
    contiguousBefore: z.boolean().optional(),
    probes: nonNegativeIntegerSchema.optional(),
    occupiedCount: nonNegativeIntegerSchema.optional(),
    rootCount: nonNegativeIntegerSchema,
    rootsTruncated: z.boolean(),
    roots: z
      .array(
        z
          .object({
            rootKind: z.string().max(64),
            loadOrder: nonNegativeIntegerSchema,
            sourceCount: nonNegativeIntegerSchema,
            samplePath: z.string().max(4096),
            maximumId: z.number().int(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export const operationBlockerDataSchema = z
  .object({
    code: z.string().max(256),
    message: z.string().max(4096),
    operationId: z.string().max(256),
    details: z.record(z.string().max(256), z.unknown()).optional(),
  })
  .strict();
