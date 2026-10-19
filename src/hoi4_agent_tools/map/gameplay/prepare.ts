/**
 * The geography-driven gameplay layer of a generated world (ADR 0062, 0063): the first stage reads
 * the finished province raster, derives the shared facts and plans the adjacency rows and rules.
 * The second stage (ports, development, names, railways) runs once states and ownership exist.
 */
import type { ResolvedGeography } from '../geography/index.js';
import type { TerrainFields } from '../relief/fields.js';
import type { WorldProvinces } from '../world-provinces.js';
import { planCrossings, type CrossingNote, type CrossingPlan } from './crossings.js';
import {
  buildBorderTable,
  provinceFeatures,
  provinceViewOf,
  type BorderStat,
  type ProvinceFeatures,
  type ProvinceRasterView,
} from './facts.js';

export interface PrepareInput {
  width: number;
  height: number;
  geography: ResolvedGeography;
  provinces: WorldProvinces;
  /** `heightmap.bmp` values. */
  heights: Uint8Array;
  /** `rivers.bmp` indices. */
  riverBitmap: Uint8Array;
  fields?: TerrainFields | undefined;
  /** Pixel paths of the rivers, for naming the land they run through. */
  riverPaths?: ReadonlyArray<{ id: string; pixels: Int32Array }> | undefined;
  autoStraits?: { maxGapPx: number } | undefined;
  /** Indices of `geography.lakes` that were written as inland seas. */
  inlandSeas: readonly number[];
  impassableLimit?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface GameplayBase {
  readonly input: PrepareInput;
  readonly view: ProvinceRasterView;
  readonly features: ProvinceFeatures;
  readonly borders: ReadonlyMap<number, BorderStat>;
  readonly crossings: CrossingPlan;
  readonly notes: CrossingNote[];
}

export function prepareGameplay(input: PrepareInput): GameplayBase {
  const view = provinceViewOf(input.provinces, input.width, input.height);
  const features = provinceFeatures({
    geography: input.geography,
    view,
    kind: input.provinces.kind,
  });
  const borders = buildBorderTable({ view, heights: input.heights, rivers: input.riverBitmap });
  const crossings = planCrossings({
    width: input.width,
    height: input.height,
    geography: input.geography,
    view,
    kind: input.provinces.kind,
    neighbors: input.provinces.neighbors,
    center: input.provinces,
    features,
    borders,
    autoStraits: input.autoStraits,
    inlandSeas: input.inlandSeas,
    impassableLimit: input.impassableLimit,
    signal: input.signal,
  });
  return { input, view, features, borders, crossings, notes: [...crossings.notes] };
}
