import { ServiceError } from '../core/result.js';
import { assembleWorldProvinces, assertProvinceMaskFeasible } from './world-provinces.js';
import type { WorldProvinces } from './world-provinces.js';
import { assertPartitionFields, PARTITION_KIND, PARTITION_TERRAIN } from './partition-fields.js';
import type { PartitionFields } from './partition-fields.js';
import type { ResolvedPartitionTuning } from './partition-tuning.js';
import { PARTITION_PROVINCE_ERROR } from './partition-tuning.js';
import { hash32, placeSeeds, STEP_UNIT, unit32, weightedWatershed } from './partition-watershed.js';

/**
 * Feature-aware provinces (ADR 0058). The land is cut by a marker-controlled watershed whose
 * cost rises on rivers, ridges, steep slopes, walls and shores, so borders prefer natural lines;
 * seeds are drawn at a density that follows terrain, fertility, coast and river proximity and the
 * density of the geography region, so provinces are small in rich valleys and on coasts and large
 * in wilderness. Sea provinces are small near coasts and large in the open sea, and a narrow
 * channel keeps two sea provinces across it. The result goes through the same finishing passes as
 * the legacy partition, so every engine rule it keeps (connected provinces, the bounding box
 * limit, no four-province corner, 65,000 provinces) holds here too.
 */

/** A piece cut off by a river smaller than this rejoins the province it was cut from. */
const MIN_PIECE_PIXELS = 8;

const LAND = PARTITION_KIND.land;
const SEA = PARTITION_KIND.sea;
const LAKE = PARTITION_KIND.lake;

export interface FeaturePartitionInput {
  fields: PartitionFields;
  tuning: ResolvedPartitionTuning;
  seed: number;
  /** Checked between the stages and inside the watershed; stops with its reason. */
  signal?: AbortSignal | undefined;
}

export interface SizeStatistics {
  count: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

export interface PartitionStatistics {
  land: SizeStatistics;
  sea: SizeStatistics;
  lake: SizeStatistics;
  /** Provinces the planned densities expected before the finishing passes. */
  expectedProvinces: number;
}

export interface FeatureProvinces {
  provinces: WorldProvinces;
  /** Natural-line strength 0 to 255 at every pixel: the cost field the borders followed. */
  barrier: Uint8Array;
  statistics: PartitionStatistics;
}

const EMPTY_STATISTICS: SizeStatistics = {
  count: 0,
  min: 0,
  p10: 0,
  median: 0,
  p90: 0,
  max: 0,
  mean: 0,
};

function statisticsOf(sizes: number[]): SizeStatistics {
  if (sizes.length === 0) return EMPTY_STATISTICS;
  const sorted = Float64Array.from(sizes).sort();
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    min: sorted[0]!,
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1]!,
    mean: Math.round((sum / sorted.length) * 100) / 100,
  };
}

/** Size distribution of the provinces of each kind. */
export function provinceStatistics(
  provinces: Pick<WorldProvinces, 'kind' | 'size'>,
  expectedProvinces = 0,
): PartitionStatistics {
  const by: number[][] = [[], [], []];
  for (let id = 0; id < provinces.kind.length; id++)
    by[provinces.kind[id]!]!.push(provinces.size[id]!);
  return {
    land: statisticsOf(by[LAND]!),
    sea: statisticsOf(by[SEA]!),
    lake: statisticsOf(by[LAKE]!),
    expectedProvinces,
  };
}

// ---------------------------------------------------------------------------------------------
// Distances to the coast

interface Shore {
  /** Land: pixels to the nearest water. Water: pixels to the nearest land. Capped at 255. */
  distance: Uint8Array;
  /** Water: id of the nearest land mass (1 and up, 65,535 for the overflow). Land: its own mass. */
  mass: Uint16Array;
}

/** Land masses (eight-connected, wrapping east-west) numbered from 1 in raster order. */
function labelLandMasses(kind: Uint8Array, width: number, height: number, queue: Int32Array) {
  const total = width * height;
  const mass = new Uint16Array(total);
  let next = 0;
  for (let start = 0; start < total; start++) {
    if (kind[start] !== LAND || mass[start] !== 0) continue;
    next = Math.min(65_535, next + 1);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    mass[start] = next;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
          const q = ny * width + nx;
          if (kind[q] !== LAND || mass[q] !== 0) continue;
          mass[q] = next;
          queue[tail++] = q;
        }
      }
    }
  }
  return mass;
}

/** Breadth-first distance (four neighbours) from the land into the water, carrying the land mass. */
function waterShore(
  kind: Uint8Array,
  landMass: Uint16Array,
  width: number,
  height: number,
  queue: Int32Array,
): Shore {
  const total = width * height;
  const distance = new Uint8Array(total).fill(255);
  const mass = new Uint16Array(total);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < total; p++)
    if (kind[p] === LAND) {
      distance[p] = 0;
      mass[p] = landMass[p]!;
      queue[tail++] = p;
    }
  while (head < tail) {
    const p = queue[head++]!;
    const d = distance[p]!;
    if (d >= 254) continue;
    const x = p % width;
    const neighbours = [
      x > 0 ? p - 1 : p + width - 1,
      x + 1 < width ? p + 1 : p - width + 1,
      p >= width ? p - width : -1,
      p + width < total ? p + width : -1,
    ];
    for (const q of neighbours) {
      if (q < 0 || distance[q] !== 255 || kind[q] === LAND) continue;
      distance[q] = d + 1;
      mass[q] = mass[p]!;
      queue[tail++] = q;
    }
  }
  return { distance, mass };
}

/** Breadth-first distance (four neighbours) from the water into the land. */
function landCoastDistance(
  kind: Uint8Array,
  width: number,
  height: number,
  queue: Int32Array,
): Uint8Array {
  const total = width * height;
  const distance = new Uint8Array(total).fill(255);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < total; p++)
    if (kind[p] !== LAND) {
      distance[p] = 0;
      queue[tail++] = p;
    }
  while (head < tail) {
    const p = queue[head++]!;
    const d = distance[p]!;
    if (d >= 254) continue;
    const x = p % width;
    const neighbours = [
      x > 0 ? p - 1 : p + width - 1,
      x + 1 < width ? p + 1 : p - width + 1,
      p >= width ? p - width : -1,
      p + width < total ? p + width : -1,
    ];
    for (const q of neighbours) {
      if (q < 0 || distance[q] !== 255) continue;
      distance[q] = d + 1;
      queue[tail++] = q;
    }
  }
  void height;
  return distance;
}

// ---------------------------------------------------------------------------------------------
// Cost fields

/** River, ridge, slope, shore and wall strength at every pixel (the plan's barrier field B). */
export function buildBarrierField(
  fields: PartitionFields,
  tuning: ResolvedPartitionTuning,
  seaShore: Uint8Array | undefined,
): Uint8Array {
  const { width, height, kind } = fields;
  const total = width * height;
  const barrier = new Uint8Array(total);
  const shelf = Math.round(Math.sqrt(tuning.seaArea.open) * 1.1);
  const shelfLine = tuning.seaArea.open > tuning.seaArea.coastal * 1.5 && seaShore !== undefined;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const k = kind[p]!;
      if (k === SEA) {
        // A faint contour along the shelf edge: sea borders follow the coast.
        if (shelfLine && Math.abs(seaShore[p]! - shelf) <= 1) barrier[p] = 110;
        continue;
      }
      if (k === LAKE) continue;
      const river = fields.riverDistance[p]!;
      let value = river === 0 ? 255 : river === 1 ? 170 : river === 2 ? 70 : 0;
      const slope = fields.slope[p]!;
      if (slope > 16) {
        const s = slope >= 64 ? 255 : Math.round(((slope - 16) * 255) / 48);
        if (s > value) value = s;
      }
      const ridge = Math.round(fields.ridge[p]! * 0.65);
      if (ridge > value) value = ridge;
      const wall = fields.barrier[p]!;
      if (wall > value) value = wall;
      if (value < 90) {
        const left = x === 0 ? width - 1 : x - 1;
        const right = x === width - 1 ? 0 : x + 1;
        if (
          kind[row + left] === LAKE ||
          kind[row + right] === LAKE ||
          (y > 0 && kind[p - width] === LAKE) ||
          (y < height - 1 && kind[p + width] === LAKE)
        )
          value = 90;
      }
      barrier[p] = value;
    }
  }
  return barrier;
}

/** Periodic value noise on a coarse lattice, interpolated per pixel; `[-1, 1]`. */
function coarseNoise(
  seed: number,
  width: number,
  height: number,
  cell: number,
  write: (pixel: number, value: number) => void,
  wanted: (pixel: number) => boolean,
): void {
  const columns = Math.max(2, Math.round(width / cell));
  const gx = width / columns;
  const gy = Math.max(2, cell);
  const rowA = new Float32Array(columns + 1);
  const rowB = new Float32Array(columns + 1);
  let lastRow = -1;
  for (let y = 0; y < height; y++) {
    const fy = y / gy;
    const iy = Math.floor(fy);
    if (iy !== lastRow) {
      for (let c = 0; c <= columns; c++) {
        rowA[c] = unit32(hash32(seed, (c % columns) + 1, iy));
        rowB[c] = unit32(hash32(seed, (c % columns) + 1, iy + 1));
      }
      lastRow = iy;
    }
    const ty = fy - iy;
    const sy = ty * ty * (3 - 2 * ty);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!wanted(row + x)) continue;
      const fx = x / gx;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const sx = tx * tx * (3 - 2 * tx);
      const a = rowA[ix]! + (rowA[ix + 1]! - rowA[ix]!) * sx;
      const b = rowB[ix]! + (rowB[ix + 1]! - rowB[ix]!) * sx;
      write(row + x, (a + (b - a) * sy) * 2 - 1);
    }
  }
}

/** Cost multiplier of entering each pixel, 256 for a plain step. */
export function buildStepField(
  fields: PartitionFields,
  barrier: Uint8Array,
  tuning: ResolvedPartitionTuning,
  seed: number,
): Uint16Array {
  const { width, height, kind } = fields;
  const step = new Uint16Array(width * height);
  const beta = tuning.barrierStrength;
  for (let p = 0; p < step.length; p++) {
    const value = STEP_UNIT * (1 + (beta * barrier[p]!) / 255);
    step[p] = value > 65_000 ? 65_000 : Math.round(value);
  }
  // Jitter keeps borders between featureless cells from being straight bisectors.
  const landCell = Math.max(4, Math.round(0.6 * Math.sqrt(tuning.landArea.plains)));
  const seaCell = Math.max(4, Math.round(0.5 * Math.sqrt(tuning.seaArea.open)));
  const jitter = (amplitude: number) => (pixel: number, value: number) => {
    const next = Math.round(step[pixel]! * (1 + amplitude * value));
    step[pixel] = next < 32 ? 32 : next > 65_000 ? 65_000 : next;
  };
  coarseNoise(seed + 101, width, height, landCell, jitter(0.12), (p) => kind[p] === LAND);
  coarseNoise(seed + 211, width, height, seaCell, jitter(0.3), (p) => kind[p] !== LAND);
  return step;
}

// ---------------------------------------------------------------------------------------------
// Planned areas

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

interface AreaPlanner {
  land: (pixel: number) => number;
  sea: (pixel: number) => number;
  minLand: number;
  minSea: number;
  expected: number;
}

function planAreas(
  fields: PartitionFields,
  tuning: ResolvedPartitionTuning,
  coastDistance: Uint8Array,
  seaDistance: Uint8Array,
): AreaPlanner {
  const { width, height, kind } = fields;
  const t = tuning;
  const classSqrt = new Float64Array(256).fill(Math.sqrt(t.landArea.plains));
  const set = (value: number, ...classes: number[]): void => {
    for (const c of classes) classSqrt[c] = Math.sqrt(value);
  };
  set(t.landArea.fertile, PARTITION_TERRAIN.farmland);
  set(t.landArea.fertile * 0.7, PARTITION_TERRAIN.urban);
  set(t.landArea.hills, PARTITION_TERRAIN.hills);
  set(t.landArea.mountain, PARTITION_TERRAIN.mountain);
  set(t.landArea.waste, PARTITION_TERRAIN.desert, PARTITION_TERRAIN.snow);
  const sqrtFertile = Math.sqrt(t.landArea.fertile);
  const coastReach = 2 * sqrtFertile;
  const riverReach = 1.2 * sqrtFertile;
  const regionScale = new Float32Array(65_536).fill(1);
  for (const region of fields.regions ?? [])
    if (region.provinceAreaPx !== undefined)
      regionScale[region.id] = region.provinceAreaPx / t.landArea.plains;
  const landRaw = (pixel: number): number => {
    let s = classSqrt[fields.terrainClass[pixel]!]!;
    const f = fields.fertility[pixel]! / 255;
    if (f > 0.4 && s > sqrtFertile) s += (sqrtFertile - s) * 0.7 * smoothstep((f - 0.4) / 0.5);
    let area = s * s;
    const coast = coastDistance[pixel]!;
    if (coast < coastReach) area *= 1 - 0.25 * (1 - coast / coastReach);
    const river = fields.riverDistance[pixel]!;
    if (river < riverReach) area *= 1 - 0.2 * (1 - river / riverReach);
    const region = fields.regionId[pixel]!;
    if (region !== 0) area *= regionScale[region]!;
    return area;
  };
  const near = Math.sqrt(t.seaArea.coastal) * 0.5;
  const far = near + 2.2 * Math.sqrt(t.seaArea.open);
  const sqrtCoastal = Math.sqrt(t.seaArea.coastal);
  const sqrtOpen = Math.sqrt(t.seaArea.open);
  const seaRaw = (pixel: number): number => {
    const w = smoothstep((seaDistance[pixel]! - near) / (far - near));
    const s = sqrtCoastal + (sqrtOpen - sqrtCoastal) * w;
    return s * s;
  };
  // Sample the plan on a coarse grid: the mean planned areas, then the smallest areas and the
  // expected province count once the plan is scaled to the request's base areas.
  let landSamples = 0;
  let seaSamples = 0;
  let landInverse = 0;
  let seaInverse = 0;
  for (let y = 2; y < height; y += 4)
    for (let x = 2; x < width; x += 4) {
      const p = y * width + x;
      if (kind[p] === LAND) {
        landSamples++;
        landInverse += 1 / Math.max(1, landRaw(p));
      } else if (kind[p] === SEA) {
        seaSamples++;
        seaInverse += 1 / Math.max(1, seaRaw(p));
      }
    }
  // The mean count is samples / area, so a scale of (sum of 1/raw) * base / samples gives the base.
  const landScale =
    t.normalizeLand && landSamples > 0 ? (landInverse * t.landBase) / landSamples : 1;
  const seaScale = t.normalizeSea && seaSamples > 0 ? (seaInverse * t.seaBase) / seaSamples : 1;
  const clampArea = (area: number): number =>
    area < t.minProvincePixels
      ? t.minProvincePixels
      : area > t.maxProvincePixels
        ? t.maxProvincePixels
        : area;
  const land = (pixel: number): number => clampArea(landRaw(pixel) * landScale);
  const sea = (pixel: number): number =>
    kind[pixel] === LAKE ? t.lakeArea : clampArea(seaRaw(pixel) * seaScale);
  let minLand = Infinity;
  let minSea = Infinity;
  let expected = 0;
  for (let y = 2; y < height; y += 4)
    for (let x = 2; x < width; x += 4) {
      const p = y * width + x;
      if (kind[p] === LAND) {
        const a = land(p);
        if (a < minLand) minLand = a;
        expected += 16 / a;
      } else {
        const a = sea(p);
        if (kind[p] === SEA && a < minSea) minSea = a;
        expected += 16 / a;
      }
    }
  return {
    land,
    sea,
    minLand: Number.isFinite(minLand) ? minLand : t.minProvincePixels,
    minSea: Number.isFinite(minSea) ? minSea : t.minProvincePixels,
    expected,
  };
}

// ---------------------------------------------------------------------------------------------
// Seeds for components the dart throwing missed

/** One seed in every connected piece of one kind (eight neighbours, wrapping) that has none. */
function seedMissedComponents(
  kind: Uint8Array,
  width: number,
  height: number,
  seeded: Uint8Array,
  queue: Int32Array,
): number[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const extra: number[] = [];
  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;
    const here = kind[start]!;
    let head = 0;
    let tail = 0;
    let hasSeed = false;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const p = queue[head++]!;
      if (seeded[p]) hasSeed = true;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
          const q = ny * width + nx;
          if (visited[q] || kind[q] !== here) continue;
          visited[q] = 1;
          queue[tail++] = q;
        }
      }
    }
    if (!hasSeed) extra.push(start);
  }
  return extra;
}

// ---------------------------------------------------------------------------------------------
// Splitting along rivers and narrow straits

/**
 * A province that still straddles a river or wall is cut along it: its pieces (four-connected
 * once the line is removed) each become a province, unless a piece is smaller than the minimum,
 * which stays with its larger neighbour. Returns the number of provinces added.
 */
function splitAcrossLines(
  fields: PartitionFields,
  labels: Int32Array,
  minPixels: number,
  queue: Int32Array,
): number {
  const { width, height, kind } = fields;
  const total = width * height;
  const hard = (p: number): boolean =>
    kind[p] === LAND && (fields.riverDistance[p] === 0 || fields.barrier[p]! >= 200);
  const piece = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < total; start++) {
    if (piece[start] !== -1 || kind[start] !== LAND || hard(start)) continue;
    const id = sizes.length;
    const label = labels[start]!;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    piece[start] = id;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % width;
      const neighbours = [
        x > 0 ? p - 1 : p + width - 1,
        x + 1 < width ? p + 1 : p - width + 1,
        p >= width ? p - width : -1,
        p + width < total ? p + width : -1,
      ];
      for (const q of neighbours)
        if (q >= 0 && piece[q] === -1 && labels[q] === label && kind[q] === LAND && !hard(q)) {
          piece[q] = id;
          queue[tail++] = q;
        }
    }
    sizes.push(tail);
  }
  // Line pixels join the smallest-numbered neighbouring piece of the same province.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let p = 0; p < total; p++) {
      if (piece[p] !== -1 || kind[p] !== LAND) continue;
      const x = p % width;
      let best = -1;
      for (const q of [
        x > 0 ? p - 1 : p + width - 1,
        x + 1 < width ? p + 1 : p - width + 1,
        p >= width ? p - width : -1,
        p + width < total ? p + width : -1,
      ])
        if (
          q >= 0 &&
          piece[q]! >= 0 &&
          labels[q] === labels[p] &&
          (best === -1 || piece[q]! < best)
        )
          best = piece[q]!;
      if (best >= 0) {
        piece[p] = best;
        sizes[best]!++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (let p = 0; p < total; p++)
    if (piece[p] === -1 && kind[p] === LAND) {
      piece[p] = sizes.length;
      sizes.push(1);
    }
  // A small piece next to another piece of its province joins the largest such neighbour.
  const parent = Int32Array.from({ length: sizes.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const best = new Int32Array(sizes.length).fill(-1);
  for (let p = 0; p < total; p++) {
    if (kind[p] !== LAND) continue;
    const x = p % width;
    for (const q of [x + 1 < width ? p + 1 : -1, p + width < total ? p + width : -1]) {
      if (q < 0 || kind[q] !== LAND || labels[q] !== labels[p] || piece[q] === piece[p]) continue;
      const a = piece[p]!;
      const b = piece[q]!;
      if (sizes[a]! < minPixels && (best[a] === -1 || sizes[b]! > sizes[best[a]!]!)) best[a] = b;
      if (sizes[b]! < minPixels && (best[b] === -1 || sizes[a]! > sizes[best[b]!]!)) best[b] = a;
    }
  }
  const order = Array.from({ length: sizes.length }, (_, i) => i)
    .filter((i) => sizes[i]! < minPixels && best[i] !== -1)
    .sort((a, b) => sizes[a]! - sizes[b]! || a - b);
  for (const i of order) {
    const target = find(best[i]!);
    const source = find(i);
    if (target === source) continue;
    parent[source] = target;
    sizes[target]! += sizes[source]!;
    sizes[source] = 0;
  }
  let maxLabel = 0;
  for (let p = 0; p < total; p++) if (labels[p]! > maxLabel) maxLabel = labels[p]!;
  const distinct = new Map<number, number>();
  let added = 0;
  const original = new Set<number>();
  for (let p = 0; p < total; p++) {
    if (kind[p] !== LAND) continue;
    const root = find(piece[p]!);
    let id = distinct.get(root);
    if (id === undefined) {
      id = maxLabel + 1 + distinct.size;
      distinct.set(root, id);
      added++;
    }
    original.add(labels[p]!);
    labels[p] = id;
  }
  return added - original.size;
}

/**
 * A sea province that fills a narrow channel between two land masses is cut along the middle of
 * the channel by the nearest land mass, so crossing the strait takes two sea provinces. Provinces
 * with more than three significant shores (island groups) are left whole.
 */
function splitNarrowStraits(
  fields: PartitionFields,
  labels: Int32Array,
  shore: Shore,
  narrowPx: number,
  minSide: number,
): number {
  const { width, height, kind } = fields;
  const total = width * height;
  const half = narrowPx / 2 + 1;
  const widest = new Map<number, number>();
  for (let p = 0; p < total; p++) {
    if (kind[p] !== SEA) continue;
    const label = labels[p]!;
    const d = shore.distance[p]!;
    const previous = widest.get(label);
    if (previous === undefined || d > previous) widest.set(label, d);
  }
  const counts = new Map<number, number>();
  for (let p = 0; p < total; p++) {
    if (kind[p] !== SEA) continue;
    const label = labels[p]!;
    if (widest.get(label)! > half) continue;
    const key = label * 65_536 + shore.mass[p]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const significant = new Map<number, number[]>();
  for (const [key, count] of counts) {
    if (count < minSide) continue;
    const label = Math.floor(key / 65_536);
    const list = significant.get(label) ?? [];
    list.push(key % 65_536);
    significant.set(label, list);
  }
  const split = new Map<number, number[]>();
  for (const [label, masses] of significant)
    if (masses.length >= 2 && masses.length <= 3)
      split.set(
        label,
        masses.sort((a, b) => a - b),
      );
  if (split.size === 0) return 0;
  let maxLabel = 0;
  for (let p = 0; p < total; p++) if (labels[p]! > maxLabel) maxLabel = labels[p]!;
  const fresh = new Map<number, number>();
  let created = 0;
  for (let p = 0; p < total; p++) {
    if (kind[p] !== SEA) continue;
    const label = labels[p]!;
    const masses = split.get(label);
    if (masses === undefined) continue;
    const mass = masses.includes(shore.mass[p]!) ? shore.mass[p]! : masses[0]!;
    if (mass === masses[0]) continue;
    const key = label * 65_536 + mass;
    let id = fresh.get(key);
    if (id === undefined) {
      id = maxLabel + 1 + fresh.size;
      fresh.set(key, id);
      created++;
    }
    labels[p] = id;
  }
  return created;
}

// ---------------------------------------------------------------------------------------------
// The partition

export interface FeaturePartitionDiagnostics {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface FeaturePartitionResult extends FeatureProvinces {
  notes: FeaturePartitionDiagnostics[];
}

/**
 * Cut the map into provinces along its natural lines. Throws `MAP_PARTITION_*` for fields that
 * are inconsistent or a plan that needs more than 21,000 provinces, and the legacy
 * `MAP_WORLD_*` codes when the exact mask cannot be represented.
 */
export function partitionProvinces(input: FeaturePartitionInput): FeaturePartitionResult {
  const { fields, tuning } = input;
  assertPartitionFields(fields);
  if (!Number.isSafeInteger(input.seed))
    throw new ServiceError(
      'MAP_PARTITION_FIELDS_INVALID',
      'The partition seed must be a safe integer',
    );
  assertProvinceMaskFeasible(fields);
  const { width, height, kind } = fields;
  const total = width * height;
  const queue = new Int32Array(total);
  const landMass = labelLandMasses(kind, width, height, queue);
  const shore = waterShore(kind, landMass, width, height, queue);
  const coastDistance = landCoastDistance(kind, width, height, queue);
  const plan = planAreas(fields, tuning, coastDistance, shore.distance);
  const notes: FeaturePartitionDiagnostics[] = [];
  const expected = Math.round(plan.expected);
  if (expected > PARTITION_PROVINCE_ERROR)
    throw new ServiceError(
      'MAP_PARTITION_PROVINCE_COUNT_HIGH',
      `The planned province areas give about ${expected} provinces, above the 21,000 the wiki advises and the text tables allow; raise landProvincePixels, seaProvincePixels or partitionTuning.landArea and seaArea`,
      { expectedProvinces: expected, maximum: PARTITION_PROVINCE_ERROR },
    );
  const { signal } = input;
  signal?.throwIfAborted();
  const barrier = buildBarrierField(fields, tuning, shore.distance);
  const step = buildStepField(fields, barrier, tuning, input.seed);
  signal?.throwIfAborted();
  // Seeds: land, sea and lakes each at their own density.
  const seeded = new Uint8Array(total);
  const seeds: number[] = [];
  const addSeeds = (pixels: Int32Array): void => {
    for (const pixel of pixels) {
      seeds.push(pixel);
      seeded[pixel] = 1;
    }
  };
  addSeeds(
    placeSeeds({
      width,
      height,
      kind,
      wanted: LAND,
      areaAt: plan.land,
      minArea: Math.max(tuning.minProvincePixels, plan.minLand * 0.85),
      barrier,
      seed: input.seed,
      salt: 17,
    }),
  );
  addSeeds(
    placeSeeds({
      width,
      height,
      kind,
      wanted: SEA,
      areaAt: plan.sea,
      minArea: Math.max(tuning.minProvincePixels, plan.minSea * 0.85),
      seed: input.seed,
      salt: 29,
    }),
  );
  addSeeds(
    placeSeeds({
      width,
      height,
      kind,
      wanted: LAKE,
      areaAt: plan.sea,
      minArea: tuning.lakeArea,
      seed: input.seed,
      salt: 43,
    }),
  );
  for (const pixel of seedMissedComponents(kind, width, height, seeded, queue)) seeds.push(pixel);
  signal?.throwIfAborted();
  if (seeds.length > 65_000)
    throw new ServiceError(
      'MAP_WORLD_TOO_MANY_PROVINCES',
      'The planned densities need more than 65,000 provinces; raise the province target areas',
      { provinces: seeds.length },
    );
  const lines = new Uint8Array(total);
  for (let p = 0; p < total; p++)
    if (kind[p] === LAND && (fields.riverDistance[p] === 0 || fields.barrier[p]! >= 200))
      lines[p] = 1;
  const usesRegions = fields.regions !== undefined || fields.regionId.some((v) => v !== 0);
  const labels = weightedWatershed({
    width,
    height,
    kind,
    step,
    ...(usesRegions ? { regionId: fields.regionId, regionPenalty: 3_000 } : {}),
    terrainClass: fields.terrainClass,
    terrainPenalty: 30,
    seeds: Int32Array.from(seeds),
    signal,
  });
  const rivers = splitAcrossLines(fields, labels, MIN_PIECE_PIXELS, queue);
  signal?.throwIfAborted();
  const straits = splitNarrowStraits(
    fields,
    labels,
    shore,
    tuning.narrowStraitPx,
    Math.max(12, Math.round(tuning.minProvincePixels / 2)),
  );
  if (rivers > 0 || straits > 0)
    notes.push({
      code: 'MAP_PARTITION_SPLITS',
      severity: 'info',
      message: `Cut ${rivers} province(s) along rivers or walls and ${straits} sea province(s) along narrow straits`,
      details: { riverSplits: rivers, straitSplits: straits },
    });
  signal?.throwIfAborted();
  const provinces = assembleWorldProvinces(
    {
      width,
      height,
      kind,
      ...(usesRegions ? { group: fields.regionId } : {}),
      line: lines,
    },
    labels,
  );
  return { provinces, barrier, statistics: provinceStatistics(provinces, expected), notes };
}
