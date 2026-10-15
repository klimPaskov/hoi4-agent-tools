import { ServiceError } from '../core/result.js';

export interface WorldDrainagePoint {
  x: number;
  y: number;
}

export interface WorldDrainageSpec {
  width: number;
  height: number;
  /** 0 = sea, 1 = land, 2 = lake. */
  kind: Uint8Array;
  /** Land in [0, 1], water in [-1, 0]. The input is never modified. */
  elevation: Float32Array;
  seed: number;
  count: number;
  /** Drainage hints in top-left pixel coordinates, rather than mandatory river routes. */
  referenceRivers?: ReadonlyArray<ReadonlyArray<WorldDrainagePoint>>;
}

export interface WorldDrainageResult {
  riverPixels: Uint8Array;
  elevation: Float32Array;
  count: number;
  warnings: string[];
}

function fail(message: string): never {
  throw new ServiceError('INVALID_WORLD_DRAINAGE', message);
}

function validate(spec: WorldDrainageSpec): void {
  const { width, height, kind, elevation, count, seed } = spec;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    fail('Drainage dimensions must be positive integers.');
  if (width * height > 13_238_272) fail('Drainage raster exceeds 13,238,272 pixels.');
  if (!(kind instanceof Uint8Array) || !(elevation instanceof Float32Array))
    fail('Drainage requires typed land and elevation rasters.');
  if (kind.length !== width * height || elevation.length !== kind.length)
    fail('Drainage raster lengths must match the dimensions.');
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(count) || count < 0 || count > 4096)
    fail('Drainage requires an integer seed and a river count between 0 and 4,096.');
  for (let pixel = 0; pixel < kind.length; pixel += 1) {
    const value = elevation[pixel]!;
    if (kind[pixel]! > 2) fail('Drainage contains an unknown land or water kind.');
    if (
      !Number.isFinite(value) ||
      (kind[pixel] === 1 ? value < 0 || value > 1 : value < -1 || value > 0)
    )
      fail('Drainage elevations must be finite, with land in [0, 1] and water in [-1, 0].');
  }
  let points = 0;
  for (const line of spec.referenceRivers ?? []) {
    if (line.length < 2) fail('A reference river requires at least two points.');
    points += line.length;
    if (points > 100_000) fail('Reference rivers exceed 100,000 points.');
    for (const point of line)
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x >= width ||
        point.y >= height
      )
        fail('Reference river coordinates must lie inside the raster.');
  }
}

/** Four cardinal directions, with opposite directions paired. No wrapping across map edges. */
function neighbor(pixel: number, direction: number, width: number, height: number): number {
  if (direction === 1) return pixel % width > 0 ? pixel - 1 : -1;
  if (direction === 2) return pixel % width < width - 1 ? pixel + 1 : -1;
  if (direction === 3) return pixel >= width ? pixel - width : -1;
  return pixel < width * (height - 1) ? pixel + width : -1;
}

function hash(pixel: number, seed: number): number {
  let value = Math.imul(pixel ^ Math.imul(seed, 0x9e3779b1), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

/** A packed heap avoids millions of JS objects on full-size maps. */
class FloodHeap {
  readonly #pixels: Uint32Array;
  readonly #levels: Float32Array;
  readonly #seed: number;
  #length = 0;

  constructor(capacity: number, levels: Float32Array, seed: number) {
    this.#pixels = new Uint32Array(capacity);
    this.#levels = levels;
    this.#seed = seed;
  }

  get length(): number {
    return this.#length;
  }

  #before(left: number, right: number): boolean {
    const level = this.#levels[left]! - this.#levels[right]!;
    if (level !== 0) return level < 0;
    const order = hash(left, this.#seed) - hash(right, this.#seed);
    return order < 0 || (order === 0 && left < right);
  }

  push(pixel: number): void {
    let index = this.#length++;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!this.#before(pixel, this.#pixels[parent]!)) break;
      this.#pixels[index] = this.#pixels[parent]!;
      index = parent;
    }
    this.#pixels[index] = pixel;
  }

  pop(): number {
    const first = this.#pixels[0]!;
    const last = this.#pixels[--this.#length]!;
    if (this.#length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.#length) {
      let child = index * 2 + 1;
      if (child + 1 < this.#length && this.#before(this.#pixels[child + 1]!, this.#pixels[child]!))
        child += 1;
      if (!this.#before(this.#pixels[child]!, last)) break;
      this.#pixels[index] = this.#pixels[child]!;
      index = child;
    }
    this.#pixels[index] = last;
    return first;
  }
}

/**
 * Priority-flood assigns each land pixel an acyclic route to sea or lake. Flood levels are
 * temporary routing costs: only accepted channels alter the returned elevation, by lowering
 * downstream pixels. This preserves downhill flow after any monotone heightmap quantization.
 * Rivers are disjoint, cardinal, one-pixel paths; width is encoded by palette index, not dilation.
 * Work is O(N log N), with a bounded O(N) tracing budget and packed raster storage.
 */
export function generateWorldDrainage(spec: WorldDrainageSpec): WorldDrainageResult {
  validate(spec);
  const { width, height, kind, seed } = spec;
  const total = kind.length;
  const elevation = Float32Array.from(spec.elevation);
  const riverPixels = Uint8Array.from(kind, (value) => (value === 1 ? 255 : 254));
  const warnings: string[] = [];
  if (spec.count === 0) return { riverPixels, elevation, count: 0, warnings };

  const referenceSources: number[] = [];
  let referenceBudget = total * 4;
  for (const [index, line] of (spec.referenceRivers ?? []).entries()) {
    let source = -1;
    // Lower routing costs along hints without committing an uphill or disconnected channel.
    for (let vertex = 1; vertex < line.length; vertex += 1) {
      const a = line[vertex - 1]!;
      const b = line[vertex]!;
      let x = Math.floor(a.x);
      let y = Math.floor(a.y);
      const endX = Math.floor(b.x);
      const endY = Math.floor(b.y);
      const dx = Math.abs(endX - x);
      const dy = Math.abs(endY - y);
      let error = dx - dy;
      while (referenceBudget-- > 0) {
        const pixel = y * width + x;
        if (kind[pixel] === 1) {
          elevation[pixel] = spec.elevation[pixel]! * 0.85;
          if (source < 0 || spec.elevation[pixel]! > spec.elevation[source]!) source = pixel;
        }
        if (x === endX && y === endY) break;
        const twice = error * 2;
        if (twice > -dy) {
          error -= dy;
          x += x < endX ? 1 : -1;
        }
        if (twice < dx) {
          error += dx;
          y += y < endY ? 1 : -1;
        }
      }
    }
    if (source >= 0) referenceSources.push(source);
    warnings.push(
      source >= 0
        ? `Reference river ${index + 1} is a drainage hint; its route may divert to a safe outlet.`
        : `Reference river ${index + 1} contains no land; generated drainage will be used.`,
    );
  }
  if (referenceBudget <= 0)
    warnings.push(
      'Reference river rasterization exceeded its bounded budget; remaining hints were omitted.',
    );

  // Direction zero means undiscovered; every assigned direction points to an earlier visit.
  const downstream = new Uint8Array(total);
  const heap = new FloodHeap(total, elevation, seed);
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (kind[pixel] !== 1) continue;
    for (let direction = 1; direction <= 4; direction += 1) {
      const next = neighbor(pixel, direction, width, height);
      if (next < 0 || kind[next] === 1) continue;
      downstream[pixel] = direction;
      heap.push(pixel);
      break;
    }
  }
  if (heap.length === 0) {
    elevation.set(spec.elevation);
    warnings.push('No river can be generated because the land has no sea or lake outlet.');
    return { riverPixels, elevation, count: 0, warnings };
  }
  while (heap.length > 0) {
    const pixel = heap.pop();
    for (let direction = 1; direction <= 4; direction += 1) {
      const next = neighbor(pixel, direction, width, height);
      if (next < 0 || kind[next] !== 1 || downstream[next] !== 0) continue;
      downstream[next] = direction % 2 === 1 ? direction + 1 : direction - 1;
      elevation[next] = Math.max(elevation[next]!, elevation[pixel]!);
      heap.push(next);
    }
  }
  elevation.set(spec.elevation);

  // Sample across the whole raster, then prefer higher headwaters. Never sort all N pixels.
  const candidates = new Set(referenceSources);
  const sampleCount = Math.min(total, Math.max(256, Math.min(65_536, spec.count * 128)));
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const pixel = Math.floor((hash(sample, seed ^ 0x9e3779b9) / 4294967296) * total);
    if (kind[pixel] === 1 && downstream[pixel] !== 0) candidates.add(pixel);
  }
  const hinted = new Set(referenceSources);
  const sources = [...candidates].sort(
    (a, b) =>
      Number(hinted.has(b)) - Number(hinted.has(a)) ||
      elevation[b]! - elevation[a]! ||
      hash(a, seed) - hash(b, seed) ||
      a - b,
  );
  const blocked = new Uint8Array(total);
  const minLength = Math.max(3, Math.min(12, Math.floor(Math.min(width, height) / 4)));
  const maxPathSteps = Math.min(total, 65_536, 8 * (width + height));
  let budget = total * 4;
  let count = 0;
  for (const source of sources) {
    if (count >= spec.count || budget <= 0) break;
    if (blocked[source] !== 0 || downstream[source] === 0) continue;
    const path: number[] = [];
    const positions = new Map<number, number>();
    let current = source;
    let reachedWater = false;
    let collided = false;
    for (let step = 0; step < maxPathSteps && budget-- > 0; step += 1) {
      if (kind[current] !== 1) {
        reachedWater = true;
        break;
      }
      if (blocked[current] !== 0 || downstream[current] === 0) {
        collided = blocked[current] !== 0;
        break;
      }
      // Remove chords as a node arrives: the final path never touches itself or forms a 2x2.
      let predecessor = path.length - 1;
      for (let direction = 1; direction <= 4; direction += 1) {
        const around = neighbor(current, direction, width, height);
        const position = positions.get(around);
        if (position !== undefined) predecessor = Math.min(predecessor, position);
      }
      while (path.length > predecessor + 1) positions.delete(path.pop()!);
      positions.set(current, path.length);
      path.push(current);
      current = neighbor(current, downstream[current]!, width, height);
    }
    if (collided) for (const pixel of path) blocked[pixel] = 1;
    if (!reachedWater || path.length < minLength) continue;
    let level = elevation[source]!;
    for (const [position, pixel] of path.entries()) {
      level = Math.min(level, elevation[pixel]!);
      elevation[pixel] = level;
      riverPixels[pixel] =
        position === 0 ? 0 : 3 + Math.min(8, Math.floor((position * 9) / path.length));
      blocked[pixel] = 1;
      for (let direction = 1; direction <= 4; direction += 1) {
        const around = neighbor(pixel, direction, width, height);
        if (around >= 0) blocked[around] = 1;
      }
    }
    count += 1;
  }
  if (count < spec.count)
    warnings.push(
      `Generated ${count} of ${spec.count} rivers; remaining routes lack a clear disjoint outlet.`,
    );
  return { riverPixels, elevation, count, warnings };
}
