import { ServiceError } from '../core/result.js';
import {
  BORDER_BARRIER_MASK,
  BORDER_FEATURE_BITS,
  BORDER_PROVINCE_KIND,
  type BorderEdgeTable,
} from './border-quality.js';
import { buildProvinceGraph, type ProvinceGraph } from './partition-graph.js';

/**
 * The graph territory assignment grows countries over (ADR 0060). Provinces come from a border
 * edge table of the C10 metric, so the natural lines are exactly the ones the metric rewards:
 * every shared border carries the strength of the features it lies on and the number of its pixel
 * edges that count as natural. States (or any other grouping of provinces) are aggregated into
 * atoms with the same two numbers, and the algorithm in `territory.ts` runs on atoms only.
 */

/** Weight of a natural feature when it forms part of a border, 0 (none) to 1 (impassable line). */
export const TERRITORY_FEATURE_STRENGTH = {
  river: 1,
  extra: 1,
  slope: 0.8,
  terrainChange: 0.45,
  lakeShore: 0.35,
} as const;

/** Credit of a border edge towards natural border length: barrier features full, terrain half. */
const BARRIER_CREDIT = 1;
const TERRAIN_CREDIT = 0.5;

/** Strength of one border edge from its feature bits (the strongest feature wins). */
export function borderEdgeStrength(bits: number): number {
  let strength = 0;
  if ((bits & BORDER_FEATURE_BITS.river) !== 0)
    strength = Math.max(strength, TERRITORY_FEATURE_STRENGTH.river);
  if ((bits & BORDER_FEATURE_BITS.extra) !== 0)
    strength = Math.max(strength, TERRITORY_FEATURE_STRENGTH.extra);
  if ((bits & BORDER_FEATURE_BITS.slope) !== 0)
    strength = Math.max(strength, TERRITORY_FEATURE_STRENGTH.slope);
  if ((bits & BORDER_FEATURE_BITS.terrainChange) !== 0)
    strength = Math.max(strength, TERRITORY_FEATURE_STRENGTH.terrainChange);
  if ((bits & BORDER_FEATURE_BITS.lakeShore) !== 0)
    strength = Math.max(strength, TERRITORY_FEATURE_STRENGTH.lakeShore);
  return strength;
}

export function borderEdgeCredit(bits: number): number {
  if ((bits & BORDER_BARRIER_MASK) !== 0) return BARRIER_CREDIT;
  if ((bits & BORDER_FEATURE_BITS.terrainChange) !== 0) return TERRAIN_CREDIT;
  return 0;
}

/** The province graph with natural-line strengths and credits taken from a border edge table. */
export interface TerritoryProvinceGraph {
  readonly graph: ProvinceGraph;
  /** Natural border length of every directed edge of `graph`, aligned with `graph.to`. */
  readonly credit: Float32Array;
  readonly table: BorderEdgeTable;
  /** Pixel sums per province, for the centroids of atoms. */
  readonly sumX: Float64Array;
  readonly sumY: Float64Array;
  readonly size: Uint32Array;
}

function graphKind(kind: number): number {
  return kind === BORDER_PROVINCE_KIND.land ? 1 : kind === BORDER_PROVINCE_KIND.lake ? 2 : 0;
}

/**
 * Build the province graph of a map from the border edge table of the C10 metric. The table holds
 * every land border pixel edge with its natural features, so the mean strength and the natural
 * length of each shared border are exact; borders with water have none.
 */
export function buildTerritoryProvinceGraph(table: BorderEdgeTable): TerritoryProvinceGraph {
  const { width, height, provinceIds, provinceKinds } = table;
  const count = provinceKinds.length;
  if (count > 65_535)
    throw new ServiceError(
      'MAP_TERRITORY_TOO_MANY_PROVINCES',
      'Territory assignment supports at most 65,535 provinces',
      { provinces: count },
    );
  const size = new Uint32Array(count);
  const sumX = new Float64Array(count);
  const sumY = new Float64Array(count);
  let negative = false;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const id = provinceIds[row + x]!;
      if (id < 0 || id >= count) {
        negative = true;
        continue;
      }
      size[id]! += 1;
      sumX[id]! += x;
      sumY[id]! += y;
    }
  }
  let pixel = provinceIds;
  if (negative) {
    pixel = new Int32Array(provinceIds.length);
    for (let p = 0; p < pixel.length; p += 1) {
      const id = provinceIds[p]!;
      pixel[p] = id < 0 || id >= count ? 0 : id;
    }
  }
  const graph = buildProvinceGraph({
    width,
    height,
    pixel,
    kind: Uint8Array.from(provinceKinds, graphKind),
    size,
    sumX,
    sumY,
  });
  const credit = new Float32Array(graph.to.length);
  const strength = new Float64Array(graph.to.length);
  const slotOf = (from: number, to: number): number => {
    let low = graph.offsets[from]!;
    let high = graph.offsets[from + 1]! - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const value = graph.to[middle]!;
      if (value === to) return middle;
      if (value < to) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  };
  for (let index = 0; index < table.edgeCount; index += 1) {
    const a = table.provinceA[index]!;
    const b = table.provinceB[index]!;
    const bits = table.features[index]!;
    const forward = slotOf(a, b);
    const backward = slotOf(b, a);
    if (forward < 0 || backward < 0) continue;
    const edgeCredit = borderEdgeCredit(bits);
    const edgeStrength = borderEdgeStrength(bits);
    credit[forward]! += edgeCredit;
    credit[backward]! += edgeCredit;
    strength[forward]! += edgeStrength;
    strength[backward]! += edgeStrength;
  }
  for (let slot = 0; slot < strength.length; slot += 1)
    graph.barrier[slot] = strength[slot]! / Math.max(1, graph.length[slot]!);
  return { graph, credit, table, sumX, sumY, size };
}

/**
 * The province graph of a partition (ADR 0058) as a territory province graph: its mean barrier
 * strength per border gives the natural length (a border at full strength counts as natural).
 * Used when the border edge table does not exist yet, as during world generation.
 */
export function territoryGraphFromPartition(
  graph: ProvinceGraph,
  sumX: ArrayLike<number>,
  sumY: ArrayLike<number>,
): Pick<TerritoryProvinceGraph, 'graph' | 'credit' | 'sumX' | 'sumY' | 'size'> {
  const credit = new Float32Array(graph.to.length);
  for (let slot = 0; slot < credit.length; slot += 1)
    credit[slot] = graph.length[slot]! * Math.min(1, graph.barrier[slot]! * 1.25);
  return {
    graph,
    credit,
    sumX: Float64Array.from({ length: graph.count }, (_, i) => sumX[i]!),
    sumY: Float64Array.from({ length: graph.count }, (_, i) => sumY[i]!),
    size: graph.size,
  };
}

/**
 * The units countries are made of: land provinces, or the land provinces of states. An atom graph
 * has the shape of a `ProvinceGraph` (every atom is land) with the natural length of every border.
 */
export interface TerritoryAtoms {
  readonly count: number;
  readonly graph: ProvinceGraph;
  /** Natural border length of every directed edge, aligned with `graph.to`. */
  readonly credit: Float32Array;
  /** Province ids of each atom, ascending. */
  readonly members: readonly (readonly number[])[];
  /** Atom of every province id, -1 for provinces in no atom. */
  readonly atomOfProvince: Int32Array;
  /** Strategic region (or any other group) of every atom, -1 for none: a soft preference. */
  readonly region: Int32Array;
}

/**
 * Aggregate provinces into atoms. `groups[i]` lists the provinces of atom `i`; every province must
 * be land and appear once. `region` is optional and gives the group id of each atom.
 */
export function buildTerritoryAtoms(
  base: Pick<TerritoryProvinceGraph, 'graph' | 'credit' | 'sumX' | 'sumY' | 'size'>,
  groups: readonly (readonly number[])[],
  region?: Int32Array,
): TerritoryAtoms {
  const provinceCount = base.graph.count;
  const atomOfProvince = new Int32Array(provinceCount).fill(-1);
  const members: number[][] = [];
  for (const [atom, group] of groups.entries()) {
    const sorted = [...group].sort((x, y) => x - y);
    for (const province of sorted) {
      if (
        province < 0 ||
        province >= provinceCount ||
        base.graph.kind[province] !== 1 ||
        atomOfProvince[province]! >= 0
      )
        throw new ServiceError(
          'MAP_TERRITORY_ATOM_INVALID',
          `Province ${province} cannot belong to atom ${atom}: it is not land or belongs to another atom`,
          { province, atom },
        );
      atomOfProvince[province] = atom;
    }
    members.push(sorted);
  }
  const count = members.length;
  const size = new Uint32Array(count);
  const sumX = new Float64Array(count);
  const sumY = new Float64Array(count);
  const rows: Array<Map<number, [number, number, number]>> = Array.from(
    { length: count },
    () => new Map<number, [number, number, number]>(),
  );
  const { graph } = base;
  for (let atom = 0; atom < count; atom += 1) {
    const row = rows[atom]!;
    for (const province of members[atom]!) {
      size[atom]! += base.size[province]!;
      sumX[atom]! += base.sumX[province]!;
      sumY[atom]! += base.sumY[province]!;
      for (let slot = graph.offsets[province]!; slot < graph.offsets[province + 1]!; slot += 1) {
        const other = atomOfProvince[graph.to[slot]!]!;
        if (other < 0 || other === atom) continue;
        const length = graph.length[slot]!;
        const entry = row.get(other);
        if (entry === undefined)
          row.set(other, [length, graph.barrier[slot]! * length, base.credit[slot]!]);
        else {
          entry[0] += length;
          entry[1] += graph.barrier[slot]! * length;
          entry[2] += base.credit[slot]!;
        }
      }
    }
  }
  const offsets = new Int32Array(count + 1);
  for (let atom = 0; atom < count; atom += 1) offsets[atom + 1] = offsets[atom]! + rows[atom]!.size;
  const to = new Int32Array(offsets[count]!);
  const length = new Uint32Array(offsets[count]!);
  const barrier = new Float32Array(offsets[count]!);
  const credit = new Float32Array(offsets[count]!);
  for (let atom = 0; atom < count; atom += 1) {
    let slot = offsets[atom]!;
    for (const other of [...rows[atom]!.keys()].sort((x, y) => x - y)) {
      const [pairLength, pairStrength, pairCredit] = rows[atom]!.get(other)!;
      to[slot] = other;
      length[slot] = pairLength;
      barrier[slot] = pairStrength / Math.max(1, pairLength);
      credit[slot] = pairCredit;
      slot += 1;
    }
  }
  const centerX = new Float32Array(count);
  const centerY = new Float32Array(count);
  for (let atom = 0; atom < count; atom += 1) {
    const n = Math.max(1, size[atom]!);
    centerX[atom] = sumX[atom]! / n;
    centerY[atom] = sumY[atom]! / n;
  }
  const atomGraph: ProvinceGraph = {
    count,
    kind: new Uint8Array(count).fill(1),
    offsets,
    to,
    length,
    barrier,
    centerX,
    centerY,
    width: graph.width,
    height: graph.height,
    size,
  };
  return {
    count,
    graph: atomGraph,
    credit,
    members,
    atomOfProvince,
    region: region ?? new Int32Array(count).fill(-1),
  };
}
