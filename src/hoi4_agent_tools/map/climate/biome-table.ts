/**
 * The biome table (ADR 0057): which ground covers exist, what province terrain, partition class,
 * graphical terrain indices, tree classes and colour class each one maps to. Everything a look
 * decision depends on is data in this file, versioned by `BIOME_TABLE_VERSION`, so a change to a
 * mapping is a change to a table and a changelog entry, not a hunt through the generator.
 */
import type { GeographyBiomeKind } from '../../schemas/geography.js';
import { PARTITION_TERRAIN } from '../partition-fields.js';
import type { ColourClass } from '../colormap.js';

export const BIOME_TABLE_VERSION = 1;

/** Ground cover of a flat or hilly cell; relief (hills, mountain) is a separate plane. */
export const COVER = {
  plains: 0,
  farmland: 1,
  steppe: 2,
  forest: 3,
  jungle: 4,
  desert: 5,
  marsh: 6,
  tundra: 7,
  ice: 8,
} as const;
export type CoverName = keyof typeof COVER;
export const COVER_NAMES = Object.keys(COVER) as CoverName[];
export const COVER_COUNT = COVER_NAMES.length;
/** Marks water cells in the cover plane. */
export const NO_COVER = 255;

export const RELIEF = { flat: 0, hills: 1, mountain: 2 } as const;

/** Province terrain names (the `terrain` column of `definition.csv`) the generator writes. */
export type ProvinceTerrain =
  | 'plains'
  | 'forest'
  | 'hills'
  | 'mountain'
  | 'desert'
  | 'marsh'
  | 'jungle';

export interface CoverDefinition {
  /** Province terrain of a province this cover dominates. */
  readonly terrain: ProvinceTerrain;
  /** Terrain class the feature-aware partition reads. */
  readonly partitionClass: number;
  /** Class of the region terrain share this cover counts toward. */
  readonly shareGroup: ShareGroup;
  readonly colour: ColourClass;
  /** Base fertility of the cover before moisture, temperature, slope and valleys. */
  readonly fertility: number;
}

/** The terrain shares a region can declare, and the cover groups that can meet them. */
export type ShareGroup = 'plains' | 'forest' | 'desert' | 'marsh' | 'jungle' | 'snow';
export const SHARE_GROUPS: readonly ShareGroup[] = [
  'plains',
  'forest',
  'desert',
  'marsh',
  'jungle',
  'snow',
];

export const COVER_TABLE: Readonly<Record<CoverName, CoverDefinition>> = {
  plains: {
    terrain: 'plains',
    partitionClass: PARTITION_TERRAIN.plains,
    shareGroup: 'plains',
    colour: 'plains',
    fertility: 0.7,
  },
  farmland: {
    terrain: 'plains',
    partitionClass: PARTITION_TERRAIN.farmland,
    shareGroup: 'plains',
    colour: 'farmland',
    fertility: 0.9,
  },
  steppe: {
    terrain: 'plains',
    partitionClass: PARTITION_TERRAIN.plains,
    shareGroup: 'plains',
    colour: 'steppe',
    fertility: 0.42,
  },
  forest: {
    terrain: 'forest',
    partitionClass: PARTITION_TERRAIN.forest,
    shareGroup: 'forest',
    colour: 'forest',
    fertility: 0.5,
  },
  jungle: {
    terrain: 'jungle',
    partitionClass: PARTITION_TERRAIN.jungle,
    shareGroup: 'jungle',
    colour: 'jungle',
    fertility: 0.38,
  },
  desert: {
    terrain: 'desert',
    partitionClass: PARTITION_TERRAIN.desert,
    shareGroup: 'desert',
    colour: 'desert',
    fertility: 0.05,
  },
  marsh: {
    terrain: 'marsh',
    partitionClass: PARTITION_TERRAIN.marsh,
    shareGroup: 'marsh',
    colour: 'marsh',
    fertility: 0.28,
  },
  tundra: {
    terrain: 'plains',
    partitionClass: PARTITION_TERRAIN.plains,
    shareGroup: 'plains',
    colour: 'tundra',
    fertility: 0.1,
  },
  ice: {
    terrain: 'plains',
    partitionClass: PARTITION_TERRAIN.snow,
    shareGroup: 'snow',
    colour: 'snow',
    fertility: 0,
  },
};

/** The cover each group is made of, in score order. */
export const GROUP_COVERS: Readonly<Record<ShareGroup, readonly number[]>> = {
  plains: [COVER.plains, COVER.steppe, COVER.tundra, COVER.farmland],
  forest: [COVER.forest],
  desert: [COVER.desert],
  marsh: [COVER.marsh],
  jungle: [COVER.jungle],
  snow: [COVER.ice],
};

/** What a declared biome kind sets: a cover, or the hills relief. */
export const DECLARED_BIOME: Readonly<
  Record<GeographyBiomeKind, { cover: number } | { relief: number }>
> = {
  forest: { cover: COVER.forest },
  desert: { cover: COVER.desert },
  marsh: { cover: COVER.marsh },
  ice: { cover: COVER.ice },
  plains: { cover: COVER.plains },
  farmland: { cover: COVER.farmland },
  jungle: { cover: COVER.jungle },
  steppe: { cover: COVER.steppe },
  tundra: { cover: COVER.tundra },
  hills: { relief: RELIEF.hills },
};

/** Share names the model may declare per region, and where each is counted. */
export const REGION_SHARE_NAMES = [
  'plains',
  'forest',
  'hills',
  'mountain',
  'desert',
  'marsh',
  'jungle',
  'urban',
  'snow',
] as const;
export type RegionShareName = (typeof REGION_SHARE_NAMES)[number];

/** Final terrain classes of the partition: the class code of a cover and relief pair. */
export function partitionClassOf(cover: number, relief: number): number {
  if (relief === RELIEF.mountain) return PARTITION_TERRAIN.mountain;
  if (relief === RELIEF.hills) return PARTITION_TERRAIN.hills;
  const name = COVER_NAMES[cover];
  return name === undefined ? PARTITION_TERRAIN.plains : COVER_TABLE[name].partitionClass;
}

/** Province terrain name of a partition class (urban and snow need a decision of their own). */
export function terrainNameOfClass(partitionClass: number): ProvinceTerrain {
  switch (partitionClass) {
    case PARTITION_TERRAIN.forest:
      return 'forest';
    case PARTITION_TERRAIN.hills:
      return 'hills';
    case PARTITION_TERRAIN.mountain:
      return 'mountain';
    case PARTITION_TERRAIN.desert:
      return 'desert';
    case PARTITION_TERRAIN.marsh:
      return 'marsh';
    case PARTITION_TERRAIN.jungle:
      return 'jungle';
    default:
      return 'plains';
  }
}
