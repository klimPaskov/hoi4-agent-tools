/**
 * A new world from a compact description: land and sea, provinces, terrain, heights, rivers,
 * trees, colour maps, continents, strategic regions with weather, countries, states with their
 * population, buildings, resources and victory points, country history and flags, a start
 * bookmark, and localisation. Generation is deterministic for a seed. Positions and the supply
 * network are derived afterwards from the generated map by the shared planners in derived.ts.
 */
import { ServiceError } from '../core/result.js';
import { createBmp, type RgbColor } from './bmp.js';
import type { ReferenceWorldRaster } from './reference-world.js';
import { generateWorldDrainage } from './world-drainage.js';
import { generateWorldProvinces, type WorldProvinces } from './world-provinces.js';
import {
  clusterRegions,
  clusterStates,
  partitionWorldFromRequest,
  type WorldPartition,
} from './partition.js';
import { smoothDiagonalContacts } from './partition-fields.js';
import { partitionFieldsFromGeography } from './partition-geography.js';
import {
  provinceCountNote,
  surfacePartitionFields,
  type WorldPartitionSpec,
} from './world-partition.js';
import { adjacencyRowText, adjacencyRulesText, type CrossingPlan } from './gameplay/crossings.js';
import { convertInlandSeas } from './gameplay/inland-sea.js';
import { planEconomy, type EconomyPlan } from './gameplay/economy.js';
import { prepareGameplay, type GameplayBase } from './gameplay/prepare.js';
import type { RailCostModel } from './derived.js';
import { fractal, lattice } from './world-noise.js';
import {
  calibratedColourMap,
  COLOUR_CLASSES,
  type ColourClass,
  type ColourMapProfile,
  type WorldLook,
} from './colormap.js';
import {
  ambientObjectText,
  applyEdgePolicy,
  assertFeaturesOutsideBand,
  edgeWaterDarkness,
  RIM_COLOUR_FACTOR,
  rimAdjacencyRows,
  rimHeight,
  rimStrength,
  type EdgeNote,
  type EdgeSpec,
} from './world-edge.js';
import { landDistanceField, lakeHeight, normalizeLakes, waterColourLevel } from './water.js';
import type { ResolvedGeography } from './geography/index.js';
import { overlayGeographyLakes, rasterizeGeographyKind } from './relief/land.js';
import { synthesizeTerrain, type SynthesizedTerrain } from './relief/terrain-synthesis.js';
import type { ReliefSettings } from './relief/macro-relief.js';

export interface WorldCountry {
  tag: string;
  name: string;
  adjective?: string;
  color?: RgbColor;
  /** Relative share of the land; default 1. */
  share?: number;
  ideology?: 'democratic' | 'communism' | 'fascism' | 'neutrality';
}

export interface WorldSpec {
  worldName?: string;
  startingScenario?: boolean;
  width: number;
  height: number;
  seed: number;
  landCoverage: number;
  continents: number;
  /** Optional land outlines in top-left pixel coordinates; they replace generated land. */
  landPolygons?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
  landProvincePixels: number;
  seaProvincePixels: number;
  provincesPerState: number;
  landProvincesPerRegion: number;
  seaProvincesPerRegion: number;
  countries: readonly WorldCountry[];
  continentNames?: readonly string[];
  startDate: string;
  rivers: number;
  /** Resolved reference data is internal; callers provide a guarded workspace image path. */
  referenceSurface?: ReferenceWorldRaster;
  referenceCities?: ReadonlyArray<{ name: string; x: number; y: number; countryTag?: string }>;
  referenceLabels?: ReadonlyArray<{
    name: string;
    x: number;
    y: number;
    kind: 'state' | 'country' | 'city' | 'sea' | 'region' | 'mountain' | 'geography';
  }>;
  /** Resolved world edge policy (ADR 0061); absent keeps the previous behaviour. */
  edge?: EdgeSpec;
  /** Write the base map's north and south frame borders in `ambient_object.txt`. */
  ambientFrame?: boolean;
  /**
   * A resolved geography model (ADR 0056): land, relief and rivers are synthesised from it. The
   * model must have been resolved for this map size. A reference picture, when given, still
   * supplies the coast and the terrain classes.
   */
  geography?: ResolvedGeography;
  relief?: Partial<ReliefSettings>;
  /** Share of land pixels the river network covers (geography worlds); default 2%. */
  riverDensity?: number;
  /** Largest number of unnamed river systems (geography worlds); absent keeps every system. */
  riverCount?: number;
  /** `legacy` keeps the original flat tints; `calibrated` follows ADR 0054. */
  colormapProfile?: ColourMapProfile;
  look?: WorldLook;
  /**
   * Opt-in feature-aware provinces, states and regions (ADR 0058). Absent or `legacy` keeps the
   * warped Voronoi provinces and breadth-first clusters, byte for byte.
   */
  partition?: WorldPartitionSpec;
  /** Colour overrides by class for `look: 'custom'`. */
  colormapPalette?: Partial<Record<ColourClass, readonly [number, number, number]>>;
  /**
   * Also write a crossing for every narrow channel the model does not declare (ADR 0062); the
   * largest gap in pixels. Needs a geography.
   */
  autoStraits?: { maxGapPx: number };
  /**
   * `geography` (default for a geography world) plans ports, development, resources, victory
   * points and names from the model; `legacy` keeps the random economy (ADR 0063).
   */
  developmentModel?: 'geography' | 'legacy';
  /** Most impassable adjacency rows (default 2,000); lowered by tests of the limit. */
  impassableRowLimit?: number;
}

/** Installed base-game data that makes generated files match the game's conventions. */
export interface WorldContext {
  palettes: Partial<Record<'terrain' | 'rivers' | 'trees' | 'cities', RgbColor[]>>;
  /** Graphical terrain palette index for each provincial terrain type. */
  terrainIndex?: ReadonlyMap<string, number>;
  stateCategories?: ReadonlySet<string>;
  /** Every graphical terrain entry of the active `common/terrain` files, by index. */
  terrainEntries?: ReadonlyArray<{
    name: string;
    index: number;
    type: string;
    texture?: number;
    permSnow: boolean;
  }>;
  /** Entries never chosen because the engine draws no atlas tile for them (`texture = 255`). */
  unrenderedTerrain?: ReadonlyArray<{ name: string; index: number; type: string; reason: string }>;
  /** Existing identifiers remain declared for shared portrait and script references. */
  continentKeys?: readonly string[];
  inheritedCountryTags?: readonly string[];
  mapRoot: string;
  statesRoot: string;
  localisationRoot: string;
}

export interface WorldFile {
  relativePath: string;
  content: Buffer;
  mediaType: string;
}

/** A diagnostic raised while generating; the planner reports it with its code. */
export interface WorldNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface GeneratedWorld {
  files: WorldFile[];
  /** The synthesised terrain and its fields, for worlds built from a geography model (ADR 0056). */
  terrain?: SynthesizedTerrain;
  /** Terrain-aware railway costs for `planSupplyRebuild` (geography worlds, ADR 0063). */
  railCost?: RailCostModel;
  /** The crossing and economy plans of a geography world, for reports and tests. */
  gameplay?: { crossings: CrossingPlan; economy: EconomyPlan | undefined };
  warnings: string[];
  notes: WorldNote[];
  summary: {
    width: number;
    height: number;
    landProvinces: number;
    seaProvinces: number;
    lakeProvinces: number;
    states: number;
    landRegions: number;
    seaRegions: number;
    countries: number;
    rivers: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness and noise

export class Random {
  #state: number;
  constructor(seed: number) {
    this.#state = (seed ^ 0x9e3779b9) >>> 0;
  }
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  int(limit: number): number {
    return Math.floor(this.next() * limit);
  }
}

// ---------------------------------------------------------------------------------------------
// Raster helpers

const LAND = 1;
const SEA = 0;
const LAKE = 2;

function neighbors4(width: number, height: number, pixel: number): number[] {
  const x = pixel % width;
  const y = (pixel - x) / width;
  const result: number[] = [];
  if (x > 0) result.push(pixel - 1);
  if (x < width - 1) result.push(pixel + 1);
  if (y > 0) result.push(pixel - width);
  if (y < height - 1) result.push(pixel + width);
  return result;
}

/** Connected components of equal values; returns the component of each pixel and their sizes. */
function components(
  values: Uint8Array,
  width: number,
  height: number,
): { component: Int32Array; sizes: number[]; values: number[] } {
  const component = new Int32Array(values.length).fill(-1);
  const sizes: number[] = [];
  const kinds: number[] = [];
  const queue = new Int32Array(values.length);
  for (let start = 0; start < values.length; start += 1) {
    if (component[start] !== -1) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = id;
    while (head < tail) {
      const pixel = queue[head++]!;
      for (const next of neighbors4(width, height, pixel))
        if (component[next] === -1 && values[next] === values[start]) {
          component[next] = id;
          queue[tail++] = next;
        }
    }
    sizes.push(tail);
    kinds.push(values[start]!);
  }
  return { component, sizes, values: kinds };
}

function pointInPolygon(x: number, y: number, points: ReadonlyArray<{ x: number; y: number }>) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!;
    const b = points[previous]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------------------------
// Land, water and height

interface Surface {
  kind: Uint8Array;
  elevation: Float32Array;
  moisture: Float32Array;
}

function generateSurface(spec: WorldSpec, random: Random): Surface {
  const { width, height } = spec;
  const total = width * height;
  const elevation = new Float32Array(total);
  const moisture = new Float32Array(total);
  const kind = new Uint8Array(total);
  const margin = Math.max(4, Math.round(width * 0.02));
  const polar = Math.max(4, Math.round(height * 0.05));
  const scale = Math.max(width, height) / 6;
  const centers = Array.from({ length: Math.max(1, spec.continents) }, () => ({
    x: margin * 3 + random.next() * (width - margin * 6),
    y: polar * 3 + random.next() * (height - polar * 6),
    radius:
      (0.55 + random.next() * 0.6) *
      Math.sqrt((width * height * spec.landCoverage) / Math.max(1, spec.continents) / Math.PI),
  }));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      let blob = 0;
      for (const center of centers) {
        const distance = Math.hypot(x - center.x, y - center.y) / center.radius;
        blob = Math.max(blob, Math.exp(-distance * distance * 1.4));
      }
      const noise = fractal(spec.seed, x, y, scale);
      elevation[pixel] = spec.landPolygons === undefined ? blob * 0.65 + noise * 0.55 : noise;
      moisture[pixel] = fractal(spec.seed + 7919, x, y, scale * 0.8, 4);
    }
  if (spec.landPolygons !== undefined) {
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        if (spec.landPolygons.some((polygon) => pointInPolygon(x + 0.5, y + 0.5, polygon)))
          kind[y * width + x] = LAND;
  } else {
    // The land threshold that gives the requested coverage.
    const sorted = Float32Array.from(elevation).sort();
    const threshold = sorted[Math.min(total - 1, Math.floor(total * (1 - spec.landCoverage)))]!;
    for (let pixel = 0; pixel < total; pixel += 1)
      kind[pixel] = elevation[pixel]! >= threshold ? LAND : SEA;
  }
  // Keep the wrapping east-west seam and the polar rows at sea, so no land touches an edge.
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (x < margin || x >= width - margin || y < polar || y >= height - polar)
        kind[y * width + x] = SEA;
  // Tiny islands sink; enclosed water becomes land when small and a lake when large.
  const parts = components(kind, width, height);
  const minimumIsland = Math.max(40, Math.round(spec.landProvincePixels / 4));
  const ocean = new Set<number>();
  for (let x = 0; x < width; x += 1) ocean.add(parts.component[x]!);
  for (let pixel = 0; pixel < total; pixel += 1) {
    const part = parts.component[pixel]!;
    if (kind[pixel] === LAND && parts.sizes[part]! < minimumIsland) kind[pixel] = SEA;
    else if (kind[pixel] === SEA && !ocean.has(part))
      kind[pixel] = parts.sizes[part]! < spec.landProvincePixels * 1.5 ? LAND : LAKE;
  }
  // Normalised land height above the coast, and sea depth below it.
  const coastDistance = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < total; pixel += 1)
    if (
      kind[pixel] === LAND &&
      neighbors4(width, height, pixel).some((next) => kind[next] !== LAND)
    ) {
      coastDistance[pixel] = 0;
      queue[tail++] = pixel;
    }
  while (head < tail) {
    const pixel = queue[head++]!;
    for (const next of neighbors4(width, height, pixel))
      if (coastDistance[next] === -1) {
        coastDistance[next] = coastDistance[pixel]! + 1;
        queue[tail++] = next;
      }
  }
  for (let pixel = 0; pixel < total; pixel += 1) {
    const inland = Math.min(1, (coastDistance[pixel] ?? 0) / 80);
    const x = pixel % width;
    const y = (pixel - x) / width;
    const ridges = Math.abs(fractal(spec.seed + 104729, x, y, scale / 2, 4) - 0.5) * 2;
    elevation[pixel] =
      kind[pixel] === LAND
        ? Math.min(1, inland * (0.12 + Math.pow(1 - ridges, 5) * 0.65))
        : -Math.min(1, (coastDistance[pixel] ?? 0) / 30);
  }
  return { kind, elevation, moisture };
}

/**
 * Surface of a world described by a geography model: land and lakes from the model (or lakes laid
 * over a reference picture's coast); elevation is filled in by the terrain synthesis later.
 */
function geographySurface(
  spec: WorldSpec,
  geography: ResolvedGeography,
  reference: ReferenceWorldRaster | undefined,
): Surface {
  const { width, height } = spec;
  const total = width * height;
  const options = { width, height, seed: spec.seed };
  let kind: Uint8Array;
  let moisture: Float32Array;
  if (reference === undefined) {
    kind = rasterizeGeographyKind(geography, options);
    moisture = new Float32Array(total);
    const scale = Math.max(width, height) / 6;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        moisture[y * width + x] = fractal(spec.seed + 7919, x, y, scale * 0.8, 4);
  } else {
    kind = new Uint8Array(reference.kind);
    overlayGeographyLakes(kind, geography, options);
    moisture = new Float32Array(reference.moisture);
  }
  return { kind, elevation: new Float32Array(total), moisture };
}

function terrainSummaryNote(terrain: SynthesizedTerrain, geography: ResolvedGeography): WorldNote {
  const { relief, riverStatistics } = terrain;
  return {
    code: 'MAP_RELIEF_SYNTHESIZED',
    severity: 'info',
    message: `Synthesised relief and rivers from the geography model: land height median ${relief.median}, 99th percentile ${relief.p99}, maximum ${relief.maximum}, mean step ${relief.meanStep.toFixed(2)} per half-resolution pixel; ${riverStatistics.count} rivers (${riverStatistics.named} named) on ${(riverStatistics.landShare * 100).toFixed(2)}% of the land`,
    details: {
      modelHash: geography.hash,
      relief,
      rivers: riverStatistics,
      // The first of the named rivers only: the response budget is shared with everything else the
      // world reports, and a river that did not complete is always listed.
      namedRivers: terrain.rivers
        .filter((river) => river.named && river.junction !== 'distributary')
        .slice(0, 24)
        .map(({ id, pixels, mouth, complete }) => ({ id, pixels, mouth, complete })),
      incompleteRivers: terrain.rivers
        .filter((river) => river.named && !river.complete)
        .slice(0, 24)
        .map(({ id }) => id),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Grouping provinces into regions and states

/** Grow clusters of about `target` members over a graph from spread-out seeds. */
export function growClusters(
  members: readonly number[],
  neighbors: (id: number) => Iterable<number>,
  target: number,
  random: Random,
  weight: (id: number) => number = () => 1,
): Map<number, number> {
  const cluster = new Map<number, number>();
  const memberSet = new Set(members);
  const pending = new Set(members);
  let clusterId = 0;
  while (pending.size > 0) {
    // Start each cluster from the remaining member with the fewest remaining neighbours, so
    // clusters fill pockets before open ground.
    const ordered = [...pending];
    const start = ordered[random.int(ordered.length)]!;
    const queue = [start];
    let filled = 0;
    while (queue.length > 0 && filled < target) {
      const current = queue.shift()!;
      if (!pending.has(current)) continue;
      pending.delete(current);
      cluster.set(current, clusterId);
      filled += weight(current);
      for (const next of neighbors(current))
        if (memberSet.has(next) && pending.has(next)) queue.push(next);
    }
    clusterId += 1;
  }
  // Absorb tiny leftover clusters into a neighbouring one.
  const sizes = new Map<number, number>();
  for (const id of cluster.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  for (const member of members) {
    const id = cluster.get(member)!;
    if ((sizes.get(id) ?? 0) * 3 >= target || target <= 2) continue;
    for (const next of neighbors(member)) {
      const other = cluster.get(next);
      if (other !== undefined && other !== id && memberSet.has(next)) {
        sizes.set(id, (sizes.get(id) ?? 1) - 1);
        sizes.set(other, (sizes.get(other) ?? 0) + 1);
        cluster.set(member, other);
        break;
      }
    }
  }
  // Absorption can empty a cluster. Native region identifiers and reported counts must agree.
  const dense = new Map(
    [...new Set(cluster.values())].sort((a, b) => a - b).map((id, index) => [id, index]),
  );
  for (const [member, id] of cluster) cluster.set(member, dense.get(id)!);
  return cluster;
}

// ---------------------------------------------------------------------------------------------
// File writers

function bmpPalette(
  base: RgbColor[] | undefined,
  fallback: (index: number) => RgbColor,
): RgbColor[] {
  return Array.from({ length: 256 }, (_, index) => base?.[index] ?? fallback(index));
}

/** Uncompressed 32-bit DDS (A8R8G8B8, one mip level), as the map colour maps use. */
export function encodeDds(width: number, height: number, bgra: Uint8Array): Buffer {
  const header = Buffer.alloc(128);
  header.write('DDS ', 0, 'ascii');
  header.writeUInt32LE(124, 4);
  header.writeUInt32LE(0x100f, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(width * 4, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(1, 28);
  header.writeUInt32LE(32, 76);
  header.writeUInt32LE(0x41, 80);
  header.writeUInt32LE(32, 88);
  header.writeUInt32LE(0x00ff0000, 92);
  header.writeUInt32LE(0x0000ff00, 96);
  header.writeUInt32LE(0x000000ff, 100);
  header.writeUInt32LE(0xff000000, 104);
  header.writeUInt32LE(0x1000, 108);
  return Buffer.concat([header, Buffer.from(bgra)]);
}

/** Uncompressed 32-bit TGA with a bottom-left origin, as country flags use. */
export function encodeTga(
  width: number,
  height: number,
  rgba: (x: number, y: number) => RgbColor,
): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 32;
  header[17] = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1)
    for (let x = 0; x < width; x += 1) {
      const color = rgba(x, height - 1 - row);
      const offset = (row * width + x) * 4;
      pixels[offset] = color.b;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.r;
      pixels[offset + 3] = 255;
    }
  return Buffer.concat([header, pixels]);
}

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function localisation(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const escape = (value: string) =>
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\r', '\\r')
      .replaceAll('\n', '\\n');
  return Buffer.from(
    `\ufeffl_english:\n${entries.map(([key, value]) => ` ${key}: "${escape(value)}"`).join('\n')}\n`,
    'utf8',
  );
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9 _-]/gu, '').trim() || 'Country';
}

const DEFAULT_TERRAIN_INDEX = new Map<string, number>([
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
 * A graphical terrain index of the base game's numbering (farmland 5, sparse forest 4, mountain
 * with grass 20), used only when the active terrain files confirm that index still has that
 * category and draws a tile. Without any terrain files the base game's numbering is assumed.
 */
function terrainVariant(context: WorldContext, index: number, type: string): number | undefined {
  const entries = context.terrainEntries;
  if (entries === undefined) return context.terrainIndex === undefined ? index : undefined;
  return entries.some(
    (entry) =>
      entry.index === index && entry.type === type && entry.texture !== 255 && !entry.permSnow,
  )
    ? index
    : undefined;
}

/** Approximate seasonal weather: signed latitude is positive north of the equator. */
function weatherBlock(signedLatitude: number, desert: boolean): string {
  const latitude = Math.abs(signedLatitude);
  const periods: string[] = [];
  const days = [30, 27, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30];
  for (let month = 0; month < 12; month += 1) {
    const season = Math.cos(((month - 6.5) / 12) * Math.PI * 2);
    const mean = 30 - latitude * 45 + season * (6 + latitude * 18) * Math.sign(signedLatitude);
    const low = Math.round(mean - 8);
    const high = Math.round(mean + 8);
    const snow = Math.max(0, Math.min(0.6, (-mean + 2) / 20));
    const rain = desert ? 0.1 : Math.max(0.2, 0.9 - snow);
    periods.push(
      [
        '\t\tperiod={',
        `\t\t\tbetween={ 0.${month} ${days[month]}.${month} }`,
        `\t\t\ttemperature={ ${low.toFixed(1)} ${high.toFixed(1)} }`,
        '\t\t\tno_phenomenon=0.500',
        `\t\t\train_light=${rain.toFixed(3)}`,
        `\t\t\train_heavy=${(rain * 0.15).toFixed(3)}`,
        `\t\t\tsnow=${snow.toFixed(3)}`,
        `\t\t\tblizzard=${(snow * 0.25).toFixed(3)}`,
        '\t\t\tarctic_water=0.000',
        `\t\t\tmud=${(desert ? 0.05 : 0.3).toFixed(3)}`,
        `\t\t\tsandstorm=${(desert ? 0.2 : 0).toFixed(3)}`,
        `\t\t\tmin_snow_level=${(snow > 0.3 ? 0.1 : 0).toFixed(3)}`,
        '\t\t}',
      ].join('\n'),
    );
  }
  return `\tweather={\n${periods.join('\n')}\n\t}`;
}

// ---------------------------------------------------------------------------------------------
// Generation

interface StateDraft {
  id: number;
  provinces: number[];
  owner: string;
  region: number;
  capital: number;
  manpower: number;
  category: string;
  infrastructure: number;
  civilian: number;
  military: number;
  dockyard: number;
  airBase: number;
  resources: Map<string, number>;
  victoryPoints: Map<number, number>;
  navalBases: Map<number, number>;
  /** Land fort levels by province, from the passes of the model. */
  forts: Map<number, number>;
}

export function generateWorld(spec: WorldSpec, context: WorldContext): GeneratedWorld {
  const { width, height } = spec;
  if (width % 256 !== 0 || height % 256 !== 0)
    throw new ServiceError(
      'MAP_WORLD_DIMENSIONS_INVALID',
      'Both map dimensions must be multiples of 256',
      { width, height },
    );
  if (width * height > 13_238_272)
    throw new ServiceError(
      'MAP_WORLD_DIMENSIONS_INVALID',
      'The game draws at most 13,238,272 province pixels; choose a smaller width or height',
      { width, height },
    );
  const tags = new Set<string>();
  for (const country of spec.countries) {
    if (!/^[A-Z][A-Z0-9]{2}$/u.test(country.tag) || tags.has(country.tag))
      throw new ServiceError(
        'MAP_WORLD_COUNTRY_TAG_INVALID',
        `Country tags must be three unique characters, uppercase letter first: ${country.tag}`,
      );
    tags.add(country.tag);
  }
  const random = new Random(spec.seed);
  // The game warns about provinces wider or taller than an eighth of the map; keep cells well
  // inside that.
  const cellLimit = Math.floor(Math.min(width, height) / 14) ** 2;
  spec = {
    ...spec,
    landProvincePixels: Math.min(spec.landProvincePixels, cellLimit),
    seaProvincePixels: Math.min(spec.seaProvincePixels, cellLimit),
  };
  const reference = spec.referenceSurface;
  if (reference !== undefined && (reference.width !== width || reference.height !== height))
    throw new ServiceError(
      'MAP_WORLD_REFERENCE_DIMENSIONS',
      'Reference raster dimensions do not match the world',
    );
  const geography = spec.geography;
  if (
    geography !== undefined &&
    (geography.frame.width !== width || geography.frame.height !== height)
  )
    throw new ServiceError(
      'MAP_GEOGRAPHY_FRAME_MISMATCH',
      'The geography model was resolved for a different map size than the world being created',
      {
        model: { width: geography.frame.width, height: geography.frame.height },
        world: { width, height },
      },
    );
  const surface: Surface =
    geography !== undefined
      ? geographySurface(spec, geography, reference)
      : reference === undefined
        ? generateSurface(spec, random)
        : {
            kind: new Uint8Array(reference.kind),
            elevation: new Float32Array(reference.elevation),
            moisture: new Float32Array(reference.moisture),
          };
  const notes: WorldNote[] = [];
  const edge: EdgeSpec = spec.edge ?? { mode: 'none', bandPx: 0, polarPx: 0, rimPx: 0 };
  if (edge.mode !== 'none') {
    assertFeaturesOutsideBand(
      edge,
      width,
      height,
      (spec.referenceCities ?? []).map(({ name, x, y }) => ({ name, x, y, kind: 'city' })),
    );
    const applied = applyEdgePolicy(
      surface.kind,
      surface.elevation,
      width,
      height,
      edge,
      spec.seed,
      Math.max(40, Math.round(spec.landProvincePixels / 4)),
    );
    notes.push(...applied.notes.map((note: EdgeNote): WorldNote => note));
  }
  // Lakes need a minimum size and may not touch the open sea (ADR 0053).
  for (const note of normalizeLakes(surface.kind, surface.elevation, width, height))
    notes.push({
      code: note.code,
      severity: 'warning',
      message: `${note.message} near (${note.x}, ${note.y})`,
      details: { pixels: note.pixels, x: note.x, y: note.y },
    });
  // A geography model gets its relief and rivers from the synthesis of ADR 0056; every other world
  // keeps the original elevation classes and drainage, byte for byte.
  const synthesized =
    geography === undefined
      ? undefined
      : synthesizeTerrain({
          geography,
          width,
          height,
          seed: spec.seed,
          kind: surface.kind,
          relief: spec.relief,
          rivers: { density: spec.riverDensity, count: spec.riverCount },
          adjustHeight:
            edge.mode === 'rim'
              ? (x, _y, value) => rimHeight(value, rimStrength(edge, width, x))
              : undefined,
        });
  if (synthesized !== undefined) {
    for (const note of synthesized.notes) {
      if (note.severity === 'error') throw new ServiceError(note.code, note.message, note.details);
      notes.push({
        code: note.code,
        severity: note.severity,
        message: note.message,
        ...(note.details === undefined ? {} : { details: note.details }),
      });
    }
    notes.push(terrainSummaryNote(synthesized, geography!));
  }
  // A lake the model calls an inland sea becomes navigable water (ADR 0062).
  const inland =
    geography === undefined || synthesized === undefined
      ? undefined
      : convertInlandSeas(surface.kind, surface.elevation, width, height, geography);
  if (inland !== undefined && geography !== undefined) {
    for (const { lake, pixels } of inland.converted)
      notes.push({
        code: 'MAP_INLAND_SEA_CREATED',
        severity: 'info',
        message: `Lake ${geography.lakes[lake]!.id} is an inland sea: its ${pixels} water pixels are written as sea provinces so ships and ports can use them`,
        details: { lakeId: geography.lakes[lake]!.id, pixels },
      });
    for (const lake of inland.missing)
      notes.push({
        code: 'MAP_INLAND_SEA_NO_WATER',
        severity: 'info',
        message: `Lake ${geography.lakes[lake]!.id} is an inland sea but has no separate water body: it joined the open sea or was too small to keep`,
        details: { lakeId: geography.lakes[lake]!.id },
      });
  }
  const drainage =
    synthesized === undefined
      ? generateWorldDrainage({
          width,
          height,
          kind: surface.kind,
          elevation: surface.elevation,
          seed: spec.seed,
          count: spec.rivers,
          ...(reference === undefined ? {} : { referenceRivers: reference.rivers }),
        })
      : {
          riverPixels: synthesized.riverBitmap,
          elevation: synthesized.elevation,
          count: synthesized.riverStatistics.count,
          warnings: [] as string[],
        };
  surface.elevation = drainage.elevation;
  let featurePartition: WorldPartition | undefined;
  let provinces: WorldProvinces;
  if (spec.partition?.mode === 'feature-aware') {
    if (spec.partition.fields === undefined) {
      // A coast that touches itself only at corners cannot be cut into valid provinces.
      const smoothed = smoothDiagonalContacts(surface.kind, width, height);
      for (const pixel of smoothed) {
        const isLand = surface.kind[pixel] === LAND;
        surface.elevation[pixel] = isLand ? 0.02 : -0.02;
        drainage.riverPixels[pixel] = isLand ? 255 : 254;
      }
      if (smoothed.length > 0)
        notes.push({
          code: 'MAP_PARTITION_MASK_SMOOTHED',
          severity: 'info',
          message: `Changed ${smoothed.length} coast pixel(s) that touched their own kind only at a corner, which no province partition can represent`,
          details: { pixels: smoothed.length },
        });
    }
    // A geography model adds its named regions and seas and its wall ranges to the fields, so
    // no province straddles a wall and sea and land regions follow the model (ADR 0058, 0062).
    const surfaceFields =
      spec.partition.fields ??
      surfacePartitionFields({
        width,
        height,
        kind: surface.kind,
        elevation: surface.elevation,
        moisture: surface.moisture,
        riverPixels: drainage.riverPixels,
        ...(reference === undefined ? {} : { referenceTerrain: reference.terrain }),
      });
    featurePartition = partitionWorldFromRequest(
      spec.partition.fields === undefined && geography !== undefined
        ? partitionFieldsFromGeography(surfaceFields, geography)
        : surfaceFields,
      spec.seed,
      spec.partition.tuning,
      {
        landProvincePixels: spec.landProvincePixels,
        seaProvincePixels: spec.seaProvincePixels,
        provincesPerState: spec.provincesPerState,
        landProvincesPerRegion: spec.landProvincesPerRegion,
        seaProvincesPerRegion: spec.seaProvincesPerRegion,
      },
    );
    provinces = featurePartition.provinces;
    for (const note of featurePartition.notes) notes.push(note);
  } else
    provinces = generateWorldProvinces({
      width,
      height,
      seed: spec.seed,
      kind: surface.kind,
      elevation: surface.elevation,
      moisture: surface.moisture,
      landProvincePixels: spec.landProvincePixels,
      seaProvincePixels: spec.seaProvincePixels,
    });
  const count = provinces.kind.length;
  const countNote = provinceCountNote(
    count,
    featurePartition === undefined ? 'legacy' : 'feature-aware',
  );
  if (countNote !== undefined) notes.push(countNote);
  // Crossings, passes and walls of a geography world (ADR 0062).
  const gameplay: GameplayBase | undefined =
    geography === undefined || synthesized === undefined
      ? undefined
      : prepareGameplay({
          width,
          height,
          geography,
          provinces,
          heights: synthesized.heights,
          riverBitmap: drainage.riverPixels,
          fields: synthesized.fields,
          riverPaths: synthesized.riverPaths,
          autoStraits: spec.autoStraits,
          impassableLimit: spec.impassableRowLimit,
          inlandSeas: inland?.converted.map(({ lake }) => lake) ?? [],
        });
  if (gameplay !== undefined) for (const note of gameplay.notes) notes.push(note);
  const center = (id: number) => ({
    x: provinces.sumX[id]! / provinces.size[id]!,
    y: provinces.sumY[id]! / provinces.size[id]!,
  });
  const landIds = [...Array(count).keys()].filter((id) => provinces.kind[id] === LAND);
  const seaIds = [...Array(count).keys()].filter((id) => provinces.kind[id] === SEA);
  const lakeIds = [...Array(count).keys()].filter((id) => provinces.kind[id] === LAKE);
  if (landIds.length < spec.countries.length)
    throw new ServiceError(
      'MAP_WORLD_LAND_TOO_SMALL',
      'The generated land has fewer provinces than countries; raise landCoverage or lower landProvincePixels',
      { landProvinces: landIds.length, countries: spec.countries.length },
    );
  const coastal = (id: number) =>
    [...provinces.neighbors[id]!].some((other) =>
      provinces.kind[id] === SEA
        ? provinces.kind[other] === LAND
        : provinces.kind[other] === SEA && provinces.kind[id] === LAND,
    );
  // Province mean elevation, moisture and latitude decide terrain.
  const meanElevation = new Float64Array(count);
  const meanMoisture = new Float64Array(count);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const id = provinces.pixel[pixel]!;
    meanElevation[id]! += surface.elevation[pixel]!;
    meanMoisture[id]! += surface.moisture[pixel]!;
  }
  const latitude = (id: number) => Math.abs(center(id).y / height - 0.5) * 2;
  const terrain = new Map<number, string>();
  const elevations = landIds
    .map((id) => meanElevation[id]! / provinces.size[id]!)
    .sort((a, b) => a - b);
  const quantile = (q: number) => elevations[Math.floor(q * (elevations.length - 1))] ?? 0;
  const mountainLevel = quantile(0.88);
  const hillLevel = quantile(0.72);
  for (const id of landIds) {
    const elevation = meanElevation[id]! / provinces.size[id]!;
    const wet = meanMoisture[id]! / provinces.size[id]!;
    const lat = latitude(id);
    terrain.set(
      id,
      elevation >= mountainLevel
        ? 'mountain'
        : elevation >= hillLevel
          ? 'hills'
          : lat < 0.3 && wet > 0.55
            ? 'jungle'
            : lat > 0.25 && lat < 0.55 && wet < 0.42
              ? 'desert'
              : wet > 0.62 && elevation < quantile(0.2)
                ? 'marsh'
                : wet > 0.5
                  ? 'forest'
                  : 'plains',
    );
  }
  for (const id of seaIds) terrain.set(id, 'ocean');
  for (const id of lakeIds) terrain.set(id, 'lakes');
  const referenceTerrainNames = [
    'plains',
    'forest',
    'desert',
    'mountain',
    'plains',
    'mountain',
    'hills',
    'marsh',
    'jungle',
  ] as const;
  if (reference !== undefined) {
    const votes = new Uint32Array(count * referenceTerrainNames.length);
    for (let pixel = 0; pixel < width * height; pixel += 1)
      if (surface.kind[pixel] === LAND)
        votes[
          provinces.pixel[pixel]! * referenceTerrainNames.length + reference.terrain[pixel]!
        ]! += 1;
    for (const id of landIds) {
      let selected = 0;
      for (let type = 1; type < referenceTerrainNames.length; type += 1)
        if (
          votes[id * referenceTerrainNames.length + type]! >
          votes[id * referenceTerrainNames.length + selected]!
        )
          selected = type;
      terrain.set(id, referenceTerrainNames[selected]!);
    }
  }
  // Continents: the largest land masses, with islands joining the nearest one.
  const landParts = new Map<number, number>();
  {
    let part = 0;
    for (const start of landIds) {
      if (landParts.has(start)) continue;
      const queue = [start];
      landParts.set(start, part);
      while (queue.length > 0) {
        const current = queue.pop()!;
        for (const next of provinces.neighbors[current]!)
          if (provinces.kind[next] === LAND && !landParts.has(next)) {
            landParts.set(next, part);
            queue.push(next);
          }
      }
      part += 1;
    }
  }
  const partSizes = new Map<number, number>();
  for (const [id, part] of landParts)
    partSizes.set(part, (partSizes.get(part) ?? 0) + provinces.size[id]!);
  const majorParts = [...partSizes]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, Math.max(1, spec.continents))
    .map(([part]) => part);
  const partCenter = (part: number) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const [id, p] of landParts)
      if (p === part) {
        sx += provinces.sumX[id]!;
        sy += provinces.sumY[id]!;
        n += provinces.size[id]!;
      }
    return { x: sx / n, y: sy / n };
  };
  const majorCenters = majorParts.map(partCenter);
  const continentOfPart = new Map<number, number>();
  for (const part of partSizes.keys()) {
    const index = majorParts.indexOf(part);
    if (index >= 0) {
      continentOfPart.set(part, index + 1);
      continue;
    }
    const c = partCenter(part);
    let best = 0;
    for (const [position, majorCenter] of majorCenters.entries())
      if (
        Math.hypot(majorCenter.x - c.x, majorCenter.y - c.y) <
        Math.hypot(majorCenters[best]!.x - c.x, majorCenters[best]!.y - c.y)
      )
        best = position;
    continentOfPart.set(part, best + 1);
  }
  const continentNames = majorParts.map(
    (_, index) =>
      spec.continentNames?.[index] ?? `Continent ${String.fromCharCode(65 + (index % 26))}`,
  );
  // Countries: grow territories from spread-out capitals in proportion to their shares.
  const owner = new Map<number, number>();
  const countryCount = spec.countries.length;
  const interpretationWarnings: string[] = [];
  const referenceOwners = new Map<number, number>();
  if (reference?.inferredCountries.length === countryCount && countryCount > 1) {
    const indexes = new Map<number, number>();
    const unresolved: number[] = [];
    for (const [index, country] of spec.countries.entries()) {
      const color = country.color;
      const matches =
        color === undefined
          ? []
          : reference.inferredCountries
              .map((region) => ({
                id: region.id,
                distance:
                  (region.color.r - color.r) ** 2 +
                  (region.color.g - color.g) ** 2 +
                  (region.color.b - color.b) ** 2,
              }))
              .sort((a, b) => a.distance - b.distance || a.id - b.id);
      const colorId =
        matches[0] !== undefined &&
        matches[0].distance <= 3 * 24 ** 2 &&
        (matches[1] === undefined || matches[0].distance < matches[1].distance)
          ? matches[0].id
          : undefined;
      const city = spec.referenceCities?.find(({ countryTag }) => countryTag === country.tag);
      const cityId =
        city !== undefined && city.x >= 0 && city.y >= 0 && city.x < width && city.y < height
          ? reference.country[Math.floor(city.y) * width + Math.floor(city.x)]
          : undefined;
      if (colorId !== undefined && cityId !== undefined && cityId > 0 && colorId !== cityId)
        throw new ServiceError(
          'MAP_WORLD_COUNTRY_REFERENCE_CONFLICT',
          'A country color and its capital anchor identify different political regions',
          { countryTag: country.tag },
        );
      const selected = colorId ?? (cityId === 0 ? undefined : cityId);
      if (selected === undefined) {
        unresolved.push(index);
        continue;
      }
      if (indexes.has(selected))
        throw new ServiceError(
          'MAP_WORLD_COUNTRY_REFERENCE_CONFLICT',
          'Two supplied countries identify the same political region',
          { countryTag: country.tag },
        );
      indexes.set(selected, index);
    }
    const remaining = reference.inferredCountries.filter(({ id }) => !indexes.has(id));
    for (const [position, index] of unresolved.entries())
      indexes.set(remaining[position]!.id, index);
    if (unresolved.length > 0)
      interpretationWarnings.push(
        `${unresolved.length} country name(s) had no distinct matching color or capital anchor; remaining political regions were assigned in deterministic reference order.`,
      );
    const votes = new Uint32Array(count * countryCount);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const selected = indexes.get(reference.country[pixel]!);
      if (selected !== undefined && surface.kind[pixel] === LAND)
        votes[provinces.pixel[pixel]! * countryCount + selected]! += 1;
    }
    for (const id of landIds) {
      let selected = 0;
      for (let country = 1; country < countryCount; country += 1)
        if (votes[id * countryCount + country]! > votes[id * countryCount + selected]!)
          selected = country;
      if (votes[id * countryCount + selected]! > 0) referenceOwners.set(id, selected);
    }
  }
  const nearestProvince = (point: { x: number; y: number }, candidates: readonly number[]) => {
    let selected = candidates[0]!;
    let distance = Number.POSITIVE_INFINITY;
    for (const id of candidates) {
      const c = center(id);
      const next = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
      if (next < distance) {
        selected = id;
        distance = next;
      }
    }
    return selected;
  };
  // Sites of the model that anchor a country (its capital) choose that country's capital province.
  const siteAnchors =
    geography === undefined
      ? []
      : geography.sites.flatMap((site) =>
          site.country === undefined || site.onWater
            ? []
            : [
                {
                  name: site.name ?? site.id,
                  x: site.at.x * width,
                  y: site.at.y * height,
                  countryTag: site.country,
                },
              ],
        );
  const namedCities = [...(spec.referenceCities ?? []), ...siteAnchors].map((city) => {
    const pixel =
      city.x >= 0 && city.y >= 0 && city.x < width && city.y < height
        ? Math.floor(city.y) * width + Math.floor(city.x)
        : undefined;
    return {
      ...city,
      province:
        pixel !== undefined && surface.kind[pixel] === LAND
          ? provinces.pixel[pixel]!
          : nearestProvince(city, landIds),
    };
  });
  const capitals: number[] = [];
  const largest = [...landIds].sort(
    (left, right) => provinces.size[right]! - provinces.size[left]! || left - right,
  );
  while (capitals.length < countryCount) {
    const countryIndex = capitals.length;
    const regionCandidates = largest.filter(
      (id) => referenceOwners.get(id) === countryIndex && !capitals.includes(id),
    );
    const candidates =
      regionCandidates.length > 0
        ? regionCandidates
        : largest.filter((id) => !capitals.includes(id));
    const named = namedCities.find((city) => city.countryTag === spec.countries[countryIndex]!.tag);
    if (named !== undefined) {
      capitals.push(
        candidates.includes(named.province) ? named.province : nearestProvince(named, candidates),
      );
      continue;
    }
    if (regionCandidates.length > 0) {
      capitals.push(regionCandidates[0]!);
      continue;
    }
    if (capitals.length === 0) {
      capitals.push(candidates[random.int(Math.min(candidates.length, 8))]!);
      continue;
    }
    let best = -1;
    let bestDistance = -1;
    for (const id of landIds) {
      if (capitals.includes(id)) continue;
      const c = center(id);
      const distance = Math.min(
        ...capitals.map((other) => Math.hypot(center(other).x - c.x, center(other).y - c.y)),
      );
      if (distance > bestDistance) {
        bestDistance = distance;
        best = id;
      }
    }
    capitals.push(best);
  }
  const shares = spec.countries.map((country) => Math.max(0.05, country.share ?? 1));
  const owned = new Array<number>(countryCount).fill(0);
  for (const [id, country] of referenceOwners) {
    owner.set(id, country);
    owned[country]! += provinces.size[id]!;
  }
  const frontiers = capitals.map((capital, index) => {
    owner.set(capital, index);
    if (!referenceOwners.has(capital)) owned[index]! += provinces.size[capital]!;
    return [...provinces.neighbors[capital]!];
  });
  for (;;) {
    let chosen = -1;
    for (let index = 0; index < countryCount; index += 1) {
      frontiers[index] = frontiers[index]!.filter(
        (id) => provinces.kind[id] === LAND && !owner.has(id),
      );
      if (frontiers[index]!.length === 0) continue;
      if (chosen < 0 || owned[index]! / shares[index]! < owned[chosen]! / shares[chosen]!)
        chosen = index;
    }
    if (chosen < 0) break;
    const frontier = frontiers[chosen]!;
    const next = frontier.splice(random.int(frontier.length), 1)[0]!;
    owner.set(next, chosen);
    owned[chosen]! += provinces.size[next]!;
    for (const neighbor of provinces.neighbors[next]!)
      if (!owner.has(neighbor)) frontier.push(neighbor);
  }
  // Islands no country reached go to the nearest capital's country.
  for (const id of landIds)
    if (!owner.has(id)) {
      const c = center(id);
      let best = 0;
      for (const [index, capital] of capitals.entries())
        if (
          Math.hypot(center(capital).x - c.x, center(capital).y - c.y) <
          Math.hypot(center(capitals[best]!).x - c.x, center(capitals[best]!).y - c.y)
        )
          best = index;
      owner.set(id, best);
    }
  // Strategic regions: land regions over the land graph, sea regions over the sea graph.
  const graph = (id: number) => provinces.neighbors[id]!;
  const landRegion =
    featurePartition === undefined
      ? growClusters(landIds, graph, spec.landProvincesPerRegion, random)
      : clusterRegions(featurePartition, landIds, 'land');
  const seaRegion =
    featurePartition === undefined
      ? growClusters(seaIds, graph, spec.seaProvincesPerRegion, random)
      : clusterRegions(featurePartition, seaIds, 'sea');
  const regionOf = new Map<number, number>();
  const landRegionCount = Math.max(-1, ...landRegion.values()) + 1;
  for (const [id, region] of landRegion) regionOf.set(id, region + 1);
  for (const [id, region] of seaRegion) regionOf.set(id, landRegionCount + region + 1);
  for (const id of lakeIds) {
    const land = [...provinces.neighbors[id]!].find((other) => landRegion.has(other));
    const sea = [...provinces.neighbors[id]!].find((other) => seaRegion.has(other));
    regionOf.set(
      id,
      land !== undefined
        ? landRegion.get(land)! + 1
        : sea !== undefined
          ? landRegionCount + seaRegion.get(sea)! + 1
          : 1,
    );
  }
  const seaRegionCount = Math.max(-1, ...seaRegion.values()) + 1;
  // States: within each region and country, clusters of about provincesPerState.
  const groups = new Map<string, number[]>();
  for (const id of landIds) {
    const key = `${regionOf.get(id)}:${owner.get(id)}`;
    const list = groups.get(key) ?? [];
    list.push(id);
    groups.set(key, list);
  }
  const states: StateDraft[] = [];
  const stateOf = new Map<number, StateDraft>();
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!;
    const clusters =
      featurePartition === undefined
        ? growClusters(members, graph, spec.provincesPerState, random)
        : clusterStates(featurePartition, members);
    const byCluster = new Map<number, number[]>();
    for (const [id, cluster] of clusters) {
      const list = byCluster.get(cluster) ?? [];
      list.push(id);
      byCluster.set(cluster, list);
    }
    for (const memberIds of [...byCluster.values()].sort(
      (left, right) => Math.min(...left) - Math.min(...right),
    )) {
      const [region, countryIndex] = key.split(':').map(Number) as [number, number];
      const sorted = memberIds.sort(
        (left, right) => provinces.size[right]! - provinces.size[left]! || left - right,
      );
      const draft: StateDraft = {
        id: states.length + 1,
        provinces: sorted,
        owner: spec.countries[countryIndex]!.tag,
        region,
        capital: sorted[0]!,
        manpower: 0,
        category: 'rural',
        infrastructure: 1,
        civilian: 0,
        military: 0,
        dockyard: 0,
        airBase: 0,
        resources: new Map(),
        victoryPoints: new Map(),
        navalBases: new Map(),
        forts: new Map(),
      };
      states.push(draft);
      for (const id of sorted) stateOf.set(id, draft);
    }
  }
  // Names from reference labels (the nearest province to each label), which win over any other.
  const stateNames = new Map<number, string>();
  const regionNames = new Map<number, string>();
  for (const label of spec.referenceLabels ?? []) {
    if (label.kind === 'state') {
      const nearby = nearestProvince(label, landIds);
      const state = stateOf.get(nearby)!;
      const previous = stateNames.get(state.id);
      stateNames.set(state.id, previous === undefined ? label.name : `${previous} / ${label.name}`);
    } else if (label.kind === 'sea' || label.kind === 'region') {
      const members = label.kind === 'sea' ? seaIds : landIds;
      if (members.length === 0) continue;
      const region = regionOf.get(nearestProvince(label, members))!;
      const previous = regionNames.get(region);
      regionNames.set(region, previous === undefined ? label.name : `${previous} / ${label.name}`);
    }
  }
  const lakeNames = new Map<number, string>();
  // State values from size, terrain and development, with the country capital boosted.
  const categories = [
    'wasteland',
    'pastoral',
    'rural',
    'town',
    'large_town',
    'city',
    'large_city',
    'metropolis',
  ];
  const slotsFor: Record<string, number> = {
    wasteland: 0,
    pastoral: 1,
    rural: 2,
    town: 4,
    large_town: 5,
    city: 6,
    large_city: 8,
    metropolis: 10,
  };
  const countryCapitalState = new Map<string, StateDraft>();
  for (const [index, capital] of capitals.entries()) {
    const state = stateOf.get(capital)!;
    state.capital = capital;
    countryCapitalState.set(spec.countries[index]!.tag, state);
  }
  const cityNames = new Map<number, string>();
  // A geography world gets its economy, ports, names and railway costs from the model (ADR 0063);
  // every other world keeps the random economy below, byte for byte.
  const economy: EconomyPlan | undefined =
    gameplay === undefined || spec.developmentModel === 'legacy'
      ? undefined
      : planEconomy(gameplay, {
          states: states.map((state) => ({
            id: state.id,
            provinces: state.provinces,
            owner: state.owner,
            isCapital: countryCapitalState.get(state.owner) === state,
          })),
          terrain,
          options: {
            categories,
            slotsFor,
            allowedCategories: context.stateCategories,
            capitalProvinces: new Set(capitals),
          },
          regionOf,
          fixedStateNames: stateNames,
          fixedRegionNames: regionNames,
          countryNames: new Map(spec.countries.map(({ tag, name }) => [tag, name])),
        });
  if (economy !== undefined) {
    for (const state of states) {
      const plan = economy.development.states.get(state.id)!;
      state.manpower = plan.manpower;
      state.category = plan.category;
      state.infrastructure = plan.infrastructure;
      state.civilian = plan.civilian;
      state.military = plan.military;
      state.dockyard = plan.dockyard;
      state.airBase = plan.airBase;
      state.resources = plan.resources;
      state.victoryPoints = plan.victoryPoints;
      for (const id of state.provinces) {
        const port = economy.ports.ports.get(id);
        if (port !== undefined) state.navalBases.set(id, port.level);
        const fort = economy.forts.get(id);
        if (fort !== undefined) state.forts.set(id, fort);
      }
    }
    for (const id of economy.development.urban) terrain.set(id, 'urban');
    for (const [id, name] of economy.names.victory) cityNames.set(id, name);
    for (const [id, name] of economy.names.states) stateNames.set(id, name);
    for (const [id, name] of economy.names.regions) regionNames.set(id, name);
    for (const [id, name] of economy.names.lakes) lakeNames.set(id, name);
    for (const note of economy.notes) notes.push(note);
  }
  if (economy === undefined) {
    for (const state of states) {
      const pixels = state.provinces.reduce((sum, id) => sum + provinces.size[id]!, 0);
      const habitability =
        state.provinces.reduce((sum, id) => {
          const value =
            {
              plains: 1,
              forest: 0.8,
              hills: 0.6,
              jungle: 0.5,
              marsh: 0.4,
              desert: 0.25,
              mountain: 0.3,
              urban: 1.5,
            }[terrain.get(id) ?? 'plains'] ?? 0.5;
          return sum + value * provinces.size[id]!;
        }, 0) / pixels;
      const isCapital = countryCapitalState.get(state.owner) === state;
      const development = Math.min(1, habitability * (0.5 + random.next()) * (isCapital ? 1.8 : 1));
      state.manpower = Math.max(1_000, Math.round((pixels * 180 * development) / 1_000) * 1_000);
      const categoryIndex = Math.max(
        0,
        Math.min(categories.length - 1, Math.round(development * 5.2 + (isCapital ? 1 : 0))),
      );
      state.category = categories[categoryIndex]!;
      if (context.stateCategories !== undefined && !context.stateCategories.has(state.category))
        state.category = context.stateCategories.has('rural')
          ? 'rural'
          : ([...context.stateCategories][0] ?? 'rural');
      const slots = slotsFor[state.category] ?? 2;
      state.infrastructure = Math.max(
        1,
        Math.min(5, Math.round(1 + development * 3 + (isCapital ? 1 : 0))),
      );
      state.civilian = Math.round(slots * (0.25 + random.next() * 0.3));
      state.military = Math.min(slots - state.civilian, Math.round(slots * random.next() * 0.3));
      if (isCapital) {
        terrain.set(state.capital, 'urban');
        state.airBase = 2;
      }
      const coastalProvinces = state.provinces.filter(coastal);
      if (coastalProvinces.length > 0 && (isCapital || random.next() < 0.35)) {
        state.navalBases.set(coastalProvinces[0]!, isCapital ? 3 : 1);
        if (slots - state.civilian - state.military > 0 && random.next() < 0.5) state.dockyard = 1;
      }
      for (const id of state.provinces) {
        const kindOfLand = terrain.get(id);
        const roll = random.next();
        const add = (resource: string, amount: number) =>
          state.resources.set(resource, (state.resources.get(resource) ?? 0) + amount);
        if (kindOfLand === 'desert' && roll < 0.3) add('oil', 2 + random.int(6));
        if ((kindOfLand === 'mountain' || kindOfLand === 'hills') && roll < 0.35)
          add('steel', 2 + random.int(8));
        if (kindOfLand === 'mountain' && roll < 0.15) add('tungsten', 1 + random.int(4));
        if (kindOfLand === 'hills' && roll > 0.85) add('chromium', 1 + random.int(4));
        if (kindOfLand === 'jungle' && roll < 0.35) add('rubber', 1 + random.int(5));
        if (kindOfLand === 'plains' && roll < 0.05) add('aluminium', 1 + random.int(4));
      }
      state.victoryPoints.set(
        state.capital,
        isCapital ? 25 : Math.max(1, Math.round(development * 8)),
      );
    }
    for (const city of namedCities) {
      const state = stateOf.get(city.province)!;
      cityNames.set(city.province, city.name);
      state.victoryPoints.set(
        city.province,
        Math.max(5, state.victoryPoints.get(city.province) ?? 0),
      );
      terrain.set(city.province, 'urban');
    }
    // Each coastal territory needs a port even when its capital lies inland or on another island.
    const portChecked = new Set<number>();
    for (const start of landIds) {
      if (portChecked.has(start)) continue;
      const queue = [start];
      portChecked.add(start);
      let bestCoast: number | undefined;
      let hasPort = false;
      for (const id of queue) {
        if (stateOf.get(id)!.navalBases.has(id)) hasPort = true;
        if (
          coastal(id) &&
          (bestCoast === undefined || provinces.size[id]! > provinces.size[bestCoast]!)
        )
          bestCoast = id;
        for (const next of provinces.neighbors[id]!)
          if (
            !portChecked.has(next) &&
            provinces.kind[next] === LAND &&
            owner.get(next) === owner.get(start)
          ) {
            portChecked.add(next);
            queue.push(next);
          }
      }
      if (!hasPort && bestCoast !== undefined) stateOf.get(bestCoast)!.navalBases.set(bestCoast, 1);
    }
  }
  // Province IDs: 1-based in reading order of the province's first pixel; 0 is the null row.
  const provinceId = (index: number) => index + 1;
  // Unique colours, never black.
  const colors: RgbColor[] = [];
  const usedColors = new Set<number>([0]);
  for (let index = 0; index < count; index += 1) {
    let value: number;
    do value = 1 + random.int(0xfffffe);
    while (usedColors.has(value));
    usedColors.add(value);
    colors.push({ r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 });
  }
  const files: WorldFile[] = [];
  const add = (relativePath: string, content: Buffer, mediaType = 'text/plain') =>
    files.push({ relativePath, content, mediaType });
  const countryNames = new Map(spec.countries.map(({ tag, name }) => [tag, name]));
  const map = context.mapRoot;
  // provinces.bmp
  const rgb = new Array<RgbColor>(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1)
    rgb[pixel] = colors[provinces.pixel[pixel]!]!;
  add(
    `${map}/provinces.bmp`,
    createBmp({ width, height, bitsPerPixel: 24, rgbPixels: rgb }),
    'image/bmp',
  );
  // definition.csv: CRLF line endings, as the game expects.
  const continentOf = (id: number) =>
    provinces.kind[id] === LAND ? (continentOfPart.get(landParts.get(id)!) ?? 1) : 0;
  const definitionRows = ['0;0;0;0;land;false;unknown;0'];
  for (let index = 0; index < count; index += 1) {
    const color = colors[index]!;
    const type =
      provinces.kind[index] === LAND ? 'land' : provinces.kind[index] === SEA ? 'sea' : 'lake';
    definitionRows.push(
      `${provinceId(index)};${color.r};${color.g};${color.b};${type};${coastal(index) ? 'true' : 'false'};${terrain.get(index)};${continentOf(index)}`,
    );
  }
  add(`${map}/definition.csv`, text(`${definitionRows.join('\r\n')}\r\n`));
  add(
    `${map}/default.map`,
    text(
      [
        'definitions = "definition.csv"',
        'provinces = "provinces.bmp"',
        'positions = "positions.txt"',
        'terrain = "terrain.bmp"',
        'rivers = "rivers.bmp"',
        'heightmap = "heightmap.bmp"',
        'tree_definition = "trees.bmp"',
        'continent = "continent.txt"',
        'adjacency_rules = "adjacency_rules.txt"',
        'adjacencies = "adjacencies.csv"',
        'ambient_object = "ambient_object.txt"',
        'seasons = "seasons.txt"',
        '',
        '# Indices in the trees.bmp palette that count as trees for automatic terrain assignment',
        'tree = { 3 4 7 10 }',
        '',
      ].join('\n'),
    ),
  );
  add(
    `${map}/continent.txt`,
    text(
      `continents = {\n${[...new Set([...continentNames.map((_, index) => `world_continent_${index + 1}`), ...(context.continentKeys ?? [])])].map((key) => `\t${key}`).join('\n')}\n}\n`,
    ),
  );
  const rimRows =
    edge.mode === 'rim'
      ? rimAdjacencyRows({
          provincePixels: provinces.pixel,
          provinceKinds: provinces.kind,
          width,
          height,
        })
      : [];
  if (rimRows.length > 0)
    notes.push({
      code: 'MAP_EDGE_RIM_ADJACENCIES',
      severity: 'info',
      message: `The rim edge policy wrote ${rimRows.length} impassable adjacency row(s) for provinces that meet across the seam`,
      details: { rows: rimRows.length },
    });
  const crossingRows = (gameplay?.crossings.rows ?? []).map(adjacencyRowText);
  add(
    `${map}/adjacencies.csv`,
    text(
      `From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment\r\n${[...crossingRows, ...rimRows].map((row) => `${row}\r\n`).join('')}-1;-1;;-1;-1;-1;-1;-1;-1\r\n`,
    ),
  );
  add(
    `${map}/adjacency_rules.txt`,
    text(
      gameplay === undefined
        ? '# No straits or canals in this world yet.\n'
        : adjacencyRulesText(gameplay.crossings.rules),
    ),
  );
  add(`${map}/positions.txt`, text(''));
  add(
    `${map}/ambient_object.txt`,
    text(
      spec.ambientFrame === true
        ? ambientObjectText(width, height)
        : '# No ambient objects: the base-game map frame does not fit this map.\n',
    ),
  );
  // City groups use palette 15 only for urban footprints. Water and undeveloped land stay 0.
  const cityPixels = new Uint8Array(width * height);
  const nearestCenter = new Int32Array(count).fill(-1);
  const centerDistance = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (surface.kind[pixel] !== LAND) continue;
    const id = provinces.pixel[pixel]!;
    const x = pixel % width,
      y = Math.floor(pixel / width);
    const distance =
      (x - provinces.sumX[id]! / provinces.size[id]!) ** 2 +
      (y - provinces.sumY[id]! / provinces.size[id]!) ** 2;
    if (distance < centerDistance[id]!) {
      nearestCenter[id] = pixel;
      centerDistance[id] = distance;
    }
  }
  for (const state of states)
    for (const [id, value] of state.victoryPoints) {
      const pixel = nearestCenter[id]!;
      const cx = pixel % width,
        cy = Math.floor(pixel / width);
      const radius = value >= 20 ? 6 : value >= 5 ? 4 : 2;
      for (let dy = -radius; dy <= radius; dy += 1)
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = cx + dx,
            y = cy + dy;
          if (x < 0 || x >= width || y < 0 || y >= height || dx * dx + dy * dy > radius * radius)
            continue;
          const target = y * width + x;
          if (provinces.pixel[target] === id && surface.kind[target] === LAND)
            cityPixels[target] = 15;
        }
    }
  const visualTerrain = (pixel: number): string => {
    if (cityPixels[pixel] === 15) return 'urban';
    if (surface.kind[pixel] !== LAND) return surface.kind[pixel] === LAKE ? 'lakes' : 'ocean';
    if (reference !== undefined)
      return referenceTerrainNames[reference.terrain[pixel]!] ?? 'plains';
    const type = terrain.get(provinces.pixel[pixel]!) ?? 'plains';
    return type === 'urban' ? 'plains' : type;
  };
  // heightmap.bmp: sea below 95, land from 96 up. Lakes sit at the sea's interior height with a
  // one to two pixel translucent bank, so the water layer draws them opaque (ADR 0053).
  const landDistance = landDistanceField(surface.kind, width, height);
  const heights = synthesized?.heights ?? new Uint8Array(width * height);
  if (synthesized === undefined)
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const value = surface.elevation[pixel]!;
      heights[pixel] =
        surface.kind[pixel] === LAND
          ? rimHeight(
              Math.min(255, Math.round(96 + value * 110)),
              rimStrength(edge, width, pixel % width),
            )
          : surface.kind[pixel] === LAKE
            ? lakeHeight(landDistance[pixel]!)
            : Math.max(60, Math.round(94 + value * 30));
    }
  const grey = Array.from({ length: 256 }, (_, index) => ({ r: index, g: index, b: index }));
  add(
    `${map}/heightmap.bmp`,
    createBmp({ width, height, bitsPerPixel: 8, palette: grey, indexedPixels: heights }),
    'image/bmp',
  );
  // terrain.bmp from province terrain, with snow on high-latitude mountains.
  const terrainIndex = context.terrainIndex ?? DEFAULT_TERRAIN_INDEX;
  // Lake pixels use the ocean's graphical terrain: the lake entry names no atlas tile.
  const lakeIndex = terrainIndex.get('lakes') ?? terrainIndex.get('ocean') ?? 15;
  const calibrated = spec.colormapProfile === 'calibrated';
  const farmlandIndex = calibrated ? terrainVariant(context, 5, 'plains') : undefined;
  const sparseForestIndex = calibrated ? terrainVariant(context, 4, 'forest') : undefined;
  const mountainGrassIndex = calibrated ? terrainVariant(context, 20, 'mountain') : undefined;
  const terrainPixels = new Uint8Array(width * height);
  const colourClasses = calibrated ? new Uint8Array(width * height) : undefined;
  const classCode = (name: ColourClass): number => COLOUR_CLASSES.indexOf(name);
  const flatSlope = (x: number, y: number): boolean =>
    Math.abs(
      heights[y * width + Math.min(width - 1, x + 1)]! - heights[y * width + Math.max(0, x - 1)]!,
    ) +
      Math.abs(
        heights[Math.min(height - 1, y + 1) * width + x]! -
          heights[Math.max(0, y - 1) * width + x]!,
      ) <=
    2;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const id = provinces.pixel[pixel]!;
    const type = visualTerrain(pixel);
    const snowy =
      synthesized !== undefined
        ? (synthesized.snow[pixel] === 1 || reference?.terrain[pixel] === 4) &&
          surface.kind[pixel] === LAND
        : reference === undefined
          ? type === 'mountain' && latitude(id) > 0.7
          : reference.terrain[pixel] === 4 && surface.kind[pixel] === LAND;
    const x = pixel % width;
    const rimmed = rimStrength(edge, width, x) > 0.35 && surface.kind[pixel] === LAND;
    let index = snowy
      ? reference === undefined
        ? 16
        : 19
      : rimmed
        ? 16
        : type === 'lakes'
          ? lakeIndex
          : (terrainIndex.get(type) ?? DEFAULT_TERRAIN_INDEX.get(type) ?? 0);
    let colour: ColourClass =
      type === 'lakes' || type === 'ocean' || type === 'urban'
        ? type === 'urban'
          ? 'urban'
          : type
        : snowy || rimmed
          ? 'snow'
          : (type as ColourClass);
    if (calibrated && !snowy && !rimmed && surface.kind[pixel] === LAND) {
      // Variant graphical terrains by rule, so one class is not one flat texture.
      const y = (pixel - x) / width;
      if (
        type === 'plains' &&
        farmlandIndex !== undefined &&
        surface.moisture[pixel]! >= 0.6 &&
        flatSlope(x, y)
      ) {
        index = farmlandIndex;
        colour = 'farmland';
      } else if (
        type === 'forest' &&
        sparseForestIndex !== undefined &&
        fractal(spec.seed + 7001, x, y, Math.max(16, width / 30), 3) < 0.42
      )
        index = sparseForestIndex;
      else if (
        type === 'mountain' &&
        mountainGrassIndex !== undefined &&
        surface.moisture[pixel]! > 0.45 &&
        fractal(spec.seed + 7919, x, y, Math.max(16, width / 20), 3) > 0.5
      )
        index = mountainGrassIndex;
    }
    terrainPixels[pixel] = index;
    if (colourClasses !== undefined) {
      if (!COLOUR_CLASSES.includes(colour)) colour = 'plains';
      colourClasses[pixel] = classCode(colour);
    }
  }
  add(
    `${map}/terrain.bmp`,
    createBmp({
      width,
      height,
      bitsPerPixel: 8,
      palette: bmpPalette(context.palettes.terrain, (index) => ({
        r: index,
        g: 128,
        b: 255 - index,
      })),
      indexedPixels: terrainPixels,
    }),
    'image/bmp',
  );
  // rivers.bmp: 255 on land, 254 at sea, rivers flowing downhill to the coast.
  const riverPixels = drainage.riverPixels;
  const riverCount = drainage.count;
  const riverPalette = bmpPalette(context.palettes.rivers, (index) =>
    index === 0
      ? { r: 0, g: 255, b: 0 }
      : index === 1
        ? { r: 255, g: 0, b: 0 }
        : index === 2
          ? { r: 255, g: 252, b: 0 }
          : index <= 11
            ? { r: 0, g: Math.max(0, 255 - index * 20), b: 255 }
            : index === 254
              ? { r: 122, g: 122, b: 122 }
              : { r: 255, g: 255, b: 255 },
  );
  add(
    `${map}/rivers.bmp`,
    createBmp({
      width,
      height,
      bitsPerPixel: 8,
      palette: riverPalette,
      indexedPixels: riverPixels,
      colorsUsed: 0,
    }),
    'image/bmp',
  );
  // trees.bmp: 75/256 of the map size, forests and jungles only.
  const treeWidth = Math.round((width * 75) / 256);
  const treeHeight = Math.round((height * 75) / 256);
  const treePixels = new Uint8Array(treeWidth * treeHeight);
  for (let y = 0; y < treeHeight; y += 1)
    for (let x = 0; x < treeWidth; x += 1) {
      const source =
        Math.floor((y * height) / treeHeight) * width + Math.floor((x * width) / treeWidth);
      const type = visualTerrain(source);
      const dense = surface.moisture[source]! > 0.6;
      treePixels[y * treeWidth + x] =
        lattice(spec.seed + 32452843, x, y) > (dense ? 0.5 : 0.3)
          ? 0
          : type === 'forest'
            ? dense
              ? 6
              : 5
            : type === 'jungle'
              ? dense
                ? 29
                : 28
              : 0;
    }
  add(
    `${map}/trees.bmp`,
    createBmp({
      width: treeWidth,
      height: treeHeight,
      bitsPerPixel: 8,
      palette: bmpPalette(context.palettes.trees, (index) => ({
        r: (index * 7) % 256,
        g: 120,
        b: 40,
      })),
      indexedPixels: treePixels,
    }),
    'image/bmp',
  );
  // cities.bmp: sparse city footprints agree with the terrain and light maps.
  add(
    `${map}/cities.bmp`,
    createBmp({
      width,
      height,
      bitsPerPixel: 8,
      palette: bmpPalette(context.palettes.cities, (index) => ({ r: index, g: index, b: index })),
      indexedPixels: cityPixels,
    }),
    'image/bmp',
  );
  // world_normal.bmp at half size. Geography worlds shade from the float height field at the
  // base game's response; every other world from the quantised heights.
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  if (synthesized !== undefined)
    add(
      `${map}/world_normal.bmp`,
      createBmp({
        width: halfWidth,
        height: halfHeight,
        bitsPerPixel: 24,
        rgbBytes: synthesized.normals,
      }),
      'image/bmp',
    );
  else {
    const normals = new Array<RgbColor>(halfWidth * halfHeight);
    const heightAt = (x: number, y: number) =>
      heights[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
    for (let y = 0; y < halfHeight; y += 1)
      for (let x = 0; x < halfWidth; x += 1) {
        const dx = (heightAt(x * 2 + 2, y * 2) - heightAt(x * 2 - 2, y * 2)) / 4;
        const dy = (heightAt(x * 2, y * 2 - 2) - heightAt(x * 2, y * 2 + 2)) / 4;
        const length = Math.hypot(dx, dy, 8);
        normals[y * halfWidth + x] = {
          r: Math.round(128 - (dx / length) * 127),
          g: Math.round(128 + (dy / length) * 127),
          b: Math.round(128 + (8 / length) * 127),
        };
      }
    add(
      `${map}/world_normal.bmp`,
      createBmp({ width: halfWidth, height: halfHeight, bitsPerPixel: 24, rgbPixels: normals }),
      'image/bmp',
    );
  }
  // Colour maps: land tint and city lights at half size; water at half, quarter and eighth.
  const tint: Record<string, RgbColor> = {
    plains: { r: 121, g: 133, b: 76 },
    forest: { r: 72, g: 96, b: 54 },
    hills: { r: 128, g: 117, b: 80 },
    mountain: { r: 132, g: 124, b: 112 },
    desert: { r: 196, g: 170, b: 116 },
    jungle: { r: 56, g: 92, b: 48 },
    marsh: { r: 92, g: 104, b: 74 },
    urban: { r: 128, g: 120, b: 104 },
    lakes: { r: 70, g: 96, b: 110 },
    ocean: { r: 50, g: 70, b: 92 },
  };
  let colormap: Uint8Array;
  if (colourClasses !== undefined) {
    const lights = new Uint8Array(width * height);
    for (let pixel = 0; pixel < lights.length; pixel += 1)
      if (cityPixels[pixel] === 15) lights[pixel] = 200;
    colormap = calibratedColourMap({
      width,
      height,
      seed: spec.seed,
      classes: colourClasses,
      moisture: surface.moisture,
      heights,
      lights,
      look: spec.look ?? 'vanilla-temperate',
      ...(spec.colormapPalette === undefined ? {} : { overrides: spec.colormapPalette }),
    });
  } else {
    colormap = new Uint8Array(halfWidth * halfHeight * 4);
    for (let y = 0; y < halfHeight; y += 1)
      for (let x = 0; x < halfWidth; x += 1) {
        // DDS rows run top to bottom, like the bitmaps' top-left coordinates used here.
        const source = y * 2 * width + x * 2;
        const color = tint[visualTerrain(source)]!;
        const shade = 0.85 + surface.moisture[source]! * 0.3;
        const offset = (y * halfWidth + x) * 4;
        colormap[offset] = Math.min(255, Math.round(color.b * shade));
        colormap[offset + 1] = Math.min(255, Math.round(color.g * shade));
        colormap[offset + 2] = Math.min(255, Math.round(color.r * shade));
        colormap[offset + 3] = cityPixels[source] === 15 ? 200 : 0;
      }
  }
  if (edge.mode === 'rim')
    for (let y = 0; y < halfHeight; y += 1)
      for (let x = 0; x < halfWidth; x += 1) {
        const strength = rimStrength(edge, width, x * 2);
        if (strength === 0 || surface.kind[y * 2 * width + x * 2] !== LAND) continue;
        const factor = 1 - (1 - RIM_COLOUR_FACTOR) * strength;
        const offset = (y * halfWidth + x) * 4;
        colormap[offset] = Math.round(colormap[offset]! * factor);
        colormap[offset + 1] = Math.round(colormap[offset + 1]! * factor);
        colormap[offset + 2] = Math.round(colormap[offset + 2]! * factor);
      }
  add(
    `${map}/terrain/colormap_rgb_cityemissivemask_a.dds`,
    encodeDds(halfWidth, halfHeight, colormap),
    'image/vnd-ms.dds',
  );
  // Water colour maps: sea tint by distance from land, lake tint with a shore gradient, and the
  // darkest tint at the world edge (ADR 0053, 0061).
  for (const level of [0, 1, 2])
    add(
      `${map}/terrain/colormap_water_${level}.dds`,
      encodeDds(
        width / 2 ** (level + 1),
        height / 2 ** (level + 1),
        waterColourLevel(
          {
            width,
            height,
            kind: surface.kind,
            landDistance,
            seed: spec.seed,
            ...(edge.mode === 'none'
              ? {}
              : { darken: (x, y) => edgeWaterDarkness(edge, width, height, x, y) }),
          },
          level,
        ),
      ),
      'image/vnd-ms.dds',
    );
  // Strategic regions with weather by latitude.
  const regionMembers = new Map<number, number[]>();
  for (const [id, region] of regionOf) {
    const list = regionMembers.get(region) ?? [];
    list.push(provinceId(id));
    regionMembers.set(region, list);
  }
  for (const [region, members] of [...regionMembers].sort((left, right) => left[0] - right[0])) {
    const indexes = members.map((member) => member - 1);
    const meanLatitude =
      indexes.reduce((sum, id) => sum + 1 - (2 * center(id).y) / height, 0) / indexes.length;
    const desert = indexes.filter((id) => terrain.get(id) === 'desert').length > indexes.length / 2;
    const naval = indexes.every((id) => provinces.kind[id] !== LAND);
    add(
      `${map}/strategicregions/${region}-${slug(regionNames.get(region) ?? `World region ${region}`).slice(0, 80)}.txt`,
      text(
        [
          'strategic_region={',
          `\tid=${region}`,
          `\tname="STRATEGICREGION_${region}"`,
          '\tprovinces={',
          `\t\t${members.sort((a, b) => a - b).join(' ')} `,
          '\t}',
          ...(naval ? ['\tnaval_terrain=water_deep_ocean'] : []),
          weatherBlock(meanLatitude, desert),
          '}',
          '',
        ].join('\n'),
      ),
    );
  }
  // States.
  for (const state of states) {
    const provinceList = state.provinces.map(provinceId).sort((a, b) => a - b);
    const resources = [...state.resources].sort(([left], [right]) => (left < right ? -1 : 1));
    const buildings = [
      `\t\t\tinfrastructure = ${state.infrastructure}`,
      ...(state.civilian > 0 ? [`\t\t\tindustrial_complex = ${state.civilian}`] : []),
      ...(state.military > 0 ? [`\t\t\tarms_factory = ${state.military}`] : []),
      ...(state.dockyard > 0 ? [`\t\t\tdockyard = ${state.dockyard}`] : []),
      ...(state.airBase > 0 ? [`\t\t\tair_base = ${state.airBase}`] : []),
      ...[
        ...state.navalBases.keys(),
        ...[...state.forts.keys()].filter((id) => !state.navalBases.has(id)).sort((a, b) => a - b),
      ].map((id) => {
        const parts = [
          ...(state.navalBases.has(id) ? [`naval_base = ${state.navalBases.get(id)}`] : []),
          ...(state.forts.has(id) ? [`bunker = ${state.forts.get(id)}`] : []),
        ];
        return `\t\t\t${provinceId(id)} = { ${parts.join(' ')} }`;
      }),
    ];
    add(
      `${context.statesRoot}/${state.id}-${slug(stateNames.get(state.id) ?? `STATE_${state.id}`).slice(0, 80)}.txt`,
      text(
        [
          'state = {',
          `\tid = ${state.id}`,
          `\tname = "STATE_${state.id}"`,
          `\tmanpower = ${state.manpower}`,
          `\tstate_category = ${state.category}`,
          ...(resources.length === 0
            ? []
            : [
                `\tresources = {\n${resources.map(([resource, amount]) => `\t\t${resource} = ${amount}`).join('\n')}\n\t}`,
              ]),
          '\thistory = {',
          `\t\towner = ${state.owner}`,
          `\t\tadd_core_of = ${state.owner}`,
          ...[...state.victoryPoints].map(
            ([id, value]) => `\t\tvictory_points = { ${provinceId(id)} ${value} }`,
          ),
          '\t\tbuildings = {',
          ...buildings,
          '\t\t}',
          '\t}',
          `\tprovinces = { ${provinceList.join(' ')} }`,
          '}',
          '',
        ].join('\n'),
      ),
    );
  }
  // Countries.
  const countryLocalisation: Array<readonly [string, string]> = [];
  const countryLines: string[] = [];
  const countryColors: string[] = [];
  for (const [index, country] of spec.countries.entries()) {
    const color = country.color ?? {
      r: 60 + random.int(170),
      g: 60 + random.int(170),
      b: 60 + random.int(170),
    };
    const fileName = `${country.tag} - ${slug(country.name)}`;
    const ideology = country.ideology ?? 'neutrality';
    countryColors.push(
      `${country.tag} = { color = rgb { ${color.r} ${color.g} ${color.b} } color_ui = rgb { ${color.r} ${color.g} ${color.b} } }`,
    );
    const leaderIdeology = {
      neutrality: 'despotism',
      democratic: 'liberalism',
      communism: 'leninism',
      fascism: 'fascism_ideology',
    }[ideology];
    const capitalState = countryCapitalState.get(country.tag)!;
    countryLines.push(`${country.tag} = "countries/${fileName}.txt"`);
    add(
      `common/countries/${fileName}.txt`,
      text(
        `graphical_culture = western_european_gfx\ngraphical_culture_2d = western_european_2d\n\ncolor = { ${color.r} ${color.g} ${color.b} }\n`,
      ),
    );
    const popularity = { democratic: 10, communism: 10, fascism: 10, neutrality: 10 };
    popularity[ideology] = 70;
    add(
      `history/countries/${country.tag} - ${slug(country.name)}.txt`,
      text(
        [
          `capital = ${capitalState.id}`,
          ...(spec.startingScenario
            ? [
                `oob = "${country.tag}_world"`,
                'add_ideas = { limited_conscription civilian_economy export_focus }',
              ]
            : []),
          '',
          'set_research_slots = 3',
          'set_stability = 0.6',
          'set_war_support = 0.2',
          '',
          'set_technology = {',
          '\tinfantry_weapons = 1',
          ...(spec.startingScenario ? ['\tinfantry_weapons1 = 1', '\tbasic_train = 1'] : []),
          '\ttech_support = 1',
          '\ttech_recon = 1',
          '}',
          '',
          'set_politics = {',
          `\truling_party = ${ideology}`,
          `\tlast_election = "${Number(spec.startDate.split('.')[0]) - 4}.1.1"`,
          '\telection_frequency = 48',
          `\telections_allowed = ${ideology === 'democratic' ? 'yes' : 'no'}`,
          '}',
          'set_popularities = {',
          ...Object.entries(popularity).map(([name, value]) => `\t${name} = ${value}`),
          '}',
          ...(spec.startingScenario
            ? [
                `create_country_leader = { name = "${country.tag}_WORLD_LEADER" picture = "gfx/leaders/leader_unknown.dds" ideology = ${leaderIdeology} expire = "1965.1.1" traits = { } }`,
              ]
            : []),
          '',
        ].join('\n'),
      ),
    );
    if (spec.startingScenario) {
      add(
        `history/units/${country.tag}_world.txt`,
        text(
          [
            '# Minimal map-acceptance scenario; no authored campaign or national content.',
            'division_template = {',
            '\tname = "Infantry Division"',
            '\tregiments = {',
            ...Array.from(
              { length: 6 },
              (_, i) => `\t\tinfantry = { x = ${Math.floor(i / 3)} y = ${i % 3} }`,
            ),
            '\t}',
            '}',
            'units = {',
            ...[1, 2].map(
              (i) =>
                `\tdivision = { name = "${country.tag} Infantry ${i}" location = ${provinceId(capitalState.capital)} division_template = "Infantry Division" start_experience_factor = 0.1 start_equipment_factor = 1 }`,
            ),
            '}',
            'instant_effect = {',
            `\tadd_equipment_to_stockpile = { type = infantry_equipment_1 amount = 3000 producer = ${country.tag} }`,
            `\tadd_equipment_to_stockpile = { type = convoy amount = 100 producer = ${country.tag} }`,
            `\tadd_equipment_to_stockpile = { type = train_equipment_1 amount = 100 producer = ${country.tag} }`,
            `\tadd_equipment_production = { equipment = { type = infantry_equipment_1 creator = ${country.tag} } requested_factories = 1 progress = 0.5 efficiency = 50 }`,
            '}',
            '',
          ].join('\n'),
        ),
      );
    }
    countryLocalisation.push(
      [country.tag, country.name],
      [`${country.tag}_DEF`, country.name],
      [`${country.tag}_ADJ`, country.adjective ?? country.name],
      ...(spec.startingScenario
        ? [[`${country.tag}_WORLD_LEADER`, 'Provisional Council'] as const]
        : []),
    );
    // A three-band flag in the country colour, in the three sizes the game draws.
    const dark = {
      r: Math.round(color.r * 0.55),
      g: Math.round(color.g * 0.55),
      b: Math.round(color.b * 0.55),
    };
    const light = {
      r: Math.min(255, color.r + 80),
      g: Math.min(255, color.g + 80),
      b: Math.min(255, color.b + 80),
    };
    for (const [folder, flagWidth, flagHeight] of [
      ['', 82, 52],
      ['medium/', 41, 26],
      ['small/', 10, 7],
    ] as const)
      add(
        `gfx/flags/${folder}${country.tag}.tga`,
        encodeTga(flagWidth, flagHeight, (_x, y) =>
          y < flagHeight / 3 ? light : y < (flagHeight * 2) / 3 ? color : dark,
        ),
        'image/x-tga',
      );
    void index;
  }
  add('common/country_tags/zz_world_countries.txt', text(`${countryLines.join('\n')}\n`));
  add('common/countries/colors.txt', text(`${countryColors.join('\n')}\n`));
  if (spec.startingScenario) {
    for (const tag of context.inheritedCountryTags ?? [])
      if (!countryNames.has(tag))
        add(
          `history/countries/${tag} - inactive world.txt`,
          text('# Inherited tag has no territory or active starting country in this world.\n'),
        );
    add(
      'common/on_actions/world.txt',
      text('# Old-world startup hooks are replaced for this generated map.\non_actions = { }\n'),
    );
    add(
      'common/ai_strategy_plans/world.txt',
      text('# No country-specific old-world AI plans apply.\n'),
    );
    add(
      'common/ai_areas/world.txt',
      text(
        `areas = { world = { strategic_regions = { ${[...regionMembers.keys()].sort((a, b) => a - b).join(' ')} } } }\n`,
      ),
    );
  }
  // The start bookmark lists the largest countries as majors.
  const ranked = [...spec.countries].sort(
    (left, right) =>
      states
        .filter((state) => state.owner === right.tag)
        .reduce((sum, state) => sum + state.manpower, 0) -
        states
          .filter((state) => state.owner === left.tag)
          .reduce((sum, state) => sum + state.manpower, 0) || (left.tag < right.tag ? -1 : 1),
  );
  const majors = ranked.slice(0, Math.min(7, ranked.length));
  add(
    'common/bookmarks/world.txt',
    text(
      [
        'bookmarks = {',
        '\tbookmark = {',
        '\t\tname = "WORLD_BOOKMARK_NAME"',
        '\t\tdesc = "WORLD_BOOKMARK_DESC"',
        `\t\tdate = ${spec.startDate}.12`,
        '\t\tpicture = "GFX_select_date_1936"',
        `\t\tdefault_country = "${majors[0]!.tag}"`,
        '\t\tdefault = yes',
        ...majors.map(
          (country) =>
            `\t\t"${country.tag}" = {\n\t\t\thistory = "${country.tag}_WORLD_DESC"\n\t\t\tideology = ${country.ideology ?? 'neutrality'}\n\t\t}`,
        ),
        '\t\t"---" = {\n\t\t\thistory = "WORLD_OTHER_DESC"\n\t\t}',
        '\t\teffect = {\n\t\t\trandomize_weather = 22345\n\t\t}',
        '\t}',
        '}',
        '',
      ].join('\n'),
    ),
  );
  // Localisation for everything named above.
  add(
    `${context.localisationRoot}/replace/world_l_english.yml`,
    localisation([
      ...states.map(
        (state) =>
          [
            `STATE_${state.id}`,
            stateNames.get(state.id) ??
              `${countryNames.get(state.owner) ?? state.owner} District ${state.id}`,
          ] as const,
      ),
      ...states.flatMap((state) =>
        [...state.victoryPoints.keys()].map(
          (id) =>
            [
              `VICTORY_POINTS_${provinceId(id)}`,
              cityNames.get(id) ??
                `${countryNames.get(state.owner) ?? state.owner} Settlement ${provinceId(id)}`,
            ] as const,
        ),
      ),
      ...[...regionMembers.keys()]
        .sort((a, b) => a - b)
        .map(
          (region) =>
            [`STRATEGICREGION_${region}`, regionNames.get(region) ?? `Region ${region}`] as const,
        ),
      ...(spec.referenceLabels ?? []).map(
        (label, index) => [`WORLD_GEOGRAPHY_${index + 1}`, label.name] as const,
      ),
      ...[...lakeNames]
        .sort((a, b) => a[0] - b[0])
        .map(([id, name]) => [`PROV${provinceId(id)}`, name] as const),
      ...continentNames.map((name, index) => [`world_continent_${index + 1}`, name] as const),
      ...countryLocalisation,
      ['WORLD_BOOKMARK_NAME', spec.worldName ?? 'A New World'],
      ['WORLD_BOOKMARK_DESC', 'Nations of an unfamiliar map at the dawn of the war.'],
      ['WORLD_OTHER_DESC', 'Any other nation of this world.'],
      ...majors.map(
        (country) =>
          [
            `${country.tag}_WORLD_DESC`,
            `${country.name} begins the game among the strongest nations.`,
          ] as const,
      ),
    ]),
  );
  return {
    files,
    warnings: [...interpretationWarnings, ...drainage.warnings],
    notes,
    ...(synthesized === undefined ? {} : { terrain: synthesized }),
    ...(economy === undefined ? {} : { railCost: economy.railCost }),
    ...(gameplay === undefined ? {} : { gameplay: { crossings: gameplay.crossings, economy } }),
    summary: {
      width,
      height,
      landProvinces: landIds.length,
      seaProvinces: seaIds.length,
      lakeProvinces: lakeIds.length,
      states: states.length,
      landRegions: landRegionCount,
      seaRegions: seaRegionCount,
      countries: spec.countries.length,
      rivers: riverCount,
    },
  };
}
