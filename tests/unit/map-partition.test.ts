import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  PARTITION_KIND,
  PARTITION_TERRAIN,
  partitionFieldsFromBitmaps,
  type PartitionFields,
} from '../../src/hoi4_agent_tools/map/partition-fields.js';
import {
  buildProvinceGraph,
  provinceEdgeCosts,
} from '../../src/hoi4_agent_tools/map/partition-graph.js';
import { clusterProvinces } from '../../src/hoi4_agent_tools/map/partition-groups.js';
import { buildBarrierField } from '../../src/hoi4_agent_tools/map/partition-provinces.js';
import {
  PARTITION_PROVINCE_ERROR,
  resolvePartitionTuning,
  type PartitionTuning,
} from '../../src/hoi4_agent_tools/map/partition-tuning.js';
import {
  placeSeeds,
  weightedWatershed,
  STEP_UNIT,
} from '../../src/hoi4_agent_tools/map/partition-watershed.js';
import {
  clusterRegions,
  clusterStates,
  partitionWorld,
  resolvePartitionMode,
  type WorldPartition,
} from '../../src/hoi4_agent_tools/map/partition.js';
import { generateWorldProvinces } from '../../src/hoi4_agent_tools/map/world-provinces.js';
import { growClusters, Random } from '../../src/hoi4_agent_tools/map/world.js';
import { provinceCountNote } from '../../src/hoi4_agent_tools/map/world-partition.js';
import {
  assertProvinceTopology,
  measureWorldBorders,
} from '../helpers/map-partition-assertions.js';
import {
  syntheticPartitionWorld,
  type SyntheticPartitionWorld,
} from '../helpers/map-partition-fixture.js';

const BASE = {
  landProvincePixels: 300,
  seaProvincePixels: 1_500,
  provincesPerState: 6,
  landProvincesPerRegion: 25,
  seaProvincesPerRegion: 10,
};

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe(code);
    return;
  }
  expect.fail(`expected ${code}`);
}

function fieldsOf(world: SyntheticPartitionWorld): PartitionFields {
  return partitionFieldsFromBitmaps({
    width: world.width,
    height: world.height,
    kind: world.kind,
    heights: world.heights,
    rivers: world.rivers,
    terrain: world.terrain,
    moisture: world.moisture,
  });
}

function partition(
  fields: PartitionFields,
  tuning?: PartitionTuning,
  seed = 7,
  base = BASE,
): WorldPartition {
  return partitionWorld({
    fields,
    seed,
    tuning: resolvePartitionTuning(tuning, { ...base, width: fields.width, height: fields.height }),
  });
}

function idsOf(provinces: WorldPartition['provinces'], kind: number): number[] {
  return provinces.kind.flatMap((value, id) => (value === kind ? [id] : []));
}

const world = syntheticPartitionWorld(384, 256, 7);
const fields = fieldsOf(world);
const main = partition(fields);

describe('feature-aware province partition', () => {
  it('keeps every engine rule the legacy partition keeps', () => {
    assertProvinceTopology(world.width, world.height, world.kind, main.provinces);
    expect(main.provinces.kind.length).toBeLessThan(65_000);
    expect(new Set(main.provinces.kind)).toEqual(new Set([0, 1, 2]));
    // A lake is one province when it is small.
    expect(idsOf(main.provinces, PARTITION_KIND.lake).length).toBe(1);
  });

  it('is deterministic and changes with the seed', () => {
    const again = partition(fields);
    expect(again.provinces.pixel).toEqual(main.provinces.pixel);
    expect(again.graph.to).toEqual(main.graph.to);
    expect(partition(fields, undefined, 8).provinces.pixel).not.toEqual(main.provinces.pixel);
  });

  it('numbers provinces densely by their first pixel, as the legacy partition does', () => {
    const seen = new Set<number>();
    for (const id of main.provinces.pixel) {
      if (seen.has(id)) continue;
      expect(id).toBe(seen.size);
      seen.add(id);
    }
  });

  it('reports the planned and the achieved size distribution', () => {
    const { land, sea, expectedProvinces } = main.statistics;
    expect(land.count).toBe(idsOf(main.provinces, 1).length);
    expect(land.mean).toBeGreaterThan(BASE.landProvincePixels * 0.6);
    expect(land.mean).toBeLessThan(BASE.landProvincePixels * 1.5);
    expect(land.p10).toBeLessThan(land.median);
    expect(land.median).toBeLessThan(land.p90);
    expect(sea.count).toBeGreaterThan(0);
    expect(expectedProvinces).toBeGreaterThan(main.provinces.kind.length * 0.6);
    expect(expectedProvinces).toBeLessThan(main.provinces.kind.length * 1.6);
  });

  it('puts province borders on rivers, ridges and steep slopes more often than the legacy partition', async () => {
    const total = world.width * world.height;
    const elevation = new Float32Array(total);
    const moisture = new Float32Array(total);
    for (let p = 0; p < total; p++) {
      elevation[p] = world.kind[p] === 1 ? (world.heights[p]! - 96) / 110 : -0.1;
      moisture[p] = world.moisture[p]! / 255;
    }
    const legacy = generateWorldProvinces({
      width: world.width,
      height: world.height,
      seed: 7,
      kind: world.kind,
      elevation,
      moisture,
      landProvincePixels: BASE.landProvincePixels,
      seaProvincePixels: BASE.seaProvincePixels,
    });
    const legacyLand = idsOf(legacy, 1);
    const legacyStates = growClusters(
      legacyLand,
      (id) => legacy.neighbors[id]!,
      BASE.provincesPerState,
      new Random(7),
    );
    const before = await measureWorldBorders(world, legacy, legacyStates);
    const after = await measureWorldBorders(
      world,
      main.provinces,
      clusterStates(main, idsOf(main.provinces, 1)),
    );
    // The legacy borders are at chance level on this fixture (enrichment about 1).
    expect(before.province.barrier.enrichment!).toBeLessThan(1.15);
    expect(before.state.barrier.enrichment!).toBeLessThan(1.15);
    expect(after.province.barrier.enrichment!).toBeGreaterThan(
      before.province.barrier.enrichment! + 0.15,
    );
    expect(after.province.barrier.enrichment!).toBeGreaterThan(1.2);
    expect(after.state.barrier.enrichment!).toBeGreaterThan(before.state.barrier.enrichment! + 0.6);
    expect(after.state.barrier.enrichment!).toBeGreaterThan(1.6);
    expect(after.state.natural.share!).toBeGreaterThan(before.state.natural.share! * 1.8);
  });

  it('does not let a province straddle a river', () => {
    const { pixel } = main.provinces;
    const { width } = world;
    const river = (p: number): boolean => world.rivers[p]! <= 11;
    let straight = 0;
    let crossings = 0;
    for (let p = 3 * width; p + 3 * width < pixel.length; p++) {
      const x = p % width;
      if (x < 3 || x >= width - 3 || !river(p)) continue;
      // A straight vertical stretch with open ground on both sides.
      if (!river(p - width) || !river(p + width)) continue;
      if (
        [-2, -1, 1, 2].some((dx) => river(p + dx) || river(p + dx - width) || river(p + dx + width))
      )
        continue;
      straight++;
      if (pixel[p - 2] === pixel[p + 2] && main.provinces.kind[pixel[p - 2]!] === 1) crossings++;
    }
    expect(straight).toBeGreaterThan(100);
    expect(crossings / straight).toBeLessThan(0.04);
  });

  it('makes provinces on rough or barren ground larger than those in fertile valleys', () => {
    const size = 1_024;
    const kind = new Uint8Array(size * 512).fill(1);
    const terrain = new Uint8Array(size * 512);
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < size; x++) terrain[y * size + x] = x < size / 2 ? 5 : 6;
    const fertileFields = partitionFieldsFromBitmaps({
      width: size,
      height: 512,
      kind,
      terrain,
    });
    const result = partition(
      fertileFields,
      { landArea: { fertile: 100, hills: 300, mountain: 700, waste: 1_000 } },
      3,
    );
    const west: number[] = [];
    const east: number[] = [];
    for (const id of idsOf(result.provinces, 1)) {
      const cx = result.provinces.sumX[id]! / result.provinces.size[id]!;
      if (cx < size / 2 - 40) west.push(result.provinces.size[id]!);
      else if (cx > size / 2 + 40) east.push(result.provinces.size[id]!);
    }
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(west)).toBeGreaterThan(70);
    expect(mean(west)).toBeLessThan(160);
    expect(mean(east)).toBeGreaterThan(500);
    expect(mean(east)).toBeLessThan(1_000);
    expect(mean(east) / mean(west)).toBeGreaterThan(4);
  });

  it('makes sea provinces small near a coast and large on the open sea', () => {
    const near: number[] = [];
    const far: number[] = [];
    const { provinces } = main;
    const half = Math.sqrt(main.tuning.seaArea.open);
    for (const id of idsOf(provinces, 0)) {
      let nearest = Infinity;
      for (const other of provinces.neighbors[id]!) if (provinces.kind[other] === 1) nearest = 0;
      if (nearest === 0) near.push(provinces.size[id]!);
      else if (provinces.size[id]! > half) far.push(provinces.size[id]!);
    }
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(near.length).toBeGreaterThan(10);
    expect(far.length).toBeGreaterThan(5);
    expect(mean(far)).toBeGreaterThan(mean(near));
  });

  it('keeps two sea provinces across a narrow strait', () => {
    const width = 512;
    const height = 256;
    const kind = new Uint8Array(width * height);
    // Two landmasses with a channel 12 pixels wide between them, open to the sea at both ends.
    for (let y = 20; y < 236; y++)
      for (let x = 60; x < 452; x++) {
        const channel = y >= 122 && y < 134;
        kind[y * width + x] = channel ? 0 : 1;
      }
    const narrow = partitionFieldsFromBitmaps({ width, height, kind });
    const result = partition(narrow, { narrowStraitPx: 24 }, 5, {
      ...BASE,
      seaProvincePixels: 2_500,
    });
    assertProvinceTopology(width, height, kind, result.provinces);
    // Walk across the channel at several places: every column shows at least two sea provinces.
    for (const x of [140, 200, 256, 320, 380]) {
      const across = new Set<number>();
      for (let y = 122; y < 134; y++) across.add(result.provinces.pixel[y * width + x]!);
      expect(across.size, `columns at x=${x}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses one province for a small lake and two for a very large one', () => {
    const size = 512;
    const kind = new Uint8Array(size * size).fill(1);
    const small = 12;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if ((x - 128) ** 2 + (y - 256) ** 2 <= small * small) kind[y * size + x] = 2;
        if ((x - 380) ** 2 + (y - 256) ** 2 <= 70 * 70) kind[y * size + x] = 2;
      }
    const result = partition(
      partitionFieldsFromBitmaps({ width: size, height: size, kind }),
      undefined,
      2,
      { ...BASE, landProvincePixels: 400 },
    );
    const lakes = idsOf(result.provinces, 2);
    expect(lakes.length).toBeGreaterThanOrEqual(3);
    const bySize = lakes.map((id) => result.provinces.size[id]!).sort((a, b) => a - b);
    expect(bySize[0]).toBeLessThan(600);
    expect(bySize.reduce((a, b) => a + b, 0)).toBeGreaterThan(15_000);
    assertProvinceTopology(size, size, kind, result.provinces);
  });
});

describe('partition inputs from the geography model', () => {
  const width = 1_024;
  const height = 512;
  const kind = new Uint8Array(width * height).fill(1);
  const regionId = new Uint16Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) regionId[y * width + x] = x < width / 2 ? 1 : 2;
  const barrier = new Uint8Array(width * height);
  // A wall along x = 200, three pixels thick.
  for (let y = 80; y < 432; y++) for (let x = 199; x <= 201; x++) barrier[y * width + x] = 255;
  const base = partitionFieldsFromBitmaps({ width, height, kind });
  const modelled: PartitionFields = {
    ...base,
    regionId,
    barrier,
    regions: [
      { id: 1, kind: 'land', name: 'Dense', provinceAreaPx: 100, provincesPerState: [2, 3, 4] },
      { id: 2, kind: 'land', name: 'Wild', provinceAreaPx: 600 },
    ],
  };
  const result = partition(modelled, undefined, 4, { ...BASE, landProvincePixels: 300 });

  it('cuts along region borders and honours the density each region asks for', () => {
    assertProvinceTopology(width, height, kind, result.provinces);
    const regionsOf = new Map<number, Set<number>>();
    for (let p = 0; p < regionId.length; p++) {
      const id = result.provinces.pixel[p]!;
      const set = regionsOf.get(id) ?? new Set<number>();
      set.add(regionId[p]!);
      regionsOf.set(id, set);
    }
    // No province straddles the border between the regions.
    expect([...regionsOf.values()].filter((set) => set.size > 1).length).toBe(0);
    const dense: number[] = [];
    const wild: number[] = [];
    for (const id of idsOf(result.provinces, 1)) {
      (result.provinceRegion[id] === 1 ? dense : wild).push(result.provinces.size[id]!);
    }
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(wild) / mean(dense)).toBeGreaterThan(3);
  });

  it('lets no province straddle a wall and puts a border on it', () => {
    let straddling = 0;
    let onWall = 0;
    for (let y = 100; y < 412; y++) {
      const west = result.provinces.pixel[y * width + 197]!;
      const east = result.provinces.pixel[y * width + 203]!;
      if (west === east) straddling++;
      const a = result.provinces.pixel[y * width + 198]!;
      const b = result.provinces.pixel[y * width + 202]!;
      if (a !== b) onWall++;
    }
    // The four-corner repair may have to join two provinces across the wall at a junction; that
    // is rare (a few rows of three hundred).
    expect(straddling).toBeLessThan(16);
    expect(onWall).toBeGreaterThan(280);
  });

  it('clusters states inside a region with the size the region asks for', () => {
    const members = idsOf(result.provinces, 1);
    const states = clusterStates(result, members);
    const sizes = new Map<number, number>();
    for (const [id, cluster] of states) {
      sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
      // No state mixes the two regions.
      const peer = [...states].find(([, other]) => other === cluster)![0];
      expect(result.provinceRegion[id]).toBe(result.provinceRegion[peer]);
    }
    const dense = [...states]
      .filter(([id]) => result.provinceRegion[id] === 1)
      .map(([, cluster]) => sizes.get(cluster)!);
    expect(Math.max(...dense)).toBeLessThanOrEqual(4);
  });
});

describe('province graph', () => {
  it('lists every neighbour once in each direction with the shared border length', () => {
    const graph = main.graph;
    const { pixel } = main.provinces;
    const expected = new Map<string, number>();
    const { width, height } = world;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const id = pixel[p]!;
        for (const q of [y * width + ((x + 1) % width), y + 1 < height ? p + width : -1]) {
          if (q < 0 || pixel[q] === id) continue;
          const key = `${Math.min(id, pixel[q]!)}:${Math.max(id, pixel[q]!)}`;
          expected.set(key, (expected.get(key) ?? 0) + 1);
        }
      }
    let directed = 0;
    for (let a = 0; a < graph.count; a++) {
      let previous = -1;
      for (let e = graph.offsets[a]!; e < graph.offsets[a + 1]!; e++) {
        const b = graph.to[e]!;
        expect(b).toBeGreaterThan(previous);
        previous = b;
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        expect(graph.length[e]).toBe(expected.get(key));
        directed++;
      }
    }
    expect(directed).toBe(expected.size * 2);
    for (let id = 0; id < graph.count; id++)
      expect(new Set(main.provinces.neighbors[id]!)).toEqual(
        new Set(graph.to.subarray(graph.offsets[id]!, graph.offsets[id + 1]!)),
      );
  });

  it('joins provinces across the east-west seam and measures how natural each border is', () => {
    const width = 128;
    const height = 64;
    const pixel = new Int32Array(width * height);
    const barrier = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        pixel[y * width + x] = x < 64 ? 0 : 1;
        // The border between 0 and 1 at x = 63|64 is on a river; the seam at 127|0 is not.
        if (x === 63 || x === 64) barrier[y * width + x] = 255;
      }
    const graph = buildProvinceGraph({
      width,
      height,
      pixel,
      kind: [1, 1],
      size: [64 * height, 64 * height],
      sumX: [32 * 64 * height, 96 * 64 * height],
      sumY: [32 * 64 * height, 32 * 64 * height],
      barrier,
    });
    expect(graph.length[0]).toBe(2 * height);
    expect(graph.barrier[0]).toBeCloseTo(0.5, 5);
    // The same two provinces touch at the river and across the seam; the seam shorter than the
    // river border would not change the mean, so check the centre distance through the seam.
    const cost = provinceEdgeCosts(graph, { barrier: 6 });
    expect(cost[0]).toBeCloseTo(64 * (1 + 6 * 0.5), 3);
    expect(Array.from(cost).length).toBe(graph.to.length);
  });

  it('refuses a raster or barrier plane of the wrong size', () => {
    const input = {
      width: 4,
      height: 4,
      pixel: new Int32Array(16),
      kind: [1],
      size: [16],
      sumX: [0],
      sumY: [0],
    };
    expect(() => buildProvinceGraph({ ...input, pixel: new Int32Array(5) })).toThrow(
      /does not match/u,
    );
    expect(() => buildProvinceGraph({ ...input, barrier: new Uint8Array(5) })).toThrow(
      /does not match/u,
    );
  });
});

describe('states and regions as clusters on the graph', () => {
  const land = idsOf(main.provinces, 1);

  it('keeps clusters inside the size limits and numbers them by smallest member', () => {
    const states = clusterStates(main, land);
    expect(states.size).toBe(land.length);
    const sizes = new Map<number, number[]>();
    for (const [id, cluster] of states) sizes.set(cluster, [...(sizes.get(cluster) ?? []), id]);
    const { max, min } = main.tuning.states;
    let small = 0;
    let previous = -1;
    for (const [cluster, members] of [...sizes].sort((a, b) => a[0] - b[0])) {
      expect(members.length).toBeLessThanOrEqual(max);
      if (members.length < min) small++;
      const first = Math.min(...members);
      expect(first).toBeGreaterThan(previous);
      previous = first;
      expect(cluster).toBeGreaterThanOrEqual(0);
    }
    // Most states reach the minimum; a few pockets cannot.
    expect(small / sizes.size).toBeLessThan(0.2);
    // Deterministic.
    expect(clusterStates(main, land)).toEqual(states);
  });

  it('builds connected clusters', () => {
    const states = clusterStates(main, land);
    const groups = new Map<number, number[]>();
    for (const [id, cluster] of states) groups.set(cluster, [...(groups.get(cluster) ?? []), id]);
    for (const members of groups.values()) {
      const set = new Set(members);
      const seen = new Set([members[0]!]);
      const stack = [members[0]!];
      while (stack.length > 0) {
        const id = stack.pop()!;
        for (const next of main.provinces.neighbors[id]!)
          if (set.has(next) && !seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
      }
      expect(seen.size).toBe(members.length);
    }
  });

  it('clusters regions of land and sea, never mixing the groups the caller names', () => {
    const regions = clusterRegions(main, land, 'land');
    expect(new Set(regions.values()).size).toBeGreaterThan(
      land.length / (main.tuning.regions.max + 1),
    );
    const seas = clusterRegions(main, idsOf(main.provinces, 0), 'sea');
    expect(new Set(seas.values()).size).toBeGreaterThan(1);
    // A hook that names groups keeps clusters apart.
    const grouped = clusterProvinces(
      land,
      main.graph,
      { min: 2, target: 40, max: 80 },
      { group: (id) => id % 2 },
    );
    for (const [id, cluster] of grouped)
      for (const [other, otherCluster] of grouped)
        if (cluster === otherCluster) expect(other % 2).toBe(id % 2);
  });

  it('avoids joining across a river or a wall when it can', () => {
    const states = clusterStates(main, land);
    const natural = states;
    const plain = growClusters(land, (id) => main.provinces.neighbors[id]!, 6, new Random(7));
    const share = (clusters: Map<number, number>): number => {
      let total = 0;
      let across = 0;
      for (let a = 0; a < main.graph.count; a++) {
        if (!clusters.has(a)) continue;
        for (let e = main.graph.offsets[a]!; e < main.graph.offsets[a + 1]!; e++) {
          const b = main.graph.to[e]!;
          if (b < a || !clusters.has(b)) continue;
          total += main.graph.length[e]!;
          if (clusters.get(a) === clusters.get(b))
            across += main.graph.length[e]! * main.graph.barrier[e]!;
        }
      }
      return across / total;
    };
    // Less natural-line length lies inside the new states than inside the breadth-first ones.
    expect(share(natural)).toBeLessThan(share(plain) * 0.9);
  });

  it('handles empty, single and tiny groups', () => {
    expect(clusterProvinces([], main.graph, { min: 2, target: 4, max: 6 }).size).toBe(0);
    const one = clusterProvinces([land[0]!], main.graph, { min: 2, target: 4, max: 6 });
    expect([...one]).toEqual([[land[0], 0]]);
  });
});

describe('barrier field and watershed engines', () => {
  it('rates rivers highest, then steep slopes and ridges, and leaves plains and water alone', () => {
    const barrier = buildBarrierField(fields, main.tuning, undefined);
    let riverPixel = -1;
    let plainPixel = -1;
    for (let p = 0; p < barrier.length; p++) {
      if (riverPixel < 0 && world.rivers[p]! <= 11 && fields.slope[p] === 0) riverPixel = p;
      if (
        plainPixel < 0 &&
        world.kind[p] === 1 &&
        fields.riverDistance[p]! > 20 &&
        fields.slope[p] === 0 &&
        fields.ridge[p] === 0
      )
        plainPixel = p;
    }
    expect(barrier[riverPixel]).toBe(255);
    expect(barrier[plainPixel]).toBe(0);
    for (let p = 0; p < barrier.length; p++) if (world.kind[p] === 0) expect(barrier[p]).toBe(0);
    expect(fields.terrainClass.some((value) => value === PARTITION_TERRAIN.mountain)).toBe(true);
  });

  it('floods from seeds, stops at a costly line and labels only what a seed reaches', () => {
    const width = 64;
    const height = 32;
    const kind = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 8; x < 56; x++) kind[y * width + x] = 1;
    const step = new Uint16Array(width * height).fill(STEP_UNIT);
    // A costly column at x = 36 shifts the meeting point of two seeds towards it.
    for (let y = 0; y < height; y++) step[y * width + 36] = STEP_UNIT * 40;
    const labels = weightedWatershed({
      width,
      height,
      kind,
      step,
      seeds: Int32Array.from([16 * width + 14, 16 * width + 50]),
    });
    // Without the costly column the border would be at x = 32; with it, the west seed's front
    // gets no further than the column.
    expect(labels[16 * width + 35]).toBe(0);
    expect(labels[16 * width + 37]).toBe(1);
    expect(labels[16 * width + 2]).toBe(-1);
    expect(labels[16 * width + 14]).toBe(0);
  });

  it('places seeds no closer than their spacing, in every component, deterministically', () => {
    const width = 256;
    const height = 128;
    const kind = new Uint8Array(width * height).fill(1);
    const options = {
      width,
      height,
      kind,
      wanted: 1,
      areaAt: () => 400,
      minArea: 400,
      seed: 3,
      salt: 1,
    };
    const seeds = placeSeeds(options);
    expect(placeSeeds(options)).toEqual(seeds);
    expect(seeds.length).toBeGreaterThan(60);
    let nearest = Infinity;
    for (let i = 0; i < seeds.length; i++)
      for (let j = i + 1; j < seeds.length; j++) {
        const ax = seeds[i]! % width;
        const bx = seeds[j]! % width;
        let dx = Math.abs(ax - bx);
        dx = Math.min(dx, width - dx);
        const dy = Math.floor(seeds[i]! / width) - Math.floor(seeds[j]! / width);
        nearest = Math.min(nearest, Math.sqrt(dx * dx + dy * dy));
      }
    expect(nearest).toBeGreaterThanOrEqual(0.8 * Math.sqrt(400) - 1);
  });
});

describe('partition limits and refusals', () => {
  it('refuses a plan that needs more provinces than the engine and the text tables allow', () => {
    const size = 1_024;
    const kind = new Uint8Array(size * 512).fill(1);
    const tooMany = partitionFieldsFromBitmaps({ width: size, height: 512, kind });
    expectCode(
      () =>
        partition(
          tooMany,
          {
            landArea: { fertile: 20, hills: 20, mountain: 20, waste: 20 },
            minProvincePixels: 20,
          },
          1,
          { ...BASE, landProvincePixels: 20 },
        ),
      'MAP_PARTITION_PROVINCE_COUNT_HIGH',
    );
    expect(PARTITION_PROVINCE_ERROR).toBe(21_000);
  });

  it('refuses fields that do not match the map, with the fields code', () => {
    expectCode(
      () => partition({ ...fields, slope: new Uint8Array(4) }),
      'MAP_PARTITION_FIELDS_INVALID',
    );
    expectCode(() => partition(fields, undefined, 1.5), 'MAP_PARTITION_FIELDS_INVALID');
  });

  it('refuses a mask that needs more than 65,000 provinces before it plans anything', () => {
    const width = 1_024;
    const height = 512;
    const kind = new Uint8Array(width * height);
    // Isolated land pixels on a checkerboard: every one needs its own province.
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) kind[y * width + x] = 1;
    expectCode(
      () => partition(partitionFieldsFromBitmaps({ width, height, kind })),
      'MAP_WORLD_TOO_MANY_PROVINCES',
    );
  });

  it('chooses the partition from the request and the geography', () => {
    expect(resolvePartitionMode(undefined, false)).toBe('legacy');
    expect(resolvePartitionMode(undefined, true)).toBe('feature-aware');
    expect(resolvePartitionMode('legacy', true)).toBe('legacy');
    expect(resolvePartitionMode('feature-aware', false)).toBe('feature-aware');
  });

  it('warns above 14,000 provinces and says which fields to change', () => {
    expect(provinceCountNote(13_999, 'legacy')).toBeUndefined();
    const note = provinceCountNote(15_000, 'feature-aware');
    expect(note?.code).toBe('MAP_PARTITION_PROVINCE_COUNT_HIGH');
    expect(note?.message).toContain('landProvincePixels');
    expect(note?.details).toMatchObject({ errorAbove: 21_000, provinces: 15_000 });
  });
});

describe('partition at scale', () => {
  it('partitions a 2,048 x 1,024 world inside its budget', () => {
    const big = syntheticPartitionWorld(2_048, 1_024, 11);
    const started = performance.now();
    const result = partition(fieldsOf(big), undefined, 11, {
      ...BASE,
      landProvincePixels: 400,
      seaProvincePixels: 2_500,
    });
    const elapsed = performance.now() - started;
    expect(result.provinces.kind.length).toBeGreaterThan(1_500);
    expect(result.provinces.kind.length).toBeLessThan(14_000);
    expect(elapsed).toBeLessThan(30_000);
    assertProvinceTopology(2_048, 1_024, big.kind, result.provinces);
  }, 120_000);
});

describe('partition cancellation', () => {
  const aborted = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };

  it('stops the partition with the abort reason and ignores a live signal', () => {
    expect(() =>
      partitionWorld({
        fields,
        seed: 7,
        tuning: resolvePartitionTuning(undefined, {
          ...BASE,
          width: fields.width,
          height: fields.height,
        }),
        signal: aborted(),
      }),
    ).toThrow(expect.objectContaining({ name: 'AbortError' }) as Error);
    const live = partitionWorld({
      fields,
      seed: 7,
      tuning: resolvePartitionTuning(undefined, {
        ...BASE,
        width: fields.width,
        height: fields.height,
      }),
      signal: new AbortController().signal,
    });
    expect(
      Buffer.from(live.provinces.pixel.buffer).equals(Buffer.from(main.provinces.pixel.buffer)),
    ).toBe(true);
  });

  it('checks the signal inside the watershed of a large map', () => {
    const width = 512;
    const height = 256;
    const kind = new Uint8Array(width * height).fill(1);
    const step = new Uint16Array(width * height).fill(STEP_UNIT);
    const seeds = Int32Array.from([128 * width + 100, 128 * width + 400]);
    expect(() =>
      weightedWatershed({ width, height, kind, step, seeds, signal: aborted() }),
    ).toThrow(expect.objectContaining({ name: 'AbortError' }) as Error);
    const labels = weightedWatershed({ width, height, kind, step, seeds });
    expect(labels.every((label) => label === 0 || label === 1)).toBe(true);
  });
});
