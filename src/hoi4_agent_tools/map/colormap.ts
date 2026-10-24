/**
 * Calibrated land colour map (ADR 0054, stage A). The engine overlays the colour map on the
 * terrain atlas at strength 0.75 in gamma space, so a bright colour map leaves the pale atlas
 * almost untouched while the base game's dark, varied one darkens and saturates it. The tables
 * below are the base game's measured class means (mean value 74, 1,084 distinct 5-bit colours);
 * variation comes from deterministic low-frequency noise and a hillshade term, so one terrain
 * class is never one flat colour.
 */
import { fractal, lattice } from './world-noise.js';

export type ColourClass =
  | 'plains'
  | 'farmland'
  | 'forest'
  | 'hills'
  | 'desert'
  | 'mountain'
  | 'marsh'
  | 'jungle'
  | 'snow'
  | 'urban'
  | 'lakes'
  | 'ocean'
  | 'steppe'
  | 'tundra';

export const COLOUR_CLASSES: readonly ColourClass[] = [
  'plains',
  'farmland',
  'forest',
  'hills',
  'desert',
  'mountain',
  'marsh',
  'jungle',
  'snow',
  'urban',
  'lakes',
  'ocean',
  // Appended so the codes of the original classes never change.
  'steppe',
  'tundra',
];

export type WorldLook = 'vanilla-temperate' | 'fertile' | 'arid' | 'custom';
/** `solved` is stage B (ADR 0057): the colour map is solved from target colours over the atlas. */
export type ColourMapProfile = 'calibrated' | 'legacy' | 'solved';

type Triple = readonly [number, number, number];

/** Means of the base game's land colour map by graphical terrain (measured on 1.19.3.0). */
const VANILLA_TEMPERATE: Readonly<Record<ColourClass, Triple>> = {
  plains: [68, 68, 41],
  farmland: [76, 74, 42],
  forest: [47, 55, 24],
  hills: [64, 66, 36],
  desert: [118, 98, 64],
  mountain: [59, 60, 35],
  marsh: [51, 55, 30],
  jungle: [36, 51, 16],
  snow: [55, 58, 35],
  urban: [69, 73, 43],
  lakes: [82, 101, 128],
  ocean: [79, 102, 141],
  steppe: [88, 80, 48],
  tundra: [66, 67, 50],
};

/** Per-channel multipliers applied to the vanilla table for the other palette sets. */
const LOOK_ADJUSTMENTS: Readonly<Record<'fertile' | 'arid', Partial<Record<ColourClass, Triple>>>> =
  {
    fertile: {
      plains: [0.88, 1.1, 0.92],
      farmland: [0.9, 1.1, 0.9],
      hills: [0.92, 1.06, 0.95],
      forest: [0.95, 1.08, 0.95],
      desert: [0.9, 0.97, 0.96],
      marsh: [0.95, 1.05, 0.95],
    },
    arid: {
      plains: [1.18, 1.05, 0.95],
      farmland: [1.12, 1.03, 0.95],
      hills: [1.15, 1.02, 0.95],
      forest: [1.15, 1.0, 0.95],
      marsh: [1.1, 1.0, 0.95],
      desert: [1.04, 1.0, 0.98],
    },
  };

export function colourTable(
  look: WorldLook,
  overrides?: Partial<Record<ColourClass, Triple>>,
): Record<ColourClass, Triple> {
  const table: Record<ColourClass, Triple> = { ...VANILLA_TEMPERATE };
  if (look === 'fertile' || look === 'arid') {
    for (const [name, factor] of Object.entries(LOOK_ADJUSTMENTS[look]) as Array<
      [ColourClass, Triple]
    >) {
      const base = VANILLA_TEMPERATE[name];
      table[name] = [
        Math.min(255, base[0] * factor[0]),
        Math.min(255, base[1] * factor[1]),
        Math.min(255, base[2] * factor[2]),
      ];
    }
  }
  if (overrides !== undefined)
    for (const [name, color] of Object.entries(overrides) as Array<[ColourClass, Triple]>)
      table[name] = color;
  return table;
}

export interface CalibratedColourMapInput {
  width: number;
  height: number;
  seed: number;
  /** Colour class of every full-resolution pixel, as an index into `COLOUR_CLASSES`. */
  classes: Uint8Array;
  /** Wetness in 0..1 per full-resolution pixel. */
  moisture: Float32Array;
  /** The written heightmap, for the hillshade term. */
  heights: Uint8Array;
  /** City-light alpha per full-resolution pixel (0 or the light strength). */
  lights: Uint8Array;
  look: WorldLook;
  overrides?: Partial<Record<ColourClass, Triple>>;
}

/** Number of standard deviations of the value noise that one unit of `fractal()` spans. */
const NOISE_SIGMA = 0.1;

/**
 * The half-resolution colour map as BGRA bytes, rows top to bottom. Deterministic: the noise is
 * integer-hash based and every operation is addition, subtraction, multiplication or division.
 */
export function calibratedColourMap(input: CalibratedColourMapInput): Uint8Array {
  const { width, height, seed, classes, moisture, heights, lights } = input;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const table = colourTable(input.look, input.overrides);
  const colours = COLOUR_CLASSES.map((name) => table[name]);
  const output = new Uint8Array(halfWidth * halfHeight * 4);
  const large = Math.max(40, width / 14);
  const medium = Math.max(16, width / 70);
  const heightAt = (x: number, y: number): number =>
    heights[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
  for (let y = 0; y < halfHeight; y += 1)
    for (let x = 0; x < halfWidth; x += 1) {
      const sx = x * 2;
      const sy = y * 2;
      const source = sy * width + sx;
      const base = colours[classes[source]!]!;
      const water = classes[source] === 10 || classes[source] === 11;
      const offset = (y * halfWidth + x) * 4;
      let factor: number;
      let wet = 0;
      let hue = 0;
      if (water) {
        // The sea floor under the water layer is nearly uniform in the base game.
        factor = 1 + (lattice(seed + 17, sx, sy) - 0.5) * 2 * 0.03;
      } else {
        const low = (fractal(seed + 4201, sx, sy, large, 4) - 0.5) / NOISE_SIGMA;
        const mid = (fractal(seed + 6007, sx, sy, medium, 3) - 0.5) / NOISE_SIGMA;
        hue = (fractal(seed + 8803, sx, sy, large * 0.5, 3) - 0.5) / NOISE_SIGMA;
        const dx = heightAt(sx + 2, sy) - heightAt(sx - 2, sy);
        const dy = heightAt(sx, sy + 2) - heightAt(sx, sy - 2);
        const shade = Math.max(-0.22, Math.min(0.22, (0.7071 * (dx + dy)) / 14));
        factor = 1 + 0.14 * low + 0.07 * mid + shade;
        wet = (moisture[source]! - 0.5) * 2;
      }
      factor = Math.min(1.75, Math.max(0.5, factor));
      const jitter = (channel: number): number =>
        1 + (lattice(seed + 29 + channel, sx, sy) - 0.5) * (water ? 0.06 : 0.16);
      // Wet ground is greener, dry ground warmer; the hue drifts slowly across the land.
      const red = base[0] * factor * jitter(0) * (1 - 0.06 * wet) * (1 + 0.06 * hue);
      const green = base[1] * factor * jitter(1) * (1 + 0.03 * wet);
      const blue = base[2] * factor * jitter(2) * (1 - 0.08 * hue);
      output[offset] = Math.min(255, Math.max(0, Math.round(blue)));
      output[offset + 1] = Math.min(255, Math.max(0, Math.round(green)));
      output[offset + 2] = Math.min(255, Math.max(0, Math.round(red)));
      output[offset + 3] = lights[source]!;
    }
  return output;
}
