import { ServiceError } from '../core/result.js';

/**
 * The province graph with edge weights (ADR 0058): who touches whom, how long the shared border
 * is, and how much of it lies on a natural line. States and strategic regions are clustered on it,
 * and the territory assignment service (C11) reuses it to grow countries over the same edges.
 * Adjacency wraps east-west like the province builder's does.
 */

export interface ProvinceGraphInput {
  width: number;
  height: number;
  /** Province id per pixel. */
  pixel: Int32Array;
  /** 0 = sea, 1 = land, 2 = lake, per province id. */
  kind: ArrayLike<number>;
  /** Pixel sums per province, for centroids. */
  size: ArrayLike<number>;
  sumX: ArrayLike<number>;
  sumY: ArrayLike<number>;
  /** Natural-line strength 0 to 255 per pixel; without it every edge has barrier 0. */
  barrier?: Uint8Array;
}

/**
 * Compressed-row adjacency. The neighbours of province `i` are `to[offsets[i]]` up to (not
 * including) `to[offsets[i + 1]]`, in ascending order. Every undirected edge appears once in each
 * direction with the same `length` and `barrier`.
 */
export interface ProvinceGraph {
  readonly count: number;
  readonly kind: Uint8Array;
  readonly offsets: Int32Array;
  readonly to: Int32Array;
  /** Pixel edges shared by the two provinces. */
  readonly length: Uint32Array;
  /** Mean natural-line strength along the shared border, 0 (none) to 1 (a river or wall). */
  readonly barrier: Float32Array;
  /** Centroid of every province in pixels; the x of a province split by the seam is its mean. */
  readonly centerX: Float32Array;
  readonly centerY: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly size: Uint32Array;
}

/** Build the weighted graph in one pass over the province raster. */
export function buildProvinceGraph(input: ProvinceGraphInput): ProvinceGraph {
  const { width, height, pixel, barrier } = input;
  const count = input.kind.length;
  if (pixel.length !== width * height)
    throw new ServiceError(
      'MAP_PARTITION_GRAPH_INVALID',
      'The province raster does not match the map dimensions',
    );
  if (barrier !== undefined && barrier.length !== pixel.length)
    throw new ServiceError(
      'MAP_PARTITION_GRAPH_INVALID',
      'The barrier plane does not match the map dimensions',
    );
  const index = new Map<number, number>();
  let capacity = 1 << 14;
  let lengthList = new Uint32Array(capacity);
  let sumList = new Float64Array(capacity);
  let fromList = new Int32Array(capacity);
  let toList = new Int32Array(capacity);
  let edges = 0;
  const add = (a: number, b: number, strength: number): void => {
    const low = a < b ? a : b;
    const high = a < b ? b : a;
    const key = low * 65_536 + high;
    let slot = index.get(key);
    if (slot === undefined) {
      slot = edges++;
      if (slot === capacity) {
        capacity *= 2;
        const l = new Uint32Array(capacity);
        l.set(lengthList);
        lengthList = l;
        const s = new Float64Array(capacity);
        s.set(sumList);
        sumList = s;
        const f = new Int32Array(capacity);
        f.set(fromList);
        fromList = f;
        const t = new Int32Array(capacity);
        t.set(toList);
        toList = t;
      }
      fromList[slot] = low;
      toList[slot] = high;
      index.set(key, slot);
    }
    lengthList[slot]!++;
    sumList[slot]! += strength;
  };
  if (count > 65_535)
    throw new ServiceError('MAP_PARTITION_GRAPH_INVALID', 'The graph supports 65,535 provinces');
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const id = pixel[p]!;
      const east = x + 1 < width ? p + 1 : row;
      const other = pixel[east]!;
      if (other !== id)
        add(id, other, barrier === undefined ? 0 : Math.max(barrier[p]!, barrier[east]!));
      if (y + 1 < height) {
        const south = p + width;
        const below = pixel[south]!;
        if (below !== id)
          add(id, below, barrier === undefined ? 0 : Math.max(barrier[p]!, barrier[south]!));
      }
    }
  }
  const degree = new Int32Array(count + 1);
  for (let e = 0; e < edges; e++) {
    degree[fromList[e]! + 1]!++;
    degree[toList[e]! + 1]!++;
  }
  for (let i = 0; i < count; i++) degree[i + 1]! += degree[i]!;
  const offsets = degree;
  const cursor = Int32Array.from(offsets.subarray(0, count));
  const to = new Int32Array(offsets[count]!);
  const length = new Uint32Array(offsets[count]!);
  const mean = new Float32Array(offsets[count]!);
  // Edges sorted by (low, high) keep every row ascending without a second sort.
  const order = Array.from({ length: edges }, (_, i) => i).sort(
    (a, b) => fromList[a]! - fromList[b]! || toList[a]! - toList[b]!,
  );
  for (const e of order) {
    const a = fromList[e]!;
    const b = toList[e]!;
    const strength = sumList[e]! / lengthList[e]! / 255;
    to[cursor[a]!] = b;
    length[cursor[a]!] = lengthList[e]!;
    mean[cursor[a]!++] = strength;
  }
  for (const e of order) {
    const a = fromList[e]!;
    const b = toList[e]!;
    const strength = sumList[e]! / lengthList[e]! / 255;
    to[cursor[b]!] = a;
    length[cursor[b]!] = lengthList[e]!;
    mean[cursor[b]!++] = strength;
  }
  // Rows now hold the high-numbered neighbours of each province, then the low-numbered ones.
  sortRows(offsets, to, length, mean);
  const kind = Uint8Array.from({ length: count }, (_, i) => input.kind[i]!);
  const size = Uint32Array.from({ length: count }, (_, i) => input.size[i]!);
  const centerX = new Float32Array(count);
  const centerY = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const n = Math.max(1, size[i]!);
    centerX[i] = input.sumX[i]! / n;
    centerY[i] = input.sumY[i]! / n;
  }
  return {
    count,
    kind,
    offsets,
    to,
    length,
    barrier: mean,
    centerX,
    centerY,
    width,
    height,
    size,
  };
}

function sortRows(
  offsets: Int32Array,
  to: Int32Array,
  length: Uint32Array,
  barrier: Float32Array,
): void {
  for (let row = 0; row + 1 < offsets.length; row++) {
    const start = offsets[row]!;
    const end = offsets[row + 1]!;
    // Insertion sort: rows hold a handful of neighbours.
    for (let i = start + 1; i < end; i++) {
      const t = to[i]!;
      const l = length[i]!;
      const b = barrier[i]!;
      let j = i - 1;
      while (j >= start && to[j]! > t) {
        to[j + 1] = to[j]!;
        length[j + 1] = length[j]!;
        barrier[j + 1] = barrier[j]!;
        j--;
      }
      to[j + 1] = t;
      length[j + 1] = l;
      barrier[j + 1] = b;
    }
  }
}

export interface EdgeCostOptions {
  /** How much a fully natural border (a river or wall) multiplies the cost. Default 6. */
  barrier?: number;
  /** Extra cost per unit when the kinds of the two provinces differ (land to water). Default 3. */
  water?: number;
}

/**
 * Directed edge costs for growing territory over the graph: centroid distance (across the seam
 * when shorter) times `1 + barrier * strength`, aligned with `graph.to`. Territory assignment
 * runs its Dijkstra on these and may add its own terms.
 */
export function provinceEdgeCosts(
  graph: ProvinceGraph,
  options: EdgeCostOptions = {},
): Float32Array {
  const beta = options.barrier ?? 6;
  const water = options.water ?? 3;
  const cost = new Float32Array(graph.to.length);
  for (let a = 0; a < graph.count; a++)
    for (let e = graph.offsets[a]!; e < graph.offsets[a + 1]!; e++) {
      const b = graph.to[e]!;
      let dx = graph.centerX[a]! - graph.centerX[b]!;
      if (dx > graph.width / 2) dx -= graph.width;
      else if (dx < -graph.width / 2) dx += graph.width;
      const dy = graph.centerY[a]! - graph.centerY[b]!;
      const distance = Math.sqrt(dx * dx + dy * dy);
      cost[e] =
        distance * (1 + beta * graph.barrier[e]!) * (graph.kind[a] === graph.kind[b] ? 1 : water);
    }
  return cost;
}
