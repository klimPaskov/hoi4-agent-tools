import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Diagnostic } from '../core/diagnostics.js';
import { assertRenderDimensions } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import type { BmpImage } from './bmp.js';

/**
 * Border-naturalness metric (ADR 0059).
 *
 * A border is natural where it runs along something a person would draw a border along: a river,
 * a steep height gradient or ridge, a lake shore, or a change between obstacle terrain classes
 * (mountain, forest, jungle, marsh). The metric is computed on the land-to-land pixel edges
 * between two provinces, states, strategic regions or countries, in one streamed pass over the
 * province raster, and is deterministic: no random numbers, no clock in any result.
 *
 * Two entry points exist for other code. `measureBorderNaturalness` reports every requested layer
 * (alignment, enrichment over chance, the plain natural share, straightness, long straight runs
 * and the worst artificial runs). `buildBorderEdgeTable` plus `scoreBorderAssignment` let a
 * territory assignment try many candidate groupings of provinces without reading the raster again.
 */

/** Feature bits stored per border edge; an edge carries the union of its two pixels' bits. */
export const BORDER_FEATURE_BITS = {
  river: 1,
  slope: 2,
  lakeShore: 4,
  terrainChange: 8,
  extra: 16,
} as const;

export type BorderFeature = keyof typeof BORDER_FEATURE_BITS;
const BORDER_FEATURES = Object.keys(BORDER_FEATURE_BITS) as readonly BorderFeature[];
/** Barrier set: the plan's measurement (rivers, steep gradients) plus lake shores and extras. */
export const BORDER_BARRIER_MASK = 1 | 2 | 4 | 16;
const BARRIER_MASK = BORDER_BARRIER_MASK;
/** Natural set: the barrier set plus terrain-class changes. */
export const BORDER_NATURAL_MASK = 31;
const NATURAL_MASK = BORDER_NATURAL_MASK;

/** Province kinds used by the metric. Only land provinces have land borders. */
export const BORDER_PROVINCE_KIND = { unknown: 0, land: 1, sea: 2, lake: 3 } as const;

export type BorderLayerName = 'province' | 'state' | 'region' | 'country';

/** Targets for an engineered world: the design's thresholds, measured against vanilla. */
export const BORDER_QUALITY_TARGETS = {
  /** Enrichment over chance at least this (vanilla 1.35 to 1.46). */
  minEnrichment: 1.6,
  /** Locally straight sample fraction at most this (vanilla country borders 0.11). */
  maxStraightness: 0.12,
} as const;

export interface BorderTargets {
  minEnrichment?: number;
  maxStraightness?: number;
  /** Minimum plain natural share of border length, for example 0.85 for states, 0.7 for countries. */
  minNaturalShare?: number;
}

/**
 * Review targets per layer. Province borders are shorter than the straightness window, so almost
 * every sample is straight (vanilla 0.67) and no straightness target applies to them. State
 * borders are shorter than region and country borders and vanilla's are straighter (0.20).
 */
export const BORDER_LAYER_TARGETS: Readonly<Record<string, BorderTargets>> = {
  province: { minEnrichment: BORDER_QUALITY_TARGETS.minEnrichment },
  state: { minEnrichment: BORDER_QUALITY_TARGETS.minEnrichment, maxStraightness: 0.25 },
  region: BORDER_QUALITY_TARGETS,
  country: BORDER_QUALITY_TARGETS,
};

export function borderTargetsForLayer(layer: string): BorderTargets {
  return BORDER_LAYER_TARGETS[layer] ?? { minEnrichment: BORDER_QUALITY_TARGETS.minEnrichment };
}

export interface BorderQualityOptions {
  /** River pixels (index 0 to this value) count as rivers. Default 11, the engine's widths. */
  riverMaxIndex?: number;
  /** A land pixel within this Chebyshev distance of a river is on the river. Default 2. */
  riverRadius?: number;
  /** A central-difference height gradient of at least this per pixel is steep. Default 2. */
  slopeGradient?: number;
  /** Pixels within this distance of a steep pixel are on the slope. Default 1. */
  slopeRadius?: number;
  /** Land pixels within this distance of a lake are on its shore. Default 1. */
  lakeRadius?: number;
  /** Pixels within this distance of an obstacle-class change are on it. Default 1. */
  terrainRadius?: number;
  /** Pixels within this distance of an extra barrier pixel are on it. Default 1. */
  extraRadius?: number;
  /** Every Nth border edge is a straightness sample. Default 7. */
  sampleStride?: number;
  /** Straightness window radius in pixels. Default 24. */
  windowRadius?: number;
  /** A window whose line fit has a perpendicular RMS below this is straight. Default 0.9. */
  straightRmsPx?: number;
  /** Windows with fewer same-border edges are too short to judge and are skipped. Default 12. */
  minWindowEdges?: number;
  /** Douglas-Peucker tolerance for long runs. Default 3 pixels. */
  simplifyTolerance?: number;
  /** A simplified segment longer than this is a long straight run. Default 60 pixels. */
  longRunPx?: number;
  /** Number of worst artificial runs reported per layer. Default 20, at most 100. */
  worstRunLimit?: number;
  /** Shortest artificial run reported, in edges. Default 12. */
  minRunEdges?: number;
  /** A natural stretch of at most this many edges does not break an artificial run. Default 3. */
  naturalGapEdges?: number;
  /** Fewer border edges than this and the metric is "too short to judge". Default 24. */
  minBorderEdges?: number;
  /** A base rate below this makes enrichment "not meaningful". Default 0.02. */
  minBaseRate?: number;
  /** Refuse (rather than allocate more) when the land border edge table exceeds this. */
  maxEdges?: number;
  /** Also return the pixels of the reported runs so a renderer can draw them. */
  collectPaint?: boolean;
  signal?: AbortSignal;
}

type ResolvedOptions = Required<Omit<BorderQualityOptions, 'signal'>> & {
  signal: AbortSignal | undefined;
};

const DEFAULT_MAX_EDGES = 8_000_000;
const MAX_RUN_LIMIT = 100;
const MAX_LAYERS = 8;

function resolveOptions(options: BorderQualityOptions): ResolvedOptions {
  const resolved = {
    riverMaxIndex: options.riverMaxIndex ?? 11,
    riverRadius: options.riverRadius ?? 2,
    slopeGradient: options.slopeGradient ?? 2,
    slopeRadius: options.slopeRadius ?? 1,
    lakeRadius: options.lakeRadius ?? 1,
    terrainRadius: options.terrainRadius ?? 1,
    extraRadius: options.extraRadius ?? 1,
    sampleStride: options.sampleStride ?? 7,
    windowRadius: options.windowRadius ?? 24,
    straightRmsPx: options.straightRmsPx ?? 0.9,
    minWindowEdges: options.minWindowEdges ?? 12,
    simplifyTolerance: options.simplifyTolerance ?? 3,
    longRunPx: options.longRunPx ?? 60,
    worstRunLimit: options.worstRunLimit ?? 20,
    minRunEdges: options.minRunEdges ?? 12,
    naturalGapEdges: options.naturalGapEdges ?? 3,
    minBorderEdges: options.minBorderEdges ?? 24,
    minBaseRate: options.minBaseRate ?? 0.02,
    maxEdges: options.maxEdges ?? DEFAULT_MAX_EDGES,
    collectPaint: options.collectPaint ?? false,
    signal: options.signal,
  };
  const integers: [string, number, number, number][] = [
    ['riverMaxIndex', resolved.riverMaxIndex, 0, 255],
    ['riverRadius', resolved.riverRadius, 0, 8],
    ['slopeGradient', resolved.slopeGradient, 1, 255],
    ['slopeRadius', resolved.slopeRadius, 0, 8],
    ['lakeRadius', resolved.lakeRadius, 0, 8],
    ['terrainRadius', resolved.terrainRadius, 0, 8],
    ['extraRadius', resolved.extraRadius, 0, 8],
    ['sampleStride', resolved.sampleStride, 1, 1_000],
    ['windowRadius', resolved.windowRadius, 4, 256],
    ['minWindowEdges', resolved.minWindowEdges, 3, 10_000],
    ['longRunPx', resolved.longRunPx, 4, 100_000],
    ['worstRunLimit', resolved.worstRunLimit, 0, MAX_RUN_LIMIT],
    ['minRunEdges', resolved.minRunEdges, 1, 1_000_000],
    ['naturalGapEdges', resolved.naturalGapEdges, 0, 1_000],
    ['minBorderEdges', resolved.minBorderEdges, 1, 100_000_000],
    ['maxEdges', resolved.maxEdges, 1, 50_000_000],
  ];
  for (const [name, value, minimum, maximum] of integers)
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new ServiceError(
        'MAP_BORDER_QUALITY_OPTION_INVALID',
        `Border quality option ${name} must be an integer from ${minimum} to ${maximum}`,
        { option: name, value },
      );
  for (const [name, value] of [
    ['straightRmsPx', resolved.straightRmsPx],
    ['simplifyTolerance', resolved.simplifyTolerance],
    ['minBaseRate', resolved.minBaseRate],
  ] as const)
    if (!Number.isFinite(value) || value <= 0 || value > 1_000)
      throw new ServiceError(
        'MAP_BORDER_QUALITY_OPTION_INVALID',
        `Border quality option ${name} must be a positive finite number`,
        { option: name, value },
      );
  return resolved;
}

/** One 8-bit plane of the map size, read a row at a time so large maps are never copied. */
export interface BorderPlane {
  readonly width: number;
  readonly height: number;
  /** Copy row `y` (top-left origin) into `target`, which holds `width` bytes. */
  readRow(y: number, target: Uint8Array): void;
}

export function borderPlaneFromBytes(
  width: number,
  height: number,
  bytes: Uint8Array,
): BorderPlane {
  if (bytes.length !== width * height)
    throw new ServiceError(
      'MAP_BORDER_PLANE_INVALID',
      'Border quality plane byte length does not match its dimensions',
      { width, height, bytes: bytes.length },
    );
  return {
    width,
    height,
    readRow(y, target) {
      target.set(bytes.subarray(y * width, (y + 1) * width));
    },
  };
}

/** An 8-bit indexed BMP read in place; the palette index is the plane value. */
export function borderPlaneFromBmp(image: BmpImage): BorderPlane {
  if (image.bitsPerPixel !== 8)
    throw new ServiceError(
      'MAP_BORDER_PLANE_INVALID',
      'Border quality planes need an 8-bit indexed bitmap',
      { bitsPerPixel: image.bitsPerPixel },
    );
  return {
    width: image.width,
    height: image.height,
    readRow(y, target) {
      const stored = image.topDown ? y : image.height - 1 - y;
      const start = image.pixelOffset + stored * image.rowStride;
      target.set(image.bytes.subarray(start, start + image.width));
    },
  };
}

/** Terrain bitmap plus the class of each of its 256 indices. */
export interface BorderTerrainPlane {
  plane: BorderPlane;
  /** Class per bitmap index: 0 is open ground, 1 to 254 an obstacle class, 255 ignore (water). */
  classes: Uint8Array;
}

export interface BorderFeaturePlanes {
  heights?: BorderPlane;
  rivers?: BorderPlane;
  terrain?: BorderTerrainPlane;
  /** Any non-zero pixel is an extra barrier (for example a geography wall range). */
  extra?: BorderPlane;
}

/** A grouping of provinces whose borders are measured. */
export interface BorderLayerInput {
  name: string;
  /** Group label per province id (index = province id); negative excludes the province. */
  labels: Int32Array;
  /** Name shown for a label in reports, for example a country tag. Defaults to the number. */
  describe?: (label: number) => string;
}

export interface BorderQualityInput {
  width: number;
  height: number;
  /** Province id per pixel, row-major from the top left; negative where unknown. */
  provinceIds: Int32Array;
  /** Kind per province id, from `BORDER_PROVINCE_KIND`. */
  provinceKinds: Uint8Array;
  layers: readonly BorderLayerInput[];
  features?: BorderFeaturePlanes;
}

/** Every land-to-land pixel edge between two provinces, with the natural features it lies on. */
export interface BorderEdgeTable {
  readonly width: number;
  readonly height: number;
  readonly edgeCount: number;
  /** Edge key `pixelIndex * 2 + direction`, ascending (raster order). Direction 0 joins the pixel
   * to its east neighbour (wrapping at the seam), direction 1 to its south neighbour. */
  readonly keys: Int32Array;
  readonly provinceA: Int32Array;
  readonly provinceB: Int32Array;
  /** Union of both pixels' `BORDER_FEATURE_BITS`. */
  readonly features: Uint8Array;
  readonly provinceIds: Int32Array;
  readonly provinceKinds: Uint8Array;
  readonly landPixels: number;
  /** Land pixel pairs (horizontal and vertical neighbours), the chance baseline. */
  readonly landPairs: number;
  readonly barrierPairs: number;
  readonly naturalPairs: number;
  readonly pairsByFeature: Readonly<Record<BorderFeature, number>>;
  /** Land-to-water edges per province id (coast, excluded from land-border shares). */
  readonly coastEdgesByProvince: Uint32Array;
  readonly inputs: Readonly<Record<'heights' | 'rivers' | 'terrain' | 'extra', boolean>>;
  readonly options: Readonly<ResolvedOptions>;
}

export interface BorderRun {
  /** Names of the two groups on either side. */
  sides: [string, string];
  labels: [number, number];
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Length in pixel edges, including bridged short natural stretches. */
  edges: number;
  /** Straight-line distance between the ends, in pixels. */
  chord: number;
  /** Chord over length: 1 is dead straight. */
  straightRatio: number;
  /** Share of the run's edges that lie on a natural feature. */
  naturalShare: number;
}

export type BorderLayerStatus = 'ok' | 'not-meaningful' | 'too-short' | 'no-borders';

export interface BorderLayerReport {
  layer: string;
  status: BorderLayerStatus;
  groups: number;
  /** Land-to-land border length in pixel edges between different groups. */
  borderEdges: number;
  /** Edges next to a province with no group (for example wasteland without a state). */
  unlabelledEdges: number;
  /** Land-to-water edges of grouped land: the coast, not counted in any share below. */
  coastEdges: number;
  barrier: {
    alignedEdges: number;
    /** Aligned share of border length. */
    alignment: number | null;
    /** Share of all land pixel pairs on the same features: what chance would give. */
    baseRate: number;
    /** Alignment over base rate, or null when the base rate is too low to mean anything. */
    enrichment: number | null;
  };
  natural: {
    alignedEdges: number;
    /** Plain share of border length on any natural feature. */
    share: number | null;
    baseRate: number;
    enrichment: number | null;
    /** Share of border length on each feature (features can overlap). */
    byFeature: Record<BorderFeature, number | null>;
    /** The same share when the coast counts as a natural line. */
    shareWithCoast: number | null;
  };
  straightness: {
    samples: number;
    straight: number;
    skippedShortWindows: number;
    /** Locally straight fraction of samples. */
    fraction: number | null;
  };
  longRuns: {
    segments: number;
    edges: number;
    /** Share of border length in simplified segments longer than `longRunPx`. */
    share: number | null;
    /** The same, counting only segments that are mostly not on a natural feature. */
    artificialShare: number | null;
  };
  artificialRuns: { count: number; edges: number; longestEdges: number };
  worstRuns: BorderRun[];
}

export interface BorderQualityReport {
  schemaVersion: 1;
  width: number;
  height: number;
  landPixels: number;
  inputs: Readonly<Record<'heights' | 'rivers' | 'terrain' | 'extra', boolean>>;
  parameters: {
    riverRadius: number;
    slopeGradient: number;
    slopeRadius: number;
    sampleStride: number;
    windowRadius: number;
    straightRmsPx: number;
    simplifyTolerance: number;
    longRunPx: number;
  };
  /** Review targets applied to each reported layer. */
  targets: Record<string, BorderTargets>;
  layers: BorderLayerReport[];
}

/** Pixels of the reported runs, for the overlay: layer name to one key list per run. */
export type BorderRunPaint = ReadonlyMap<string, readonly Int32Array[]>;

export interface BorderQualityResult {
  report: BorderQualityReport;
  table: BorderEdgeTable;
  paint?: BorderRunPaint;
}

class Pace {
  #last = performance.now();
  constructor(private readonly signal: AbortSignal | undefined) {}
  async tick(): Promise<void> {
    this.signal?.throwIfAborted();
    if (performance.now() - this.#last < 12) return;
    await yieldToEventLoop();
    this.signal?.throwIfAborted();
    this.#last = performance.now();
  }
}

class RowRing {
  readonly #rows: Uint8Array[];
  readonly #tags: Int32Array;
  constructor(count: number, width: number) {
    this.#rows = Array.from({ length: count }, () => new Uint8Array(width));
    this.#tags = new Int32Array(count).fill(-(2 ** 30));
  }
  get(y: number, fill: (target: Uint8Array) => void): Uint8Array {
    const slot = mod(y, this.#rows.length);
    const row = this.#rows[slot]!;
    if (this.#tags[slot] !== y) {
      fill(row);
      this.#tags[slot] = y;
    }
    return row;
  }
}

/** Horizontal OR over [x - radius, x + radius] with wrap at the seam. */
function dilateRow(source: Uint8Array, target: Uint8Array, radius: number): void {
  const width = source.length;
  if (radius === 0) {
    target.set(source);
    return;
  }
  let count = 0;
  for (let k = -radius; k <= radius; k += 1) count += source[(k + width * 16) % width]!;
  for (let x = 0; x < width; x += 1) {
    target[x] = count > 0 ? 1 : 0;
    count += source[(x + radius + 1) % width]! - source[(x - radius + width * 16) % width]!;
  }
}

/**
 * Per-row feature flags computed on the fly from the source planes. Every feature keeps only the
 * few rows its radius needs, so memory is a handful of rows and never a second map-sized raster.
 */
class FeatureRows {
  readonly active: Record<BorderFeature, boolean>;
  readonly #width: number;
  readonly #height: number;
  readonly #input: BorderQualityInput;
  readonly #options: ResolvedOptions;
  readonly #heightRows: RowRing | undefined;
  readonly #terrainRows: RowRing | undefined;
  readonly #scratch: Uint8Array;
  readonly #baseRing: Record<BorderFeature, RowRing | undefined>;
  readonly #base: Uint8Array;
  readonly #radius: Record<BorderFeature, number>;

  constructor(input: BorderQualityInput, options: ResolvedOptions) {
    this.#input = input;
    this.#options = options;
    this.#width = input.width;
    this.#height = input.height;
    const planes = input.features ?? {};
    this.active = {
      river: planes.rivers !== undefined,
      slope: planes.heights !== undefined,
      lakeShore: input.provinceKinds.includes(BORDER_PROVINCE_KIND.lake),
      terrainChange: planes.terrain !== undefined,
      extra: planes.extra !== undefined,
    };
    this.#radius = {
      river: options.riverRadius,
      slope: options.slopeRadius,
      lakeShore: options.lakeRadius,
      terrainChange: options.terrainRadius,
      extra: options.extraRadius,
    };
    this.#scratch = new Uint8Array(input.width);
    this.#base = new Uint8Array(input.width);
    this.#heightRows = this.active.slope ? new RowRing(4, input.width) : undefined;
    this.#terrainRows = this.active.terrainChange ? new RowRing(4, input.width) : undefined;
    this.#baseRing = Object.fromEntries(
      BORDER_FEATURES.map((feature) => [
        feature,
        this.active[feature] ? new RowRing(2 * this.#radius[feature] + 3, input.width) : undefined,
      ]),
    ) as Record<BorderFeature, RowRing | undefined>;
  }

  #isLand(offset: number): boolean {
    const id = this.#input.provinceIds[offset]!;
    return id >= 0 && this.#input.provinceKinds[id] === BORDER_PROVINCE_KIND.land;
  }

  #rawHeights(y: number): Uint8Array {
    return this.#heightRows!.get(y, (target) => this.#input.features!.heights!.readRow(y, target));
  }

  #rawTerrain(y: number): Uint8Array {
    return this.#terrainRows!.get(y, (target) =>
      this.#input.features!.terrain!.plane.readRow(y, target),
    );
  }

  /** Dilated (horizontally only) feature indicator for row y; zeros outside the map. */
  #dilatedRow(feature: BorderFeature, y: number): Uint8Array {
    return this.#baseRing[feature]!.get(y, (target) => {
      if (y < 0 || y >= this.#height) {
        target.fill(0);
        return;
      }
      const width = this.#width;
      const base = this.#base;
      const planes = this.#input.features ?? {};
      const rowOffset = y * width;
      switch (feature) {
        case 'river': {
          planes.rivers!.readRow(y, this.#scratch);
          for (let x = 0; x < width; x += 1)
            base[x] = this.#scratch[x]! <= this.#options.riverMaxIndex ? 1 : 0;
          break;
        }
        case 'extra': {
          planes.extra!.readRow(y, this.#scratch);
          for (let x = 0; x < width; x += 1) base[x] = this.#scratch[x]! !== 0 ? 1 : 0;
          break;
        }
        case 'lakeShore': {
          const ids = this.#input.provinceIds;
          const kinds = this.#input.provinceKinds;
          for (let x = 0; x < width; x += 1) {
            const id = ids[rowOffset + x]!;
            base[x] = id >= 0 && kinds[id] === BORDER_PROVINCE_KIND.lake ? 1 : 0;
          }
          break;
        }
        case 'slope': {
          const here = this.#rawHeights(y);
          const above = y > 0 ? this.#rawHeights(y - 1) : here;
          const below = y < this.#height - 1 ? this.#rawHeights(y + 1) : here;
          // The central-difference gradient magnitude per pixel, compared as a square.
          const limit = (2 * this.#options.slopeGradient) ** 2;
          for (let x = 0; x < width; x += 1) {
            if (!this.#isLand(rowOffset + x)) {
              base[x] = 0;
              continue;
            }
            const left = x === 0 ? width - 1 : x - 1;
            const right = x === width - 1 ? 0 : x + 1;
            const dx = here[right]! - here[left]!;
            const dy = below[x]! - above[x]!;
            base[x] = dx * dx + dy * dy >= limit ? 1 : 0;
          }
          break;
        }
        case 'terrainChange': {
          const classes = this.#input.features!.terrain!.classes;
          const here = this.#rawTerrain(y);
          const above = y > 0 ? this.#rawTerrain(y - 1) : undefined;
          const below = y < this.#height - 1 ? this.#rawTerrain(y + 1) : undefined;
          const classOf = (row: Uint8Array, rowStart: number, x: number): number =>
            this.#isLand(rowStart + x) ? classes[row[x]!]! : 255;
          for (let x = 0; x < width; x += 1) {
            const own = classOf(here, rowOffset, x);
            if (own === 255) {
              base[x] = 0;
              continue;
            }
            const left = x === 0 ? width - 1 : x - 1;
            const right = x === width - 1 ? 0 : x + 1;
            let changed = false;
            for (const other of [
              classOf(here, rowOffset, left),
              classOf(here, rowOffset, right),
              above === undefined ? 255 : classOf(above, rowOffset - width, x),
              below === undefined ? 255 : classOf(below, rowOffset + width, x),
            ])
              if (other !== 255 && other !== own) changed = true;
            base[x] = changed ? 1 : 0;
          }
          break;
        }
      }
      dilateRow(base, target, this.#radius[feature]);
    });
  }

  /** Feature bits of row `y` (all zero outside the map). */
  rowFlags(y: number, out: Uint8Array): void {
    out.fill(0);
    if (y < 0 || y >= this.#height) return;
    const width = this.#width;
    for (const feature of BORDER_FEATURES) {
      if (!this.active[feature]) continue;
      const bit = BORDER_FEATURE_BITS[feature];
      const radius = this.#radius[feature];
      for (let dy = -radius; dy <= radius; dy += 1) {
        const row = this.#dilatedRow(feature, y + dy);
        for (let x = 0; x < width; x += 1) if (row[x]! !== 0) out[x] = out[x]! | bit;
      }
    }
  }
}

function validateInput(input: BorderQualityInput): void {
  assertRenderDimensions(input.width, input.height, 'border quality raster', {
    maximumPixels: 13_238_272,
  });
  if (input.provinceIds.length !== input.width * input.height)
    throw new ServiceError(
      'MAP_BORDER_QUALITY_INPUT_INVALID',
      'Border quality province raster does not match its dimensions',
      { width: input.width, height: input.height, length: input.provinceIds.length },
    );
  if (input.layers.length > MAX_LAYERS)
    throw new ServiceError('MAP_BORDER_QUALITY_INPUT_INVALID', 'Too many border layers', {
      layers: input.layers.length,
      maximum: MAX_LAYERS,
    });
  const names = new Set<string>();
  for (const layer of input.layers) {
    if (names.has(layer.name))
      throw new ServiceError(
        'MAP_BORDER_QUALITY_INPUT_INVALID',
        'Border layer names must be unique',
        {
          layer: layer.name,
        },
      );
    names.add(layer.name);
    if (layer.labels.length < input.provinceKinds.length)
      throw new ServiceError(
        'MAP_BORDER_QUALITY_INPUT_INVALID',
        'A border layer needs one label per province id',
        { layer: layer.name, labels: layer.labels.length, provinces: input.provinceKinds.length },
      );
  }
  const planes = input.features ?? {};
  for (const [name, plane] of [
    ['heights', planes.heights],
    ['rivers', planes.rivers],
    ['terrain', planes.terrain?.plane],
    ['extra', planes.extra],
  ] as const) {
    if (plane === undefined) continue;
    if (plane.width !== input.width || plane.height !== input.height)
      throw new ServiceError(
        'MAP_BORDER_QUALITY_INPUT_INVALID',
        `The ${name} plane must match the province raster size`,
        { plane: name, width: plane.width, height: plane.height },
      );
  }
  if (planes.terrain !== undefined && planes.terrain.classes.length !== 256)
    throw new ServiceError(
      'MAP_BORDER_QUALITY_INPUT_INVALID',
      'The terrain class table needs 256 entries',
    );
}

/**
 * One streamed pass over the raster: collect every land border edge and the chance baseline. The
 * pass is a generator that yields every 16 rows so a synchronous planner can interleave its own
 * checkpoints; `buildBorderEdgeTable` drives it and yields to the event loop.
 */
export function* buildBorderEdgeTableSteps(
  input: BorderQualityInput,
  options: BorderQualityOptions = {},
): Generator<void, BorderEdgeTable, void> {
  const resolved = resolveOptions(options);
  validateInput(input);
  const { width, height, provinceIds, provinceKinds } = input;
  const rows = new FeatureRows(input, resolved);
  let capacity = Math.min(65_536, resolved.maxEdges);
  let keys = new Int32Array(capacity);
  let provinceA = new Int32Array(capacity);
  let provinceB = new Int32Array(capacity);
  let features = new Uint8Array(capacity);
  let edgeCount = 0;
  const push = (key: number, a: number, b: number, bits: number): void => {
    if (edgeCount === capacity) {
      if (capacity >= resolved.maxEdges)
        throw new ServiceError(
          'MAP_BORDER_QUALITY_BUDGET_EXCEEDED',
          'The map has more land border edges than the fixed border quality budget allows',
          { maximumEdges: resolved.maxEdges },
        );
      capacity = Math.min(resolved.maxEdges, capacity * 2);
      const grow = <T extends Int32Array | Uint8Array>(array: T): T => {
        const bigger = new (array.constructor as new (length: number) => T)(capacity);
        bigger.set(array);
        return bigger;
      };
      keys = grow(keys);
      provinceA = grow(provinceA);
      provinceB = grow(provinceB);
      features = grow(features);
    }
    keys[edgeCount] = key;
    provinceA[edgeCount] = a;
    provinceB[edgeCount] = b;
    features[edgeCount] = bits;
    edgeCount += 1;
  };
  const coastEdgesByProvince = new Uint32Array(provinceKinds.length);
  const pairsByFeature: Record<BorderFeature, number> = {
    river: 0,
    slope: 0,
    lakeShore: 0,
    terrainChange: 0,
    extra: 0,
  };
  let landPixels = 0;
  let landPairs = 0;
  let barrierPairs = 0;
  let naturalPairs = 0;
  let current = new Uint8Array(width);
  let next = new Uint8Array(width);
  rows.rowFlags(0, current);
  const isLand = (id: number): boolean =>
    id >= 0 && id < provinceKinds.length && provinceKinds[id] === BORDER_PROVINCE_KIND.land;
  const isWater = (id: number): boolean =>
    id >= 0 &&
    id < provinceKinds.length &&
    (provinceKinds[id] === BORDER_PROVINCE_KIND.sea ||
      provinceKinds[id] === BORDER_PROVINCE_KIND.lake);
  const visitPair = (a: number, b: number, key: number, bits: number): void => {
    if (isLand(b)) {
      landPairs += 1;
      if ((bits & BARRIER_MASK) !== 0) barrierPairs += 1;
      if ((bits & NATURAL_MASK) !== 0) naturalPairs += 1;
      for (const feature of BORDER_FEATURES)
        if ((bits & BORDER_FEATURE_BITS[feature]) !== 0) pairsByFeature[feature] += 1;
      if (a !== b) push(key, a, b, bits & NATURAL_MASK);
    } else if (isWater(b)) {
      coastEdgesByProvince[a] = coastEdgesByProvince[a]! + 1;
    }
  };
  for (let y = 0; y < height; y += 1) {
    if (y % 16 === 0) {
      resolved.signal?.throwIfAborted();
      yield;
    }
    if (y + 1 < height) rows.rowFlags(y + 1, next);
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + x;
      const id = provinceIds[pixel]!;
      if (!isLand(id)) {
        // A water pixel's land neighbours are counted from the land side below.
        continue;
      }
      landPixels += 1;
      const east = x === width - 1 ? 0 : x + 1;
      visitPair(id, provinceIds[rowStart + east]!, pixel * 2, current[x]! | current[east]!);
      if (y + 1 < height)
        visitPair(id, provinceIds[pixel + width]!, pixel * 2 + 1, current[x]! | next[x]!);
    }
    // Coast edges to the north and west of land come from water pixels looking at land.
    for (let x = 0; x < width; x += 1) {
      const id = provinceIds[rowStart + x]!;
      if (!isWater(id)) continue;
      const east = x === width - 1 ? 0 : x + 1;
      const eastId = provinceIds[rowStart + east]!;
      if (isLand(eastId)) coastEdgesByProvince[eastId] = coastEdgesByProvince[eastId]! + 1;
      if (y + 1 < height) {
        const southId = provinceIds[rowStart + width + x]!;
        if (isLand(southId)) coastEdgesByProvince[southId] = coastEdgesByProvince[southId]! + 1;
      }
    }
    [current, next] = [next, current];
  }
  return {
    width,
    height,
    edgeCount,
    keys: keys.slice(0, edgeCount),
    provinceA: provinceA.slice(0, edgeCount),
    provinceB: provinceB.slice(0, edgeCount),
    features: features.slice(0, edgeCount),
    provinceIds,
    provinceKinds,
    landPixels,
    landPairs,
    barrierPairs,
    naturalPairs,
    pairsByFeature,
    coastEdgesByProvince,
    inputs: {
      heights: input.features?.heights !== undefined,
      rivers: input.features?.rivers !== undefined,
      terrain: input.features?.terrain !== undefined,
      extra: input.features?.extra !== undefined,
    },
    options: resolved,
  };
}

/** Drive `buildBorderEdgeTableSteps`, yielding to the event loop about every 12 milliseconds. */
export async function buildBorderEdgeTable(
  input: BorderQualityInput,
  options: BorderQualityOptions = {},
): Promise<BorderEdgeTable> {
  const steps = buildBorderEdgeTableSteps(input, options);
  const pace = new Pace(options.signal);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pace.tick();
  }
}

function round(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function share(count: number, total: number): number | null {
  return total === 0 ? null : round(count / total);
}

function mod(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/** Labels with every non-land province excluded, as an array indexed by province id. */
function effectiveLabels(table: BorderEdgeTable, labels: Int32Array): Int32Array {
  const result = new Int32Array(table.provinceKinds.length);
  for (let id = 0; id < result.length; id += 1)
    result[id] = table.provinceKinds[id] === BORDER_PROVINCE_KIND.land ? labels[id]! : -1;
  return result;
}

export interface BorderScore {
  borderEdges: number;
  barrierEdges: number;
  naturalEdges: number;
  unlabelledEdges: number;
  /** Aligned share of border length (the plan's alignment). */
  alignment: number | null;
  enrichment: number | null;
  /** Plain share of border length on a natural feature. */
  naturalShare: number | null;
  baseRate: number;
}

/**
 * Score one grouping of provinces against a prebuilt edge table in one pass over its edges, with
 * no raster access. Territory assignment calls this for each candidate grouping.
 */
export function scoreBorderAssignment(table: BorderEdgeTable, labels: Int32Array): BorderScore {
  const effective = effectiveLabels(table, labels);
  let borderEdges = 0;
  let barrierEdges = 0;
  let naturalEdges = 0;
  let unlabelledEdges = 0;
  for (let index = 0; index < table.edgeCount; index += 1) {
    const left = effective[table.provinceA[index]!]!;
    const right = effective[table.provinceB[index]!]!;
    if (left < 0 || right < 0) {
      unlabelledEdges += 1;
      continue;
    }
    if (left === right) continue;
    borderEdges += 1;
    const bits = table.features[index]!;
    if ((bits & BARRIER_MASK) !== 0) barrierEdges += 1;
    if ((bits & NATURAL_MASK) !== 0) naturalEdges += 1;
  }
  const baseRate = table.landPairs === 0 ? 0 : table.barrierPairs / table.landPairs;
  const alignment = borderEdges === 0 ? null : barrierEdges / borderEdges;
  return {
    borderEdges,
    barrierEdges,
    naturalEdges,
    unlabelledEdges,
    alignment: alignment === null ? null : round(alignment),
    enrichment:
      alignment === null || baseRate < table.options.minBaseRate
        ? null
        : round(alignment / baseRate),
    naturalShare: share(naturalEdges, borderEdges),
    baseRate: round(baseRate),
  };
}

interface SelectedEdges {
  /** Table indices of the layer's border edges, in raster order. */
  indices: Int32Array;
  count: number;
  unlabelled: number;
  labels: Int32Array;
  labelBound: number;
}

function selectEdges(table: BorderEdgeTable, labels: Int32Array): SelectedEdges {
  const effective = effectiveLabels(table, labels);
  let labelBound = 0;
  for (const value of effective) if (value >= labelBound) labelBound = value + 1;
  const indices = new Int32Array(table.edgeCount);
  let count = 0;
  let unlabelled = 0;
  for (let index = 0; index < table.edgeCount; index += 1) {
    const left = effective[table.provinceA[index]!]!;
    const right = effective[table.provinceB[index]!]!;
    if (left < 0 || right < 0) unlabelled += 1;
    else if (left !== right) {
      indices[count] = index;
      count += 1;
    }
  }
  return { indices: indices.slice(0, count), count, unlabelled, labels: effective, labelBound };
}

/** Pair key of the two groups on either side of an edge (ordered), or -1 if not a border. */
function pairKeyOf(
  table: BorderEdgeTable,
  selection: SelectedEdges,
  pixel: number,
  direction: number,
): number {
  const width = table.width;
  const x = pixel % width;
  const other =
    direction === 0 ? (x === width - 1 ? pixel - (width - 1) : pixel + 1) : pixel + width;
  if (other >= table.provinceIds.length) return -1;
  const a = table.provinceIds[pixel]!;
  const b = table.provinceIds[other]!;
  if (a < 0 || b < 0 || a >= selection.labels.length || b >= selection.labels.length) return -1;
  const left = selection.labels[a]!;
  const right = selection.labels[b]!;
  if (left < 0 || right < 0 || left === right) return -1;
  return left < right ? left * selection.labelBound + right : right * selection.labelBound + left;
}

interface StraightnessResult {
  samples: number;
  straight: number;
  skipped: number;
}

async function measureStraightness(
  table: BorderEdgeTable,
  selection: SelectedEdges,
  pace: Pace,
): Promise<StraightnessResult> {
  const { width, height } = table;
  const options = table.options;
  const count = selection.count;
  const radius = options.windowRadius;
  const doubledWidth = width * 2;
  const midX = new Int32Array(count);
  const midY = new Int32Array(count);
  const pairKey = new Float64Array(count);
  for (let n = 0; n < count; n += 1) {
    const key = table.keys[selection.indices[n]!]!;
    const pixel = key >> 1;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if ((key & 1) === 0) {
      midX[n] = (2 * (x + 1)) % doubledWidth;
      midY[n] = 2 * y + 1;
    } else {
      midX[n] = 2 * x + 1;
      midY[n] = 2 * (y + 1);
    }
    pairKey[n] = pairKeyOf(table, selection, pixel, key & 1);
  }
  const cellsX = Math.ceil(width / radius);
  const cellsY = Math.ceil(height / radius);
  const cellStart = new Int32Array(cellsX * cellsY + 1);
  const cellOf = new Int32Array(count);
  for (let n = 0; n < count; n += 1) {
    const cell =
      Math.min(cellsY - 1, Math.floor(midY[n]! / 2 / radius)) * cellsX +
      Math.min(cellsX - 1, Math.floor(midX[n]! / 2 / radius));
    cellOf[n] = cell;
    cellStart[cell + 1] = cellStart[cell + 1]! + 1;
  }
  for (let cell = 0; cell < cellsX * cellsY; cell += 1)
    cellStart[cell + 1] = cellStart[cell + 1]! + cellStart[cell]!;
  const fill = cellStart.slice(0, cellsX * cellsY);
  const cellEdges = new Int32Array(count);
  for (let n = 0; n < count; n += 1) {
    const cell = cellOf[n]!;
    cellEdges[fill[cell]!] = n;
    fill[cell] = fill[cell]! + 1;
  }
  const windowSquared = (2 * radius) ** 2;
  const rmsLimit = options.straightRmsPx;
  let samples = 0;
  let straight = 0;
  let skipped = 0;
  const columns: number[] = [];
  for (let n = 0; n < count; n += options.sampleStride) {
    if ((n & 255) === 0) await pace.tick();
    const cell = cellOf[n]!;
    const cellX = cell % cellsX;
    const cellY = (cell - cellX) / cellsX;
    columns.length = 0;
    for (const dx of [-1, 0, 1]) {
      const column = mod(cellX + dx, cellsX);
      if (!columns.includes(column)) columns.push(column);
    }
    const key = pairKey[n]!;
    const originX = midX[n]!;
    const originY = midY[n]!;
    let points = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    for (let row = Math.max(0, cellY - 1); row <= Math.min(cellsY - 1, cellY + 1); row += 1) {
      for (const column of columns) {
        const slot = row * cellsX + column;
        for (let at = cellStart[slot]!; at < cellStart[slot + 1]!; at += 1) {
          const other = cellEdges[at]!;
          if (pairKey[other] !== key) continue;
          let dx = midX[other]! - originX;
          if (dx > width) dx -= doubledWidth;
          else if (dx < -width) dx += doubledWidth;
          const dy = midY[other]! - originY;
          if (dx * dx + dy * dy > windowSquared) continue;
          const px = dx / 2;
          const py = dy / 2;
          points += 1;
          sumX += px;
          sumY += py;
          sumXX += px * px;
          sumYY += py * py;
          sumXY += px * py;
        }
      }
    }
    if (points < options.minWindowEdges) {
      skipped += 1;
      continue;
    }
    const meanX = sumX / points;
    const meanY = sumY / points;
    const varianceX = sumXX / points - meanX * meanX;
    const varianceY = sumYY / points - meanY * meanY;
    const covariance = sumXY / points - meanX * meanY;
    const smallest =
      (varianceX +
        varianceY -
        Math.sqrt((varianceX - varianceY) ** 2 + 4 * covariance * covariance)) /
      2;
    samples += 1;
    if (Math.sqrt(Math.max(0, smallest)) < rmsLimit) straight += 1;
  }
  return { samples, straight, skipped };
}

/** Indices (ascending) of the vertices Douglas-Peucker keeps at the given tolerance. */
function simplifyPolyline(
  xs: readonly number[],
  ys: readonly number[],
  tolerance: number,
): number[] {
  const count = xs.length;
  if (count <= 2) return count === 0 ? [] : count === 1 ? [0] : [0, 1];
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: number[] = [0, count - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last <= first + 1) continue;
    const ax = xs[first]!;
    const ay = ys[first]!;
    const dx = xs[last]! - ax;
    const dy = ys[last]! - ay;
    const length = Math.hypot(dx, dy);
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let at = first + 1; at < last; at += 1) {
      const px = xs[at]! - ax;
      const py = ys[at]! - ay;
      const distance = length === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / length;
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = at;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push(first, farthest, farthest, last);
  }
  const kept: number[] = [];
  for (let at = 0; at < count; at += 1) if (keep[at] === 1) kept.push(at);
  return kept;
}

interface Chain {
  xs: number[];
  ys: number[];
  /** Edge keys along the chain, one fewer than the vertices. */
  keys: number[];
  pairKey: number;
}

interface RunCandidate {
  chain: Chain;
  first: number;
  last: number;
  edges: number;
  natural: number;
}

interface LayerAccumulators {
  longSegments: number;
  longEdges: number;
  longArtificialEdges: number;
  totalChainEdges: number;
  runCount: number;
  runEdges: number;
  longestRun: number;
  runs: RunCandidate[];
}

/** Find the edge-table index of an edge key by binary search. */
function indexOfKey(table: BorderEdgeTable, key: number): number {
  let low = 0;
  let high = table.edgeCount - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = table.keys[middle]!;
    if (value === key) return middle;
    if (value < key) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/**
 * Walk every border of the layer as chains of unit segments on the pixel-corner lattice. A chain
 * stops at a junction (a corner where the same pair of groups continues in more than one way) and
 * at the end of the border. Coordinates are unwrapped across the east-west seam.
 */
async function traceChains(
  table: BorderEdgeTable,
  selection: SelectedEdges,
  pace: Pace,
  visit: (chain: Chain) => void,
): Promise<void> {
  const { width, height } = table;
  const visited = new Uint8Array(Math.ceil((2 * width * height) / 8));
  const isVisited = (key: number): boolean => (visited[key >> 3]! & (1 << (key & 7))) !== 0;
  const mark = (key: number): void => {
    visited[key >> 3] = visited[key >> 3]! | (1 << (key & 7));
  };
  const extend = (
    startX: number,
    startY: number,
    pairKey: number,
  ): { xs: number[]; ys: number[]; keys: number[] } => {
    const out = { xs: [] as number[], ys: [] as number[], keys: [] as number[] };
    let ux = startX;
    let cy = startY;
    for (;;) {
      const nx = mod(ux, width);
      const west = nx === 0 ? width - 1 : nx - 1;
      let found = 0;
      let foundKey = 0;
      let foundX = 0;
      let foundY = 0;
      // up, down, left, right incident segments of the corner (nx, cy)
      const candidates: [boolean, number, number, number][] = [
        [cy >= 1, ((cy - 1) * width + west) * 2, ux, cy - 1],
        [cy <= height - 1, (cy * width + west) * 2, ux, cy + 1],
        [cy >= 1 && cy <= height - 1, ((cy - 1) * width + west) * 2 + 1, ux - 1, cy],
        [cy >= 1 && cy <= height - 1, ((cy - 1) * width + nx) * 2 + 1, ux + 1, cy],
      ];
      for (const [valid, key, candidateX, candidateY] of candidates) {
        if (!valid || isVisited(key)) continue;
        if (pairKeyOf(table, selection, key >> 1, key & 1) !== pairKey) continue;
        found += 1;
        foundKey = key;
        foundX = candidateX;
        foundY = candidateY;
      }
      if (found !== 1) break;
      mark(foundKey);
      out.keys.push(foundKey);
      out.xs.push(foundX);
      out.ys.push(foundY);
      ux = foundX;
      cy = foundY;
    }
    return out;
  };
  for (let n = 0; n < selection.count; n += 1) {
    if ((n & 511) === 0) await pace.tick();
    const startKey = table.keys[selection.indices[n]!]!;
    if (isVisited(startKey)) continue;
    mark(startKey);
    const pixel = startKey >> 1;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const pairKey = pairKeyOf(table, selection, pixel, startKey & 1);
    const vertical = (startKey & 1) === 0;
    const ax = vertical ? x + 1 : x;
    const ay = vertical ? y : y + 1;
    const bx = x + 1;
    const by = y + 1;
    const forward = extend(bx, by, pairKey);
    const backward = extend(ax, ay, pairKey);
    const chain: Chain = {
      xs: [...backward.xs.reverse(), ax, bx, ...forward.xs],
      ys: [...backward.ys.reverse(), ay, by, ...forward.ys],
      keys: [...backward.keys.reverse(), startKey, ...forward.keys],
      pairKey,
    };
    visit(chain);
  }
}

function chainSides(
  pairKey: number,
  labelBound: number,
  describe: (label: number) => string,
): { labels: [number, number]; sides: [string, string] } {
  const low = Math.floor(pairKey / labelBound);
  const high = pairKey - low * labelBound;
  return { labels: [low, high], sides: [describe(low), describe(high)] };
}

function analyseChain(
  table: BorderEdgeTable,
  chain: Chain,
  accumulators: LayerAccumulators,
  runLimit: number,
): void {
  const options = table.options;
  const segments = chain.keys.length;
  const natural = new Uint8Array(segments);
  for (let at = 0; at < segments; at += 1) {
    const index = indexOfKey(table, chain.keys[at]!);
    natural[at] = index >= 0 && (table.features[index]! & NATURAL_MASK) !== 0 ? 1 : 0;
  }
  accumulators.totalChainEdges += segments;
  const kept = simplifyPolyline(chain.xs, chain.ys, options.simplifyTolerance);
  for (let at = 1; at < kept.length; at += 1) {
    const from = kept[at - 1]!;
    const to = kept[at]!;
    const chord = Math.hypot(chain.xs[to]! - chain.xs[from]!, chain.ys[to]! - chain.ys[from]!);
    if (chord <= options.longRunPx) continue;
    let onFeature = 0;
    for (let edge = from; edge < to; edge += 1) onFeature += natural[edge]!;
    accumulators.longSegments += 1;
    accumulators.longEdges += to - from;
    if (onFeature * 2 < to - from) accumulators.longArtificialEdges += to - from;
  }
  // Artificial runs: maximal stretches of edges on no feature, bridging short natural gaps.
  let start = -1;
  let end = -1;
  const flush = (): void => {
    if (start < 0) return;
    const edges = end - start + 1;
    if (edges >= options.minRunEdges) {
      let onFeature = 0;
      for (let edge = start; edge <= end; edge += 1) onFeature += natural[edge]!;
      accumulators.runCount += 1;
      accumulators.runEdges += edges;
      if (edges > accumulators.longestRun) accumulators.longestRun = edges;
      if (runLimit > 0) {
        accumulators.runs.push({ chain, first: start, last: end, edges, natural: onFeature });
        if (accumulators.runs.length > runLimit * 8) trimRuns(accumulators, runLimit * 2);
      }
    }
    start = -1;
    end = -1;
  };
  let gap = 0;
  for (let at = 0; at < segments; at += 1) {
    if (natural[at] === 0) {
      if (start < 0) start = at;
      end = at;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > options.naturalGapEdges) flush();
    }
  }
  flush();
}

function runOrder(left: RunCandidate, right: RunCandidate): number {
  return (
    right.edges - left.edges ||
    left.chain.keys[left.first]! - right.chain.keys[right.first]! ||
    left.last - right.last
  );
}

function trimRuns(accumulators: LayerAccumulators, keep: number): void {
  accumulators.runs.sort(runOrder);
  accumulators.runs.length = Math.min(accumulators.runs.length, keep);
}

function formatRun(
  table: BorderEdgeTable,
  candidate: RunCandidate,
  labelBound: number,
  describe: (label: number) => string,
): BorderRun {
  const { chain, first, last, edges, natural } = candidate;
  const width = table.width;
  const startX = chain.xs[first]!;
  const startY = chain.ys[first]!;
  const endX = chain.xs[last + 1]!;
  const endY = chain.ys[last + 1]!;
  const chord = Math.hypot(endX - startX, endY - startY);
  const { labels, sides } = chainSides(chain.pairKey, labelBound, describe);
  return {
    sides,
    labels,
    from: { x: mod(startX, width), y: startY },
    to: { x: mod(endX, width), y: endY },
    edges,
    chord: round(chord, 2),
    straightRatio: round(Math.min(1, chord / edges)),
    naturalShare: round(natural / edges),
  };
}

async function evaluateLayer(
  table: BorderEdgeTable,
  layer: BorderLayerInput,
  pace: Pace,
  paint: Map<string, Int32Array[]> | undefined,
): Promise<BorderLayerReport> {
  const options = table.options;
  const describe = layer.describe ?? ((label: number) => String(label));
  const selection = selectEdges(table, layer.labels);
  const groups = new Set<number>();
  let coastEdges = 0;
  for (const [id, label] of selection.labels.entries())
    if (label >= 0) {
      groups.add(label);
      coastEdges += table.coastEdgesByProvince[id]!;
    }
  let barrierEdges = 0;
  let naturalEdges = 0;
  const featureEdges: Record<BorderFeature, number> = {
    river: 0,
    slope: 0,
    lakeShore: 0,
    terrainChange: 0,
    extra: 0,
  };
  for (let n = 0; n < selection.count; n += 1) {
    const bits = table.features[selection.indices[n]!]!;
    if ((bits & BARRIER_MASK) !== 0) barrierEdges += 1;
    if ((bits & NATURAL_MASK) !== 0) naturalEdges += 1;
    for (const feature of BORDER_FEATURES)
      if ((bits & BORDER_FEATURE_BITS[feature]) !== 0) featureEdges[feature] += 1;
  }
  const borderEdges = selection.count;
  const barrierBase = table.landPairs === 0 ? 0 : table.barrierPairs / table.landPairs;
  const naturalBase = table.landPairs === 0 ? 0 : table.naturalPairs / table.landPairs;
  const noFeatures =
    !table.inputs.heights &&
    !table.inputs.rivers &&
    !table.inputs.terrain &&
    !table.inputs.extra &&
    table.pairsByFeature.lakeShore === 0;
  const status: BorderLayerStatus =
    borderEdges === 0
      ? 'no-borders'
      : borderEdges < options.minBorderEdges
        ? 'too-short'
        : noFeatures || barrierBase < options.minBaseRate
          ? 'not-meaningful'
          : 'ok';
  const accumulators: LayerAccumulators = {
    longSegments: 0,
    longEdges: 0,
    longArtificialEdges: 0,
    totalChainEdges: 0,
    runCount: 0,
    runEdges: 0,
    longestRun: 0,
    runs: [],
  };
  let straightness: StraightnessResult = { samples: 0, straight: 0, skipped: 0 };
  if (borderEdges > 0) {
    straightness = await measureStraightness(table, selection, pace);
    await traceChains(table, selection, pace, (chain) =>
      analyseChain(table, chain, accumulators, options.worstRunLimit),
    );
  }
  trimRuns(accumulators, options.worstRunLimit);
  const alignment = borderEdges === 0 ? null : barrierEdges / borderEdges;
  const naturalShare = borderEdges === 0 ? null : naturalEdges / borderEdges;
  const worstRuns = accumulators.runs.map((run) =>
    formatRun(table, run, selection.labelBound, describe),
  );
  if (paint !== undefined)
    paint.set(
      layer.name,
      accumulators.runs.map((run) =>
        Int32Array.from(run.chain.keys.slice(run.first, run.last + 1)),
      ),
    );
  const byFeature = Object.fromEntries(
    BORDER_FEATURES.map((feature) => [feature, share(featureEdges[feature], borderEdges)]),
  ) as Record<BorderFeature, number | null>;
  return {
    layer: layer.name,
    status,
    groups: groups.size,
    borderEdges,
    unlabelledEdges: selection.unlabelled,
    coastEdges,
    barrier: {
      alignedEdges: barrierEdges,
      alignment: alignment === null ? null : round(alignment),
      baseRate: round(barrierBase),
      enrichment:
        alignment === null || barrierBase < options.minBaseRate
          ? null
          : round(alignment / barrierBase),
    },
    natural: {
      alignedEdges: naturalEdges,
      share: naturalShare === null ? null : round(naturalShare),
      baseRate: round(naturalBase),
      enrichment:
        naturalShare === null || naturalBase < options.minBaseRate
          ? null
          : round(naturalShare / naturalBase),
      byFeature,
      shareWithCoast: share(naturalEdges + coastEdges, borderEdges + coastEdges),
    },
    straightness: {
      samples: straightness.samples,
      straight: straightness.straight,
      skippedShortWindows: straightness.skipped,
      fraction: share(straightness.straight, straightness.samples),
    },
    longRuns: {
      segments: accumulators.longSegments,
      edges: accumulators.longEdges,
      share: share(accumulators.longEdges, accumulators.totalChainEdges),
      artificialShare: share(accumulators.longArtificialEdges, accumulators.totalChainEdges),
    },
    artificialRuns: {
      count: accumulators.runCount,
      edges: accumulators.runEdges,
      longestEdges: accumulators.longestRun,
    },
    worstRuns,
  };
}

/** Measure how natural the borders of every requested layer are. Deterministic and bounded. */
export async function measureBorderNaturalness(
  input: BorderQualityInput,
  options: BorderQualityOptions = {},
): Promise<BorderQualityResult> {
  const table = await buildBorderEdgeTable(input, options);
  const pace = new Pace(table.options.signal);
  const paint = table.options.collectPaint ? new Map<string, Int32Array[]>() : undefined;
  const layers: BorderLayerReport[] = [];
  for (const layer of input.layers) layers.push(await evaluateLayer(table, layer, pace, paint));
  const report: BorderQualityReport = {
    schemaVersion: 1,
    width: table.width,
    height: table.height,
    landPixels: table.landPixels,
    inputs: table.inputs,
    parameters: {
      riverRadius: table.options.riverRadius,
      slopeGradient: table.options.slopeGradient,
      slopeRadius: table.options.slopeRadius,
      sampleStride: table.options.sampleStride,
      windowRadius: table.options.windowRadius,
      straightRmsPx: table.options.straightRmsPx,
      simplifyTolerance: table.options.simplifyTolerance,
      longRunPx: table.options.longRunPx,
    },
    targets: Object.fromEntries(layers.map(({ layer }) => [layer, borderTargetsForLayer(layer)])),
    layers,
  };
  return { report, table, ...(paint === undefined ? {} : { paint }) };
}

export interface BorderTargetCheck {
  layer: string;
  passed: boolean;
  failures: {
    metric: 'enrichment' | 'straightness' | 'naturalShare';
    value: number | null;
    target: number;
  }[];
}

/** Compare a layer with targets; a metric that cannot be judged is not a failure. */
export function checkBorderTargets(
  layer: BorderLayerReport,
  targets: BorderTargets = borderTargetsForLayer(layer.layer),
): BorderTargetCheck {
  const failures: BorderTargetCheck['failures'] = [];
  const minEnrichment = targets.minEnrichment;
  if (
    minEnrichment !== undefined &&
    layer.barrier.enrichment !== null &&
    layer.barrier.enrichment < minEnrichment
  )
    failures.push({ metric: 'enrichment', value: layer.barrier.enrichment, target: minEnrichment });
  const maxStraightness = targets.maxStraightness;
  if (
    maxStraightness !== undefined &&
    layer.straightness.fraction !== null &&
    layer.straightness.fraction > maxStraightness
  )
    failures.push({
      metric: 'straightness',
      value: layer.straightness.fraction,
      target: maxStraightness,
    });
  const minShare = targets.minNaturalShare;
  if (minShare !== undefined && layer.natural.share !== null && layer.natural.share < minShare)
    failures.push({ metric: 'naturalShare', value: layer.natural.share, target: minShare });
  return { layer: layer.layer, passed: failures.length === 0, failures };
}

/** The border validators (ADR 0059) as diagnostics: review warnings, not-meaningful and missing inputs. */
export function borderQualityDiagnostics(
  report: BorderQualityReport,
  targets?: BorderTargets,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const missing = (['heights', 'rivers', 'terrain'] as const).filter(
    (name) => !report.inputs[name],
  );
  if (missing.length > 0)
    diagnostics.push({
      code: 'MAP_BORDER_INPUT_MISSING',
      severity: 'info',
      category: 'map',
      message: `Border naturalness was measured without the ${missing.join(', ')} bitmap${missing.length > 1 ? 's' : ''}; those features are not counted`,
      details: { missing },
    });
  for (const layer of report.layers) {
    if (layer.status === 'not-meaningful')
      diagnostics.push({
        code: 'MAP_BORDER_NOT_MEANINGFUL',
        severity: 'info',
        category: 'map',
        message: `The ${layer.layer} border enrichment is not meaningful: only ${(layer.barrier.baseRate * 100).toFixed(1)}% of land lies on a river, slope or lake shore`,
        details: { layer: layer.layer, baseRate: layer.barrier.baseRate },
      });
    if (layer.status === 'no-borders' || layer.status === 'too-short') continue;
    const check = checkBorderTargets(layer, targets ?? borderTargetsForLayer(layer.layer));
    if (!check.passed)
      diagnostics.push({
        code: 'MAP_BORDER_ARTIFICIAL_REVIEW',
        severity: 'warning',
        category: 'map',
        message: `The ${layer.layer} borders look artificial: ${check.failures
          .map(({ metric, value, target }) =>
            metric === 'enrichment'
              ? `enrichment ${String(value)} is below ${String(target)}`
              : metric === 'straightness'
                ? `${String(value)} of samples are locally straight (limit ${String(target)})`
                : `natural share ${String(value)} is below ${String(target)}`,
          )
          .join('; ')}`,
        details: {
          layer: layer.layer,
          failures: check.failures,
          worstRun: layer.worstRuns[0] ?? null,
        },
      });
  }
  return diagnostics;
}

/** The two pixels either side of an edge key (`pixel * 2 + direction`). */
export function borderEdgePixels(width: number, key: number): [number, number] {
  const pixel = key >> 1;
  const x = pixel % width;
  return [
    pixel,
    (key & 1) === 0 ? (x === width - 1 ? pixel - (width - 1) : pixel + 1) : pixel + width,
  ];
}

/** Visit every border edge of a grouping with whether it lies on a natural feature. */
export function forEachBorderEdge(
  table: BorderEdgeTable,
  labels: Int32Array,
  visit: (key: number, natural: boolean) => void,
): void {
  const effective = effectiveLabels(table, labels);
  for (let index = 0; index < table.edgeCount; index += 1) {
    const left = effective[table.provinceA[index]!]!;
    const right = effective[table.provinceB[index]!]!;
    if (left < 0 || right < 0 || left === right) continue;
    visit(table.keys[index]!, (table.features[index]! & NATURAL_MASK) !== 0);
  }
}
