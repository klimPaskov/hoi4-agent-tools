/**
 * Full-resolution height field (ADR 0056): the macro relief upsampled bilinearly with the macro
 * kind as a mask, plus fractal and ridged detail weighted by the mountain footprint, plus the coast
 * ramp. Heights stay floating point until the very end, so shading never terraces.
 */
import { rowStrips } from '../geography/index.js';
import { LAND } from './grid.js';
import { LAND_FLOOR, type MacroRelief } from './macro-relief.js';
import { clamp, fractal2, lerp, ridged2, smoothstep } from './math.js';

/** Length of the coast ramp, in pixels: land stands at the floor at the shore and free of it from here. */
export const COAST_RAMP_PIXELS = 6;

/**
 * Four-neighbour distance of land pixels from the nearest water pixel: 1 for land next to water,
 * up to `limit`; 0 for water and for land farther than `limit`.
 */
export function landEdgeDistance(
  kind: Uint8Array,
  width: number,
  height: number,
  limit: number,
): Uint8Array {
  const total = width * height;
  const distance = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (kind[pixel] !== LAND) continue;
    const x = pixel % width;
    const touchesWater =
      (x > 0 && kind[pixel - 1] !== LAND) ||
      (x < width - 1 && kind[pixel + 1] !== LAND) ||
      (pixel >= width && kind[pixel - width] !== LAND) ||
      (pixel < total - width && kind[pixel + width] !== LAND);
    if (touchesWater) {
      distance[pixel] = 1;
      queue[tail++] = pixel;
    }
  }
  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    if (next > limit) continue;
    const x = pixel % width;
    const visit = (other: number): void => {
      if (kind[other] === LAND && distance[other] === 0) {
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

export interface FullResolutionInput {
  macro: MacroRelief;
  /** Full-resolution kind. */
  kind: Uint8Array;
  width: number;
  height: number;
  seed: number;
  /** 0 to 1. */
  detail: number;
  signal?: AbortSignal | undefined;
}

/**
 * Float heights of land at full resolution, in map values. Water pixels hold 0: their heights are
 * a function of the distance to land and are written when the field is quantised.
 */
export function buildFullResolutionHeights(input: FullResolutionInput): Float32Array {
  const { macro, kind, width, height, seed } = input;
  const mw = macro.width;
  const mh = macro.height;
  const out = new Float32Array(width * height);
  const edge = landEdgeDistance(kind, width, height, COAST_RAMP_PIXELS);
  const wavelength = Math.max(12, 0.0046 * width);
  const broad = Math.max(24, 0.0125 * width);
  const detailAmplitude = 0.4 + 1.2 * input.detail;
  const heights = macro.heights;
  const macroKind = macro.kind;
  for (const strip of rowStrips({ width, height }, 64)) {
    input.signal?.throwIfAborted();
    for (let y = strip.y0; y < strip.y1; y += 1) {
      const v = (y - 0.5) / 2;
      const vy0 = clamp(Math.floor(v), 0, mh - 1);
      const vy1 = vy0 + 1 < mh ? vy0 + 1 : vy0;
      const ty = clamp(v - vy0, 0, 1);
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        if (kind[pixel] !== LAND) continue;
        const u = (x - 0.5) / 2;
        const ux0 = clamp(Math.floor(u), 0, mw - 1);
        const ux1 = ux0 + 1 < mw ? ux0 + 1 : ux0;
        const tx = clamp(u - ux0, 0, 1);
        // Masked bilinear: only land cells contribute, so the coast does not sag to zero.
        const i00 = vy0 * mw + ux0;
        const i10 = vy0 * mw + ux1;
        const i01 = vy1 * mw + ux0;
        const i11 = vy1 * mw + ux1;
        const w00 = macroKind[i00] === LAND ? (1 - tx) * (1 - ty) : 0;
        const w10 = macroKind[i10] === LAND ? tx * (1 - ty) : 0;
        const w01 = macroKind[i01] === LAND ? (1 - tx) * ty : 0;
        const w11 = macroKind[i11] === LAND ? tx * ty : 0;
        const total = w00 + w10 + w01 + w11;
        let level: number;
        let footprint: number;
        if (total > 1e-6) {
          level =
            (heights[i00]! * w00 +
              heights[i10]! * w10 +
              heights[i01]! * w01 +
              heights[i11]! * w11) /
            total;
          footprint =
            (macro.footprint[i00]! * w00 +
              macro.footprint[i10]! * w10 +
              macro.footprint[i01]! * w01 +
              macro.footprint[i11]! * w11) /
            total;
        } else {
          level = LAND_FLOOR + 3;
          footprint = 0;
        }
        // Detail: ridged crests and gullies in the mountains, quiet roughness on the plains.
        const warpX = (fractal2(seed + 211, x, y, broad, 2) - 0.5) * 2 * wavelength * 0.9;
        const warpY = (fractal2(seed + 223, x, y, broad, 2) - 0.5) * 2 * wavelength * 0.9;
        const ridge = ridged2(seed + 101, x + warpX, y + warpY, wavelength, 3);
        const rolling = fractal2(seed + 131, x, y, broad, 3) - 0.5;
        const amplitude = detailAmplitude * (0.5 + 5.5 * footprint);
        let h = level + (ridge - 0.45) * 2 * amplitude + rolling * 2 * detailAmplitude * 0.6;
        const near = edge[pixel]!;
        if (near > 0 && near <= COAST_RAMP_PIXELS)
          h = lerp(
            LAND_FLOOR,
            Math.max(h, LAND_FLOOR),
            smoothstep((near - 1) / (COAST_RAMP_PIXELS - 1)),
          );
        out[pixel] = h < LAND_FLOOR ? LAND_FLOOR : h;
      }
    }
  }
  return out;
}
