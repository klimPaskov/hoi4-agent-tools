import { ServiceError } from '../core/result.js';

export interface WorldProvinceInput {
  width: number;
  height: number;
  seed: number;
  /** 0 = sea, 1 = land, 2 = lake; the mask is preserved exactly. */
  kind: Uint8Array;
  elevation: Float32Array;
  moisture: Float32Array;
  landProvincePixels: number;
  seaProvincePixels: number;
}

/** The part of the input the shared finishing passes need: the exact land, sea and lake mask. */
export interface ProvinceGeometryInput {
  width: number;
  height: number;
  /** 0 = sea, 1 = land, 2 = lake; the mask is preserved exactly. */
  kind: Uint8Array;
  /**
   * Optional group per pixel (a geography region, say). The finishing passes merge and move pixels
   * inside one group whenever they can and cross a group border only when the engine rules leave
   * no other repair. Without it they behave exactly as the legacy partition always did.
   */
  group?: Uint16Array;
  /**
   * Optional line pixels (a river, a wall). Slivers are absorbed across a line only when no
   * neighbour on their own side can take them.
   */
  line?: Uint8Array;
}

export interface WorldProvinces {
  pixel: Int32Array;
  kind: number[];
  size: number[];
  sumX: number[];
  sumY: number[];
  neighbors: Array<Set<number>>;
}

function invalid(message: string): never {
  throw new ServiceError('MAP_WORLD_INVALID_PROVINCES', message);
}

function hash(seed: number, value: number): number {
  let n = Math.imul(seed ^ value, 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000;
}

function circularDelta(x: number, origin: number, width: number): number {
  return x - origin - Math.round((x - origin) / width) * width;
}

interface SeedGrid {
  cell: number;
  columns: number;
  rows: number;
  bins: number[][];
  x: number[];
  y: number[];
}

/** Extra land sites a sampling box gets from its mean height and wetness, before rounding. */
function landDensity(relief: number, wet: number): number {
  return Math.max(0, relief) * 1.3 + Math.max(0, wet);
}

/**
 * Jittered sites use ordinary Euclidean distance, rather than cardinal flood distance.
 * Additional sites in elevated/wet land give those areas a denser, varied partition; the
 * sampling box grows by the mean of those extras, so they redistribute provinces instead of
 * adding to the requested `landProvincePixels`. Lakes take the sea target.
 * Each occupied sampling box has a site, including thin coasts and small islands.
 */
function sites(input: WorldProvinceInput, wanted: number): SeedGrid {
  const { width, height, kind, elevation, moisture, seed } = input;
  const target = wanted === 1 ? input.landProvincePixels : input.seaProvincePixels;
  let extras = 0;
  let pixels = 0;
  if (wanted === 1)
    for (let p = 0; p < kind.length; p++) {
      if (kind[p] !== 1) continue;
      pixels++;
      extras += Math.min(2, landDensity(elevation[p]!, moisture[p]!));
    }
  const meanExtra = pixels === 0 ? 0 : extras / pixels;
  const cell = Math.max(
    2,
    Math.floor(Math.min(Math.sqrt(target * (1 + meanExtra)), width / 20, height / 20)),
  );
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const result: SeedGrid = {
    cell,
    columns,
    rows,
    bins: Array.from({ length: columns * rows }, () => []),
    x: [],
    y: [],
  };
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < columns; bx++) {
      const bin = by * columns + bx;
      const choices = [-1, -1, -1];
      const scores = [Infinity, Infinity, Infinity];
      let count = 0;
      let relief = 0;
      let wet = 0;
      for (let y = by * cell; y < Math.min(height, (by + 1) * cell); y++) {
        for (let x = bx * cell; x < Math.min(width, (bx + 1) * cell); x++) {
          const p = y * width + x;
          if (kind[p] !== wanted) continue;
          count++;
          relief += elevation[p]!;
          wet += moisture[p]!;
          // Independent reservoir scores avoid a preferred corner or row direction.
          for (let slot = 0; slot < 3; slot++) {
            const score = hash(seed ^ (wanted * 0x193) ^ (slot * 0x7919), p);
            if (score < scores[slot]!) {
              scores[slot] = score;
              choices[slot] = p;
            }
          }
        }
      }
      if (count === 0) continue;
      const density = wanted === 1 ? landDensity(relief / count, wet / count) : 0;
      const extra = Math.min(2, Math.floor(density + hash(seed, bin + wanted * 7717)));
      const used = new Set<number>();
      for (let slot = 0; slot <= extra; slot++) {
        const p = choices[slot]!;
        if (used.has(p)) continue;
        used.add(p);
        result.bins[bin]!.push(result.x.length);
        result.x.push(p % width);
        result.y.push(Math.floor(p / width));
      }
    }
  }
  return result;
}

function nearestPartition(input: WorldProvinceInput): Int32Array {
  const { width, height, kind, seed } = input;
  const output = new Int32Array(width * height);
  let offset = 0;
  for (let wanted = 0; wanted < 3; wanted++) {
    const grid = sites(input, wanted);
    if (grid.x.length === 0) continue;
    const { cell, columns, rows } = grid;
    const candidates: number[][] = [];
    // Bounded candidate lists keep the per-pixel work independent of province count.
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < columns; bx++) {
        const list: number[] = [];
        const visited = new Set<number>();
        for (let dy = -3; dy <= 3; dy++) {
          if (by + dy < 0 || by + dy >= rows) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const column = (bx + dx + columns * 4) % columns;
            const bin = (by + dy) * columns + column;
            if (visited.has(bin)) continue;
            visited.add(bin);
            list.push(...grid.bins[bin]!);
          }
        }
        candidates.push(list);
      }
    }
    const phase = hash(seed, wanted + 337) * Math.PI * 2;
    const cycles = Math.max(1, Math.round(width / (cell * 7)));
    const sx = Float64Array.from({ length: width }, (_, x) =>
      Math.sin((x / width) * Math.PI * 2 * cycles + phase),
    );
    const cx = Float64Array.from({ length: width }, (_, x) =>
      Math.cos((x / width) * Math.PI * 2 * (cycles + 1) + phase),
    );
    for (let y = 0; y < height; y++) {
      const sy = Math.sin(y / (cell * 4.3) + phase);
      const cy = Math.cos(y / (cell * 5.1) - phase);
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (kind[p] !== wanted) continue;
        const qx = x + cell * 0.55 * sx[x]! * sy;
        const qy = y + cell * 0.55 * cx[x]! * cy;
        const list = candidates[Math.floor(y / cell) * columns + Math.floor(x / cell)]!;
        let best = -1;
        let distance = Infinity;
        for (const id of list) {
          const dx = circularDelta(grid.x[id]!, qx, width);
          const dy = grid.y[id]! - qy;
          const d = dx * dx + dy * dy;
          if (d < distance) {
            distance = d;
            best = id;
          }
        }
        if (best < 0) invalid('An occupied sampling box has no province site');
        output[p] = offset + best;
      }
    }
    offset += grid.x.length;
  }
  return output;
}

interface Parts {
  pixel: Int32Array;
  parent: number[];
  size: number[];
  kind: number[];
  origin: number[];
  minX: number[];
  maxX: number[];
  minY: number[];
  maxY: number[];
  /** The group of the pixel a part started from; empty without `ProvinceGeometryInput.group`. */
  group: number[];
}

/** Split disconnected Voronoi pieces and any unusually long coastal cells in one scan. */
function connectedParts(input: ProvinceGeometryInput, labels: Int32Array): Parts {
  const { width, height, kind } = input;
  const pixel = new Int32Array(labels.length).fill(-1);
  const queue = new Int32Array(labels.length);
  const parts: Parts = {
    pixel,
    parent: [],
    size: [],
    kind: [],
    origin: [],
    minX: [],
    maxX: [],
    minY: [],
    maxY: [],
    group: [],
  };
  const limitX = Math.max(1, Math.floor(width / 8));
  const limitY = Math.max(1, Math.floor(height / 8));
  for (let start = 0; start < labels.length; start++) {
    if (pixel[start] !== -1) continue;
    const id = parts.parent.length;
    parts.parent.push(id);
    parts.kind.push(kind[start]!);
    if (input.group !== undefined) parts.group.push(input.group[start]!);
    const origin = start % width;
    let minX = 0;
    let maxX = 0;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    pixel[start] = id;
    while (head < tail) {
      const current = queue[head++]!;
      const x = current % width;
      const next = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        current - width,
        current + width,
      ];
      for (const p of next) {
        if (p < 0 || p >= labels.length || pixel[p] !== -1 || labels[p] !== labels[start]) continue;
        const px = (p % width) - origin;
        const py = Math.floor(p / width);
        const nx = Math.min(minX, px);
        const xx = Math.max(maxX, px);
        const ny = Math.min(minY, py);
        const xy = Math.max(maxY, py);
        if (xx - nx + 1 > limitX || xy - ny + 1 > limitY) continue;
        minX = nx;
        maxX = xx;
        minY = ny;
        maxY = xy;
        pixel[p] = id;
        queue[tail++] = p;
      }
    }
    parts.size.push(tail);
    parts.origin.push(origin);
    parts.minX.push(minX);
    parts.maxX.push(maxX);
    parts.minY.push(minY);
    parts.maxY.push(maxY);
  }
  return parts;
}

function root(parts: Parts, id: number): number {
  let r = id;
  while (parts.parent[r] !== r) r = parts.parent[r]!;
  while (parts.parent[id] !== id) {
    const next = parts.parent[id]!;
    parts.parent[id] = r;
    id = next;
  }
  return r;
}

function merge(
  parts: Parts,
  a: number,
  b: number,
  width: number,
  height: number,
  sameGroup = false,
): boolean {
  a = root(parts, a);
  b = root(parts, b);
  if (a === b) return true;
  if (parts.kind[a] !== parts.kind[b]) return false;
  if (sameGroup && parts.group[a] !== parts.group[b]) return false;
  const shift = parts.origin[b]! - parts.origin[a]!;
  const minX = Math.min(parts.minX[a]!, parts.minX[b]! + shift);
  const maxX = Math.max(parts.maxX[a]!, parts.maxX[b]! + shift);
  const minY = Math.min(parts.minY[a]!, parts.minY[b]!);
  const maxY = Math.max(parts.maxY[a]!, parts.maxY[b]!);
  if (maxX - minX + 1 > Math.max(1, Math.floor(width / 8))) return false;
  if (maxY - minY + 1 > Math.max(1, Math.floor(height / 8))) return false;
  parts.parent[b] = a;
  parts.size[a]! += parts.size[b]!;
  parts.size[b] = 0;
  parts.minX[a] = minX;
  parts.maxX[a] = maxX;
  parts.minY[a] = minY;
  parts.maxY[a] = maxY;
  return true;
}

function absorbSlivers(input: ProvinceGeometryInput, parts: Parts): void {
  const { width, height } = input;
  // Every successful operation removes a whole connected component. The scan is
  // repeated because a previously isolated fragment may become mergeable afterwards. With groups
  // or lines, the first stages merge inside a group and not across a line, and the last stage
  // takes what is left.
  const stages: Array<{ sameGroup: boolean; avoidLine: boolean }> = [];
  if (input.group !== undefined && input.line !== undefined)
    stages.push({ sameGroup: true, avoidLine: true });
  if (input.line !== undefined) stages.push({ sameGroup: false, avoidLine: true });
  if (input.group !== undefined) stages.push({ sameGroup: true, avoidLine: false });
  stages.push({ sameGroup: false, avoidLine: false });
  for (const { sameGroup, avoidLine } of stages) {
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let p = 0; p < parts.pixel.length; p++) {
        const x = p % width;
        const adjacent = [x + 1 < width ? p + 1 : p + 1 - width, p + width];
        for (const q of adjacent) {
          if (q >= parts.pixel.length) continue;
          if (avoidLine && (input.line![p] !== 0 || input.line![q] !== 0)) continue;
          const a = root(parts, parts.pixel[p]!);
          const b = root(parts, parts.pixel[q]!);
          if (a === b || (parts.size[a]! >= 20 && parts.size[b]! >= 20)) continue;
          if (merge(parts, a, b, width, height, sameGroup)) changed = true;
        }
      }
      if (!changed) break;
    }
  }
}

/** Removing a pixel may not cut its donor; verify the donor's local four-way paths. */
function removable(parts: Parts, p: number, width: number, height: number): boolean {
  const owner = root(parts, parts.pixel[p]!);
  if (parts.size[owner]! <= 20) return false;
  const x = p % width;
  const y = Math.floor(p / width);
  const cells = new Int32Array(9).fill(-1);
  for (let dy = -1; dy <= 1; dy++) {
    if (y + dy < 0 || y + dy >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const q = (y + dy) * width + ((x + dx + width) % width);
      if (root(parts, parts.pixel[q]!) === owner) cells[(dy + 1) * 3 + dx + 1] = q;
    }
  }
  const cardinal = [1, 3, 5, 7].filter((i) => cells[i] !== -1);
  if (cardinal.length < 2) return true;
  const visited = new Uint8Array(9);
  const stack = [cardinal[0]!];
  visited[cardinal[0]!] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (const j of [i % 3 > 0 ? i - 1 : -1, i % 3 < 2 ? i + 1 : -1, i - 3, i + 3]) {
      if (j < 0 || j >= 9 || cells[j] === -1 || visited[j]) continue;
      visited[j] = 1;
      stack.push(j);
    }
  }
  return cardinal.every((i) => visited[i] === 1);
}

/** Grow a small fragment from removable neighboring cells when whole-province unions exceed bounds. */
function rebalanceSlivers(input: ProvinceGeometryInput, parts: Parts): void {
  const { width, height, kind } = input;
  const fragments = new Map<number, number[]>();
  for (let p = 0; p < parts.pixel.length; p++) {
    const id = root(parts, parts.pixel[p]!);
    if (parts.size[id]! >= 20) continue;
    const cells = fragments.get(id) ?? [];
    cells.push(p);
    fragments.set(id, cells);
  }
  for (const [id, cells] of fragments) {
    while (parts.size[id]! < 20) {
      let moved = false;
      for (const p of cells) {
        const x = p % width;
        for (const q of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width]) {
          if (q < 0 || q >= kind.length || kind[q] !== kind[p]) continue;
          const donor = root(parts, parts.pixel[q]!);
          if (donor === id || parts.size[donor]! <= 20 || !removable(parts, q, width, height))
            continue;
          const dx = (q % width) - parts.origin[id]!,
            y = Math.floor(q / width);
          const minX = Math.min(parts.minX[id]!, dx),
            maxX = Math.max(parts.maxX[id]!, dx);
          const minY = Math.min(parts.minY[id]!, y),
            maxY = Math.max(parts.maxY[id]!, y);
          if (maxX - minX + 1 > width / 8 || maxY - minY + 1 > height / 8) continue;
          parts.pixel[q] = id;
          parts.size[id]!++;
          parts.size[donor]!--;
          parts.minX[id] = minX;
          parts.maxX[id] = maxX;
          parts.minY[id] = minY;
          parts.maxY[id] = maxY;
          cells.push(q);
          moved = true;
          break;
        }
        if (moved) break;
      }
      if (!moved) break;
    }
  }
}

function repairCrossings(input: ProvinceGeometryInput, parts: Parts): void {
  const { width, height, kind } = input;
  const repairStages: Array<{ sameGroup: boolean; avoidLine: boolean }> = [];
  if (input.group !== undefined && input.line !== undefined)
    repairStages.push({ sameGroup: true, avoidLine: true });
  if (input.line !== undefined) repairStages.push({ sameGroup: false, avoidLine: true });
  if (input.group !== undefined) repairStages.push({ sameGroup: true, avoidLine: false });
  repairStages.push({ sameGroup: false, avoidLine: false });
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (let y = 0; y + 1 < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = y * width + x;
        const b = y * width + ((x + 1) % width);
        const corners = [a, b, a + width, b + width];
        const ids = corners.map((p) => root(parts, parts.pixel[p]!));
        if (new Set(ids).size < 4) continue;
        const edges = [
          [0, 1],
          [0, 2],
          [1, 3],
          [2, 3],
        ] as const;
        let repaired = false;
        // Whole-cell unions cannot introduce crossings or disconnected provinces. With groups or
        // lines, the repairs inside one group and not across a line come first.
        for (const { sameGroup, avoidLine } of repairStages) {
          for (const [i, j] of edges) {
            if (avoidLine && (input.line![corners[i]!] !== 0 || input.line![corners[j]!] !== 0))
              continue;
            if (merge(parts, ids[i]!, ids[j]!, width, height, sameGroup)) {
              repaired = true;
              break;
            }
          }
          if (repaired) break;
          for (const [i, j] of edges.flatMap(([i, j]) => [
            [i, j],
            [j, i],
          ])) {
            const p = corners[i!]!;
            const q = corners[j!]!;
            if (avoidLine && (input.line![p] !== 0 || input.line![q] !== 0)) continue;
            if (kind[p] !== kind[q] || !removable(parts, p, width, height)) continue;
            if (
              sameGroup &&
              parts.group[root(parts, ids[i!]!)] !== parts.group[root(parts, ids[j!]!)]
            )
              continue;
            const target = ids[j!]!;
            const dx = (p % width) - parts.origin[target]!;
            const py = Math.floor(p / width);
            const minX = Math.min(parts.minX[target]!, dx);
            const maxX = Math.max(parts.maxX[target]!, dx);
            const minY = Math.min(parts.minY[target]!, py);
            const maxY = Math.max(parts.maxY[target]!, py);
            if (maxX - minX + 1 > width / 8 || maxY - minY + 1 > height / 8) continue;
            parts.pixel[p] = target;
            parts.size[target]!++;
            parts.size[ids[i!]!]!--;
            parts.minX[target] = minX;
            parts.maxX[target] = maxX;
            parts.minY[target] = minY;
            parts.maxY[target] = maxY;
            repaired = true;
            break;
          }
          if (repaired) break;
        }
        if (!repaired)
          throw new ServiceError(
            'MAP_WORLD_UNREPRESENTABLE_TOPOLOGY',
            'The exact land/sea/lake mask cannot resolve a four-province corner while preserving connected provinces and size limits',
            { x, y },
          );
        changed = true;
      }
    }
    if (!changed) return;
  }
  throw new ServiceError(
    'MAP_WORLD_UNREPRESENTABLE_TOPOLOGY',
    'Province corner repair did not converge',
  );
}

/**
 * Refuse a mask that needs more provinces than the engine tolerates before any site is built:
 * a singleton component of one kind necessarily needs its own province, which is an inexpensive
 * lower bound for a hostile fragmented mask.
 */
export function assertProvinceMaskFeasible(input: ProvinceGeometryInput): void {
  const { width, kind } = input;
  const total = width * input.height;
  let isolated = 0;
  for (let p = 0; p < total; p++) {
    const x = p % width;
    const left = x > 0 ? p - 1 : p + width - 1;
    const right = x + 1 < width ? p + 1 : p - width + 1;
    if (
      kind[left] !== kind[p] &&
      kind[right] !== kind[p] &&
      (p < width || kind[p - width] !== kind[p]) &&
      (p + width >= total || kind[p + width] !== kind[p])
    )
      isolated++;
  }
  if (isolated > 65_000)
    throw new ServiceError(
      'MAP_WORLD_TOO_MANY_PROVINCES',
      'The kind mask requires more than 65,000 isolated provinces',
      { isolated },
    );
}

/**
 * Turn one label per pixel into provinces: split disconnected and over-wide parts, absorb slivers,
 * keep every province at least 20 pixels where the mask allows, repair four-province corners and
 * number the provinces by their first pixel. Both partitions finish through this function, so the
 * engine rules (connected provinces, the bounding box limit, no X crossing, the 65,000 cap) hold
 * whichever one made the labels.
 */
export function assembleWorldProvinces(
  input: ProvinceGeometryInput,
  labels: Int32Array,
): WorldProvinces {
  const { width, height, kind } = input;
  const total = width * height;
  const parts = connectedParts(input, labels);
  absorbSlivers(input, parts);
  rebalanceSlivers(input, parts);
  repairCrossings(input, parts);
  const result: WorldProvinces = {
    pixel: new Int32Array(total),
    kind: [],
    size: [],
    sumX: [],
    sumY: [],
    neighbors: [],
  };
  const ids = new Int32Array(parts.parent.length).fill(-1);
  const localSameKindNeighbor = new Uint8Array(parts.parent.length);
  for (let p = 0; p < total; p++) {
    const owner = root(parts, parts.pixel[p]!);
    let id = ids[owner]!;
    if (id === -1) {
      id = result.kind.length;
      ids[owner] = id;
      result.kind.push(kind[p]!);
      result.size.push(0);
      result.sumX.push(0);
      result.sumY.push(0);
      result.neighbors.push(new Set());
    }
    result.pixel[p] = id;
    result.size[id]!++;
    result.sumX[id]! += p % width;
    result.sumY[id]! += Math.floor(p / width);
  }
  for (let p = 0; p < total; p++) {
    const id = result.pixel[p]!;
    const x = p % width;
    for (const q of [x + 1 < width ? p + 1 : p + 1 - width, p + width]) {
      if (q >= total) continue;
      const other = result.pixel[q]!;
      if (other === id) continue;
      result.neighbors[id]!.add(other);
      result.neighbors[other]!.add(id);
      if ((q === p + width || x + 1 < width) && result.kind[id] === result.kind[other]) {
        localSameKindNeighbor[id] = 1;
        localSameKindNeighbor[other] = 1;
      }
    }
  }
  if (result.kind.length > 65_000)
    throw new ServiceError(
      'MAP_WORLD_TOO_MANY_PROVINCES',
      'The world exceeds 65,000 provinces; raise the province target areas or simplify fragmented coastlines',
      { provinces: result.kind.length },
    );
  for (let id = 0; id < result.kind.length; id++) {
    if (result.size[id]! >= 20) continue;
    // A tiny component cut by the map seam has the same exception as an isolated tiny island:
    // its only same-kind neighbor may be across the seam, where a native bounding box cannot merge.
    if (localSameKindNeighbor[id])
      throw new ServiceError(
        'MAP_WORLD_UNREPRESENTABLE_TOPOLOGY',
        'The exact kind mask leaves a province smaller than 20 pixels that cannot merge within the province extent limits',
        {
          province: id,
          pixels: result.size[id],
          kind: result.kind[id],
          x: result.sumX[id]! / result.size[id]!,
          y: result.sumY[id]! / result.size[id]!,
        },
      );
  }
  return result;
}

/**
 * Deterministic province geometry with periodic adjacency, but separate province IDs at the seam.
 * Native province bounding boxes use bitmap coordinates, not circular spans. Work is proportional to pixels
 * with bounded local candidate searches; no retained per-pixel objects or global site scans.
 */
export function generateWorldProvinces(input: WorldProvinceInput): WorldProvinces {
  const { width, height, kind, elevation, moisture, seed } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16)
    invalid('Province dimensions must be integers of at least 16 pixels');
  const total = width * height;
  if (!Number.isSafeInteger(total) || total > 13_238_272)
    invalid('Province dimensions exceed the 13,238,272-pixel map limit');
  if (!Number.isSafeInteger(seed)) invalid('The province seed must be a safe integer');
  if (
    !(kind instanceof Uint8Array) ||
    !(elevation instanceof Float32Array) ||
    !(moisture instanceof Float32Array)
  )
    invalid('Province fields must use the specified typed arrays');
  if (kind.length !== total || elevation.length !== total || moisture.length !== total)
    invalid('Province fields must match the map dimensions');
  if (
    ![input.landProvincePixels, input.seaProvincePixels].every((v) => Number.isFinite(v) && v >= 20)
  )
    invalid('Province target areas must be finite and at least 20 pixels');
  for (let p = 0; p < total; p++) {
    if (kind[p]! > 2 || !Number.isFinite(elevation[p]) || !Number.isFinite(moisture[p]))
      invalid('Province fields contain an unsupported kind or non-finite terrain value');
  }
  assertProvinceMaskFeasible(input);
  return assembleWorldProvinces(input, nearestPartition(input));
}
