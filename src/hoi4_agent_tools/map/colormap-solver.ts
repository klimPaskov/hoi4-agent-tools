/**
 * Colour map solver (ADR 0057, plan section C2 stage B). Stage A (`colormap.ts`) writes tabulated
 * colour map values per class. Stage B states the colour the player should see (a target albedo
 * per pixel from the class, the ecology, the hillshade and a little noise) and solves for the
 * colour map value that produces it: the terrain shader overlays the colour map on the mean colour
 * of the atlas tile the pixel's graphical terrain index draws, and `overlayInverse` undoes that
 * overlay per channel. Tile-dependent errors of the tables disappear, a fertile plain is green on
 * whichever tile draws it, and the result reports how many pixels were out of reach.
 *
 * The model is the unlit overlay only: lighting, fog, seasons and the snow layer are not part of
 * it, so the offline numbers approximate the look and are meant to be calibrated against
 * screenshots the owner approves.
 */
import type { AtlasTiles } from './atlas-tiles.js';
import {
  COLOUR_CLASSES,
  colourTable,
  type ColourClass,
  type WorldLook,
} from './colormap.js';
import { overlayForward, overlayInverse } from './colormap-overlay.js';
import { fractal, lattice } from './world-noise.js';

type Triple = readonly [number, number, number];

/** The tile whose mean colour the base game's colour map means were measured over. */
const CLASS_TILE: Partial<Record<ColourClass, number>> = {
  plains: 1,
  farmland: 0,
  forest: 4,
  hills: 2,
  desert: 9,
  mountain: 11,
  marsh: 6,
  jungle: 4,
  snow: 0,
  urban: 10,
};

/** Classes that carry vegetation: they turn greener when fertile and drier toward the desert. */
const VEGETATION = new Set<ColourClass>([
  'plains',
  'farmland',
  'forest',
  'hills',
  'steppe',
  'tundra',
  'jungle',
  'marsh',
]);

/** Per-channel multipliers of the target albedo for the other palette sets. */
const LOOK_ALBEDO: Readonly<Record<'fertile' | 'arid', Partial<Record<ColourClass, Triple>>>> = {
  fertile: {
    plains: [0.94, 1.07, 0.93],
    farmland: [0.95, 1.08, 0.92],
    hills: [0.96, 1.04, 0.96],
    forest: [0.96, 1.06, 0.95],
    steppe: [0.97, 1.04, 0.96],
    marsh: [0.97, 1.03, 0.97],
  },
  arid: {
    plains: [1.1, 1.03, 0.94],
    farmland: [1.07, 1.02, 0.95],
    hills: [1.08, 1.02, 0.95],
    forest: [1.08, 1.0, 0.95],
    steppe: [1.05, 1.0, 0.95],
    marsh: [1.05, 1.0, 0.97],
    desert: [1.03, 1.0, 0.98],
  },
};

const NOISE_SIGMA = 0.1;
/** A channel further than this (in 0..1) from the wanted colour after quantising is a residual. */
const RESIDUAL_TOLERANCE = 6 / 255;

/**
 * The colour each class should show with the base game's tables, from the base game's measured
 * colour map means over the bundled atlas tile means: what the unmodified game shows.
 */
export function albedoTable(
  look: WorldLook,
  bundledTiles: AtlasTiles,
  overrides?: Partial<Record<ColourClass, Triple>>,
): Triple[] {
  const vanilla = colourTable('vanilla-temperate');
  const albedo: Triple[] = COLOUR_CLASSES.map((name): Triple => {
    const tile = CLASS_TILE[name];
    const cm = vanilla[name];
    if (tile === undefined) return [cm[0] / 255, cm[1] / 255, cm[2] / 255];
    const mean = bundledTiles.means[tile]!;
    return [
      overlayForward(mean[0] / 255, cm[0] / 255),
      overlayForward(mean[1] / 255, cm[1] / 255),
      overlayForward(mean[2] / 255, cm[2] / 255),
    ];
  });
  const index = (name: ColourClass): number => COLOUR_CLASSES.indexOf(name);
  const mix = (a: Triple, b: Triple, t: number): Triple => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  // Dry grass between the plains and the desert; the cold plains pale and grey.
  albedo[index('steppe')] = mix(albedo[index('plains')]!, albedo[index('desert')]!, 0.45);
  const tundra = mix(albedo[index('plains')]!, albedo[index('snow')]!, 0.35);
  const luminance = 0.3 * tundra[0] + 0.59 * tundra[1] + 0.11 * tundra[2];
  albedo[index('tundra')] = mix(tundra, [luminance, luminance, luminance * 1.04], 0.35);
  if (look === 'fertile' || look === 'arid')
    for (const [name, factor] of Object.entries(LOOK_ALBEDO[look]) as Array<
      [ColourClass, Triple]
    >) {
      const base = albedo[index(name)]!;
      albedo[index(name)] = [base[0] * factor[0], base[1] * factor[1], base[2] * factor[2]];
    }
  if (overrides !== undefined)
    for (const [name, colour] of Object.entries(overrides) as Array<[ColourClass, Triple]>)
      albedo[index(name)] = [colour[0] / 255, colour[1] / 255, colour[2] / 255];
  return albedo;
}

export interface ColourSolverInput {
  /** Full map size. */
  width: number;
  height: number;
  seed: number;
  /** Colour class of every full-resolution pixel, an index into `COLOUR_CLASSES`. */
  classes: Uint8Array;
  /** Graphical terrain index of every full-resolution pixel (the `terrain.bmp` indices). */
  indices: Uint8Array;
  /** Atlas tile of each graphical terrain index (`terrainTileTable`). */
  tileOfIndex: Uint8Array;
  /** Mean colours of the atlas tiles as the installed game draws them. */
  tiles: AtlasTiles;
  /** The same tile means the albedo targets were measured over: the bundled table. */
  referenceTiles: AtlasTiles;
  /** The written heightmap, for the hillshade term. */
  heights: Uint8Array;
  /** City-light alpha per full-resolution pixel. */
  lights: Uint8Array;
  look: WorldLook;
  /** Colours by class for `look: 'custom'`, as the colour the player should see. */
  overrides?: Partial<Record<ColourClass, Triple>>;
  /** Wetness in -1 (dry) to 1 (wet) per half-resolution cell, from the ecology. */
  wetness?: Float32Array;
  /** Fertility 0..255 per half-resolution cell, from the ecology. */
  fertility?: Uint8Array;
  /** Mean annual temperature in degrees Celsius per half-resolution cell. */
  temperature?: Float32Array;
  /** Without an ecology: wetness 0..1 per full-resolution pixel. */
  moisture?: Float32Array;
  signal?: AbortSignal | undefined;
}

export interface ColourSolverStatistics {
  /** Land cells solved (half resolution). */
  landCells: number;
  /** Cells where a channel's wanted colour was outside the range the tile allows. */
  clamped: number;
  /** Cells where a channel misses the wanted colour by more than 6/255 after quantising. */
  residual: number;
  meanValue: number;
  distinct5BitColours: number;
  tileSource: AtlasTiles['source'];
}

export interface ColourSolverResult {
  /** The half-resolution colour map as BGRA bytes, rows top to bottom. */
  colormap: Uint8Array;
  statistics: ColourSolverStatistics;
}

const WATER_CLASSES = new Set<number>([
  COLOUR_CLASSES.indexOf('lakes'),
  COLOUR_CLASSES.indexOf('ocean'),
]);

/**
 * Solve the half-resolution colour map. Deterministic: the noise is integer-hash based and every
 * operation is `+ - * /`, `sqrt` or a table lookup.
 */
export function solveColourMap(input: ColourSolverInput): ColourSolverResult {
  const { width, height, seed, classes, indices, heights, lights } = input;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const albedo = albedoTable(input.look, input.referenceTiles, input.overrides);
  const waterTable = colourTable(input.look);
  const desert = albedo[COLOUR_CLASSES.indexOf('desert')]!;
  const vegetation = COLOUR_CLASSES.map((name) => VEGETATION.has(name));
  const tileMean = new Float64Array(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const mean = input.tiles.means[input.tileOfIndex[index]!] ?? input.tiles.means[1]!;
    tileMean[index * 3] = mean[0] / 255;
    tileMean[index * 3 + 1] = mean[1] / 255;
    tileMean[index * 3 + 2] = mean[2] / 255;
  }
  const output = new Uint8Array(halfWidth * halfHeight * 4);
  const large = Math.max(40, width / 14);
  const medium = Math.max(16, width / 70);
  const heightAt = (x: number, y: number): number =>
    heights[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
  const seen = new Uint8Array(32 * 32 * 32);
  let landCells = 0;
  let clamped = 0;
  let residual = 0;
  let valueSum = 0;
  let distinct = 0;

  for (let y = 0; y < halfHeight; y += 1) {
    if (y % 64 === 0) input.signal?.throwIfAborted();
    for (let x = 0; x < halfWidth; x += 1) {
      const sx = x * 2;
      const sy = y * 2;
      const source = sy * width + sx;
      const cell = y * halfWidth + x;
      const offset = cell * 4;
      const cls = classes[source]!;
      output[offset + 3] = lights[source]!;
      if (WATER_CLASSES.has(cls)) {
        // The sea floor under the water layer is nearly uniform in the base game.
        const base = waterTable[COLOUR_CLASSES[cls]!]!;
        const factor = 1 + (lattice(seed + 17, sx, sy) - 0.5) * 2 * 0.03;
        const jitter = (channel: number): number =>
          1 + (lattice(seed + 29 + channel, sx, sy) - 0.5) * 0.06;
        output[offset] = clampByte(base[2] * factor * jitter(2));
        output[offset + 1] = clampByte(base[1] * factor * jitter(1));
        output[offset + 2] = clampByte(base[0] * factor * jitter(0));
        continue;
      }

      const low = (fractal(seed + 4201, sx, sy, large, 4) - 0.5) / NOISE_SIGMA;
      const mid = (fractal(seed + 6007, sx, sy, medium, 3) - 0.5) / NOISE_SIGMA;
      const hue = (fractal(seed + 8803, sx, sy, large * 0.5, 3) - 0.5) / NOISE_SIGMA;
      const dx = heightAt(sx + 2, sy) - heightAt(sx - 2, sy);
      const dy = heightAt(sx, sy + 2) - heightAt(sx, sy - 2);
      const shade = Math.max(-0.14, Math.min(0.14, (0.7071 * (dx + dy)) / 22));
      const factor = Math.min(1.45, Math.max(0.6, 1 + 0.11 * low + 0.055 * mid + shade));
      const wetness =
        input.wetness !== undefined
          ? input.wetness[cell]!
          : input.moisture !== undefined
            ? (input.moisture[source]! - 0.5) * 2
            : 0;
      const jitter = (channel: number): number =>
        1 + (lattice(seed + 29 + channel, sx, sy) - 0.5) * 0.06;

      let [r, g, b] = albedo[cls]!;
      const vegetated = vegetation[cls]!;
      if (vegetated && wetness < 0) {
        const mix = 0.28 * Math.min(1, -wetness);
        r += (desert[0] - r) * mix;
        g += (desert[1] - g) * mix;
        b += (desert[2] - b) * mix;
      }
      r *= factor * jitter(0) * (1 - 0.05 * wetness) * (1 + 0.05 * hue);
      g *= factor * jitter(1) * (1 + 0.03 * wetness);
      b *= factor * jitter(2) * (1 - 0.07 * hue);
      if (input.fertility !== undefined && vegetated) {
        const lush = input.fertility[cell]! / 255 - 0.5;
        g *= 1 + 0.14 * lush;
        r *= 1 - 0.09 * lush;
        b *= 1 - 0.12 * lush;
      }
      if (input.temperature !== undefined) {
        const cold = Math.min(1, Math.max(0, (4 - input.temperature[cell]!) / 26));
        if (cold > 0) {
          const grey = 0.3 * r + 0.59 * g + 0.11 * b;
          const mix = 0.5 * cold;
          r += (grey * 0.97 - r) * mix;
          g += (grey - g) * mix;
          b += (grey * 1.06 - b) * mix;
          const lift = 1 + 0.06 * cold;
          r *= lift;
          g *= lift;
          b *= lift;
        }
      }

      // The atlas colour under this cell: its four pixels' tiles blend bilinearly in the shader.
      const i00 = indices[source]! * 3;
      const i01 = indices[source + 1]! * 3;
      const i10 = indices[source + width]! * 3;
      const i11 = indices[source + width + 1]! * 3;
      const atlas: [number, number, number] = [0, 0, 0];
      for (let channel = 0; channel < 3; channel += 1)
        atlas[channel] =
          (tileMean[i00 + channel]! +
            tileMean[i01 + channel]! +
            tileMean[i10 + channel]! +
            tileMean[i11 + channel]!) /
          4;
      const wanted = [clampWanted(r), clampWanted(g), clampWanted(b)] as const;
      let anyClamped = false;
      let worst = 0;
      const values: [number, number, number] = [0, 0, 0];
      for (let channel = 0; channel < 3; channel += 1) {
        const inverse = overlayInverse(atlas[channel]!, wanted[channel]!);
        if (!inverse.reachable) anyClamped = true;
        const byte = clampByte(inverse.colour * 255);
        values[channel] = byte;
        const shown = overlayForward(atlas[channel]!, byte / 255);
        const miss = Math.abs(shown - wanted[channel]!);
        if (miss > worst) worst = miss;
      }
      output[offset] = values[2];
      output[offset + 1] = values[1];
      output[offset + 2] = values[0];
      landCells += 1;
      if (anyClamped) clamped += 1;
      if (worst > RESIDUAL_TOLERANCE) residual += 1;
      valueSum += Math.max(values[0], values[1], values[2]);
      const key = ((values[0] >> 3) << 10) | ((values[1] >> 3) << 5) | (values[2] >> 3);
      if (seen[key] === 0) {
        seen[key] = 1;
        distinct += 1;
      }
    }
  }
  return {
    colormap: output,
    statistics: {
      landCells,
      clamped,
      residual,
      meanValue: landCells === 0 ? 0 : valueSum / landCells,
      distinct5BitColours: distinct,
      tileSource: input.tiles.source,
    },
  };
}

function clampByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

function clampWanted(value: number): number {
  return value < 0.012 ? 0.012 : value > 0.985 ? 0.985 : value;
}
