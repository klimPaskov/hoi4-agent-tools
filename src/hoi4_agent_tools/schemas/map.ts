import { z } from 'zod/v4';
import { renderDimensionViolation, RENDER_MAX_DIMENSION } from '../core/render-budget.js';
import { MAP_MASK_CELL_LIMIT, MAP_SELECTED_PIXEL_LIMIT } from '../map/limits.js';

const identifier = z.string().min(1).max(256);
const stateId = z.number().int().positive();
const provinceId = z.number().int().min(0);
const provinceTypeSchema = z.enum(['land', 'sea', 'lake']);
const nonnegativeMap = z.record(z.string().min(1), z.number().min(0));
const rgbSchema = z
  .object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  })
  .strict();
const pointSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict();
const operationBase = {
  id: identifier,
  summary: z.string().max(1000).optional(),
};

const moveStateDistributionSchema = z
  .object({
    stateValues: z.literal('retain-in-current-states'),
    ownership: z.literal('retain-in-current-states'),
    provinceBuildings: z.literal('follow-province'),
    victoryPoints: z.literal('follow-province'),
    ports: z.literal('follow-province'),
    supplyNodes: z.literal('follow-province'),
    railways: z.literal('follow-province'),
    positions: z.literal('follow-province'),
    strategicRegion: z.enum(['require-same', 'move-to-target-region']),
  })
  .strict();

const splitScalarPolicySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('retain-in-source') }).strict(),
  z.object({ method: z.literal('proportional-by-land-pixels') }).strict(),
  z
    .object({
      method: z.literal('exact'),
      source: z.number().min(0),
      destination: z.number().min(0),
    })
    .strict(),
]);
const splitMapPolicySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('retain-in-source') }).strict(),
  z.object({ method: z.literal('proportional-by-land-pixels') }).strict(),
  z
    .object({ method: z.literal('exact'), source: nonnegativeMap, destination: nonnegativeMap })
    .strict(),
]);
const splitTagPolicySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('copy-source') }).strict(),
  z
    .object({
      method: z.literal('exact'),
      source: z.string().min(1).nullable(),
      destination: z.string().min(1).nullable(),
    })
    .strict(),
]);
const splitTagListPolicySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('copy-source') }).strict(),
  z
    .object({
      method: z.literal('exact'),
      source: z.array(z.string().min(1)).max(10_000),
      destination: z.array(z.string().min(1)).max(10_000),
    })
    .strict(),
]);
const splitStateDistributionSchema = z
  .object({
    manpower: splitScalarPolicySchema,
    resources: splitMapPolicySchema,
    stateBuildings: splitMapPolicySchema,
    owner: splitTagPolicySchema,
    controller: splitTagPolicySchema,
    cores: splitTagListPolicySchema,
    claims: splitTagListPolicySchema,
    victoryPoints: z.literal('follow-province'),
    provinceBuildings: z.literal('follow-province'),
    ports: z.literal('follow-province'),
    supplyNodes: z.literal('follow-province'),
    railways: z.literal('follow-province'),
    positions: z.literal('follow-province'),
  })
  .strict();
const stateLocalisationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('existing'), language: z.literal('l_english') }).strict(),
  z
    .object({
      method: z.literal('upsert'),
      language: z.literal('l_english'),
      value: z.string().min(1).max(100_000),
      file: z.string().min(1).max(1000).optional(),
    })
    .strict(),
]);
const mergeStateDistributionSchema = z
  .object({
    stateValues: z.literal('sum-into-target'),
    ownership: z.literal('retain-target'),
    controller: z.literal('retain-target'),
    cores: z.literal('union'),
    claims: z.literal('union'),
    victoryPoints: z.literal('follow-province'),
    provinceBuildings: z.literal('follow-province'),
    ports: z.literal('follow-province'),
    supplyNodes: z.literal('follow-province'),
    railways: z.literal('follow-province'),
    positions: z.literal('follow-province'),
    strategicRegion: z.literal('require-same'),
  })
  .strict();
const provinceDefinitionInputSchema = z
  .object({
    color: rgbSchema.optional(),
    type: provinceTypeSchema.optional(),
    coastal: z.boolean().optional(),
    terrain: z.string().min(1).optional(),
    continent: z.number().int().min(0).optional(),
  })
  .strict();
const provinceGeometrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pixels'),
      pixels: z
        .array(pointSchema)
        .min(1)
        .max(MAP_SELECTED_PIXEL_LIMIT)
        .describe(
          `Exact coordinates to recolor; at most ${MAP_SELECTED_PIXEL_LIMIT} pixels per operation`,
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mask'),
      width: z.number().int().positive().max(RENDER_MAX_DIMENSION),
      height: z.number().int().positive().max(RENDER_MAX_DIMENSION),
      origin: pointSchema,
      selectedPixelCount: z
        .number()
        .int()
        .positive()
        .max(MAP_SELECTED_PIXEL_LIMIT)
        .describe(
          `Declared selected cells; at most ${MAP_SELECTED_PIXEL_LIMIT} pixels per operation`,
        ),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      data: z.string().min(4).max(30_000_000),
    })
    .strict()
    .superRefine((value, context) => {
      const area = value.width * value.height;
      const violation = renderDimensionViolation(value.width, value.height, 'map operation mask', {
        maximumPixels: MAP_MASK_CELL_LIMIT,
      });
      if (violation !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['width'],
          message: `${violation.code}: ${violation.message}`,
        });
      }
      if (value.selectedPixelCount > area) {
        context.addIssue({
          code: 'custom',
          path: ['selectedPixelCount'],
          message: 'Selected-pixel count cannot exceed raster-mask area',
        });
      }
    }),
  z
    .object({
      kind: z.literal('polygon'),
      fillRule: z
        .literal('even-odd')
        .describe('Required deterministic polygon fill rule used for pixel-center sampling'),
      points: z
        .array(pointSchema)
        .min(3)
        .max(4_096)
        .describe(
          'Integer raster-boundary coordinates; runtime bounds are x from 0 through raster width and y from 0 through raster height',
        ),
    })
    .strict()
    .describe(
      `Even-odd polygon rasterization samples pixel centers and is rejected if it selects more than ${MAP_SELECTED_PIXEL_LIMIT} pixels`,
    ),
]);
const provinceDefinitionSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('inherit-source'),
      overrides: provinceDefinitionInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal('exact'),
      value: z
        .object({
          color: rgbSchema.optional(),
          type: provinceTypeSchema,
          coastal: z.boolean(),
          terrain: z.string().min(1),
          continent: z.number().int().min(0),
        })
        .strict(),
    })
    .strict(),
]);
const splitProvinceDistributionSchema = z
  .object({
    state: z.enum(['inherit-source', 'none']),
    strategicRegion: z.literal('inherit-source'),
    victoryPoints: z.literal('retain-source'),
    provinceBuildings: z.literal('retain-source'),
    ports: z.literal('retain-source'),
    supplyNodes: z.literal('retain-source'),
    railways: z.literal('retain-source'),
    adjacencies: z.literal('retain-source'),
    positions: z.literal('retain-source'),
    entityLocators: z.literal('retain-source'),
  })
  .strict();
const mergeProvinceDistributionSchema = z
  .object({
    membership: z.literal('require-same'),
    victoryPoints: z.literal('sum-into-target'),
    provinceBuildings: z.literal('sum-into-target'),
    references: z.literal('remap-to-target-and-deduplicate'),
  })
  .strict();
const provinceTypeStateMembershipSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('retain') }).strict(),
  z.object({ method: z.literal('remove'), stateId }).strict(),
  z.object({ method: z.literal('assign'), stateId }).strict(),
]);
const provinceTypeDistributionSchema = z
  .object({
    stateMembership: provinceTypeStateMembershipSchema,
    stateValues: z.literal('retain-in-current-states'),
    strategicRegion: z.literal('retain-membership'),
    victoryPoints: z.enum(['retain-if-valid', 'remove']),
    provinceBuildings: z.enum(['retain-if-valid', 'remove']),
    ports: z.enum(['retain-if-valid', 'remove']),
    supplyNodes: z.enum(['retain-if-valid', 'remove']),
    railways: z.enum(['retain-if-valid', 'remove-containing']),
    buildingPositions: z.enum(['retain-if-valid', 'remove']),
    unitPositions: z.enum(['retain-if-valid', 'remove']),
    entityLocators: z.literal('retain-at-coordinate'),
    adjacencies: z.enum(['retain-if-valid', 'remove-referencing']),
  })
  .strict();

const splitStateOperation = (kind: 'split_state' | 'create_state') =>
  z
    .object({
      ...operationBase,
      kind: z.literal(kind),
      sourceStateId: stateId,
      stateId: stateId.optional(),
      provinceIds: z.array(provinceId).min(1).max(100_000),
      name: z.string().max(1000).optional(),
      fileName: z.string().max(255).optional(),
      localisation: stateLocalisationSchema.optional(),
      distribution: splitStateDistributionSchema,
    })
    .strict();
const splitProvinceOperation = (kind: 'split_province' | 'create_province') =>
  z
    .object({
      ...operationBase,
      kind: z.literal(kind),
      sourceProvinceId: provinceId,
      provinceId: provinceId.optional(),
      geometry: provinceGeometrySchema,
      definition: provinceDefinitionSchema,
      distribution: splitProvinceDistributionSchema,
    })
    .strict();
const occurrenceSchema = z.number().int().min(0).optional();

export const mapOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...operationBase,
      kind: z.literal('move_state_provinces'),
      sourceStateId: stateId,
      targetStateId: stateId,
      provinceIds: z.array(provinceId).min(1).max(100_000),
      distribution: moveStateDistributionSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('add_normal_adjacency'),
      from: provinceId,
      to: provinceId,
      pixelTransfers: z
        .array(
          z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              sourceProvinceId: provinceId,
              targetProvinceId: provinceId,
            })
            .strict(),
        )
        .min(1)
        .max(MAP_SELECTED_PIXEL_LIMIT)
        .describe(
          `Exact raster recolors; at most ${MAP_SELECTED_PIXEL_LIMIT} transfers per operation`,
        ),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('remove_normal_adjacency'),
      from: provinceId,
      to: provinceId,
      pixelTransfers: z
        .array(
          z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              sourceProvinceId: provinceId,
              targetProvinceId: provinceId,
            })
            .strict(),
        )
        .min(1)
        .max(MAP_SELECTED_PIXEL_LIMIT)
        .describe(
          `Exact raster recolors; at most ${MAP_SELECTED_PIXEL_LIMIT} transfers per operation`,
        ),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('update_state'),
      stateId,
      changes: z
        .object({
          capital: provinceId
            .nullable()
            .optional()
            .describe(
              'Assertion for the capital derived from the exact victoryPoints payload; never writes a state capital field',
            ),
          manpower: z.number().min(0).optional(),
          category: z.string().min(1).optional(),
          resources: nonnegativeMap.optional(),
          stateBuildings: nonnegativeMap.optional(),
          owner: z.string().min(1).nullable().optional(),
          controller: z.string().min(1).nullable().optional(),
          cores: z.array(z.string().min(1)).max(10_000).optional(),
          claims: z.array(z.string().min(1)).max(10_000).optional(),
          victoryPoints: z
            .array(z.object({ provinceId, value: z.number().min(0) }).strict())
            .max(100_000)
            .optional(),
          provinceBuildings: z.record(z.string().regex(/^\d+$/u), nonnegativeMap).optional(),
        })
        .strict(),
    })
    .strict(),
  splitStateOperation('split_state'),
  splitStateOperation('create_state'),
  z
    .object({
      ...operationBase,
      kind: z.literal('merge_states'),
      sourceStateIds: z.array(stateId).min(1).max(100_000),
      targetStateId: stateId,
      distribution: mergeStateDistributionSchema,
    })
    .strict(),
  splitProvinceOperation('split_province'),
  splitProvinceOperation('create_province'),
  z
    .object({
      ...operationBase,
      kind: z.literal('merge_provinces'),
      sourceProvinceIds: z.array(provinceId).min(1).max(100_000),
      targetProvinceId: provinceId,
      distribution: mergeProvinceDistributionSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('remove_province'),
      provinceId,
      mergeIntoProvinceId: provinceId,
      distribution: mergeProvinceDistributionSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('update_province_definition'),
      provinceId,
      changes: provinceDefinitionInputSchema,
      distribution: provinceTypeDistributionSchema
        .optional()
        .describe('Required complete dependency policy when changes.type crosses land/sea/lake'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('move_region_provinces'),
      sourceRegionId: z.number().int().positive(),
      targetRegionId: z.number().int().positive(),
      provinceIds: z.array(provinceId).min(1).max(100_000),
      distribution: z.literal('move-membership'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('add_adjacency'),
      adjacency: z
        .object({
          from: provinceId,
          to: provinceId,
          type: z.string(),
          through: z.number().int(),
          startX: z.number(),
          startY: z.number(),
          stopX: z.number(),
          stopY: z.number(),
          rule: z.string(),
          comment: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('remove_adjacency'),
      from: provinceId,
      to: provinceId,
      type: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('add_supply_node'),
      level: z.number().int().min(1).max(5),
      provinceId,
    })
    .strict(),
  z.object({ ...operationBase, kind: z.literal('remove_supply_node'), provinceId }).strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('add_railway'),
      level: z.number().int().min(1).max(5),
      provinces: z.array(provinceId).min(2).max(100_000),
    })
    .strict(),
  z
    .object({ ...operationBase, kind: z.literal('remove_railway'), index: z.number().int().min(0) })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('upsert_building_position'),
      match: z
        .object({ stateId, building: z.string().min(1), occurrence: occurrenceSchema })
        .strict(),
      value: z
        .object({
          stateId,
          building: z.string().min(1),
          x: z.number(),
          y: z.number(),
          z: z.number(),
          rotation: z.number(),
          adjacentSeaProvince: z.number().int(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('remove_building_position'),
      match: z
        .object({ stateId, building: z.string().min(1), occurrence: occurrenceSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('upsert_unit_position'),
      match: z
        .object({ provinceId, type: z.number().int(), occurrence: occurrenceSchema })
        .strict(),
      value: z
        .object({
          provinceId,
          type: z.number().int(),
          x: z.number(),
          y: z.number(),
          z: z.number(),
          rotation: z.number(),
          offset: z.number(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('remove_unit_position'),
      match: z
        .object({ provinceId, type: z.number().int(), occurrence: occurrenceSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('upsert_weather_position'),
      match: z
        .object({
          strategicRegionId: z.number().int().positive(),
          size: z.string(),
          occurrence: occurrenceSchema,
        })
        .strict(),
      value: z
        .object({
          strategicRegionId: z.number().int().positive(),
          x: z.number(),
          y: z.number(),
          z: z.number(),
          size: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('remove_weather_position'),
      match: z
        .object({
          strategicRegionId: z.number().int().positive(),
          size: z.string(),
          occurrence: occurrenceSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('update_entity_locator'),
      entity: z.string().min(1),
      name: z.string().min(1),
      position: z.tuple([z.number(), z.number(), z.number()]),
    })
    .strict(),
]);

export const mapAllocationRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), requestedId: stateId.optional() }).strict(),
  z
    .object({
      kind: z.literal('province'),
      requestedId: provinceId.optional(),
      requestedColor: rgbSchema.optional(),
    })
    .strict(),
]);
