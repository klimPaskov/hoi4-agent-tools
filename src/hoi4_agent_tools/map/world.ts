/**
 * A new world from a compact description: land and sea, provinces, terrain, heights, rivers,
 * trees, colour maps, continents, strategic regions with weather, countries, states with their
 * population, buildings, resources and victory points, country history and flags, a start
 * bookmark, and localisation. Generation is deterministic for a seed. Positions and the supply
 * network are derived afterwards from the generated map by the shared planners in derived.ts.
 */
import { ServiceError } from '../core/result.js';
import { createBmp, type RgbColor } from './bmp.js';

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
}

/** Installed base-game data that makes generated files match the game's conventions. */
export interface WorldContext {
  palettes: Partial<Record<'terrain' | 'rivers' | 'trees' | 'cities', RgbColor[]>>;
  /** Graphical terrain palette index for each provincial terrain type. */
  terrainIndex?: ReadonlyMap<string, number>;
  stateCategories?: ReadonlySet<string>;
  mapRoot: string;
  statesRoot: string;
  localisationRoot: string;
}

export interface WorldFile {
  relativePath: string;
  content: Buffer;
  mediaType: string;
}

export interface GeneratedWorld {
  files: WorldFile[];
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

class Random {
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

function lattice(seed: number, x: number, y: number): number {
  let hash = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = lattice(seed, x0, y0);
  const b = lattice(seed, x0 + 1, y0);
  const c = lattice(seed, x0, y0 + 1);
  const d = lattice(seed, x0 + 1, y0 + 1);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

function fractal(seed: number, x: number, y: number, scale: number, octaves = 5): number {
  let total = 0;
  let amplitude = 1;
  let weight = 0;
  let frequency = 1 / scale;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(seed + octave * 101, x * frequency, y * frequency) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / weight;
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
    const inland = Math.min(1, (coastDistance[pixel] ?? 0) / 40);
    const x = pixel % width;
    const y = (pixel - x) / width;
    const ridges = Math.abs(fractal(spec.seed + 104729, x, y, scale / 2, 4) - 0.5) * 2;
    elevation[pixel] =
      kind[pixel] === LAND
        ? Math.min(1, 0.08 + inland * 0.35 + Math.pow(1 - ridges, 3) * 0.6 * inland)
        : -Math.min(1, (coastDistance[pixel] ?? 0) / 30);
  }
  return { kind, elevation, moisture };
}

// ---------------------------------------------------------------------------------------------
// Provinces

interface Provinces {
  /** Province number for each pixel, 0-based; -1 never remains after generation. */
  pixel: Int32Array;
  kind: number[];
  size: number[];
  sumX: number[];
  sumY: number[];
  neighbors: Array<Set<number>>;
}

function seedsFor(
  surface: Surface,
  spec: WorldSpec,
  random: Random,
  wanted: number,
  cellPixels: number,
): number[] {
  const { width, height } = spec;
  const cell = Math.max(3, Math.round(Math.sqrt(cellPixels)));
  const seeds: number[] = [];
  for (let cy = 0; cy < height; cy += cell)
    for (let cx = 0; cx < width; cx += cell) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const x = Math.min(width - 1, cx + random.int(cell));
        const y = Math.min(height - 1, cy + random.int(cell));
        const pixel = y * width + x;
        if (surface.kind[pixel] === wanted) {
          seeds.push(pixel);
          break;
        }
      }
    }
  return seeds;
}

function generateProvinces(surface: Surface, spec: WorldSpec, random: Random): Provinces {
  const { width, height } = spec;
  const total = width * height;
  const pixel = new Int32Array(total).fill(-1);
  const seeds = [
    ...seedsFor(surface, spec, random, LAND, spec.landProvincePixels),
    ...seedsFor(surface, spec, random, SEA, spec.seaProvincePixels),
    ...seedsFor(surface, spec, random, LAKE, spec.landProvincePixels * 2),
  ];
  // Every connected patch of one kind needs at least one seed.
  const parts = components(surface.kind, width, height);
  const seeded = new Set(seeds.map((seed) => parts.component[seed]!));
  for (let start = 0; start < total; start += 1)
    if (!seeded.has(parts.component[start]!)) {
      seeds.push(start);
      seeded.add(parts.component[start]!);
    }
  // Grow every province at the same pace, only through pixels of its own kind, so each
  // province is connected and its shape approximates a Voronoi cell.
  let frontier: number[] = [];
  for (const [id, seed] of seeds.entries()) {
    if (pixel[seed] !== -1) continue;
    pixel[seed] = id;
    frontier.push(seed);
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const current of frontier)
      for (const neighbor of neighbors4(width, height, current))
        if (pixel[neighbor] === -1 && surface.kind[neighbor] === surface.kind[current]) {
          pixel[neighbor] = pixel[current]!;
          next.push(neighbor);
        }
    frontier = next;
  }
  removeCrossings(pixel, surface.kind, width, height);
  return compactProvinces(pixel, surface.kind, spec, width, height);
}

/**
 * Remove "X crossings", where four provinces meet at one pixel corner, by giving one pixel of
 * the 2x2 block to a neighbour of the same kind.
 */
function removeCrossings(pixel: Int32Array, kind: Uint8Array, width: number, height: number): void {
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let y = 0; y + 1 < height; y += 1)
      // The map wraps east to west, so the last column meets the first.
      for (let x = 0; x < width; x += 1) {
        const a = y * width + x;
        const b = x + 1 < width ? a + 1 : y * width;
        const c = a + width;
        const d = x + 1 < width ? c + 1 : (y + 1) * width;
        const ids = new Set([pixel[a], pixel[b], pixel[c], pixel[d]]);
        if (ids.size < 4) continue;
        if (kind[d] === kind[b]) pixel[d] = pixel[b]!;
        else if (kind[d] === kind[c]) pixel[d] = pixel[c]!;
        else if (kind[a] === kind[b]) pixel[a] = pixel[b]!;
        else if (kind[a] === kind[c]) pixel[a] = pixel[c]!;
        else continue;
        changed = true;
      }
    if (!changed) return;
  }
}

/**
 * Keep each province's largest connected piece, give smaller pieces and tiny provinces to a
 * neighbour of the same kind, and renumber the survivors densely.
 */
function compactProvinces(
  pixel: Int32Array,
  kind: Uint8Array,
  spec: WorldSpec,
  width: number,
  height: number,
): Provinces {
  const total = width * height;
  for (let pass = 0; pass < 3; pass += 1) {
    const seen = new Int32Array(total).fill(-1);
    const best = new Map<number, { piece: number; size: number }>();
    const pieceSizes: number[] = [];
    const pieceOwner: number[] = [];
    const queue = new Int32Array(total);
    for (let start = 0; start < total; start += 1) {
      if (seen[start] !== -1) continue;
      const piece = pieceSizes.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      seen[start] = piece;
      while (head < tail) {
        const current = queue[head++]!;
        for (const next of neighbors4(width, height, current))
          if (seen[next] === -1 && pixel[next] === pixel[start]) {
            seen[next] = piece;
            queue[tail++] = next;
          }
      }
      pieceSizes.push(tail);
      pieceOwner.push(pixel[start]!);
      const current = best.get(pixel[start]!);
      if (current === undefined || tail > current.size)
        best.set(pixel[start]!, { piece, size: tail });
    }
    const minimum = 20;
    let changed = false;
    for (let current = 0; current < total; current += 1) {
      const piece = seen[current]!;
      const owner = pieceOwner[piece]!;
      const keep = best.get(owner)!.piece === piece && pieceSizes[piece]! >= minimum;
      if (keep) continue;
      for (const next of neighbors4(width, height, current))
        if (seen[next] !== piece && kind[next] === kind[current]) {
          pixel[current] = pixel[next]!;
          changed = true;
          break;
        }
    }
    if (!changed) break;
  }
  removeCrossings(pixel, kind, width, height);
  // Dense renumbering in reading order of each province's first pixel.
  const renumber = new Map<number, number>();
  const result: Provinces = {
    pixel: new Int32Array(total),
    kind: [],
    size: [],
    sumX: [],
    sumY: [],
    neighbors: [],
  };
  for (let current = 0; current < total; current += 1) {
    let id = renumber.get(pixel[current]!);
    if (id === undefined) {
      id = result.kind.length;
      renumber.set(pixel[current]!, id);
      result.kind.push(kind[current]!);
      result.size.push(0);
      result.sumX.push(0);
      result.sumY.push(0);
      result.neighbors.push(new Set());
    }
    result.pixel[current] = id;
    result.size[id]! += 1;
    result.sumX[id]! += current % width;
    result.sumY[id]! += Math.floor(current / width);
  }
  for (let current = 0; current < total; current += 1) {
    const id = result.pixel[current]!;
    for (const next of neighbors4(width, height, current)) {
      const other = result.pixel[next]!;
      if (other !== id) result.neighbors[id]!.add(other);
    }
  }
  if (result.kind.length > 65_000)
    throw new ServiceError(
      'MAP_WORLD_TOO_MANY_PROVINCES',
      'The world would have more provinces than the game can draw; raise landProvincePixels or seaProvincePixels',
      { provinces: result.kind.length },
    );
  void spec;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Grouping provinces into regions and states

/** Grow clusters of about `target` members over a graph from spread-out seeds. */
function growClusters(
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
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
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
  ['hills', 2],
  ['desert', 3],
  ['mountain', 6],
  ['marsh', 9],
  ['urban', 13],
  ['lakes', 14],
  ['ocean', 15],
  ['jungle', 21],
]);

/** Approximate 1936 weather for a latitude between 0 (equator) and 1 (pole). */
function weatherBlock(latitude: number, desert: boolean): string {
  const periods: string[] = [];
  const days = [30, 27, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30];
  for (let month = 0; month < 12; month += 1) {
    const season = Math.cos(((month - 6.5) / 12) * Math.PI * 2);
    const mean = 30 - latitude * 45 - season * (6 + latitude * 18);
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
  const surface = generateSurface(spec, random);
  const provinces = generateProvinces(surface, spec, random);
  const count = provinces.kind.length;
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
  const capitals: number[] = [];
  const largest = [...landIds].sort(
    (left, right) => provinces.size[right]! - provinces.size[left]! || left - right,
  );
  capitals.push(largest[random.int(Math.min(largest.length, 8))]!);
  while (capitals.length < countryCount) {
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
  const frontiers = capitals.map((capital, index) => {
    owner.set(capital, index);
    owned[index] = provinces.size[capital]!;
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
  const landRegion = growClusters(landIds, graph, spec.landProvincesPerRegion, random);
  const seaRegion = growClusters(seaIds, graph, spec.seaProvincesPerRegion, random);
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
    const clusters = growClusters(members, graph, spec.provincesPerState, random);
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
      };
      states.push(draft);
      for (const id of sorted) stateOf.set(id, draft);
    }
  }
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
  for (const [index, capital] of capitals.entries())
    countryCapitalState.set(spec.countries[index]!.tag, stateOf.get(capital)!);
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
      `continents = {\n${continentNames.map((_, index) => `\tworld_continent_${index + 1}`).join('\n')}\n}\n`,
    ),
  );
  add(
    `${map}/adjacencies.csv`,
    text(
      'From;To;Type;Through;start_x;start_y;stop_x;stop_y;adjacency_rule_name;Comment\r\n-1;-1;;-1;-1;-1;-1;-1;-1\r\n',
    ),
  );
  add(`${map}/adjacency_rules.txt`, text('# No straits or canals in this world yet.\n'));
  add(`${map}/positions.txt`, text(''));
  add(
    `${map}/ambient_object.txt`,
    text('# No ambient objects: the base-game map frame does not fit this map.\n'),
  );
  // heightmap.bmp: sea below 95, land from 96 up.
  const heights = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const value = surface.elevation[pixel]!;
    heights[pixel] =
      surface.kind[pixel] === LAND
        ? Math.min(255, Math.round(96 + value * 110))
        : surface.kind[pixel] === LAKE
          ? 93
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
  const terrainPixels = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const id = provinces.pixel[pixel]!;
    const type = terrain.get(id)!;
    const snowy = type === 'mountain' && latitude(id) > 0.7;
    terrainPixels[pixel] = snowy
      ? 16
      : (terrainIndex.get(type) ?? DEFAULT_TERRAIN_INDEX.get(type) ?? 0);
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
  const riverPixels = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1)
    riverPixels[pixel] = surface.kind[pixel] === LAND ? 255 : 254;
  let riverCount = 0;
  for (let attempt = 0; attempt < spec.rivers * 30 && riverCount < spec.rivers; attempt += 1) {
    let current = random.int(width * height);
    if (surface.kind[current] !== LAND || surface.elevation[current]! < 0.45) continue;
    const path: number[] = [current];
    const visited = new Set(path);
    let reachedCoast = false;
    for (let step = 0; step < width; step += 1) {
      const options = neighbors4(width, height, current).filter((next) => !visited.has(next));
      if (options.some((next) => surface.kind[next] === SEA)) {
        reachedCoast = true;
        break;
      }
      const landOptions = options.filter(
        (next) => surface.kind[next] === LAND && riverPixels[next] === 255,
      );
      // A river must not touch another river except at its own previous pixel.
      const clear = landOptions.filter((next) =>
        neighbors4(width, height, next).every(
          (around) =>
            around === current || (riverPixels[around] ?? 255) >= 254 || path.includes(around),
        ),
      );
      if (clear.length === 0) break;
      clear.sort(
        (left, right) => surface.elevation[left]! - surface.elevation[right]! || left - right,
      );
      current = clear[0]!;
      path.push(current);
      visited.add(current);
    }
    if (!reachedCoast || path.length < 12) continue;
    for (const [position, pixel] of path.entries())
      riverPixels[pixel] =
        position === 0 ? 0 : Math.min(6, 3 + Math.floor((position / path.length) * 4));
    riverCount += 1;
  }
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
      const type = terrain.get(provinces.pixel[source]!);
      const dense = surface.moisture[source]! > 0.6;
      treePixels[y * treeWidth + x] =
        type === 'forest' ? (dense ? 6 : 5) : type === 'jungle' ? (dense ? 29 : 28) : 0;
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
  // cities.bmp: the city-type map cities.txt reads (land 0, water 15 in the base game).
  const cityPixels = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1)
    cityPixels[pixel] = surface.kind[pixel] === LAND ? 0 : 15;
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
  // world_normal.bmp at half size from the height gradient.
  const halfWidth = width / 2;
  const halfHeight = height / 2;
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
  const colormap = new Uint8Array(halfWidth * halfHeight * 4);
  for (let y = 0; y < halfHeight; y += 1)
    for (let x = 0; x < halfWidth; x += 1) {
      // DDS rows run top to bottom, like the bitmaps' top-left coordinates used here.
      const source = y * 2 * width + x * 2;
      const id = provinces.pixel[source]!;
      const color = tint[terrain.get(id) ?? 'plains']!;
      const shade = 0.85 + surface.moisture[source]! * 0.3;
      const offset = (y * halfWidth + x) * 4;
      colormap[offset] = Math.min(255, Math.round(color.b * shade));
      colormap[offset + 1] = Math.min(255, Math.round(color.g * shade));
      colormap[offset + 2] = Math.min(255, Math.round(color.r * shade));
      colormap[offset + 3] = terrain.get(id) === 'urban' ? 200 : 0;
    }
  add(
    `${map}/terrain/colormap_rgb_cityemissivemask_a.dds`,
    encodeDds(halfWidth, halfHeight, colormap),
    'image/vnd-ms.dds',
  );
  for (const level of [0, 1, 2]) {
    const factor = 2 ** (level + 1);
    const levelWidth = width / factor;
    const levelHeight = height / factor;
    const water = new Uint8Array(levelWidth * levelHeight * 4);
    for (let y = 0; y < levelHeight; y += 1)
      for (let x = 0; x < levelWidth; x += 1) {
        const depth = Math.max(0, -surface.elevation[y * factor * width + x * factor]!);
        const offset = (y * levelWidth + x) * 4;
        water[offset] = Math.round(120 - depth * 50);
        water[offset + 1] = Math.round(90 - depth * 40);
        water[offset + 2] = Math.round(40 - depth * 20);
        water[offset + 3] = 255;
      }
    add(
      `${map}/terrain/colormap_water_${level}.dds`,
      encodeDds(levelWidth, levelHeight, water),
      'image/vnd-ms.dds',
    );
  }
  // Strategic regions with weather by latitude.
  const regionMembers = new Map<number, number[]>();
  for (const [id, region] of regionOf) {
    const list = regionMembers.get(region) ?? [];
    list.push(provinceId(id));
    regionMembers.set(region, list);
  }
  for (const [region, members] of [...regionMembers].sort((left, right) => left[0] - right[0])) {
    const indexes = members.map((member) => member - 1);
    const meanLatitude = indexes.reduce((sum, id) => sum + latitude(id), 0) / indexes.length;
    const desert = indexes.filter((id) => terrain.get(id) === 'desert').length > indexes.length / 2;
    const naval = indexes.every((id) => provinces.kind[id] !== LAND);
    add(
      `${map}/strategicregions/${region}-World region ${region}.txt`,
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
      ...[...state.navalBases].map(
        ([id, level]) => `\t\t\t${provinceId(id)} = { naval_base = ${level} }`,
      ),
    ];
    add(
      `${context.statesRoot}/${state.id}-STATE_${state.id}.txt`,
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
  for (const [index, country] of spec.countries.entries()) {
    const color = country.color ?? {
      r: 60 + random.int(170),
      g: 60 + random.int(170),
      b: 60 + random.int(170),
    };
    const fileName = slug(country.name);
    const ideology = country.ideology ?? 'neutrality';
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
      `history/countries/${country.tag} - ${fileName}.txt`,
      text(
        [
          `capital = ${capitalState.id}`,
          '',
          'set_research_slots = 3',
          'set_stability = 0.6',
          'set_war_support = 0.2',
          '',
          'set_technology = {',
          '\tinfantry_weapons = 1',
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
          '',
        ].join('\n'),
      ),
    );
    countryLocalisation.push(
      [country.tag, country.name],
      [`${country.tag}_DEF`, country.name],
      [`${country.tag}_ADJ`, country.adjective ?? country.name],
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
    `${context.localisationRoot}/english/world_l_english.yml`,
    localisation([
      ...states.map((state) => [`STATE_${state.id}`, `${state.owner} ${state.id}`] as const),
      ...states.flatMap((state) =>
        [...state.victoryPoints.keys()].map(
          (id) =>
            [`VICTORY_POINTS_${provinceId(id)}`, `${state.owner} City ${provinceId(id)}`] as const,
        ),
      ),
      ...[...regionMembers.keys()]
        .sort((a, b) => a - b)
        .map((region) => [`STRATEGICREGION_${region}`, `Region ${region}`] as const),
      ...continentNames.map((name, index) => [`world_continent_${index + 1}`, name] as const),
      ...countryLocalisation,
      ['WORLD_BOOKMARK_NAME', 'A New World'],
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
