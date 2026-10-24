/**
 * Mean colours of the terrain atlas tiles (ADR 0057). The colour map solver needs the mean colour
 * of the atlas tile each graphical terrain index draws, because the terrain shader overlays the
 * colour map on that tile (`pdxmap.shader:317`). The means are read at run time from the
 * installed `map/terrain/atlas0.dds`; nothing of the atlas is copied or written. Without the
 * installed atlas the sixteen measured means below (game version 1.19.3.0) are used, and the
 * result says so.
 */
import { RenderBudget } from '../core/render-budget.js';
import { decodeDds } from '../gui/dds.js';

export type TileMean = readonly [number, number, number];

/** Mean RGB of the sixteen 512 x 512 tiles of the base game's `atlas0.dds`, row by row. */
export const BUNDLED_ATLAS_TILE_MEANS: readonly TileMean[] = [
  [133.1, 141.5, 107],
  [151.7, 156.4, 120.6],
  [140.8, 142, 115.3],
  [138.2, 137.6, 114.6],
  [78.5, 97.1, 86.3],
  [106.2, 127.5, 108.1],
  [128.1, 150.8, 143.6],
  [131.1, 136.7, 116.7],
  [163.5, 165.7, 128.8],
  [187.4, 181, 133.6],
  [132.8, 119.9, 104.6],
  [122.4, 115, 109.8],
  [196.2, 186.5, 136.6],
  [174.4, 161.9, 122.8],
  [154.1, 134.1, 110.1],
  [109.3, 98.7, 82.7],
];

/**
 * The atlas tile each graphical terrain index of the base game draws (`texture = n` in
 * `common/terrain/00_terrain.txt`). Used when the active terrain files are not available.
 */
export const BASE_TERRAIN_TILES: Readonly<Record<number, number>> = {
  0: 1,
  1: 4,
  2: 3,
  3: 9,
  4: 5,
  5: 0,
  6: 11,
  7: 12,
  8: 14,
  9: 6,
  10: 13,
  11: 11,
  12: 8,
  13: 10,
  15: 9,
  16: 11,
  17: 2,
  18: 7,
  19: 0,
  20: 7,
  21: 4,
  22: 5,
  27: 7,
  31: 15,
};

export const ATLAS_TILE_COUNT = 16;

/** Tile mean colours with the provenance of the numbers. */
export interface AtlasTiles {
  readonly means: readonly TileMean[];
  readonly source: 'installed-atlas' | 'bundled-table';
  /** Why the installed atlas was not used, when `source` is the bundled table. */
  readonly reason?: string;
}

export const BUNDLED_ATLAS: AtlasTiles = {
  means: BUNDLED_ATLAS_TILE_MEANS,
  source: 'bundled-table',
  reason: 'The installed atlas is not part of the active sources',
};

/**
 * Mean colour of every tile of a 4 x 4 atlas, from the first mip level of a DDS file. Returns the
 * bundled table, with the reason, when the file cannot be decoded as a square 4 x 4 atlas.
 */
export function atlasTilesFromDds(bytes: Buffer): AtlasTiles {
  let decoded;
  try {
    decoded = decodeDds(bytes, new RenderBudget());
  } catch {
    return { ...BUNDLED_ATLAS, reason: 'The atlas is too large to decode within the render budget' };
  }
  if ('unsupported' in decoded)
    return { ...BUNDLED_ATLAS, reason: `The atlas format is not supported (${decoded.format})` };
  const { width, height, data } = decoded;
  if (width !== height || width % 4 !== 0 || width < 4)
    return { ...BUNDLED_ATLAS, reason: 'The atlas is not a square 4 x 4 grid of tiles' };
  const tile = width / 4;
  const means: TileMean[] = [];
  for (let index = 0; index < ATLAS_TILE_COUNT; index += 1) {
    const x0 = (index % 4) * tile;
    const y0 = Math.floor(index / 4) * tile;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let y = 0; y < tile; y += 1) {
      let offset = ((y0 + y) * width + x0) * 4;
      for (let x = 0; x < tile; x += 1) {
        r += data[offset]!;
        g += data[offset + 1]!;
        b += data[offset + 2]!;
        offset += 4;
      }
    }
    const count = tile * tile;
    means.push([
      Math.round((r / count) * 10) / 10,
      Math.round((g / count) * 10) / 10,
      Math.round((b / count) * 10) / 10,
    ]);
  }
  return { means, source: 'installed-atlas' };
}

/**
 * Tile of each of the 256 graphical terrain indices: from the active terrain entries when they
 * are known (an entry with `texture = 255` or no texture draws no tile), otherwise the base
 * game's numbering. An index no entry defines uses tile 1 (plains).
 */
export function terrainTileTable(
  entries:
    | ReadonlyArray<{ index: number; texture?: number | undefined }>
    | undefined,
): Uint8Array {
  const table = new Uint8Array(256).fill(1);
  if (entries === undefined) {
    for (const [index, tile] of Object.entries(BASE_TERRAIN_TILES)) table[Number(index)] = tile;
    return table;
  }
  for (const entry of entries)
    if (
      entry.index >= 0 &&
      entry.index < 256 &&
      entry.texture !== undefined &&
      entry.texture >= 0 &&
      entry.texture < ATLAS_TILE_COUNT
    )
      table[entry.index] = entry.texture;
  return table;
}
