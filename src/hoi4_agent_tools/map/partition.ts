import { buildProvinceGraph, type ProvinceGraph } from './partition-graph.js';
import { clusterProvinces } from './partition-groups.js';
import { PARTITION_KIND, PARTITION_TERRAIN, type PartitionFields } from './partition-fields.js';
import {
  partitionProvinces,
  type FeaturePartitionDiagnostics,
  type PartitionStatistics,
} from './partition-provinces.js';
import type {
  PartitionBase,
  PartitionTuning,
  ResolvedPartitionTuning,
} from './partition-tuning.js';
import { resolvePartitionTuning } from './partition-tuning.js';
import type { WorldProvinces } from './world-provinces.js';

/**
 * The feature-aware partition as a reusable service (ADR 0058). `partitionWorld` cuts the map into
 * provinces along its natural lines and returns the provinces, the weighted province graph, the
 * barrier raster and the groupings (geography region and ground class per province) that the
 * state and region clustering reads. World generation calls it, and so can the territory
 * assignment service to grow countries over the same graph.
 */

export type PartitionMode = 'legacy' | 'feature-aware';

/**
 * Which partition a request gets. A request that names one gets it; otherwise a world described
 * by a geography model gets the feature-aware partition (the model has regions, walls and
 * densities that only it can use) and every other request keeps the legacy partition, so its
 * output stays byte-identical for a seed.
 */
export function resolvePartitionMode(
  requested: PartitionMode | undefined,
  hasGeography: boolean,
): PartitionMode {
  return requested ?? (hasGeography ? 'feature-aware' : 'legacy');
}

export interface WorldPartitionInput {
  fields: PartitionFields;
  tuning: ResolvedPartitionTuning;
  seed: number;
  /** Land pixels that each get a province of their own (see `FeaturePartitionInput.pins`). */
  pins?: readonly number[] | undefined;
  /** Checked between the stages and inside the long loops; stops with its reason. */
  signal?: AbortSignal | undefined;
}

export interface WorldPartition {
  fields: PartitionFields;
  tuning: ResolvedPartitionTuning;
  provinces: WorldProvinces;
  graph: ProvinceGraph;
  /** Natural-line strength, 0 to 255, at every pixel. */
  barrier: Uint8Array;
  /** Geography region (or named sea) of each province, 0 for none: the region holding most pixels. */
  provinceRegion: Uint16Array;
  /**
   * Ground class (`PARTITION_TERRAIN`) of each land province, the class holding most pixels. A sea
   * province has 0 when it touches land (shelf) and 1 when it does not (open sea).
   */
  provinceGround: Uint8Array;
  statistics: PartitionStatistics;
  notes: FeaturePartitionDiagnostics[];
}

/** The class or region holding most pixels of every province. */
function majorityPerProvince(
  pixel: Int32Array,
  plane: Uint8Array | Uint16Array,
  count: number,
  include: (p: number) => boolean,
  empty: number,
): Uint16Array {
  const best = new Uint16Array(count).fill(empty);
  const bestCount = new Uint32Array(count);
  const tally = new Map<number, number>();
  let lastKey = -1;
  let run = 0;
  const flush = (): void => {
    if (lastKey < 0) return;
    const total = (tally.get(lastKey) ?? 0) + run;
    tally.set(lastKey, total);
    const id = Math.floor(lastKey / 65_536);
    const value = lastKey % 65_536;
    if (total > bestCount[id]! || (total === bestCount[id]! && value < best[id]!)) {
      bestCount[id] = total;
      best[id] = value;
    }
    run = 0;
  };
  for (let p = 0; p < pixel.length; p++) {
    if (!include(p)) continue;
    const key = pixel[p]! * 65_536 + plane[p]!;
    if (key !== lastKey) {
      flush();
      lastKey = key;
    }
    run++;
  }
  flush();
  return best;
}

/** Cut a map into provinces along its natural lines and build the weighted province graph. */
export function partitionWorld(input: WorldPartitionInput): WorldPartition {
  const { fields } = input;
  const result = partitionProvinces(input);
  input.signal?.throwIfAborted();
  const { provinces } = result;
  const graph = buildProvinceGraph({
    width: fields.width,
    height: fields.height,
    pixel: provinces.pixel,
    kind: provinces.kind,
    size: provinces.size,
    sumX: provinces.sumX,
    sumY: provinces.sumY,
    barrier: result.barrier,
  });
  const count = provinces.kind.length;
  const provinceRegion = majorityPerProvince(
    provinces.pixel,
    fields.regionId,
    count,
    (p) => fields.kind[p] !== PARTITION_KIND.lake,
    0,
  );
  const provinceGround = Uint8Array.from(
    majorityPerProvince(
      provinces.pixel,
      fields.terrainClass,
      count,
      (p) => fields.kind[p] === PARTITION_KIND.land,
      PARTITION_TERRAIN.water,
    ),
  );
  for (let id = 0; id < count; id++)
    if (provinces.kind[id] === PARTITION_KIND.sea) {
      let shelf = false;
      for (let e = graph.offsets[id]!; e < graph.offsets[id + 1]!; e++)
        if (graph.kind[graph.to[e]!] === PARTITION_KIND.land) shelf = true;
      provinceGround[id] = shelf ? 0 : 1;
    }
  return {
    fields,
    tuning: input.tuning,
    provinces,
    graph,
    barrier: result.barrier,
    provinceRegion,
    provinceGround,
    statistics: result.statistics,
    notes: result.notes,
  };
}

/** Resolve tuning against a request and partition in one call. */
export function partitionWorldFromRequest(
  fields: PartitionFields,
  seed: number,
  tuning: PartitionTuning | undefined,
  base: Omit<PartitionBase, 'width' | 'height'>,
  signal?: AbortSignal,
  pins?: readonly number[],
): WorldPartition {
  return partitionWorld({
    fields,
    seed,
    pins,
    signal,
    tuning: resolvePartitionTuning(tuning, {
      ...base,
      width: fields.width,
      height: fields.height,
    }),
  });
}

/**
 * Cluster land provinces into states. `members` are one country's provinces of one strategic
 * region (or any group the caller chose); the clusters follow natural lines, never join provinces
 * of different geography regions and prefer like ground. Returns the cluster of every member,
 * numbered from 0 by smallest member id.
 */
export function clusterStates(
  partition: WorldPartition,
  members: readonly number[],
): Map<number, number> {
  const { states } = partition.tuning;
  const region = partition.provinceRegion;
  const ground = partition.provinceGround;
  const table = new Map((partition.fields.regions ?? []).map((entry) => [entry.id, entry]));
  // A geography region may ask for its own state size; its provinces never mix with another's.
  const byRegion = new Map<number, number[]>();
  for (const id of members) {
    const list = byRegion.get(region[id]!) ?? [];
    list.push(id);
    byRegion.set(region[id]!, list);
  }
  const combined = new Map<number, number>();
  let offset = 0;
  for (const regionId of [...byRegion.keys()].sort((x, y) => x - y)) {
    const per = table.get(regionId)?.provincesPerState;
    const options =
      per === undefined
        ? { min: states.min, target: states.target, max: states.max }
        : { min: per[0], target: per[1], max: Math.max(per[2], per[1]) };
    const clusters = clusterProvinces(byRegion.get(regionId)!, partition.graph, options, {
      label: (id) => ground[id]!,
    });
    let largest = -1;
    for (const [id, cluster] of clusters) {
      combined.set(id, offset + cluster);
      if (cluster > largest) largest = cluster;
    }
    offset += largest + 1;
  }
  // Number the clusters by their smallest member, as every clustering here does.
  const dense = new Map<number, number>();
  const result = new Map<number, number>();
  for (const id of [...members].sort((x, y) => x - y)) {
    const cluster = combined.get(id)!;
    let number = dense.get(cluster);
    if (number === undefined) {
      number = dense.size;
      dense.set(cluster, number);
    }
    result.set(id, number);
  }
  return result;
}

/**
 * Cluster provinces into strategic regions: land by basin and ground inside each geography
 * region, sea by named sea and by shelf against open water. Pass the land provinces or the sea
 * provinces as `members`.
 */
export function clusterRegions(
  partition: WorldPartition,
  members: readonly number[],
  kind: 'land' | 'sea',
): Map<number, number> {
  const options = kind === 'land' ? partition.tuning.regions : partition.tuning.seaRegions;
  const region = partition.provinceRegion;
  const ground = partition.provinceGround;
  return clusterProvinces(
    members,
    partition.graph,
    { min: options.min, target: options.target, max: options.max },
    {
      group: (id) => region[id]!,
      label: (id: number) => ground[id]!,
    },
  );
}
