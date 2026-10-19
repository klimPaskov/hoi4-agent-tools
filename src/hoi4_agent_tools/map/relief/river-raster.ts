/**
 * River pixels (ADR 0056): the macro rivers of `hydrology.ts` become the one-pixel, orthogonally
 * connected paths of `rivers.bmp`. Each river is routed in short chunks by A* over the
 * full-resolution heights inside a corridor around its macro route; a river never touches another
 * river except where it joins one (a tributary ends beside its parent in a red pixel, a
 * distributary starts beside it in a yellow one), so no 2 x 2 block can form. Exactly one green
 * source marks the main branch of every connected river.
 */
import { LAND, MinHeap } from './grid.js';
import type { MacroRiver } from './hydrology.js';
import { noise2, seedFromString, smoothstep } from './math.js';

/** Index values of `rivers.bmp`. */
export const RIVER_SOURCE_INDEX = 0;
export const RIVER_TRIBUTARY_END_INDEX = 1;
export const RIVER_DISTRIBUTARY_START_INDEX = 2;
export const RIVER_LAND_INDEX = 255;
export const RIVER_WATER_INDEX = 254;

export interface PixelRiver {
  readonly id: string;
  readonly named: boolean;
  /** Pixel indices from the source to the mouth; empty when the river could not be routed. */
  readonly pixels: Int32Array;
  /** True when the path reaches water, the map edge or its parent river. */
  readonly complete: boolean;
}

export interface RiverRasterNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface RiverRasterInput {
  rivers: readonly MacroRiver[];
  /** Macro grid size. */
  macroWidth: number;
  macroHeight: number;
  /** Full-resolution kind (0 sea, 1 land, 2 lake). */
  kind: Uint8Array;
  width: number;
  height: number;
  /**
   * Float heights at full resolution. Beds are lowered in place so that heights never rise
   * downstream, which keeps the flow downhill after quantisation.
   */
  heights: Float32Array;
  seed: number;
  /** Most river pixels to keep: unnamed headwaters are dropped, smallest first, beyond it. */
  pixelCap?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface RiverRasterResult {
  /** 255 land, 254 water, 0 to 11 river indices. */
  bitmap: Uint8Array;
  /** Order of the river at each river pixel; 0 elsewhere. */
  order: Uint8Array;
  rivers: PixelRiver[];
  pixels: number;
  notes: RiverRasterNote[];
}

const WINDOW_LIMIT = 288;

interface Window {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

class Scratch {
  readonly cost = new Float32Array(WINDOW_LIMIT * WINDOW_LIMIT);
  readonly previous = new Int32Array(WINDOW_LIMIT * WINDOW_LIMIT);
  readonly stamp = new Int32Array(WINDOW_LIMIT * WINDOW_LIMIT);
  readonly heap = new MinHeap(1 << 15);
  run = 0;
}

interface PixelContext {
  width: number;
  height: number;
  kind: Uint8Array;
  heights: Float32Array;
  /** River index plus one at river pixels. */
  owner: Int16Array;
  seed: number;
}

/** True when the pixel or any of its eight neighbours belongs to a river. */
function nearRiver(context: PixelContext, x: number, y: number): boolean {
  const { width, height, owner } = context;
  for (let dy = -1; dy <= 1; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      if (owner[ny * width + nx] !== 0) return true;
    }
  }
  return false;
}

/** Owners other than `allowed` among the eight neighbours of a pixel (and the pixel itself). */
function foreignNeighbour(context: PixelContext, x: number, y: number, allowed: number): boolean {
  const { width, height, owner } = context;
  for (let dy = -1; dy <= 1; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const value = owner[ny * width + nx]!;
      if (value !== 0 && value !== allowed) return true;
    }
  }
  return false;
}

/** True when a land pixel touches water orthogonally, or lies on the map border. */
function atMouth(context: PixelContext, x: number, y: number): boolean {
  const { width, height, kind } = context;
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
  const index = y * width + x;
  return (
    kind[index - 1] !== LAND ||
    kind[index + 1] !== LAND ||
    kind[index - width] !== LAND ||
    kind[index + width] !== LAND
  );
}

interface SearchSpec {
  start: number;
  window: Window;
  /** A pixel to reach (within `tolerance` Manhattan steps) or a test for goal pixels. */
  goal?: number;
  tolerance?: number;
  goalTest?: (x: number, y: number) => boolean;
  /** True when goal pixels may stand beside the parent river (a tributary joining). */
  joinGoal?: boolean;
  /** Where the heuristic points when only a test is given. */
  aim: { x: number; y: number };
  /** The corridor: a segment the route should stay near. */
  guide: { ax: number; ay: number; bx: number; by: number };
  /** The river being routed (its own pixels do not block it) and the one it joins. */
  self: number;
  parent: number;
}

/** One A* run over a window; returns pixel indices from the start to the goal, or undefined. */
function search(context: PixelContext, scratch: Scratch, spec: SearchSpec): number[] | undefined {
  const { width, kind, heights, seed } = context;
  const win = spec.window;
  scratch.run += 1;
  const run = scratch.run;
  const heap = scratch.heap;
  heap.clear();
  const startX = spec.start % width;
  const startY = (spec.start - startX) / width;
  const goalX = spec.goal === undefined ? spec.aim.x : spec.goal % width;
  const goalY = spec.goal === undefined ? spec.aim.y : (spec.goal - (spec.goal % width)) / width;
  const wanderSeed = seed;
  const segX = spec.guide.bx - spec.guide.ax;
  const segY = spec.guide.by - spec.guide.ay;
  const segLength = segX * segX + segY * segY;
  const local = (x: number, y: number): number => (y - win.y0) * win.width + (x - win.x0);
  const startLocal = local(startX, startY);
  scratch.stamp[startLocal] = run;
  scratch.cost[startLocal] = 0;
  scratch.previous[startLocal] = -1;
  heap.push(Math.abs(goalX - startX) + Math.abs(goalY - startY), startLocal);
  const tolerance = spec.tolerance ?? 0;
  let expanded = 0;
  const limit = win.width * win.height * 6;
  while (heap.length > 0) {
    const current = heap.pop();
    const g = scratch.cost[current]!;
    const x = win.x0 + (current % win.width);
    const y = win.y0 + (current - (current % win.width)) / win.width;
    if (heap.popKey > (g + Math.abs(goalX - x) + Math.abs(goalY - y)) * 1.0001 + 0.01) continue;
    const goalReached =
      spec.goalTest === undefined
        ? Math.abs(x - goalX) + Math.abs(y - goalY) <= tolerance
        : spec.goalTest(x, y);
    if (goalReached && current !== startLocal) {
      const path: number[] = [];
      for (let at = current; at >= 0; at = scratch.previous[at]!) {
        const ax = win.x0 + (at % win.width);
        const ay = win.y0 + (at - (at % win.width)) / win.width;
        path.push(ay * width + ax);
      }
      return path.reverse();
    }
    if (++expanded > limit) return undefined;
    const here = y * width + x;
    for (let n = 0; n < 4; n += 1) {
      const nx = x + (n === 0 ? 1 : n === 1 ? -1 : 0);
      const ny = y + (n === 2 ? 1 : n === 3 ? -1 : 0);
      if (nx < win.x0 || ny < win.y0 || nx >= win.x0 + win.width || ny >= win.y0 + win.height)
        continue;
      const next = ny * width + nx;
      if (kind[next] !== LAND) continue;
      const isGoal =
        spec.goalTest !== undefined
          ? spec.goalTest(nx, ny)
          : spec.goal !== undefined && Math.abs(nx - goalX) + Math.abs(ny - goalY) <= tolerance;
      // Cells beside another river are off limits, except where a tributary joins its parent.
      if (!(spec.joinGoal === true && isGoal) && nearRiver(context, nx, ny)) continue;
      let step = 1;
      const rise = heights[next]! - heights[here]!;
      if (rise > 0) step += 0.8 * rise;
      step +=
        2.2 *
        (0.6 * noise2(wanderSeed, nx / 10, ny / 10) + 0.4 * noise2(wanderSeed + 3, nx / 4, ny / 4));
      if (segLength > 0) {
        const t = Math.max(
          0,
          Math.min(1, ((nx - spec.guide.ax) * segX + (ny - spec.guide.ay) * segY) / segLength),
        );
        const dx = nx - (spec.guide.ax + t * segX);
        const dy = ny - (spec.guide.ay + t * segY);
        step += 0.012 * Math.sqrt(dx * dx + dy * dy);
      }
      const candidate = Math.fround(g + step);
      const target = local(nx, ny);
      if (scratch.stamp[target] === run && scratch.cost[target]! <= candidate) continue;
      scratch.stamp[target] = run;
      scratch.cost[target] = candidate;
      scratch.previous[target] = current;
      heap.push(Math.fround(candidate + Math.abs(goalX - nx) + Math.abs(goalY - ny)), target);
    }
  }
  return undefined;
}

/** True when the pixel would complete a 2 x 2 block of river pixels with the three around it. */
function formsBlock(context: PixelContext, x: number, y: number): boolean {
  const { width, height, owner } = context;
  for (const [ox, oy] of [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
  ] as const) {
    const bx = x + ox;
    const by = y + oy;
    if (bx < 0 || by < 0 || bx + 1 >= width || by + 1 >= height) continue;
    let others = 0;
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      if (bx + cx === x && by + cy === y) continue;
      if (owner[(by + cy) * width + bx + cx] !== 0) others += 1;
    }
    if (others === 3) return true;
  }
  return false;
}

/**
 * A pixel that touches the parent orthogonally at exactly one pixel, touches no other river and
 * closes no 2 x 2 block: where a branch may start or a tributary may end.
 */
function singleContact(context: PixelContext, x: number, y: number, parent: number): boolean {
  if (parent <= 0) return false;
  const { width, height, owner } = context;
  if (foreignNeighbour(context, x, y, parent)) return false;
  let beside = 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (owner[ny * width + nx] === parent) beside += 1;
  }
  return beside === 1 && !formsBlock(context, x, y);
}

/** Remove loops: a pixel that touches an earlier pixel of the path (other than its predecessor) cuts the path back. */
function removeChords(path: number[], width: number): number[] {
  const kept: number[] = [];
  const position = new Map<number, number>();
  for (const pixel of path) {
    const x = pixel % width;
    let cut = kept.length - 1;
    for (const neighbour of [pixel - 1, pixel + 1, pixel - width, pixel + width]) {
      if (neighbour === pixel - 1 && x === 0) continue;
      if (neighbour === pixel + 1 && x === width - 1) continue;
      const at = position.get(neighbour);
      if (at !== undefined && at < cut) cut = at;
    }
    while (kept.length > cut + 1) position.delete(kept.pop()!);
    if (position.has(pixel)) continue;
    position.set(pixel, kept.length);
    kept.push(pixel);
  }
  return kept;
}

function windowFor(
  points: readonly number[],
  width: number,
  height: number,
  margin: number,
): Window {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pixel of points) {
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const wx0 = Math.max(0, x0 - margin);
  const wy0 = Math.max(0, y0 - margin);
  const wx1 = Math.min(width - 1, x1 + margin);
  const wy1 = Math.min(height - 1, y1 + margin);
  return {
    x0: wx0,
    y0: wy0,
    width: Math.min(WINDOW_LIMIT, wx1 - wx0 + 1),
    height: Math.min(WINDOW_LIMIT, wy1 - wy0 + 1),
  };
}

/** A free land pixel near the centre of a macro cell. */
function cellPixel(context: PixelContext, cell: number, macroWidth: number): number {
  const mx = cell % macroWidth;
  const my = (cell - mx) / macroWidth;
  const { width, height, kind } = context;
  const cx = Math.min(width - 1, 2 * mx + 1);
  const cy = Math.min(height - 1, 2 * my + 1);
  let best = -1;
  let bestScore = Infinity;
  for (let dy = -2; dy <= 2; dy += 1)
    for (let dx = -2; dx <= 2; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const pixel = y * width + x;
      if (kind[pixel] !== LAND || nearRiver(context, x, y)) continue;
      const score = dx * dx + dy * dy;
      if (score < bestScore) {
        bestScore = score;
        best = pixel;
      }
    }
  return best;
}

/** The pixel of a river nearest to a point, within  pixels. */
function nearestOwned(
  context: PixelContext,
  cx: number,
  cy: number,
  value: number,
  radius: number,
): { x: number; y: number } | undefined {
  const { width, height, owner } = context;
  let best: { x: number; y: number } | undefined;
  let bestDistance = Infinity;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      if (x < 0 || x >= width || owner[y * width + x] !== value) continue;
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        bestDistance = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * Smoothed pixel-space polyline of a macro river, one point per macro cell, ends fixed, with small
 * bends added: a river on a macro cell grid would otherwise run in the straight 45 degree and axis
 * lines the grid favours.
 */
function smoothedPoints(
  cells: Int32Array,
  macroWidth: number,
  seed: number,
): Array<[number, number]> {
  const n = cells.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = 2 * (cells[i]! % macroWidth) + 0.5;
    ys[i] = 2 * Math.floor(cells[i]! / macroWidth) + 0.5;
  }
  const points: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const r = Math.min(3, i, n - 1 - i);
    let x = 0;
    let y = 0;
    for (let j = i - r; j <= i + r; j += 1) {
      x += xs[j]!;
      y += ys[j]!;
    }
    points.push([x / (2 * r + 1), y / (2 * r + 1)]);
  }
  if (n < 6) return points;
  let length = 0;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    arc[i] = length;
  }
  const amplitude = Math.min(9, 3 + 0.02 * length);
  const bent: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const a = points[Math.max(0, i - 2)]!;
    const b = points[Math.min(n - 1, i + 2)]!;
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const norm = Math.sqrt(tx * tx + ty * ty);
    if (norm === 0) {
      bent.push(points[i]!);
      continue;
    }
    tx /= norm;
    ty /= norm;
    const taper = smoothstep(Math.min(i, n - 1 - i) / 6);
    const offset =
      Math.max(-1, Math.min(1, (noise2(seed, arc[i]! / 17, 0.5) * 2 - 1) * 1.8)) *
      amplitude *
      taper;
    bent.push([points[i]![0] - ty * offset, points[i]![1] + tx * offset]);
  }
  return bent;
}

/** Four-connected pixels along a polyline: short steps along the larger axis give natural staircases. */
function orthogonalTrace(
  points: ReadonlyArray<readonly [number, number]>,
  from: number,
  width: number,
  height: number,
): number[] {
  let cx = from % width;
  let cy = (from - cx) / width;
  const path = [from];
  for (const [px, py] of points) {
    const tx = Math.min(width - 1, Math.max(0, Math.round(px)));
    const ty = Math.min(height - 1, Math.max(0, Math.round(py)));
    while (cx !== tx || cy !== ty) {
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) cx += dx > 0 ? 1 : -1;
      else cy += dy > 0 ? 1 : -1;
      path.push(cy * width + cx);
    }
  }
  return path;
}

/** Turn the macro rivers into river pixels. */
export function rasterizeRivers(input: RiverRasterInput): RiverRasterResult {
  const { rivers, width, height, kind, heights } = input;
  const total = width * height;
  const owner = new Int16Array(total);
  const context: PixelContext = {
    width,
    height,
    kind,
    heights,
    owner,
    seed: seedFromString(input.seed, 'river-pixels'),
  };
  const scratch = new Scratch();
  const notes: RiverRasterNote[] = [];
  const out: PixelRiver[] = [];
  const failed: string[] = [];
  let skipped = 0;
  const emptyRiver = (river: MacroRiver): PixelRiver => ({
    id: river.id,
    named: river.named,
    pixels: new Int32Array(0),
    complete: false,
  });
  const giveUp = (river: MacroRiver): void => {
    out.push(emptyRiver(river));
    if (river.named) failed.push(river.id);
    else skipped += 1;
  };
  for (let index = 0; index < rivers.length; index += 1) {
    if (index % 16 === 0) input.signal?.throwIfAborted();
    const river = rivers[index]!;
    const self = index + 1;
    const parentRiver = river.parent >= 0 ? out[river.parent] : undefined;
    if (river.parent >= 0 && (parentRiver === undefined || parentRiver.pixels.length === 0)) {
      giveUp(river);
      continue;
    }
    const parent = river.parent >= 0 ? river.parent + 1 : 0;
    const cells = river.cells;
    // Where the parent river's pixels really run, near the macro cell it joins.
    const anchor =
      river.joinCell < 0
        ? undefined
        : nearestOwned(
            context,
            Math.min(width - 1, 2 * (river.joinCell % input.macroWidth) + 1),
            Math.min(height - 1, 2 * Math.floor(river.joinCell / input.macroWidth) + 1),
            parent,
            40,
          );
    const points = smoothedPoints(
      cells,
      input.macroWidth,
      seedFromString(input.seed, `bend:${river.id}`),
    );
    // The first pixel.
    let start = -1;
    let first = 0;
    if (river.junction === 'distributary' && anchor !== undefined) {
      let best = Infinity;
      const aim = points[Math.min(points.length - 1, 3)]!;
      for (let dy = -8; dy <= 8; dy += 1)
        for (let dx = -8; dx <= 8; dx += 1) {
          const px = anchor.x + dx;
          const py = anchor.y + dy;
          if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) continue;
          if (owner[py * width + px] !== parent) continue;
          for (const [ox, oy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const sx = px + ox;
            const sy = py + oy;
            const pixel = sy * width + sx;
            if (kind[pixel] !== LAND || owner[pixel] !== 0) continue;
            if (!singleContact(context, sx, sy, parent)) continue;
            const score = (sx - aim[0]) ** 2 + (sy - aim[1]) ** 2;
            if (score < best) {
              best = score;
              start = pixel;
            }
          }
        }
      first = 1;
    } else {
      // A source beside another river moves a little downstream.
      for (let k = 0; k < Math.min(8, cells.length - 3) && start < 0; k += 1) {
        start = cellPixel(context, cells[k]!, input.macroWidth);
        if (start >= 0) first = k + 1;
      }
    }
    if (start < 0 || (river.endsIn === 'river' && anchor === undefined)) {
      giveUp(river);
      continue;
    }
    const traced = orthogonalTrace(points.slice(first), start, width, height);
    const valid = (pixel: number): boolean =>
      kind[pixel] === LAND && !nearRiver(context, pixel % width, Math.floor(pixel / width));
    let path: number[] = [start];
    const lookahead = 48;
    for (let i = 1; i < traced.length; i += 1) {
      const pixel = traced[i]!;
      if (valid(pixel)) {
        path.push(pixel);
        continue;
      }
      // Blocked: join the trace again at the next free pixel by a short search.
      let next = -1;
      for (let j = i + 1; j < Math.min(traced.length, i + lookahead); j += 1)
        if (valid(traced[j]!)) {
          next = j;
          break;
        }
      const here = path[path.length - 1]!;
      let found: number[] | undefined;
      if (next >= 0)
        for (const margin of [8, 20, 40]) {
          const target = traced[next]!;
          const hx = here % width;
          const hy = (here - hx) / width;
          const tx = target % width;
          const ty = (target - tx) / width;
          found = search(context, scratch, {
            start: here,
            window: windowFor([here, target], width, height, margin),
            goal: target,
            tolerance: 0,
            aim: { x: tx, y: ty },
            guide: { ax: hx, ay: hy, bx: tx, by: ty },
            self,
            parent,
          });
          if (found !== undefined) break;
        }
      // Nothing to rejoin: the trace ran into water or another river, and the end search takes over.
      if (found === undefined) break;
      for (let k = 1; k < found.length; k += 1) path.push(found[k]!);
      i = next;
    }
    // The end: the mouth for most rivers, the parent for tributaries.
    let complete = false;
    const here = path[path.length - 1]!;
    const hx = here % width;
    const hy = (here - hx) / width;
    const endRiver = river.endsIn === 'river';
    if (!endRiver && atMouth(context, hx, hy)) complete = true;
    else {
      const last = points[points.length - 1]!;
      const jx = anchor?.x ?? Math.round(last[0]);
      const jy = anchor?.y ?? Math.round(last[1]);
      for (const margin of endRiver ? [10, 24, 48, 90] : [10, 24, 48]) {
        const target = endRiver ? jy * width + jx : here;
        const found = search(context, scratch, {
          start: here,
          window: windowFor([here, target], width, height, margin + (endRiver ? 16 : 0)),
          goalTest: endRiver
            ? (x, y) =>
                kind[y * width + x] === LAND &&
                Math.abs(x - jx) + Math.abs(y - jy) <= (margin > 60 ? 120 : 30) &&
                owner[y * width + x] === 0 &&
                singleContact(context, x, y, parent)
            : (x, y) =>
                owner[y * width + x] === 0 &&
                kind[y * width + x] === LAND &&
                atMouth(context, x, y),
          joinGoal: endRiver,
          aim: { x: jx, y: jy },
          guide: { ax: hx, ay: hy, bx: jx, by: jy },
          self,
          parent,
        });
        if (found !== undefined) {
          for (let k = 1; k < found.length; k += 1) path.push(found[k]!);
          complete = true;
          break;
        }
      }
    }
    path = removeChords(path, width);
    for (const pixel of path) owner[pixel] = self;
    if (!complete && river.named) failed.push(river.id);
    else if (!complete) skipped += 1;
    if ((path.length < 4 || !complete) && !river.named) {
      for (const pixel of path) owner[pixel] = 0;
      out.push(emptyRiver(river));
      continue;
    }
    out.push({ id: river.id, named: river.named, pixels: Int32Array.from(path), complete });
  }
  if (failed.length > 0)
    notes.push({
      code: 'MAP_RIVER_PIXEL_ROUTE_INCOMPLETE',
      severity: 'warning',
      message: `${failed.length} river(s) could not be routed to the end at full resolution: ${failed
        .slice(0, 8)
        .join(', ')}`,
      details: { rivers: failed.slice(0, 50), count: failed.length },
    });

  if (skipped > 0)
    notes.push({
      code: 'MAP_RIVER_STREAMS_DROPPED',
      severity: 'info',
      message: `${skipped} short stream(s) of the accumulation network found no room at full resolution and were dropped`,
      details: { streams: skipped },
    });

  // The pixel budget: drop the smallest unnamed headwaters (rivers nothing else joins) first.
  if (input.pixelCap !== undefined) {
    let used = 0;
    for (const river of out) used += river.pixels.length;
    if (used > input.pixelCap) {
      const children = new Int32Array(rivers.length);
      rivers.forEach((river, index) => {
        if (out[index]!.pixels.length > 0 && river.parent >= 0)
          children[river.parent] = children[river.parent]! + 1;
      });
      const order = rivers
        .map((river, index) => index)
        .filter((index) => !rivers[index]!.named && out[index]!.pixels.length > 0)
        .sort(
          (a, b) =>
            rivers[a]!.order - rivers[b]!.order ||
            rivers[a]!.catchment[rivers[a]!.catchment.length - 1]! -
              rivers[b]!.catchment[rivers[b]!.catchment.length - 1]! ||
            a - b,
        );
      let dropped = 0;
      for (let pass = 0; pass < 6 && used > input.pixelCap; pass += 1)
        for (const index of order) {
          if (used <= input.pixelCap) break;
          const river = out[index]!;
          if (river.pixels.length === 0 || children[index]! > 0) continue;
          used -= river.pixels.length;
          for (const pixel of river.pixels) owner[pixel] = 0;
          out[index] = emptyRiver(rivers[index]!);
          const parent = rivers[index]!.parent;
          if (parent >= 0) children[parent] = children[parent]! - 1;
          dropped += 1;
        }
      notes.push({
        code: 'MAP_RIVER_DENSITY',
        severity: used > input.pixelCap ? 'warning' : 'info',
        message: `The rivers came to more than ${input.pixelCap} pixels, the most a map should carry, so ${dropped} small headwater stream(s) were dropped${used > input.pixelCap ? `; the named rivers alone use ${used}` : ''}`,
        details: { cap: input.pixelCap, dropped, pixels: used },
      });
    }
  }

  // Beds: heights never rise downstream, then the bitmap.
  const bitmap = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel += 1)
    bitmap[pixel] = kind[pixel] === LAND ? RIVER_LAND_INDEX : RIVER_WATER_INDEX;
  const order = new Uint8Array(total);
  let pixels = 0;
  for (let index = 0; index < rivers.length; index += 1) {
    const river = rivers[index]!;
    const pixelRiver = out[index]!;
    const path = pixelRiver.pixels;
    if (path.length === 0) continue;
    let level = Infinity;
    for (let k = 0; k < path.length; k += 1) {
      const pixel = path[k]!;
      const cell = Math.min(
        river.cells.length - 1,
        Math.floor((k * river.cells.length) / path.length),
      );
      const w = river.width[cell]!;
      level = Math.min(level, heights[pixel]! - (0.25 + 0.06 * (w - 3)));
      heights[pixel] = Math.max(96, level);
      bitmap[pixel] = w;
      order[pixel] = Math.min(255, river.order);
    }
    if (river.parent < 0) bitmap[path[0]!] = RIVER_SOURCE_INDEX;
    else if (river.junction === 'tributary' && pixelRiver.complete)
      bitmap[path[path.length - 1]!] = RIVER_TRIBUTARY_END_INDEX;
    else if (river.junction === 'distributary') bitmap[path[0]!] = RIVER_DISTRIBUTARY_START_INDEX;
    pixels += path.length;
  }
  return { bitmap, order, rivers: out, pixels, notes };
}
