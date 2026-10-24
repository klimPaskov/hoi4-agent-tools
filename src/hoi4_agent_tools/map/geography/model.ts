import type {
  GeographyBiomeKind,
  GeographyDepthClass,
  GeographyPlaceKind,
  GeographySiteKind,
} from '../../schemas/geography.js';
import { boundsContain, pointSegment, ringContains, type Bounds } from './geometry.js';

/**
 * The resolved geography model: the in-memory contract that relief, hydrology, climate, partition
 * and naming stages build on. It is immutable, sorted by id, free of defaults left to guess
 * (every optional input has a documented value here), and independent of the request that made it.
 * Coordinates are normalised frame coordinates (0..1, origin top-left); lengths are fractions of
 * the map width; heights are 0..1 of the relief scale. `GeographyFrame` carries the pixel size so
 * consumers can rasterise with `./raster.js` without re-deriving any aspect ratio.
 */

export interface GeographyFrame {
  /** Pixels. */
  readonly width: number;
  readonly height: number;
}

export type GeographyFeatureKind =
  | 'sea'
  | 'land'
  | 'region'
  | 'range'
  | 'pass'
  | 'volcano'
  | 'plateau'
  | 'river'
  | 'lake'
  | 'biome'
  | 'strait'
  | 'site'
  | 'road'
  | 'place';

/** Fixed order of kinds wherever features are listed together. */
export const GEOGRAPHY_FEATURE_KINDS: readonly GeographyFeatureKind[] = [
  'sea',
  'land',
  'region',
  'range',
  'pass',
  'volcano',
  'plateau',
  'river',
  'lake',
  'biome',
  'strait',
  'site',
  'road',
  'place',
];

export interface GeoPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A closed ring; the closing edge from the last vertex to the first is implied. Resolution
 * orients outer rings so their shoelace sum is positive and holes so it is negative, whatever
 * order the input listed them in.
 */
export interface ResolvedRing {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly bounds: Bounds;
  /** Frame-unit area, positive for outer rings and negative for holes. */
  readonly signedArea: number;
}

/** Union of `outers` minus `holes`; even-odd filling over all rings gives the same result. */
export interface ResolvedArea {
  readonly outers: readonly ResolvedRing[];
  readonly holes: readonly ResolvedRing[];
  readonly bounds: Bounds;
  /** Fraction of the whole frame covered (0..1). */
  readonly areaFraction: number;
  /** A point inside the area, stable for labels, containment tests and river anchors. */
  readonly interior: GeoPoint;
}

/** A polyline with per-vertex half-width and crest height and an arc-length table. */
export interface ResolvedPolyline {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Fractions of the map width. */
  readonly halfWidth: Float64Array;
  /** 0..1 of the relief scale. */
  readonly peak: Float64Array;
  readonly closed: boolean;
  readonly bounds: Bounds;
  /**
   * Cumulative length at every vertex in map-width units (x counts 1, y counts height/width), so
   * one unit equals the whole map width. A closed path has one extra entry for the closing edge.
   */
  readonly arc: Float64Array;
  /** Total length in map-width units. */
  readonly length: number;
}

interface FeatureBase<K extends GeographyFeatureKind> {
  readonly id: string;
  readonly kind: K;
  readonly name?: string;
  readonly tags: readonly string[];
  readonly note?: string;
}

export interface ResolvedSea extends FeatureBase<'sea'> {
  readonly area: ResolvedArea;
  readonly depthClass: GeographyDepthClass;
  readonly ice: number;
  readonly seaKind: 'ocean' | 'sea' | 'gulf' | 'fjord';
}

export interface ResolvedLand extends FeatureBase<'land'> {
  readonly area: ResolvedArea;
  readonly landKind?: 'continent' | 'island' | 'archipelago' | 'peninsula';
  /** The declared region, else the region whose area contains this land's interior point. */
  readonly regionId?: string;
  readonly regionSource?: 'explicit' | 'containment';
  readonly biome?: GeographyBiomeKind;
  readonly fertility?: number;
  readonly elevationBase: number;
  readonly coastDetail: number;
}

export interface ResolvedRegion extends FeatureBase<'region'> {
  readonly area?: ResolvedArea;
  /** Ids of lands that declare or are contained in this region, sorted. */
  readonly landIds: readonly string[];
  /** Target terrain shares as declared (absent shares are not listed). */
  readonly terrain?: Readonly<Record<string, number>>;
  /** Typical `[smallest, usual, largest]` provinces per state and province size in pixels. */
  readonly provincesPerState?: readonly [number, number, number];
  readonly provinceAreaPx?: number;
  /** Palette index of the city group drawn over this region's land (cities.bmp). */
  readonly cityStyle?: number;
}

export interface ResolvedRange extends FeatureBase<'range'> {
  readonly path: ResolvedPolyline;
  readonly profile: 'ridge' | 'massif' | 'escarpment' | 'wall';
  readonly asymmetry: number;
  readonly snowline?: number;
  readonly spurs: number;
  readonly barrier: 'none' | 'impassable' | 'fort-line';
  /** Ids of the passes through this range, ordered by position along it. */
  readonly passIds: readonly string[];
}

export interface ResolvedPass extends FeatureBase<'pass'> {
  readonly rangeId: string;
  /** Position along the range by arc length, 0 to 1. */
  readonly at: number;
  /** Fraction of the map width. */
  readonly width: number;
  /** Saddle depth, 0 (no dip) to 1 (down to the surrounding ground). */
  readonly depth: number;
  readonly fort: number;
  /** The point on the range path at `at`. */
  readonly position: GeoPoint;
  /** `range-fraction` when the input gave `range` and `at`, `point` when it gave a position. */
  readonly positionSource: 'range-fraction' | 'point';
  /** Distance from the given position to the range path, in map-width units (0 for a fraction). */
  readonly offset: number;
}

export interface ResolvedVolcano extends FeatureBase<'volcano'> {
  readonly at: GeoPoint;
  readonly radius: number;
  readonly peak: number;
  readonly crater: number;
  readonly active: boolean;
  readonly landId?: string;
}

export interface ResolvedPlateau extends FeatureBase<'plateau'> {
  readonly area: ResolvedArea;
  readonly height: number;
  readonly edge: 'cliff' | 'ramp';
}

export type ResolvedRiverEnd =
  | { readonly type: 'point'; readonly x: number; readonly y: number }
  | { readonly type: 'lake'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'sea'; readonly id: string }
  | { readonly type: 'river'; readonly id: string };

export interface ResolvedRiver extends FeatureBase<'river'> {
  readonly source: ResolvedRiverEnd;
  readonly mouth: ResolvedRiverEnd;
  readonly via: readonly GeoPoint[];
  readonly size: number;
  readonly delta: boolean;
  /** Ids of rivers whose mouth is this river, sorted. */
  readonly tributaryIds: readonly string[];
  /** Straight-line length through the known anchors, in map-width units. */
  readonly anchorLength: number;
}

export interface ResolvedLake extends FeatureBase<'lake'> {
  readonly area: ResolvedArea;
  readonly shape: 'polygon' | 'disc';
  readonly depthClass: GeographyDepthClass;
  readonly outflowId?: string;
  readonly gameplay: 'lake' | 'inland-sea';
  readonly landId?: string;
}

export interface ResolvedBiome extends FeatureBase<'biome'> {
  readonly area: ResolvedArea;
  readonly biome: GeographyBiomeKind;
  readonly density: number;
  readonly fertility?: number;
  /** Higher wins where polygons overlap; ties between different biomes are an error. */
  readonly z: number;
}

export type ResolvedStraitEnd =
  | { readonly type: 'point'; readonly x: number; readonly y: number; readonly landId?: string }
  | { readonly type: 'land'; readonly id: string };

export interface ResolvedStrait extends FeatureBase<'strait'> {
  readonly between: readonly [ResolvedStraitEnd, ResolvedStraitEnd];
  /** `declared` when the input named the ends, `derived` when they are the lands nearest the path ends. */
  readonly ends: 'declared' | 'derived';
  /** The channel centre line through the water, when the input gave one. */
  readonly path?: readonly GeoPoint[];
  readonly rule: 'open' | 'army-closed' | 'navy-closed';
  readonly width: number;
}

export interface ResolvedSite extends FeatureBase<'site'> {
  readonly siteKind: GeographySiteKind;
  readonly at: GeoPoint;
  readonly importance: number;
  readonly country?: string;
  readonly onWater: boolean;
  readonly landId?: string;
  readonly regionId?: string;
  readonly lakeId?: string;
}

export interface ResolvedRoad extends FeatureBase<'road'> {
  readonly path: ResolvedPolyline;
  readonly importance: number;
}

export interface ResolvedPlace extends FeatureBase<'place'> {
  readonly placeKind: GeographyPlaceKind;
  readonly at: GeoPoint;
  /** What the model says is under the point. */
  readonly surface: ResolvedSurface['surface'];
}

export interface ResolvedClimate {
  /** Compass bearing the prevailing wind blows from. */
  readonly windFrom: number;
  readonly temperature: { readonly warm: number; readonly cold: number };
  readonly warmBandY: number;
  readonly rainScale: number;
  readonly seasonality: number;
  /** True when the model sets any climate field; false means every value is a default. */
  readonly declared: boolean;
}

export type ResolvedFeature =
  | ResolvedSea
  | ResolvedLand
  | ResolvedRegion
  | ResolvedRange
  | ResolvedPass
  | ResolvedVolcano
  | ResolvedPlateau
  | ResolvedRiver
  | ResolvedLake
  | ResolvedBiome
  | ResolvedStrait
  | ResolvedSite
  | ResolvedRoad
  | ResolvedPlace;

export interface FeatureOfKind {
  sea: ResolvedSea;
  land: ResolvedLand;
  region: ResolvedRegion;
  range: ResolvedRange;
  pass: ResolvedPass;
  volcano: ResolvedVolcano;
  plateau: ResolvedPlateau;
  river: ResolvedRiver;
  lake: ResolvedLake;
  biome: ResolvedBiome;
  strait: ResolvedStrait;
  site: ResolvedSite;
  road: ResolvedRoad;
  place: ResolvedPlace;
}

export type ResolvedSurface =
  | { readonly surface: 'land'; readonly id: string }
  | { readonly surface: 'lake'; readonly id: string }
  | { readonly surface: 'sea'; readonly id: string }
  /** Water that no sea, lake or land feature claims; the open ocean of the model. */
  | { readonly surface: 'open-water' };

export interface ResolvedGeographyData {
  readonly frame: GeographyFrame;
  readonly hash: string;
  readonly name?: string;
  readonly description?: string;
  readonly seas: readonly ResolvedSea[];
  readonly lands: readonly ResolvedLand[];
  readonly regions: readonly ResolvedRegion[];
  readonly ranges: readonly ResolvedRange[];
  readonly passes: readonly ResolvedPass[];
  readonly volcanoes: readonly ResolvedVolcano[];
  readonly plateaus: readonly ResolvedPlateau[];
  readonly rivers: readonly ResolvedRiver[];
  readonly lakes: readonly ResolvedLake[];
  /** Ordered by ascending `z`, then id: later entries win. */
  readonly biomes: readonly ResolvedBiome[];
  readonly straits: readonly ResolvedStrait[];
  readonly sites: readonly ResolvedSite[];
  readonly roads: readonly ResolvedRoad[];
  readonly places: readonly ResolvedPlace[];
  readonly climate: ResolvedClimate;
  /** Vertices of every ring and path in the model. */
  readonly pointCount: number;
}

function areaContains(area: ResolvedArea, x: number, y: number): boolean {
  if (!boundsContain(area.bounds, x, y)) return false;
  let inside = false;
  for (const ring of area.outers)
    if (boundsContain(ring.bounds, x, y) && ringContains(ring.xs, ring.ys, x, y)) {
      inside = true;
      break;
    }
  if (!inside) return false;
  for (const hole of area.holes)
    if (boundsContain(hole.bounds, x, y) && ringContainsStrictly(hole, x, y)) return false;
  return true;
}

/** A hole boundary belongs to the shape: only points strictly inside the hole are excluded. */
function ringContainsStrictly(ring: ResolvedRing, x: number, y: number): boolean {
  let inside = false;
  const n = ring.xs.length;
  for (let index = 0, previous = n - 1; index < n; previous = index++) {
    const ay = ring.ys[previous]!,
      by = ring.ys[index]!;
    if (ay > y !== by > y) {
      const ax = ring.xs[previous]!,
        bx = ring.xs[index]!;
      if (x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
    }
  }
  return inside;
}

/** Surface lookup over the water and land features, usable before a full model exists. */
export function findSurface(
  features: {
    readonly lakes: readonly { id: string; area: ResolvedArea }[];
    readonly lands: readonly { id: string; area: ResolvedArea }[];
    readonly seas: readonly { id: string; area: ResolvedArea }[];
  },
  x: number,
  y: number,
): ResolvedSurface {
  for (const lake of features.lakes)
    if (areaContains(lake.area, x, y)) return { surface: 'lake', id: lake.id };
  for (const land of features.lands)
    if (areaContains(land.area, x, y)) return { surface: 'land', id: land.id };
  for (const sea of features.seas)
    if (areaContains(sea.area, x, y)) return { surface: 'sea', id: sea.id };
  return { surface: 'open-water' };
}

export function resolvedAreaContains(area: ResolvedArea, x: number, y: number): boolean {
  return areaContains(area, x, y);
}

/**
 * Distance from a point to the nearest ring edge of the area, inside or outside, in map-width
 * units (`aspect` is height over width, so one unit is the whole map width on both axes).
 */
export function areaBoundaryDistance(
  area: ResolvedArea,
  x: number,
  y: number,
  aspect: number,
): number {
  let best = Infinity;
  for (const ring of [...area.outers, ...area.holes]) {
    const n = ring.xs.length;
    for (let index = 0, previous = n - 1; index < n; previous = index++) {
      const found = pointSegment(
        x,
        y * aspect,
        ring.xs[previous]!,
        ring.ys[previous]! * aspect,
        ring.xs[index]!,
        ring.ys[index]! * aspect,
      ).distance;
      if (found < best) best = found;
    }
  }
  return best;
}

/** The resolved model with lookup by id and by point. Construct it with `resolveGeography`. */
export class ResolvedGeography implements ResolvedGeographyData {
  readonly frame: GeographyFrame;
  readonly hash: string;
  readonly name?: string;
  readonly description?: string;
  readonly seas: readonly ResolvedSea[];
  readonly lands: readonly ResolvedLand[];
  readonly regions: readonly ResolvedRegion[];
  readonly ranges: readonly ResolvedRange[];
  readonly passes: readonly ResolvedPass[];
  readonly volcanoes: readonly ResolvedVolcano[];
  readonly plateaus: readonly ResolvedPlateau[];
  readonly rivers: readonly ResolvedRiver[];
  readonly lakes: readonly ResolvedLake[];
  readonly biomes: readonly ResolvedBiome[];
  readonly straits: readonly ResolvedStrait[];
  readonly sites: readonly ResolvedSite[];
  readonly roads: readonly ResolvedRoad[];
  readonly places: readonly ResolvedPlace[];
  readonly climate: ResolvedClimate;
  readonly pointCount: number;
  private readonly byId: ReadonlyMap<string, ResolvedFeature>;

  constructor(data: ResolvedGeographyData) {
    this.frame = data.frame;
    this.hash = data.hash;
    if (data.name !== undefined) this.name = data.name;
    if (data.description !== undefined) this.description = data.description;
    this.seas = data.seas;
    this.lands = data.lands;
    this.regions = data.regions;
    this.ranges = data.ranges;
    this.passes = data.passes;
    this.volcanoes = data.volcanoes;
    this.plateaus = data.plateaus;
    this.rivers = data.rivers;
    this.lakes = data.lakes;
    this.biomes = data.biomes;
    this.straits = data.straits;
    this.sites = data.sites;
    this.roads = data.roads;
    this.places = data.places;
    this.climate = data.climate;
    this.pointCount = data.pointCount;
    this.byId = new Map(this.features().map((feature) => [feature.id, feature]));
  }

  /** Every feature, grouped by `GEOGRAPHY_FEATURE_KINDS` and sorted by id inside a group. */
  features(): readonly ResolvedFeature[] {
    return [
      ...this.seas,
      ...this.lands,
      ...this.regions,
      ...this.ranges,
      ...this.passes,
      ...this.volcanoes,
      ...this.plateaus,
      ...this.rivers,
      ...this.lakes,
      ...[...this.biomes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ...this.straits,
      ...this.sites,
      ...this.roads,
      ...this.places,
    ];
  }

  get featureCount(): number {
    return this.byId.size;
  }

  /** The feature with this id, of any kind. */
  find(id: string): ResolvedFeature | undefined {
    return this.byId.get(id);
  }

  /** The feature with this id when it has the given kind. */
  get<K extends GeographyFeatureKind>(kind: K, id: string): FeatureOfKind[K] | undefined {
    const feature = this.byId.get(id);
    return feature?.kind === kind ? (feature as FeatureOfKind[K]) : undefined;
  }

  list<K extends GeographyFeatureKind>(kind: K): readonly FeatureOfKind[K][] {
    const lists: { [P in GeographyFeatureKind]: readonly FeatureOfKind[P][] } = {
      sea: this.seas,
      land: this.lands,
      region: this.regions,
      range: this.ranges,
      pass: this.passes,
      volcano: this.volcanoes,
      plateau: this.plateaus,
      river: this.rivers,
      lake: this.lakes,
      biome: this.biomes,
      strait: this.straits,
      site: this.sites,
      road: this.roads,
      place: this.places,
    };
    return lists[kind];
  }

  /** The first land (by id) containing the point, if any. */
  landIdAt(x: number, y: number): string | undefined {
    for (const land of this.lands) if (areaContains(land.area, x, y)) return land.id;
    return undefined;
  }

  /**
   * What the model says is at a point. Lakes carve land; land beats sea; a point in no feature is
   * open water. Boundaries belong to the feature (a coastline point is land).
   */
  surfaceAt(x: number, y: number): ResolvedSurface {
    return findSurface(this, x, y);
  }

  isLandAt(x: number, y: number): boolean {
    return this.surfaceAt(x, y).surface === 'land';
  }
}
