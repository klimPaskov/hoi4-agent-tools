import { ServiceError } from '../core/result.js';
import { provinceEdgeCosts, type ProvinceGraph } from './partition-graph.js';
import type { TerritoryAtoms } from './territory-graph.js';

/**
 * Territory assignment (ADR 0060): grow countries over a graph of atoms (provinces or states) from
 * capital and anchor seeds so that their borders follow rivers, ranges and shores.
 *
 * 1. Every country is a source set (seeds and forced atoms). One multi-source Dijkstra grows them
 *    over the land graph. A step costs the centroid distance times `1 + beta * barrier` (the
 *    barrier is the mean strength of the natural lines on the shared border) divided by the
 *    country's multiplier, so a wavefront stops at a river and meets the other country there.
 * 2. Multipliers are corrected with `sqrt(target / achieved)` until every share is within the
 *    tolerance, and the best round is kept.
 * 3. Landmasses without a seed are reached over sea edges to the nearest atoms (`islandPolicy`).
 * 4. A country whose seeds on its capital's landmass are cut apart is joined by a forced corridor.
 * 5. A deterministic local search moves boundary atoms to the neighbouring country when that
 *    shortens the artificial (not natural) border, within the balance and connectivity limits.
 *
 * Everything is deterministic: ties go to the lower country and atom index, jitter comes from a
 * hash of the seed and the atom pair, and no step uses `Math.pow`, `Math.hypot` or a clock.
 */

export const TERRITORY_MAX_COUNTRIES = 512;
export const TERRITORY_MAX_SEEDS = 64;

export interface TerritoryCountry {
  /** Three letters or digits, unique. */
  tag: string;
  /** Relative target size, above 0. */
  weight: number;
  /** Atoms the country starts from; the first is its capital. */
  seeds: readonly number[];
  /** Atoms the country always owns. */
  forced?: readonly number[];
  /** Atoms the country may never own. */
  blocked?: readonly number[];
  /** Region ids (`TerritoryAtoms.region`) the country prefers; atoms of other countries' regions cost more. */
  homeRegions?: readonly number[];
  /** Tag of the country this one is a subject of: it is grown inside the overlord's territory. */
  overlord?: string;
  /** Tag the finished territory is relabelled to (a merge); the target must be in the list. */
  mergeInto?: string;
}

export type IslandPolicy = 'one-owner' | 'nearest' | 'unowned';

export interface TerritoryRules {
  /** The country's atoms on its capital's landmass form one piece (a corridor joins cut seeds). */
  connectedMainland: boolean;
  /** Landmasses with no seed: one owner for the whole island, the nearest owner of each atom, or nobody. */
  islandPolicy: IslandPolicy;
}

export interface TerritorySmoothing {
  /** Passes of the local search, 0 to 20. */
  passes: number;
  /** A country's size may change by at most this share through smoothing, 0 to 1. */
  maxShareChange: number;
}

export interface TerritoryOptions {
  rules?: Partial<TerritoryRules>;
  /** `none` ignores natural lines: the naive nearest-seed baseline. Default `natural`. */
  barriers?: 'natural' | 'none';
  /** Cost multiplier of a fully natural border. Default 6. */
  barrierStrength?: number;
  /** Cost multiplier for hopping to another landmass. Default 3. */
  seaCost?: number;
  /** Seeded noise on step costs, 0 to 0.5, so featureless borders are not straight. Default 0.08. */
  jitter?: number;
  seed?: number;
  /** Allowed relative size error of a country, 0.01 to 1. Default 0.15. */
  shareTolerance?: number;
  smoothing?: Partial<TerritorySmoothing>;
  /** Atoms no country owns. */
  unowned?: readonly number[];
  /** Atoms outside the scope: neither grown into nor counted. */
  excluded?: readonly number[];
  /** Largest number of balancing rounds. Default 20. */
  maxRounds?: number;
  signal?: AbortSignal;
}

export interface TerritoryCountryStats {
  tag: string;
  atoms: number;
  /** Land pixels owned. */
  weight: number;
  targetWeight: number;
  share: number;
  /** The share the land allows: a country alone on an island cannot have less than the island. */
  targetShare: number;
  /** The share the weights ask for. */
  requestedShare: number;
  /** |size - feasible target| / feasible target. */
  shareError: number;
  landmasses: number;
  /** Connected pieces over all landmasses. */
  pieces: number;
}

export interface TerritoryStats {
  countries: TerritoryCountryStats[];
  assignedAtoms: number;
  unownedAtoms: number;
  maxShareError: number;
  /** Pixel edges between atoms of different countries. */
  borderLength: number;
  /** Of which on a natural line (barrier features full, terrain changes half). */
  naturalLength: number;
  naturalShare: number | null;
  rounds: number;
  smoothingMoves: number;
  corridors: number;
}

export interface TerritoryNote {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TerritoryResult {
  tags: string[];
  /** Final owner of every atom: an index into the countries given, -1 for none (after merging). */
  owner: Int32Array;
  /** The country every atom was grown for, before merging. */
  origin: Int32Array;
  stats: TerritoryStats;
  notes: TerritoryNote[];
}

interface ResolvedCountry {
  tag: string;
  weight: number;
  seeds: number[];
  forced: number[];
  blocked: Set<number>;
  home: Set<number>;
  overlord: number;
  mergeInto: number;
}

interface LevelEntity {
  weight: number;
  /** Capital first. */
  seeds: number[];
  forced: number[];
  blocked: Set<number>;
  home: Set<number>;
}

const TAG_PATTERN = /^[A-Z0-9]{3}$/u;

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new ServiceError(code, message, details);
}

// ---------------------------------------------------------------------------------------------
// Heap

/** A binary min-heap on (cost, entity, atom); the entity and atom break ties deterministically. */
class GrowHeap {
  #cost = new Float64Array(1024);
  #entity = new Int32Array(1024);
  #atom = new Int32Array(1024);
  #size = 0;
  get size(): number {
    return this.#size;
  }
  #less(i: number, j: number): boolean {
    const a = this.#cost[i]!;
    const b = this.#cost[j]!;
    if (a !== b) return a < b;
    if (this.#entity[i] !== this.#entity[j]) return this.#entity[i]! < this.#entity[j]!;
    return this.#atom[i]! < this.#atom[j]!;
  }
  #swap(i: number, j: number): void {
    const cost = this.#cost[i]!;
    const entity = this.#entity[i]!;
    const atom = this.#atom[i]!;
    this.#cost[i] = this.#cost[j]!;
    this.#entity[i] = this.#entity[j]!;
    this.#atom[i] = this.#atom[j]!;
    this.#cost[j] = cost;
    this.#entity[j] = entity;
    this.#atom[j] = atom;
  }
  push(cost: number, entity: number, atom: number): void {
    if (this.#size === this.#cost.length) {
      const grow = <T extends Float64Array | Int32Array>(array: T): T => {
        const bigger = new (array.constructor as new (length: number) => T)(array.length * 2);
        bigger.set(array);
        return bigger;
      };
      this.#cost = grow(this.#cost);
      this.#entity = grow(this.#entity);
      this.#atom = grow(this.#atom);
    }
    let i = this.#size++;
    this.#cost[i] = cost;
    this.#entity[i] = entity;
    this.#atom[i] = atom;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(i, parent)) break;
      this.#swap(i, parent);
      i = parent;
    }
  }
  /** Remove the smallest; read it from `top*` first. */
  topCost(): number {
    return this.#cost[0]!;
  }
  topEntity(): number {
    return this.#entity[0]!;
  }
  topAtom(): number {
    return this.#atom[0]!;
  }
  pop(): void {
    const last = --this.#size;
    if (last > 0) {
      this.#cost[0] = this.#cost[last]!;
      this.#entity[0] = this.#entity[last]!;
      this.#atom[0] = this.#atom[last]!;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < last && this.#less(left, best)) best = left;
        if (right < last && this.#less(right, best)) best = right;
        if (best === i) break;
        this.#swap(i, best);
        i = best;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function hash32(seed: number, a: number, b: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ a, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (Math.imul(h, 0x27d4eb2f) >>> 0) / 4_294_967_296;
}

function wrappedDistance(
  graph: ProvinceGraph,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  let dx = ax - bx;
  if (dx > graph.width / 2) dx -= graph.width;
  else if (dx < -graph.width / 2) dx += graph.width;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Connected components of the allowed atoms over land edges; -1 outside. */
function landComponents(
  graph: ProvinceGraph,
  allowed: Uint8Array,
): { component: Int32Array; count: number } {
  const component = new Int32Array(graph.count).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let start = 0; start < graph.count; start += 1) {
    if (allowed[start] === 0 || component[start]! >= 0) continue;
    component[start] = count;
    stack.push(start);
    while (stack.length > 0) {
      const atom = stack.pop()!;
      for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
        const next = graph.to[slot]!;
        if (allowed[next] === 0 || component[next]! >= 0) continue;
        component[next] = count;
        stack.push(next);
      }
    }
    count += 1;
  }
  return { component, count };
}

/** A uniform grid of atom centres for nearest-neighbour searches. */
class CentreGrid {
  readonly #cell: number;
  readonly #columns: number;
  readonly #rows: number;
  readonly #cells: number[][];
  constructor(
    private readonly graph: ProvinceGraph,
    atoms: readonly number[],
  ) {
    this.#cell = Math.max(
      8,
      Math.sqrt((graph.width * graph.height) / Math.max(1, atoms.length)) * 2,
    );
    this.#columns = Math.max(1, Math.ceil(graph.width / this.#cell));
    this.#rows = Math.max(1, Math.ceil(graph.height / this.#cell));
    this.#cells = Array.from({ length: this.#columns * this.#rows }, () => []);
    for (const atom of atoms) this.#cells[this.#cellOf(atom)]!.push(atom);
  }
  #cellOf(atom: number): number {
    const column = Math.min(
      this.#columns - 1,
      Math.max(0, Math.floor(this.graph.centerX[atom]! / this.#cell)),
    );
    const row = Math.min(
      this.#rows - 1,
      Math.max(0, Math.floor(this.graph.centerY[atom]! / this.#cell)),
    );
    return row * this.#columns + column;
  }
  /** The `k` atoms nearest to `atom` (wrapping east-west) that satisfy `accept`, nearest first. */
  nearest(atom: number, k: number, accept: (candidate: number) => boolean): number[] {
    const graph = this.graph;
    const column = Math.min(
      this.#columns - 1,
      Math.max(0, Math.floor(graph.centerX[atom]! / this.#cell)),
    );
    const row = Math.min(
      this.#rows - 1,
      Math.max(0, Math.floor(graph.centerY[atom]! / this.#cell)),
    );
    const found: Array<{ atom: number; distance: number }> = [];
    const limit = Math.max(this.#columns, this.#rows);
    for (let ring = 0; ring <= limit; ring += 1) {
      if (found.length >= k) {
        const reach = Math.max(0, ring - 1) * this.#cell;
        if (found[k - 1]!.distance <= reach) break;
      }
      for (let dy = -ring; dy <= ring; dy += 1) {
        const y = row + dy;
        if (y < 0 || y >= this.#rows) continue;
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = (((column + dx) % this.#columns) + this.#columns) % this.#columns;
          for (const candidate of this.#cells[y * this.#columns + x]!) {
            if (!accept(candidate)) continue;
            found.push({
              atom: candidate,
              distance: wrappedDistance(
                graph,
                graph.centerX[atom]!,
                graph.centerY[atom]!,
                graph.centerX[candidate]!,
                graph.centerY[candidate]!,
              ),
            });
          }
        }
      }
      found.sort((x, y) => x.distance - y.distance || x.atom - y.atom);
      if (found.length > k * 4) found.length = k * 4;
    }
    return found.slice(0, k).map(({ atom: candidate }) => candidate);
  }
}

// ---------------------------------------------------------------------------------------------
// The algorithm

class TerritoryRun {
  readonly rules: TerritoryRules;
  readonly barriers: 'natural' | 'none';
  readonly seaCost: number;
  readonly jitter: number;
  readonly seed: number;
  readonly tolerance: number;
  readonly smoothing: TerritorySmoothing;
  readonly maxRounds: number;
  readonly unowned: Uint8Array;
  readonly excluded: Uint8Array;
  readonly graph: ProvinceGraph;
  readonly baseCost: Float32Array;
  readonly notes: TerritoryNote[] = [];
  rounds = 0;
  smoothingMoves = 0;
  corridors = 0;
  /** Feasible target (pixels) of each entity of the level grown last. */
  lastTargets: Float64Array = new Float64Array(0);
  #grid: CentreGrid | undefined;

  constructor(
    readonly atoms: TerritoryAtoms,
    options: TerritoryOptions,
  ) {
    this.graph = atoms.graph;
    this.rules = {
      connectedMainland: options.rules?.connectedMainland ?? true,
      islandPolicy: options.rules?.islandPolicy ?? 'one-owner',
    };
    this.barriers = options.barriers ?? 'natural';
    this.seaCost = options.seaCost ?? 3;
    this.jitter = options.jitter ?? 0.08;
    this.seed = options.seed ?? 0;
    this.tolerance = options.shareTolerance ?? 0.15;
    this.smoothing = {
      passes: options.smoothing?.passes ?? 4,
      maxShareChange: options.smoothing?.maxShareChange ?? 0.15,
    };
    this.maxRounds = options.maxRounds ?? 20;
    this.unowned = new Uint8Array(atoms.count);
    this.excluded = new Uint8Array(atoms.count);
    for (const atom of options.unowned ?? []) this.unowned[atom] = 1;
    for (const atom of options.excluded ?? []) this.excluded[atom] = 1;
    const costs = provinceEdgeCosts(this.graph, {
      barrier: this.barriers === 'natural' ? (options.barrierStrength ?? 6) : 0,
      water: 1,
    });
    // Seeded noise, the same in both directions of an edge.
    if (this.jitter > 0)
      for (let a = 0; a < this.graph.count; a += 1)
        for (let slot = this.graph.offsets[a]!; slot < this.graph.offsets[a + 1]!; slot += 1) {
          const b = this.graph.to[slot]!;
          const noise = hash32(this.seed, Math.min(a, b), Math.max(a, b)) * 2 - 1;
          costs[slot] = costs[slot]! * (1 + this.jitter * noise);
        }
    this.baseCost = costs;
  }

  signalCheck(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
  }

  centreDistance(a: number, b: number): number {
    const g = this.graph;
    return wrappedDistance(g, g.centerX[a]!, g.centerY[a]!, g.centerX[b]!, g.centerY[b]!);
  }

  grid(): CentreGrid {
    if (this.#grid === undefined) {
      const all: number[] = [];
      for (let atom = 0; atom < this.graph.count; atom += 1)
        if (this.excluded[atom] === 0) all.push(atom);
      this.#grid = new CentreGrid(this.graph, all);
    }
    return this.#grid;
  }

  /** Grow `entities` inside `allowed` and return the entity index of every atom, -1 for none. */
  growLevel(
    entities: readonly LevelEntity[],
    allowed: Uint8Array,
    signal: AbortSignal | undefined,
    label: string,
  ): Int32Array {
    const graph = this.graph;
    const n = graph.count;
    const entityCount = entities.length;
    // Atoms nobody may take are outside the land the entities share.
    const open = new Uint8Array(n);
    let openWeight = 0;
    for (let atom = 0; atom < n; atom += 1)
      if (allowed[atom] === 1 && this.excluded[atom] === 0 && this.unowned[atom] === 0) {
        open[atom] = 1;
        openWeight += graph.size[atom]!;
      }
    if (entityCount === 1) {
      this.lastTargets = Float64Array.of(openWeight);
      const owner = new Int32Array(n).fill(-1);
      const entity = entities[0]!;
      for (let atom = 0; atom < n; atom += 1)
        if (open[atom] === 1 && !entity.blocked.has(atom)) owner[atom] = 0;
      return owner;
    }
    const sourceOwner = new Int32Array(n).fill(-1);
    for (const [index, entity] of entities.entries())
      for (const atom of [...entity.seeds, ...entity.forced]) {
        if (open[atom] === 0)
          refuse(
            'MAP_TERRITORY_SEED_UNAVAILABLE',
            `Atom ${atom} of ${label} is outside the land that can be assigned (excluded, unowned or outside its overlord)`,
            { atom, level: label },
          );
        sourceOwner[atom] = index;
      }
    const { component, count: componentCount } = landComponents(graph, open);
    const seeded = new Uint8Array(componentCount);
    for (let atom = 0; atom < n; atom += 1)
      if (sourceOwner[atom]! >= 0) seeded[component[atom]!] = 1;
    // Cut-off check: the sources on each capital's landmass must reach each other.
    if (this.rules.connectedMainland)
      for (const [index, entity] of entities.entries()) {
        const capital = entity.seeds[0] ?? entity.forced[0];
        if (capital === undefined) continue;
        const reached = this.#reach(capital, index, entity, open, sourceOwner);
        for (const atom of [...entity.seeds, ...entity.forced])
          if (component[atom] === component[capital] && !reached.has(atom))
            refuse(
              'MAP_TERRITORY_FORCED_UNREACHABLE',
              `Atom ${atom} is on the same landmass as the capital of ${label} entity ${index} but blocked or forced territory of other countries cuts it off`,
              { atom, capital, entity: index, level: label },
            );
      }
    // Sea edges: every atom of a landmass without a source reaches its nearest neighbours elsewhere.
    const seaFrom: number[] = [];
    const seaTo: number[] = [];
    if (this.rules.islandPolicy !== 'unowned') {
      const grid = this.grid();
      const present = new Set<string>();
      for (let atom = 0; atom < n; atom += 1) {
        if (open[atom] === 0 || seeded[component[atom]!] === 1) continue;
        const near = grid.nearest(atom, 3, (candidate) => {
          return open[candidate] === 1 && component[candidate] !== component[atom];
        });
        for (const other of near) {
          const key = atom < other ? `${atom}:${other}` : `${other}:${atom}`;
          if (present.has(key)) continue;
          present.add(key);
          seaFrom.push(atom, other);
          seaTo.push(other, atom);
        }
      }
    }
    const seaOffsets = new Int32Array(n + 1);
    for (const from of seaFrom) seaOffsets[from + 1]!++;
    for (let atom = 0; atom < n; atom += 1) seaOffsets[atom + 1]! += seaOffsets[atom]!;
    const seaAdjacent = new Int32Array(seaFrom.length);
    {
      const cursor = Int32Array.from(seaOffsets.subarray(0, n));
      for (let i = 0; i < seaFrom.length; i += 1) seaAdjacent[cursor[seaFrom[i]!]!++] = seaTo[i]!;
    }
    // Island atoms by component, for the one-owner policy.
    const islandMembers: number[][] = Array.from({ length: componentCount }, () => []);
    for (let atom = 0; atom < n; atom += 1)
      if (open[atom] === 1 && seeded[component[atom]!] === 0)
        islandMembers[component[atom]!]!.push(atom);
    // Region preference.
    const homeOwners = new Map<number, Set<number>>();
    for (const [index, entity] of entities.entries())
      for (const region of entity.home) {
        const set = homeOwners.get(region) ?? new Set<number>();
        set.add(index);
        homeOwners.set(region, set);
      }
    const regionFactor = (index: number, atom: number): number => {
      const region = this.atoms.region[atom]!;
      if (region < 0) return 1;
      const owners = homeOwners.get(region);
      if (owners === undefined) return 1;
      return owners.has(index) ? 0.7 : 1.8;
    };
    const jitterSea = (a: number, b: number): number =>
      1 + this.jitter * (hash32(this.seed + 1, Math.min(a, b), Math.max(a, b)) * 2 - 1);
    const owner = new Int32Array(n);
    const multiplier = new Float64Array(entityCount).fill(1);
    const targets = new Float64Array(entityCount);
    // Feasible targets: a country alone on a landmass owns all of it, and cannot own more than the
    // landmasses it starts on and the islands; the rest is shared by weight (water filling).
    const componentSize = new Float64Array(componentCount);
    for (let atom = 0; atom < n; atom += 1)
      if (open[atom] === 1) componentSize[component[atom]!]! += graph.size[atom]!;
    const startsOn = entities.map(() => new Set<number>());
    for (const [index, entity] of entities.entries())
      for (const atom of [...entity.seeds, ...entity.forced])
        startsOn[index]!.add(component[atom]!);
    const holders = new Int32Array(componentCount);
    for (const set of startsOn) for (const part of set) holders[part]! += 1;
    let islandTotal = 0;
    for (let part = 0; part < componentCount; part += 1)
      if (seeded[part] === 0) islandTotal += componentSize[part]!;
    const low = new Float64Array(entityCount);
    const high = new Float64Array(entityCount);
    for (const [index, set] of startsOn.entries()) {
      for (const part of set) {
        high[index]! += componentSize[part]!;
        if (holders[part] === 1) low[index]! += componentSize[part]!;
      }
      high[index]! += islandTotal;
    }
    const fixedTarget = new Float64Array(entityCount).fill(-1);
    this.lastTargets = targets;
    for (let pass = 0; pass < entityCount + 1; pass += 1) {
      let remaining = openWeight;
      let remainingWeight = 0;
      for (let i = 0; i < entityCount; i += 1)
        if (fixedTarget[i]! >= 0) remaining -= fixedTarget[i]!;
        else remainingWeight += entities[i]!.weight;
      let violated = false;
      for (let i = 0; i < entityCount; i += 1) {
        if (fixedTarget[i]! >= 0) continue;
        const wanted = (remaining * entities[i]!.weight) / remainingWeight;
        if (wanted < low[i]!) {
          fixedTarget[i] = low[i]!;
          violated = true;
        } else if (wanted > high[i]!) {
          fixedTarget[i] = high[i]!;
          violated = true;
        }
      }
      if (!violated) {
        for (let i = 0; i < entityCount; i += 1)
          targets[i] =
            fixedTarget[i]! >= 0
              ? fixedTarget[i]!
              : (remaining * entities[i]!.weight) / remainingWeight;
        break;
      }
    }
    const forcedExtra: Array<Set<number>> = entities.map(() => new Set<number>());
    const sources = (index: number): number[] => [
      ...entities[index]!.seeds,
      ...entities[index]!.forced,
      ...forcedExtra[index]!,
    ];
    const grow = (): void => {
      owner.fill(-1);
      const heap = new GrowHeap();
      const assigned: number[] = [];
      const give = (atom: number, index: number): void => {
        owner[atom] = index;
        assigned.push(atom);
      };
      for (let index = 0; index < entityCount; index += 1)
        for (const atom of sources(index)) give(atom, index);
      const relax = (atom: number, index: number, distance: number): void => {
        const entity = entities[index]!;
        // With the nearest policy an unseeded landmass is reached atom by atom over sea edges.
        const byLand = !(this.rules.islandPolicy === 'nearest' && seeded[component[atom]!] === 0);
        for (
          let slot = graph.offsets[atom]!;
          byLand && slot < graph.offsets[atom + 1]!;
          slot += 1
        ) {
          const next = graph.to[slot]!;
          if (open[next] === 0 || owner[next]! >= 0 || entity.blocked.has(next)) continue;
          heap.push(
            distance + (this.baseCost[slot]! * regionFactor(index, next)) / multiplier[index]!,
            index,
            next,
          );
        }
        for (let slot = seaOffsets[atom]!; slot < seaOffsets[atom + 1]!; slot += 1) {
          const next = seaAdjacent[slot]!;
          if (owner[next]! >= 0 || entity.blocked.has(next)) continue;
          heap.push(
            distance +
              (this.centreDistance(atom, next) * this.seaCost * jitterSea(atom, next)) /
                multiplier[index]!,
            index,
            next,
          );
        }
      };
      for (const atom of [...assigned]) relax(atom, owner[atom]!, 0);
      while (heap.size > 0) {
        const distance = heap.topCost();
        const index = heap.topEntity();
        const atom = heap.topAtom();
        heap.pop();
        if (owner[atom]! >= 0) continue;
        const island = seeded[component[atom]!] === 0 && this.rules.islandPolicy === 'one-owner';
        const entity = entities[index]!;
        if (island) {
          // The whole island, unless this country may not own some of it.
          const members = islandMembers[component[atom]!]!;
          if (members.some((member) => entity.blocked.has(member) || owner[member]! >= 0)) continue;
          for (const member of members) give(member, index);
          for (const member of members) relax(member, index, distance);
        } else {
          give(atom, index);
          relax(atom, index, distance);
        }
      }
    };
    const measure = (): { area: Float64Array; error: number } => {
      const area = new Float64Array(entityCount);
      for (let atom = 0; atom < n; atom += 1)
        if (owner[atom]! >= 0) area[owner[atom]!]! += graph.size[atom]!;
      let error = 0;
      for (let i = 0; i < entityCount; i += 1)
        error = Math.max(error, Math.abs(area[i]! - targets[i]!) / Math.max(1, targets[i]!));
      return { area, error };
    };
    // Balancing rounds: the multiplier of a country that is too small rises.
    let best: Int32Array | undefined;
    let bestMultiplier = Float64Array.from(multiplier);
    let bestScore: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    let sinceBest = 0;
    for (let round = 0; round < Math.max(1, this.maxRounds); round += 1) {
      signal?.throwIfAborted();
      this.rounds += 1;
      grow();
      const { area, error } = measure();
      const score: [number, number] = [
        Math.max(0, error - this.tolerance * 0.5),
        this.#artificial(owner),
      ];
      if (score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
        best = Int32Array.from(owner);
        bestMultiplier = Float64Array.from(multiplier);
        bestScore = score;
        sinceBest = 0;
      } else sinceBest += 1;
      if (error <= this.tolerance * 0.4 || sinceBest >= 4) break;
      for (let i = 0; i < entityCount; i += 1) {
        const ratio = Math.sqrt(targets[i]! / Math.max(1, area[i]!));
        const step = Math.min(1.5, Math.max(0.67, ratio));
        multiplier[i] = Math.min(16, Math.max(1 / 16, multiplier[i]! * step));
      }
    }
    // The best round is the working assignment.
    owner.set(best!);
    multiplier.set(bestMultiplier);
    // Connectivity: a country cut apart on its capital's landmass is joined by a forced corridor.
    if (this.rules.connectedMainland) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        signal?.throwIfAborted();
        const added = this.#joinCutSeeds(
          entities,
          owner,
          forcedExtra,
          open,
          component,
          sourceOwner,
        );
        if (!added) break;
        this.corridors += 1;
        grow();
      }
    }
    const fixed = new Uint8Array(n);
    for (let index = 0; index < entityCount; index += 1)
      for (const atom of sources(index)) fixed[atom] = 1;
    if (this.barriers === 'natural' && this.smoothing.passes > 0)
      this.#smooth(entities, owner, fixed, targets, signal);
    return owner;
  }

  /** Atoms reachable from `capital` through open atoms the entity may own. */
  #reach(
    capital: number,
    index: number,
    entity: LevelEntity,
    open: Uint8Array,
    sourceOwner: Int32Array,
  ): Set<number> {
    const graph = this.graph;
    const seen = new Set<number>([capital]);
    const stack = [capital];
    while (stack.length > 0) {
      const atom = stack.pop()!;
      for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
        const next = graph.to[slot]!;
        if (open[next] === 0 || seen.has(next) || entity.blocked.has(next)) continue;
        if (sourceOwner[next]! >= 0 && sourceOwner[next] !== index) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  }

  /** The artificial (not natural) border length of an assignment, in pixel edges. */
  #artificial(owner: Int32Array): number {
    const graph = this.graph;
    let total = 0;
    for (let a = 0; a < graph.count; a += 1) {
      const mine = owner[a]!;
      for (let slot = graph.offsets[a]!; slot < graph.offsets[a + 1]!; slot += 1) {
        const b = graph.to[slot]!;
        if (b < a) continue;
        const other = owner[b]!;
        if (mine === other) continue;
        total += graph.length[slot]! - this.atoms.credit[slot]!;
      }
    }
    return total;
  }

  /**
   * Where a country's atoms on its capital's landmass fall into several pieces, force the cheapest
   * corridor of atoms (not forced for another country) that joins a stray piece to the capital's
   * piece. Returns whether any corridor was added.
   */
  #joinCutSeeds(
    entities: readonly LevelEntity[],
    owner: Int32Array,
    forcedExtra: Array<Set<number>>,
    open: Uint8Array,
    component: Int32Array,
    sourceOwner: Int32Array,
  ): boolean {
    const graph = this.graph;
    for (const [index, entity] of entities.entries()) {
      const capital = entity.seeds[0] ?? entity.forced[0];
      if (capital === undefined) continue;
      // The capital's piece.
      const piece = new Set<number>([capital]);
      const stack = [capital];
      while (stack.length > 0) {
        const atom = stack.pop()!;
        for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
          const next = graph.to[slot]!;
          if (owner[next] === index && !piece.has(next)) {
            piece.add(next);
            stack.push(next);
          }
        }
      }
      const stray = [...entity.seeds, ...entity.forced, ...forcedExtra[index]!].find(
        (atom) => component[atom] === component[capital] && !piece.has(atom),
      );
      if (stray === undefined) continue;
      // Cheapest path from the stray source to the capital's piece through atoms that are free.
      const heap = new GrowHeap();
      const distance = new Float64Array(graph.count).fill(Number.POSITIVE_INFINITY);
      const parent = new Int32Array(graph.count).fill(-1);
      distance[stray] = 0;
      heap.push(0, 0, stray);
      let reached = -1;
      while (heap.size > 0) {
        const cost = heap.topCost();
        const atom = heap.topAtom();
        heap.pop();
        if (cost > distance[atom]!) continue;
        if (piece.has(atom)) {
          reached = atom;
          break;
        }
        for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
          const next = graph.to[slot]!;
          if (open[next] === 0 || entity.blocked.has(next)) continue;
          if (sourceOwner[next]! >= 0 && sourceOwner[next] !== index) continue;
          if (forcedExtra.some((set, other) => other !== index && set.has(next))) continue;
          const step = this.baseCost[slot]! * (owner[next] === index || piece.has(next) ? 1 : 4);
          if (cost + step < distance[next]!) {
            distance[next] = cost + step;
            parent[next] = atom;
            heap.push(cost + step, 0, next);
          }
        }
      }
      if (reached < 0)
        refuse(
          'MAP_TERRITORY_FORCED_UNREACHABLE',
          `No corridor joins atom ${stray} to the capital of entity ${index}`,
          { atom: stray, capital, entity: index },
        );
      for (let atom = reached; atom >= 0; atom = parent[atom]!) forcedExtra[index]!.add(atom);
      return true;
    }
    return false;
  }

  /** Move boundary atoms to a neighbouring country when that shortens the artificial border. */
  #smooth(
    entities: readonly LevelEntity[],
    owner: Int32Array,
    fixed: Uint8Array,
    targets: Float64Array,
    signal: AbortSignal | undefined,
  ): void {
    const graph = this.graph;
    const entityCount = entities.length;
    const area = new Float64Array(entityCount);
    for (let atom = 0; atom < graph.count; atom += 1)
      if (owner[atom]! >= 0) area[owner[atom]!]! += graph.size[atom]!;
    const start = Float64Array.from(area);
    const tolerance = this.tolerance;
    const errorOf = (index: number, value: number): number =>
      Math.abs(value - targets[index]!) / Math.max(1, targets[index]!);
    const allowedSize = (index: number, value: number): boolean => {
      const change = Math.abs(value - start[index]!) / Math.max(1, start[index]!);
      if (change > this.smoothing.maxShareChange) return false;
      return errorOf(index, value) <= Math.max(tolerance, errorOf(index, area[index]!));
    };
    for (let pass = 0; pass < this.smoothing.passes; pass += 1) {
      let moved = 0;
      for (let atom = 0; atom < graph.count; atom += 1) {
        if ((atom & 1023) === 0) signal?.throwIfAborted();
        const from = owner[atom]!;
        if (from < 0 || fixed[atom] === 1) continue;
        // Candidate owners among the neighbours.
        let gainBest = 0;
        let target = -1;
        let seenOther = false;
        for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
          const other = owner[graph.to[slot]!]!;
          if (other >= 0 && other !== from) {
            seenOther = true;
            break;
          }
        }
        if (!seenOther) continue;
        const tried = new Set<number>();
        for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
          const candidate = owner[graph.to[slot]!]!;
          if (candidate < 0 || candidate === from || tried.has(candidate)) continue;
          tried.add(candidate);
          if (entities[candidate]!.blocked.has(atom)) continue;
          // Artificial border length before and after, over the atom's edges.
          let gain = 0;
          for (let s = graph.offsets[atom]!; s < graph.offsets[atom + 1]!; s += 1) {
            const neighbour = owner[graph.to[s]!]!;
            if (neighbour < 0) continue;
            const artificial = graph.length[s]! - this.atoms.credit[s]!;
            if (neighbour !== from) gain += artificial;
            if (neighbour !== candidate) gain -= artificial;
          }
          if (gain > gainBest + 1e-9) {
            gainBest = gain;
            target = candidate;
          }
        }
        if (target < 0) continue;
        const weight = graph.size[atom]!;
        if (
          !allowedSize(from, area[from]! - weight) ||
          !allowedSize(target, area[target]! + weight)
        )
          continue;
        if (!this.#staysConnected(atom, from, owner)) continue;
        owner[atom] = target;
        area[from]! -= weight;
        area[target]! += weight;
        moved += 1;
        this.smoothingMoves += 1;
      }
      if (moved === 0) break;
    }
  }

  /** Whether the neighbours of `atom` owned by `from` stay joined when `atom` is taken away. */
  #staysConnected(atom: number, from: number, owner: Int32Array): boolean {
    const graph = this.graph;
    const neighbours: number[] = [];
    for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1)
      if (owner[graph.to[slot]!] === from) neighbours.push(graph.to[slot]!);
    if (neighbours.length <= 1) return true;
    const wanted = new Set(neighbours.slice(1));
    const seen = new Set<number>([neighbours[0]!, atom]);
    const queue = [neighbours[0]!];
    let budget = 4000;
    for (let head = 0; head < queue.length && wanted.size > 0; head += 1) {
      if (budget-- <= 0) return false;
      const current = queue[head]!;
      for (let slot = graph.offsets[current]!; slot < graph.offsets[current + 1]!; slot += 1) {
        const next = graph.to[slot]!;
        if (seen.has(next) || owner[next] !== from) continue;
        seen.add(next);
        wanted.delete(next);
        queue.push(next);
      }
    }
    return wanted.size === 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point

function validateCountries(
  atoms: TerritoryAtoms,
  countries: readonly TerritoryCountry[],
  options: TerritoryOptions,
): ResolvedCountry[] {
  if (countries.length === 0)
    refuse('MAP_TERRITORY_COUNTRIES_MISSING', 'Territory assignment needs at least one country');
  if (countries.length > TERRITORY_MAX_COUNTRIES)
    refuse(
      'MAP_TERRITORY_TOO_MANY_COUNTRIES',
      `Territory assignment accepts at most ${TERRITORY_MAX_COUNTRIES} countries`,
      { countries: countries.length, limit: TERRITORY_MAX_COUNTRIES },
    );
  const tags = new Map<string, number>();
  const atomOk = (atom: number): boolean =>
    Number.isInteger(atom) && atom >= 0 && atom < atoms.count;
  const excluded = new Set(options.excluded ?? []);
  const unowned = new Set(options.unowned ?? []);
  for (const atom of [...excluded, ...unowned])
    if (!atomOk(atom))
      refuse('MAP_TERRITORY_ATOM_UNKNOWN', `Atom ${atom} does not exist`, { atom });
  const resolved: ResolvedCountry[] = [];
  for (const [index, country] of countries.entries()) {
    if (!TAG_PATTERN.test(country.tag))
      refuse(
        'MAP_TERRITORY_TAG_INVALID',
        `Country tag ${country.tag} must be three capital letters or digits`,
        { tag: country.tag },
      );
    if (tags.has(country.tag))
      refuse('MAP_TERRITORY_TAG_DUPLICATE', `Country tag ${country.tag} appears twice`, {
        tag: country.tag,
      });
    tags.set(country.tag, index);
    if (!Number.isFinite(country.weight) || country.weight <= 0)
      refuse('MAP_TERRITORY_WEIGHT_INVALID', `Country ${country.tag} needs a weight above zero`, {
        tag: country.tag,
        weight: country.weight,
      });
    for (const [kind, list] of [
      ['seeds', country.seeds],
      ['forced', country.forced ?? []],
      ['blocked', country.blocked ?? []],
    ] as const)
      for (const atom of list)
        if (!atomOk(atom))
          refuse(
            'MAP_TERRITORY_ATOM_UNKNOWN',
            `Country ${country.tag} names atom ${atom} in ${kind}, which does not exist`,
            { tag: country.tag, kind, atom },
          );
    if (country.seeds.length > TERRITORY_MAX_SEEDS)
      refuse(
        'MAP_TERRITORY_TOO_MANY_SEEDS',
        `Country ${country.tag} has more than ${TERRITORY_MAX_SEEDS} seeds`,
        { tag: country.tag },
      );
    const seeds = [...new Set(country.seeds)];
    const forced = [...new Set(country.forced ?? [])].filter((atom) => !seeds.includes(atom));
    if (seeds.length + forced.length === 0)
      refuse(
        'MAP_TERRITORY_SEED_MISSING',
        `Country ${country.tag} has no seed and no forced territory`,
        { tag: country.tag },
      );
    resolved.push({
      tag: country.tag,
      weight: country.weight,
      seeds,
      forced,
      blocked: new Set(country.blocked ?? []),
      home: new Set(country.homeRegions ?? []),
      overlord: -1,
      mergeInto: -1,
    });
  }
  for (const [index, country] of countries.entries()) {
    if (country.overlord !== undefined) {
      const overlord = tags.get(country.overlord);
      if (overlord === undefined || overlord === index)
        refuse(
          'MAP_TERRITORY_OVERLORD_INVALID',
          `Country ${country.tag} names overlord ${country.overlord}, which is not another listed country`,
          { tag: country.tag, overlord: country.overlord },
        );
      resolved[index]!.overlord = overlord;
    }
    if (country.mergeInto !== undefined) {
      const target = tags.get(country.mergeInto);
      if (target === undefined || target === index || countries[target]!.mergeInto !== undefined)
        refuse(
          'MAP_TERRITORY_MERGE_INVALID',
          `Country ${country.tag} merges into ${country.mergeInto}, which must be another listed country that is not itself merged`,
          { tag: country.tag, mergeInto: country.mergeInto },
        );
      resolved[index]!.mergeInto = target;
    }
  }
  for (const [index] of resolved.entries()) {
    const seen = new Set<number>([index]);
    for (let node = resolved[index]!.overlord; node >= 0; node = resolved[node]!.overlord) {
      if (seen.has(node))
        refuse(
          'MAP_TERRITORY_OVERLORD_INVALID',
          `The overlord chain of ${resolved[index]!.tag} is a cycle`,
          { tag: resolved[index]!.tag },
        );
      seen.add(node);
    }
  }
  // Seeds and forced atoms are exclusive.
  const claimed = new Map<number, number>();
  for (const [index, country] of resolved.entries())
    for (const atom of [...country.seeds, ...country.forced]) {
      const holder = claimed.get(atom);
      if (holder !== undefined && holder !== index)
        refuse(
          'MAP_TERRITORY_FORCED_CONFLICT',
          `Atom ${atom} is a seed or forced territory of both ${resolved[holder]!.tag} and ${country.tag}`,
          { atom, tags: [resolved[holder]!.tag, country.tag] },
        );
      claimed.set(atom, index);
      if (country.blocked.has(atom))
        refuse(
          'MAP_TERRITORY_FORCED_BLOCKED',
          `Atom ${atom} is both forced or a seed and blocked for ${country.tag}`,
          { atom, tag: country.tag },
        );
      if (excluded.has(atom) || unowned.has(atom))
        refuse(
          'MAP_TERRITORY_SEED_UNAVAILABLE',
          `Atom ${atom} of ${country.tag} is excluded from the assignment or declared unowned`,
          { atom, tag: country.tag },
        );
    }
  return resolved;
}

/** Territory assignment: grow the countries over the atoms and describe the result. */
export function growTerritory(
  atoms: TerritoryAtoms,
  countries: readonly TerritoryCountry[],
  options: TerritoryOptions = {},
): TerritoryResult {
  for (const [name, value, low, high] of [
    ['shareTolerance', options.shareTolerance ?? 0.15, 0.01, 1],
    ['jitter', options.jitter ?? 0.08, 0, 0.5],
    ['barrierStrength', options.barrierStrength ?? 6, 0, 60],
    ['seaCost', options.seaCost ?? 3, 1, 50],
    ['smoothing.maxShareChange', options.smoothing?.maxShareChange ?? 0.15, 0, 1],
  ] as const)
    if (!Number.isFinite(value) || value < low || value > high)
      refuse(
        'MAP_TERRITORY_OPTION_INVALID',
        `Territory option ${name} must be from ${low} to ${high}`,
        {
          option: name,
          value,
        },
      );
  const passes = options.smoothing?.passes ?? 4;
  if (!Number.isInteger(passes) || passes < 0 || passes > 20)
    refuse(
      'MAP_TERRITORY_OPTION_INVALID',
      'Territory option smoothing.passes must be from 0 to 20',
      {
        option: 'smoothing.passes',
        value: passes,
      },
    );
  const resolved = validateCountries(atoms, countries, options);
  const run = new TerritoryRun(atoms, options);
  const signal = options.signal;
  const n = atoms.count;
  const toEntity = (index: number): LevelEntity => ({
    weight: resolved[index]!.weight,
    seeds: resolved[index]!.seeds,
    forced: resolved[index]!.forced,
    blocked: resolved[index]!.blocked,
    home: resolved[index]!.home,
  });
  // Subjects form a tree under their overlord; a bloc is grown as one entity first.
  const children = new Map<number, number[]>();
  for (const [index, country] of resolved.entries())
    if (country.overlord >= 0) {
      const list = children.get(country.overlord) ?? [];
      list.push(index);
      children.set(country.overlord, list);
    }
  const subtree = (index: number): number[] => [
    index,
    ...(children.get(index) ?? []).flatMap((child) => subtree(child)),
  ];
  const bloc = (index: number): LevelEntity => {
    const members = subtree(index);
    const blocked = new Set<number>(resolved[index]!.blocked);
    for (const atom of [...blocked])
      if (!members.every((member) => resolved[member]!.blocked.has(atom))) blocked.delete(atom);
    return {
      weight: members.reduce((sum, member) => sum + resolved[member]!.weight, 0),
      seeds: members.flatMap((member) => resolved[member]!.seeds),
      forced: members.flatMap((member) => resolved[member]!.forced),
      blocked,
      home: new Set(members.flatMap((member) => [...resolved[member]!.home])),
    };
  };
  const origin = new Int32Array(n).fill(-1);
  const feasible = new Float64Array(resolved.length).fill(-1);
  const assignTree = (index: number, mask: Uint8Array, label: string): void => {
    const direct = children.get(index) ?? [];
    if (direct.length === 0) {
      for (let atom = 0; atom < n; atom += 1) if (mask[atom] === 1) origin[atom] = index;
      return;
    }
    const entities = [toEntity(index), ...direct.map((child) => bloc(child))];
    const local = run.growLevel(entities, mask, signal, label);
    const levelTargets = run.lastTargets;
    feasible[index] = levelTargets[0]!;
    for (const [position, child] of direct.entries())
      if ((children.get(child) ?? []).length === 0) feasible[child] = levelTargets[position + 1]!;
    const own = new Uint8Array(n);
    for (let atom = 0; atom < n; atom += 1) if (local[atom] === 0) own[atom] = 1;
    for (let atom = 0; atom < n; atom += 1) if (own[atom] === 1) origin[atom] = index;
    for (const [position, child] of direct.entries()) {
      const sub = new Uint8Array(n);
      for (let atom = 0; atom < n; atom += 1) if (local[atom] === position + 1) sub[atom] = 1;
      assignTree(child, sub, `${label}>${resolved[child]!.tag}`);
    }
  };
  const roots = resolved.flatMap((country, index) => (country.overlord < 0 ? [index] : []));
  const everywhere = new Uint8Array(n).fill(1);
  const top = run.growLevel(
    roots.map((root) => bloc(root)),
    everywhere,
    signal,
    'the countries',
  );
  const topTargets = Float64Array.from(run.lastTargets);
  for (const [position, root] of roots.entries()) {
    const mask = new Uint8Array(n);
    for (let atom = 0; atom < n; atom += 1) if (top[atom] === position) mask[atom] = 1;
    if ((children.get(root) ?? []).length === 0) feasible[root] = topTargets[position]!;
    assignTree(root, mask, resolved[root]!.tag);
  }
  // A subject never holds atoms its blocked set forbids; merged territory is relabelled last.
  const owner = Int32Array.from(origin);
  for (let atom = 0; atom < n; atom += 1) {
    const country = owner[atom]!;
    if (country >= 0 && resolved[country]!.mergeInto >= 0)
      owner[atom] = resolved[country]!.mergeInto;
  }
  const stats = describeTerritory(atoms, resolved, owner, origin, run, feasible);
  return {
    tags: resolved.map(({ tag }) => tag),
    owner,
    origin,
    stats,
    notes: run.notes,
  };
}

function describeTerritory(
  atoms: TerritoryAtoms,
  countries: readonly ResolvedCountry[],
  owner: Int32Array,
  origin: Int32Array,
  run: TerritoryRun,
  feasible: Float64Array,
): TerritoryStats {
  const graph = atoms.graph;
  const n = atoms.count;
  const count = countries.length;
  const area = new Float64Array(count);
  const atomCount = new Int32Array(count);
  let assignedWeight = 0;
  let assigned = 0;
  let unowned = 0;
  for (let atom = 0; atom < n; atom += 1) {
    if (run.excluded[atom] === 1) continue;
    if (owner[atom]! < 0) {
      unowned += 1;
      continue;
    }
    // Targets are by country as grown, so size is measured by origin before merging.
    const grown = origin[atom]!;
    area[grown]! += graph.size[atom]!;
    atomCount[grown]! += 1;
    assignedWeight += graph.size[atom]!;
    assigned += 1;
  }
  // Components over the final owner of each country's atoms.
  const landmass = landComponents(
    graph,
    Uint8Array.from(origin, (value) => (value >= 0 ? 1 : 0)),
  );
  const landmasses = Array.from({ length: count }, () => new Set<number>());
  const pieces = new Int32Array(count);
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start += 1) {
    const country = origin[start]!;
    if (country < 0 || seen[start] === 1) continue;
    pieces[country]! += 1;
    seen[start] = 1;
    const stack = [start];
    while (stack.length > 0) {
      const atom = stack.pop()!;
      landmasses[country]!.add(landmass.component[atom]!);
      for (let slot = graph.offsets[atom]!; slot < graph.offsets[atom + 1]!; slot += 1) {
        const next = graph.to[slot]!;
        if (origin[next] === country && seen[next] === 0) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
  }
  let totalWeight = 0;
  for (const country of countries) totalWeight += country.weight;
  const stats: TerritoryCountryStats[] = [];
  let maxShareError = 0;
  for (let index = 0; index < count; index += 1) {
    const requestedShare = countries[index]!.weight / totalWeight;
    const target = feasible[index]! >= 0 ? feasible[index]! : requestedShare * assignedWeight;
    const targetShare = assignedWeight === 0 ? requestedShare : target / assignedWeight;
    const share = assignedWeight === 0 ? 0 : area[index]! / assignedWeight;
    const error = Math.abs(area[index]! - target) / Math.max(1, target);
    maxShareError = Math.max(maxShareError, error);
    stats.push({
      tag: countries[index]!.tag,
      atoms: atomCount[index]!,
      weight: area[index]!,
      targetWeight: round(target, 1),
      share: round(share),
      targetShare: round(targetShare),
      requestedShare: round(requestedShare),
      shareError: round(error),
      landmasses: landmasses[index]!.size,
      pieces: pieces[index]!,
    });
  }
  let borderLength = 0;
  let naturalLength = 0;
  for (let a = 0; a < n; a += 1) {
    if (owner[a]! < 0) continue;
    for (let slot = graph.offsets[a]!; slot < graph.offsets[a + 1]!; slot += 1) {
      const b = graph.to[slot]!;
      if (b < a || owner[b]! < 0 || owner[b] === owner[a]) continue;
      borderLength += graph.length[slot]!;
      naturalLength += atoms.credit[slot]!;
    }
  }
  return {
    countries: stats,
    assignedAtoms: assigned,
    unownedAtoms: unowned,
    maxShareError: round(maxShareError),
    borderLength,
    naturalLength: round(naturalLength, 1),
    naturalShare: borderLength === 0 ? null : round(naturalLength / borderLength),
    rounds: run.rounds,
    smoothingMoves: run.smoothingMoves,
    corridors: run.corridors,
  };
}

function round(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
