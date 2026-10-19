/**
 * Hydrology on the macro grid (ADR 0056): priority-flood conditioning with a slope epsilon, D8 flow
 * and accumulation, named rivers routed as least-cost paths over the conditioned heights, an
 * accumulation network above a threshold chosen for the target density, deltas, stream-power
 * carving with floodplains, and river widths by catchment. The result is a list of macro-cell
 * rivers that `river-raster.ts` turns into the one-pixel paths of `rivers.bmp`.
 */
import { ServiceError } from '../../core/result.js';
import { fillAreaStrip, type ResolvedGeography, type ResolvedRiver } from '../geography/index.js';
import { LAKE, LAND, MinHeap, NEIGHBOUR_DX, NEIGHBOUR_DY, NEIGHBOUR_LENGTH, SEA } from './grid.js';
import { LAND_FLOOR, type MacroRelief } from './macro-relief.js';
import { SQRT2, clamp, hash01, log2Approx, noise2, seedFromString, smoothstep } from './math.js';

/** Share of land pixels the river network should cover by default (vanilla: 2.28%). */
export const DEFAULT_RIVER_DENSITY = 0.02;
/** The most river pixels a map may carry: long networks slow the game. */
export const RIVER_PIXEL_CAP = 130_000;
/** Pixels written per macro cell of river, on average (orthogonal paths: between 2 and 4). */
const PIXELS_PER_CELL = 2.7;
/** A river may climb at most this much (map height units) along its route. */
export const MAXIMUM_RIVER_CLIMB = 22;

export interface HydrologyInput {
  geography: ResolvedGeography;
  macro: MacroRelief;
  seed: number;
  /** Share of land pixels the network covers; default `DEFAULT_RIVER_DENSITY`. */
  density?: number | undefined;
  /** Largest number of unnamed river systems; absent keeps every system the density allows. */
  count?: number | undefined;
  /** Rain per macro cell, a multiplier of one; later stages supply a rain-shadow field. */
  rainfall?: Float32Array | undefined;
  /** Number of land pixels at full resolution. */
  landPixels: number;
  signal?: AbortSignal | undefined;
}

export type RiverMouthKind = 'sea' | 'lake' | 'edge' | 'river';

/** One river as a chain of macro cells from the source to the last land cell. */
export interface MacroRiver {
  /** Geography id, or `stream:<n>` for the accumulation network. */
  readonly id: string;
  readonly name?: string;
  readonly named: boolean;
  /** Cells from source to mouth; indices into the macro grid. */
  readonly cells: Int32Array;
  /** Index into the river list of the river this one joins or branches from, or -1. */
  readonly parent: number;
  /** Cell of the parent river where it joins (a tributary) or branches (a distributary). */
  readonly joinCell: number;
  readonly junction: 'none' | 'tributary' | 'distributary';
  /** Declared size 1..5 (0 for the accumulation network). */
  readonly size: number;
  readonly endsIn: RiverMouthKind;
  /** Rain-weighted catchment at every cell. */
  readonly catchment: Float32Array;
  /** Width index 3..11 at every cell; never narrower downstream. */
  readonly width: Uint8Array;
  /** 1 for a headwater, one more than the highest tributary otherwise. */
  order: number;
  /** Total height the route climbs, in map values. */
  readonly climb: number;
}

export interface HydrologyNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface HydrologyResult {
  /** Macro heights after carving. */
  heights: Float32Array;
  /** Parents come before the rivers that join them. */
  rivers: MacroRiver[];
  /** 0 to 255: how deeply a macro cell was carved into a valley or floodplain. */
  valley: Uint8Array;
  /** Estimated river pixels at full resolution. */
  estimatedPixels: number;
  notes: HydrologyNote[];
}

interface Flood {
  filled: Float32Array;
  /** Receiving cell of every land cell; -1 for an outlet (water, the map edge or a sink). */
  receiver: Int32Array;
  /** Cells in the order the flood reached them: receivers before the cells they drain. */
  order: Int32Array;
  count: number;
}

/**
 * Rise per cell of the conditioned surface inside depressions and flats: a small base plus a hashed
 * share, so flat ground drains along an irregular tree instead of straight lines to the nearest outlet.
 */
function slope(cell: number): number {
  const mixed = Math.imul(cell ^ 0x2545f491, 0x9e3779b1);
  return 0.002 + 0.05 * (((mixed ^ (mixed >>> 15)) >>> 0) / 4294967296);
}

function isLandCell(kind: Uint8Array, cell: number): boolean {
  return kind[cell] === LAND;
}

function priorityFlood(
  height: Float32Array,
  kind: Uint8Array,
  mw: number,
  mh: number,
  sinks: Uint8Array | undefined,
  heap: MinHeap,
): Flood {
  const total = mw * mh;
  const filled = new Float32Array(total);
  const receiver = new Int32Array(total).fill(-1);
  const order = new Int32Array(total);
  const seen = new Uint8Array(total);
  heap.clear();
  for (let cell = 0; cell < total; cell += 1) {
    if (!isLandCell(kind, cell)) continue;
    const x = cell % mw;
    const y = (cell - x) / mw;
    let outlet = sinks?.[cell] === 1;
    if (!outlet)
      for (let n = 0; n < 8 && !outlet; n += 1) {
        const nx = x + NEIGHBOUR_DX[n]!;
        const ny = y + NEIGHBOUR_DY[n]!;
        if (nx < 0 || ny < 0 || nx >= mw || ny >= mh || !isLandCell(kind, ny * mw + nx))
          outlet = true;
      }
    if (!outlet) continue;
    seen[cell] = 1;
    filled[cell] = height[cell]!;
    heap.push(filled[cell]!, cell);
  }
  let count = 0;
  while (heap.length > 0) {
    const cell = heap.pop();
    order[count++] = cell;
    const x = cell % mw;
    const y = (cell - x) / mw;
    const level = filled[cell]!;
    for (let n = 0; n < 8; n += 1) {
      const nx = x + NEIGHBOUR_DX[n]!;
      const ny = y + NEIGHBOUR_DY[n]!;
      if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
      const next = ny * mw + nx;
      if (seen[next] === 1 || !isLandCell(kind, next)) continue;
      seen[next] = 1;
      receiver[next] = cell;
      const value = height[next]!;
      const rise = level + slope(next);
      filled[next] = value > rise ? value : rise;
      heap.push(filled[next], next);
    }
  }
  return { filled, receiver, order, count };
}

function accumulate(flood: Flood, rain: Float32Array, kind: Uint8Array): Float32Array {
  const acc = new Float32Array(rain.length);
  for (let cell = 0; cell < acc.length; cell += 1)
    acc[cell] = isLandCell(kind, cell) ? rain[cell]! : 0;
  for (let index = flood.count - 1; index >= 0; index -= 1) {
    const cell = flood.order[index]!;
    const receiver = flood.receiver[cell]!;
    if (receiver >= 0) acc[receiver] = acc[receiver]! + acc[cell]!;
  }
  return acc;
}

// ---------------------------------------------------------------------------------------------
// Routing of named rivers

interface Router {
  /**
   * Cheapest route from `start` to a goal cell. `blocked` cells are never entered; cells next to
   * an occupied cell cost more. Returns the cells from `start` to the goal, or undefined.
   */
  route(spec: RouteSpec): { cells: number[]; joined: number } | undefined;
}

interface RouteSpec {
  start: number;
  /** A goal cell, with a heuristic toward it. */
  goalCell?: number;
  /** Alternatively, a test for goal cells; `joined` reports the neighbour that made it a goal. */
  goalTest?: (cell: number) => number | undefined;
  /** Cells owned by another river: blocked, except those of `allowOwner`. */
  allowOwner?: number;
  /** A direction the route should keep to: stepping against it costs `weight` per cell. */
  bias?: { dx: number; dy: number; weight: number };
  limit?: number;
}

function createRouter(
  height: Float32Array,
  kind: Uint8Array,
  occupant: Int16Array,
  wander: Float32Array,
  mw: number,
  mh: number,
  heap: MinHeap,
): Router {
  const total = mw * mh;
  const dist = new Float32Array(total);
  const stamp = new Int32Array(total);
  const previous = new Int32Array(total);
  let run = 0;
  return {
    route(spec) {
      run += 1;
      heap.clear();
      const goalX = spec.goalCell === undefined ? 0 : spec.goalCell % mw;
      const goalY = spec.goalCell === undefined ? 0 : (spec.goalCell - goalX) / mw;
      const heuristic = (cell: number): number => {
        if (spec.goalCell === undefined) return 0;
        const x = cell % mw;
        const dx = x - goalX;
        const dy = (cell - x) / mw - goalY;
        return Math.sqrt(dx * dx + dy * dy);
      };
      stamp[spec.start] = run;
      dist[spec.start] = 0;
      previous[spec.start] = -1;
      heap.push(heuristic(spec.start), spec.start);
      let expanded = 0;
      const limit = spec.limit ?? total * 8;
      while (heap.length > 0) {
        const cell = heap.pop();
        const cost = dist[cell]!;
        if (heap.popKey > (cost + heuristic(cell)) * 1.0001 + 0.01) continue;
        let joined: number | undefined;
        if (spec.goalCell !== undefined) {
          if (cell === spec.goalCell) joined = -1;
        } else if (spec.goalTest !== undefined) joined = spec.goalTest(cell);
        if (joined !== undefined) {
          const cells: number[] = [];
          for (let at = cell; at >= 0; at = previous[at]!) cells.push(at);
          cells.reverse();
          return { cells, joined };
        }
        if (++expanded > limit) return undefined;
        const x = cell % mw;
        const y = (cell - x) / mw;
        for (let n = 0; n < 8; n += 1) {
          const nx = x + NEIGHBOUR_DX[n]!;
          const ny = y + NEIGHBOUR_DY[n]!;
          if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
          const next = ny * mw + nx;
          if (!isLandCell(kind, next)) continue;
          const owner = occupant[next]!;
          if (owner !== 0 && owner !== (spec.allowOwner ?? -1) + 1) continue;
          // Diagonal steps may not squeeze between two blocked cells.
          if (n % 2 === 1) {
            const a = y * mw + nx;
            const b = ny * mw + x;
            if (!isLandCell(kind, a) && !isLandCell(kind, b)) continue;
          }
          const length = NEIGHBOUR_LENGTH[n]!;
          const rise = height[next]! - height[cell]!;
          let step =
            length *
            (1 +
              4 * (rise > 0 ? rise : 0) +
              0.01 * (height[next]! - LAND_FLOOR) +
              4 * wander[next]!);
          // Keep clear of other rivers' channels so the pixel paths can stay apart.
          let crowded = false;
          for (let m = 0; m < 8 && !crowded; m += 1) {
            const mx = nx + NEIGHBOUR_DX[m]!;
            const my = ny + NEIGHBOUR_DY[m]!;
            if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
            const around = occupant[my * mw + mx]!;
            if (around !== 0 && around !== (spec.allowOwner ?? -1) + 1) crowded = true;
          }
          if (crowded) step += 6;
          if (spec.bias !== undefined) {
            const along =
              (NEIGHBOUR_DX[n]! * spec.bias.dx + NEIGHBOUR_DY[n]! * spec.bias.dy) / length;
            if (along < 0) step += spec.bias.weight * -along * length;
          }
          const candidate = Math.fround(cost + step);
          if (stamp[next] === run && dist[next]! <= candidate) continue;
          stamp[next] = run;
          dist[next] = candidate;
          previous[next] = cell;
          heap.push(Math.fround(candidate + heuristic(next)), next);
        }
      }
      return undefined;
    },
  };
}

function nearestLandCell(
  kind: Uint8Array,
  mw: number,
  mh: number,
  x: number,
  y: number,
  radius: number,
): number {
  const cx = clamp(Math.floor(x), 0, mw - 1);
  const cy = clamp(Math.floor(y), 0, mh - 1);
  if (isLandCell(kind, cy * mw + cx)) return cy * mw + cx;
  let best = -1;
  let bestDistance = Infinity;
  for (let dy = -radius; dy <= radius; dy += 1)
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
      const cell = ny * mw + nx;
      if (!isLandCell(kind, cell)) continue;
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        bestDistance = d;
        best = cell;
      }
    }
  return best;
}

function touchesWater(
  kind: Uint8Array,
  mw: number,
  mh: number,
  cell: number,
  wanted: number,
): boolean {
  const x = cell % mw;
  const y = (cell - x) / mw;
  for (let n = 0; n < 8; n += 1) {
    const nx = x + NEIGHBOUR_DX[n]!;
    const ny = y + NEIGHBOUR_DY[n]!;
    if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) {
      if (wanted === -1) return true;
      continue;
    }
    if (kind[ny * mw + nx] === wanted) return true;
  }
  return false;
}

interface NamedRoute {
  river: ResolvedRiver;
  cells: number[];
  parentId?: string;
  joinCell: number;
  endsIn: RiverMouthKind;
  climb: number;
}

/** The highest a route rises above the lowest point it has already passed: how far it runs uphill. */
function climbOf(height: Float32Array, cells: readonly number[]): number {
  let lowest = Infinity;
  let climb = 0;
  for (const cell of cells) {
    const value = height[cell]!;
    if (value < lowest) lowest = value;
    else if (value - lowest > climb) climb = value - lowest;
  }
  return climb;
}

// ---------------------------------------------------------------------------------------------

function fail(code: string, message: string, details: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

function riverSourceLake(river: ResolvedRiver): string | undefined {
  return river.source.type === 'lake' ? river.source.id : undefined;
}

function onEdge(mw: number, mh: number, cell: number): boolean {
  const x = cell % mw;
  const y = (cell - x) / mw;
  return x === 0 || y === 0 || x === mw - 1 || y === mh - 1;
}

interface NamedContext {
  geography: ResolvedGeography;
  macro: MacroRelief;
  router: Router;
  occupant: Int16Array;
  lakeOf: Int16Array;
  flood: Flood;
  conditioned: Float32Array;
  notes: HydrologyNote[];
  seed: number;
}

/** The macro cell holding a frame point, moved to the nearest land cell within `radius`. */
function landCellAt(macro: MacroRelief, x: number, y: number, radius: number): number {
  return nearestLandCell(
    macro.kind,
    macro.width,
    macro.height,
    x * macro.width,
    y * macro.height,
    radius,
  );
}

// ---------------------------------------------------------------------------------------------
// Meanders

interface MeanderContext {
  occupant: Int16Array;
  kind: Uint8Array;
  height: Float32Array;
  mw: number;
  mh: number;
  seed: number;
  /** Cells reserved by rivers not yet built: a displaced route may not run over them. */
  reserved?: Uint8Array;
}

function foreignCell(
  occupant: Int16Array,
  mw: number,
  mh: number,
  cell: number,
  own: number,
): boolean {
  const x = cell % mw;
  const y = (cell - x) / mw;
  for (let n = 0; n < 8; n += 1) {
    const nx = x + NEIGHBOUR_DX[n]!;
    const ny = y + NEIGHBOUR_DY[n]!;
    if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
    const owner = occupant[ny * mw + nx]!;
    if (owner !== 0 && owner !== own) return true;
  }
  return occupant[cell] !== 0 && occupant[cell] !== own;
}

/**
 * Give a least-cost route natural bends: its smoothed line is displaced sideways by a smooth noise
 * that dies away at both ends, and the result is traced back to 8-connected cells. A displaced route
 * that leaves land, touches another river or climbs noticeably is retried with half the amplitude,
 * and finally dropped.
 */
function meanderRoute(
  cells: number[],
  own: number,
  context: MeanderContext,
  name: string,
): number[] {
  const n = cells.length;
  if (n < 30) return cells;
  const { occupant, kind, mw, mh } = context;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - 4);
    const hi = Math.min(n - 1, i + 4);
    let x = 0;
    let y = 0;
    for (let j = lo; j <= hi; j += 1) {
      x += (cells[j]! % mw) + 0.5;
      y += Math.floor(cells[j]! / mw) + 0.5;
    }
    sx[i] = x / (hi - lo + 1);
    sy[i] = y / (hi - lo + 1);
  }
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    const ex = sx[i]! - sx[i - 1]!;
    const ey = sy[i]! - sy[i - 1]!;
    arc[i] = arc[i - 1]! + Math.sqrt(ex * ex + ey * ey);
  }
  const originalClimb = climbOf(context.height, cells);
  const seed = seedFromString(context.seed, `meander:${name}`);
  const keep = 4;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const amplitude = clamp(0.09 * n, 2, 13) / (1 << attempt);
    const points: Array<[number, number]> = [];
    for (let i = keep; i < n - keep; i += 1) {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      let tx = sx[b]! - sx[a]!;
      let ty = sy[b]! - sy[a]!;
      const length = Math.sqrt(tx * tx + ty * ty);
      if (length === 0) continue;
      tx /= length;
      ty /= length;
      const taper = smoothstep(Math.min(i, n - 1 - i) / 10);
      const offset =
        clamp((noise2(seed, arc[i]! / 26, 0.37) * 2 - 1) * 1.7, -1, 1) * amplitude * taper;
      points.push([sx[i]! - ty * offset, sy[i]! + tx * offset]);
    }
    const chain: number[] = cells.slice(0, keep);
    let valid = true;
    let previous = cells[keep - 1]!;
    const visit = (cell: number): boolean => {
      if (cell === chain[chain.length - 1]) return true;
      if (kind[cell] !== LAND || foreignCell(occupant, mw, mh, cell, own)) return false;
      if (context.reserved?.[cell] === 1 && occupant[cell] !== own) return false;
      chain.push(cell);
      return true;
    };
    const lineTo = (tx: number, ty: number): boolean => {
      const fx = previous % mw;
      const fy = Math.floor(previous / mw);
      const steps = Math.max(Math.abs(tx - fx), Math.abs(ty - fy));
      for (let step = 1; step <= steps; step += 1) {
        const x = Math.round(fx + ((tx - fx) * step) / steps);
        const y = Math.round(fy + ((ty - fy) * step) / steps);
        if (x < 0 || y < 0 || x >= mw || y >= mh) return false;
        if (!visit(y * mw + x)) return false;
      }
      previous = chain[chain.length - 1]!;
      return true;
    };
    for (const [px, py] of points) {
      if (!lineTo(Math.floor(px), Math.floor(py))) {
        valid = false;
        break;
      }
    }
    if (valid)
      for (const cell of cells.slice(n - keep)) {
        if (!lineTo(cell % mw, Math.floor(cell / mw))) {
          valid = false;
          break;
        }
      }
    if (!valid) continue;
    // Drop loops: a cell visited twice cuts the chain back to its first visit.
    const seen = new Map<number, number>();
    const result: number[] = [];
    for (const cell of chain) {
      const at = seen.get(cell);
      if (at !== undefined) {
        while (result.length > at + 1) seen.delete(result.pop()!);
        continue;
      }
      seen.set(cell, result.length);
      result.push(cell);
    }
    if (climbOf(context.height, result) > originalClimb + 8) continue;
    for (const cell of cells) if (occupant[cell] === own) occupant[cell] = 0;
    for (const cell of result) occupant[cell] = own;
    return result;
  }
  return cells;
}

function routeNamedRivers(context: NamedContext): NamedRoute[] {
  const { geography, macro, router, occupant, lakeOf, flood, conditioned, notes } = context;
  const mw = macro.width;
  const mh = macro.height;
  const kind = macro.kind;
  const routed: NamedRoute[] = [];
  const done = new Set<string>();
  const pending = [...geography.rivers].sort(
    (a, b) => b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const lakeIndex = new Map(geography.lakes.map((lake, index) => [lake.id, index + 1]));
  while (pending.length > 0) {
    const ready = pending.filter(
      (river) => river.mouth.type !== 'river' || done.has(river.mouth.id),
    );
    if (ready.length === 0)
      fail('MAP_RIVER_CYCLE', 'Rivers flow into each other in a cycle', {
        rivers: pending.map((river) => river.id).slice(0, 20),
      });
    for (const river of ready) {
      pending.splice(pending.indexOf(river), 1);
      const ownId = routed.length + 1;
      let start: number;
      function unreachable(reason: string, details: Record<string, unknown> = {}): never {
        return fail(
          'MAP_RIVER_UNREACHABLE_MOUTH',
          `River ${river.id} cannot reach its mouth: ${reason}`,
          { riverId: river.id, ...details },
        );
      }
      // The first via point or the mouth point steers the choice of a lake's outlet.
      const firstVia = river.via[0];
      if (river.source.type === 'lake') {
        const index = lakeIndex.get(river.source.id)!;
        const lake = geography.get('lake', river.source.id)!;
        const x0 = Math.max(0, Math.floor(lake.area.bounds.x0 * mw) - 2);
        const x1 = Math.min(mw - 1, Math.ceil(lake.area.bounds.x1 * mw) + 2);
        const y0 = Math.max(0, Math.floor(lake.area.bounds.y0 * mh) - 2);
        const y1 = Math.min(mh - 1, Math.ceil(lake.area.bounds.y1 * mh) + 2);
        let best = -1;
        let bestScore = Infinity;
        for (let y = y0; y <= y1; y += 1)
          for (let x = x0; x <= x1; x += 1) {
            const cell = y * mw + x;
            if (!isLandCell(kind, cell) || occupant[cell] !== 0) continue;
            let rim = false;
            for (let n = 0; n < 8 && !rim; n += 1) {
              const nx = x + NEIGHBOUR_DX[n]!;
              const ny = y + NEIGHBOUR_DY[n]!;
              if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && lakeOf[ny * mw + nx] === index)
                rim = true;
            }
            if (!rim) continue;
            const score =
              firstVia === undefined
                ? conditioned[cell]!
                : (x + 0.5 - firstVia.x * mw) * (x + 0.5 - firstVia.x * mw) +
                  (y + 0.5 - firstVia.y * mh) * (y + 0.5 - firstVia.y * mh);
            if (score < bestScore) {
              bestScore = score;
              best = cell;
            }
          }
        if (best < 0) unreachable(`its source lake ${river.source.id} has no free shore`);
        start = best;
      } else {
        if (river.source.type !== 'point')
          return fail(
            'MAP_RIVER_SOURCE_NOT_LAND',
            `River ${river.id} must start at a point or a lake`,
            {
              riverId: river.id,
            },
          );
        start = landCellAt(macro, river.source.x, river.source.y, 8);
        if (start < 0)
          fail(
            'MAP_RIVER_SOURCE_NOT_LAND',
            `The source of river ${river.id} has no land within reach`,
            {
              riverId: river.id,
            },
          );
        if (occupant[start] !== 0) {
          let free = -1;
          for (let r = 1; r <= 3 && free < 0; r += 1)
            for (let dy = -r; dy <= r && free < 0; dy += 1)
              for (let dx = -r; dx <= r && free < 0; dx += 1) {
                const x = (start % mw) + dx;
                const y = Math.floor(start / mw) + dy;
                if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
                const cell = y * mw + x;
                if (isLandCell(kind, cell) && occupant[cell] === 0) free = cell;
              }
          if (free < 0) unreachable('its source is already taken by another river');
          start = free;
        }
      }
      const cells: number[] = [start];
      occupant[start] = ownId;
      let current = start;
      const append = (leg: number[]): void => {
        for (let index = 1; index < leg.length; index += 1) {
          cells.push(leg[index]!);
          occupant[leg[index]!] = ownId;
        }
        current = cells[cells.length - 1]!;
      };
      for (const via of river.via) {
        const target = landCellAt(macro, via.x, via.y, 6);
        if (target < 0 || target === current || occupant[target] !== 0) continue;
        const leg = router.route({ start: current, goalCell: target });
        if (leg === undefined)
          unreachable('a via point cannot be reached over land', { via: { x: via.x, y: via.y } });
        append(leg.cells);
      }
      let joinCell = -1;
      let parentId: string | undefined;
      let endsIn: RiverMouthKind = 'sea';
      const mouth = river.mouth;
      let final: { cells: number[]; joined: number } | undefined;
      // A river that has run a while keeps its general direction toward an open "sea" mouth.
      let bias: { dx: number; dy: number; weight: number } | undefined;
      if (cells.length >= 12) {
        const dx = (current % mw) - (start % mw);
        const dy = Math.floor(current / mw) - Math.floor(start / mw);
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length >= 8) bias = { dx: dx / length, dy: dy / length, weight: 1.5 };
      }
      if (mouth.type === 'sea') {
        final = router.route({
          start: current,
          goalTest: (cell) =>
            touchesWater(kind, mw, mh, cell, SEA) || onEdge(mw, mh, cell) ? -1 : undefined,
          ...(bias === undefined ? {} : { bias }),
        });
        if (final === undefined) unreachable(`no coast of ${mouth.id} lies on its land`);
      } else if (mouth.type === 'lake') {
        const index = lakeIndex.get(mouth.id)!;
        final = router.route({
          start: current,
          goalTest: (cell) => {
            const x = cell % mw;
            const y = (cell - x) / mw;
            for (let n = 0; n < 8; n += 1) {
              const nx = x + NEIGHBOUR_DX[n]!;
              const ny = y + NEIGHBOUR_DY[n]!;
              if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && lakeOf[ny * mw + nx] === index)
                return -1;
            }
            return undefined;
          },
        });
        if (final === undefined) unreachable(`lake ${mouth.id} is not reachable over land`);
        endsIn = 'lake';
      } else if (mouth.type === 'river') {
        const parentIndex = routed.findIndex((route) => route.river.id === mouth.id);
        const parentOwner = parentIndex + 1;
        final = router.route({
          start: current,
          goalTest: (cell) => {
            const x = cell % mw;
            const y = (cell - x) / mw;
            for (let n = 0; n < 8; n += 1) {
              const nx = x + NEIGHBOUR_DX[n]!;
              const ny = y + NEIGHBOUR_DY[n]!;
              if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
              if (occupant[ny * mw + nx] === parentOwner) return ny * mw + nx;
            }
            return undefined;
          },
        });
        if (final === undefined) unreachable(`river ${mouth.id} is not reachable over land`);
        parentId = mouth.id;
        joinCell = final.joined;
        endsIn = 'river';
      } else {
        const target = landCellAt(macro, mouth.x, mouth.y, 8);
        if (target < 0) unreachable('its mouth lies far from any land');
        final =
          target === current
            ? { cells: [current], joined: -1 }
            : router.route({ start: current, goalCell: target });
        if (final === undefined) unreachable('its mouth cannot be reached over land');
      }
      append(final.cells);
      if (mouth.type === 'point') {
        // Past a mouth drawn on land, the river follows the conditioned flow to the water.
        let guard = 4096;
        while (
          guard-- > 0 &&
          !touchesWater(kind, mw, mh, current, SEA) &&
          !touchesWater(kind, mw, mh, current, LAKE) &&
          !onEdge(mw, mh, current)
        ) {
          const next = flood.receiver[current]!;
          if (next < 0 || occupant[next] !== 0) break;
          cells.push(next);
          occupant[next] = ownId;
          current = next;
        }
        endsIn = touchesWater(kind, mw, mh, current, LAKE)
          ? 'lake'
          : touchesWater(kind, mw, mh, current, SEA)
            ? 'sea'
            : 'edge';
      } else if (mouth.type === 'sea')
        endsIn = touchesWater(kind, mw, mh, current, SEA) ? 'sea' : 'edge';
      cells.splice(
        0,
        cells.length,
        ...meanderRoute(
          cells,
          ownId,
          { occupant, kind, height: conditioned, mw, mh, seed: context.seed },
          river.id,
        ),
      );
      const climb = climbOf(conditioned, cells);
      if (climb > MAXIMUM_RIVER_CLIMB)
        unreachable(
          `its route would climb ${Math.round(climb)} height units over a divide (the limit is ${MAXIMUM_RIVER_CLIMB})`,
          { climb: Math.round(climb) },
        );
      routed.push({
        river,
        cells,
        ...(parentId === undefined ? {} : { parentId }),
        joinCell,
        endsIn,
        climb,
      });
      done.add(river.id);
    }
  }
  void notes;
  return routed;
}

// ---------------------------------------------------------------------------------------------
// Deltas

const DELTA_COS = 0.7660444;
const DELTA_SIN = 0.6427876;

function addDeltas(
  rivers: MacroRiver[],
  named: readonly NamedRoute[],
  geography: ResolvedGeography,
  router: Router,
  occupant: Int16Array,
  kind: Uint8Array,
  mw: number,
  mh: number,
  notes: HydrologyNote[],
): void {
  void geography;
  const count = named.length;
  for (let index = 0; index < count; index += 1) {
    const route = named[index]!;
    if (!route.river.delta || (route.endsIn !== 'sea' && route.endsIn !== 'lake')) continue;
    const n = route.cells.length;
    if (n < 14) {
      notes.push({
        code: 'MAP_RIVER_DELTA_SKIPPED',
        severity: 'info',
        message: `River ${route.river.id} is too short for a delta`,
        details: { riverId: route.river.id },
      });
      continue;
    }
    const b = n - 1 - clamp(Math.round(0.14 * n), 6, 28);
    const branch = route.cells[b]!;
    const last = route.cells[n - 1]!;
    const bx = branch % mw;
    const by = (branch - bx) / mw;
    let dx = (last % mw) - bx;
    let dy = Math.floor(last / mw) - by;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) continue;
    dx /= length;
    dy /= length;
    let made = 0;
    for (const sign of [1, -1]) {
      const rx = dx * DELTA_COS - dy * DELTA_SIN * sign;
      const ry = dx * DELTA_SIN * sign + dy * DELTA_COS;
      // The first cell is a free neighbour of the branch cell on this side of the main channel.
      let start = -1;
      let best = -Infinity;
      for (let k = 0; k < 8; k += 1) {
        const x = bx + NEIGHBOUR_DX[k]!;
        const y = by + NEIGHBOUR_DY[k]!;
        if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
        const cell = y * mw + x;
        if (!isLandCell(kind, cell) || occupant[cell] !== 0) continue;
        const score = NEIGHBOUR_DX[k]! * rx + NEIGHBOUR_DY[k]! * ry;
        if (score > best) {
          best = score;
          start = cell;
        }
      }
      if (start < 0) continue;
      const ownId = rivers.length + 1;
      occupant[start] = ownId;
      // The channel fans out at an angle and ends at the first coast it reaches.
      const found = router.route({
        start,
        goalTest: (cell) =>
          touchesWater(kind, mw, mh, cell, route.endsIn === 'lake' ? LAKE : SEA) ? -1 : undefined,
        bias: { dx: rx, dy: ry, weight: 3 },
        limit: 20_000,
      });
      if (found === undefined || found.cells.length > 4 * (n - 1 - b) + 16) {
        occupant[start] = 0;
        continue;
      }
      const cells = found.cells;
      for (const cell of cells) occupant[cell] = ownId;
      const parentIndex = rivers.findIndex((river) => river.id === route.river.id);
      const parent = rivers[parentIndex]!;
      const at = Math.max(0, parent.cells.indexOf(branch));
      const share = 0.4 * parent.catchment[at]!;
      rivers.push({
        id: `${route.river.id}~delta${made + 1}`,
        ...(route.river.name === undefined ? {} : { name: route.river.name }),
        named: true,
        cells: Int32Array.from(cells),
        parent: parentIndex,
        joinCell: branch,
        junction: 'distributary',
        size: Math.max(1, route.river.size - 1),
        endsIn: route.endsIn,
        catchment: new Float32Array(cells.length).fill(share),
        width: new Uint8Array(cells.length),
        order: 1,
        climb: 0,
      });
      made += 1;
    }
    if (made === 0)
      notes.push({
        code: 'MAP_RIVER_DELTA_SKIPPED',
        severity: 'info',
        message: `River ${route.river.id} has no room for distributaries near its mouth`,
        details: { riverId: route.river.id },
      });
  }
}

// ---------------------------------------------------------------------------------------------
// The accumulation network

interface StreamSet {
  isStream: Uint8Array;
  threshold: number;
}

function selectStreams(input: {
  flood: Flood;
  acc: Float32Array;
  kind: Uint8Array;
  channel: Uint8Array;
  budgetCells: number;
  count: number | undefined;
  mw: number;
  mh: number;
}): StreamSet {
  const { flood, acc, kind, channel, mw, mh } = input;
  const total = acc.length;
  const isStream = new Uint8Array(total);
  const minimum = 6;
  if (input.budgetCells < 8 || input.count === 0) return { isStream, threshold: Infinity };
  let candidates = 0;
  for (let cell = 0; cell < total; cell += 1)
    if (isLandCell(kind, cell) && channel[cell] === 0 && acc[cell]! >= minimum) candidates += 1;
  if (candidates === 0) return { isStream, threshold: Infinity };
  const values = new Float32Array(candidates);
  let fill = 0;
  for (let cell = 0; cell < total; cell += 1)
    if (isLandCell(kind, cell) && channel[cell] === 0 && acc[cell]! >= minimum)
      values[fill++] = acc[cell]!;
  values.sort();
  const keep = Math.min(candidates, Math.floor(input.budgetCells));
  const threshold = Math.max(minimum, values[candidates - keep]!);
  for (let cell = 0; cell < total; cell += 1)
    if (isLandCell(kind, cell) && channel[cell] === 0 && acc[cell]! >= threshold)
      isStream[cell] = 1;
  // Systems: the trees that drain to one outlet. Keep the largest when a count is given and drop dust.
  const root = new Int32Array(total).fill(-1);
  const size = new Int32Array(total);
  for (let index = 0; index < flood.count; index += 1) {
    const cell = flood.order[index]!;
    if (isStream[cell] === 0) continue;
    const receiver = flood.receiver[cell]!;
    const rootCell = receiver >= 0 && isStream[receiver] === 1 ? root[receiver]! : cell;
    root[cell] = rootCell;
    size[rootCell] = size[rootCell]! + 1;
  }
  const roots: number[] = [];
  for (let cell = 0; cell < total; cell += 1)
    if (isStream[cell] === 1 && root[cell] === cell) roots.push(cell);
  roots.sort((a, b) => acc[b]! - acc[a]! || a - b);
  const keepRoot = new Set<number>();
  for (const cell of roots) {
    if (size[cell]! < 8) continue;
    if (input.count !== undefined && keepRoot.size >= input.count) break;
    keepRoot.add(cell);
  }
  for (let cell = 0; cell < total; cell += 1)
    if (isStream[cell] === 1 && !keepRoot.has(root[cell]!)) isStream[cell] = 0;
  pruneStubs(isStream, flood, mw, mh);
  return { isStream, threshold };
}

/** Remove short headwater stubs (fewer than 5 cells between a source and the next confluence). */
function pruneStubs(isStream: Uint8Array, flood: Flood, mw: number, mh: number): void {
  const total = isStream.length;
  const children = new Uint8Array(total);
  const countChildren = (): void => {
    children.fill(0);
    for (let cell = 0; cell < total; cell += 1) {
      if (isStream[cell] === 0) continue;
      const receiver = flood.receiver[cell]!;
      if (receiver >= 0 && isStream[receiver] === 1) children[receiver] = children[receiver]! + 1;
    }
  };
  void mw;
  void mh;
  for (let round = 0; round < 3; round += 1) {
    countChildren();
    let removed = 0;
    for (let cell = 0; cell < total; cell += 1) {
      if (isStream[cell] === 0 || children[cell] !== 0) continue;
      const path: number[] = [];
      let at = cell;
      while (isStream[at] === 1 && children[at]! <= 1) {
        path.push(at);
        const receiver = flood.receiver[at]!;
        if (receiver < 0 || isStream[receiver] === 0) break;
        if (children[receiver]! >= 2) break;
        at = receiver;
      }
      // A stub that ends at a confluence (or an outlet with a sibling) is short.
      const last = path[path.length - 1]!;
      const receiver = flood.receiver[last]!;
      const joins = receiver >= 0 && isStream[receiver] === 1 && children[receiver]! >= 2;
      if (joins && path.length < 5) {
        for (const stub of path) isStream[stub] = 0;
        removed += 1;
      }
    }
    if (removed === 0) break;
  }
}

function decomposeStreams(input: {
  stream: StreamSet;
  flood: Flood;
  acc: Float32Array;
  channel: Uint8Array;
  named: readonly NamedRoute[];
  rivers: MacroRiver[];
  riverIndex: Map<string, number>;
  occupant: Int16Array;
  kind: Uint8Array;
  height: Float32Array;
  seed: number;
  mw: number;
  mh: number;
}): void {
  const { stream, flood, acc, channel, named, rivers, riverIndex, mw, mh } = input;
  const { isStream } = stream;
  const total = isStream.length;
  // Which named river owns each channel cell.
  const channelOwner = new Map<number, number>();
  for (const route of named) {
    const index = riverIndex.get(route.river.id)!;
    for (const cell of route.cells) channelOwner.set(cell, index);
  }
  void channel;
  const roots: number[] = [];
  for (let cell = 0; cell < total; cell += 1) {
    if (isStream[cell] === 0) continue;
    const receiver = flood.receiver[cell]!;
    if (receiver < 0 || isStream[receiver] === 0) roots.push(cell);
  }
  roots.sort((a, b) => acc[b]! - acc[a]! || a - b);
  let counter = 0;
  for (const rootCell of roots) {
    const receiver = flood.receiver[rootCell]!;
    const owner = receiver >= 0 ? channelOwner.get(receiver) : undefined;
    const stack: Array<{ cell: number; parent: number; join: number; ends: RiverMouthKind }> = [
      {
        cell: rootCell,
        parent: owner ?? -1,
        join: owner === undefined ? -1 : receiver,
        ends: owner === undefined ? 'sea' : 'river',
      },
    ];
    while (stack.length > 0) {
      // River ids are 16 bits wide; the network stops growing long before that matters.
      if (rivers.length >= 30_000) return;
      const item = stack.pop()!;
      let chain: number[] = [];
      let cell = item.cell;
      const reserved = rivers.length;
      const spawnedFrom = stack.length;
      for (;;) {
        chain.push(cell);
        const x = cell % mw;
        const y = (cell - x) / mw;
        let best = -1;
        const others: number[] = [];
        for (let n = 0; n < 8; n += 1) {
          const nx = x + NEIGHBOUR_DX[n]!;
          const ny = y + NEIGHBOUR_DY[n]!;
          if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
          const next = ny * mw + nx;
          if (isStream[next] === 0 || flood.receiver[next] !== cell) continue;
          if (best < 0 || acc[next]! > acc[best]! || (acc[next] === acc[best] && next < best)) {
            if (best >= 0) others.push(best);
            best = next;
          } else others.push(next);
        }
        if (best < 0) break;
        others.sort((a, b) => acc[a]! - acc[b]! || b - a);
        for (const other of others)
          stack.push({ cell: other, parent: reserved, join: cell, ends: 'river' });
        cell = best;
      }
      chain.reverse();
      const original = chain;
      const id = `stream:${++counter}`;
      if (chain.length >= 30 && rivers.length < 30_000) {
        const own = rivers.length + 1;
        for (const c of chain) input.occupant[c] = own;
        chain = meanderRoute(
          chain,
          own,
          {
            occupant: input.occupant,
            kind: input.kind,
            height: input.height,
            mw,
            mh,
            seed: input.seed,
            reserved: isStream,
          },
          id,
        );
        if (chain !== original)
          // Tributaries that were to join a cell of the old route join the nearest cell of the new one.
          for (let k = spawnedFrom; k < stack.length; k += 1) {
            const spawned = stack[k]!;
            const jx = spawned.join % mw;
            const jy = Math.floor(spawned.join / mw);
            let nearest = spawned.join;
            let best = Infinity;
            for (const c of chain) {
              const d =
                ((c % mw) - jx) * ((c % mw) - jx) +
                (Math.floor(c / mw) - jy) * (Math.floor(c / mw) - jy);
              if (d < best) {
                best = d;
                nearest = c;
              }
            }
            spawned.join = nearest;
          }
      }
      const catchment = new Float32Array(chain.length);
      chain.forEach((c, index) => {
        catchment[index] =
          chain === original
            ? acc[c]!
            : acc[
                original[
                  Math.min(
                    original.length - 1,
                    Math.floor((index * original.length) / chain.length),
                  )
                ]!
              ]!;
      });
      rivers.push({
        id,
        named: false,
        cells: Int32Array.from(chain),
        parent: item.parent,
        joinCell: item.join,
        junction: item.parent < 0 ? 'none' : 'tributary',
        size: 0,
        endsIn: item.ends,
        catchment,
        width: new Uint8Array(chain.length),
        order: 1,
        climb: 0,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Widths and orders

/** Widths of declared sizes 1 to 5 at the mouth. */
const SIZE_WIDTH: readonly number[] = [3, 3, 4, 6, 8, 10];

function computeWidths(rivers: readonly MacroRiver[], threshold: number): void {
  let maximum = 1;
  for (const river of rivers)
    for (const value of river.catchment) if (value > maximum) maximum = value;
  const minimum = Number.isFinite(threshold) ? Math.max(threshold, 4) : 8;
  const span = log2Approx(maximum / minimum);
  for (const river of rivers) {
    const cells = river.cells.length;
    let running = 3;
    for (let index = 0; index < cells; index += 1) {
      const ratio = river.catchment[index]! / minimum;
      let bin = span > 0.001 ? 3 + Math.floor((8 * log2Approx(ratio)) / span) : 3;
      if (river.named && river.junction !== 'distributary') {
        const ramp = 3 + Math.round(((SIZE_WIDTH[river.size] ?? 3) - 3) * ((index + 1) / cells));
        if (ramp > bin) bin = ramp;
      }
      if (bin > running) running = bin;
      river.width[index] = clamp(running, 3, 11);
    }
  }
  // A river below a confluence is at least as wide as each river that joined it.
  for (let index = rivers.length - 1; index >= 0; index -= 1) {
    const child = rivers[index]!;
    if (child.parent < 0 || child.junction !== 'tributary') continue;
    const parent = rivers[child.parent]!;
    const at = parent.cells.indexOf(child.joinCell);
    if (at < 0) continue;
    const floor = child.width[child.cells.length - 1]!;
    for (let k = at; k < parent.cells.length; k += 1)
      if (parent.width[k]! < floor) parent.width[k] = floor;
  }
}

function computeOrders(rivers: readonly MacroRiver[]): void {
  for (let index = rivers.length - 1; index >= 0; index -= 1) {
    const child = rivers[index]!;
    if (child.parent < 0) continue;
    const parent = rivers[child.parent]!;
    if (child.order + 1 > parent.order) parent.order = child.order + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Carving

/** Stream-power constant: height lost per iteration is `K * sqrt(catchment) * slope`. */
const STREAM_POWER = 0.06;
const CARVING_STEPS = 8;

function carveValleys(input: {
  macro: MacroRelief;
  rivers: readonly MacroRiver[];
  mw: number;
  mh: number;
}): { heights: Float32Array; valley: Uint8Array } {
  const { macro, rivers, mw, mh } = input;
  const total = mw * mh;
  const heights = Float32Array.from(macro.heights);
  const before = Float32Array.from(macro.heights);
  for (let step = 0; step < CARVING_STEPS; step += 1)
    for (const river of rivers) {
      const cells = river.cells;
      for (let k = 0; k < cells.length; k += 1) {
        const cell = cells[k]!;
        const receiver = k + 1 < cells.length ? heights[cells[k + 1]!]! : LAND_FLOOR;
        const drop = heights[cell]! - receiver;
        if (drop <= 0) continue;
        const loss = Math.min(STREAM_POWER * Math.sqrt(river.catchment[k]!) * drop, 0.35 * drop);
        heights[cell] = Math.max(LAND_FLOOR + 0.4, heights[cell]! - loss);
      }
    }
  // Beds never rise downstream.
  for (const river of rivers) {
    let level = Infinity;
    for (const cell of river.cells) {
      level = Math.min(level, heights[cell]!);
      heights[cell] = level;
    }
  }
  // Valleys and floodplains around the larger rivers: every cell takes the nearest wide river's bed.
  const widthAt = new Uint8Array(total);
  const nearest = new Int32Array(total).fill(-1);
  const distance = new Float32Array(total).fill(Infinity);
  const radiusOf = (width: number): number => (width < 5 ? 0 : 1.5 + (width - 5));
  for (const river of rivers)
    river.cells.forEach((cell, k) => {
      const width = river.width[k]!;
      if (radiusOf(width) <= 0) return;
      widthAt[cell] = width;
      nearest[cell] = cell;
      distance[cell] = 0;
    });
  const relax = (cell: number, x: number, y: number, neighbour: number): void => {
    const source = nearest[neighbour]!;
    if (source < 0) return;
    const sx = source % mw;
    const dx = x - sx;
    const dy = y - (source - sx) / mw;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < distance[cell]! && d <= radiusOf(widthAt[source]!)) {
      distance[cell] = d;
      nearest[cell] = source;
    }
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let y = 0; y < mh; y += 1)
      for (let x = 0; x < mw; x += 1) {
        const cell = y * mw + x;
        if (x > 0) relax(cell, x, y, cell - 1);
        if (y > 0) {
          relax(cell, x, y, cell - mw);
          if (x > 0) relax(cell, x, y, cell - mw - 1);
          if (x < mw - 1) relax(cell, x, y, cell - mw + 1);
        }
      }
    for (let y = mh - 1; y >= 0; y -= 1)
      for (let x = mw - 1; x >= 0; x -= 1) {
        const cell = y * mw + x;
        if (x < mw - 1) relax(cell, x, y, cell + 1);
        if (y < mh - 1) {
          relax(cell, x, y, cell + mw);
          if (x < mw - 1) relax(cell, x, y, cell + mw + 1);
          if (x > 0) relax(cell, x, y, cell + mw - 1);
        }
      }
  }
  for (let cell = 0; cell < total; cell += 1) {
    const source = nearest[cell]!;
    if (source < 0 || source === cell || macro.kind[cell] !== LAND) continue;
    const radius = radiusOf(widthAt[source]!);
    const d = distance[cell]!;
    const flat = 0.45 * radius;
    const profile = d <= flat ? 0.12 * d : 0.12 * flat + 1.1 * (d - flat);
    const target = heights[source]! + profile;
    if (target < heights[cell]!) {
      const weight = 1 - smoothstep((d - 0.6 * radius) / (0.4 * radius));
      heights[cell] = heights[cell]! + (target - heights[cell]!) * weight;
    }
  }
  const valley = new Uint8Array(total);
  for (let cell = 0; cell < total; cell += 1)
    if (macro.kind[cell] === LAND)
      valley[cell] = clamp(Math.round((before[cell]! - heights[cell]!) * 10), 0, 255);
  void SQRT2;
  return { heights, valley };
}

// ---------------------------------------------------------------------------------------------

/**
 * Run the hydrology of the model on the macro relief. The macro heights are copied, never
 * modified in place.
 */
export function synthesizeHydrology(input: HydrologyInput): HydrologyResult {
  const { geography, macro, seed } = input;
  const mw = macro.width;
  const mh = macro.height;
  const total = mw * mh;
  const kind = macro.kind;
  const notes: HydrologyNote[] = [];
  const rain = input.rainfall ?? new Float32Array(total).fill(1);
  const heap = new MinHeap(total);

  // Conditioned heights: a tiny hash jitter breaks ties so flat ground does not drain in straight lines.
  const jitterSeed = seedFromString(seed, 'hydrology-jitter');
  const conditioned = new Float32Array(total);
  for (let cell = 0; cell < total; cell += 1) {
    if (!isLandCell(kind, cell)) continue;
    const x = cell % mw;
    conditioned[cell] =
      macro.heights[cell]! + (hash01(jitterSeed, x, (cell - x) / mw) - 0.5) * 0.03;
  }
  const first = priorityFlood(conditioned, kind, mw, mh, undefined, heap);

  // Lakes by cell, for sources and mouths.
  const lakeOf = new Int16Array(total);
  if (geography.lakes.length > 0) {
    const mask = new Int16Array(total);
    geography.lakes.forEach((lake, index) => {
      fillAreaStrip(lake.area, { width: mw, height: mh }, { y0: 0, y1: mh }, mask, index + 1);
      const x0 = Math.max(0, Math.floor(lake.area.bounds.x0 * mw) - 1);
      const x1 = Math.min(mw - 1, Math.ceil(lake.area.bounds.x1 * mw) + 1);
      const y0 = Math.max(0, Math.floor(lake.area.bounds.y0 * mh) - 1);
      const y1 = Math.min(mh - 1, Math.ceil(lake.area.bounds.y1 * mh) + 1);
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const cell = y * mw + x;
          if (mask[cell] !== 0 && kind[cell] === LAKE) lakeOf[cell] = index + 1;
        }
        mask.fill(0, y * mw + x0, y * mw + x1 + 1);
      }
    });
  }

  // Named rivers, parents first, each as a least-cost route over the conditioned heights.
  const occupant = new Int16Array(total);
  const wander = new Float32Array(total);
  const wanderSeed = seedFromString(seed, 'river-wander');
  for (let cell = 0; cell < total; cell += 1) {
    const x = cell % mw;
    const y = (cell - x) / mw;
    wander[cell] =
      0.55 * noise2(wanderSeed, x / 22, y / 22) + 0.45 * noise2(wanderSeed + 1, x / 7, y / 7);
  }
  const router = createRouter(first.filled, kind, occupant, wander, mw, mh, heap);
  const named = routeNamedRivers({
    geography,
    macro,
    router,
    occupant,
    lakeOf,
    flood: first,
    conditioned,
    notes,
    seed,
  });

  // Burn the channels into the heights and flood again with the channels as outlets, so every
  // other cell drains either to the coast or into a channel.
  const channel = new Uint8Array(total);
  const burned = Float32Array.from(conditioned);
  for (const route of named) {
    let level = Infinity;
    for (const cell of route.cells) {
      level = Math.min(conditioned[cell]! - 0.4, level - 0.003);
      burned[cell] = level;
      channel[cell] = 1;
    }
  }
  const second = priorityFlood(burned, kind, mw, mh, channel, heap);
  const acc = accumulate(second, rain, kind);

  // Catchment along every named channel: its own cells, the cells draining into them and the
  // tributaries that join.
  const catchments = new Map<string, Float32Array>();
  for (const route of [...named].reverse()) {
    const values = new Float32Array(route.cells.length);
    let sum = 0;
    route.cells.forEach((cell, index) => {
      sum += acc[cell]!;
      for (const other of named)
        if (other.parentId === route.river.id && other.joinCell === cell) {
          const child = catchments.get(other.river.id);
          if (child !== undefined) sum += child[child.length - 1]!;
        }
      values[index] = sum;
    });
    catchments.set(route.river.id, values);
  }

  // The accumulation network.
  const namedPixels = named.reduce((sum, route) => sum + route.cells.length * PIXELS_PER_CELL, 0);
  const density = clamp(input.density ?? DEFAULT_RIVER_DENSITY, 0, 0.05);
  const budget = Math.max(0, Math.min(RIVER_PIXEL_CAP, density * input.landPixels) - namedPixels);
  const stream = selectStreams({
    flood: second,
    acc,
    kind,
    channel,
    budgetCells: budget / PIXELS_PER_CELL,
    count: input.count,
    mw,
    mh,
  });

  const rivers: MacroRiver[] = [];
  const riverIndex = new Map<string, number>();
  for (const route of named) {
    const parent = route.parentId === undefined ? -1 : (riverIndex.get(route.parentId) ?? -1);
    riverIndex.set(route.river.id, rivers.length);
    rivers.push({
      id: route.river.id,
      ...(route.river.name === undefined ? {} : { name: route.river.name }),
      named: true,
      cells: Int32Array.from(route.cells),
      parent,
      joinCell: route.joinCell,
      junction: route.parentId === undefined ? 'none' : 'tributary',
      size: route.river.size,
      endsIn: route.endsIn,
      catchment: catchments.get(route.river.id)!,
      width: new Uint8Array(route.cells.length),
      order: 1,
      climb: route.climb,
    });
  }
  addDeltas(rivers, named, geography, router, occupant, kind, mw, mh, notes);
  decomposeStreams({
    stream,
    flood: second,
    acc,
    channel,
    named,
    rivers,
    riverIndex,
    occupant,
    kind,
    height: conditioned,
    seed,
    mw,
    mh,
  });
  computeWidths(rivers, stream.threshold);
  computeOrders(rivers);
  const carved = carveValleys({ macro, rivers, mw, mh });
  let estimated = 0;
  for (const river of rivers) estimated += river.cells.length * PIXELS_PER_CELL;
  if (estimated > RIVER_PIXEL_CAP * 1.15)
    notes.push({
      code: 'MAP_RIVER_DENSITY',
      severity: 'warning',
      message: `The river network is estimated at ${Math.round(estimated)} pixels, above the ${RIVER_PIXEL_CAP} guard; the named rivers alone are this long`,
      details: { estimatedPixels: Math.round(estimated) },
    });
  const endorheic = geography.lakes.filter(
    (lake) =>
      lake.outflowId === undefined &&
      geography.rivers.every((river) => riverSourceLake(river) !== lake.id),
  );
  if (endorheic.length > 0)
    notes.push({
      code: 'MAP_LAKE_ENDORHEIC',
      severity: 'info',
      message: `${endorheic.length} lake(s) have no outflow river and keep their water: ${endorheic
        .slice(0, 8)
        .map((lake) => lake.id)
        .join(', ')}`,
      details: { lakes: endorheic.map((lake) => lake.id).slice(0, 50) },
    });
  return {
    heights: carved.heights,
    rivers,
    valley: carved.valley,
    estimatedPixels: estimated,
    notes,
  };
}
