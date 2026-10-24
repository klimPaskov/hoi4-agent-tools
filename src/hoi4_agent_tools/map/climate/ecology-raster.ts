/**
 * From the macro ecology to full-resolution rasters (ADR 0057): the terrain class and fertility
 * planes the partition reads, the province terrain vote that follows them, the graphical terrain
 * index of every pixel, the colour class for the colour map, and the tree grid. A pixel finds its
 * macro cell through a small smooth warp, so the edges between covers are not 2-pixel stairs, and
 * the same warp serves every pass, so the class plane, the terrain bitmap and the trees agree.
 */
import { PARTITION_TERRAIN } from '../partition-fields.js';
import { COLOUR_CLASSES, type ColourClass } from '../colormap.js';
import { lattice } from '../world-noise.js';
import { clamp01, smoothstep01 } from '../stable-math.js';
import {
  COVER,
  COVER_NAMES,
  COVER_TABLE,
  NO_COVER,
  RELIEF,
  partitionClassOf,
  terrainNameOfClass,
  type ProvinceTerrain,
} from './biome-table.js';
import type { Ecology } from './ecology.js';
import type { GraphicIndices } from './graphic-indices.js';

const LAND = 1;
const LAKE = 2;

/** A smooth noise on a coarse lattice, sampled bilinearly. */
class NoiseGrid {
  readonly #values: Float32Array;
  readonly #columns: number;
  readonly #cell: number;

  constructor(seed: number, width: number, height: number, cell: number) {
    this.#cell = cell;
    this.#columns = Math.ceil(width / cell) + 2;
    const rows = Math.ceil(height / cell) + 2;
    this.#values = new Float32Array(this.#columns * rows);
    for (let j = 0; j < rows; j += 1)
      for (let i = 0; i < this.#columns; i += 1)
        this.#values[j * this.#columns + i] = lattice(seed, i, j);
  }

  /** 0..1, smooth over `cell` pixels. */
  at(x: number, y: number): number {
    const u = x / this.#cell;
    const v = y / this.#cell;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const tx = smoothstep01(u - i);
    const ty = smoothstep01(v - j);
    const base = j * this.#columns + i;
    const a = this.#values[base]!;
    const b = this.#values[base + 1]!;
    const c = this.#values[base + this.#columns]!;
    const d = this.#values[base + this.#columns + 1]!;
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }
}

/** Maps full-resolution pixels to macro cells through a smooth warp, and carries mixing noise. */
export class EcologySampler {
  readonly width: number;
  readonly height: number;
  readonly #ecology: Ecology;
  readonly #warpX: NoiseGrid;
  readonly #warpY: NoiseGrid;
  readonly #fineX: NoiseGrid;
  readonly #fineY: NoiseGrid;
  readonly #mixLarge: NoiseGrid;
  readonly #mixSmall: NoiseGrid;
  readonly #seed: number;

  constructor(ecology: Ecology, width: number, height: number, seed: number) {
    this.#ecology = ecology;
    this.width = width;
    this.height = height;
    this.#seed = seed;
    this.#warpX = new NoiseGrid(seed + 61001, width, height, 24);
    this.#warpY = new NoiseGrid(seed + 61003, width, height, 24);
    this.#fineX = new NoiseGrid(seed + 61007, width, height, 7);
    this.#fineY = new NoiseGrid(seed + 61009, width, height, 7);
    this.#mixLarge = new NoiseGrid(seed + 61051, width, height, Math.max(20, width / 60));
    this.#mixSmall = new NoiseGrid(seed + 61057, width, height, Math.max(6, width / 300));
  }

  /**
   * The macro cell of a pixel after the warp, or the pixel's own cell when the warped one is not
   * land. The warp moves a pixel by up to about 3 pixels.
   */
  cellOf(x: number, y: number): number {
    const mw = this.#ecology.width;
    const mh = this.#ecology.height;
    const wx = (this.#warpX.at(x, y) - 0.5) * 6.4 + (this.#fineX.at(x, y) - 0.5) * 2.4;
    const wy = (this.#warpY.at(x, y) - 0.5) * 6.4 + (this.#fineY.at(x, y) - 0.5) * 2.4;
    let cx = Math.floor((x + wx) / 2);
    let cy = Math.floor((y + wy) / 2);
    cx = cx < 0 ? 0 : cx >= mw ? mw - 1 : cx;
    cy = cy < 0 ? 0 : cy >= mh ? mh - 1 : cy;
    const cell = cy * mw + cx;
    if (this.#ecology.cover[cell] !== NO_COVER) return cell;
    return (y >> 1) * mw + (x >> 1);
  }

  /** Smooth mixing noise at two scales, 0..1. */
  mix(x: number, y: number): { large: number; small: number } {
    return { large: this.#mixLarge.at(x, y), small: this.#mixSmall.at(x, y) };
  }

  /** A fixed random number for a pixel and a purpose, 0..1. */
  hash(x: number, y: number, purpose: number): number {
    return lattice(this.#seed + purpose, x, y);
  }
}

export interface EcologyPlanes {
  /** `PARTITION_TERRAIN` class of every pixel; 255 off land. */
  readonly classPlane: Uint8Array;
  /** Fertility 0..255 of every pixel (bilinear over the macro cells); 0 off land. */
  readonly fertilityPlane: Uint8Array;
}

/**
 * The terrain class and fertility planes of a world, for the feature-aware partition and for the
 * province terrain vote. `snow` marks permanent snow pixels of the relief synthesis: they belong
 * to mountains.
 */
export function ecologyPlanes(
  ecology: Ecology,
  sampler: EcologySampler,
  kind: Uint8Array,
  snow: Uint8Array | undefined,
  signal?: AbortSignal,
): EcologyPlanes {
  const { width, height } = sampler;
  const total = width * height;
  const classPlane = new Uint8Array(total).fill(PARTITION_TERRAIN.water);
  const fertilityPlane = new Uint8Array(total);
  const mw = ecology.width;
  const mh = ecology.height;
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) signal?.throwIfAborted();
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (kind[pixel] !== LAND) continue;
      const cell = sampler.cellOf(x, y);
      const cover = ecology.cover[cell]!;
      let relief = ecology.relief[cell]!;
      if (snow !== undefined && snow[pixel] === 1 && cover !== COVER.ice) relief = RELIEF.mountain;
      classPlane[pixel] = partitionClassOf(cover === NO_COVER ? COVER.plains : cover, relief);
      // Fertility: bilinear between the four nearest macro cell centres.
      const u = (x + 0.5) / 2 - 0.5;
      const v = (y + 0.5) / 2 - 0.5;
      const i0 = Math.max(0, Math.min(mw - 1, Math.floor(u)));
      const j0 = Math.max(0, Math.min(mh - 1, Math.floor(v)));
      const i1 = Math.min(mw - 1, i0 + 1);
      const j1 = Math.min(mh - 1, j0 + 1);
      const tx = clamp01(u - i0);
      const ty = clamp01(v - j0);
      const f00 = ecology.fertility[j0 * mw + i0]!;
      const f10 = ecology.fertility[j0 * mw + i1]!;
      const f01 = ecology.fertility[j1 * mw + i0]!;
      const f11 = ecology.fertility[j1 * mw + i1]!;
      fertilityPlane[pixel] = Math.round(
        f00 + (f10 - f00) * tx + (f01 - f00) * ty + (f00 - f10 - f01 + f11) * tx * ty,
      );
    }
  }
  return { classPlane, fertilityPlane };
}

/** Province terrain names for the land provinces, by vote over the class plane. */
export function provinceTerrainVote(
  classPlane: Uint8Array,
  provincePixels: Uint16Array | Uint32Array | Int32Array,
  provinceCount: number,
  landProvinces: ReadonlyArray<number>,
): Map<number, ProvinceTerrain> {
  const classes = 10;
  const counts = new Uint32Array(provinceCount * classes);
  for (let pixel = 0; pixel < classPlane.length; pixel += 1) {
    const value = classPlane[pixel]!;
    if (value < classes) counts[provincePixels[pixel]! * classes + value]! += 1;
  }
  const result = new Map<number, ProvinceTerrain>();
  for (const id of landProvinces) {
    const base = id * classes;
    let total = 0;
    for (let c = 0; c < classes; c += 1) total += counts[base + c]!;
    if (total === 0) {
      result.set(id, 'plains');
      continue;
    }
    const mountain = counts[base + PARTITION_TERRAIN.mountain]!;
    const hills = counts[base + PARTITION_TERRAIN.hills]!;
    if (mountain >= total * 0.45) result.set(id, 'mountain');
    else if (mountain + hills >= total * 0.55)
      result.set(id, mountain > hills ? 'mountain' : 'hills');
    else {
      // Ground cover: plains, farmland, snow and the rest vote for the terrain they draw.
      const votes = new Map<ProvinceTerrain, number>();
      for (let c = 0; c < classes; c += 1) {
        if (c === PARTITION_TERRAIN.mountain || c === PARTITION_TERRAIN.hills) continue;
        const name = terrainNameOfClass(c === PARTITION_TERRAIN.snow ? PARTITION_TERRAIN.plains : c);
        votes.set(name, (votes.get(name) ?? 0) + counts[base + c]!);
      }
      votes.set('hills', (votes.get('hills') ?? 0) + hills * 0.5);
      let best: ProvinceTerrain = 'plains';
      let bestVotes = -1;
      for (const [name, count] of [...votes].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
        if (count > bestVotes) {
          best = name;
          bestVotes = count;
        }
      result.set(id, best);
    }
  }
  return result;
}

export interface GraphicsInput {
  ecology: Ecology;
  sampler: EcologySampler;
  indices: GraphicIndices;
  kind: Uint8Array;
  snow: Uint8Array | undefined;
  /** 15 on urban footprint pixels (victory points). */
  cityPixels: Uint8Array;
  signal?: AbortSignal | undefined;
}

export interface Graphics {
  /** `terrain.bmp` indices. */
  readonly terrainPixels: Uint8Array;
  /** Index into `COLOUR_CLASSES` of every pixel. */
  readonly colourClasses: Uint8Array;
}

const CLASS_CODE = new Map<ColourClass, number>(
  COLOUR_CLASSES.map((name, index) => [name, index] as const),
);

/**
 * The graphical terrain index and colour class of every pixel. Covers mix their variants with
 * smooth noise: dense and sparse forest, farmland edges, three desert tiles, sand and grassy
 * mountains, peaks, desert hills.
 */
export function ecologyGraphics(input: GraphicsInput): Graphics {
  const { ecology, sampler, indices: g, kind, snow, cityPixels } = input;
  const { width, height } = sampler;
  const total = width * height;
  const terrainPixels = new Uint8Array(total);
  const colourClasses = new Uint8Array(total);
  const code = (name: ColourClass): number => CLASS_CODE.get(name)!;
  const lakeClass = code('lakes');
  const oceanClass = code('ocean');
  const urbanClass = code('urban');
  const snowClass = code('snow');
  const mountainClass = code('mountain');
  const hillsClass = code('hills');
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) input.signal?.throwIfAborted();
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const surface = kind[pixel]!;
      if (surface !== LAND) {
        terrainPixels[pixel] = surface === LAKE ? g.lake : g.ocean;
        colourClasses[pixel] = surface === LAKE ? lakeClass : oceanClass;
        continue;
      }
      if (cityPixels[pixel] === 15) {
        terrainPixels[pixel] = g.urban;
        colourClasses[pixel] = urbanClass;
        continue;
      }
      const cell = sampler.cellOf(x, y);
      let cover = ecology.cover[cell]!;
      if (cover === NO_COVER) cover = COVER.plains;
      const relief = ecology.relief[cell]!;
      const density = ecology.density[cell]! / 255;
      const moisture = ecology.moisture[cell]!;
      const temperature = ecology.temperature[cell]!;
      const height255 = ecology.heights[cell]!;
      const { large, small } = sampler.mix(x, y);
      const n = large * 0.7 + small * 0.3;
      if (snow !== undefined && snow[pixel] === 1 && cover !== COVER.ice) {
        terrainPixels[pixel] = g.snowMountain;
        colourClasses[pixel] = snowClass;
        continue;
      }
      let index: number;
      let colour: ColourClass;
      if (relief === RELIEF.mountain) {
        colour = 'mountain';
        if (cover === COVER.ice) {
          index = g.snowMountain;
          colour = 'snow';
        } else if (cover === COVER.desert || moisture < 0.3)
          index = large < 0.55 ? g.mountainSand : g.mountain;
        else if (height255 >= 215) index = large < 0.5 ? g.mountainTops : g.mountain;
        else if (moisture > 0.6 && height255 < 175 && large > 0.45) index = g.mountainGrass;
        else index = large > 0.82 ? g.mountainAlt : g.mountain;
      } else if (relief === RELIEF.hills) {
        colour = 'hills';
        if (cover === COVER.ice) {
          index = g.snowPlains;
          colour = 'snow';
        } else if (cover === COVER.desert || moisture < 0.3)
          index = large < 0.5 ? g.desertHills : g.desertRidge;
        else if (cover === COVER.forest) {
          index = density > 0.55 ? g.forestDense : g.forestSparse;
          colour = 'forest';
        } else if (cover === COVER.jungle) {
          index = g.jungleDense;
          colour = 'jungle';
        } else if (cover === COVER.marsh) index = g.marsh;
        else index = g.hills;
      } else {
        const definition = COVER_TABLE[COVER_NAMES[cover]!];
        colour = definition.colour;
        switch (cover) {
          case COVER.farmland:
            index = n < 0.16 ? g.plains : g.farmland;
            break;
          case COVER.steppe: {
            const dry = clamp01((0.6 - moisture) / 0.3);
            index = n < dry * 0.9 ? g.steppe : g.plains;
            break;
          }
          case COVER.forest:
            index =
              density > 0.62
                ? n < 0.15
                  ? g.forestSparse
                  : g.forestDense
                : density > 0.4
                  ? n < 0.6
                    ? g.forestSparse
                    : g.forestDense
                  : n < 0.8
                    ? g.forestSparse
                    : g.plains;
            break;
          case COVER.jungle:
            index = density > 0.6 ? (n < 0.7 ? g.jungleDense : g.jungleSparse) : g.jungleSparse;
            break;
          case COVER.desert:
            index = n < 0.45 ? g.desertDunes : n < 0.8 ? g.desertFlat : g.desertRock;
            break;
          case COVER.marsh:
            index = g.marsh;
            break;
          case COVER.tundra:
            index = temperature < -5 && n < 0.35 ? g.snowPlains : g.plains;
            break;
          case COVER.ice:
            index = g.snowPlains;
            break;
          default:
            index = g.plains;
        }
      }
      terrainPixels[pixel] = index;
      colourClasses[pixel] = code(colour);
    }
  }
  void hillsClass;
  void mountainClass;
  return { terrainPixels, colourClasses };
}

export interface TreeGridInput {
  ecology: Ecology;
  sampler: EcologySampler;
  kind: Uint8Array;
  /** Palette index per kind of tree: 5/6 forest, 28/29 jungle, 2/3 palm. */
  trees?: Partial<TreeIndices>;
  seed: number;
}

export interface TreeIndices {
  forestSparse: number;
  forestDense: number;
  jungleSparse: number;
  jungleDense: number;
  palmSparse: number;
  palmDense: number;
}

export const DEFAULT_TREE_INDICES: TreeIndices = {
  forestSparse: 5,
  forestDense: 6,
  jungleSparse: 28,
  jungleDense: 29,
  palmSparse: 2,
  palmDense: 3,
};

/** `trees.bmp` (75/256 of the map size): forests, jungles, palms at oases, thin savanna and marsh trees. */
export function ecologyTreeGrid(input: TreeGridInput): {
  pixels: Uint8Array;
  width: number;
  height: number;
  nonZero: number;
} {
  const { ecology, sampler, kind } = input;
  const mapWidth = sampler.width;
  const mapHeight = sampler.height;
  const width = Math.round((mapWidth * 75) / 256);
  const height = Math.round((mapHeight * 75) / 256);
  const index = { ...DEFAULT_TREE_INDICES, ...input.trees };
  const pixels = new Uint8Array(width * height);
  let nonZero = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(mapWidth - 1, Math.floor(((x + 0.5) * mapWidth) / width));
      const sy = Math.min(mapHeight - 1, Math.floor(((y + 0.5) * mapHeight) / height));
      if (kind[sy * mapWidth + sx] !== LAND) continue;
      const cell = sampler.cellOf(sx, sy);
      const cover = ecology.cover[cell]!;
      const density = ecology.density[cell]! / 255;
      const u = lattice(input.seed + 32452843, x, y);
      const v = lattice(input.seed + 32452847, x, y);
      let value = 0;
      if (cover === COVER.forest) {
        if (u < Math.min(1, 0.25 + 0.85 * density))
          value = v < density ? index.forestDense : index.forestSparse;
      } else if (cover === COVER.jungle) {
        if (u < Math.min(1, 0.3 + 0.65 * density))
          value = v < density ? index.jungleDense : index.jungleSparse;
      } else if (cover === COVER.marsh) {
        if (u < 0.12) value = index.forestSparse;
      } else if (cover === COVER.desert) {
        // Palms stand at oases and along warm rivers and lakes.
        const water =
          Math.max(ecology.riverProximity[cell]!, ecology.lakeProximity[cell]!) / 255;
        if (ecology.temperature[cell]! >= 18 && water > 0.35 && u < 0.5 * water)
          value = water > 0.7 ? index.palmDense : index.palmSparse;
      } else if (cover === COVER.tundra) {
        if (u < 0.02) value = index.forestSparse;
      } else if (cover !== COVER.ice) {
        // Plains, farmland and steppe: thin trees on wet warm ground, hedgerows on farmland.
        const chance = density;
        if (chance > 0 && u < chance) value = index.forestSparse;
      }
      if (value !== 0 && ecology.relief[cell] === RELIEF.mountain && u > 0.3) value = 0;
      if (value !== 0) {
        pixels[y * width + x] = value;
        nonZero += 1;
      }
    }
  return { pixels, width, height, nonZero };
}
