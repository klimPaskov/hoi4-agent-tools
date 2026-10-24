import { ServiceError } from '../core/result.js';

/**
 * The two engines of the feature-aware province partition (ADR 0058): variable-radius dart
 * throwing for seeds and a marker-controlled watershed (multi-source Dijkstra with integer costs
 * in a bucket queue) for borders. Both are deterministic: hashed priorities, no random state, no
 * floating-point function beyond `+ - * /` and `sqrt`.
 */

export function hash32(seed: number, a: number, b = 0): number {
  let n = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x7f4a7c15, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d) ^ Math.imul(b + 0x165667b1, 0x297a2d39);
  n = Math.imul(n ^ (n >>> 12), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 15), 0xc2b2ae35);
  return (n ^ (n >>> 16)) >>> 0;
}

export function unit32(value: number): number {
  return value / 4_294_967_296;
}

export interface SeedRequest {
  width: number;
  height: number;
  kind: Uint8Array;
  /** The kind value to seed: 0 sea, 1 land, 2 lake. */
  wanted: number;
  /** Planned province area in pixels at a pixel of the wanted kind. */
  areaAt: (pixel: number) => number;
  /** The smallest value `areaAt` can return; sets the candidate lattice. */
  minArea: number;
  /** Pixels at or above this barrier value are not chosen as seeds. */
  barrier?: Uint8Array;
  avoidBarrierAbove?: number;
  seed: number;
  salt: number;
}

/**
 * Candidates per final seed. Random sequential adsorption reaches about 94% of the jamming
 * density after ten attempts per disc, which fills the map without visible gaps.
 */
const OVERSAMPLE = 40;
/** Dart-throwing spacing over the square root of the planned area (jamming gives 0.834). */
export const SEED_SPACING = 0.8;

/**
 * Variable-radius Poisson-disc seeds: candidates are drawn per lattice cell with a probability
 * that follows the planned area, ordered by a hashed priority, and accepted when no accepted seed
 * lies closer than the smaller of the two spacings. Returns pixel indices in acceptance order.
 */
export function placeSeeds(request: SeedRequest): Int32Array {
  const { width, height, kind, wanted, areaAt, minArea, seed, salt } = request;
  const stride = Math.max(1, Math.floor(0.35 * SEED_SPACING * Math.sqrt(minArea)));
  const cx: number[] = [];
  const spacing: number[] = [];
  const keys: number[] = [];
  const limit = request.avoidBarrierAbove ?? 64;
  for (let y0 = 0; y0 < height; y0 += stride) {
    for (let x0 = 0; x0 < width; x0 += stride) {
      const h = hash32(seed + salt, x0 * 0x10001 + 1, y0);
      const x = Math.min(width - 1, x0 + (h % stride));
      const y = Math.min(height - 1, y0 + (((h >>> 8) >>> 0) % stride));
      const pixel = y * width + x;
      if (kind[pixel] !== wanted) continue;
      if (request.barrier !== undefined && request.barrier[pixel]! > limit) continue;
      const area = areaAt(pixel);
      const chance = (OVERSAMPLE * stride * stride) / area;
      if (chance < 1 && unit32(hash32(seed + salt, pixel, 7)) >= chance) continue;
      cx.push(pixel);
      spacing.push(SEED_SPACING * Math.sqrt(area));
      keys.push(hash32(seed + salt, pixel, 13) >>> 4);
    }
  }
  const count = cx.length;
  if (count === 0) return new Int32Array(0);
  if (count >= 1 << 24)
    throw new ServiceError(
      'MAP_PARTITION_TOO_MANY_CANDIDATES',
      'The planned province areas are too small for this map',
      { candidates: count },
    );
  const order = new Float64Array(count);
  for (let i = 0; i < count; i++) order[i] = keys[i]! * 16_777_216 + i;
  order.sort();
  let smallest = Infinity;
  for (const value of spacing) if (value < smallest) smallest = value;
  const cell = smallest / Math.SQRT2;
  const columns = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  const grid = new Int32Array(columns * rows).fill(-1);
  const seedPixels: number[] = [];
  const seedSpacing: number[] = [];
  for (let k = 0; k < count; k++) {
    const index = order[k]! % 16_777_216;
    const pixel = cx[index]!;
    const d = spacing[index]!;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const reach = Math.ceil(d / cell);
    let free = true;
    for (let dy = -reach; dy <= reach && free; dy++) {
      const row = gy + dy;
      if (row < 0 || row >= rows) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        let column = gx + dx;
        // The map wraps east-west.
        const wrapped = Math.ceil(width / cell);
        if (column < 0) column += wrapped;
        else if (column >= wrapped) column -= wrapped;
        const other = grid[row * columns + column]!;
        if (other < 0) continue;
        const ox = seedPixels[other]! % width;
        const oy = (seedPixels[other]! - ox) / width;
        let ddx = ox - x;
        if (ddx > width / 2) ddx -= width;
        else if (ddx < -width / 2) ddx += width;
        const ddy = oy - y;
        const near = Math.min(d, seedSpacing[other]!);
        if (ddx * ddx + ddy * ddy < near * near) {
          free = false;
          break;
        }
      }
    }
    if (!free) continue;
    grid[gy * columns + gx] = seedPixels.length;
    seedPixels.push(pixel);
    seedSpacing.push(d);
  }
  return Int32Array.from(seedPixels);
}

export interface WatershedInput {
  width: number;
  height: number;
  /** Pixels only exchange labels with pixels of the same kind. */
  kind: Uint8Array;
  /** Cost multiplier of entering a pixel, 256 for a plain step (see `STEP_UNIT`). */
  step: Uint16Array;
  /** Optional planes whose change between two pixels adds a fixed penalty. */
  regionId?: Uint16Array;
  regionPenalty?: number;
  terrainClass?: Uint8Array;
  terrainPenalty?: number;
  /** Seed pixels; the label of seed `i` is `i`. */
  seeds: Int32Array;
  /** Checked every 65,536 settled pixels; stops with its reason. */
  signal?: AbortSignal | undefined;
}

/** A plain step has this multiplier, and costs 10 for a cardinal move and 14 for a diagonal one. */
export const STEP_UNIT = 256;

/**
 * Label every pixel with the seed that reaches it at the least cost. The cost of a move onto pixel
 * `q` is `base * step[q] / 256` plus a penalty when the region or terrain class changes, so
 * wavefronts slow down on natural lines and meet on them. Ties go to the first arrival. The
 * result labels exactly the pixels connected to a seed through pixels of one kind (eight
 * neighbours, wrapping east-west).
 */
export function weightedWatershed(input: WatershedInput): Int32Array {
  const { width, height, kind, step, seeds } = input;
  const total = width * height;
  const regionPenalty = input.regionPenalty ?? 0;
  const terrainPenalty = input.terrainPenalty ?? 0;
  const region = input.regionId;
  const terrain = input.terrainClass;
  let maxStep = 0;
  for (let p = 0; p < total; p++) if (step[p]! > maxStep) maxStep = step[p]!;
  const maxCost = ((14 * maxStep) >> 8) + 1 + regionPenalty + terrainPenalty;
  let buckets = 1;
  while (buckets <= maxCost) buckets <<= 1;
  const mask = buckets - 1;
  const heads = new Int32Array(buckets).fill(-1);
  let capacity = Math.max(1 << 16, seeds.length * 4);
  let nodePixel = new Int32Array(capacity);
  let nodeNext = new Int32Array(capacity);
  let used = 0;
  let free = -1;
  let live = 0;
  const distance = new Int32Array(total).fill(0x7fffffff);
  const labels = new Int32Array(total).fill(-1);
  const push = (cost: number, pixel: number): void => {
    let node: number;
    if (free >= 0) {
      node = free;
      free = nodeNext[node]!;
    } else {
      if (used === capacity) {
        capacity *= 2;
        const pixels = new Int32Array(capacity);
        pixels.set(nodePixel);
        nodePixel = pixels;
        const next = new Int32Array(capacity);
        next.set(nodeNext);
        nodeNext = next;
      }
      node = used++;
    }
    const bucket = cost & mask;
    nodePixel[node] = pixel;
    nodeNext[node] = heads[bucket]!;
    heads[bucket] = node;
    live++;
  };
  for (let i = 0; i < seeds.length; i++) {
    const p = seeds[i]!;
    if (labels[p] !== -1) continue;
    labels[p] = i;
    distance[p] = 0;
    push(0, p);
  }
  const relax = (q: number, from: number, current: number, base: number, label: number): void => {
    let cost = current + ((base * step[q]!) >> 8);
    if (region !== undefined && region[q] !== region[from]) cost += regionPenalty;
    if (terrain !== undefined && terrain[q] !== terrain[from]) cost += terrainPenalty;
    if (cost < distance[q]!) {
      distance[q] = cost;
      labels[q] = label;
      push(cost, q);
    }
  };
  const last = width - 1;
  const signal = input.signal;
  let settled = 0;
  for (let current = 0; live > 0; current++) {
    const bucket = current & mask;
    while (heads[bucket]! !== -1) {
      const node = heads[bucket]!;
      heads[bucket] = nodeNext[node]!;
      const p = nodePixel[node]!;
      nodeNext[node] = free;
      free = node;
      live--;
      if (distance[p] !== current) continue;
      if ((++settled & 0xffff) === 0) signal?.throwIfAborted();
      const y = (p / width) | 0;
      const x = p - y * width;
      const label = labels[p]!;
      const here = kind[p]!;
      const west = x > 0 ? p - 1 : p + last;
      const east = x < last ? p + 1 : p - last;
      if (kind[west] === here) relax(west, p, current, 10, label);
      if (kind[east] === here) relax(east, p, current, 10, label);
      if (y > 0) {
        const north = p - width;
        const northWest = x > 0 ? north - 1 : north + last;
        const northEast = x < last ? north + 1 : north - last;
        if (kind[north] === here) relax(north, p, current, 10, label);
        if (kind[northWest] === here) relax(northWest, p, current, 14, label);
        if (kind[northEast] === here) relax(northEast, p, current, 14, label);
      }
      if (y < height - 1) {
        const south = p + width;
        const southWest = x > 0 ? south - 1 : south + last;
        const southEast = x < last ? south + 1 : south - last;
        if (kind[south] === here) relax(south, p, current, 10, label);
        if (kind[southWest] === here) relax(southWest, p, current, 14, label);
        if (kind[southEast] === here) relax(southEast, p, current, 14, label);
      }
    }
  }
  return labels;
}
