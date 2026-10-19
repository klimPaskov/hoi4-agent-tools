import { z } from 'zod/v4';
import { workspaceRelativePathSchema } from './common.js';

/**
 * Geography model, version 1: a typed feature list that describes a world before any pixel exists.
 * Coordinates are normalised to the whole world frame, origin top-left, x east, y south, exactly
 * like `reference.labels`. Lengths (radii, widths) are fractions of the map width, so a circle stays
 * a circle at every aspect ratio. Heights are 0 to 1 of the relief scale. Every array is optional.
 */

export const GEOGRAPHY_VERSION = 1;
/** A model file or inline model larger than this is refused before parsing. */
export const GEOGRAPHY_SOURCE_MAX_BYTES = 4_194_304;
export const GEOGRAPHY_MAX_FEATURES = 4_000;
export const GEOGRAPHY_MAX_POINTS = 200_000;
export const GEOGRAPHY_MAX_RING_VERTICES = 2_000;
export const GEOGRAPHY_MAX_PATH_VERTICES = 2_000;

// eslint-disable-next-line no-control-regex -- portable JSON Schema pattern rejects grammar-breaking controls.
const namePattern = /^[^\u0000-\u001f\u007f]+$/u;
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(namePattern, 'Names must not contain control characters');
const tagSchema = z.string().min(1).max(48);
const unit = z.number().min(0).max(1);
const positiveFraction = (max: number) => z.number().gt(0).max(max);

/** Feature identifiers are unique across the whole model, so a reference needs no kind prefix. */
export const geographyFeatureIdSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u,
    'Feature ids start with a letter and use letters, digits, underscore, dot or hyphen (at most 64 characters)',
  );

const pointObject = z.object({ x: unit, y: unit }).strict();
/** A point is `{x, y}` or the compact pair `[x, y]`. */
export const geographyPointSchema = z.union([pointObject, z.tuple([unit, unit])]);
const pathPointObject = z
  .object({
    x: unit,
    y: unit,
    halfWidth: positiveFraction(0.25).optional(),
    peak: unit.optional(),
  })
  .strict();
/** A path vertex may override the range half-width and crest height at that vertex. */
export const geographyPathPointSchema = z.union([pathPointObject, z.tuple([unit, unit])]);

export const geographyRingSchema = z
  .array(geographyPointSchema)
  .min(3)
  .max(GEOGRAPHY_MAX_RING_VERTICES);
/** Outer rings (`polygons`) and cut-outs (`holes`); a hole lies inside exactly one polygon. */
const areaFields = {
  polygons: z.array(geographyRingSchema).min(1).max(64),
  holes: z.array(geographyRingSchema).max(64).optional(),
};

const featureBase = {
  id: geographyFeatureIdSchema,
  name: nameSchema.optional(),
  /** Free labels (for example `established` or `proposed`); sorted and de-duplicated. */
  tags: z.array(tagSchema).max(16).optional(),
  note: z.string().max(2_000).optional(),
};

export const geographyDepthClassSchema = z.enum(['shelf', 'open', 'abyss']);
export const geographyBiomeKindSchema = z.enum([
  'forest',
  'desert',
  'marsh',
  'ice',
  'plains',
  'farmland',
  'jungle',
  'steppe',
  'tundra',
  'hills',
]);
export const geographySiteKindSchema = z.enum([
  'capital',
  'city',
  'fortress',
  'port',
  'ruin',
  'temple',
  'mine',
  'landmark',
]);
export const geographyPlaceKindSchema = z.enum([
  'cape',
  'bay',
  'gulf',
  'peninsula',
  'reef',
  'landmark',
  'other',
]);

const seaSchema = z
  .object({
    ...featureBase,
    ...areaFields,
    depthClass: geographyDepthClassSchema.optional(),
    ice: unit.optional(),
    kind: z.enum(['ocean', 'sea', 'gulf', 'fjord']).optional(),
  })
  .strict();

const landSchema = z
  .object({
    ...featureBase,
    ...areaFields,
    kind: z.enum(['continent', 'island', 'archipelago', 'peninsula']).optional(),
    region: geographyFeatureIdSchema.optional(),
    biome: geographyBiomeKindSchema.optional(),
    fertility: unit.optional(),
    elevationBase: unit.optional(),
    coastDetail: unit.optional(),
  })
  .strict();

/** Target share of each terrain inside a region, 0 to 1 (they need not sum to exactly 1). */
const terrainSharesSchema = z
  .object({
    plains: unit.optional(),
    forest: unit.optional(),
    hills: unit.optional(),
    mountain: unit.optional(),
    desert: unit.optional(),
    marsh: unit.optional(),
    jungle: unit.optional(),
    urban: unit.optional(),
    snow: unit.optional(),
  })
  .strict();

const provincesPerStateBound = z.number().int().min(1).max(64);
const regionSchema = z
  .object({
    ...featureBase,
    polygons: areaFields.polygons.optional(),
    holes: areaFields.holes,
    terrain: terrainSharesSchema.optional(),
    /** Typical states (`[smallest, usual, largest]` provinces) and province size in pixels. */
    density: z
      .object({
        provincesPerState: z
          .tuple([provincesPerStateBound, provincesPerStateBound, provincesPerStateBound])
          .optional(),
        provinceAreaPx: z.number().int().min(20).max(50_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const rangeSchema = z
  .object({
    ...featureBase,
    path: z.array(geographyPathPointSchema).min(2).max(GEOGRAPHY_MAX_PATH_VERTICES),
    closed: z.boolean().optional(),
    halfWidth: positiveFraction(0.25).optional(),
    peak: unit.optional(),
    profile: z.enum(['ridge', 'massif', 'escarpment', 'wall']).optional(),
    asymmetry: z.number().min(-1).max(1).optional(),
    snowline: unit.optional(),
    spurs: unit.optional(),
    barrier: z.enum(['none', 'impassable', 'fort-line']).optional(),
  })
  .strict();

/**
 * A gap in a range. Give `range` and `at` (0 to 1 along the range by arc length), or give a
 * `position` point and let the tool find the range (the named `range`, else the nearest one) and
 * the position along it.
 */
const passSchema = z
  .object({
    ...featureBase,
    range: geographyFeatureIdSchema.optional(),
    at: unit.optional(),
    position: geographyPointSchema.optional(),
    width: positiveFraction(0.1).optional(),
    depth: unit.optional(),
    fort: z.number().int().min(0).max(5).optional(),
  })
  .strict();

const volcanoSchema = z
  .object({
    ...featureBase,
    at: geographyPointSchema,
    radius: positiveFraction(0.25).optional(),
    peak: unit.optional(),
    crater: positiveFraction(0.25).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const plateauSchema = z
  .object({
    ...featureBase,
    ...areaFields,
    /** Absolute relief inside the plateau; a value below the surroundings makes a basin or chasm. */
    height: unit,
    edge: z.enum(['cliff', 'ramp']).optional(),
  })
  .strict();

/** A river end is a point, a lake (`{lake}`), a sea (`{sea}`, mouths only) or a river (`{river}`, mouths only). */
const riverSourceSchema = z.union([
  geographyPointSchema,
  z.object({ lake: geographyFeatureIdSchema }).strict(),
]);
const riverMouthSchema = z.union([
  geographyPointSchema,
  z.object({ sea: geographyFeatureIdSchema }).strict(),
  z.object({ lake: geographyFeatureIdSchema }).strict(),
  z.object({ river: geographyFeatureIdSchema }).strict(),
]);
const riverSchema = z
  .object({
    ...featureBase,
    source: riverSourceSchema,
    mouth: riverMouthSchema,
    via: z.array(geographyPointSchema).max(512).optional(),
    size: z.number().int().min(1).max(5).optional(),
    delta: z.boolean().optional(),
  })
  .strict();

const lakeSchema = z
  .object({
    ...featureBase,
    polygons: areaFields.polygons.optional(),
    holes: areaFields.holes,
    center: geographyPointSchema.optional(),
    radius: positiveFraction(0.25).optional(),
    depthClass: geographyDepthClassSchema.optional(),
    outflow: geographyFeatureIdSchema.optional(),
    gameplay: z.enum(['lake', 'inland-sea']).optional(),
  })
  .strict();

const biomeSchema = z
  .object({
    ...featureBase,
    ...areaFields,
    kind: geographyBiomeKindSchema,
    density: unit.optional(),
    fertility: unit.optional(),
    /** Overlap priority: higher wins, and two different kinds may only overlap at different values. */
    z: z.number().int().min(-1_000).max(1_000).optional(),
  })
  .strict();

const strait = z.union([
  geographyPointSchema,
  z.object({ land: geographyFeatureIdSchema }).strict(),
]);
/**
 * A channel between two lands. Give `between` (two points on land, or land ids), a `path` through
 * the water, or both; with only a path the lands nearest its two ends are used.
 */
const straitSchema = z
  .object({
    ...featureBase,
    between: z.tuple([strait, strait]).optional(),
    path: z.array(geographyPointSchema).min(2).max(64).optional(),
    rule: z.enum(['open', 'army-closed', 'navy-closed']).optional(),
    width: positiveFraction(0.1).optional(),
  })
  .strict();

const siteSchema = z
  .object({
    ...featureBase,
    kind: geographySiteKindSchema,
    at: geographyPointSchema,
    importance: z.number().int().min(1).max(5).optional(),
    country: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{2}$/u)
      .optional(),
    /** The site stands in water (a landing, a shrine on a reef) and need not be on land. */
    onWater: z.boolean().optional(),
    /** A lake the site belongs to, for a port on a lake shore. */
    lake: geographyFeatureIdSchema.optional(),
  })
  .strict();

const roadSchema = z
  .object({
    ...featureBase,
    path: z.array(geographyPointSchema).min(2).max(GEOGRAPHY_MAX_PATH_VERTICES),
    importance: z.number().int().min(1).max(3).optional(),
  })
  .strict();

/** A named point of any surface (cape, bay, gulf, reef, landmark) that gives later stages a name to use. */
const placeSchema = z
  .object({
    ...featureBase,
    kind: geographyPlaceKindSchema,
    at: geographyPointSchema,
  })
  .strict();

const climateSchema = z
  .object({
    /** Compass bearing the prevailing wind blows from: 0 north, 90 east, 180 south, 270 west. */
    windFrom: z.number().min(0).lt(360).optional(),
    /** Mean annual temperature in degrees Celsius at the warmest and coldest latitude bands. */
    temperature: z
      .object({ warm: z.number().min(-60).max(60), cold: z.number().min(-90).max(40) })
      .strict()
      .optional(),
    /** y of the warmest latitude band, 0 north to 1 south. */
    warmBandY: unit.optional(),
    rainScale: z.number().min(0.1).max(4).optional(),
    seasonality: unit.optional(),
  })
  .strict();

export const geographyModelSchema = z
  .object({
    version: z.literal(GEOGRAPHY_VERSION),
    name: nameSchema.optional(),
    description: z.string().max(2_000).optional(),
    seas: z.array(seaSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    lands: z.array(landSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    regions: z.array(regionSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    ranges: z.array(rangeSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    passes: z.array(passSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    volcanoes: z.array(volcanoSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    plateaus: z.array(plateauSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    rivers: z.array(riverSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    lakes: z.array(lakeSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    biomes: z.array(biomeSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    straits: z.array(straitSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    sites: z.array(siteSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    roads: z.array(roadSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    places: z.array(placeSchema).max(GEOGRAPHY_MAX_FEATURES).optional(),
    climate: climateSchema.optional(),
  })
  .strict()
  .describe(
    'Geography model version 1. Normalized 0..1 coordinates over the whole world frame, origin top-left; lengths are fractions of the map width.',
  );

/** A workspace-relative `.json` file holding a geography model. */
export const geographyPathSchema = workspaceRelativePathSchema.refine(
  (value) => !value.includes(':') && /\.json$/iu.test(value),
  'Geography must be a workspace-relative .json file',
);

export type GeographyModelInput = z.infer<typeof geographyModelSchema>;
export type GeographyPointInput = z.infer<typeof geographyPointSchema>;
export type GeographyPathPointInput = z.infer<typeof geographyPathPointSchema>;
export type GeographyDepthClass = z.infer<typeof geographyDepthClassSchema>;
export type GeographyBiomeKind = z.infer<typeof geographyBiomeKindSchema>;
export type GeographySiteKind = z.infer<typeof geographySiteKindSchema>;
export type GeographyPlaceKind = z.infer<typeof geographyPlaceKindSchema>;
