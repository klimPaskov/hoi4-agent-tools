/**
 * Facts about the provinces of a generated world that the geography-driven stages share
 * (ADR 0062, 0063): which model land, region, sea or lake each province belongs to, how the
 * provinces border each other, and where they lie. Everything is computed from the province
 * raster in single passes with typed arrays and no randomness, so two runs give the same facts.
 */
import {
  scanAreaStrip,
  type RasterGrid,
  type ResolvedArea,
  type ResolvedGeography,
} from '../geography/index.js';
import type { WorldProvinces } from '../world-provinces.js';

export const SEA = 0;
export const LAND = 1;
export const LAKE = 2;

/** The coarse grid the model's areas are painted on for containment votes. */
export const FACT_GRID_WIDTH = 1_024;

export function factGrid(width: number, height: number): RasterGrid {
  const scale = Math.min(1, FACT_GRID_WIDTH / width);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Paint areas on a grid: each cell holds the 1-based position of the last area that covers it
 * (0 for none), so later entries win where areas overlap.
 */
export function paintAreas(areas: readonly ResolvedArea[], grid: RasterGrid): Uint16Array {
  const data = new Uint16Array(grid.width * grid.height);
  const strip = { y0: 0, y1: grid.height };
  for (const [position, area] of areas.entries()) {
    const value = position + 1;
    scanAreaStrip(area, grid, strip, (y, x0, x1) => {
      data.fill(value, y * grid.width + x0, y * grid.width + x1);
    });
  }
  return data;
}

export interface ProvinceRasterView {
  readonly width: number;
  readonly height: number;
  /** Province index (0-based) of every pixel. */
  readonly pixel: Int32Array;
  readonly count: number;
}

/**
 * For every province the value its sampled pixels most often take in a painted raster; 0 when no
 * sample falls on a painted cell. Ties go to the smaller value. `stride` samples every n-th pixel
 * on both axes.
 */
export function provinceModes(
  view: ProvinceRasterView,
  raster: Uint16Array,
  grid: RasterGrid,
  stride = 3,
  only?: (province: number) => boolean,
  minShare = 0,
): Int32Array {
  const votes = new Map<number, number>();
  const samples = new Int32Array(view.count);
  const { width, height, pixel } = view;
  for (let y = 0; y < height; y += stride) {
    const gy = Math.min(grid.height - 1, Math.floor(((y + 0.5) * grid.height) / height));
    for (let x = 0; x < width; x += stride) {
      const gx = Math.min(grid.width - 1, Math.floor(((x + 0.5) * grid.width) / width));
      const value = raster[gy * grid.width + gx]!;
      const province = pixel[y * width + x]!;
      if (only !== undefined && !only(province)) continue;
      samples[province]! += 1;
      if (value === 0) continue;
      const key = province * 65_536 + value;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  const best = new Int32Array(view.count);
  const bestVotes = new Int32Array(view.count);
  for (const [key, count] of [...votes].sort((left, right) => left[0] - right[0])) {
    const province = Math.floor(key / 65_536);
    if (count > bestVotes[province]! && count >= minShare * samples[province]!) {
      bestVotes[province] = count;
      best[province] = key - province * 65_536;
    }
  }
  return best;
}

/** Statistics of the border between two provinces, over 4-connected pixel pairs. */
export interface BorderStat {
  /** Pixel pairs across the border. */
  count: number;
  /** Pairs where either pixel is a river pixel. */
  rivers: number;
  /** Sum of the absolute height differences across the pairs. */
  step: number;
  /** Sum of the larger of the two heights over the pairs. */
  top: number;
  sumX: number;
  sumY: number;
}

export function pairKey(a: number, b: number, count: number): number {
  return a < b ? a * count + b : b * count + a;
}

export function pairOf(key: number, count: number): [number, number] {
  const a = Math.floor(key / count);
  return [a, key - a * count];
}

export interface BorderTableInput {
  view: ProvinceRasterView;
  heights: Uint8Array;
  /** `rivers.bmp` indices: 0 to 11 are river pixels. */
  rivers: Uint8Array;
}

/**
 * Every border between two provinces, wrapping across the east-west seam. Pixel pairs are the
 * right-hand and lower neighbours of each pixel.
 */
export function buildBorderTable(input: BorderTableInput): Map<number, BorderStat> {
  const { width, height, pixel, count } = input.view;
  const { heights, rivers } = input;
  const table = new Map<number, BorderStat>();
  const visit = (a: number, b: number, p: number, q: number): void => {
    const key = pairKey(a, b, count);
    let stat = table.get(key);
    if (stat === undefined) {
      stat = { count: 0, rivers: 0, step: 0, top: 0, sumX: 0, sumY: 0 };
      table.set(key, stat);
    }
    stat.count += 1;
    if (rivers[p]! <= 11 || rivers[q]! <= 11) stat.rivers += 1;
    const hp = heights[p]!;
    const hq = heights[q]!;
    stat.step += hp > hq ? hp - hq : hq - hp;
    stat.top += hp > hq ? hp : hq;
    stat.sumX += p % width;
    stat.sumY += Math.floor(p / width);
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const p = row + x;
      const a = pixel[p]!;
      const right = row + (x + 1 === width ? 0 : x + 1);
      const b = pixel[right]!;
      if (a !== b) visit(a, b, p, right);
      if (y + 1 < height) {
        const c = pixel[p + width]!;
        if (a !== c) visit(a, c, p, p + width);
      }
    }
  }
  return table;
}

/** Province centre in pixels. */
export interface CenterSource {
  readonly size: readonly number[];
  readonly sumX: readonly number[];
  readonly sumY: readonly number[];
}

export function centerOf(source: CenterSource, id: number): { x: number; y: number } {
  const size = source.size[id]!;
  return { x: source.sumX[id]! / size, y: source.sumY[id]! / size };
}

/** Horizontal difference on a wrapping map. */
export function wrapDelta(a: number, b: number, width: number): number {
  const delta = a - b;
  const half = width / 2;
  return delta > half ? delta - width : delta < -half ? delta + width : delta;
}

export function distanceOnMap(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
): number {
  const dx = wrapDelta(ax, bx, width);
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Which land, region, sea or lake of the model each province belongs to. */
export interface ProvinceFeatures {
  /** Index into `geography.lands` of the land holding most of the province, or -1. */
  readonly land: Int32Array;
  /** Index into `geography.regions` (those with an area), or -1. */
  readonly region: Int32Array;
  /** Index into `geography.seas` for sea provinces, or -1. */
  readonly sea: Int32Array;
  /** Index into `geography.lakes` for lake and inland-sea provinces, or -1. */
  readonly lake: Int32Array;
}

export interface FeatureInput {
  geography: ResolvedGeography;
  view: ProvinceRasterView;
  kind: readonly number[];
}

export function provinceFeatures(input: FeatureInput): ProvinceFeatures {
  const { geography, view, kind } = input;
  const grid = factGrid(view.width, view.height);
  const landRaster = paintAreas(
    geography.lands.map((land) => land.area),
    grid,
  );
  const regionIndex: number[] = [];
  const regionAreas: ResolvedArea[] = [];
  for (const [position, region] of geography.regions.entries())
    if (region.area !== undefined) {
      regionIndex.push(position);
      regionAreas.push(region.area);
    }
  const regionRaster = paintAreas(regionAreas, grid);
  const seaRaster = paintAreas(
    geography.seas.map((sea) => sea.area),
    grid,
  );
  const lakeRaster = paintAreas(
    geography.lakes.map((lake) => lake.area),
    grid,
  );
  const isLand = (province: number): boolean => kind[province] === LAND;
  const isSea = (province: number): boolean => kind[province] === SEA;
  const lands = provinceModes(view, landRaster, grid, 3, isLand);
  const regions = provinceModes(view, regionRaster, grid, 3, isLand);
  const seas = provinceModes(view, seaRaster, grid, 3, isSea);
  const lakes = provinceModes(view, lakeRaster, grid, 3, (province) => !isLand(province), 0.5);
  const out = {
    land: new Int32Array(view.count).fill(-1),
    region: new Int32Array(view.count).fill(-1),
    sea: new Int32Array(view.count).fill(-1),
    lake: new Int32Array(view.count).fill(-1),
  };
  for (let province = 0; province < view.count; province += 1) {
    if (lands[province]! > 0) out.land[province] = lands[province]! - 1;
    if (regions[province]! > 0) out.region[province] = regionIndex[regions[province]! - 1]!;
    // Water inside a lake polygon belongs to the lake (an inland sea), not to the sea drawn under it.
    if (seas[province]! > 0 && lakes[province] === 0) out.sea[province] = seas[province]! - 1;
    if (lakes[province]! > 0) out.lake[province] = lakes[province]! - 1;
  }
  return out;
}

/** Nearest province to a pixel position among `candidates`, by centre distance. */
export function nearestProvince(
  source: CenterSource,
  width: number,
  candidates: readonly number[],
  x: number,
  y: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of candidates) {
    const centre = centerOf(source, id);
    const d = distanceOnMap(centre.x, centre.y, x, y, width);
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  return best;
}

export function provinceViewOf(
  provinces: WorldProvinces,
  width: number,
  height: number,
): ProvinceRasterView {
  return { width, height, pixel: provinces.pixel, count: provinces.kind.length };
}

/**
 * Pixels of province `a` that touch province `b` (4-connected), for each requested unordered pair
 * `(a, b)` given as `a * count + b` in both orders as needed. One pass over the raster.
 * Returns, for every requested key `a * count + b` (ordered), the pixel indices of `a` next to `b`.
 */
export function collectContacts(
  view: ProvinceRasterView,
  wanted: ReadonlySet<number>,
): Map<number, number[]> {
  const { width, height, pixel, count } = view;
  const out = new Map<number, number[]>();
  if (wanted.size === 0) return out;
  const touch = (own: number, other: number, at: number): void => {
    const key = own * count + other;
    if (!wanted.has(key)) return;
    let list = out.get(key);
    if (list === undefined) {
      list = [];
      out.set(key, list);
    }
    if (list[list.length - 1] !== at) list.push(at);
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const p = row + x;
      const a = pixel[p]!;
      const right = row + (x + 1 === width ? 0 : x + 1);
      const b = pixel[right]!;
      if (a !== b) {
        touch(a, b, p);
        touch(b, a, right);
      }
      if (y + 1 < height) {
        const q = p + width;
        const c = pixel[q]!;
        if (a !== c) {
          touch(a, c, p);
          touch(c, a, q);
        }
      }
    }
  }
  return out;
}

export interface ClosestApproach {
  /** Pixel distance between the nearest pair. */
  readonly gap: number;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
}

/** The nearest pair of pixels between two contact lists, subsampled to at most `limit` each. */
export function closestApproach(
  left: readonly number[],
  right: readonly number[],
  width: number,
  limit = 300,
): ClosestApproach | undefined {
  if (left.length === 0 || right.length === 0) return undefined;
  const stepL = Math.max(1, Math.ceil(left.length / limit));
  const stepR = Math.max(1, Math.ceil(right.length / limit));
  let best = Number.POSITIVE_INFINITY;
  let bestL = -1;
  let bestR = -1;
  for (let i = 0; i < left.length; i += stepL) {
    const lx = left[i]! % width;
    const ly = Math.floor(left[i]! / width);
    for (let j = 0; j < right.length; j += stepR) {
      const dx = wrapDelta(lx, right[j]! % width, width);
      const dy = ly - Math.floor(right[j]! / width);
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bestL = left[i]!;
        bestR = right[j]!;
      }
    }
  }
  return {
    gap: Math.sqrt(best),
    from: { x: bestL % width, y: Math.floor(bestL / width) },
    to: { x: bestR % width, y: Math.floor(bestR / width) },
  };
}
