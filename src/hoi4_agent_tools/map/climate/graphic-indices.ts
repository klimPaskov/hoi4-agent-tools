/**
 * The graphical terrain indices (`terrain.bmp` palette entries) a world can use, resolved against
 * the active `common/terrain` files (ADR 0057). The base game's numbering is the default; an index
 * is only used when the active terrain files still give it the category the look needs and draw a
 * tile for it (`texture != 255`). Anything missing falls back to the category's representative
 * index and is reported once as `MAP_BIOME_UNMAPPED`.
 */
import type { WorldContext } from '../world.js';

export const DEFAULT_TERRAIN_INDEX: ReadonlyMap<string, number> = new Map([
  ['plains', 0],
  ['forest', 1],
  ['hills', 17],
  ['desert', 3],
  ['mountain', 6],
  ['marsh', 9],
  ['urban', 13],
  ['lakes', 15],
  ['ocean', 15],
  ['jungle', 21],
]);

/**
 * A graphical terrain index of the base game's numbering, used only when the active terrain
 * files confirm that index still has that category and draws a tile. Without any terrain files
 * the base game's numbering is assumed.
 */
export function terrainVariant(
  context: Pick<WorldContext, 'terrainEntries' | 'terrainIndex'>,
  index: number,
  type: string,
  allowPermanentSnow = false,
): number | undefined {
  const entries = context.terrainEntries;
  if (entries === undefined) return context.terrainIndex === undefined ? index : undefined;
  return entries.some(
    (entry) =>
      entry.index === index &&
      entry.type === type &&
      entry.texture !== 255 &&
      (allowPermanentSnow || !entry.permSnow),
  )
    ? index
    : undefined;
}

/** The indices the look chooses from, by role. */
export interface GraphicIndices {
  readonly plains: number;
  readonly farmland: number;
  readonly steppe: number;
  readonly forestDense: number;
  readonly forestSparse: number;
  readonly jungleDense: number;
  readonly jungleSparse: number;
  readonly desertDunes: number;
  readonly desertFlat: number;
  readonly desertRock: number;
  readonly marsh: number;
  readonly hills: number;
  readonly desertHills: number;
  readonly desertRidge: number;
  readonly mountain: number;
  readonly mountainAlt: number;
  readonly mountainSand: number;
  readonly mountainGrass: number;
  readonly mountainTops: number;
  readonly snowPlains: number;
  readonly snowMountain: number;
  readonly urban: number;
  readonly lake: number;
  readonly ocean: number;
  /** Cover names whose category the active terrain files do not define. */
  readonly unmapped: readonly string[];
}

/** Resolve every index the biome look uses against the context's terrain files. */
export function resolveGraphicIndices(
  context: Pick<WorldContext, 'terrainEntries' | 'terrainIndex'>,
): GraphicIndices {
  const representative = (type: string): number =>
    context.terrainIndex?.get(type) ?? DEFAULT_TERRAIN_INDEX.get(type) ?? 0;
  const unmapped = new Set<string>();
  const known = (type: string): boolean =>
    context.terrainIndex === undefined || context.terrainIndex.has(type);
  for (const type of ['plains', 'forest', 'jungle', 'desert', 'marsh', 'hills', 'mountain'])
    if (!known(type)) unmapped.add(type);
  const pick = (index: number, type: string): number =>
    terrainVariant(context, index, type) ?? representative(type);
  const urban = context.terrainIndex?.get('urban') ?? DEFAULT_TERRAIN_INDEX.get('urban')!;
  const lake =
    context.terrainIndex?.get('lakes') ?? context.terrainIndex?.get('ocean') ?? 15;
  return {
    plains: pick(0, 'plains'),
    farmland: pick(5, 'plains'),
    steppe: pick(12, 'desert'),
    forestDense: pick(1, 'forest'),
    forestSparse: pick(4, 'forest'),
    jungleDense: pick(21, 'jungle'),
    jungleSparse: pick(22, 'jungle'),
    desertDunes: pick(3, 'desert'),
    desertFlat: pick(7, 'desert'),
    desertRock: pick(12, 'desert'),
    marsh: pick(9, 'marsh'),
    hills: pick(17, 'hills'),
    desertHills: pick(8, 'desert'),
    desertRidge: pick(2, 'hills'),
    mountain: pick(6, 'mountain'),
    mountainAlt: pick(10, 'mountain'),
    mountainSand: pick(18, 'mountain'),
    mountainGrass: pick(20, 'mountain'),
    mountainTops: pick(31, 'mountain'),
    snowPlains: terrainVariant(context, 19, 'plains', true) ?? pick(0, 'plains'),
    snowMountain: terrainVariant(context, 16, 'mountain', true) ?? pick(6, 'mountain'),
    urban,
    lake,
    ocean: context.terrainIndex?.get('ocean') ?? 15,
    unmapped: [...unmapped].sort(),
  };
}
