/**
 * The typed interface between terrain synthesis and the stages that read its fields: the
 * feature-aware partition (C9), the border-naturalness metric (C10), climate and biome (C8) and the
 * composite renders (C14). Every field is a plain typed array with its grid size, so a consumer needs
 * no knowledge of how it was made (ADR 0056).
 */

/** A raster over the map: `scale` map pixels per cell on each axis (1 for full size, 2 for half). */
export interface FieldRaster<T extends Uint8Array | Uint16Array | Float32Array> {
  readonly width: number;
  readonly height: number;
  readonly scale: 1 | 2;
  readonly data: T;
}

/** What makes a pixel a barrier; the flags combine in `BarrierField.sources`. */
export const BARRIER_RIVER = 1;
export const BARRIER_CREST = 2;
export const BARRIER_STEEP = 4;
export const BARRIER_LAKE_SHORE = 8;
/** A range declared `barrier: 'impassable'`, outside its pass gaps. */
export const BARRIER_WALL = 16;
/** A range declared `barrier: 'fort-line'`, outside its pass gaps. */
export const BARRIER_FORT_LINE = 32;

/**
 * Where a border should prefer to run. `strength` is 0 to 255 (rivers by width 100 to 212, steep
 * ground 60 to 200, crests 150, lake shores 90, walls 255, fort lines 180); `sources` holds the
 * flags of everything that contributed. Both are full size.
 */
export interface BarrierField {
  readonly width: number;
  readonly height: number;
  readonly strength: Uint8Array;
  readonly sources: Uint8Array;
}

/**
 * Valleys and floodplains the rivers carved, at half size: 0 where nothing was carved, 255 for a
 * cut of 25 height units or more. Fertility and settlement read it: river plains are flat and wet.
 */
export type ValleyField = FieldRaster<Uint8Array>;

/** Distance in map pixels to the nearest range crest, clipped at 255, at half size. */
export type CrestDistanceField = FieldRaster<Uint8Array>;

/** How much of a pixel belongs to mountains, 0 to 255, at half size (0 on plains and water). */
export type MountainField = FieldRaster<Uint8Array>;

export interface TerrainFields {
  readonly barrier: BarrierField;
  readonly valley: ValleyField;
  readonly crestDistance: CrestDistanceField;
  readonly mountain: MountainField;
}

/** One named or unnamed river as written, for reports and for stages that need river topology. */
export interface RiverReportEntry {
  readonly id: string;
  readonly name?: string;
  readonly named: boolean;
  readonly pixels: number;
  /** Straight-line to path length: 1 is a straight river. */
  readonly sinuosity: number;
  readonly mouth: 'sea' | 'lake' | 'edge' | 'river';
  /** The river this one joins or branches from. */
  readonly parent?: string;
  readonly junction: 'none' | 'tributary' | 'distributary';
  /** Widest index (3 to 11) and the highest tributary order. */
  readonly width: number;
  readonly order: number;
  /** False when the river could not be routed to its end at full resolution. */
  readonly complete: boolean;
}

export interface ReliefStatistics {
  readonly landPixels: number;
  readonly median: number;
  readonly p99: number;
  readonly maximum: number;
  /** Mean absolute central height step over land, per half-resolution pixel (vanilla: 0.97). */
  readonly meanStep: number;
}

export interface RiverStatistics {
  readonly pixels: number;
  /** Share of land pixels. */
  readonly landShare: number;
  readonly count: number;
  /** Rivers the model names, not counting their distributaries. */
  readonly named: number;
  /** Distributary channels of named deltas. */
  readonly distributaries: number;
  /** Rivers of the accumulation network. */
  readonly streams: number;
  /** Share of river pixels on straight 41-pixel stretches (the base game: 0.011). */
  readonly straightShare: number;
}
