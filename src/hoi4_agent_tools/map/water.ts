/**
 * Lake and water conventions (ADR 0053). The engine draws a water layer everywhere with an alpha
 * that depends on the heightmap, so what a lake looks like is decided by its height, not by its
 * province type alone. These functions are shared by the generator and the validators.
 */
import { fractal } from './world-noise.js';

const SEA = 0;
const LAND = 1;
const LAKE = 2;

/** Engine constant: the water surface is a plane at 9.5 world units, heightmap value 95. */
export const WATER_SURFACE_HEIGHT = 95;
/** Height of sea and lake interiors in the base game (99.995% of its sea pixels). */
export const WATER_INTERIOR_HEIGHT = 89;
/** Largest height at which the water layer is fully opaque. */
export const WATER_OPAQUE_HEIGHT = 91;
/** Lowest height of land; coasts rise to this value. */
export const LAND_MINIMUM_HEIGHT = 96;
/**
 * Heights of lake pixels at distance 1, 2, ... from the shore; deeper pixels use the interior
 * height. Only the shore ring is translucent, so the lake reads as open water, not as specks.
 */
export const LAKE_BANK_HEIGHTS: readonly number[] = [93, 91];
/** A lake pixel within this distance of land may stand above `WATER_OPAQUE_HEIGHT` (up to 95). */
export const LAKE_BANK_ALLOWANCE_PX = 3;
export const LAKE_BANK_MAXIMUM_HEIGHT = 95;
/** Enclosed water below this size is not a lake; it becomes land. */
export const LAKE_MINIMUM_PIXELS = 60;

/**
 * Opacity of the water layer at a heightmap value: `1 - saturate((h / 95.7 - 0.954) * 25)`, as
 * `pdxwater.shader` computes it (on a 3 x 3 average of the heightmap, which this ignores).
 */
export function waterAlpha(height: number): number {
  const t = (height / 95.7 - 0.954) * 25;
  return 1 - Math.min(1, Math.max(0, t));
}

/** Height of a lake pixel `distance` pixels from the nearest land (1 is adjacent to land). */
export function lakeHeight(distance: number): number {
  return distance >= 1 && distance <= LAKE_BANK_HEIGHTS.length
    ? LAKE_BANK_HEIGHTS[distance - 1]!
    : WATER_INTERIOR_HEIGHT;
}

/**
 * Four-neighbour distance from the nearest land pixel through water: 0 on land, 1 for water
 * next to land, capped at `limit`. Pixels the search does not reach hold `limit`.
 */
export function landDistanceField(
  kind: Uint8Array,
  width: number,
  height: number,
  limit = 255,
): Uint8Array {
  const total = width * height;
  const distance = new Uint8Array(total).fill(limit);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < total; pixel += 1)
    if (kind[pixel] === LAND) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    if (next >= limit) continue;
    const x = pixel % width;
    const visit = (other: number): void => {
      if (distance[other] === limit && kind[other] !== LAND) {
        distance[other] = next;
        queue[tail++] = other;
      }
    };
    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < total - width) visit(pixel + width);
  }
  return distance;
}

export interface LakeNote {
  code: 'MAP_LAKE_TOO_SMALL' | 'MAP_LAKE_CONNECTED_TO_SEA';
  message: string;
  pixels: number;
  /** A pixel of the affected water body. */
  x: number;
  y: number;
}

/**
 * Enforce the lake rules on a raster of 0 sea, 1 land and 2 lake (modified in place, with the
 * matching elevation values): lake water that touches the open sea is sea, and enclosed water
 * below `LAKE_MINIMUM_PIXELS` is land. Every change is reported.
 */
export function normalizeLakes(
  kind: Uint8Array,
  elevation: Float32Array,
  width: number,
  height: number,
  minimumPixels = LAKE_MINIMUM_PIXELS,
): LakeNote[] {
  const total = width * height;
  const notes: LakeNote[] = [];
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  for (let start = 0; start < total; start += 1) {
    if (kind[start] !== LAKE || seen[start]) continue;
    let head = 0;
    let tail = 0;
    const found = { sea: false };
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % width;
      const visit = (other: number): void => {
        if (kind[other] === SEA) found.sea = true;
        else if (kind[other] === LAKE && !seen[other]) {
          seen[other] = 1;
          queue[tail++] = other;
        }
      };
      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (pixel >= width) visit(pixel - width);
      if (pixel < total - width) visit(pixel + width);
    }
    if (!found.sea && tail >= minimumPixels) continue;
    const toSea = found.sea;
    for (let index = 0; index < tail; index += 1) {
      const pixel = queue[index]!;
      kind[pixel] = toSea ? SEA : LAND;
      elevation[pixel] = toSea ? -0.15 : 0.02;
    }
    const x = start % width;
    notes.push({
      code: toSea ? 'MAP_LAKE_CONNECTED_TO_SEA' : 'MAP_LAKE_TOO_SMALL',
      message: toSea
        ? `Lake water of ${tail} pixels touches the open sea and was written as sea`
        : `Enclosed water of ${tail} pixels is below the ${minimumPixels} pixel lake floor and was written as land`,
      pixels: tail,
      x,
      y: (start - x) / width,
    });
  }
  return notes;
}

type Curve = ReadonlyArray<readonly [number, number, number, number]>;

/**
 * Sea tint by distance from land in vanilla-map pixels, fitted to the base game's water colour
 * map: bright over the shelf, falling to a dark deep blue (measured means 59,102,138 at the
 * coast, 83,130,175 at 5 to 10 pixels, 34,57,78 beyond 160).
 */
const SEA_CURVE: Curve = [
  [0, 59, 102, 138],
  [3, 73, 120, 161],
  [7, 83, 130, 175],
  [15, 69, 111, 153],
  [30, 57, 92, 130],
  [60, 45, 74, 106],
  [120, 36, 60, 86],
  [200, 34, 57, 78],
];
const LAKE_INTERIOR_TINT = [58, 102, 147] as const;
const LAKE_SHORE_TINT = [78, 128, 168] as const;
const DEEPEST_TINT = [26, 43, 59] as const;
const ICE_TINT = [196, 218, 232] as const;
const VANILLA_MAP_WIDTH = 5632;

function curveAt(curve: Curve, distance: number): [number, number, number] {
  if (distance <= curve[0]![0]) return [curve[0]![1], curve[0]![2], curve[0]![3]];
  for (let index = 1; index < curve.length; index += 1) {
    const upper = curve[index]!;
    if (distance <= upper[0]) {
      const lower = curve[index - 1]!;
      const t = (distance - lower[0]) / (upper[0] - lower[0]);
      return [
        lower[1] + (upper[1] - lower[1]) * t,
        lower[2] + (upper[2] - lower[2]) * t,
        lower[3] + (upper[3] - lower[3]) * t,
      ];
    }
  }
  const last = curve.at(-1)!;
  return [last[1], last[2], last[3]];
}

export interface WaterColourInput {
  width: number;
  height: number;
  /** 0 sea, 1 land, 2 lake. */
  kind: Uint8Array;
  /** Output of `landDistanceField`. */
  landDistance: Uint8Array;
  seed: number;
  /**
   * Darkening toward the deepest tint, 0 to 1, at a full-resolution pixel; the world edge band
   * (ADR 0061) uses it so the seam shows no shelf.
   */
  darken?: (x: number, y: number) => number;
  /**
   * A distance from land in pixels to use instead of the real one for a sea pixel, or a negative
   * number for none: a sea the model calls a shelf is bright and one it calls an abyss is dark
   * whatever the coast is doing (ADR 0057).
   */
  virtualDistance?: (x: number, y: number) => number;
  /** Sea ice cover 0 to 1 at a full-resolution pixel: the water tints toward pale ice. */
  ice?: (x: number, y: number) => number;
}

/**
 * One level of the water colour map as BGRA bytes (alpha 255), sampling the full-resolution
 * rasters every `2 ** (level + 1)` pixels. Pure arithmetic plus value noise: platform-stable.
 */
export function waterColourLevel(input: WaterColourInput, level: number): Uint8Array {
  const { width, height, kind, landDistance } = input;
  const factor = 2 ** (level + 1);
  const levelWidth = width / factor;
  const levelHeight = height / factor;
  const scale = Math.min(1.5, Math.max(0.35, width / VANILLA_MAP_WIDTH));
  const patch = Math.max(48, width / 9);
  const output = new Uint8Array(levelWidth * levelHeight * 4);
  for (let y = 0; y < levelHeight; y += 1)
    for (let x = 0; x < levelWidth; x += 1) {
      const sx = x * factor;
      const sy = y * factor;
      const pixel = sy * width + sx;
      let distance = landDistance[pixel]!;
      if (kind[pixel] !== LAKE && input.virtualDistance !== undefined) {
        const virtual = input.virtualDistance(sx, sy);
        if (virtual >= 0) distance = virtual;
      }
      let r: number;
      let g: number;
      let b: number;
      const noise = fractal(input.seed + 3571, sx, sy, patch, 3) - 0.5;
      if (kind[pixel] === LAKE) {
        const t = Math.min(1, Math.max(0, (distance - 1) / 7));
        const variation = 1 + noise * 0.3;
        r = (LAKE_SHORE_TINT[0] + (LAKE_INTERIOR_TINT[0] - LAKE_SHORE_TINT[0]) * t) * variation;
        g = (LAKE_SHORE_TINT[1] + (LAKE_INTERIOR_TINT[1] - LAKE_SHORE_TINT[1]) * t) * variation;
        b = (LAKE_SHORE_TINT[2] + (LAKE_INTERIOR_TINT[2] - LAKE_SHORE_TINT[2]) * t) * variation;
      } else {
        const [cr, cg, cb] = curveAt(SEA_CURVE, distance / scale);
        // Open water varies in large patches; the shelf stays calmer.
        const strength = 0.25 + 0.75 * Math.min(1, distance / (60 * scale));
        const variation = Math.min(1.5, Math.max(0.6, 1 + noise * 2 * strength));
        r = cr * variation;
        g = cg * variation;
        b = cb * variation;
      }
      const ice = kind[pixel] === SEA ? (input.ice?.(sx, sy) ?? 0) : 0;
      if (ice > 0) {
        const cover = Math.min(1, ice * (0.75 + 0.5 * noise));
        r += (ICE_TINT[0] - r) * cover;
        g += (ICE_TINT[1] - g) * cover;
        b += (ICE_TINT[2] - b) * cover;
      }
      const darkness = input.darken?.(sx, sy) ?? 0;
      if (darkness > 0) {
        r += (DEEPEST_TINT[0] - r) * darkness;
        g += (DEEPEST_TINT[1] - g) * darkness;
        b += (DEEPEST_TINT[2] - b) * darkness;
      }
      const offset = (y * levelWidth + x) * 4;
      output[offset] = Math.min(255, Math.max(0, Math.round(b)));
      output[offset + 1] = Math.min(255, Math.max(0, Math.round(g)));
      output[offset + 2] = Math.min(255, Math.max(0, Math.round(r)));
      output[offset + 3] = 255;
    }
  return output;
}
