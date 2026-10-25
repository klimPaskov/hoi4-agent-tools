/**
 * Terrain synthesis from a resolved geography model (ADR 0056): relief on a macro grid, erosion-aware
 * hydrology, full-resolution detail and river pixels, the normal map from the real height field, and
 * the barrier and valley fields later stages read. One call, deterministic, memory bounded by typed
 * arrays of the map size.
 */
import type { ResolvedGeography } from '../geography/index.js';
import { LAKE, LAND, chamferDistance } from './grid.js';
import { landDistanceField, lakeHeight } from '../water.js';
import {
  BARRIER_CREST,
  BARRIER_FORT_LINE,
  BARRIER_LAKE_SHORE,
  BARRIER_RIVER,
  BARRIER_STEEP,
  BARRIER_WALL,
  type BarrierField,
  type RiverReportEntry,
  type RiverStatistics,
  type TerrainFields,
  type ReliefStatistics,
} from './fields.js';
import {
  checkRangesAndFeatures,
  reliefStatistics,
  straightRiverShare,
  type ReliefNote,
} from './checks.js';
import { buildFullResolutionHeights } from './full-resolution.js';
import { RIVER_PIXEL_CAP, synthesizeHydrology } from './hydrology.js';
import {
  DEFAULT_RELIEF,
  LAND_FLOOR,
  HEIGHT_CEILING,
  peakHeight,
  synthesizeMacroRelief,
  type ReliefSettings,
} from './macro-relief.js';
import { rasterizeRivers } from './river-raster.js';

export interface TerrainSynthesisInput {
  geography: ResolvedGeography;
  width: number;
  height: number;
  seed: number;
  /** Final surface: 0 sea, 1 land, 2 lake. Never modified. */
  kind: Uint8Array;
  relief?: Partial<ReliefSettings> | undefined;
  rivers?: { density?: number | undefined; count?: number | undefined } | undefined;
  /** Rain per macro cell (half the map size), a multiplier of one; later stages supply it. */
  rainfall?: Float32Array | undefined;
  /**
   * A change to land heights in map values, applied to the macro relief before the hydrology so
   * that rivers route around it (the world rim, ADR 0061): `x` and `y` are the full-resolution
   * pixel at the centre of the macro cell.
   */
  adjustHeight?: ((x: number, y: number, height: number) => number) | undefined;
  signal?: AbortSignal | undefined;
  /** Called when a stage starts, for progress heartbeats and timing. */
  onStage?: ((stage: string) => void) | undefined;
}

export interface RiverPath {
  readonly id: string;
  /** Pixel indices (y * width + x) from the source to the last land pixel. */
  readonly pixels: Int32Array;
}

export interface SynthesizedTerrain {
  readonly width: number;
  readonly height: number;
  /** `heightmap.bmp` values: land from 96, water 89 with the bank of ADR 0053. */
  readonly heights: Uint8Array;
  /** `world_normal.bmp` at half size: red, green, blue per pixel. */
  readonly normals: Uint8Array;
  /** `rivers.bmp` indices: 255 land, 254 water, 0 to 11 rivers. */
  readonly riverBitmap: Uint8Array;
  /** Order of the river on each river pixel (1 for a headwater), 0 elsewhere. */
  readonly riverOrder: Uint8Array;
  /** Land in 0..1 and water in -1..0, in the scale the province generator expects. */
  readonly elevation: Float32Array;
  /** 1 where a range's snow line puts permanent snow. */
  readonly snow: Uint8Array;
  readonly fields: TerrainFields;
  readonly rivers: readonly RiverReportEntry[];
  /** Pixel paths from source to mouth, in the order of `rivers`, for stages that need river topology. */
  readonly riverPaths: readonly RiverPath[];
  readonly relief: ReliefStatistics;
  readonly riverStatistics: RiverStatistics;
  readonly notes: readonly ReliefNote[];
}

/** Red channel response of the normal map per height step (base game: about 2.6). */
export const NORMAL_RESPONSE = 2.6;

function normalMap(
  floats: Float32Array,
  width: number,
  height: number,
  signal: AbortSignal | undefined,
): Uint8Array {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const out = new Uint8Array(halfWidth * halfHeight * 3);
  const gain = NORMAL_RESPONSE / 127;
  const at = (x: number, y: number): number =>
    floats[
      (y < 0 ? 0 : y >= height ? height - 1 : y) * width + (x < 0 ? 0 : x >= width ? width - 1 : x)
    ]!;
  for (let y = 0; y < halfHeight; y += 1) {
    if (y % 64 === 0) signal?.throwIfAborted();
    for (let x = 0; x < halfWidth; x += 1) {
      const dx = at(2 * x + 2, 2 * y) - at(2 * x - 2, 2 * y);
      const dy = at(2 * x, 2 * y - 2) - at(2 * x, 2 * y + 2);
      const nx = -gain * dx;
      const ny = gain * dy;
      const length = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * halfWidth + x) * 3;
      out[o] = Math.round(128 + (nx / length) * 127);
      out[o + 1] = Math.round(128 + (ny / length) * 127);
      out[o + 2] = Math.round(128 + (1 / length) * 127);
    }
  }
  return out;
}

function barrierField(
  width: number,
  height: number,
  kind: Uint8Array,
  heights: Uint8Array,
  riverBitmap: Uint8Array,
  macro: { width: number; crest: Uint8Array; footprint: Float32Array; barrier: Uint8Array },
  signal: AbortSignal | undefined,
): BarrierField {
  const strength = new Uint8Array(width * height);
  const sources = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) signal?.throwIfAborted();
    const my = y >> 1;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (kind[index] !== LAND) continue;
      let value = 0;
      let flags = 0;
      const river = riverBitmap[index]!;
      if (river <= 11) {
        flags |= BARRIER_RIVER;
        value = Math.max(value, river >= 3 ? 100 + 14 * (river - 3) : 100);
      }
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        const gx = (heights[index + 1]! - heights[index - 1]!) / 2;
        const gy = (heights[index + width]! - heights[index - width]!) / 2;
        const gradient = Math.sqrt(gx * gx + gy * gy);
        if (gradient >= 2) {
          flags |= BARRIER_STEEP;
          value = Math.max(value, Math.min(200, 60 + 25 * (gradient - 2)));
        }
        if (
          kind[index - 1] === LAKE ||
          kind[index + 1] === LAKE ||
          kind[index - width] === LAKE ||
          kind[index + width] === LAKE
        ) {
          flags |= BARRIER_LAKE_SHORE;
          value = Math.max(value, 90);
        }
      }
      const cell = my * macro.width + (x >> 1);
      if (macro.crest[cell] === 1 && macro.footprint[cell]! >= 0.4) {
        flags |= BARRIER_CREST;
        value = Math.max(value, 150);
      }
      const wall = macro.barrier[cell]!;
      if (wall === 1) {
        flags |= BARRIER_WALL;
        value = 255;
      } else if (wall === 2) {
        flags |= BARRIER_FORT_LINE;
        value = Math.max(value, 180);
      }
      strength[index] = Math.round(value);
      sources[index] = flags;
    }
  }
  return { width, height, strength, sources };
}

/**
 * Run the macro relief and the hydrology only, which is where a model's rivers fail to reach
 * their mouths, and return their notes. The full-resolution heights, river pixels and fields are
 * not built, so a model can be checked in a fraction of a write. A river that cannot reach its
 * mouth throws as in `synthesizeTerrain`, with every failing river in its details.
 */
export function checkTerrainRivers(input: TerrainSynthesisInput): ReliefNote[] {
  const { geography, width, height, seed, kind } = input;
  const relief: ReliefSettings = { ...DEFAULT_RELIEF, ...input.relief };
  let landPixels = 0;
  for (let index = 0; index < width * height; index += 1) if (kind[index] === LAND) landPixels += 1;
  const macro = synthesizeMacroRelief({
    geography,
    width,
    height,
    seed,
    kind,
    relief,
    signal: input.signal,
  });
  const adjust = input.adjustHeight;
  if (adjust !== undefined)
    for (let y = 0; y < macro.height; y += 1)
      for (let x = 0; x < macro.width; x += 1) {
        const cell = y * macro.width + x;
        if (macro.kind[cell] === LAND)
          macro.heights[cell] = adjust(2 * x + 1, 2 * y + 1, macro.heights[cell]!);
      }
  return [
    ...synthesizeHydrology({
      geography,
      macro,
      seed,
      density: input.rivers?.density,
      count: input.rivers?.count,
      rainfall: input.rainfall,
      landPixels,
      signal: input.signal,
    }).notes,
  ];
}

/** Build relief, hydrology, normals and fields for a geography model on a map of the given size. */
export function synthesizeTerrain(input: TerrainSynthesisInput): SynthesizedTerrain {
  const { geography, width, height, seed, kind } = input;
  const relief: ReliefSettings = { ...DEFAULT_RELIEF, ...input.relief };
  const total = width * height;
  let landPixels = 0;
  for (let index = 0; index < total; index += 1) if (kind[index] === LAND) landPixels += 1;
  const notes: ReliefNote[] = [];
  const stage = input.onStage ?? ((): void => undefined);

  stage('macro relief');
  const macro = synthesizeMacroRelief({
    geography,
    width,
    height,
    seed,
    kind,
    relief,
    signal: input.signal,
  });
  const adjust = input.adjustHeight;
  if (adjust !== undefined)
    for (let y = 0; y < macro.height; y += 1)
      for (let x = 0; x < macro.width; x += 1) {
        const cell = y * macro.width + x;
        if (macro.kind[cell] === LAND)
          macro.heights[cell] = adjust(2 * x + 1, 2 * y + 1, macro.heights[cell]!);
      }
  stage('hydrology');
  const hydrology = synthesizeHydrology({
    geography,
    macro,
    seed,
    density: input.rivers?.density,
    count: input.rivers?.count,
    rainfall: input.rainfall,
    landPixels,
    signal: input.signal,
  });
  for (const note of hydrology.notes) notes.push(note);
  stage('full-resolution heights');
  const floats = buildFullResolutionHeights({
    macro: { ...macro, heights: hydrology.heights },
    kind,
    width,
    height,
    seed,
    detail: relief.detail,
    signal: input.signal,
  });
  stage('river pixels');
  const raster = rasterizeRivers({
    rivers: hydrology.rivers,
    macroWidth: macro.width,
    macroHeight: macro.height,
    kind,
    width,
    height,
    heights: floats,
    seed,
    pixelCap: Math.min(RIVER_PIXEL_CAP, Math.floor(0.025 * landPixels)),
    signal: input.signal,
  });
  for (const note of raster.notes) notes.push(note);

  stage('quantise');
  // Quantise once, at the end, monotonically: land from the floor, water by the bank rule.
  const landDistance = landDistanceField(kind, width, height);
  const heights = new Uint8Array(total);
  const elevation = new Float32Array(total);
  const snow = new Uint8Array(total);
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) input.signal?.throwIfAborted();
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (kind[index] === LAND) {
        let value = floats[index]!;
        value = value < LAND_FLOOR ? LAND_FLOOR : value > HEIGHT_CEILING ? HEIGHT_CEILING : value;
        floats[index] = value;
        const quantised = Math.round(value);
        heights[index] = quantised;
        elevation[index] = Math.min(1, Math.max(0, (quantised - LAND_FLOOR) / 110));
        const line = macro.snowLine[(y >> 1) * macro.width + (x >> 1)]!;
        if (line < 255 && quantised >= line) snow[index] = 1;
      } else {
        const water = lakeHeight(landDistance[index]!);
        floats[index] = water;
        heights[index] = water;
        elevation[index] = (water - 94) / 30;
      }
    }
  }
  stage('normals and fields');
  const normals = normalMap(floats, width, height, input.signal);
  const barrier = barrierField(width, height, kind, heights, raster.bitmap, macro, input.signal);

  const valley = {
    width: macro.width,
    height: macro.height,
    scale: 2 as const,
    data: hydrology.valley,
  };
  const crestDistance = chamferDistance(macro.crest, macro.width, macro.height, 255);
  const crestData = new Uint8Array(crestDistance.length);
  for (let index = 0; index < crestData.length; index += 1)
    crestData[index] = Math.min(255, Math.round(crestDistance[index]! * 2));
  const mountainData = new Uint8Array(macro.footprint.length);
  for (let index = 0; index < mountainData.length; index += 1)
    mountainData[index] =
      macro.kind[index] === LAND ? Math.round(macro.footprint[index]! * 255) : 0;
  const fields: TerrainFields = {
    barrier,
    valley,
    crestDistance: { width: macro.width, height: macro.height, scale: 2, data: crestData },
    mountain: { width: macro.width, height: macro.height, scale: 2, data: mountainData },
  };

  stage('checks');
  const heightRaster = { width, height, kind, heights };
  const statistics = reliefStatistics(heightRaster);
  for (const note of checkRangesAndFeatures(
    geography,
    macro.ranges,
    heightRaster,
    (peak) => peakHeight(peak, macro.scale),
    (peak) => peakHeight(peak, macro.scale),
  ))
    notes.push(note);
  if (geography.ranges.length > 0 && statistics.landPixels > 0 && statistics.p99 < 150)
    notes.push({
      code: 'MAP_RELIEF_FLAT',
      severity: 'warning',
      message: `The 99th percentile of land height is ${statistics.p99} although the model has ${geography.ranges.length} range(s); raise their peaks, or relief.scale`,
      details: { p99: statistics.p99, ranges: geography.ranges.length },
    });

  // Rivers: the report, the straight-run metric and the density.
  const entries: RiverReportEntry[] = [];
  const paths: RiverPath[] = [];
  let riverCount = 0;
  let named = 0;
  let distributaries = 0;
  hydrology.rivers.forEach((river, index) => {
    const pixelRiver = raster.rivers[index]!;
    const path = pixelRiver.pixels;
    if (path.length === 0) return;
    riverCount += 1;
    paths.push({ id: river.id, pixels: path });
    if (river.junction === 'distributary') distributaries += 1;
    else if (river.named) named += 1;
    const first = path[0]!;
    const last = path[path.length - 1]!;
    const chordX = (first % width) - (last % width);
    const chordY = Math.floor(first / width) - Math.floor(last / width);
    const chord = Math.sqrt(chordX * chordX + chordY * chordY);
    let widest = 3;
    for (const value of river.width) if (value > widest) widest = value;
    const parentId = river.parent >= 0 ? hydrology.rivers[river.parent]!.id : undefined;
    entries.push({
      id: river.id,
      ...(river.name === undefined ? {} : { name: river.name }),
      named: river.named,
      pixels: path.length,
      sinuosity: path.length <= 1 ? 1 : Math.round((chord / (path.length - 1)) * 1000) / 1000,
      mouth: river.endsIn,
      ...(parentId === undefined ? {} : { parent: parentId }),
      junction: river.junction,
      width: widest,
      order: river.order,
      complete: pixelRiver.complete,
    });
  });
  const straight = straightRiverShare(raster.bitmap, width, height);
  const straightShare = straight.river === 0 ? 0 : straight.straight / straight.river;
  if (straight.river > 400 && straightShare > 0.03)
    notes.push({
      code: 'MAP_RIVER_STRAIGHT_RUN',
      severity: 'warning',
      message: `${(straightShare * 100).toFixed(1)}% of river pixels lie on straight stretches of 41 pixels or more (the base game: 1.1%); the ground there is flat, so the relief gives the rivers nothing to bend around`,
      details: { riverPixels: straight.river, straightPixels: straight.straight },
    });
  const share = landPixels === 0 ? 0 : raster.pixels / landPixels;
  if (
    landPixels > 20_000 &&
    (share > 0.03 || (input.rivers?.density === undefined && share < 0.01))
  )
    notes.push({
      code: 'MAP_RIVER_DENSITY',
      severity: 'warning',
      message: `Rivers cover ${(share * 100).toFixed(2)}% of the land (${raster.pixels} pixels); the base game has 2.3% and long networks slow the game`,
      details: { pixels: raster.pixels, landShare: Math.round(share * 10_000) / 10_000 },
    });
  const riverStatistics: RiverStatistics = {
    pixels: raster.pixels,
    landShare: share,
    count: riverCount,
    named,
    distributaries,
    streams: riverCount - named - distributaries,
    straightShare: Math.round(straightShare * 10_000) / 10_000,
  };
  return {
    width,
    height,
    heights,
    normals,
    riverBitmap: raster.bitmap,
    riverOrder: raster.order,
    elevation,
    snow,
    fields,
    rivers: entries,
    riverPaths: paths,
    relief: statistics,
    riverStatistics,
    notes,
  };
}
