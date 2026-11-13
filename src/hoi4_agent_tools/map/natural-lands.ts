import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { ServiceError } from '../core/result.js';
import { BORDER_PROVINCE_KIND, type BorderPlane } from './border-quality.js';
import { borderQualityInputFromIndex } from './border-quality-input.js';
import { NATURAL_LAND_KINDS, NATURAL_TERRAIN_CLASSES } from './limits.js';
import type { MapWorkspaceIndex } from './model.js';

/**
 * Natural lands: the land provinces of a map cut into the pieces its ground suggests. Lines run
 * where neighbouring provinces are split by a major river, a crest or a change of terrain class;
 * open country without such lines is cut into drainage basins (each province drains to its lowest
 * neighbour, coasts and lakes are sinks), and fragments below a minimum size join the neighbour
 * across their weakest line. The result is deterministic for the same map and options.
 */

export { NATURAL_LAND_KINDS, NATURAL_TERRAIN_CLASSES };
export type NaturalLandKind = (typeof NATURAL_LAND_KINDS)[number];

export type NaturalTerrainClass = (typeof NATURAL_TERRAIN_CLASSES)[number];

/** Default class of a provincial terrain category; any other category is open ground. */
export const NATURAL_TERRAIN_CLASS_DEFAULTS: Readonly<Record<string, NaturalTerrainClass>> = {
  desert: 'desert',
  forest: 'forest',
  hills: 'upland',
  jungle: 'forest',
  marsh: 'marsh',
  mountain: 'upland',
};

/** Highest `rivers.bmp` index that is a river width; higher indices are land and water. */
const RIVER_WIDTH_MAX_INDEX = 11;
/** Strength of a line kind when choosing the weakest line to merge a fragment across. */
const LINE_STRENGTH = { river: 1, crest: 1, terrain: 0.5, divide: 0.2 } as const;
const CLASS_PRIORITY: readonly NaturalTerrainClass[] = [
  'upland',
  'forest',
  'marsh',
  'desert',
  'open',
];
const MAX_PROVINCES = 65_535;

export interface NaturalLandsOptions {
  /** Lands smaller than this many provinces merge across their weakest line. Default 6. */
  minProvinces?: number | undefined;
  /** Drainage basins smaller than this merge over their lowest pass. Default `minProvinces`. */
  minBasinProvinces?: number | undefined;
  /** Basins larger than this split at branch points of their drainage tree. Default none. */
  maxBasinProvinces?: number | undefined;
  /** `rivers.bmp` width index from which a river is major (up to 11). Default 6. */
  riverMajorIndex?: number | undefined;
  /** Share of a border's pixel edges that must touch a major river pixel. Default 0.4. */
  riverShare?: number | undefined;
  /** Mean border height above the higher province's mean height that makes a crest. Default 3.5. */
  crestExcess?: number | undefined;
  /** Let crests between two upland provinces cut ranges apart. Default false. */
  splitRangesAtCrests?: boolean | undefined;
  /** Class of provincial terrain categories, over the defaults (for example a mod's own types). */
  terrainClasses?: Readonly<Record<string, NaturalTerrainClass>> | undefined;
  signal?: AbortSignal | undefined;
}

export interface ResolvedNaturalLandsOptions {
  minProvinces: number;
  minBasinProvinces: number;
  maxBasinProvinces: number | null;
  riverMajorIndex: number;
  riverShare: number;
  crestExcess: number;
  splitRangesAtCrests: boolean;
  terrainClasses: Record<string, NaturalTerrainClass>;
}

export interface NaturalLandsInput {
  width: number;
  height: number;
  /** Province id per pixel, row-major from the top left; negative where unknown. */
  provinceIds: Int32Array;
  /** Kind per province id, from `BORDER_PROVINCE_KIND`. */
  provinceKinds: Uint8Array;
  /** Provincial terrain category per province id (`definition.csv`), empty when unknown. */
  provinceTerrain: readonly string[];
  heights?: BorderPlane;
  rivers?: BorderPlane;
}

/** The line between a land and one neighbouring land, as border pixel edges per kind. */
export interface NaturalLandLine {
  land: string;
  /** Pixel edges shared with the neighbour. */
  length: number;
  /** Pixel edges on borders that follow a major river. */
  river: number;
  /** Pixel edges on borders along a crest. */
  crest: number;
  /** Pixel edges on borders where the terrain class changes. */
  terrain: number;
  /** Pixel edges on borders with none of these: a drainage divide. */
  divide: number;
}

export interface NaturalLand {
  id: string;
  kind: NaturalLandKind;
  provinces: number[];
  pixels: number;
  /** Touches the sea. */
  coast: boolean;
  /** Touches a lake. */
  lakeShore: boolean;
  /** Pixel mean of the heightmap, null without one. */
  meanHeight: number | null;
  /** Share of provinces per provincial terrain category. */
  terrain: Record<string, number>;
  lines: NaturalLandLine[];
}

export interface NaturalLandsResult {
  schemaVersion: 1;
  options: ResolvedNaturalLandsOptions;
  inputs: { heights: boolean; rivers: boolean };
  landProvinces: number;
  counts: Record<NaturalLandKind, number>;
  /** Lands still below `minProvinces` because they have no land neighbour, such as islands. */
  undersized: string[];
  lands: NaturalLand[];
}

function invalid(option: string, message: string, value: unknown): ServiceError {
  return new ServiceError('MAP_NATURAL_LANDS_OPTION_INVALID', message, { option, value });
}

export function resolveNaturalLandsOptions(
  options: NaturalLandsOptions = {},
): ResolvedNaturalLandsOptions {
  const minProvinces = options.minProvinces ?? 6;
  const minBasinProvinces = options.minBasinProvinces ?? minProvinces;
  const maxBasinProvinces = options.maxBasinProvinces ?? null;
  const riverMajorIndex = options.riverMajorIndex ?? 6;
  const riverShare = options.riverShare ?? 0.4;
  const crestExcess = options.crestExcess ?? 3.5;
  for (const [name, value, minimum, maximum] of [
    ['minProvinces', minProvinces, 1, 10_000],
    ['minBasinProvinces', minBasinProvinces, 1, 10_000],
    ['riverMajorIndex', riverMajorIndex, 0, RIVER_WIDTH_MAX_INDEX],
  ] as const)
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw invalid(name, `${name} must be an integer from ${minimum} to ${maximum}`, value);
  if (
    maxBasinProvinces !== null &&
    (!Number.isInteger(maxBasinProvinces) ||
      maxBasinProvinces < 2 * minBasinProvinces ||
      maxBasinProvinces > 100_000)
  )
    throw invalid(
      'maxBasinProvinces',
      'maxBasinProvinces must be an integer from twice minBasinProvinces to 100000',
      maxBasinProvinces,
    );
  if (!Number.isFinite(riverShare) || riverShare <= 0 || riverShare > 1)
    throw invalid('riverShare', 'riverShare must be above 0 and at most 1', riverShare);
  if (!Number.isFinite(crestExcess) || crestExcess <= 0 || crestExcess > 255)
    throw invalid('crestExcess', 'crestExcess must be above 0 and at most 255', crestExcess);
  const terrainClasses: Record<string, NaturalTerrainClass> = {};
  for (const [name, value] of Object.entries(options.terrainClasses ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!(NATURAL_TERRAIN_CLASSES as readonly string[]).includes(value))
      throw invalid('terrainClasses', `Terrain class of ${name} is not a known class`, value);
    terrainClasses[name.toLowerCase()] = value;
  }
  return {
    minProvinces,
    minBasinProvinces,
    maxBasinProvinces,
    riverMajorIndex,
    riverShare,
    crestExcess,
    splitRangesAtCrests: options.splitRangesAtCrests ?? false,
    terrainClasses,
  };
}

const PAIR_RIVER = 1;
const PAIR_CREST = 2;
const PAIR_TERRAIN = 4;
const PAIR_CUT = 8;

/** Province-pair evidence from one pass over the raster. */
interface PairTable {
  count: number;
  a: Int32Array;
  b: Int32Array;
  length: Uint32Array;
  /** Mean height along the border pixels (0 without a heightmap). */
  pass: Float64Array;
  flags: Uint8Array;
}

interface ProvinceFacts {
  land: Uint8Array;
  pixels: Uint32Array;
  meanHeight: Float64Array;
  coast: Uint8Array;
  lake: Uint8Array;
  classOf: NaturalTerrainClass[];
}

function classOfTerrain(
  terrain: string,
  overrides: Readonly<Record<string, NaturalTerrainClass>>,
): NaturalTerrainClass {
  const key = terrain.toLowerCase();
  return overrides[key] ?? NATURAL_TERRAIN_CLASS_DEFAULTS[key] ?? 'open';
}

function* scanRaster(
  input: NaturalLandsInput,
  options: ResolvedNaturalLandsOptions,
  signal: AbortSignal | undefined,
): Generator<void, { facts: ProvinceFacts; pairs: PairTable }, void> {
  const { width, height, provinceIds, provinceKinds } = input;
  const count = provinceKinds.length;
  if (provinceIds.length !== width * height)
    throw new ServiceError(
      'MAP_NATURAL_LANDS_INPUT_INVALID',
      'The province raster does not match its dimensions',
      { width, height, length: provinceIds.length },
    );
  if (count > MAX_PROVINCES + 1)
    throw new ServiceError(
      'MAP_NATURAL_LANDS_INPUT_INVALID',
      `Natural lands support province ids up to ${MAX_PROVINCES}`,
      { provinces: count },
    );
  for (const [name, plane] of [
    ['heights', input.heights],
    ['rivers', input.rivers],
  ] as const)
    if (plane !== undefined && (plane.width !== width || plane.height !== height))
      throw new ServiceError(
        'MAP_NATURAL_LANDS_INPUT_INVALID',
        `The ${name} plane must match the province raster size`,
        { plane: name, width: plane.width, height: plane.height },
      );
  const land = new Uint8Array(count);
  const coast = new Uint8Array(count);
  const lake = new Uint8Array(count);
  const pixels = new Uint32Array(count);
  const heightSum = new Float64Array(count);
  const kindOf = (id: number): number => (id >= 0 && id < count ? provinceKinds[id]! : 0);
  let capacity = 4_096;
  let pairA = new Int32Array(capacity);
  let pairB = new Int32Array(capacity);
  let pairLength = new Uint32Array(capacity);
  let pairRiver = new Uint32Array(capacity);
  let pairHeight = new Float64Array(capacity);
  let pairs = 0;
  const slots = new Map<number, number>();
  const major = (value: number): boolean =>
    value >= options.riverMajorIndex && value <= RIVER_WIDTH_MAX_INDEX;
  const heightRows = [new Uint8Array(width), new Uint8Array(width)];
  const riverRows = [new Uint8Array(width), new Uint8Array(width)];
  const visit = (a: number, b: number, heightA: number, heightB: number, river: boolean): void => {
    if (a === b) return;
    const kindA = kindOf(a);
    const kindB = kindOf(b);
    if (kindA === BORDER_PROVINCE_KIND.land && kindB === BORDER_PROVINCE_KIND.land) {
      const low = a < b ? a : b;
      const high = a < b ? b : a;
      const key = low * 65_536 + high;
      let slot = slots.get(key);
      if (slot === undefined) {
        slot = pairs;
        pairs += 1;
        if (slot === capacity) {
          capacity *= 2;
          const grow = <T extends Int32Array | Uint32Array | Float64Array>(array: T): T => {
            const bigger = new (array.constructor as new (length: number) => T)(capacity);
            bigger.set(array);
            return bigger;
          };
          pairA = grow(pairA);
          pairB = grow(pairB);
          pairLength = grow(pairLength);
          pairRiver = grow(pairRiver);
          pairHeight = grow(pairHeight);
        }
        pairA[slot] = low;
        pairB[slot] = high;
        slots.set(key, slot);
      }
      pairLength[slot]! += 1;
      if (river) pairRiver[slot]! += 1;
      pairHeight[slot]! += (heightA + heightB) / 2;
      return;
    }
    if (kindA === BORDER_PROVINCE_KIND.land) {
      if (kindB === BORDER_PROVINCE_KIND.sea) coast[a] = 1;
      else if (kindB === BORDER_PROVINCE_KIND.lake) lake[a] = 1;
    } else if (kindB === BORDER_PROVINCE_KIND.land) {
      if (kindA === BORDER_PROVINCE_KIND.sea) coast[b] = 1;
      else if (kindA === BORDER_PROVINCE_KIND.lake) lake[b] = 1;
    }
  };
  const readRows = (y: number, slot: number): void => {
    input.heights?.readRow(y, heightRows[slot]!);
    input.rivers?.readRow(y, riverRows[slot]!);
  };
  readRows(0, 0);
  let here = 0;
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) {
      signal?.throwIfAborted();
      if (y > 0) yield;
    }
    const next = 1 - here;
    if (y + 1 < height) readRows(y + 1, next);
    const heightsHere = heightRows[here]!;
    const heightsNext = heightRows[next]!;
    const riversHere = riverRows[here]!;
    const riversNext = riverRows[next]!;
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + x;
      const id = provinceIds[pixel]!;
      if (kindOf(id) === BORDER_PROVINCE_KIND.land) {
        land[id] = 1;
        pixels[id]! += 1;
        heightSum[id]! += heightsHere[x]!;
      }
      const east = x === width - 1 ? 0 : x + 1;
      const eastId = provinceIds[rowStart + east]!;
      if (eastId !== id)
        visit(
          id,
          eastId,
          heightsHere[x]!,
          heightsHere[east]!,
          major(riversHere[x]!) || major(riversHere[east]!),
        );
      if (y + 1 < height) {
        const southId = provinceIds[pixel + width]!;
        if (southId !== id)
          visit(
            id,
            southId,
            heightsHere[x]!,
            heightsNext[x]!,
            major(riversHere[x]!) || major(riversNext[x]!),
          );
      }
    }
    here = next;
  }
  const meanHeight = new Float64Array(count);
  const classOf: NaturalTerrainClass[] = new Array<NaturalTerrainClass>(count).fill('open');
  for (let id = 0; id < count; id += 1) {
    if (pixels[id]! > 0) meanHeight[id] = heightSum[id]! / pixels[id]!;
    classOf[id] = classOfTerrain(input.provinceTerrain[id] ?? '', options.terrainClasses);
  }
  // Order pairs by (low, high) so every later walk is deterministic.
  const order = Array.from({ length: pairs }, (_, i) => i).sort(
    (x, y) => pairA[x]! - pairA[y]! || pairB[x]! - pairB[y]!,
  );
  const table: PairTable = {
    count: pairs,
    a: new Int32Array(pairs),
    b: new Int32Array(pairs),
    length: new Uint32Array(pairs),
    pass: new Float64Array(pairs),
    flags: new Uint8Array(pairs),
  };
  for (const [slot, from] of order.entries()) {
    const a = pairA[from]!;
    const b = pairB[from]!;
    const length = pairLength[from]!;
    const pass = pairHeight[from]! / length;
    let flags = 0;
    if (input.rivers !== undefined && pairRiver[from]! / length >= options.riverShare)
      flags |= PAIR_RIVER;
    if (
      input.heights !== undefined &&
      pass - Math.max(meanHeight[a]!, meanHeight[b]!) >= options.crestExcess
    )
      flags |= PAIR_CREST;
    if (classOf[a] !== classOf[b]) flags |= PAIR_TERRAIN;
    const bothUpland = classOf[a] === 'upland' && classOf[b] === 'upland';
    if (
      (flags & (PAIR_RIVER | PAIR_TERRAIN)) !== 0 ||
      ((flags & PAIR_CREST) !== 0 && (options.splitRangesAtCrests || !bothUpland))
    )
      flags |= PAIR_CUT;
    table.a[slot] = a;
    table.b[slot] = b;
    table.length[slot] = length;
    table.pass[slot] = pass;
    table.flags[slot] = flags;
  }
  return { facts: { land, pixels, meanHeight, coast, lake, classOf }, pairs: table };
}

/** Land neighbours of every province with the pair index of the shared border. */
interface Adjacency {
  offsets: Int32Array;
  to: Int32Array;
  pair: Int32Array;
}

function buildAdjacency(count: number, pairs: PairTable): Adjacency {
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i < pairs.count; i += 1) {
    offsets[pairs.a[i]! + 1]! += 1;
    offsets[pairs.b[i]! + 1]! += 1;
  }
  for (let i = 0; i < count; i += 1) offsets[i + 1]! += offsets[i]!;
  const cursor = offsets.slice(0, count);
  const to = new Int32Array(offsets[count]!);
  const pair = new Int32Array(offsets[count]!);
  // Pairs are sorted by (low, high), so each row is filled in ascending neighbour order per side.
  for (let i = 0; i < pairs.count; i += 1) {
    const a = pairs.a[i]!;
    const b = pairs.b[i]!;
    to[cursor[a]!] = b;
    pair[cursor[a]!++] = i;
    to[cursor[b]!] = a;
    pair[cursor[b]!++] = i;
  }
  return { offsets, to, pair };
}

/** A binary min-heap of `[size, key, group]` entries. */
class GroupHeap {
  readonly #items: [number, number, number][] = [];
  get size(): number {
    return this.#items.length;
  }
  static #less(x: [number, number, number], y: [number, number, number]): boolean {
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  }
  push(item: [number, number, number]): void {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!GroupHeap.#less(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }
  pop(): [number, number, number] | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && GroupHeap.#less(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && GroupHeap.#less(items[right]!, items[smallest]!))
          smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

/** What two groups share: border length, length-weighted line strength, and the lowest pass. */
interface Shared {
  length: number;
  strength: number;
  pass: number;
}

function pairStrength(flags: number): number {
  let strength: number = LINE_STRENGTH.divide;
  if ((flags & PAIR_RIVER) !== 0) strength = Math.max(strength, LINE_STRENGTH.river);
  if ((flags & PAIR_CREST) !== 0) strength = Math.max(strength, LINE_STRENGTH.crest);
  if ((flags & PAIR_TERRAIN) !== 0) strength = Math.max(strength, LINE_STRENGTH.terrain);
  return strength;
}

/**
 * Groups of provinces that merge into neighbours: every merge joins the smallest group below the
 * minimum (ties by smallest province id) into the neighbour the caller chooses.
 */
class GroupGraph {
  readonly members: number[][];
  readonly key: number[];
  readonly alive: boolean[];
  readonly adjacent: Map<number, Shared>[];

  constructor(groups: number[][], groupOf: Int32Array, pairs: PairTable) {
    this.members = groups.map((group) => [...group]);
    this.key = groups.map((group) =>
      group.reduce((lowest, province) => (province < lowest ? province : lowest), Infinity),
    );
    this.alive = groups.map(() => true);
    this.adjacent = groups.map(() => new Map<number, Shared>());
    for (let i = 0; i < pairs.count; i += 1) {
      const x = groupOf[pairs.a[i]!]!;
      const y = groupOf[pairs.b[i]!]!;
      if (x < 0 || y < 0 || x === y) continue;
      const shared = {
        length: pairs.length[i]!,
        strength: pairStrength(pairs.flags[i]!) * pairs.length[i]!,
        pass: pairs.pass[i]!,
      };
      GroupGraph.#add(this.adjacent[x]!, y, shared);
      GroupGraph.#add(this.adjacent[y]!, x, shared);
    }
  }

  static #add(row: Map<number, Shared>, other: number, shared: Shared): void {
    const entry = row.get(other);
    if (entry === undefined) row.set(other, { ...shared });
    else {
      entry.length += shared.length;
      entry.strength += shared.strength;
      entry.pass = Math.min(entry.pass, shared.pass);
    }
  }

  merge(into: number, from: number): void {
    this.members[into]!.push(...this.members[from]!);
    this.key[into] = Math.min(this.key[into]!, this.key[from]!);
    this.alive[from] = false;
    const row = this.adjacent[into]!;
    row.delete(from);
    for (const [other, shared] of this.adjacent[from]!) {
      if (other === into) continue;
      GroupGraph.#add(row, other, shared);
      const otherRow = this.adjacent[other]!;
      otherRow.delete(from);
      GroupGraph.#add(otherRow, into, shared);
    }
    this.adjacent[from]!.clear();
  }

  /**
   * Merge every group below `minimum` into the neighbour `better` ranks first, smallest first.
   * Groups with no eligible neighbour stay as they are.
   */
  mergeSmall(
    minimum: number,
    eligible: (group: number, other: number) => boolean,
    better: (x: [number, Shared], y: [number, Shared]) => boolean,
  ): void {
    const heap = new GroupHeap();
    for (let group = 0; group < this.members.length; group += 1)
      if (this.alive[group] && this.members[group]!.length < minimum)
        heap.push([this.members[group]!.length, this.key[group]!, group]);
    for (let entry = heap.pop(); entry !== undefined; entry = heap.pop()) {
      const [size, , group] = entry;
      if (!this.alive[group] || this.members[group]!.length !== size || size >= minimum) continue;
      let best: [number, Shared] | undefined;
      for (const candidate of this.adjacent[group]!) {
        if (!this.alive[candidate[0]] || !eligible(group, candidate[0])) continue;
        if (best === undefined || better(candidate, best)) best = candidate;
      }
      if (best === undefined) continue;
      const target = best[0];
      this.merge(target, group);
      if (this.members[target]!.length < minimum)
        heap.push([this.members[target]!.length, this.key[target]!, target]);
    }
  }

  groups(): number[][] {
    return this.members
      .filter((_, group) => this.alive[group])
      .map((members) => [...members].sort((x, y) => x - y));
  }
}

function connectedComponents(
  provinces: readonly number[],
  adjacency: Adjacency,
  joined: (pair: number) => boolean,
  inside: (province: number) => boolean,
  componentOf: Int32Array,
  first: number,
): number[][] {
  const components: number[][] = [];
  for (const start of provinces) {
    if (componentOf[start]! >= 0) continue;
    const id = first + components.length;
    const component: number[] = [];
    const stack = [start];
    componentOf[start] = id;
    while (stack.length > 0) {
      const province = stack.pop()!;
      component.push(province);
      for (
        let slot = adjacency.offsets[province]!;
        slot < adjacency.offsets[province + 1]!;
        slot++
      ) {
        const other = adjacency.to[slot]!;
        if (componentOf[other]! >= 0 || !inside(other) || !joined(adjacency.pair[slot]!)) continue;
        componentOf[other] = id;
        stack.push(other);
      }
    }
    components.push(component.sort((x, y) => x - y));
  }
  return components;
}

/** Split a basin larger than `maximum` at branch points of its drainage tree. */
function splitBasin(
  basin: number[],
  down: Int32Array,
  meanHeight: Float64Array,
  minimum: number,
  maximum: number,
): number[][] {
  if (basin.length <= maximum) return [basin];
  const inBasin = new Set(basin);
  const parent = (province: number): number => {
    const next = down[province]!;
    return next >= 0 && inBasin.has(next) ? next : -1;
  };
  // Downstream provinces are strictly lower, so descending height visits children first.
  const descending = [...basin].sort((x, y) => meanHeight[y]! - meanHeight[x]! || x - y);
  const subtree = new Map<number, number>();
  const children = new Map<number, number>();
  let roots = 0;
  for (const province of descending) {
    const size = (subtree.get(province) ?? 0) + 1;
    subtree.set(province, size);
    const up = parent(province);
    if (up < 0) roots += 1;
    else {
      subtree.set(up, (subtree.get(up) ?? 0) + size);
      children.set(up, (children.get(up) ?? 0) + 1);
    }
  }
  let fitting: number | undefined;
  let smallest: number | undefined;
  for (const province of basin) {
    const up = parent(province);
    const branches = up < 0 ? roots : children.get(up)!;
    if (branches < 2) continue;
    const size = subtree.get(province)!;
    if (size < minimum || size > basin.length - minimum) continue;
    if (size <= maximum) {
      if (fitting === undefined || size > subtree.get(fitting)!) fitting = province;
    } else if (smallest === undefined || size < subtree.get(smallest)!) smallest = province;
  }
  const cut = fitting ?? smallest;
  if (cut === undefined) return [basin];
  const inCut = new Set<number>([cut]);
  for (const province of [...descending].reverse()) {
    const up = parent(province);
    if (up >= 0 && inCut.has(up)) inCut.add(province);
  }
  const piece = basin.filter((province) => inCut.has(province));
  const rest = basin.filter((province) => !inCut.has(province));
  return [
    ...splitBasin(piece, down, meanHeight, minimum, maximum),
    ...splitBasin(rest, down, meanHeight, minimum, maximum),
  ];
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Cut the land provinces of a map into natural lands, as steps: the generator yields about every
 * 64 raster rows and between stages, so a synchronous planner can interleave its own checkpoints.
 */
export function* naturalLandsSteps(
  input: NaturalLandsInput,
  options: NaturalLandsOptions = {},
): Generator<void, NaturalLandsResult, void> {
  const resolved = resolveNaturalLandsOptions(options);
  const signal = options.signal;
  const { facts, pairs } = yield* scanRaster(input, resolved, signal);
  const count = input.provinceKinds.length;
  const adjacency = buildAdjacency(count, pairs);
  const landProvinces: number[] = [];
  for (let id = 0; id < count; id += 1) if (facts.land[id] === 1) landProvinces.push(id);
  const hasHeights = input.heights !== undefined;

  // 1. Pieces of one terrain class that no line crosses.
  const componentOf = new Int32Array(count).fill(-1);
  const components = connectedComponents(
    landProvinces,
    adjacency,
    (pair) => (pairs.flags[pair]! & PAIR_CUT) === 0,
    () => true,
    componentOf,
    0,
  );
  signal?.throwIfAborted();
  yield;

  // 2. Drainage basins inside every piece that is not a range.
  const down = new Int32Array(count).fill(-1);
  const basins: number[][] = [];
  const basinComponent: number[] = [];
  for (const [index, component] of components.entries()) {
    const drained = hasHeights && facts.classOf[component[0]!] !== 'upland';
    if (!drained) {
      basins.push(component);
      basinComponent.push(index);
      continue;
    }
    for (const province of component) {
      if (facts.coast[province] === 1 || facts.lake[province] === 1) continue;
      let lowest = -1;
      for (
        let slot = adjacency.offsets[province]!;
        slot < adjacency.offsets[province + 1]!;
        slot++
      ) {
        const other = adjacency.to[slot]!;
        if (componentOf[other] !== index) continue;
        if (facts.meanHeight[other]! >= facts.meanHeight[province]!) continue;
        if (
          lowest < 0 ||
          facts.meanHeight[other]! < facts.meanHeight[lowest]! ||
          (facts.meanHeight[other] === facts.meanHeight[lowest] && other < lowest)
        )
          lowest = other;
      }
      down[province] = lowest;
    }
    const sinkOf = new Map<number, number[]>();
    for (const province of component) {
      let sink = province;
      while (down[sink]! >= 0) sink = down[sink]!;
      const members = sinkOf.get(sink);
      if (members === undefined) sinkOf.set(sink, [province]);
      else members.push(province);
    }
    for (const sink of [...sinkOf.keys()].sort((x, y) => x - y)) {
      basins.push(sinkOf.get(sink)!);
      basinComponent.push(index);
    }
  }
  const basinOf = new Int32Array(count).fill(-1);
  for (const [index, basin] of basins.entries())
    for (const province of basin) basinOf[province] = index;
  const basinGraph = new GroupGraph(basins, basinOf, pairs);
  basinGraph.mergeSmall(
    resolved.minBasinProvinces,
    (group, other) => basinComponent[group] === basinComponent[other],
    ([xGroup, x], [yGroup, y]) =>
      x.pass < y.pass ||
      (x.pass === y.pass &&
        (x.length > y.length ||
          (x.length === y.length && basinGraph.key[xGroup]! < basinGraph.key[yGroup]!))),
  );
  let pieces = basinGraph.groups();
  if (resolved.maxBasinProvinces !== null) {
    const maximum = resolved.maxBasinProvinces;
    pieces = pieces.flatMap((piece) =>
      hasHeights && facts.classOf[piece[0]!] !== 'upland'
        ? splitBasin(piece, down, facts.meanHeight, resolved.minBasinProvinces, maximum)
        : [piece],
    );
  }
  signal?.throwIfAborted();
  yield;

  // 3. Every piece in one connected part, then fragments merge across their weakest line.
  const pieceOf = new Int32Array(count).fill(-1);
  for (const [index, piece] of pieces.entries())
    for (const province of piece) pieceOf[province] = index;
  const partOf = new Int32Array(count).fill(-1);
  const parts: number[][] = [];
  for (const piece of pieces) {
    const owner = pieceOf[piece[0]!]!;
    parts.push(
      ...connectedComponents(
        piece,
        adjacency,
        () => true,
        (province) => pieceOf[province] === owner,
        partOf,
        parts.length,
      ),
    );
  }
  const landGraph = new GroupGraph(parts, partOf, pairs);
  landGraph.mergeSmall(
    resolved.minProvinces,
    () => true,
    ([xGroup, x], [yGroup, y]) => {
      const xStrength = x.strength / x.length;
      const yStrength = y.strength / y.length;
      return (
        xStrength < yStrength ||
        (xStrength === yStrength &&
          (x.length > y.length ||
            (x.length === y.length && landGraph.key[xGroup]! < landGraph.key[yGroup]!)))
      );
    },
  );
  const groups = landGraph.groups().sort((x, y) => x[0]! - y[0]!);

  // 4. Describe the lands.
  const landOf = new Int32Array(count).fill(-1);
  for (const [index, group] of groups.entries())
    for (const province of group) landOf[province] = index;
  const ids = groups.map((group) => `L${group[0]!}`);
  const lines = groups.map(() => new Map<number, NaturalLandLine>());
  for (let i = 0; i < pairs.count; i += 1) {
    const x = landOf[pairs.a[i]!]!;
    const y = landOf[pairs.b[i]!]!;
    if (x === y) continue;
    const length = pairs.length[i]!;
    const flags = pairs.flags[i]!;
    for (const [from, to] of [
      [x, y],
      [y, x],
    ] as const) {
      let line = lines[from]!.get(to);
      if (line === undefined) {
        line = { land: ids[to]!, length: 0, river: 0, crest: 0, terrain: 0, divide: 0 };
        lines[from]!.set(to, line);
      }
      line.length += length;
      if ((flags & PAIR_RIVER) !== 0) line.river += length;
      if ((flags & PAIR_CREST) !== 0) line.crest += length;
      if ((flags & PAIR_TERRAIN) !== 0) line.terrain += length;
      if ((flags & (PAIR_RIVER | PAIR_CREST | PAIR_TERRAIN)) === 0) line.divide += length;
    }
  }
  const counts = Object.fromEntries(NATURAL_LAND_KINDS.map((kind) => [kind, 0])) as Record<
    NaturalLandKind,
    number
  >;
  const lands: NaturalLand[] = groups.map((group, index) => {
    const classCount = new Map<NaturalTerrainClass, number>();
    const terrainCount = new Map<string, number>();
    let landPixels = 0;
    let heightTotal = 0;
    let coast = false;
    let lakeShore = false;
    for (const province of group) {
      const terrainClass = facts.classOf[province]!;
      classCount.set(terrainClass, (classCount.get(terrainClass) ?? 0) + 1);
      const terrain = (input.provinceTerrain[province] ?? '') || 'unknown';
      terrainCount.set(terrain, (terrainCount.get(terrain) ?? 0) + 1);
      landPixels += facts.pixels[province]!;
      heightTotal += facts.meanHeight[province]! * facts.pixels[province]!;
      if (facts.coast[province] === 1) coast = true;
      if (facts.lake[province] === 1) lakeShore = true;
    }
    let majority: NaturalTerrainClass = 'open';
    let majorityCount = -1;
    for (const terrainClass of CLASS_PRIORITY) {
      const value = classCount.get(terrainClass) ?? 0;
      if (value > majorityCount) {
        majority = terrainClass;
        majorityCount = value;
      }
    }
    const kind: NaturalLandKind =
      majority === 'upland'
        ? 'range'
        : majority === 'open'
          ? hasHeights
            ? 'basin'
            : 'plains'
          : majority;
    counts[kind] += 1;
    const terrain: Record<string, number> = {};
    for (const name of [...terrainCount.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)))
      terrain[name] = round(terrainCount.get(name)! / group.length, 4);
    return {
      id: ids[index]!,
      kind,
      provinces: group,
      pixels: landPixels,
      coast,
      lakeShore,
      meanHeight: hasHeights ? round(heightTotal / Math.max(1, landPixels), 2) : null,
      terrain,
      lines: [...lines[index]!.entries()]
        .sort(([x], [y]) => groups[x]![0]! - groups[y]![0]!)
        .map(([, line]) => line),
    };
  });
  return {
    schemaVersion: 1,
    options: resolved,
    inputs: { heights: hasHeights, rivers: input.rivers !== undefined },
    landProvinces: landProvinces.length,
    counts,
    undersized: lands
      .filter(({ provinces }) => provinces.length < resolved.minProvinces)
      .map(({ id }) => id),
    lands,
  };
}

/** Drive `naturalLandsSteps`, yielding to the event loop about every 12 milliseconds. */
export async function computeNaturalLands(
  input: NaturalLandsInput,
  options: NaturalLandsOptions = {},
): Promise<NaturalLandsResult> {
  const steps = naturalLandsSteps(input, options);
  let last = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - last >= 12) {
      await yieldToEventLoop();
      options.signal?.throwIfAborted();
      last = performance.now();
    }
  }
}

export interface NaturalLandsIndexResult {
  result: NaturalLandsResult;
  /** Bitmaps that could not be used, with the reason. */
  skipped: { input: string; reason: string }[];
}

/**
 * The natural-lands input of a scanned map workspace: the province raster and kinds, the terrain
 * category of every province from its definition, and the heightmap and rivers bitmap when they
 * are present and the size of the province map.
 */
export function naturalLandsInputFromIndex(index: MapWorkspaceIndex): {
  input: NaturalLandsInput;
  skipped: { input: string; reason: string }[];
} {
  if (index.raster === undefined)
    throw new ServiceError(
      'MAP_NATURAL_LANDS_RASTER_MISSING',
      'Natural lands need a valid province bitmap and definitions',
    );
  const { input, skipped } = borderQualityInputFromIndex(index);
  const provinceTerrain: string[] = new Array<string>(input.provinceKinds.length).fill('');
  for (const definition of index.definitions)
    if (
      Number.isInteger(definition.id) &&
      definition.id >= 0 &&
      definition.id < provinceTerrain.length
    )
      provinceTerrain[definition.id] = definition.terrain;
  return {
    input: {
      width: input.width,
      height: input.height,
      provinceIds: input.provinceIds,
      provinceKinds: input.provinceKinds,
      provinceTerrain,
      ...(input.features?.heights === undefined ? {} : { heights: input.features.heights }),
      ...(input.features?.rivers === undefined ? {} : { rivers: input.features.rivers }),
    },
    skipped: skipped.filter(({ input: name }) => name === 'heightmap' || name === 'rivers'),
  };
}

/** Natural lands of a scanned map workspace (the heightmap and rivers bitmap when present). */
export async function naturalLandsFromIndex(
  index: MapWorkspaceIndex,
  options: NaturalLandsOptions = {},
): Promise<NaturalLandsIndexResult> {
  resolveNaturalLandsOptions(options);
  const { input, skipped } = naturalLandsInputFromIndex(index);
  return { result: await computeNaturalLands(input, options), skipped };
}

export const NATURAL_LANDS_INLINE_LIMIT = 50;

/** Compact, schema-stable summary of natural lands for inline tool results. */
export interface NaturalLandsSummary {
  count: number;
  landProvinces: number;
  counts: Record<NaturalLandKind, number>;
  inputs: { heights: boolean; rivers: boolean };
  skippedInputs: { input: string; reason: string }[];
  undersized: number;
  lands: { id: string; kind: NaturalLandKind; provinces: number; coast: boolean }[];
  truncated: boolean;
}

export function summarizeNaturalLands(
  result: NaturalLandsResult,
  skipped: NaturalLandsIndexResult['skipped'],
): NaturalLandsSummary {
  return {
    count: result.lands.length,
    landProvinces: result.landProvinces,
    counts: result.counts,
    inputs: result.inputs,
    skippedInputs: skipped,
    undersized: result.undersized.length,
    lands: result.lands.slice(0, NATURAL_LANDS_INLINE_LIMIT).map((land) => ({
      id: land.id,
      kind: land.kind,
      provinces: land.provinces.length,
      coast: land.coast,
    })),
    truncated: result.lands.length > NATURAL_LANDS_INLINE_LIMIT,
  };
}

/**
 * The provinces of the named lands, ascending. An unknown land id is refused with
 * `MAP_NATURAL_LAND_UNKNOWN`.
 */
export function naturalLandProvinces(
  result: NaturalLandsResult,
  landIds: readonly string[],
): number[] {
  const byId = new Map(result.lands.map((land) => [land.id, land]));
  const unknown = landIds.filter((id) => !byId.has(id));
  if (unknown.length > 0)
    throw new ServiceError(
      'MAP_NATURAL_LAND_UNKNOWN',
      `Unknown natural land ${unknown.slice(0, 5).join(', ')}; inspect the map with lands: true and the same landOptions`,
      { landIds: unknown.slice(0, 20) },
    );
  const provinces = new Set<number>();
  for (const id of landIds) for (const province of byId.get(id)!.provinces) provinces.add(province);
  return [...provinces].sort((x, y) => x - y);
}
