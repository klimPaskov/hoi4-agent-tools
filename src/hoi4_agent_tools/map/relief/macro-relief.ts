/**
 * Macro relief of the geography model (ADR 0056): the smooth part of the height field on a grid of
 * half the map size. Fractal base relief, plateaus with cliff or ramp edges, mountain ranges as
 * ridge, massif, escarpment and wall profiles with asymmetry, passes, spurs and snow lines, and
 * volcanoes with craters. Full-resolution detail, the coast ramp and the river carving are applied
 * later, in strips.
 *
 * Heights are map values (0 to 255, the heightmap's own scale). Only `+ - * /`, `sqrt` and `floor`
 * are used, so a seed gives the same terrain on every platform.
 */
import {
  createBandStrip,
  clearBandStrip,
  fillAreaStrip,
  forEachPolylinePixel,
  rasterizeBandStrip,
  rowStrips,
  sampleAlong,
  scanAreaStrip,
  type ResolvedArea,
  type ResolvedGeography,
  type ResolvedPlateau,
  type ResolvedRange,
  type ResolvedVolcano,
} from '../geography/index.js';
import { LAKE, LAND, bilinear, chamferDistance } from './grid.js';
import {
  Rng,
  clamp,
  clamp01,
  fractal2,
  noise2,
  pow125,
  pow15,
  ridged2,
  seedFromString,
  smoothstep,
} from './math.js';

export type ReliefScaleName = 'vanilla' | 'low' | 'dramatic';

export interface ReliefSettings {
  scale: ReliefScaleName;
  /** 0 to 1: full-resolution roughness. */
  detail: number;
}

export const DEFAULT_RELIEF: ReliefSettings = { scale: 'vanilla', detail: 0.5 };

/** Height multipliers applied to everything above the lowland. */
export const RELIEF_SCALE_FACTOR: Record<ReliefScaleName, number> = {
  low: 0.75,
  vanilla: 1,
  dramatic: 1.15,
};

/** Lowest height of land: the coast stands at this value (ADR 0053). */
export const LAND_FLOOR = 96;
/** Height a peak of `0` would have; a peak of `1` stands `PEAK_SPAN` above it. */
export const PEAK_BASE = 100;
export const PEAK_SPAN = 148;
/** The highest value a heightmap pixel may hold in practice (255 is reserved). */
export const HEIGHT_CEILING = 252;

/** Map height of a crest or cone given by a 0..1 peak. */
export function peakHeight(peak: number, scale: number): number {
  return Math.min(HEIGHT_CEILING, PEAK_BASE + PEAK_SPAN * peak * scale);
}

/** Map height of a plateau given by a 0..1 relief; 0 is the land floor, a chasm bottom. */
export function plateauHeight(height: number, scale: number): number {
  return Math.min(HEIGHT_CEILING, LAND_FLOOR + PEAK_SPAN * height * scale);
}

/** One range as it was synthesised: the tables the checks and later stages read. */
export interface RangeTable {
  readonly id: string;
  /** Number of entries in every table; entry `k` is at arc fraction `k / (count - 1)`. */
  readonly count: number;
  /** Length of the path in map widths. */
  readonly length: number;
  /** Requested crest height (map values) along the path. */
  readonly crest: Float32Array;
  /** Half-width of the footprint along the path, a fraction of the map width. */
  readonly halfWidth: Float32Array;
  /** Mean base height under the path before the range was added. */
  readonly base: Float32Array;
  /** 1 on the open range, falling to `1 - depth` inside a pass saddle. */
  readonly envelope: Float32Array;
  /** Pass saddles: centre arc fraction and half-length along the path in map widths. */
  readonly passes: ReadonlyArray<{
    id: string;
    at: number;
    halfLength: number;
    depth: number;
  }>;
}

export interface MacroRelief {
  /** Macro grid size: half the map. */
  readonly width: number;
  readonly height: number;
  /** 0 sea, 1 land, 2 lake, majority of the four map pixels of a cell. */
  readonly kind: Uint8Array;
  /** Base land height before any feature. */
  readonly base: Float32Array;
  /** Final macro height of land cells (map values); 0 on water. */
  readonly heights: Float32Array;
  /** 0 to 1: how much a cell belongs to a mountain, volcano or plateau edge (weights full-resolution detail). */
  readonly footprint: Float32Array;
  /** Permanent-snow height (map values) of a cell; 255 where no range sets one. */
  readonly snowLine: Uint8Array;
  /** 1 on the crest lines of the ranges. */
  readonly crest: Uint8Array;
  /** 1 where an impassable range stands, 2 for a fort line; pass gaps are clear. */
  readonly barrier: Uint8Array;
  readonly ranges: readonly RangeTable[];
  readonly scale: number;
}

export interface MacroReliefInput {
  geography: ResolvedGeography;
  /** Full map size. */
  width: number;
  height: number;
  seed: number;
  /** Full-resolution kind (0 sea, 1 land, 2 lake). */
  kind: Uint8Array;
  relief: ReliefSettings;
  signal?: AbortSignal | undefined;
}

/** Kind of each macro cell: the majority of its four pixels, with lake before land before sea. */
function downsampleKind(kind: Uint8Array, width: number, height: number): Uint8Array {
  const mw = width / 2;
  const mh = height / 2;
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y += 1)
    for (let x = 0; x < mw; x += 1) {
      const a = kind[2 * y * width + 2 * x]!;
      const b = kind[2 * y * width + 2 * x + 1]!;
      const c = kind[(2 * y + 1) * width + 2 * x]!;
      const d = kind[(2 * y + 1) * width + 2 * x + 1]!;
      let lakes = 0;
      let lands = 0;
      if (a === LAKE) lakes += 1;
      else if (a === LAND) lands += 1;
      if (b === LAKE) lakes += 1;
      else if (b === LAND) lands += 1;
      if (c === LAKE) lakes += 1;
      else if (c === LAND) lands += 1;
      if (d === LAKE) lakes += 1;
      else if (d === LAND) lands += 1;
      out[y * mw + x] = lakes >= 2 ? LAKE : lands >= 2 ? LAND : lakes + lands >= 2 ? LAND : 0;
    }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Base relief

function landElevationField(
  geography: ResolvedGeography,
  mw: number,
  mh: number,
  fallback: number,
): Float32Array {
  const field = new Float32Array(mw * mh).fill(fallback);
  for (const land of geography.lands)
    fillAreaStrip(
      land.area,
      { width: mw, height: mh },
      { y0: 0, y1: mh },
      field,
      land.elevationBase,
    );
  return field;
}

function baseRelief(
  kind: Uint8Array,
  elevation: Float32Array,
  mw: number,
  mh: number,
  seed: number,
): Float32Array {
  const water = new Uint8Array(kind.length);
  for (let index = 0; index < kind.length; index += 1) water[index] = kind[index] === LAND ? 0 : 1;
  const distance = chamferDistance(water, mw, mh, 4096);
  const base = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y += 1)
    for (let x = 0; x < mw; x += 1) {
      const index = y * mw + x;
      if (kind[index] !== LAND) continue;
      const eb = elevation[index]!;
      const inland = smoothstep(distance[index]! / (0.06 * mw));
      const rolling = (fractal2(seed + 11, x, y, 0.16 * mw, 5) - 0.5) * 2;
      const hills = clamp((fractal2(seed + 23, x, y, 0.07 * mw, 4) - 0.55) * 3.2, 0, 1);
      // Texture at the scale of valleys and ridges: it gives water something to follow.
      const texture = (fractal2(seed + 37, x, y, 0.025 * mw, 5) - 0.5) * 2;
      base[index] = Math.max(
        LAND_FLOOR + 1,
        99 +
          38 * eb +
          5 * inland +
          rolling * (5 + 14 * eb) +
          hills * (10 + 30 * eb) +
          texture * (4 + 8 * eb + 6 * hills) +
          (ridged2(seed + 53, x, y, 0.045 * mw, 4) - 0.45) * 2 * (2.5 + 6 * eb),
      );
    }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Plateaus

function applyPlateau(
  plateau: ResolvedPlateau,
  heights: Float32Array,
  kind: Uint8Array,
  mw: number,
  mh: number,
  scale: number,
  seed: number,
  footprint: Float32Array,
): void {
  const area: ResolvedArea = plateau.area;
  const x0 = Math.max(0, Math.floor(area.bounds.x0 * mw) - 2);
  const y0 = Math.max(0, Math.floor(area.bounds.y0 * mh) - 2);
  const x1 = Math.min(mw, Math.ceil(area.bounds.x1 * mw) + 2);
  const y1 = Math.min(mh, Math.ceil(area.bounds.y1 * mh) + 2);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const inside = new Uint8Array(w * h);
  scanAreaStrip(area, { width: mw, height: mh }, { y0, y1 }, (y, xa, xb) => {
    const row = (y - y0) * w - x0;
    inside.fill(1, row + Math.max(xa, x0), row + Math.min(xb, x1));
  });
  const outside = new Uint8Array(w * h);
  let cells = 0;
  for (let index = 0; index < inside.length; index += 1) {
    outside[index] = inside[index] === 0 ? 1 : 0;
    cells += inside[index]!;
  }
  if (cells === 0) return;
  const depth = chamferDistance(outside, w, h, 4096);
  const edgeCells = plateau.edge === 'cliff' ? 2 : clamp(0.3 * Math.sqrt(cells), 6, 60);
  const top = plateauHeight(plateau.height, scale);
  const plateauSeed = seedFromString(seed, plateau.id);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const local = y * w + x;
      if (inside[local] === 0) continue;
      const index = (y + y0) * mw + x + x0;
      if (kind[index] !== LAND) continue;
      const weight = smoothstep((depth[local]! - 0.5) / edgeCells);
      const target = top + (fractal2(plateauSeed, x + x0, y + y0, 0.03 * mw, 3) - 0.5) * 3;
      const next = heights[index]! + (Math.max(LAND_FLOOR, target) - heights[index]!) * weight;
      heights[index] = next;
      footprint[index] = Math.max(footprint[index]!, 3.2 * weight * (1 - weight));
    }
}

// ---------------------------------------------------------------------------------------------
// Ranges

const SPUR_ANGLES: ReadonlyArray<readonly [number, number]> = [
  [0.6427876, 0.7660444],
  [0.5735764, 0.819152],
  [0.5, 0.8660254],
  [0.4226183, 0.9063078],
  [0.3420201, 0.9396926],
];

/** Pass window half-length in map widths: a saddle is wider than the gap through it. */
function passHalfLength(width: number): number {
  return Math.max(width * 2.2, 0.004);
}

function buildRangeTable(
  range: ResolvedRange,
  geography: ResolvedGeography,
  base: Float32Array,
  mw: number,
  mh: number,
  scale: number,
): RangeTable {
  const path = range.path;
  const count = clamp(Math.ceil(path.length * mw * 0.5), 32, 4096);
  const crest = new Float32Array(count);
  const halfWidth = new Float32Array(count);
  const baseAlong = new Float32Array(count);
  const envelope = new Float32Array(count).fill(1);
  const raw = new Float32Array(count);
  for (let k = 0; k < count; k += 1) {
    const sample = sampleAlong(path, geography.frame, k / (count - 1));
    crest[k] = peakHeight(sample.peak, scale);
    halfWidth[k] = sample.halfWidth;
    raw[k] = bilinear(base, mw, mh, sample.x * mw - 0.5, sample.y * mh - 0.5);
  }
  // Smooth the base under the crest so lumps in the base noise do not ripple the crest line.
  const reach = Math.max(2, Math.round(count / 24));
  for (let k = 0; k < count; k += 1) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, k - reach); j <= Math.min(count - 1, k + reach); j += 1) {
      sum += raw[j]!;
      n += 1;
    }
    baseAlong[k] = sum / n;
  }
  const passes: Array<{ id: string; at: number; halfLength: number; depth: number }> = [];
  for (const id of range.passIds) {
    const pass = geography.get('pass', id);
    if (pass === undefined) continue;
    const halfLength = passHalfLength(pass.width);
    passes.push({ id, at: pass.at, halfLength, depth: pass.depth });
    for (let k = 0; k < count; k += 1) {
      const distance = (k / (count - 1) - pass.at) * path.length;
      const s = (distance * distance) / (halfLength * halfLength);
      if (s >= 1) continue;
      const bump = (1 - s) * (1 - s);
      envelope[k] = envelope[k]! * (1 - pass.depth * bump);
    }
  }
  return {
    id: range.id,
    count,
    length: path.length,
    crest,
    halfWidth,
    base: baseAlong,
    envelope,
    passes,
  };
}

/** Cross profile of a range at normalised distance `u` (0 on the crest, 1 at the foot). */
function rangeProfile(profile: ResolvedRange['profile'], u: number, steep: boolean): number {
  if (u >= 1) return 0;
  switch (profile) {
    case 'ridge': {
      // A sharp crest over a wide apron of foothills.
      return 0.65 * pow125(1 - u) + 0.35 * pow125(1 - pow15(u));
    }
    case 'massif': {
      const f = 1 - u * u * u;
      return pow125(f);
    }
    case 'wall': {
      const u2 = u * u;
      return 1 - u2 * u2 * u2;
    }
    case 'escarpment': {
      if (steep) {
        const u2 = u * u;
        return 1 - u2 * u2;
      }
      return pow125(1 - pow125(u));
    }
  }
}

function table(values: Float32Array, count: number, t: number): number {
  const position = clamp(t, 0, 1) * (count - 1);
  const k0 = Math.floor(position);
  const k1 = k0 + 1 < count ? k0 + 1 : k0;
  return values[k0]! + (values[k1]! - values[k0]!) * (position - k0);
}

interface RangeTargets {
  delta: Float32Array;
  footprint: Float32Array;
  snow: Uint8Array;
  crest: Uint8Array;
  barrier: Uint8Array;
}

/** A window of the macro grid holding one range's own height above the base, before it is merged. */
interface LocalRaster {
  x0: number;
  y0: number;
  width: number;
  height: number;
  delta: Float32Array;
  /** 1 where the range counts as a barrier (its body outside the pass gaps). */
  flag: Uint8Array;
}

/**
 * The share of the half-width by which the crest line may wander off the drawn path. Checks that
 * look for a crest search this far either side of the path.
 */
export const CREST_WANDER_SHARE = 0.35;

function applyRange(
  range: ResolvedRange,
  tableOf: RangeTable,
  geography: ResolvedGeography,
  kind: Uint8Array,
  mw: number,
  mh: number,
  scale: number,
  seed: number,
  targets: RangeTargets,
): void {
  const path = range.path;
  const grid = { width: mw, height: mh };
  let widest = 0;
  for (const half of path.halfWidth) widest = Math.max(widest, half);
  const widestCells = widest * mw;
  const reach = widestCells * 2.9;
  const snowHeight =
    range.snowline === undefined
      ? 255
      : Math.min(254, Math.round(peakHeight(range.snowline, scale)));
  const rangeSeed = seedFromString(seed, `range:${range.id}`);
  const asym = range.asymmetry;
  const steepSide = asym >= 0 ? 1 : -1;
  const margin = Math.ceil(reach + widestCells * CREST_WANDER_SHARE + 3);
  const x0 = Math.max(0, Math.floor(path.bounds.x0 * mw - margin));
  const y0 = Math.max(0, Math.floor(path.bounds.y0 * mh - margin));
  const x1 = Math.min(mw, Math.ceil(path.bounds.x1 * mw + margin));
  const y1 = Math.min(mh, Math.ceil(path.bounds.y1 * mh + margin));
  if (x1 <= x0 || y1 <= y0) return;
  const local: LocalRaster = {
    x0,
    y0,
    width: x1 - x0,
    height: y1 - y0,
    delta: new Float32Array((x1 - x0) * (y1 - y0)),
    flag: new Uint8Array((x1 - x0) * (y1 - y0)),
  };
  const stripHeight = 64;
  const band = createBandStrip(grid, { y0: 0, y1: stripHeight });
  for (const strip of rowStrips(grid, stripHeight)) {
    if (strip.y1 <= y0 || strip.y0 >= y1) continue;
    const active = { ...band, strip };
    clearBandStrip(active);
    rasterizeBandStrip(path, grid, strip, reach, active);
    for (let y = Math.max(strip.y0, y0); y < Math.min(strip.y1, y1); y += 1)
      for (let x = x0; x < x1; x += 1) {
        const cell = (y - strip.y0) * mw + x;
        const d = active.distance[cell]!;
        if (d === Infinity) continue;
        const t = active.t[cell]!;
        const halfCells = table(tableOf.halfWidth, tableOf.count, t) * mw;
        const side = active.side[cell]!;
        let hw = halfCells;
        let steep = false;
        if (range.profile === 'escarpment') {
          steep = side === 0 || side === steepSide;
          hw = steep ? halfCells * 0.45 : halfCells * 1.1;
        } else if (asym !== 0) hw = halfCells * clamp(1 + 0.6 * asym * side, 0.25, 2);
        // The footprint wanders in width along the range and the crest keeps its height; walls
        // stay straight.
        const wander =
          range.profile === 'wall'
            ? 0
            : (fractal2(rangeSeed, x, y, Math.max(8, hw * 2.2), 3) - 0.5) * 1.5;
        const u = (d * (1 + clamp(wander, -0.4, 0.4))) / hw;
        if (u >= 1) continue;
        const f = rangeProfile(range.profile, u, steep);
        if (f <= 0) continue;
        const envelope = table(tableOf.envelope, tableOf.count, t);
        const crest = table(tableOf.crest, tableOf.count, t);
        const baseUnder = table(tableOf.base, tableOf.count, t);
        // Peaks and cols along the crest: the crest stays within 7% of the requested height.
        const lump = clamp(
          (fractal2(rangeSeed + 5, x, y, Math.max(8, hw * 1.6), 3) - 0.3) * 2.5,
          0,
          1,
        );
        const amplitude = Math.max(0, crest - baseUnder) * (0.93 + 0.07 * lump);
        const delta = amplitude * f * envelope;
        const at = (y - y0) * local.width + (x - x0);
        if (delta > local.delta[at]!) local.delta[at] = delta;
        if (range.barrier !== 'none' && f * envelope >= 0.5) local.flag[at] = 1;
      }
  }
  // Spurs: short side ridges off the crest, into the same local window.
  if (range.spurs > 0 && range.profile !== 'wall')
    addSpurs(range, tableOf, geography, local, mw, mh, seed);
  mergeWarped(
    local,
    targets,
    kind,
    mw,
    mh,
    {
      seed: rangeSeed,
      snowHeight,
      barrier: range.barrier === 'impassable' ? 1 : range.barrier === 'fort-line' ? 2 : 0,
    },
    range.profile === 'wall' ? 0.08 : CREST_WANDER_SHARE * 0.85 * widestCells,
    widestCells,
  );
  forEachPolylinePixel(path, grid, { y0: 0, y1: mh }, (x, y) => {
    targets.crest[y * mw + x] = 1;
  });
}

/** Merge a range window into the targets, displacing it by a smooth noise so the crest meanders. */
function mergeWarped(
  local: LocalRaster,
  targets: RangeTargets,
  kind: Uint8Array,
  mw: number,
  mh: number,
  options: { seed: number; snowHeight: number; barrier: number },
  amplitude: number,
  widestCells: number,
): void {
  const { seed: rangeSeed, snowHeight } = options;
  const wavelength = Math.max(10, widestCells * 3);
  for (let y = local.y0; y < local.y0 + local.height; y += 1)
    for (let x = local.x0; x < local.x0 + local.width; x += 1) {
      const index = y * mw + x;
      if (kind[index] !== LAND) continue;
      let sx = x;
      let sy = y;
      if (amplitude > 0) {
        sx =
          x + clamp((fractal2(rangeSeed + 31, x, y, wavelength, 3) - 0.5) * 2.4, -1, 1) * amplitude;
        sy =
          y + clamp((fractal2(rangeSeed + 37, x, y, wavelength, 3) - 0.5) * 2.4, -1, 1) * amplitude;
      }
      const lx = sx - local.x0;
      const ly = sy - local.y0;
      if (lx < 0 || ly < 0 || lx > local.width - 1 || ly > local.height - 1) continue;
      const delta = bilinear(local.delta, local.width, local.height, lx, ly);
      if (options.barrier > 0 && local.flag[Math.round(ly) * local.width + Math.round(lx)] === 1)
        targets.barrier[index] = Math.max(targets.barrier[index]!, options.barrier);
      if (delta <= 0.01) continue;
      if (delta > targets.delta[index]!) targets.delta[index] = delta;
      const weight = Math.min(1, delta / 50);
      if (weight > targets.footprint[index]!) targets.footprint[index] = weight;
      if (snowHeight < 255 && delta > 4 && snowHeight < targets.snow[index]!)
        targets.snow[index] = snowHeight;
    }
}

function addSpurs(
  range: ResolvedRange,
  tableOf: RangeTable,
  geography: ResolvedGeography,
  local: LocalRaster,
  mw: number,
  mh: number,
  seed: number,
): void {
  const path = range.path;
  const rng = new Rng(seedFromString(seed, `spur:${range.id}`));
  const lengthCells = path.length * mw;
  let along = 0;
  while (along < lengthCells) {
    const t = along / lengthCells;
    const sample = sampleAlong(path, geography.frame, t);
    const hw = sample.halfWidth * mw;
    along += Math.max(2, (0.6 + 0.4 * rng.next()) * hw);
    if (rng.next() > Math.min(1, range.spurs * 1.6)) continue;
    const envelope = table(tableOf.envelope, tableOf.count, t);
    if (envelope < 0.5) continue;
    const sign = rng.next() < 0.5 ? 1 : -1;
    const angle = SPUR_ANGLES[Math.floor(rng.next() * SPUR_ANGLES.length) % SPUR_ANGLES.length]!;
    const tx = sample.tangentX;
    const ty = sample.tangentY;
    const dx = tx * angle[0] - ty * angle[1] * sign;
    const dy = tx * angle[1] * sign + ty * angle[0];
    const length = (0.5 + 0.3 * rng.next()) * hw;
    const px = sample.x * mw;
    const py = sample.y * mh;
    const ex = px + dx * length;
    const ey = py + dy * length;
    const spurHalf = Math.max(1.5, 0.2 * hw);
    const crest = table(tableOf.crest, tableOf.count, t);
    const amplitude = Math.max(0, crest - table(tableOf.base, tableOf.count, t));
    const height = 0.55 * amplitude * envelope;
    const minX = Math.max(local.x0, Math.floor(Math.min(px, ex) - spurHalf - 1));
    const maxX = Math.min(local.x0 + local.width - 1, Math.ceil(Math.max(px, ex) + spurHalf + 1));
    const minY = Math.max(local.y0, Math.floor(Math.min(py, ey) - spurHalf - 1));
    const maxY = Math.min(local.y0 + local.height - 1, Math.ceil(Math.max(py, ey) + spurHalf + 1));
    const sx = ex - px;
    const sy = ey - py;
    const lengthSquared = sx * sx + sy * sy;
    for (let y = minY; y <= maxY; y += 1)
      for (let x = minX; x <= maxX; x += 1) {
        const qx = x + 0.5 - px;
        const qy = y + 0.5 - py;
        const a = lengthSquared === 0 ? 0 : clamp01((qx * sx + qy * sy) / lengthSquared);
        const ox = qx - a * sx;
        const oy = qy - a * sy;
        const u = Math.sqrt(ox * ox + oy * oy) / spurHalf;
        if (u >= 1) continue;
        const delta = height * pow125(1 - pow15(u)) * (1 - 0.65 * a);
        const at = (y - local.y0) * local.width + (x - local.x0);
        if (delta > local.delta[at]!) local.delta[at] = delta;
      }
  }
}

// ---------------------------------------------------------------------------------------------
// Volcanoes

function applyVolcano(
  volcano: ResolvedVolcano,
  base: Float32Array,
  kind: Uint8Array,
  mw: number,
  mh: number,
  scale: number,
  seed: number,
  targets: RangeTargets,
): void {
  const radius = volcano.radius * mw;
  const crater = Math.min(volcano.crater * mw, radius * 0.9);
  const cx = volcano.at.x * mw;
  const cy = volcano.at.y * mh;
  const level = bilinear(base, mw, mh, cx - 0.5, cy - 0.5);
  const amplitude = Math.max(0, peakHeight(volcano.peak, scale) - level);
  const depth = Math.max(8, 0.22 * amplitude);
  const volcanoSeed = seedFromString(seed, `volcano:${volcano.id}`);
  const reach = radius * 1.25;
  const minX = Math.max(0, Math.floor(cx - reach - 1));
  const maxX = Math.min(mw - 1, Math.ceil(cx + reach));
  const minY = Math.max(0, Math.floor(cy - reach - 1));
  const maxY = Math.min(mh - 1, Math.ceil(cy + reach));
  for (let y = minY; y <= maxY; y += 1)
    for (let x = minX; x <= maxX; x += 1) {
      const index = y * mw + x;
      if (kind[index] !== LAND) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      let delta: number;
      if (r <= crater) {
        const s = r / crater;
        delta = amplitude - depth * (1 - s * s);
      } else {
        // Direction on the unit circle keeps the noise continuous all the way round.
        const ux = dx / r;
        const uy = dy / r;
        const outer = radius * (0.88 + 0.24 * noise2(volcanoSeed, ux * 3 + 11, uy * 3 + 11));
        if (r >= outer) continue;
        const s = (r - crater) / (outer - crater);
        const w = 1 - Math.sqrt(s);
        const cone = w * Math.sqrt(Math.sqrt(w));
        const n = noise2(volcanoSeed + 7, ux * 4 + 23, uy * 4 + 23) * 2 - 1;
        const gully = (1 - (n < 0 ? -n : n)) * smoothstep(s * 3);
        delta = amplitude * cone * (1 - 0.28 * gully * gully);
      }
      if (delta > targets.delta[index]!) targets.delta[index] = delta;
      const weight = Math.min(1, delta / 50);
      if (weight > targets.footprint[index]!) targets.footprint[index] = weight;
    }
}

// ---------------------------------------------------------------------------------------------

/** Build the macro relief of the model. */
export function synthesizeMacroRelief(input: MacroReliefInput): MacroRelief {
  const { geography, width, height, seed } = input;
  const mw = width / 2;
  const mh = height / 2;
  const scale = RELIEF_SCALE_FACTOR[input.relief.scale];
  const kind = downsampleKind(input.kind, width, height);
  const elevation = landElevationField(geography, mw, mh, 0.15);
  const base = baseRelief(kind, elevation, mw, mh, seed);
  const heights = Float32Array.from(base);
  const footprint = new Float32Array(mw * mh);
  for (const plateau of geography.plateaus) {
    input.signal?.throwIfAborted();
    applyPlateau(plateau, heights, kind, mw, mh, scale, seed, footprint);
  }
  const targets: RangeTargets = {
    delta: new Float32Array(mw * mh),
    footprint: new Float32Array(mw * mh),
    snow: new Uint8Array(mw * mh).fill(255),
    crest: new Uint8Array(mw * mh),
    barrier: new Uint8Array(mw * mh),
  };
  const ranges: RangeTable[] = [];
  for (const range of geography.ranges) {
    input.signal?.throwIfAborted();
    const tableOf = buildRangeTable(range, geography, heights, mw, mh, scale);
    ranges.push(tableOf);
    applyRange(range, tableOf, geography, kind, mw, mh, scale, seed, targets);
  }
  for (const volcano of geography.volcanoes) {
    input.signal?.throwIfAborted();
    applyVolcano(volcano, heights, kind, mw, mh, scale, seed, targets);
  }
  for (let index = 0; index < heights.length; index += 1) {
    if (kind[index] !== LAND) {
      heights[index] = 0;
      continue;
    }
    heights[index] = Math.min(HEIGHT_CEILING, heights[index]! + targets.delta[index]!);
    footprint[index] = Math.max(footprint[index]!, targets.footprint[index]!);
  }
  return {
    width: mw,
    height: mh,
    kind,
    base,
    heights,
    footprint,
    snowLine: targets.snow,
    crest: targets.crest,
    barrier: targets.barrier,
    ranges,
    scale,
  };
}
