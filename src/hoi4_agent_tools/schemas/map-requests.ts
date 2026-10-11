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

const mapTileSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1).max(2_048),
    height: z.number().int().min(1).max(2_048),
  })
  .strict();

const mapAreaSchema = z
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
  );

/** Fields that select a rendered map view instead of validation and lookups. */
export const MAP_VIEW_FIELDS = ['layer', 'overlays', 'scale', 'tile', 'area'] as const;
const MAP_LOOKUP_FIELDS = [
  'provinceIds',
  'stateIds',
  'regionIds',
  'query',
  'coordinates',
  'allocationRequests',
] as const;

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
    references: z
      .boolean()
      .default(false)
      .describe(
        'Also check events, focuses, decisions, history and AI areas for states, provinces and regions the map lacks, and state tags without a country.',
      ),
    layer: mapLayerSchema
      .optional()
      .describe(
        'Render this base layer instead of validating; combine with overlays, tile or area.',
      ),
    overlays: z.array(mapOverlaySchema).max(12).optional(),
    scale: z.number().int().min(1).max(16).optional(),
    tile: mapTileSchema.optional().describe('Render one top-left bitmap area.'),
    area: mapAreaSchema
      .optional()
      .describe('Render the bounding area of these provinces, states or regions.'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tile !== undefined && value.area !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['area'],
        message: 'Choose tile or area, not both',
      });
    if (!MAP_VIEW_FIELDS.some((field) => value[field] !== undefined)) return;
    for (const field of MAP_LOOKUP_FIELDS) {
      const fieldValue = value[field];
      if (fieldValue !== undefined && !(Array.isArray(fieldValue) && fieldValue.length === 0))
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is a lookup; request a rendered view (layer, overlays, tile, area, scale) in a separate call`,
        });
    }
  });

/** Internal render request derived from a map inspection that names a view. */
export const mapRenderRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    layer: mapLayerSchema.optional(),
    overlays: z.array(mapOverlaySchema).max(12).optional(),
    scale: z.number().int().min(1).max(16).optional(),
    tile: mapTileSchema.optional(),
    area: mapAreaSchema.optional(),
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
