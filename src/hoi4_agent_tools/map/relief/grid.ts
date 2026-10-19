/**
 * Raster helpers for relief and hydrology synthesis: bilinear sampling, chamfer distances,
 * component labelling and a packed binary heap. All results are deterministic.
 */
import { SQRT2 } from './math.js';

export interface GridSize {
  readonly width: number;
  readonly height: number;
}

/** Cell kinds used throughout the synthesis: the same codes as the world generator. */
export const SEA = 0;
export const LAND = 1;
export const LAKE = 2;

/** Bilinear sample at continuous cell coordinates; cell centres lie on integers. Clamped at the border. */
export function bilinear(
  field: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const fu = u < 0 ? 0 : u > width - 1 ? width - 1 : u;
  const fv = v < 0 ? 0 : v > height - 1 ? height - 1 : v;
  const x0 = Math.floor(fu);
  const y0 = Math.floor(fv);
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const tx = fu - x0;
  const ty = fv - y0;
  const a = field[y0 * width + x0]!;
  const b = field[y0 * width + x1]!;
  const c = field[y1 * width + x0]!;
  const d = field[y1 * width + x1]!;
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/**
 * Euclidean-like distance in cells from every cell to the nearest cell where `source` is non-zero,
 * by a two-pass chamfer with weights 1 and sqrt(2). Cells farther than `limit` hold `limit`.
 */
export function chamferDistance(
  source: Uint8Array,
  width: number,
  height: number,
  limit = 65_535,
): Float32Array {
  const distance = new Float32Array(width * height);
  for (let index = 0; index < distance.length; index += 1)
    distance[index] = source[index] !== 0 ? 0 : limit;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let best = distance[index]!;
      if (best === 0) continue;
      if (x > 0) best = Math.min(best, distance[index - 1]! + 1);
      if (y > 0) {
        best = Math.min(best, distance[index - width]! + 1);
        if (x > 0) best = Math.min(best, distance[index - width - 1]! + SQRT2);
        if (x < width - 1) best = Math.min(best, distance[index - width + 1]! + SQRT2);
      }
      distance[index] = best;
    }
  for (let y = height - 1; y >= 0; y -= 1)
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let best = distance[index]!;
      if (best === 0) continue;
      if (x < width - 1) best = Math.min(best, distance[index + 1]! + 1);
      if (y < height - 1) {
        best = Math.min(best, distance[index + width]! + 1);
        if (x < width - 1) best = Math.min(best, distance[index + width + 1]! + SQRT2);
        if (x > 0) best = Math.min(best, distance[index + width - 1]! + SQRT2);
      }
      distance[index] = best > limit ? limit : best;
    }
  return distance;
}

/** Offsets of the eight neighbours: east, south-east, south, south-west, west, north-west, north, north-east. */
export const NEIGHBOUR_DX: readonly number[] = [1, 1, 0, -1, -1, -1, 0, 1];
export const NEIGHBOUR_DY: readonly number[] = [0, 1, 1, 1, 0, -1, -1, -1];
export const NEIGHBOUR_LENGTH: readonly number[] = [1, SQRT2, 1, SQRT2, 1, SQRT2, 1, SQRT2];

/**
 * Four-connected components of cells for which `inside` is true. Returns the per-cell component
 * index (-1 outside any component), the component sizes and one seed cell of each.
 */
export function labelComponents(
  width: number,
  height: number,
  inside: (index: number) => boolean,
): { label: Int32Array; sizes: number[]; seeds: number[] } {
  const total = width * height;
  const label = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  const seeds: number[] = [];
  const queue = new Int32Array(total);
  for (let start = 0; start < total; start += 1) {
    if (label[start] !== -1 || !inside(start)) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const cell = queue[head++]!;
      const x = cell % width;
      if (x > 0 && label[cell - 1] === -1 && inside(cell - 1)) {
        label[cell - 1] = id;
        queue[tail++] = cell - 1;
      }
      if (x < width - 1 && label[cell + 1] === -1 && inside(cell + 1)) {
        label[cell + 1] = id;
        queue[tail++] = cell + 1;
      }
      if (cell >= width && label[cell - width] === -1 && inside(cell - width)) {
        label[cell - width] = id;
        queue[tail++] = cell - width;
      }
      if (cell < total - width && label[cell + width] === -1 && inside(cell + width)) {
        label[cell + width] = id;
        queue[tail++] = cell + width;
      }
    }
    sizes.push(tail);
    seeds.push(start);
  }
  return { label, sizes, seeds };
}

/**
 * A packed binary min-heap of (key, id) pairs. Ties on the key are broken by the smaller id, so the
 * pop order never depends on insertion history.
 */
export class MinHeap {
  #keys: Float32Array;
  #ids: Int32Array;
  #length = 0;
  /** The key of the entry returned by the last `pop`. */
  popKey = 0;

  constructor(capacity: number) {
    this.#keys = new Float32Array(capacity);
    this.#ids = new Int32Array(capacity);
  }

  get length(): number {
    return this.#length;
  }

  clear(): void {
    this.#length = 0;
  }

  push(key: number, id: number): void {
    if (this.#length === this.#keys.length) {
      // Lazy-deletion searches push a cell more than once: grow instead of dropping entries.
      const keys = new Float32Array(this.#keys.length * 2);
      const ids = new Int32Array(this.#ids.length * 2);
      keys.set(this.#keys);
      ids.set(this.#ids);
      this.#keys = keys;
      this.#ids = ids;
    }
    let index = this.#length++;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      const parentKey = this.#keys[parent]!;
      if (!(key < parentKey || (key === parentKey && id < this.#ids[parent]!))) break;
      this.#keys[index] = parentKey;
      this.#ids[index] = this.#ids[parent]!;
      index = parent;
    }
    this.#keys[index] = key;
    this.#ids[index] = id;
  }

  /** Remove and return the id of the smallest entry; `popKey` holds its key. */
  pop(): number {
    const topId = this.#ids[0]!;
    this.popKey = this.#keys[0]!;
    this.#length -= 1;
    const length = this.#length;
    if (length === 0) return topId;
    const key = this.#keys[length]!;
    const id = this.#ids[length]!;
    let index = 0;
    while (index * 2 + 1 < length) {
      let child = index * 2 + 1;
      if (child + 1 < length) {
        const right = this.#keys[child + 1]!;
        const left = this.#keys[child]!;
        if (right < left || (right === left && this.#ids[child + 1]! < this.#ids[child]!))
          child += 1;
      }
      const childKey = this.#keys[child]!;
      if (!(childKey < key || (childKey === key && this.#ids[child]! < id))) break;
      this.#keys[index] = childKey;
      this.#ids[index] = this.#ids[child]!;
      index = child;
    }
    this.#keys[index] = key;
    this.#ids[index] = id;
    return topId;
  }
}
