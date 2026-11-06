/**
 * Relief from painted classes (ZR-27, ADR 0056 amended). A reference picture classified with a
 * palette says, pixel by pixel, where the mountains, hills and volcanoes are, which the polygons
 * of a geography model only approximate. This stage raises the macro relief toward those classes
 * before the hydrology runs, so the model's rivers route around the painted mountains:
 *
 * - each class is measured as its share of every macro cell and blurred over `falloffPx`, so a
 *   single painted pixel lifts nothing and a class edge becomes a slope, never a cliff;
 * - mountains rise toward `mountainPeak` under ridged noise, so ranges keep crests and saddles,
 *   hills toward `hillsPeak` under gentle noise, volcanoes toward `volcanoPeak`;
 * - a cell keeps the model's height where that is higher, and every other cell keeps the model's
 *   broad elevation untouched;
 * - impassable land (ZR-28) rises toward `impassablePeak`, the highest ground of the map;
 * - a declared pass keeps the saddle the macro relief carved for it: the raise is capped there
 *   as the carving capped the model's own heights, so a painted range never fills its pass;
 * - painted mountains and volcanoes get permanent snow above a height that falls from the
 *   equator toward the poles, and weight the full-resolution detail as model ranges do.
 */
import { LAND } from './grid.js';
import { fractal2, ridged2, smoothstep } from './math.js';
import {
  cappedAtPass,
  HEIGHT_CEILING,
  PEAK_BASE,
  PEAK_SPAN,
  type PassCaps,
} from './macro-relief.js';

/** Reference terrain codes the stage reads (`REFERENCE_TERRAIN` of the reference interpretation). */
export const PAINTED_MOUNTAIN = 3;
export const PAINTED_VOLCANO = 5;
export const PAINTED_HILLS = 6;

export interface PaintedReliefSettings {
  /** Blur radius of the class edges in full-resolution pixels. */
  falloffPx: number;
  /** 0 to 1 peaks on the relief scale of model ranges (`PEAK_BASE + PEAK_SPAN * peak`). */
  mountainPeak: number;
  hillsPeak: number;
  volcanoPeak: number;
  /** Peak of impassable land (ZR-28), the highest ground of the map. */
  impassablePeak: number;
}

/** Defaults measured against the base game 1.19.4.1: mountain p99 223, hills p90 140. */
export const DEFAULT_PAINTED_RELIEF: PaintedReliefSettings = {
  falloffPx: 24,
  mountainPeak: 0.82,
  hillsPeak: 0.27,
  volcanoPeak: 0.9,
  impassablePeak: 0.95,
};

export interface PaintedReliefInput {
  /** Full-resolution class code per pixel. */
  classes: Uint8Array;
  /** Full-resolution mask of impassable land, which rises toward `impassablePeak`. */
  impassable?: Uint8Array | undefined;
  settings: PaintedReliefSettings;
  seed: number;
}

/** The macro arrays the stage changes in place. */
export interface PaintedReliefTarget {
  /** Macro grid size: half the map. */
  width: number;
  height: number;
  kind: Uint8Array;
  heights: Float32Array;
  footprint: Float32Array;
  snowLine: Uint8Array;
  /** The pass saddles of the macro relief, which a raise may not fill. */
  passCap?: PassCaps | undefined;
  scale: number;
}

export interface PaintedReliefSummary {
  /** Macro cells the painted classes raised above the model. */
  raisedCells: number;
  /** Highest painted target in map values. */
  highest: number;
}

/** Three passes of a separable box blur, about a Gaussian with the given radius in cells. */
function blur(field: Float32Array, width: number, height: number, radius: number): Float32Array {
  let source = field;
  const passRadius = Math.max(1, Math.round(radius / Math.sqrt(3)));
  const span = passRadius * 2 + 1;
  for (let pass = 0; pass < 3; pass += 1) {
    const across = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = -passRadius; x <= passRadius; x += 1)
        sum += source[row + Math.min(width - 1, Math.max(0, x))]!;
      for (let x = 0; x < width; x += 1) {
        across[row + x] = sum / span;
        sum +=
          source[row + Math.min(width - 1, x + passRadius + 1)]! -
          source[row + Math.max(0, x - passRadius)]!;
      }
    }
    const down = new Float32Array(width * height);
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -passRadius; y <= passRadius; y += 1)
        sum += across[Math.min(height - 1, Math.max(0, y)) * width + x]!;
      for (let y = 0; y < height; y += 1) {
        down[y * width + x] = sum / span;
        sum +=
          across[Math.min(height - 1, y + passRadius + 1) * width + x]! -
          across[Math.max(0, y - passRadius) * width + x]!;
      }
    }
    source = down;
  }
  return source;
}

/** Permanent-snow height in map values at a row: 232 at the equator, 140 at the poles. */
export function paintedSnowHeight(y: number, height: number): number {
  const latitude = Math.abs((y + 0.5) / height - 0.5) * 2;
  return Math.round(232 - 92 * latitude ** 1.5);
}

export function applyPaintedRelief(
  target: PaintedReliefTarget,
  input: PaintedReliefInput,
): PaintedReliefSummary {
  const { width: mw, height: mh, kind } = target;
  const fullWidth = mw * 2;
  const share = (code: number, source: Uint8Array = input.classes): Float32Array => {
    const field = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y += 1)
      for (let x = 0; x < mw; x += 1) {
        const top = 2 * y * fullWidth + 2 * x;
        let count = 0;
        for (const offset of [0, 1, fullWidth, fullWidth + 1])
          if (source[top + offset] === code) count += 1;
        field[y * mw + x] = count / 4;
      }
    return field;
  };
  const radius = Math.max(1, input.settings.falloffPx / 2);
  const mountain = blur(share(PAINTED_MOUNTAIN), mw, mh, radius);
  const hills = blur(share(PAINTED_HILLS), mw, mh, radius);
  // Volcanoes are cones: a narrower falloff keeps them peaked.
  const volcano = blur(share(PAINTED_VOLCANO), mw, mh, Math.max(1, radius / 2));
  const blocked =
    input.impassable === undefined ? undefined : blur(share(1, input.impassable), mw, mh, radius);
  const lift = (peak: number): number => PEAK_SPAN * peak * target.scale;
  const wavelength = Math.max(6, radius * 3);
  let raisedCells = 0;
  let highest = 0;
  for (let y = 0; y < mh; y += 1)
    for (let x = 0; x < mw; x += 1) {
      const cell = y * mw + x;
      if (kind[cell] !== LAND) continue;
      // Coverage saturates inside a painted area, so its interior reaches the peak.
      const m = smoothstep(mountain[cell]! * 1.6);
      const h = smoothstep(hills[cell]! * 1.6);
      const v = smoothstep(volcano[cell]! * 2);
      const i = blocked === undefined ? 0 : smoothstep(blocked[cell]! * 1.6);
      if (m <= 0.001 && h <= 0.001 && v <= 0.001 && i <= 0.001) continue;
      const ridges = 0.55 + 0.45 * ridged2(input.seed + 4111, x, y, wavelength, 3);
      const swell = 0.7 + 0.3 * fractal2(input.seed + 4127, x, y, wavelength, 3);
      const goal = Math.min(
        HEIGHT_CEILING,
        Math.max(
          PEAK_BASE + lift(input.settings.mountainPeak) * m * ridges,
          PEAK_BASE + lift(input.settings.hillsPeak) * h * swell,
          PEAK_BASE + lift(input.settings.volcanoPeak) * v,
          // Impassable land keeps its crests but never sinks below most of its peak.
          PEAK_BASE + lift(input.settings.impassablePeak) * i * (0.8 + 0.2 * ridges),
        ),
      );
      const raised = cappedAtPass(target.passCap, cell, goal);
      if (raised > target.heights[cell]!) {
        target.heights[cell] = raised;
        raisedCells += 1;
        if (raised > highest) highest = raised;
      }
      const weight = Math.max(m, 0.6 * h, v, i);
      if (weight > target.footprint[cell]!) target.footprint[cell] = weight;
      if (Math.max(m, v, i) > 0.25) {
        const snow = paintedSnowHeight(y, mh);
        if (snow < target.snowLine[cell]!) target.snowLine[cell] = snow;
      }
    }
  return { raisedCells, highest: Math.round(highest) };
}

/** Settings for `relief.painted`: `true` takes the defaults, an object overrides some of them. */
export function resolvePaintedRelief(
  input: true | { [K in keyof PaintedReliefSettings]?: number | undefined },
): PaintedReliefSettings {
  if (input === true) return DEFAULT_PAINTED_RELIEF;
  return {
    falloffPx: input.falloffPx ?? DEFAULT_PAINTED_RELIEF.falloffPx,
    mountainPeak: input.mountainPeak ?? DEFAULT_PAINTED_RELIEF.mountainPeak,
    hillsPeak: input.hillsPeak ?? DEFAULT_PAINTED_RELIEF.hillsPeak,
    volcanoPeak: input.volcanoPeak ?? DEFAULT_PAINTED_RELIEF.volcanoPeak,
    impassablePeak: input.impassablePeak ?? DEFAULT_PAINTED_RELIEF.impassablePeak,
  };
}
