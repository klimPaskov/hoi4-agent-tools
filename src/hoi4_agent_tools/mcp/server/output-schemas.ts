import { z } from 'zod/v4';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const nonNegativeIntegerSchema = z.number().int().min(0);

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
