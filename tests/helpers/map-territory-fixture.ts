import {
  BORDER_PROVINCE_KIND,
  borderPlaneFromBytes,
  buildBorderEdgeTable,
  scoreBorderAssignment,
  type BorderEdgeTable,
  type BorderScore,
} from '../../src/hoi4_agent_tools/map/border-quality.js';
import { partitionFieldsFromBitmaps } from '../../src/hoi4_agent_tools/map/partition-fields.js';
import type { ProvinceGraph } from '../../src/hoi4_agent_tools/map/partition-graph.js';
import {
  clusterStates,
  partitionWorld,
  type WorldPartition,
} from '../../src/hoi4_agent_tools/map/partition.js';
import { resolvePartitionTuning } from '../../src/hoi4_agent_tools/map/partition-tuning.js';
import {
  buildTerritoryAtoms,
  buildTerritoryProvinceGraph,
  type TerritoryAtoms,
  type TerritoryProvinceGraph,
} from '../../src/hoi4_agent_tools/map/territory-graph.js';
import { syntheticPartitionWorld, type SyntheticPartitionWorld } from './map-partition-fixture.js';

/**
 * Project-owned synthetic worlds for territory assignment: a partitioned fixture world with
 * rivers, ridges and a lake (real rasters, the metric of C10), and plain grids of atoms where the
 * natural lines are exactly known.
 */
export interface TerritoryWorldFixture {
  world: SyntheticPartitionWorld;
  partition: WorldPartition;
  table: BorderEdgeTable;
  provinceGraph: TerritoryProvinceGraph;
  landProvinces: number[];
}

const BASE = {
  landProvincePixels: 300,
  seaProvincePixels: 1_500,
  provincesPerState: 6,
  landProvincesPerRegion: 25,
  seaProvincesPerRegion: 10,
};

export async function territoryWorld(
  width = 768,
  height = 384,
  seed = 7,
): Promise<TerritoryWorldFixture> {
  const world = syntheticPartitionWorld(width, height, seed);
  const fields = partitionFieldsFromBitmaps({
    width,
    height,
    kind: world.kind,
    heights: world.heights,
    rivers: world.rivers,
    terrain: world.terrain,
    moisture: world.moisture,
  });
  const partition = partitionWorld({
    fields,
    seed,
    tuning: resolvePartitionTuning(undefined, { ...BASE, width, height }),
  });
  const kinds = Uint8Array.from(partition.provinces.kind, (k) =>
    k === 1
      ? BORDER_PROVINCE_KIND.land
      : k === 0
        ? BORDER_PROVINCE_KIND.sea
        : BORDER_PROVINCE_KIND.lake,
  );
  const table = await buildBorderEdgeTable({
    width,
    height,
    provinceIds: partition.provinces.pixel,
    provinceKinds: kinds,
    layers: [],
    features: {
      heights: borderPlaneFromBytes(width, height, world.heights),
      rivers: borderPlaneFromBytes(width, height, world.rivers),
    },
  });
  const landProvinces = Array.from(kinds, (kind, id) =>
    kind === BORDER_PROVINCE_KIND.land ? id : -1,
  ).filter((id) => id >= 0);
  return {
    world,
    partition,
    table,
    provinceGraph: buildTerritoryProvinceGraph(table),
    landProvinces,
  };
}

/** One atom per land province. */
export function provinceAtoms(fixture: TerritoryWorldFixture): TerritoryAtoms {
  return buildTerritoryAtoms(
    fixture.provinceGraph,
    fixture.landProvinces.map((id) => [id]),
  );
}

/** Atoms are the states the feature-aware clustering finds over all land provinces. */
export function stateAtoms(fixture: TerritoryWorldFixture): TerritoryAtoms {
  const clusters = clusterStates(fixture.partition, fixture.landProvinces);
  const groups = new Map<number, number[]>();
  for (const [province, cluster] of clusters) {
    const list = groups.get(cluster) ?? [];
    list.push(province);
    groups.set(cluster, list);
  }
  return buildTerritoryAtoms(
    fixture.provinceGraph,
    [...groups.keys()].sort((a, b) => a - b).map((key) => groups.get(key)!),
  );
}

/** Country label of every province id from an owner per atom. */
export function provinceLabels(
  atoms: TerritoryAtoms,
  owner: Int32Array,
  provinceCount: number,
): Int32Array {
  const labels = new Int32Array(provinceCount).fill(-1);
  for (let atom = 0; atom < atoms.count; atom += 1)
    for (const province of atoms.members[atom]!) labels[province] = owner[atom]!;
  return labels;
}

export function scoreOwners(
  fixture: TerritoryWorldFixture,
  atoms: TerritoryAtoms,
  owner: Int32Array,
): BorderScore {
  return scoreBorderAssignment(
    fixture.table,
    provinceLabels(atoms, owner, fixture.partition.provinces.kind.length),
  );
}

/** The atom whose centre is nearest to a point as a fraction of the map. */
export function atomNear(atoms: TerritoryAtoms, fx: number, fy: number): number {
  const graph = atoms.graph;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let atom = 0; atom < atoms.count; atom += 1) {
    const dx = graph.centerX[atom]! - fx * graph.width;
    const dy = graph.centerY[atom]! - fy * graph.height;
    const d = dx * dx + dy * dy;
    if (d < distance) {
      distance = d;
      best = atom;
    }
  }
  return best;
}

export interface GridOptions {
  width: number;
  height: number;
  /** Columns c such that the border between column c and c + 1 is a river. */
  riverColumns?: readonly number[];
  /** Rows r such that the border between row r and r + 1 is a river. */
  riverRows?: readonly number[];
  /** Atoms that do not exist (sea): their edges are dropped, so islands can form. */
  holes?: ReadonlySet<number>;
  /** Pixel size of an atom. Default 10. */
  cell?: number;
}

/**
 * A plain grid of atoms (id = y * width + x), each cell cell x cell pixels, with rivers on chosen
 * lines. A hole is an atom with no neighbours and no weight use (it must be excluded).
 */
export function gridAtoms(options: GridOptions): TerritoryAtoms {
  const { width, height } = options;
  const cell = options.cell ?? 10;
  const count = width * height;
  const rivers = new Set(options.riverColumns ?? []);
  const rows = new Set(options.riverRows ?? []);
  const holes = options.holes ?? new Set<number>();
  const to: number[] = [];
  const length: number[] = [];
  const barrier: number[] = [];
  const credit: number[] = [];
  const offsets = new Int32Array(count + 1);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const atom = y * width + x;
      if (!holes.has(atom))
        for (const [dx, dy] of [
          [0, -1],
          [-1, 0],
          [1, 0],
          [0, 1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const other = ny * width + nx;
          if (holes.has(other)) continue;
          const river =
            (dx !== 0 && rivers.has(Math.min(x, nx))) || (dy !== 0 && rows.has(Math.min(y, ny)));
          to.push(other);
          length.push(cell);
          barrier.push(river ? 1 : 0);
          credit.push(river ? cell : 0);
        }
      offsets[atom + 1] = to.length;
    }
  const centerX = new Float32Array(count);
  const centerY = new Float32Array(count);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      centerX[y * width + x] = x * cell + cell / 2;
      centerY[y * width + x] = y * cell + cell / 2;
    }
  const graph: ProvinceGraph = {
    count,
    kind: new Uint8Array(count).fill(1),
    offsets,
    to: Int32Array.from(to),
    length: Uint32Array.from(length),
    barrier: Float32Array.from(barrier),
    centerX,
    centerY,
    width: width * cell,
    height: height * cell,
    size: new Uint32Array(count).fill(cell * cell),
  };
  return {
    count,
    graph,
    credit: Float32Array.from(credit),
    members: Array.from({ length: count }, (_, atom) => [atom]),
    atomOfProvince: Int32Array.from({ length: count }, (_, atom) => atom),
    region: new Int32Array(count).fill(-1),
  };
}
