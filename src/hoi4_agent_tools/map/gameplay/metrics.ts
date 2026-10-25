/**
 * Per-province measurements the development, port and naming stages read: heights, rivers, the
 * share of valley and mountain, and the fertility the model states (or the terrain implies).
 * One pass over the pixels; no randomness.
 */
import type { GeographyBiomeKind } from '../../schemas/geography.js';
import { scanAreaStrip, type ResolvedArea } from '../geography/index.js';
import { LAND, SEA, factGrid, type ProvinceRasterView } from './facts.js';
import type { PrepareInput } from './prepare.js';

export interface ProvinceMetrics {
  /** Mean heightmap value of the province's pixels. */
  readonly meanHeight: Float32Array;
  /** River pixels (index 0 to 11) inside the province. */
  readonly riverPixels: Uint32Array;
  /** Widest river index (3 to 11) inside the province, 0 for none. */
  readonly riverWidth: Uint8Array;
  /** Widest river index of a river pixel next to sea, 0 for none (a river mouth). */
  readonly mouthWidth: Uint8Array;
  /** Mean valley cut, 0 to 1. */
  readonly valley: Float32Array;
  /** Mean mountain share, 0 to 1. */
  readonly mountain: Float32Array;
  /** Fertility 0 to 1 the model states; NaN where it states none. */
  readonly stated: Float32Array;
}

/** Fertility of a biome kind when the model gives none. */
export const BIOME_FERTILITY: Readonly<Record<GeographyBiomeKind, number>> = {
  farmland: 0.9,
  plains: 0.7,
  steppe: 0.5,
  forest: 0.5,
  hills: 0.4,
  jungle: 0.35,
  marsh: 0.25,
  tundra: 0.15,
  desert: 0.1,
  ice: 0.02,
};

/** Fertility of a province terrain when nothing else is known. */
export const TERRAIN_FERTILITY: Readonly<Record<string, number>> = {
  plains: 0.7,
  urban: 0.6,
  forest: 0.55,
  hills: 0.4,
  jungle: 0.35,
  marsh: 0.25,
  desert: 0.12,
  mountain: 0.15,
  lakes: 0,
  ocean: 0,
};

export function computeMetrics(input: PrepareInput, view: ProvinceRasterView): ProvinceMetrics {
  const { width, height, geography } = input;
  const count = view.count;
  const kind = input.provinces.kind;
  const heightSum = new Float64Array(count);
  const size = new Float64Array(count);
  const riverPixels = new Uint32Array(count);
  const riverWidth = new Uint8Array(count);
  const mouthWidth = new Uint8Array(count);
  const valleySum = new Float64Array(count);
  const mountainSum = new Float64Array(count);
  const valley = input.fields?.valley;
  const mountain = input.fields?.mountain;
  const rivers = input.riverBitmap;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const p = row + x;
      const id = view.pixel[p]!;
      size[id]! += 1;
      heightSum[id]! += input.heights[p]!;
      if (valley !== undefined) valleySum[id]! += valley.data[(y >> 1) * valley.width + (x >> 1)]!;
      if (mountain !== undefined)
        mountainSum[id]! += mountain.data[(y >> 1) * mountain.width + (x >> 1)]!;
      const river = rivers[p]!;
      if (river > 11) continue;
      riverPixels[id]! += 1;
      const index = river < 3 ? 3 : river;
      if (index > riverWidth[id]!) riverWidth[id] = index;
      const touching =
        (x > 0 && kind[view.pixel[p - 1]!] === SEA) ||
        (x + 1 < width && kind[view.pixel[p + 1]!] === SEA) ||
        (y > 0 && kind[view.pixel[p - width]!] === SEA) ||
        (y + 1 < height && kind[view.pixel[p + width]!] === SEA);
      if (touching && index > mouthWidth[id]!) mouthWidth[id] = index;
    }
  }
  const meanHeight = new Float32Array(count);
  const valleyMean = new Float32Array(count);
  const mountainMean = new Float32Array(count);
  for (let id = 0; id < count; id += 1) {
    const n = Math.max(1, size[id]!);
    meanHeight[id] = heightSum[id]! / n;
    valleyMean[id] = valleySum[id]! / n / 255;
    mountainMean[id] = mountainSum[id]! / n / 255;
  }
  // Fertility the model states: land defaults, then biomes from low to high priority.
  const grid = factGrid(width, height);
  const cells = new Float32Array(grid.width * grid.height).fill(Number.NaN);
  const whole = { y0: 0, y1: grid.height };
  const paint = (area: ResolvedArea, value: number): void =>
    scanAreaStrip(area, grid, whole, (y, x0, x1) => {
      cells.fill(value, y * grid.width + x0, y * grid.width + x1);
    });
  for (const land of geography.lands)
    if (land.fertility !== undefined) paint(land.area, land.fertility);
  for (const biome of geography.biomes)
    paint(biome.area, biome.fertility ?? BIOME_FERTILITY[biome.biome]);
  const samples = new Uint32Array(count);
  const valued = new Uint32Array(count);
  const total = new Float64Array(count);
  const stride = 3;
  for (let y = 0; y < height; y += stride) {
    const gy = Math.min(grid.height - 1, Math.floor(((y + 0.5) * grid.height) / height));
    for (let x = 0; x < width; x += stride) {
      const id = view.pixel[y * width + x]!;
      if (kind[id] !== LAND) continue;
      samples[id]! += 1;
      const gx = Math.min(grid.width - 1, Math.floor(((x + 0.5) * grid.width) / width));
      const value = cells[gy * grid.width + gx]!;
      if (Number.isNaN(value)) continue;
      valued[id]! += 1;
      total[id]! += value;
    }
  }
  const stated = new Float32Array(count).fill(Number.NaN);
  for (let id = 0; id < count; id += 1)
    if (kind[id] === LAND && samples[id]! > 0 && valued[id]! * 2 >= samples[id]!)
      stated[id] = total[id]! / valued[id]!;
  return {
    meanHeight,
    riverPixels,
    riverWidth,
    mouthWidth,
    valley: valleyMean,
    mountain: mountainMean,
    stated,
  };
}

/** Fertility of a province: the model's statement, else the terrain's, plus valley and slope. */
export function fertilityOf(metrics: ProvinceMetrics, province: number, terrain: string): number {
  const stated = metrics.stated[province]!;
  let value = Number.isNaN(stated) ? (TERRAIN_FERTILITY[terrain] ?? 0.4) : stated;
  value += 0.2 * metrics.valley[province]!;
  const high = metrics.meanHeight[province]! - 140;
  if (high > 0) value -= Math.min(0.3, high / 300);
  return Math.max(0, Math.min(1, value));
}
