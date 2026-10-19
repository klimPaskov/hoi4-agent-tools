import {
  PARTITION_KIND,
  PARTITION_TERRAIN,
  partitionFieldsFromBitmaps,
  type PartitionFields,
} from './partition-fields.js';
import {
  PARTITION_PROVINCE_ERROR,
  PARTITION_PROVINCE_WARNING,
  type PartitionTuning,
} from './partition-tuning.js';
import type { PartitionMode } from './partition.js';

/**
 * The generator's side of the partition (ADR 0058): what `create_world` hands the partition when
 * a request asks for it, and the province-count guard both partitions share. Domain logic lives in
 * `partition*.ts`; this file only adapts the generator's rasters to the partition's fields.
 */

/** Opt-in partition request carried by the world spec. Absent means the legacy partition. */
export interface WorldPartitionSpec {
  mode: PartitionMode;
  tuning?: PartitionTuning;
  /** Fields from the relief, hydrology and geography stages; computed from the surface if absent. */
  fields?: PartitionFields;
}

/** Terrain class of each reference terrain code (`referenceTerrainNames` in `world.ts`). */
const REFERENCE_CLASSES: readonly number[] = [
  PARTITION_TERRAIN.plains,
  PARTITION_TERRAIN.forest,
  PARTITION_TERRAIN.desert,
  PARTITION_TERRAIN.mountain,
  PARTITION_TERRAIN.snow,
  PARTITION_TERRAIN.mountain,
  PARTITION_TERRAIN.hills,
  PARTITION_TERRAIN.marsh,
  PARTITION_TERRAIN.jungle,
];

export interface SurfacePartitionInput {
  width: number;
  height: number;
  /** 0 = sea, 1 = land, 2 = lake. */
  kind: Uint8Array;
  /** Land in [0, 1], water in [-1, 0]. */
  elevation: Float32Array;
  moisture: Float32Array;
  /** `rivers.bmp` indices: 0 to 11 river, 254 water, 255 land. */
  riverPixels: Uint8Array;
  /** Reference terrain codes, when a picture supplied them. */
  referenceTerrain?: Uint8Array;
}

/** Value below which a share of the land lies, from a coarse histogram (no sort of 13 million). */
function landQuantiles(input: SurfacePartitionInput, shares: readonly number[]): number[] {
  const bins = 2048;
  const histogram = new Uint32Array(bins);
  let land = 0;
  for (let p = 0; p < input.kind.length; p++) {
    if (input.kind[p] !== PARTITION_KIND.land) continue;
    const value = Math.min(1, Math.max(0, input.elevation[p]!));
    histogram[Math.min(bins - 1, Math.floor(value * bins))]!++;
    land++;
  }
  return shares.map((share) => {
    let seen = 0;
    for (let bin = 0; bin < bins; bin++) {
      seen += histogram[bin]!;
      if (seen >= share * land) return (bin + 1) / bins;
    }
    return 1;
  });
}

/**
 * Partition fields from the generator's own rasters: heights as `heightmap.bmp` will hold them,
 * the drainage rivers, and a per-pixel terrain class (the reference picture's when there is one,
 * otherwise elevation and moisture rules like the province terrain rules).
 */
export function surfacePartitionFields(input: SurfacePartitionInput): PartitionFields {
  const { width, height, kind, elevation, moisture } = input;
  const total = width * height;
  const heights = new Uint8Array(total);
  const terrain = new Uint8Array(total).fill(PARTITION_TERRAIN.water);
  const wet = new Uint8Array(total);
  const [hillLevel = 1, mountainLevel = 1] =
    input.referenceTerrain === undefined ? landQuantiles(input, [0.72, 0.88]) : [1, 1];
  for (let p = 0; p < total; p++) {
    wet[p] = Math.round(Math.min(1, Math.max(0, moisture[p]!)) * 255);
    if (kind[p] !== PARTITION_KIND.land) {
      heights[p] = 89;
      continue;
    }
    const value = elevation[p]!;
    heights[p] = Math.min(255, Math.max(96, Math.round(96 + value * 110)));
    if (input.referenceTerrain !== undefined) {
      terrain[p] = REFERENCE_CLASSES[input.referenceTerrain[p]!] ?? PARTITION_TERRAIN.plains;
      continue;
    }
    const y = Math.floor(p / width);
    const latitude = Math.abs(y / height - 0.5) * 2;
    const m = moisture[p]!;
    terrain[p] =
      value >= mountainLevel
        ? PARTITION_TERRAIN.mountain
        : value >= hillLevel
          ? PARTITION_TERRAIN.hills
          : latitude < 0.3 && m > 0.55
            ? PARTITION_TERRAIN.jungle
            : latitude > 0.25 && latitude < 0.55 && m < 0.42
              ? PARTITION_TERRAIN.desert
              : m > 0.62
                ? PARTITION_TERRAIN.marsh
                : m > 0.5
                  ? PARTITION_TERRAIN.forest
                  : PARTITION_TERRAIN.plains;
  }
  const identity = Uint8Array.from({ length: 256 }, (_, index) => index);
  return partitionFieldsFromBitmaps({
    width,
    height,
    kind,
    heights,
    rivers: input.riverPixels,
    terrain,
    terrainClasses: identity,
    moisture: wet,
  });
}

/** A province-count note for the legacy partition and the final check of the feature-aware one. */
export function provinceCountNote(
  provinces: number,
  mode: PartitionMode,
):
  | { code: string; severity: 'warning'; message: string; details: Record<string, unknown> }
  | undefined {
  if (provinces <= PARTITION_PROVINCE_WARNING) return undefined;
  return {
    code: 'MAP_PARTITION_PROVINCE_COUNT_HIGH',
    severity: 'warning',
    message: `The world has ${provinces} provinces. Vanilla has about 13,400 and the wiki advises at most about 21,000; the text tables (definitions, positions, buildings) near 16 MiB each stop loading beyond that. Raise landProvincePixels and seaProvincePixels to reduce the count`,
    details: {
      provinces,
      warningAbove: PARTITION_PROVINCE_WARNING,
      errorAbove: PARTITION_PROVINCE_ERROR,
      mode,
    },
  };
}
