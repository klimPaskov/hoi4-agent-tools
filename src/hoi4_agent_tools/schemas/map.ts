import { z } from 'zod/v4';
import { renderDimensionViolation, RENDER_MAX_DIMENSION } from '../core/render-budget.js';
import { MAP_MASK_CELL_LIMIT, MAP_SELECTED_PIXEL_LIMIT } from '../map/limits.js';
import { workspaceRelativePathSchema } from './common.js';
import { geographyModelSchema, geographyPathSchema } from './geography.js';
import { referenceSheetsDocumentSchema, referenceSheetsPathSchema } from './reference-sheets.js';

const identifier = z.string().min(1).max(256);
// eslint-disable-next-line no-control-regex -- portable JSON Schema pattern rejects grammar-breaking controls.
const worldNamePattern = /^[^\u0000-\u001f\u007f]+$/u;
const worldName = z
  .string()
  .min(1)
  .max(64)
  .regex(worldNamePattern, 'World names must not contain control characters');
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
const countryTagSchema = z.string().regex(/^[A-Z][A-Z0-9]{2}$/u);
const realmPolygonSchema = z.array(pointSchema).min(3).max(10_000);
const realmPolygonsSchema = z.array(realmPolygonSchema).min(1).max(64);
export const workspaceRealmSchema = z
  .object({
    tag: countryTagSchema,
    capital: pointSchema.describe(
      'World pixel, top-left origin, on land; the capital province. Capitals and seeds of different realms must be at least 10 pixels apart; each gets a province of its own.',
    ),
    seeds: z
      .array(pointSchema)
      .max(256)
      .optional()
      .describe('Further world pixels whose provinces the country must own.'),
    claim: realmPolygonsSchema
      .optional()
      .describe(
        'Polygons in world pixels; land provinces more than half inside belong to the country.',
      ),
    exclude: realmPolygonsSchema
      .optional()
      .describe(
        'Polygons in world pixels; land provinces more than half inside never belong to it.',
      ),
    weight: z
      .number()
      .min(0.05)
      .max(100)
      .optional()
      .describe('Relative share of the land claims leave free; default 1.'),
  })
  .strict();
export const workspaceCountriesSchema = z
  .object({
    source: z.literal('workspace'),
    realms: z.array(workspaceRealmSchema).min(1).max(512),
    unowned: z
      .array(realmPolygonSchema)
      .max(256)
      .optional()
      .describe('Polygons in world pixels whose land provinces no country owns.'),
    islands: z
      .enum(['nearest', 'one-owner', 'unowned'])
      .default('nearest')
      .describe(
        'Landmasses no country reaches: every province to the nearest capital, the whole landmass to one country, or unowned.',
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, realm] of value.realms.entries()) {
      if (seen.has(realm.tag))
        context.addIssue({
          code: 'custom',
          path: ['realms', index, 'tag'],
          message: `Country ${realm.tag} is listed twice`,
        });
      seen.add(realm.tag);
    }
  });
export type WorkspaceCountriesInput = z.input<typeof workspaceCountriesSchema>;

const operationBase = {
  id: identifier,
  summary: z.string().max(1000).optional(),
};

const referencePointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
const referenceKindSchema = z.enum([
  'sea',
  'land',
  'plains',
  'forest',
  'desert',
  'mountain',
  'snow',
  'lake',
  'volcano',
  'hills',
  'marsh',
  'jungle',
]);
const referencePolygonSchema = z.array(referencePointSchema).min(3).max(1_000);
const referenceImagePathSchema = workspaceRelativePathSchema.refine(
  (value) => !value.includes(':') && /\.(?:png|jpe?g|webp)$/iu.test(value),
  'Reference must be a workspace-relative PNG, JPEG or WebP file',
);

/** Optional controls refine automatic interpretation; a single imagePath is sufficient. */
export const worldReferenceSchema = z
  .object({
    imagePath: referenceImagePathSchema,
    politicalImagePath: referenceImagePathSchema.optional(),
    terrainImagePath: referenceImagePathSchema.optional(),
    heightImagePath: referenceImagePathSchema.optional(),
    mode: z
      .enum(['auto', 'illustrated', 'satellite', 'sketch', 'political', 'grayscale'])
      .optional(),
    crop: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().positive().max(65_536),
        height: z.number().int().positive().max(65_536),
      })
      .strict()
      .optional(),
    ignoreMasks: z.array(referencePolygonSchema).max(64).optional(),
    annotations: z
      .array(z.object({ kind: referenceKindSchema, polygon: referencePolygonSchema }).strict())
      .max(128)
      .optional(),
    riverAnnotations: z.array(z.array(referencePointSchema).min(2).max(1_000)).max(128).optional(),
    palette: z
      .array(z.object({ kind: referenceKindSchema, color: rgbSchema }).strict())
      .max(64)
      .optional(),
    coastDetail: z.number().min(0).max(1).optional(),
    paletteMatch: z
      .enum(['nearest', 'exact'])
      .optional()
      .describe(
        'nearest (default) snaps every pixel to the closest palette colour. exact requires every pixel to equal a palette colour, trusts the classes as painted (no text masking, cleanup, smoothing or political inference) and fails with MAP_REFERENCE_PALETTE_UNKNOWN_COLOR naming any other colour, its count and source pixels.',
      ),
    sheets: referenceSheetsDocumentSchema
      .optional()
      .describe(
        'Registration of a picture made of drawn sheets onto the world frame (inline; use sheetsPath for a file). Each sheet maps its part of the picture with anchor, target and scale (or affine); the registered picture is read at the resolution the sheets need and every layer derives from it. Implies fit frame; width and height are required. Annotations, masks, labels and cities then use world coordinates.',
      ),
    agreement: z
      .object({
        minLandIou: z.number().min(0).max(1).optional(),
        warnLandIou: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional()
      .describe(
        'With a geography model: land intersection over union between the model and this reference below minLandIou (default 0.85) blocks the write with MAP_IMPORT_SOURCES_DISAGREE; below warnLandIou (default 0.95) it is a warning. The measured value is always in map-import-report.json.',
      ),
    sheetsPath: referenceSheetsPathSchema
      .optional()
      .describe(
        'Workspace-relative .json file holding the sheet registration (reference-sheets version 1).',
      ),
    fit: z
      .enum(['contain', 'frame'])
      .optional()
      .describe(
        'contain (default) centres the picture with sea padding at a working size of at most 3,072 pixels per side. frame maps the picture (or its crop) onto exactly width x height, which must be given and have the same shape within 1%, and reads it at the frame resolution.',
      ),
    labels: z
      .array(
        z
          .object({
            name: worldName,
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            kind: z.enum(['state', 'country', 'city', 'sea', 'region', 'mountain', 'geography']),
          })
          .strict(),
      )
      .max(2_048)
      .optional(),
    cities: z
      .array(
        z
          .object({
            name: worldName,
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            countryTag: z
              .string()
              .regex(/^[A-Z][A-Z0-9]{2}$/u)
              .optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict()
  .refine((value) => value.paletteMatch !== 'exact' || (value.palette?.length ?? 0) > 0, {
    path: ['palette'],
    message: 'paletteMatch "exact" needs a palette that lists every colour of the picture',
  })
  .refine((value) => value.sheets === undefined || value.sheetsPath === undefined, {
    path: ['sheetsPath'],
    message: 'Give the sheets inline (sheets) or by file (sheetsPath), not both',
  })
  .refine(
    (value) =>
      (value.sheets === undefined && value.sheetsPath === undefined) || value.fit !== 'contain',
    { path: ['fit'], message: 'Registered sheets always fill the frame; omit fit or use "frame"' },
  )
  .describe(
    'Generate from one local reference image. Optional controls use normalized 0..1 source coordinates; crop uses source pixels. Labels and political semantics may need refinement.',
  );
export type WorldReferenceInput = z.infer<typeof worldReferenceSchema>;

/** World edge and seam policy (ADR 0061). Omit `edge` to keep land and sea as drawn. */
export const worldEdgeSchema = z
  .object({
    mode: z
      .enum(['sea-band', 'rim', 'none'])
      .optional()
      .describe(
        'sea-band (default when edge is given) clears land from the east and west edges and the poles to open sea; rim ends land at the seam in an impassable snow range with impassable adjacencies across the seam; none keeps the picture and warns about land cut by the wrapping seam.',
      ),
    bandPx: z
      .number()
      .int()
      .min(8)
      .max(2_048)
      .optional()
      .describe(
        'East and west sea band in pixels; default max(192, 4% of the width), at most a quarter of the width.',
      ),
    polarPx: z
      .number()
      .int()
      .min(0)
      .max(1_024)
      .optional()
      .describe('North and south sea band in pixels; default 64, at most a quarter of the height.'),
    rimPx: z
      .number()
      .int()
      .min(16)
      .max(2_048)
      .optional()
      .describe(
        'Rim range width in pixels for mode rim; default 160, at most a quarter of the width.',
      ),
  })
  .strict();
export type WorldEdgeInput = z.infer<typeof worldEdgeSchema>;

/** Relief synthesis from a geography model (ADR 0056). */
export const worldReliefSchema = z
  .object({
    scale: z
      .enum(['vanilla', 'low', 'dramatic'])
      .optional()
      .describe(
        'Height of everything above the lowland: vanilla (the default) follows the base game, low is 25% lower, dramatic 15% higher.',
      ),
    detail: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Full-resolution roughness of the terrain, 0 to 1; default 0.5.'),
  })
  .strict();
export type WorldReliefInput = z.infer<typeof worldReliefSchema>;

/** River network target for a geography world: a share of the land pixels. */
export const worldRiverDensitySchema = z
  .object({
    density: z
      .number()
      .min(0)
      .max(0.04)
      .describe(
        'Share of land pixels the unnamed river network covers, 0 to 0.04; the named rivers come on top. Default 0.02 (the base game has 0.023).',
      ),
  })
  .strict();

export const worldLookSchema = z
  .enum(['vanilla-temperate', 'fertile', 'arid', 'custom'])
  .describe(
    'Colour palette set for the calibrated land colour map: the base game, a greener fertile palette, a drier arid palette, or custom with colormap.palette. Setting it selects the calibrated colour map.',
  );

export type WorldLookInput = z.infer<typeof worldLookSchema>;

const colourClassNames = [
  'plains',
  'farmland',
  'forest',
  'hills',
  'desert',
  'mountain',
  'marsh',
  'jungle',
  'snow',
  'urban',
  'lakes',
  'ocean',
] as const;
export const worldColormapSchema = z
  .object({
    profile: z
      .enum(['calibrated', 'legacy'])
      .optional()
      .describe(
        'calibrated writes a dark, varied colour map calibrated to the base game; legacy keeps the original flat tints. Defaults to calibrated when look is set, otherwise legacy.',
      ),
    palette: z
      .object(
        Object.fromEntries(colourClassNames.map((name) => [name, rgbSchema.optional()])) as Record<
          (typeof colourClassNames)[number],
          z.ZodOptional<typeof rgbSchema>
        >,
      )
      .strict()
      .optional()
      .describe('Class colours for look custom: the intended colour map value of each class.'),
  })
  .strict();
export type WorldColormapInput = z.infer<typeof worldColormapSchema>;

/** Feature-aware provinces, states and strategic regions (ADR 0058). */
export const worldPartitionSchema = z
  .enum(['legacy', 'feature-aware'])
  .describe(
    'legacy (default) keeps the warped Voronoi provinces and breadth-first clusters, so a seed gives the same world as before; feature-aware cuts provinces along rivers, ridges, steep slopes and shores, sizes them by terrain, fertility and coast, and clusters states and regions along natural lines. A world given a geography defaults to feature-aware.',
  );
export type WorldPartitionInput = z.infer<typeof worldPartitionSchema>;

/** Development model of a world built from a geography (ADR 0063). */
export const worldDevelopmentSchema = z
  .object({
    model: z
      .enum(['geography', 'legacy'])
      .optional()
      .describe(
        'geography (default for a geography world) plans ports, population, state categories, infrastructure, factories, resources, victory points, names and railway costs from the model: fertility, rivers, the coast, passes, ranges and sites. legacy keeps the random economy.',
      ),
  })
  .strict();
export type WorldDevelopmentInput = z.infer<typeof worldDevelopmentSchema>;

/** Automatic detection of narrow sea channels between landmasses (ADR 0062). */
export const worldAutoStraitsSchema = z
  .union([
    z.boolean(),
    z
      .object({
        maxGapPx: z
          .number()
          .int()
          .min(4)
          .max(96)
          .optional()
          .describe('Widest channel written as a crossing, in pixels; default 24 (about 170 km).'),
      })
      .strict(),
  ])
  .describe(
    'Also write a sea crossing for every channel narrower than maxGapPx that one sea province fills between two landmasses and that the model does not declare as a strait. Needs a geography.',
  );
export type WorldAutoStraitsInput = z.infer<typeof worldAutoStraitsSchema>;

const partitionAreaPixels = z.number().int().min(20).max(50_000);
export const worldPartitionTuningSchema = z
  .object({
    landArea: z
      .object({
        fertile: partitionAreaPixels.optional(),
        hills: partitionAreaPixels.optional(),
        mountain: partitionAreaPixels.optional(),
        waste: partitionAreaPixels.optional(),
      })
      .strict()
      .optional()
      .describe(
        'Typical land province area in pixels by ground. Defaults follow landProvincePixels (0.35, 1, 2.2 and 3.4 times, scaled so the mean stays landProvincePixels). fertile must not exceed hills, nor hills mountain.',
      ),
    seaArea: z
      .object({
        coastal: z.number().int().min(20).max(200_000).optional(),
        open: z.number().int().min(20).max(200_000).optional(),
      })
      .strict()
      .optional()
      .describe(
        'Sea province area in pixels near a coast and on the open sea. Defaults follow seaProvincePixels (0.5 and 2.4 times, scaled so the mean stays seaProvincePixels).',
      ),
    provincesPerState: z
      .tuple([z.number().int().min(1).max(64), z.number().int().min(1).max(64)])
      .optional()
      .describe(
        '[smallest, largest] land provinces per state; the preferred size is the geometric mean.',
      ),
    regionSize: z
      .tuple([z.number().int().min(1).max(400), z.number().int().min(1).max(400)])
      .optional()
      .describe('[smallest, largest] land provinces per strategic region.'),
    barrierStrength: z
      .number()
      .min(0)
      .max(60)
      .optional()
      .describe('How strongly borders are pulled onto natural lines, 0 to 60; default 20.'),
    minProvincePixels: z
      .number()
      .int()
      .min(20)
      .max(2_000)
      .optional()
      .describe('No province is planned smaller than this; default 40. The engine floor is 8.'),
    narrowStraitPx: z
      .number()
      .int()
      .min(4)
      .max(64)
      .optional()
      .describe('A sea channel at most this wide gets two sea provinces across it; default 24.'),
  })
  .strict();
export type WorldPartitionTuningInput = z.infer<typeof worldPartitionTuningSchema>;

const moveStateDistributionSchema = z
  .object({
    stateValues: z.enum(['retain-in-current-states', 'proportional-by-land-pixels']),
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
      kind: z.literal('rectangle'),
      origin: pointSchema,
      width: z.number().int().positive().max(RENDER_MAX_DIMENSION),
      height: z.number().int().positive().max(RENDER_MAX_DIMENSION),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.width * value.height > MAP_SELECTED_PIXEL_LIMIT)
        context.addIssue({
          code: 'custom',
          path: ['width'],
          message: `Rectangle selects more than ${MAP_SELECTED_PIXEL_LIMIT} pixels`,
        });
    }),
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

const splitStateOperation = (kind: 'split_state') =>
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
      remapReferences: z.enum(['refuse', 'override']).optional(),
    })
    .strict();
const createStateOperation = z
  .object({
    ...operationBase,
    kind: z.literal('create_state'),
    sourceStateId: stateId.optional(),
    stateId: stateId.optional(),
    provinceIds: z.array(provinceId).min(1).max(100_000),
    name: z.string().min(1).max(1000).optional(),
    displayName: z.string().min(1).max(100_000).optional(),
    fileName: z.string().max(255).optional(),
    localisation: stateLocalisationSchema.optional(),
    distribution: z.union([z.literal('proportional'), splitStateDistributionSchema]).optional(),
    remapReferences: z.enum(['refuse', 'override']).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.displayName !== undefined, {
    message: 'create_state requires name or displayName',
    path: ['displayName'],
  });
const splitProvinceOperation = (kind: 'split_province') =>
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
const createProvinceOperation = z
  .object({
    ...operationBase,
    kind: z.literal('create_province'),
    sourceProvinceId: provinceId,
    provinceId: provinceId.optional(),
    geometry: provinceGeometrySchema,
    definition: provinceDefinitionSchema.optional(),
    distribution: z
      .union([z.literal('inherit-source'), splitProvinceDistributionSchema])
      .optional(),
  })
  .strict();
const occurrenceSchema = z.number().int().min(0).optional();

const stateChangesSchema = z
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
  .strict();

const tagSchema = z
  .string()
  .regex(/^[A-Z0-9]{3}$/u, 'A country tag is three capital letters or digits');
const territoryRefSchema = z.union([
  z.object({ state: stateId }).strict(),
  z.object({ province: provinceId }).strict(),
  z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict(),
]);
const territorySelectionSchema = z
  .object({
    stateIds: z.array(stateId).max(100_000).optional(),
    provinceIds: z.array(provinceId).max(100_000).optional(),
    regionIds: z.array(z.number().int().positive()).max(10_000).optional(),
  })
  .strict();
const borderQualityModeSchema = z
  .enum(['off', 'report', 'enforce'])
  .describe(
    'off skips the measurement; report adds border naturalness to the result; enforce blocks the write when the borders miss the targets.',
  );
const borderTargetsSchema = z
  .object({
    minEnrichment: z.number().min(0).max(20).optional(),
    maxStraightness: z.number().min(0).max(1).optional(),
    minNaturalShare: z.number().min(0).max(1).optional(),
  })
  .strict()
  .describe(
    'Override the targets (enrichment 1.6; straightness 0.12 for country borders and 0.25 for state borders).',
  );
const territoryCountrySchema = z
  .object({
    tag: tagSchema,
    weight: z
      .number()
      .positive()
      .max(1_000_000)
      .optional()
      .describe('Relative target size; default 1.'),
    seeds: z
      .array(territoryRefSchema)
      .min(1)
      .max(64)
      .describe('{ state }, { province } or a pixel { x, y }. The first is the capital.'),
    forced: territorySelectionSchema.optional(),
    blocked: territorySelectionSchema.optional(),
    regions: z
      .array(z.number().int().positive())
      .max(1_000)
      .optional()
      .describe('Strategic regions this country prefers to grow in.'),
    overlord: tagSchema.optional().describe('Grow this country inside its overlord.'),
    mergeInto: tagSchema
      .optional()
      .describe(
        'Relabel the finished territory to another listed country (this tag stays a core).',
      ),
    cores: territorySelectionSchema.optional(),
    claims: territorySelectionSchema.optional(),
  })
  .strict();
const territoryOperation = z
  .object({
    ...operationBase,
    kind: z.literal('assign_territory'),
    unit: z
      .enum(['state', 'province'])
      .default('state')
      .describe(
        'state assigns whole states. province assigns provinces and regroups the states a border cuts (conserving population, resources and buildings).',
      ),
    countries: z.array(territoryCountrySchema).min(1).max(512),
    scope: z
      .object({
        stateIds: z.array(stateId).max(100_000).optional(),
        regionIds: z.array(z.number().int().positive()).max(10_000).optional(),
        owners: z.array(z.string().min(1).max(32)).max(1_000).optional(),
      })
      .strict()
      .optional()
      .describe('Only these states take part; the rest keep their owners.'),
    unowned: territorySelectionSchema.optional(),
    barriers: z
      .enum(['natural', 'none'])
      .default('natural')
      .describe('none ignores rivers, ranges and shores (nearest seed).'),
    rules: z
      .object({
        connectedMainland: z.boolean().default(true),
        islandPolicy: z.enum(['one-owner', 'nearest', 'unowned']).default('one-owner'),
      })
      .strict()
      .optional(),
    smoothing: z
      .object({
        passes: z.number().int().min(0).max(20).default(4),
        maxShareChange: z.number().min(0).max(1).default(0.15),
      })
      .strict()
      .optional(),
    shareTolerance: z.number().min(0.01).max(1).default(0.15),
    seed: z.number().int().min(0).max(2_147_483_647).default(0),
    ownership: z
      .object({
        controller: z.enum(['owner', 'keep']).default('owner'),
        cores: z.enum(['keep', 'owner', 'add-owner']).default('keep'),
        claims: z.enum(['keep', 'clear']).default('keep'),
        unowned: z.enum(['clear', 'keep']).default('clear'),
      })
      .strict()
      .optional(),
    stateSize: z
      .object({
        min: z.number().int().min(1).max(1_000),
        max: z.number().int().min(1).max(10_000).optional(),
      })
      .strict()
      .optional()
      .describe('Province unit: fragments below min provinces join a neighbour of the same owner.'),
    remapReferences: z.enum(['refuse', 'override']).optional(),
    borderQuality: borderQualityModeSchema.default('report'),
    borderTargets: borderTargetsSchema.optional(),
  })
  .strict();
const repartitionOperation = z
  .object({
    ...operationBase,
    kind: z.literal('repartition_states'),
    countries: z.array(tagSchema).min(1).max(512).optional(),
    stateIds: z.array(stateId).max(100_000).optional(),
    provincesPerState: z
      .object({
        min: z.number().int().min(1).max(1_000).optional(),
        target: z.number().int().min(1).max(1_000).optional(),
        max: z.number().int().min(1).max(10_000).optional(),
      })
      .strict()
      .optional(),
    remapReferences: z.enum(['refuse', 'override']).optional(),
    borderQuality: borderQualityModeSchema.default('report'),
    borderTargets: borderTargetsSchema.optional(),
  })
  .strict();

export const mapOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...operationBase,
      kind: z.literal('move_state_provinces'),
      sourceStateId: stateId,
      targetStateId: stateId,
      provinceIds: z.array(provinceId).min(1).max(100_000),
      distribution: z.union([z.literal('proportional'), moveStateDistributionSchema]).optional(),
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
      changes: stateChangesSchema,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('update_states'),
      updates: z
        .array(z.object({ stateId, changes: stateChangesSchema }).strict())
        .min(1)
        .max(5_000)
        .describe(
          'One entry per state, each with the changes update_state takes. The whole list is one validated rewrite; a state may appear once.',
        ),
    })
    .strict(),
  territoryOperation,
  repartitionOperation,
  splitStateOperation('split_state'),
  createStateOperation,
  z
    .object({
      ...operationBase,
      kind: z.literal('merge_states'),
      sourceStateIds: z.array(stateId).min(1).max(100_000),
      targetStateId: stateId,
      // Every merge policy has one allowed value, so the whole object may be omitted.
      distribution: mergeStateDistributionSchema.default({
        stateValues: 'sum-into-target',
        ownership: 'retain-target',
        controller: 'retain-target',
        cores: 'union',
        claims: 'union',
        victoryPoints: 'follow-province',
        provinceBuildings: 'follow-province',
        ports: 'follow-province',
        supplyNodes: 'follow-province',
        railways: 'follow-province',
        positions: 'follow-province',
        strategicRegion: 'require-same',
      }),
      remapReferences: z.enum(['refuse', 'override']).optional(),
    })
    .strict(),
  splitProvinceOperation('split_province'),
  createProvinceOperation,
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
      kind: z.literal('create_world'),
      worldName: worldName.optional(),
      startingScenario: z
        .boolean()
        .optional()
        .describe(
          'Include basic starting units and stockpiles and replace old-world startup/AI geography. Defaults on for reference-image worlds.',
        ),
      id: identifier.default('world'),
      reference: worldReferenceSchema.optional(),
      geography: geographyModelSchema
        .optional()
        .describe(
          'Geography model version 1, inline: seas, lands, ranges, passes, volcanoes, plateaus, rivers, lakes, biomes, straits, sites and climate in normalized 0..1 world coordinates. Use geographyPath for models over a few hundred vertices. With preview:true it returns a model overlay and map-geography-report.json. Without preview the world is built from it: relief (ranges with passes, volcanoes, plateaus), rivers and lakes are synthesised; biomes, climate and fertility are not yet, and a model that declares them is blocked with MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE.',
        ),
      synthesisCheck: z
        .boolean()
        .optional()
        .describe(
          'With preview:true and a geography: run only the relief and river synthesis and report every river that cannot reach its mouth, with the divide that stops it, without writing or planning the map. Refused without preview or without a geography.',
        ),
      geographyPath: geographyPathSchema
        .optional()
        .describe(
          'Workspace-relative .json file holding a geography model (at most 4 MiB). Alternative to the inline geography field; give one of them.',
        ),
      width: z.number().int().min(256).max(8_192).multipleOf(256).optional(),
      height: z.number().int().min(256).max(4_096).multipleOf(256).optional(),
      seed: z.number().int().min(0).max(2_147_483_647).default(1),
      landCoverage: z.number().min(0.05).max(0.9).default(0.35),
      continents: z.number().int().min(1).max(12).default(3),
      landPolygons: z
        .array(z.array(pointSchema).min(3).max(10_000))
        .max(64)
        .optional()
        .describe('Land outlines in top-left pixel coordinates; omit for generated continents.'),
      landProvincePixels: z.number().int().min(60).max(50_000).default(400),
      seaProvincePixels: z.number().int().min(200).max(200_000).default(2_500),
      provincesPerState: z.number().int().min(1).max(64).optional(),
      landProvincesPerRegion: z.number().int().min(2).max(400).optional(),
      seaProvincesPerRegion: z.number().int().min(1).max(200).optional(),
      countries: z
        .union([
          z
            .array(
              z
                .object({
                  tag: countryTagSchema,
                  name: worldName,
                  adjective: worldName.optional(),
                  color: rgbSchema.optional(),
                  share: z.number().min(0.05).max(100).optional(),
                  ideology: z.enum(['democratic', 'communism', 'fascism', 'neutrality']).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(200),
          workspaceCountriesSchema,
        ])
        .optional()
        .describe(
          'Countries the world generates and writes (an array), or { source: "workspace", realms } for countries the workspace already declares: the world then places them from their capital, seeds, claims and exclusions and writes no country, flag, unit, country history, country name or bookmark file.',
        ),
      continentNames: z.array(worldName).max(12).optional(),
      startDate: z
        .string()
        .regex(/^\d{3,4}\.\d{1,2}\.\d{1,2}$/u)
        .default('1936.1.1'),
      rivers: z
        .union([z.number().int().min(0).max(500), worldRiverDensitySchema])
        .optional()
        .describe(
          'Without a geography: the number of generated rivers. With a geography: an integer limits the number of unnamed river systems, an object { density } sets the share of land the network covers; the rivers the model names are always routed.',
        ),
      relief: worldReliefSchema
        .optional()
        .describe(
          'Relief of a world built from a geography model: height scale and detail. Needs geography.',
        ),
      edge: worldEdgeSchema.optional(),
      ambientFrame: z
        .boolean()
        .optional()
        .describe(
          "Write the base map's north and south frame borders and logo frame into ambient_object.txt, placed for the world size. Off by default.",
        ),
      look: worldLookSchema.optional(),
      colormap: worldColormapSchema.optional(),
      partition: worldPartitionSchema.optional(),
      development: worldDevelopmentSchema.optional(),
      autoStraits: worldAutoStraitsSchema.optional(),
      partitionTuning: worldPartitionTuningSchema
        .optional()
        .describe(
          'Size bands and strengths of the feature-aware partition; refused with partition legacy.',
        ),
      borderQuality: borderQualityModeSchema
        .optional()
        .describe(
          'Measure how well the new world’s province, state, region and country borders follow rivers, slopes and shores. enforce blocks the write below the targets and needs the feature-aware partition; omitted measures nothing.',
        ),
      borderTargets: borderTargetsSchema.optional(),
      replaceBaseGame: z
        .boolean()
        .default(true)
        .describe(
          'Add replace_path for the base game states, countries, units, strategic regions, supply areas and bookmarks to descriptor.mod.',
        ),
    })
    .strict()
    .refine(
      (operation) => operation.geography === undefined || operation.geographyPath === undefined,
      {
        path: ['geographyPath'],
        message: 'Give the geography inline (geography) or by file (geographyPath), not both',
      },
    )
    .refine(
      (operation) =>
        (operation.reference?.fit !== 'frame' &&
          operation.reference?.sheets === undefined &&
          operation.reference?.sheetsPath === undefined) ||
        (operation.width !== undefined && operation.height !== undefined),
      {
        path: ['reference', 'fit'],
        message: 'reference.fit "frame" and registered sheets need explicit width and height',
      },
    ),
  z
    .object({
      ...operationBase,
      kind: z.literal('remap_map_references'),
      entity: z.enum(['province', 'state', 'strategic-region']),
      mapping: z
        .array(
          z
            .object({
              from: z.number().int().min(0),
              to: z
                .union([
                  z.number().int().min(0),
                  z.array(z.number().int().min(0)).min(1).max(16),
                  z.null(),
                ])
                .describe(
                  'One ID replaces; several IDs copy the referencing assignment once per ID; null removes it.',
                ),
            })
            .strict(),
        )
        .min(1)
        .max(1_000),
      readOnlySources: z
        .enum(['refuse', 'override'])
        .default('refuse')
        .describe('override copies game or dependency files that need the change into the mod.'),
      pathPrefixes: z.array(z.string().min(1).max(256)).max(32).optional(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('regenerate_map_positions'),
      positions: z
        .array(z.enum(['buildings', 'units', 'weather']))
        .min(1)
        .max(3)
        .default(['buildings', 'units', 'weather']),
      stateIds: z.array(stateId).max(10_000).optional(),
      provinceIds: z.array(provinceId).max(100_000).optional(),
      regionIds: z.array(z.number().int().positive()).max(10_000).optional(),
      mode: z
        .enum(['missing', 'replace'])
        .default('missing')
        .describe('missing adds only absent positions; replace rewrites them for the selection.'),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('rebuild_supply'),
      stateIds: z.array(stateId).max(10_000).optional(),
      mode: z
        .enum(['connect', 'replace'])
        .default('connect')
        .describe(
          'connect adds a supply node to each selected state without one and links unconnected nodes by railway; replace rebuilds the whole network.',
        ),
      railwayLevel: z.number().int().min(1).max(5).default(1),
      capitalRailwayLevel: z.number().int().min(1).max(5).default(3),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('renumber_map_entity'),
      entity: z.enum(['province', 'state', 'strategic-region']),
      fromId: z.number().int().min(0),
      toId: z.number().int().min(0),
      collision: z.enum(['swap', 'reject']).default('swap'),
      renameLocalisation: z.boolean().default(true),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.entity !== 'province' && (value.fromId === 0 || value.toId === 0)) {
        context.addIssue({
          code: 'custom',
          path: ['fromId'],
          message: 'State and strategic-region IDs must be positive',
        });
      }
    }),
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
