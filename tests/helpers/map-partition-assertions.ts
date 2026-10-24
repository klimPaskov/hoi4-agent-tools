import { expect } from 'vitest';
import {
  borderPlaneFromBytes,
  measureBorderNaturalness,
  type BorderLayerReport,
} from '../../src/hoi4_agent_tools/map/border-quality.js';
import type { WorldProvinces } from '../../src/hoi4_agent_tools/map/world-provinces.js';
import type { SyntheticPartitionWorld } from './map-partition-fixture.js';

/**
 * Every rule the finishing passes promise: the exact kind mask, one connected piece per
 * province, bounding boxes inside an eighth of the map, no four-province corner (also across the
 * seam), provinces of at least 20 pixels where a same-kind neighbour is reachable, symmetric
 * adjacency and full coverage.
 */
export function assertProvinceTopology(
  width: number,
  height: number,
  kind: Uint8Array,
  provinces: WorldProvinces,
): void {
  const total = width * height;
  const seen = new Uint8Array(total);
  const count = provinces.kind.length;
  const components = new Int32Array(count);
  const minX = new Int32Array(count).fill(width);
  const maxX = new Int32Array(count).fill(-width);
  const minY = new Int32Array(count).fill(height);
  const maxY = new Int32Array(count).fill(-height);
  const sameKindNeighbour = new Set<number>();
  for (let p = 0; p < total; p++) {
    const id = provinces.pixel[p]!;
    if (provinces.kind[id] !== kind[p]) expect.fail(`province ${id} changes the mask at ${p}`);
    const x = p % width;
    const y = (p - x) / width;
    for (const q of [x + 1 < width ? p + 1 : -1, p + width])
      if (q >= 0 && q < total && provinces.pixel[q] !== id && kind[p] === kind[q]) {
        sameKindNeighbour.add(id);
        sameKindNeighbour.add(provinces.pixel[q]!);
      }
    minX[id] = Math.min(minX[id]!, x);
    maxX[id] = Math.max(maxX[id]!, x);
    minY[id] = Math.min(minY[id]!, y);
    maxY[id] = Math.max(maxY[id]!, y);
    if (seen[p]) continue;
    components[id]!++;
    const queue = [p];
    seen[p] = 1;
    for (const current of queue) {
      const cx = current % width;
      for (const q of [
        current - width,
        current + width,
        cx + 1 < width ? current + 1 : -1,
        cx > 0 ? current - 1 : -1,
      ]) {
        if (q < 0 || q >= total || seen[q] || provinces.pixel[q] !== id) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
  }
  for (let id = 0; id < count; id++) {
    expect(components[id], `province ${id} is connected`).toBe(1);
    expect(maxX[id]! - minX[id]! + 1).toBeLessThanOrEqual(width / 8);
    expect(maxY[id]! - minY[id]! + 1).toBeLessThanOrEqual(height / 8);
    if (sameKindNeighbour.has(id)) expect(provinces.size[id]).toBeGreaterThanOrEqual(20);
    for (const other of provinces.neighbors[id]!)
      expect(provinces.neighbors[other]!.has(id)).toBe(true);
  }
  for (let y = 0; y + 1 < height; y++)
    for (let x = 0; x < width; x++) {
      const a = y * width + x;
      const b = y * width + ((x + 1) % width);
      const corner = new Set([a, b, a + width, b + width].map((p) => provinces.pixel[p]));
      if (corner.size === 4) expect.fail(`four provinces meet at ${x},${y}`);
    }
  expect(provinces.size.reduce((sum, size) => sum + size, 0)).toBe(total);
}

export interface BorderMeasurement {
  province: BorderLayerReport;
  state: BorderLayerReport;
}

/** The border-naturalness report of a province raster, grouped into states, on a fixture world. */
export async function measureWorldBorders(
  world: SyntheticPartitionWorld,
  provinces: Pick<WorldProvinces, 'pixel' | 'kind'>,
  stateOf: ReadonlyMap<number, number>,
): Promise<BorderMeasurement> {
  const count = provinces.kind.length;
  const kinds = Uint8Array.from(provinces.kind, (k) => (k === 1 ? 1 : k === 0 ? 2 : 3));
  const provinceLabels = new Int32Array(count).fill(-1);
  const stateLabels = new Int32Array(count).fill(-1);
  for (let id = 0; id < count; id++)
    if (kinds[id] === 1) {
      provinceLabels[id] = id;
      stateLabels[id] = stateOf.get(id) ?? -1;
    }
  const result = await measureBorderNaturalness({
    width: world.width,
    height: world.height,
    provinceIds: provinces.pixel,
    provinceKinds: kinds,
    layers: [
      { name: 'province', labels: provinceLabels },
      { name: 'state', labels: stateLabels },
    ],
    features: {
      heights: borderPlaneFromBytes(world.width, world.height, world.heights),
      rivers: borderPlaneFromBytes(world.width, world.height, world.rivers),
    },
  });
  return {
    province: result.report.layers.find((layer) => layer.layer === 'province')!,
    state: result.report.layers.find((layer) => layer.layer === 'state')!,
  };
}
