import { compareCodeUnits, hashCanonical } from '../../core/canonical.js';
import {
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../../core/diagnostics.js';
import {
  GEOGRAPHY_MAX_FEATURES,
  GEOGRAPHY_MAX_POINTS,
  type GeographyModelInput,
  type GeographyPathPointInput,
  type GeographyPointInput,
} from '../../schemas/geography.js';
import {
  boundsOf,
  findSelfIntersection,
  interiorPoint,
  ringCentroid,
  ringContains,
  ringsIntersect,
  signedArea,
  unionBounds,
} from './geometry.js';
import {
  areaBoundaryDistance,
  findSurface,
  ResolvedGeography,
  resolvedAreaContains,
  type GeographyFeatureKind,
  type GeographyFrame,
  type GeoPoint,
  type ResolvedArea,
  type ResolvedBiome,
  type ResolvedClimate,
  type ResolvedLake,
  type ResolvedLand,
  type ResolvedPass,
  type ResolvedPlateau,
  type ResolvedPolyline,
  type ResolvedRange,
  type ResolvedRegion,
  type ResolvedRing,
  type ResolvedRiver,
  type ResolvedRiverEnd,
  type ResolvedPlace,
  type ResolvedRoad,
  type ResolvedSea,
  type ResolvedSite,
  type ResolvedStrait,
  type ResolvedStraitEnd,
  type ResolvedVolcano,
} from './model.js';
import {
  analysisGrid,
  nearestOnPolyline,
  sampleAlong,
  scanAreaStrip,
  type RasterGrid,
} from './raster.js';

/** Values the resolved model uses where the input leaves a field out. Part of the contract. */
export const GEOGRAPHY_DEFAULTS = {
  sea: { depthClass: 'open', ice: 0, kind: 'sea' },
  land: { elevationBase: 0.15, coastDetail: 0.5 },
  range: {
    halfWidth: 0.012,
    peak: 0.7,
    profile: 'ridge',
    asymmetry: 0,
    spurs: 0.5,
    barrier: 'none',
  },
  pass: { width: 0.006, depth: 0.6, fort: 0, reach: 0.02 },
  volcano: { radius: 0.01, peak: 0.85, craterShare: 0.2, active: false },
  plateau: { edge: 'ramp' },
  river: { size: 3, delta: false },
  lake: { depthClass: 'open', gameplay: 'lake' },
  biome: { density: 0.6, z: 0 },
  strait: { rule: 'open', width: 0.01 },
  straitReach: 0.1,
  lakeShoreReach: 0.01,
  site: { importance: 1 },
  road: { importance: 1 },
  landTolerance: 0.003,
  climate: {
    windFrom: 270,
    temperature: { warm: 24, cold: -10 },
    warmBandY: 0.5,
    rainScale: 1,
    seasonality: 0.5,
  },
} as const;

/** Edge policy the validator may enforce; mirrors the `edge` option of world generation. */
export interface GeographyEdgePolicy {
  mode?: 'sea-band' | 'rim' | 'none' | undefined;
  /** Pixels kept free of land east and west; default `max(192, 4% of width)`. */
  bandPx?: number | undefined;
  /** Pixels kept free of land north and south; default 64. */
  polarPx?: number | undefined;
}

export interface GeographyResolveOptions {
  frame: GeographyFrame;
  /** A reference image supplies the coast, so a model without lands is acceptable. */
  hasReference?: boolean;
  edge?: GeographyEdgePolicy;
  operationId?: string;
}

export interface GeographyResolution {
  geography: ResolvedGeography;
  /** Sorted, bounded, deterministic. */
  diagnostics: Diagnostic[];
  /** No error diagnostics: the model may be used for synthesis. */
  valid: boolean;
  edgeBand: { westEastPx: number; northSouthPx: number };
}

export const GEOGRAPHY_DIAGNOSTIC_LIMIT = 1_000;

const DISC_VERTICES = 64;
// cos and sin of 2 pi / 64, rotated repeatedly so no trigonometric call is needed.
const DISC_COS = 0.9951847266721969;
const DISC_SIN = 0.0980171403295606;

type Sink = (
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  details?: Record<string, unknown>,
) => void;

function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
}

function toPoint(point: GeographyPointInput): GeoPoint {
  return Array.isArray(point) ? { x: point[0], y: point[1] } : point;
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort(compareCodeUnits);
}

function byId<T extends { id: string }>(items: readonly T[] | undefined): T[] {
  return [...(items ?? [])].sort((a, b) => compareCodeUnits(a.id, b.id));
}

function countPoints(model: GeographyModelInput): number {
  let total = 0;
  const rings = (area: { polygons?: unknown[][] | undefined; holes?: unknown[][] | undefined }) => {
    for (const ring of area.polygons ?? []) total += ring.length;
    for (const ring of area.holes ?? []) total += ring.length;
  };
  for (const item of [
    ...(model.seas ?? []),
    ...(model.lands ?? []),
    ...(model.regions ?? []),
    ...(model.plateaus ?? []),
    ...(model.lakes ?? []),
    ...(model.biomes ?? []),
  ])
    rings(item);
  for (const range of model.ranges ?? []) total += range.path.length;
  for (const river of model.rivers ?? []) total += 2 + (river.via?.length ?? 0);
  total += (model.volcanoes?.length ?? 0) + (model.sites?.length ?? 0);
  total += (model.places?.length ?? 0) + (model.passes?.length ?? 0);
  for (const road of model.roads ?? []) total += road.path.length;
  for (const strait of model.straits ?? []) total += 2 + (strait.path?.length ?? 0);
  return total;
}

function featureCount(model: GeographyModelInput): number {
  return (
    (model.seas?.length ?? 0) +
    (model.lands?.length ?? 0) +
    (model.regions?.length ?? 0) +
    (model.ranges?.length ?? 0) +
    (model.passes?.length ?? 0) +
    (model.volcanoes?.length ?? 0) +
    (model.plateaus?.length ?? 0) +
    (model.rivers?.length ?? 0) +
    (model.lakes?.length ?? 0) +
    (model.biomes?.length ?? 0) +
    (model.straits?.length ?? 0) +
    (model.sites?.length ?? 0) +
    (model.roads?.length ?? 0) +
    (model.places?.length ?? 0)
  );
}

function allCollinear(xs: readonly number[], ys: readonly number[]): boolean {
  for (let index = 2; index < xs.length; index++) {
    const cross =
      (xs[1]! - xs[0]!) * (ys[index]! - ys[0]!) - (ys[1]! - ys[0]!) * (xs[index]! - xs[0]!);
    if (Math.abs(cross) > 1e-15) return false;
  }
  return true;
}

function ringFrom(
  points: readonly GeographyPointInput[],
  outer: boolean,
  label: string,
  sink: Sink,
  featureId: string,
): ResolvedRing | undefined {
  const xs: number[] = [],
    ys: number[] = [];
  let duplicates = 0;
  for (const raw of points) {
    const { x, y } = toPoint(raw);
    if (xs.length > 0 && xs.at(-1) === x && ys.at(-1) === y) {
      duplicates++;
      continue;
    }
    xs.push(x);
    ys.push(y);
  }
  if (xs.length > 1 && xs[0] === xs.at(-1) && ys[0] === ys.at(-1)) {
    xs.pop();
    ys.pop();
    duplicates++;
  }
  if (duplicates > 0)
    sink(
      'MAP_GEOGRAPHY_RING_DUPLICATE_VERTEX',
      'warning',
      `${label} of ${featureId} repeats ${duplicates} vertex(es), including a closing copy of the first; the ring is closed implicitly, so they were removed`,
      { featureId, duplicates },
    );
  const area = signedArea(xs, ys);
  // A crossing ring (a bowtie can have a zero shoelace sum) is reported as such, not as empty.
  const collinear = xs.length >= 3 && allCollinear(xs, ys);
  const crossing = xs.length >= 3 && !collinear && findSelfIntersection(xs, ys, true) !== undefined;
  if (crossing)
    sink(
      'MAP_GEOGRAPHY_RING_SELF_INTERSECTION',
      'error',
      `${label} of ${featureId} crosses, touches or doubles back on itself`,
      { featureId },
    );
  if (xs.length < 3 || collinear || (!crossing && Math.abs(area) < 1e-12)) {
    sink(
      'MAP_GEOGRAPHY_RING_DEGENERATE',
      'error',
      `${label} of ${featureId} has fewer than 3 distinct vertices or no area`,
      { featureId, vertices: xs.length },
    );
    return undefined;
  }
  // Orient outers with a positive shoelace sum and holes with a negative one.
  if (outer !== area > 0) {
    xs.reverse();
    ys.reverse();
  }
  const fx = Float64Array.from(xs),
    fy = Float64Array.from(ys);
  return { xs: fx, ys: fy, bounds: boundsOf(fx, fy), signedArea: signedArea(fx, fy) };
}

function ringInside(inner: ResolvedRing, outer: ResolvedRing): boolean {
  return ringContains(outer.xs, outer.ys, inner.xs[0]!, inner.ys[0]!);
}

function buildArea(
  featureId: string,
  polygons: readonly (readonly GeographyPointInput[])[],
  holes: readonly (readonly GeographyPointInput[])[],
  sink: Sink,
): ResolvedArea | undefined {
  const outers: ResolvedRing[] = [];
  const holeRings: ResolvedRing[] = [];
  for (const [index, polygon] of polygons.entries()) {
    const ring = ringFrom(polygon, true, `Polygon ${index + 1}`, sink, featureId);
    if (ring !== undefined) outers.push(ring);
  }
  for (const [index, hole] of holes.entries()) {
    const ring = ringFrom(hole, false, `Hole ${index + 1}`, sink, featureId);
    if (ring !== undefined) holeRings.push(ring);
  }
  if (outers.length === 0) return undefined;
  const overlap = (a: ResolvedRing, b: ResolvedRing): boolean =>
    ringsIntersect(a.xs, a.ys, b.xs, b.ys) || ringInside(a, b) || ringInside(b, a);
  for (let i = 0; i < outers.length; i++)
    for (let j = i + 1; j < outers.length; j++)
      if (overlap(outers[i]!, outers[j]!))
        sink(
          'MAP_GEOGRAPHY_POLYGONS_OVERLAP',
          'error',
          `Polygons ${i + 1} and ${j + 1} of ${featureId} overlap or touch; describe one shape per polygon and use holes for cut-outs`,
          { featureId, polygons: [i + 1, j + 1] },
        );
  for (const [index, hole] of holeRings.entries()) {
    const container = outers.find(
      (outer) => ringInside(hole, outer) && !ringsIntersect(outer.xs, outer.ys, hole.xs, hole.ys),
    );
    if (container === undefined)
      sink(
        'MAP_GEOGRAPHY_HOLE_OUTSIDE',
        'error',
        `Hole ${index + 1} of ${featureId} is not strictly inside one polygon`,
        { featureId, hole: index + 1 },
      );
    for (let other = index + 1; other < holeRings.length; other++)
      if (overlap(hole, holeRings[other]!))
        sink(
          'MAP_GEOGRAPHY_POLYGONS_OVERLAP',
          'error',
          `Holes ${index + 1} and ${other + 1} of ${featureId} overlap or touch`,
          { featureId, holes: [index + 1, other + 1] },
        );
  }
  const fraction = Math.max(
    0,
    outers.reduce((sum, ring) => sum + ring.signedArea, 0) +
      holeRings.reduce((sum, ring) => sum + ring.signedArea, 0),
  );
  const bounds = unionBounds(outers.map((ring) => ring.bounds));
  // Centroid of the largest polygon places the label point inside the dominant part.
  const largest = outers.reduce((a, b) => (b.signedArea > a.signedArea ? b : a));
  const [, centroidY] = ringCentroid(largest.xs, largest.ys);
  const [ix, iy] = interiorPoint(
    [largest, ...holeRings.filter((h) => ringInside(h, largest))],
    centroidY,
    largest.bounds,
  );
  return { outers, holes: holeRings, bounds, areaFraction: fraction, interior: { x: ix, y: iy } };
}

function buildPolyline(
  featureId: string,
  raw: readonly GeographyPathPointInput[],
  closed: boolean,
  defaults: { halfWidth: number; peak: number },
  frame: GeographyFrame,
  sink: Sink,
): ResolvedPolyline | undefined {
  const xs: number[] = [],
    ys: number[] = [],
    halfWidth: number[] = [],
    peak: number[] = [];
  let duplicates = 0;
  for (const point of raw) {
    const x = Array.isArray(point) ? point[0] : (point as { x: number }).x;
    const y = Array.isArray(point) ? point[1] : (point as { y: number }).y;
    if (xs.length > 0 && xs.at(-1) === x && ys.at(-1) === y) {
      duplicates++;
      continue;
    }
    xs.push(x);
    ys.push(y);
    halfWidth.push(
      Array.isArray(point)
        ? defaults.halfWidth
        : ((point as { halfWidth?: number }).halfWidth ?? defaults.halfWidth),
    );
    peak.push(
      Array.isArray(point) ? defaults.peak : ((point as { peak?: number }).peak ?? defaults.peak),
    );
  }
  if (closed && xs.length > 1 && xs[0] === xs.at(-1) && ys[0] === ys.at(-1)) {
    xs.pop();
    ys.pop();
    halfWidth.pop();
    peak.pop();
    duplicates++;
  }
  if (duplicates > 0)
    sink(
      'MAP_GEOGRAPHY_PATH_DUPLICATE_VERTEX',
      'warning',
      `Path of ${featureId} repeats ${duplicates} consecutive vertex(es); they were removed`,
      { featureId, duplicates },
    );
  if (xs.length < (closed ? 3 : 2)) {
    sink(
      'MAP_GEOGRAPHY_PATH_DEGENERATE',
      'error',
      `Path of ${featureId} needs at least ${closed ? 3 : 2} distinct vertices`,
      { featureId, vertices: xs.length },
    );
    return undefined;
  }
  const fx = Float64Array.from(xs),
    fy = Float64Array.from(ys);
  const segments = closed ? fx.length : fx.length - 1;
  const arc = new Float64Array(segments + 1);
  const aspect = frame.height / frame.width;
  for (let index = 0; index < segments; index++) {
    const next = (index + 1) % fx.length;
    const dx = fx[next]! - fx[index]!,
      dy = (fy[next]! - fy[index]!) * aspect;
    arc[index + 1] = arc[index]! + Math.sqrt(dx * dx + dy * dy);
  }
  if (findSelfIntersection(fx, fy, closed) !== undefined)
    sink('MAP_GEOGRAPHY_PATH_SELF_INTERSECTION', 'warning', `Path of ${featureId} crosses itself`, {
      featureId,
    });
  return {
    xs: fx,
    ys: fy,
    halfWidth: Float64Array.from(halfWidth),
    peak: Float64Array.from(peak),
    closed,
    bounds: boundsOf(fx, fy),
    arc,
    length: arc[segments]!,
  };
}

function discArea(center: GeoPoint, radius: number, frame: GeographyFrame): ResolvedArea {
  const xs: number[] = [],
    ys: number[] = [];
  let cos = 1,
    sin = 0;
  const ry = radius * (frame.width / frame.height);
  for (let index = 0; index < DISC_VERTICES; index++) {
    xs.push(center.x + radius * cos);
    ys.push(center.y + ry * sin);
    const nextCos = cos * DISC_COS - sin * DISC_SIN;
    sin = sin * DISC_COS + cos * DISC_SIN;
    cos = nextCos;
  }
  const fx = Float64Array.from(xs),
    fy = Float64Array.from(ys);
  const ring: ResolvedRing = {
    xs: fx,
    ys: fy,
    bounds: boundsOf(fx, fy),
    signedArea: signedArea(fx, fy),
  };
  if (ring.signedArea < 0) {
    fx.reverse();
    fy.reverse();
  }
  const oriented: ResolvedRing = {
    xs: fx,
    ys: fy,
    bounds: ring.bounds,
    signedArea: Math.abs(ring.signedArea),
  };
  return {
    outers: [oriented],
    holes: [],
    bounds: oriented.bounds,
    areaFraction: oriented.signedArea,
    interior: { ...center },
  };
}

function baseOf(feature: {
  id: string;
  name?: string | undefined;
  tags?: string[] | undefined;
  note?: string | undefined;
}) {
  return {
    id: feature.id,
    tags: sortedUnique(feature.tags),
    ...opt('name', feature.name),
    ...opt('note', feature.note),
  };
}

function polylineSegmentLength(a: GeoPoint, b: GeoPoint, frame: GeographyFrame): number {
  const dx = b.x - a.x,
    dy = (b.y - a.y) * (frame.height / frame.width);
  return Math.sqrt(dx * dx + dy * dy);
}

function pairKey(a: number, b: number): number {
  return a < b ? a * 65_536 + b : b * 65_536 + a;
}

/** Plain-object form of the resolved model: primary fields only, arrays sorted, no derived data. */
function canonicalModel(
  frame: GeographyFrame,
  parts: Omit<Parameters<typeof makeGeography>[0], 'hash' | 'pointCount'>,
): unknown {
  const ring = (r: ResolvedRing) => Array.from(r.xs, (x, index) => [x, r.ys[index]!]);
  const area = (a: ResolvedArea) => ({ polygons: a.outers.map(ring), holes: a.holes.map(ring) });
  const line = (l: ResolvedPolyline) => ({
    closed: l.closed,
    points: Array.from(l.xs, (x, index) => [x, l.ys[index]!, l.halfWidth[index]!, l.peak[index]!]),
  });
  const end = (e: ResolvedRiverEnd | ResolvedStraitEnd) =>
    e.type === 'point' ? { x: e.x, y: e.y } : { [e.type]: e.id };
  const base = (f: { id: string; name?: string; tags: readonly string[]; note?: string }) => ({
    id: f.id,
    name: f.name,
    tags: f.tags,
    note: f.note,
  });
  return {
    version: 1,
    frame,
    name: parts.name,
    description: parts.description,
    seas: parts.seas.map((f) => ({
      ...base(f),
      ...area(f.area),
      depthClass: f.depthClass,
      ice: f.ice,
      kind: f.seaKind,
    })),
    lands: parts.lands.map((f) => ({
      ...base(f),
      ...area(f.area),
      kind: f.landKind,
      region: f.regionSource === 'explicit' ? f.regionId : undefined,
      biome: f.biome,
      fertility: f.fertility,
      elevationBase: f.elevationBase,
      coastDetail: f.coastDetail,
    })),
    regions: parts.regions.map((f) => ({
      ...base(f),
      ...(f.area === undefined ? {} : area(f.area)),
      terrain: f.terrain,
      provincesPerState: f.provincesPerState,
      provinceAreaPx: f.provinceAreaPx,
      cityStyle: f.cityStyle,
    })),
    ranges: parts.ranges.map((f) => ({
      ...base(f),
      ...line(f.path),
      profile: f.profile,
      asymmetry: f.asymmetry,
      snowline: f.snowline,
      spurs: f.spurs,
      barrier: f.barrier,
    })),
    passes: parts.passes.map((f) => ({
      ...base(f),
      range: f.rangeId,
      at: f.at,
      width: f.width,
      depth: f.depth,
      fort: f.fort,
    })),
    volcanoes: parts.volcanoes.map((f) => ({
      ...base(f),
      at: f.at,
      radius: f.radius,
      peak: f.peak,
      crater: f.crater,
      active: f.active,
    })),
    plateaus: parts.plateaus.map((f) => ({
      ...base(f),
      ...area(f.area),
      height: f.height,
      edge: f.edge,
    })),
    rivers: parts.rivers.map((f) => ({
      ...base(f),
      source: end(f.source),
      mouth: end(f.mouth),
      via: f.via,
      size: f.size,
      delta: f.delta,
    })),
    lakes: parts.lakes.map((f) => ({
      ...base(f),
      ...area(f.area),
      shape: f.shape,
      depthClass: f.depthClass,
      outflow: f.outflowId,
      gameplay: f.gameplay,
    })),
    biomes: parts.biomes.map((f) => ({
      ...base(f),
      ...area(f.area),
      kind: f.biome,
      density: f.density,
      fertility: f.fertility,
      z: f.z,
    })),
    straits: parts.straits.map((f) => ({
      ...base(f),
      between: f.between.map(end),
      ends: f.ends,
      path: f.path?.map((point) => [point.x, point.y]),
      rule: f.rule,
      width: f.width,
    })),
    sites: parts.sites.map((f) => ({
      ...base(f),
      kind: f.siteKind,
      at: f.at,
      importance: f.importance,
      country: f.country,
      onWater: f.onWater,
      lake: f.lakeId,
    })),
    roads: parts.roads.map((f) => ({ ...base(f), ...line(f.path), importance: f.importance })),
    places: parts.places.map((f) => ({ ...base(f), kind: f.placeKind, at: f.at })),
    climate: parts.climate,
  };
}

function makeGeography(data: {
  frame: GeographyFrame;
  hash: string;
  name?: string;
  description?: string;
  seas: ResolvedSea[];
  lands: ResolvedLand[];
  regions: ResolvedRegion[];
  ranges: ResolvedRange[];
  passes: ResolvedPass[];
  volcanoes: ResolvedVolcano[];
  plateaus: ResolvedPlateau[];
  rivers: ResolvedRiver[];
  lakes: ResolvedLake[];
  biomes: ResolvedBiome[];
  straits: ResolvedStrait[];
  sites: ResolvedSite[];
  roads: ResolvedRoad[];
  places: ResolvedPlace[];
  climate: ResolvedClimate;
  pointCount: number;
}): ResolvedGeography {
  return new ResolvedGeography(data);
}

function emptyClimate(): ResolvedClimate {
  return {
    ...GEOGRAPHY_DEFAULTS.climate,
    temperature: { ...GEOGRAPHY_DEFAULTS.climate.temperature },
    declared: false,
  };
}

/**
 * Resolve a validated-by-schema geography model against a pixel frame: sort every feature by id,
 * fill documented defaults, orient rings, derive areas and cross-references, and report every
 * defect as a `MAP_GEOGRAPHY_*` diagnostic. The same input and frame always give the same model,
 * the same `hash` and the same diagnostics, whatever order the features were written in.
 */
export function resolveGeography(
  model: GeographyModelInput,
  options: GeographyResolveOptions,
): GeographyResolution {
  const frame = options.frame;
  const found: Diagnostic[] = [];
  const sink: Sink = (code, severity, message, details) => {
    found.push({
      code,
      severity,
      category: 'map',
      message,
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      ...(details === undefined ? {} : { details }),
    });
  };
  const edgeBand = {
    westEastPx: Math.max(1, options.edge?.bandPx ?? Math.max(192, Math.round(0.04 * frame.width))),
    northSouthPx: Math.max(0, options.edge?.polarPx ?? 64),
  };
  const finish = (geography: ResolvedGeography): GeographyResolution => {
    const diagnostics = limitDiagnostics(sortDiagnostics(found));
    return {
      geography,
      diagnostics,
      valid: !diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'),
      edgeBand,
    };
  };

  const features = featureCount(model);
  const points = countPoints(model);
  if (features > GEOGRAPHY_MAX_FEATURES || points > GEOGRAPHY_MAX_POINTS) {
    if (features > GEOGRAPHY_MAX_FEATURES)
      sink(
        'MAP_GEOGRAPHY_LIMIT_FEATURES',
        'error',
        `The model holds ${features} features; the limit is ${GEOGRAPHY_MAX_FEATURES}`,
        { features, limit: GEOGRAPHY_MAX_FEATURES },
      );
    if (points > GEOGRAPHY_MAX_POINTS)
      sink(
        'MAP_GEOGRAPHY_LIMIT_POINTS',
        'error',
        `The model holds ${points} vertices and points; the limit is ${GEOGRAPHY_MAX_POINTS}`,
        { points, limit: GEOGRAPHY_MAX_POINTS },
      );
    const climate = emptyClimate();
    return finish(
      makeGeography({
        frame,
        hash: hashCanonical({ rejected: 'limits', frame }),
        seas: [],
        lands: [],
        regions: [],
        ranges: [],
        passes: [],
        volcanoes: [],
        plateaus: [],
        rivers: [],
        lakes: [],
        biomes: [],
        straits: [],
        sites: [],
        roads: [],
        places: [],
        climate,
        pointCount: 0,
      }),
    );
  }

  // Ids are global: the first occurrence in each kind order wins, later ones are dropped.
  const kinds = new Map<string, GeographyFeatureKind>();
  const claim = <T extends { id: string }>(
    kind: GeographyFeatureKind,
    items: readonly T[] | undefined,
  ): T[] => {
    const kept: T[] = [];
    for (const item of byId(items)) {
      const previous = kinds.get(item.id);
      if (previous !== undefined) {
        sink(
          'MAP_GEOGRAPHY_ID_DUPLICATE',
          'error',
          `Feature id ${item.id} is used by a ${previous} and a ${kind}; ids must be unique across the model`,
          { featureId: item.id, kinds: [previous, kind] },
        );
        continue;
      }
      kinds.set(item.id, kind);
      kept.push(item);
    }
    return kept;
  };
  const seaInputs = claim('sea', model.seas);
  const landInputs = claim('land', model.lands);
  const regionInputs = claim('region', model.regions);
  const rangeInputs = claim('range', model.ranges);
  const passInputs = claim('pass', model.passes);
  const volcanoInputs = claim('volcano', model.volcanoes);
  const plateauInputs = claim('plateau', model.plateaus);
  const riverInputs = claim('river', model.rivers);
  const lakeInputs = claim('lake', model.lakes);
  const biomeInputs = claim('biome', model.biomes);
  const straitInputs = claim('strait', model.straits);
  const siteInputs = claim('site', model.sites);
  const roadInputs = claim('road', model.roads);
  const placeInputs = claim('place', model.places);

  const seas: ResolvedSea[] = [];
  for (const input of seaInputs) {
    const area = buildArea(input.id, input.polygons, input.holes ?? [], sink);
    if (area === undefined) continue;
    seas.push({
      ...baseOf(input),
      kind: 'sea',
      area,
      depthClass: input.depthClass ?? GEOGRAPHY_DEFAULTS.sea.depthClass,
      ice: input.ice ?? GEOGRAPHY_DEFAULTS.sea.ice,
      seaKind: input.kind ?? GEOGRAPHY_DEFAULTS.sea.kind,
    });
  }

  const regions: ResolvedRegion[] = [];
  const regionAreas = new Map<string, ResolvedArea>();
  for (const input of regionInputs) {
    let area: ResolvedArea | undefined;
    if (input.polygons !== undefined) {
      area = buildArea(input.id, input.polygons, input.holes ?? [], sink);
      if (area !== undefined) regionAreas.set(input.id, area);
    } else if (input.holes !== undefined)
      sink(
        'MAP_GEOGRAPHY_HOLES_WITHOUT_POLYGONS',
        'error',
        `Region ${input.id} lists holes but no polygons`,
        {
          featureId: input.id,
        },
      );
    const terrain = Object.fromEntries(
      Object.entries(input.terrain ?? {}).filter(([, share]) => share !== undefined),
    ) as Record<string, number>;
    const shareSum = Object.values(terrain).reduce((sum, share) => sum + share, 0);
    if (shareSum > 1.05)
      sink(
        'MAP_GEOGRAPHY_REGION_TERRAIN_SUM',
        'warning',
        `The terrain shares of region ${input.id} add up to ${shareSum.toFixed(2)}, above 1`,
        { featureId: input.id, sum: shareSum },
      );
    const perState = input.density?.provincesPerState;
    if (perState !== undefined && !(perState[0] <= perState[1] && perState[1] <= perState[2]))
      sink(
        'MAP_GEOGRAPHY_REGION_DENSITY_ORDER',
        'error',
        `Region ${input.id} lists provincesPerState as [smallest, usual, largest] but they are not in order`,
        { featureId: input.id },
      );
    regions.push({
      ...baseOf(input),
      kind: 'region',
      ...opt('area', area),
      landIds: [],
      ...(Object.keys(terrain).length === 0 ? {} : { terrain }),
      ...(perState === undefined ? {} : { provincesPerState: perState }),
      ...opt('provinceAreaPx', input.density?.provinceAreaPx),
      ...opt('cityStyle', input.cityStyle),
    });
  }

  const lands: ResolvedLand[] = [];
  const landDrafts: Array<{ land: ResolvedLand; declared: string | undefined }> = [];
  for (const input of landInputs) {
    const area = buildArea(input.id, input.polygons, input.holes ?? [], sink);
    if (area === undefined) continue;
    const land: ResolvedLand = {
      ...baseOf(input),
      kind: 'land',
      area,
      elevationBase: input.elevationBase ?? GEOGRAPHY_DEFAULTS.land.elevationBase,
      coastDetail: input.coastDetail ?? GEOGRAPHY_DEFAULTS.land.coastDetail,
      ...opt('landKind', input.kind),
      ...opt('biome', input.biome),
      ...opt('fertility', input.fertility),
    };
    landDrafts.push({ land, declared: input.region });
  }
  // Region assignment: an explicit id must name a region; otherwise containment decides.
  for (const { land, declared } of landDrafts) {
    let regionId: string | undefined;
    let regionSource: 'explicit' | 'containment' | undefined;
    if (declared !== undefined) {
      const kind = kinds.get(declared);
      if (kind === undefined)
        sink(
          'MAP_GEOGRAPHY_REF_UNKNOWN',
          'error',
          `Land ${land.id} names region ${declared}, which does not exist`,
          {
            featureId: land.id,
            field: 'region',
            reference: declared,
          },
        );
      else if (kind !== 'region')
        sink(
          'MAP_GEOGRAPHY_REF_KIND',
          'error',
          `Land ${land.id} names ${declared} as its region, but that is a ${kind}`,
          {
            featureId: land.id,
            field: 'region',
            reference: declared,
            actualKind: kind,
          },
        );
      else {
        regionId = declared;
        regionSource = 'explicit';
      }
    } else
      for (const region of regions) {
        const area = region.area;
        if (area === undefined) continue;
        if (resolvedAreaContains(area, land.area.interior.x, land.area.interior.y)) {
          regionId = region.id;
          regionSource = 'containment';
          break;
        }
      }
    lands.push({
      ...land,
      ...(regionId === undefined ? {} : { regionId, regionSource: regionSource! }),
    });
  }
  for (const [index, region] of regions.entries())
    regions[index] = {
      ...region,
      landIds: lands.filter((land) => land.regionId === region.id).map((land) => land.id),
    };
  for (const region of regions)
    if (region.area === undefined && region.landIds.length === 0)
      sink(
        'MAP_GEOGRAPHY_REGION_EMPTY',
        'warning',
        `Region ${region.id} has no polygons and no land names it`,
        {
          featureId: region.id,
        },
      );

  const ranges: ResolvedRange[] = [];
  for (const input of rangeInputs) {
    const halfWidth = input.halfWidth ?? GEOGRAPHY_DEFAULTS.range.halfWidth;
    const peak = input.peak ?? GEOGRAPHY_DEFAULTS.range.peak;
    const path = buildPolyline(
      input.id,
      input.path,
      input.closed ?? false,
      { halfWidth, peak },
      frame,
      sink,
    );
    if (path === undefined) continue;
    ranges.push({
      ...baseOf(input),
      kind: 'range',
      path,
      profile: input.profile ?? GEOGRAPHY_DEFAULTS.range.profile,
      asymmetry: input.asymmetry ?? GEOGRAPHY_DEFAULTS.range.asymmetry,
      spurs: input.spurs ?? GEOGRAPHY_DEFAULTS.range.spurs,
      barrier: input.barrier ?? GEOGRAPHY_DEFAULTS.range.barrier,
      passIds: [],
      ...opt('snowline', input.snowline),
    });
  }

  const passes: ResolvedPass[] = [];
  for (const input of passInputs) {
    if (input.at !== undefined && input.position !== undefined) {
      sink(
        'MAP_GEOGRAPHY_PASS_SHAPE',
        'error',
        `Pass ${input.id} gives both at and position; give one`,
        { featureId: input.id },
      );
      continue;
    }
    if (input.at === undefined && input.position === undefined) {
      sink(
        'MAP_GEOGRAPHY_PASS_SHAPE',
        'error',
        `Pass ${input.id} needs either range with at, or a position`,
        { featureId: input.id },
      );
      continue;
    }
    if (input.at !== undefined && input.range === undefined) {
      sink(
        'MAP_GEOGRAPHY_PASS_SHAPE',
        'error',
        `Pass ${input.id} gives at without the range it is measured along`,
        { featureId: input.id },
      );
      continue;
    }
    let range: ResolvedRange | undefined;
    if (input.range !== undefined) {
      const kind = kinds.get(input.range);
      range = ranges.find((candidate) => candidate.id === input.range);
      if (kind === undefined)
        sink(
          'MAP_GEOGRAPHY_REF_UNKNOWN',
          'error',
          `Pass ${input.id} names range ${input.range}, which does not exist`,
          { featureId: input.id, field: 'range', reference: input.range },
        );
      else if (kind !== 'range')
        sink(
          'MAP_GEOGRAPHY_REF_KIND',
          'error',
          `Pass ${input.id} names ${input.range} as its range, but that is a ${kind}`,
          { featureId: input.id, field: 'range', reference: input.range, actualKind: kind },
        );
      if (range === undefined) continue;
    }
    let at: number;
    let position: GeoPoint;
    let offset = 0;
    let positionSource: 'range-fraction' | 'point';
    if (input.position !== undefined) {
      positionSource = 'point';
      const given = toPoint(input.position);
      // Without a named range the nearest range whose footprint reaches the point is used.
      let best:
        { range: ResolvedRange; projection: ReturnType<typeof nearestOnPolyline> } | undefined;
      for (const candidate of range === undefined ? ranges : [range]) {
        const projection = nearestOnPolyline(candidate.path, frame, given.x, given.y);
        if (best === undefined || projection.distance < best.projection.distance)
          best = { range: candidate, projection };
      }
      if (best === undefined) {
        sink('MAP_GEOGRAPHY_PASS_OFF_RANGE', 'error', `Pass ${input.id} has no range to lie on`, {
          featureId: input.id,
        });
        continue;
      }
      const reach = Math.max(GEOGRAPHY_DEFAULTS.pass.reach, 2 * best.projection.halfWidth);
      if (best.projection.distance > reach) {
        sink(
          'MAP_GEOGRAPHY_PASS_OFF_RANGE',
          'error',
          `Pass ${input.id} is ${best.projection.distance.toFixed(4)} map widths from ${best.range.id}, beyond the ${reach.toFixed(4)} its footprint reaches`,
          {
            featureId: input.id,
            range: best.range.id,
            distance: best.projection.distance,
            reach,
          },
        );
        continue;
      }
      range = best.range;
      at = best.projection.at;
      position = { x: best.projection.x, y: best.projection.y };
      offset = best.projection.distance;
    } else {
      positionSource = 'range-fraction';
      at = input.at!;
      const sample = sampleAlong(range!.path, frame, at);
      position = { x: sample.x, y: sample.y };
    }
    passes.push({
      ...baseOf(input),
      kind: 'pass',
      rangeId: range!.id,
      at,
      width: input.width ?? GEOGRAPHY_DEFAULTS.pass.width,
      depth: input.depth ?? GEOGRAPHY_DEFAULTS.pass.depth,
      fort: input.fort ?? GEOGRAPHY_DEFAULTS.pass.fort,
      position,
      positionSource,
      offset,
    });
  }
  for (const [index, range] of ranges.entries()) {
    const own = passes
      .filter((pass) => pass.rangeId === range.id)
      .sort((a, b) => a.at - b.at || compareCodeUnits(a.id, b.id));
    ranges[index] = { ...range, passIds: own.map((pass) => pass.id) };
    const length = range.path.length;
    for (let i = 0; i < own.length; i++)
      for (let j = i + 1; j < own.length; j++) {
        const gap = (own[j]!.at - own[i]!.at) * length;
        if (gap < (own[i]!.width + own[j]!.width) / 2)
          sink(
            'MAP_GEOGRAPHY_PASS_OVERLAP',
            'warning',
            `Passes ${own[i]!.id} and ${own[j]!.id} on ${range.id} overlap`,
            {
              featureId: own[j]!.id,
              other: own[i]!.id,
            },
          );
      }
  }

  const plateaus: ResolvedPlateau[] = [];
  for (const input of plateauInputs) {
    const area = buildArea(input.id, input.polygons, input.holes ?? [], sink);
    if (area === undefined) continue;
    plateaus.push({
      ...baseOf(input),
      kind: 'plateau',
      area,
      height: input.height,
      edge: input.edge ?? GEOGRAPHY_DEFAULTS.plateau.edge,
    });
  }

  const lakes: ResolvedLake[] = [];
  const lakeDrafts: ResolvedLake[] = [];
  for (const input of lakeInputs) {
    const hasPolygons = input.polygons !== undefined;
    const hasDisc = input.center !== undefined || input.radius !== undefined;
    if (
      hasPolygons === hasDisc ||
      (hasDisc && (input.center === undefined || input.radius === undefined))
    ) {
      sink(
        'MAP_GEOGRAPHY_LAKE_SHAPE',
        'error',
        `Lake ${input.id} needs either polygons or both center and radius, not both and not neither`,
        { featureId: input.id },
      );
      continue;
    }
    let area: ResolvedArea | undefined;
    if (hasPolygons) area = buildArea(input.id, input.polygons!, input.holes ?? [], sink);
    else {
      area = discArea(toPoint(input.center!), input.radius!, frame);
      const b = area.bounds;
      if (b.x0 < 0 || b.y0 < 0 || b.x1 > 1 || b.y1 > 1) {
        sink(
          'MAP_GEOGRAPHY_LAKE_OUT_OF_FRAME',
          'error',
          `Lake ${input.id} extends outside the world frame`,
          {
            featureId: input.id,
          },
        );
        continue;
      }
    }
    if (area === undefined) continue;
    lakeDrafts.push({
      ...baseOf(input),
      kind: 'lake',
      area,
      shape: hasPolygons ? 'polygon' : 'disc',
      depthClass: input.depthClass ?? GEOGRAPHY_DEFAULTS.lake.depthClass,
      gameplay: input.gameplay ?? GEOGRAPHY_DEFAULTS.lake.gameplay,
      ...(input.outflow === undefined ? {} : { outflowId: input.outflow }),
    });
  }
  lakes.push(...lakeDrafts);

  // Points that stand on a coast may fall a hair outside a simplified polygon; they count as land
  // when a coastline lies within the tolerance.
  const aspect = frame.height / frame.width;
  const tolerance = GEOGRAPHY_DEFAULTS.landTolerance;
  const coastDistance = (
    x: number,
    y: number,
    limit: number,
  ): { id: string; distance: number } | undefined => {
    let best: { id: string; distance: number } | undefined;
    for (const land of lands) {
      const b = land.area.bounds;
      if (
        x < b.x0 - limit ||
        x > b.x1 + limit ||
        y < b.y0 - limit / aspect ||
        y > b.y1 + limit / aspect
      )
        continue;
      const distance = areaBoundaryDistance(land.area, x, y, aspect);
      if (distance <= limit && (best === undefined || distance < best.distance))
        best = { id: land.id, distance };
    }
    return best;
  };
  const landAtOrNear = (x: number, y: number): string | undefined => {
    const here = findSurface({ lakes, lands, seas }, x, y);
    if (here.surface === 'land') return here.id;
    // A lake carves land: its water is never land, however close its shore.
    return here.surface === 'lake' ? undefined : coastDistance(x, y, tolerance)?.id;
  };
  const volcanoes: ResolvedVolcano[] = [];
  for (const input of volcanoInputs) {
    const at = toPoint(input.at);
    const radius = input.radius ?? GEOGRAPHY_DEFAULTS.volcano.radius;
    const crater = input.crater ?? radius * GEOGRAPHY_DEFAULTS.volcano.craterShare;
    if (crater > radius)
      sink(
        'MAP_GEOGRAPHY_VOLCANO_CRATER_RADIUS',
        'error',
        `Volcano ${input.id} has a crater wider than its cone`,
        { featureId: input.id },
      );
    const here = findSurface({ lakes, lands, seas }, at.x, at.y);
    const landId = here.surface === 'land' ? here.id : landAtOrNear(at.x, at.y);
    if (landId === undefined)
      sink(
        'MAP_GEOGRAPHY_VOLCANO_NOT_ON_LAND',
        'error',
        `Volcano ${input.id} stands on ${here.surface}, not land`,
        { featureId: input.id },
      );
    volcanoes.push({
      ...baseOf(input),
      kind: 'volcano',
      at,
      radius,
      peak: input.peak ?? GEOGRAPHY_DEFAULTS.volcano.peak,
      crater,
      active: input.active ?? GEOGRAPHY_DEFAULTS.volcano.active,
      ...(landId === undefined ? {} : { landId }),
    });
  }
  for (let i = 0; i < volcanoes.length; i++)
    for (let j = i + 1; j < volcanoes.length; j++) {
      const a = volcanoes[i]!,
        b = volcanoes[j]!;
      if (polylineSegmentLength(a.at, b.at, frame) < Math.max(a.radius, b.radius))
        sink(
          'MAP_GEOGRAPHY_VOLCANO_OVERLAP',
          'warning',
          `Volcanoes ${a.id} and ${b.id} are closer than their larger radius`,
          {
            featureId: b.id,
            other: a.id,
          },
        );
    }

  const biomes: ResolvedBiome[] = [];
  for (const input of biomeInputs) {
    const area = buildArea(input.id, input.polygons, input.holes ?? [], sink);
    if (area === undefined) continue;
    biomes.push({
      ...baseOf(input),
      kind: 'biome',
      area,
      biome: input.kind,
      density: input.density ?? GEOGRAPHY_DEFAULTS.biome.density,
      z: input.z ?? GEOGRAPHY_DEFAULTS.biome.z,
      ...opt('fertility', input.fertility),
    });
  }
  biomes.sort((a, b) => a.z - b.z || compareCodeUnits(a.id, b.id));

  // Rivers: resolve ends against lakes, seas and other rivers.
  const lakeById = new Map(lakes.map((lake) => [lake.id, lake]));
  const kindOf = (id: string) => kinds.get(id);
  const refError = (
    featureId: string,
    field: string,
    reference: string,
    expected: GeographyFeatureKind,
  ): boolean => {
    const actual = kindOf(reference);
    if (actual === undefined) {
      sink(
        'MAP_GEOGRAPHY_REF_UNKNOWN',
        'error',
        `${featureId} names ${reference} in ${field}, which does not exist`,
        {
          featureId,
          field,
          reference,
        },
      );
      return true;
    }
    if (actual !== expected) {
      sink(
        'MAP_GEOGRAPHY_REF_KIND',
        'error',
        `${featureId} names ${reference} in ${field} as a ${expected}, but it is a ${actual}`,
        {
          featureId,
          field,
          reference,
          actualKind: actual,
        },
      );
      return true;
    }
    return false;
  };
  const surface = (x: number, y: number) => findSurface({ lakes, lands, seas }, x, y);
  const rivers: ResolvedRiver[] = [];
  const riverMouthRefs = new Map<string, string>();
  for (const input of riverInputs) {
    let source: ResolvedRiverEnd | undefined;
    if ('lake' in input.source && !Array.isArray(input.source)) {
      const id = input.source.lake;
      if (!refError(input.id, 'source', id, 'lake')) {
        const lake = lakeById.get(id);
        if (lake !== undefined)
          source = { type: 'lake', id, x: lake.area.interior.x, y: lake.area.interior.y };
      }
    } else {
      const point = toPoint(input.source as GeographyPointInput);
      const at = surface(point.x, point.y).surface;
      if (at !== 'land' && at !== 'lake' && landAtOrNear(point.x, point.y) === undefined)
        sink(
          'MAP_GEOGRAPHY_RIVER_SOURCE_NOT_LAND',
          'error',
          `River ${input.id} starts in ${at}, not on land`,
          { featureId: input.id },
        );
      source = { type: 'point', x: point.x, y: point.y };
    }
    let mouth: ResolvedRiverEnd | undefined;
    const rawMouth = input.mouth;
    if (!Array.isArray(rawMouth) && 'sea' in rawMouth) {
      if (!refError(input.id, 'mouth', rawMouth.sea, 'sea'))
        mouth = { type: 'sea', id: rawMouth.sea };
    } else if (!Array.isArray(rawMouth) && 'lake' in rawMouth) {
      if (!refError(input.id, 'mouth', rawMouth.lake, 'lake')) {
        const lake = lakeById.get(rawMouth.lake);
        if (lake !== undefined)
          mouth = { type: 'lake', id: lake.id, x: lake.area.interior.x, y: lake.area.interior.y };
      }
    } else if (!Array.isArray(rawMouth) && 'river' in rawMouth) {
      if (rawMouth.river === input.id)
        sink('MAP_GEOGRAPHY_RIVER_CYCLE', 'error', `River ${input.id} cannot flow into itself`, {
          featureId: input.id,
        });
      else if (!refError(input.id, 'mouth', rawMouth.river, 'river')) {
        mouth = { type: 'river', id: rawMouth.river };
        riverMouthRefs.set(input.id, rawMouth.river);
      }
    } else {
      const point = toPoint(rawMouth);
      const at = surface(point.x, point.y).surface;
      const onFrameEdge = point.x <= 0 || point.x >= 1 || point.y <= 0 || point.y >= 1;
      // A mouth drawn on the shore may sit just inside a simplified coast.
      if (at === 'land' && !onFrameEdge && coastDistance(point.x, point.y, tolerance) === undefined)
        sink(
          'MAP_GEOGRAPHY_RIVER_MOUTH_NOT_WATER',
          'error',
          `River ${input.id} ends on land; its mouth must be in water or on the frame edge`,
          {
            featureId: input.id,
            // How far inland the mouth is, so a converter can snap it to the coast.
            inlandDistance: coastDistance(point.x, point.y, 1)?.distance ?? null,
            nearestLand: coastDistance(point.x, point.y, 1)?.id ?? null,
          },
        );
      mouth = { type: 'point', x: point.x, y: point.y };
    }
    const via = (input.via ?? []).map(toPoint);
    for (const [index, point] of via.entries())
      if (
        surface(point.x, point.y).surface !== 'land' &&
        landAtOrNear(point.x, point.y) === undefined
      )
        sink(
          'MAP_GEOGRAPHY_RIVER_VIA_NOT_LAND',
          'warning',
          `Via point ${index + 1} of river ${input.id} is not on land`,
          { featureId: input.id, via: index + 1 },
        );
    if (source === undefined || mouth === undefined) continue;
    const anchors: GeoPoint[] = [
      ...('x' in source ? [{ x: source.x, y: source.y }] : []),
      ...via,
      ...('x' in mouth ? [{ x: mouth.x, y: mouth.y }] : []),
    ];
    let anchorLength = 0;
    for (let index = 1; index < anchors.length; index++)
      anchorLength += polylineSegmentLength(anchors[index - 1]!, anchors[index]!, frame);
    rivers.push({
      ...baseOf(input),
      kind: 'river',
      source,
      mouth,
      via,
      size: input.size ?? GEOGRAPHY_DEFAULTS.river.size,
      delta: input.delta ?? GEOGRAPHY_DEFAULTS.river.delta,
      tributaryIds: [],
      anchorLength,
    });
  }
  // Cycle detection along river-into-river mouths.
  for (const river of rivers) {
    const seen = new Set<string>([river.id]);
    let next = riverMouthRefs.get(river.id);
    while (next !== undefined) {
      if (seen.has(next)) {
        sink(
          'MAP_GEOGRAPHY_RIVER_CYCLE',
          'error',
          `River ${river.id} flows into itself through ${[...seen].join(', ')}`,
          {
            featureId: river.id,
            cycle: [...seen],
          },
        );
        break;
      }
      seen.add(next);
      next = riverMouthRefs.get(next);
    }
  }
  for (const [index, river] of rivers.entries())
    rivers[index] = {
      ...river,
      tributaryIds: rivers
        .filter((other) => other.mouth.type === 'river' && other.mouth.id === river.id)
        .map((other) => other.id),
    };

  // Lakes: outflow, containing land.
  for (const [index, lake] of lakes.entries()) {
    const input = lakeInputs.find((candidate) => candidate.id === lake.id)!;
    if (input.outflow !== undefined && !refError(lake.id, 'outflow', input.outflow, 'river')) {
      const river = rivers.find((candidate) => candidate.id === input.outflow);
      if (river !== undefined && !(river.source.type === 'lake' && river.source.id === lake.id))
        sink(
          'MAP_GEOGRAPHY_LAKE_OUTFLOW_MISMATCH',
          'warning',
          `Lake ${lake.id} names river ${river.id} as its outflow, but that river does not start at the lake`,
          {
            featureId: lake.id,
            reference: river.id,
          },
        );
    }
    for (const river of rivers)
      if (river.source.type === 'lake' && river.source.id === lake.id && input.outflow !== river.id)
        sink(
          'MAP_GEOGRAPHY_LAKE_OUTFLOW_MISMATCH',
          'info',
          `River ${river.id} starts at lake ${lake.id}, which does not name it as its outflow`,
          {
            featureId: river.id,
            reference: lake.id,
          },
        );
    let outside = 0;
    for (const ring of lake.area.outers)
      for (let v = 0; v < ring.xs.length; v++)
        if (!landContains(lands, ring.xs[v]!, ring.ys[v]!)) outside++;
    if (outside > 0)
      sink(
        'MAP_GEOGRAPHY_LAKE_NOT_IN_LAND',
        'error',
        `Lake ${lake.id} has ${outside} vertex(es) outside every land; a lake must lie inside land (use a sea for water that meets the coast)`,
        {
          featureId: lake.id,
          vertices: outside,
        },
      );
    const landId = lands.find((land) => containsInterior(land.area, lake.area.interior))?.id;
    lakes[index] = { ...lake, ...(landId === undefined ? {} : { landId }) };
    const pixels = lake.area.areaFraction * frame.width * frame.height;
    if (pixels < 60)
      sink(
        'MAP_GEOGRAPHY_LAKE_TOO_SMALL',
        'warning',
        `Lake ${lake.id} covers about ${Math.round(pixels)} pixels; lakes under 60 pixels are dropped`,
        {
          featureId: lake.id,
          pixels: Math.round(pixels),
        },
      );
  }

  // Straits.
  const nearestLand = (x: number, y: number, limit: number): string | undefined =>
    landIdAt(lands, x, y) ?? coastDistance(x, y, limit)?.id;
  const straits: ResolvedStrait[] = [];
  for (const input of straitInputs) {
    if (input.between === undefined && input.path === undefined) {
      sink(
        'MAP_GEOGRAPHY_STRAIT_SHAPE',
        'error',
        `Strait ${input.id} needs between (two lands or points) or a path through the water`,
        { featureId: input.id },
      );
      continue;
    }
    const path = (input.path ?? []).map(toPoint);
    if (path.length > 0) {
      const onLand = path.filter((point) => surface(point.x, point.y).surface === 'land').length;
      if (onLand * 2 > path.length)
        sink(
          'MAP_GEOGRAPHY_STRAIT_PATH_ON_LAND',
          'warning',
          `${onLand} of ${path.length} path points of strait ${input.id} lie on land; the path should run through the water`,
          { featureId: input.id, onLand },
        );
    }
    const ends: ResolvedStraitEnd[] = [];
    let failed = false;
    let derived = false;
    if (input.between !== undefined) {
      for (const [index, raw] of input.between.entries()) {
        if (!Array.isArray(raw) && 'land' in raw) {
          if (refError(input.id, `between[${index}]`, raw.land, 'land')) failed = true;
          else ends.push({ type: 'land', id: raw.land });
        } else {
          const point = toPoint(raw);
          const landId = landAtOrNear(point.x, point.y);
          if (landId === undefined) {
            sink(
              'MAP_GEOGRAPHY_STRAIT_ENDPOINT',
              'error',
              `Strait ${input.id} end ${index + 1} is not on land`,
              { featureId: input.id, end: index + 1 },
            );
            failed = true;
          }
          ends.push({
            type: 'point',
            x: point.x,
            y: point.y,
            ...(landId === undefined ? {} : { landId }),
          });
        }
      }
    } else {
      // Only a path: the lands nearest its two ends are the shores it separates.
      derived = true;
      for (const [index, point] of [path[0]!, path.at(-1)!].entries()) {
        const landId = nearestLand(point.x, point.y, GEOGRAPHY_DEFAULTS.straitReach);
        if (landId === undefined) {
          sink(
            'MAP_GEOGRAPHY_STRAIT_ENDPOINT',
            'error',
            `No land lies within ${GEOGRAPHY_DEFAULTS.straitReach} map widths of end ${index + 1} of strait ${input.id}`,
            { featureId: input.id, end: index + 1 },
          );
          failed = true;
        } else ends.push({ type: 'land', id: landId });
      }
    }
    if (failed || ends.length !== 2) continue;
    const first = ends[0]!,
      second = ends[1]!;
    const idOf = (end: ResolvedStraitEnd) => (end.type === 'land' ? end.id : end.landId);
    if (idOf(first) !== undefined && idOf(first) === idOf(second))
      sink(
        'MAP_GEOGRAPHY_STRAIT_SAME_LAND',
        derived ? 'warning' : 'error',
        `Strait ${input.id} joins ${idOf(first)} to itself; a strait separates two lands`,
        { featureId: input.id, land: idOf(first), derived },
      );
    if (first.type === 'point' && second.type === 'point') {
      let water = false;
      for (let step = 1; step < 32 && !water; step++) {
        const f = step / 32;
        if (
          surface(first.x + (second.x - first.x) * f, first.y + (second.y - first.y) * f)
            .surface !== 'land'
        )
          water = true;
      }
      if (!water)
        sink(
          'MAP_GEOGRAPHY_STRAIT_NO_WATER',
          'warning',
          `The straight line of strait ${input.id} crosses no water`,
          { featureId: input.id },
        );
    }
    straits.push({
      ...baseOf(input),
      kind: 'strait',
      between: [first, second],
      ends: derived ? 'derived' : 'declared',
      ...(path.length === 0 ? {} : { path }),
      rule: input.rule ?? GEOGRAPHY_DEFAULTS.strait.rule,
      width: input.width ?? GEOGRAPHY_DEFAULTS.strait.width,
    });
  }

  // Sites.
  const sites: ResolvedSite[] = [];
  for (const input of siteInputs) {
    const at = toPoint(input.at);
    const here = surface(at.x, at.y);
    const onWater = input.onWater ?? false;
    const landId = here.surface === 'land' ? here.id : landAtOrNear(at.x, at.y);
    let lakeId: string | undefined;
    if (input.lake !== undefined && !refError(input.id, 'lake', input.lake, 'lake'))
      lakeId = input.lake;
    // A port of a lake stands on its shore, which a drawn polygon often covers.
    const lakeShore =
      lakeId !== undefined &&
      (() => {
        const lake = lakeById.get(lakeId);
        return (
          lake !== undefined &&
          (resolvedAreaContains(lake.area, at.x, at.y) ||
            areaBoundaryDistance(lake.area, at.x, at.y, aspect) <=
              GEOGRAPHY_DEFAULTS.lakeShoreReach)
        );
      })();
    if (!onWater && landId === undefined && !lakeShore)
      sink(
        'MAP_GEOGRAPHY_SITE_IN_WATER',
        'error',
        `Site ${input.id} (${input.kind}) is in ${here.surface}, not on land; set onWater for a site that stands in water, or lake for a port on a lake shore`,
        { featureId: input.id },
      );
    const regionId =
      landId === undefined
        ? undefined
        : (lands.find((land) => land.id === landId)?.regionId ??
          regions.find((region) => region.area !== undefined && containsInterior(region.area, at))
            ?.id);
    sites.push({
      ...baseOf(input),
      kind: 'site',
      siteKind: input.kind,
      at,
      importance: input.importance ?? GEOGRAPHY_DEFAULTS.site.importance,
      onWater,
      ...opt('country', input.country),
      ...(landId === undefined ? {} : { landId }),
      ...(regionId === undefined ? {} : { regionId }),
      ...(lakeId === undefined ? {} : { lakeId }),
    });
  }
  for (let i = 0; i < sites.length; i++)
    for (let j = i + 1; j < sites.length; j++)
      if (
        Math.abs(sites[i]!.at.x - sites[j]!.at.x) < 1e-6 &&
        Math.abs(sites[i]!.at.y - sites[j]!.at.y) < 1e-6
      )
        sink(
          'MAP_GEOGRAPHY_SITE_DUPLICATE_POSITION',
          'warning',
          `Sites ${sites[i]!.id} and ${sites[j]!.id} share a position`,
          { featureId: sites[j]!.id, other: sites[i]!.id },
        );

  // Roads and named places.
  const roads: ResolvedRoad[] = [];
  for (const input of roadInputs) {
    const path = buildPolyline(
      input.id,
      input.path,
      false,
      { halfWidth: 0.001, peak: 0 },
      frame,
      sink,
    );
    if (path === undefined) continue;
    roads.push({
      ...baseOf(input),
      kind: 'road',
      path,
      importance: input.importance ?? GEOGRAPHY_DEFAULTS.road.importance,
    });
  }
  const places: ResolvedPlace[] = [];
  for (const input of placeInputs) {
    const at = toPoint(input.at);
    places.push({
      ...baseOf(input),
      kind: 'place',
      placeKind: input.kind,
      at,
      surface: surface(at.x, at.y).surface,
    });
  }

  // Climate.
  const climateInput = model.climate;
  const climate: ResolvedClimate =
    climateInput === undefined
      ? emptyClimate()
      : {
          windFrom: climateInput.windFrom ?? GEOGRAPHY_DEFAULTS.climate.windFrom,
          temperature: {
            warm: climateInput.temperature?.warm ?? GEOGRAPHY_DEFAULTS.climate.temperature.warm,
            cold: climateInput.temperature?.cold ?? GEOGRAPHY_DEFAULTS.climate.temperature.cold,
          },
          warmBandY: climateInput.warmBandY ?? GEOGRAPHY_DEFAULTS.climate.warmBandY,
          rainScale: climateInput.rainScale ?? GEOGRAPHY_DEFAULTS.climate.rainScale,
          seasonality: climateInput.seasonality ?? GEOGRAPHY_DEFAULTS.climate.seasonality,
          declared: true,
        };
  if (climate.temperature.cold > climate.temperature.warm)
    sink(
      'MAP_GEOGRAPHY_CLIMATE_TEMPERATURE_ORDER',
      'error',
      'climate.temperature.cold must not exceed climate.temperature.warm',
      {},
    );

  // Whole-model checks on a coarse grid.
  const grid = analysisGrid(frame);
  coarseChecks({ grid, lands, seas, lakes, biomes, ranges, frame, sink });
  edgeChecks({
    lands,
    plateaus,
    ranges,
    volcanoes,
    sites,
    passes,
    rivers,
    frame,
    edgeBand,
    policy: options.edge,
    sink,
    grid,
  });
  if (lands.length === 0 && options.hasReference !== true)
    sink(
      'MAP_GEOGRAPHY_NO_LAND',
      'error',
      'The model has no lands and no reference image supplies a coast, so there is no world to build',
      {},
    );
  const names = new Map<string, string>();
  for (const feature of [
    ...seas,
    ...lands,
    ...regions,
    ...ranges,
    ...rivers,
    ...lakes,
    ...sites,
    ...volcanoes,
    ...straits,
  ]) {
    if (feature.name === undefined) continue;
    const key = `${feature.kind}:${feature.name}`;
    const other = names.get(key);
    if (other !== undefined)
      sink(
        'MAP_GEOGRAPHY_NAME_DUPLICATE',
        'warning',
        `${feature.kind} ${feature.id} repeats the name "${feature.name}" of ${other}`,
        {
          featureId: feature.id,
          other,
        },
      );
    else names.set(key, feature.id);
  }

  const parts = {
    frame,
    seas,
    lands,
    regions,
    ranges,
    passes,
    volcanoes,
    plateaus,
    rivers,
    lakes,
    biomes,
    straits,
    sites,
    roads,
    places,
    climate,
    ...opt('name', model.name),
    ...opt('description', model.description),
  };
  const hash = hashCanonical(canonicalModel(frame, parts));
  const geography = makeGeography({ ...parts, hash, pointCount: points });
  return finish(geography);
}

function containsInterior(area: ResolvedArea, point: GeoPoint): boolean {
  return resolvedAreaContains(area, point.x, point.y);
}

function landIdAt(lands: readonly ResolvedLand[], x: number, y: number): string | undefined {
  for (const land of lands) if (containsInterior(land.area, { x, y })) return land.id;
  return undefined;
}

function landContains(lands: readonly ResolvedLand[], x: number, y: number): boolean {
  return landIdAt(lands, x, y) !== undefined;
}

function limitDiagnostics(sorted: Diagnostic[]): Diagnostic[] {
  if (sorted.length <= GEOGRAPHY_DIAGNOSTIC_LIMIT) return sorted;
  const kept = sorted.slice(0, GEOGRAPHY_DIAGNOSTIC_LIMIT - 1);
  const omitted = sorted.slice(GEOGRAPHY_DIAGNOSTIC_LIMIT - 1);
  const counts: Record<string, number> = {};
  for (const item of omitted) counts[item.code] = (counts[item.code] ?? 0) + 1;
  const worst = omitted.some(({ severity }) => severity === 'error' || severity === 'blocker')
    ? 'error'
    : omitted.some(({ severity }) => severity === 'warning')
      ? 'warning'
      : 'info';
  kept.push({
    code: 'MAP_GEOGRAPHY_DIAGNOSTICS_TRUNCATED',
    severity: worst,
    category: 'map',
    message: `${omitted.length} further geography diagnostics were omitted`,
    details: { omitted: omitted.length, byCode: counts },
  });
  return kept;
}

function coarseChecks(input: {
  grid: RasterGrid;
  lands: readonly ResolvedLand[];
  seas: readonly ResolvedSea[];
  lakes: readonly ResolvedLake[];
  biomes: readonly ResolvedBiome[];
  ranges: readonly ResolvedRange[];
  frame: GeographyFrame;
  sink: Sink;
}): void {
  const { grid, lands, seas, biomes, sink } = input;
  const cells = grid.width * grid.height;
  const strip = { y0: 0, y1: grid.height };
  // Land ownership: who painted each cell, so overlaps are measurable.
  const landOwner = new Int32Array(cells).fill(-1);
  const landOverlap = new Map<number, number>();
  const landCells: number[] = [];
  for (const [index, land] of lands.entries()) {
    let count = 0;
    scanAreaStrip(land.area, grid, strip, (y, x0, x1) => {
      for (let x = x0; x < x1; x++) {
        const cell = y * grid.width + x;
        const owner = landOwner[cell]!;
        if (owner >= 0 && owner !== index) {
          const key = pairKey(owner, index);
          landOverlap.set(key, (landOverlap.get(key) ?? 0) + 1);
        } else landOwner[cell] = index;
        count++;
      }
    });
    landCells.push(count);
  }
  for (const [key, overlap] of [...landOverlap].sort((a, b) => a[0] - b[0])) {
    const i = Math.floor(key / 65_536),
      j = key % 65_536;
    const smaller = Math.max(1, Math.min(landCells[i]!, landCells[j]!));
    if (overlap / smaller > 0.01 && overlap >= 3)
      sink(
        'MAP_GEOGRAPHY_LAND_OVERLAP',
        'warning',
        `Lands ${lands[i]!.id} and ${lands[j]!.id} overlap by ${Math.round((100 * overlap) / smaller)}% of the smaller; the union is used`,
        {
          featureId: lands[j]!.id,
          other: lands[i]!.id,
        },
      );
  }
  const isLand = (cell: number) => landOwner[cell]! >= 0;
  for (const sea of seas) {
    let total = 0,
      onLand = 0;
    scanAreaStrip(sea.area, grid, strip, (y, x0, x1) => {
      for (let x = x0; x < x1; x++) {
        total++;
        if (isLand(y * grid.width + x)) onLand++;
      }
    });
    if (total > 0 && onLand / total > 0.1)
      sink(
        'MAP_GEOGRAPHY_SEA_OVER_LAND',
        'warning',
        `Sea ${sea.id} lies ${Math.round((100 * onLand) / total)}% over land; land wins where they overlap`,
        {
          featureId: sea.id,
        },
      );
  }
  // Biomes: equal-priority overlap of different biomes is a contradiction.
  const groups = new Map<number, ResolvedBiome[]>();
  for (const biome of biomes) {
    const list = groups.get(biome.z);
    if (list === undefined) groups.set(biome.z, [biome]);
    else list.push(biome);
  }
  const wateryAllowed = new Set(['ice', 'marsh']);
  for (const biome of biomes) {
    let total = 0,
      onLand = 0;
    scanAreaStrip(biome.area, grid, strip, (y, x0, x1) => {
      for (let x = x0; x < x1; x++) {
        total++;
        if (isLand(y * grid.width + x)) onLand++;
      }
    });
    if (total >= 3 && onLand / total < 0.5 && !wateryAllowed.has(biome.biome))
      sink(
        'MAP_GEOGRAPHY_BIOME_OVER_WATER',
        'error',
        `Biome ${biome.id} (${biome.biome}) lies ${Math.round((100 * (total - onLand)) / total)}% over water`,
        {
          featureId: biome.id,
        },
      );
  }
  for (const [z, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (list.length < 2) continue;
    const owner = new Int32Array(cells).fill(-1);
    const conflicts = new Map<number, number>();
    for (const [index, biome] of list.entries())
      scanAreaStrip(biome.area, grid, strip, (y, x0, x1) => {
        for (let x = x0; x < x1; x++) {
          const cell = y * grid.width + x;
          const previous = owner[cell]!;
          if (previous >= 0 && list[previous]!.biome !== biome.biome) {
            const key = pairKey(previous, index);
            conflicts.set(key, (conflicts.get(key) ?? 0) + 1);
          }
          if (previous < 0) owner[cell] = index;
        }
      });
    for (const [key, count] of [...conflicts].sort((a, b) => a[0] - b[0])) {
      if (count < 3) continue;
      const a = list[Math.floor(key / 65_536)]!,
        b = list[key % 65_536]!;
      sink(
        'MAP_GEOGRAPHY_BIOME_CONFLICT',
        'error',
        `Biomes ${a.id} (${a.biome}) and ${b.id} (${b.biome}) overlap with the same priority z=${z}; give one a higher z`,
        {
          featureId: b.id,
          other: a.id,
          z,
        },
      );
    }
  }
  // A range mostly over water is almost always a coordinate mistake.
  for (const range of input.ranges) {
    let water = 0;
    for (let index = 0; index < range.path.xs.length; index++) {
      const cx = Math.min(grid.width - 1, Math.floor(range.path.xs[index]! * grid.width));
      const cy = Math.min(grid.height - 1, Math.floor(range.path.ys[index]! * grid.height));
      if (!isLand(cy * grid.width + cx)) water++;
    }
    if (lands.length > 0 && water / range.path.xs.length > 0.5)
      sink(
        'MAP_GEOGRAPHY_RANGE_ON_WATER',
        'warning',
        `More than half the vertices of range ${range.id} are not on land`,
        {
          featureId: range.id,
        },
      );
  }
}

function edgeChecks(input: {
  lands: readonly ResolvedLand[];
  plateaus: readonly ResolvedPlateau[];
  ranges: readonly ResolvedRange[];
  volcanoes: readonly ResolvedVolcano[];
  sites: readonly ResolvedSite[];
  passes: readonly ResolvedPass[];
  rivers: readonly ResolvedRiver[];
  frame: GeographyFrame;
  edgeBand: { westEastPx: number; northSouthPx: number };
  policy: GeographyEdgePolicy | undefined;
  sink: Sink;
  grid: RasterGrid;
}): void {
  const { frame, edgeBand, sink, grid } = input;
  // A rim wall ends land inside the band by design, and `none` opts out of the check.
  if (input.policy?.mode === 'none' || input.policy?.mode === 'rim') return;
  const severity: DiagnosticSeverity = input.policy?.mode === 'sea-band' ? 'error' : 'warning';
  const fx = edgeBand.westEastPx / frame.width;
  const fy = edgeBand.northSouthPx / frame.height;
  const inBand = (x: number, y: number) => x < fx || x > 1 - fx || y < fy || y > 1 - fy;
  const report = (kind: string, id: string) =>
    sink(
      'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND',
      severity,
      `${kind} ${id} reaches the edge band (${edgeBand.westEastPx} pixels east and west, ${edgeBand.northSouthPx} north and south); land there is cut by the world wrap`,
      { featureId: id, bandPx: edgeBand.westEastPx, polarPx: edgeBand.northSouthPx },
    );
  const strip = { y0: 0, y1: grid.height };
  const bandColumns = Math.ceil(fx * grid.width),
    bandRows = Math.ceil(fy * grid.height);
  const touchesBand = (area: ResolvedArea): boolean => {
    if (!(
      area.bounds.x0 < fx ||
      area.bounds.x1 > 1 - fx ||
      area.bounds.y0 < fy ||
      area.bounds.y1 > 1 - fy
    ))
      return false;
    let touched = false;
    scanAreaStrip(area, grid, strip, (y, x0, x1) => {
      if (touched) return;
      if (
        y < bandRows ||
        y >= grid.height - bandRows ||
        x0 < bandColumns ||
        x1 > grid.width - bandColumns
      )
        touched = true;
    });
    return touched;
  };
  for (const land of input.lands) if (touchesBand(land.area)) report('Land', land.id);
  for (const plateau of input.plateaus)
    if (touchesBand(plateau.area)) report('Plateau', plateau.id);
  for (const range of input.ranges)
    for (let index = 0; index < range.path.xs.length; index++)
      if (inBand(range.path.xs[index]!, range.path.ys[index]!)) {
        report('Range', range.id);
        break;
      }
  for (const volcano of input.volcanoes)
    if (inBand(volcano.at.x, volcano.at.y)) report('Volcano', volcano.id);
  for (const site of input.sites) if (inBand(site.at.x, site.at.y)) report('Site', site.id);
  for (const pass of input.passes)
    if (inBand(pass.position.x, pass.position.y)) report('Pass', pass.id);
  for (const river of input.rivers) {
    const points = [river.source, ...river.via.map((p) => ({ type: 'point' as const, ...p }))];
    if (points.some((p) => 'x' in p && inBand(p.x, p.y))) report('River', river.id);
  }
}
