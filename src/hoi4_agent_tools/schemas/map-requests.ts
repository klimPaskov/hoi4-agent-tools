import { z } from 'zod/v4';
import { MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT } from '../map/limits.js';
import { backgroundRequestKeySchema, workspaceIdSchema } from './common.js';
import { mapAllocationRequestSchema, mapOperationSchema } from './map.js';

function compact<T extends z.ZodType>(schema: T, description: string): z.ZodPipe<z.ZodUnknown, T> {
  return z.unknown().describe(description).pipe(schema);
}

const compactMapOperationSchema = compact(mapOperationSchema, 'Complete map operation.');

export const mapLayerSchema = z.enum([
  'province',
  'state',
  'strategic-region',
  'terrain',
  'continent',
  'owner',
  'controller',
  'cores',
  'claims',
  'coast',
]);

export const mapOverlaySchema = z.enum([
  'coastlines',
  'ports',
  'victory-points',
  'resources',
  'state-buildings',
  'province-buildings',
  'supply-nodes',
  'railways',
  'adjacencies',
  'building-positions',
  'unit-positions',
  'weather-positions',
]);

export const mapInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    provinceIds: z
      .array(z.number().int().min(0))
      .max(MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT)
      .default([])
      .describe(`Export row runs for up to ${MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT} province IDs`),
    stateIds: z.array(z.number().int().positive()).max(1_000).default([]),
    regionIds: z.array(z.number().int().positive()).max(1_000).default([]),
    query: z.string().max(256).optional(),
    queryLimit: z.number().int().min(1).max(1_000).default(100),
    coordinates: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('pixel'),
              x: z.number().int().min(0),
              y: z.number().int().min(0),
            })
            .strict(),
          z
            .object({
              kind: z.literal('map'),
              x: z.number(),
              z: z.number(),
            })
            .strict(),
        ]),
      )
      .max(100)
      .default([]),
    lookupOnly: z.boolean().default(false),
    includeOverview: z.boolean().default(true),
    allocationRequests: z.array(mapAllocationRequestSchema).max(100).default([]),
  })
  .strict();

export const mapRenderRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    layer: mapLayerSchema.optional(),
    overlays: z.array(mapOverlaySchema).max(12).optional(),
    scale: z.number().int().min(1).max(16).optional(),
    tile: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1).max(2_048),
        height: z.number().int().min(1).max(2_048),
      })
      .strict()
      .optional(),
    area: z
      .object({
        provinceIds: z.array(z.number().int().nonnegative()).max(256).optional(),
        stateIds: z.array(z.number().int().nonnegative()).max(64).optional(),
        regionIds: z.array(z.number().int().nonnegative()).max(64).optional(),
        padding: z.number().int().min(0).max(256).optional(),
      })
      .strict()
      .refine(
        ({ provinceIds, stateIds, regionIds }) =>
          (provinceIds?.length ?? 0) + (stateIds?.length ?? 0) + (regionIds?.length ?? 0) > 0,
        'Map area requires at least one province, state, or region ID',
      )
      .optional(),
  })
  .strict()
  .refine(
    ({ tile, area }) => tile === undefined || area === undefined,
    'Choose tile or area, not both',
  );

export const mapRewriteRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operations: z.array(compactMapOperationSchema).min(1).max(100),
    diffScale: z.number().int().min(1).max(16).optional(),
    requestKey: backgroundRequestKeySchema.optional(),
  })
  .strict();

export type MapInspectToolRequest = z.infer<typeof mapInspectRequestSchema>;
export type MapRenderToolRequest = z.infer<typeof mapRenderRequestSchema>;
export type MapRewriteToolRequest = z.infer<typeof mapRewriteRequestSchema>;
