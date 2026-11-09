import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  areaRowFactor,
  resolvePartitionTuning,
} from '../../src/hoi4_agent_tools/map/partition-tuning.js';
import {
  generateWorld,
  type WorldNote,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { plainContext, syntheticRaster, worldSpec } from '../helpers/map-appearance-world.js';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const BASE = {
  width: 512,
  height: 256,
  landProvincePixels: 120,
  seaProvincePixels: 800,
  provincesPerState: 5,
  landProvincesPerRegion: 20,
  seaProvincesPerRegion: 10,
};
// ZIN's request of 9 November 2026 (owner decision K116): about three times larger provinces at
// the top edge, as now from the middle south.
const ZIN = [
  [0, 3],
  [0.3, 1.6],
  [0.45, 1],
  [1, 1],
] as const;

describe('partitionTuning.areaByRow', () => {
  it('interpolates between its points and holds beyond the ends', () => {
    expect(areaRowFactor(undefined, 10, 100)).toBe(1);
    expect(areaRowFactor(ZIN, 0, 1000)).toBeCloseTo(2.999, 2);
    expect(areaRowFactor(ZIN, 150 - 0.5, 1000)).toBeCloseTo(2.3, 5);
    expect(areaRowFactor(ZIN, 375 - 0.5, 1000)).toBeCloseTo(1.3, 5);
    expect(areaRowFactor(ZIN, 800, 1000)).toBe(1);
    expect(areaRowFactor([[0.5, 2]], 0, 100)).toBe(2);
    expect(areaRowFactor([[0.5, 2]], 99, 100)).toBe(2);
  });

  it('refuses rows out of order or range and factors out of range', () => {
    for (const areaByRow of [
      [],
      [
        [0.5, 2],
        [0.4, 1],
      ],
      [
        [0.5, 2],
        [0.5, 1],
      ],
      [[1.2, 2]],
      [[0.5, 0.1]],
      [[0.5, 9]],
    ] as Array<Array<[number, number]>>)
      expect(() => resolvePartitionTuning({ areaByRow }, BASE), JSON.stringify(areaByRow)).toThrow(
        expect.objectContaining({ code: 'MAP_PARTITION_AREA_BY_ROW_INVALID' }),
      );
    expect(resolvePartitionTuning({ areaByRow: ZIN }, BASE).areaByRow).toEqual(ZIN);
    expect(resolvePartitionTuning({}, BASE).areaByRow).toBeUndefined();
  });

  it('accepts only [row, factor] points in the schema', () => {
    const parse = (areaByRow: unknown) =>
      mapOperationSchema.safeParse({
        kind: 'create_world',
        id: 'w',
        partition: 'feature-aware',
        partitionTuning: { areaByRow },
      }).success;
    expect(parse(ZIN)).toBe(true);
    expect(parse([])).toBe(false);
    expect(parse([[0.5]])).toBe(false);
    expect(parse([[0.5, 10]])).toBe(false);
    expect(parse([[-0.1, 1]])).toBe(false);
  });
});

describe('create_world with areaByRow', () => {
  // Land from near the top edge to near the bottom, all one ground, so only the row changes the size.
  const surface = syntheticRaster(512, 256, {
    at: (x, y) => (x >= 24 && x < 488 && y >= 6 && y < 250 ? 1 : 0),
  });
  const spec = (areaByRow?: ReadonlyArray<readonly [number, number]>): WorldSpec =>
    worldSpec(surface, {
      landProvincePixels: 120,
      seaProvincePixels: 800,
      partition: {
        mode: 'feature-aware',
        ...(areaByRow === undefined ? {} : { tuning: { areaByRow } }),
      },
    });
  const bands = (note: WorldNote) =>
    (
      note.details as {
        bands: Array<{
          rows: [number, number];
          landProvinces: number;
          meanAreaPx: number;
          ratio?: number;
        }>;
      }
    ).bands;

  it('makes northern provinces larger and leaves the south as it was', () => {
    const plain = generateWorld(spec(), plainContext);
    const scaled = generateWorld(spec(ZIN), plainContext);
    expect(plain.notes.some(({ code }) => code === 'MAP_PARTITION_AREA_BY_ROW')).toBe(false);
    const note = scaled.notes.find(({ code }) => code === 'MAP_PARTITION_AREA_BY_ROW')!;
    const [north, middle, south] = bands(note);
    expect(north!.rows).toEqual([0, 0.3]);
    expect(south!.rows).toEqual([0.45, 1]);
    // The north band's mean factor is about 2.3; the realised ratio should be near it.
    expect(north!.ratio!).toBeGreaterThan(1.7);
    expect(middle!.ratio!).toBeGreaterThan(1.1);
    expect(south!.ratio).toBe(1);
    expect(scaled.summary.landProvinces).toBeLessThan(plain.summary.landProvinces);
    // The south keeps its province size: the same band of the plain world.
    const plainSouth = bands(
      generateWorld(spec([[0, 1]]), plainContext).notes.find(
        ({ code }) => code === 'MAP_PARTITION_AREA_BY_ROW',
      )!,
    )[0]!;
    const plainMean = plainSouth.meanAreaPx;
    expect(Math.abs(south!.meanAreaPx - plainMean)).toBeLessThan(0.2 * plainMean);
  });

  it('writes the same files as before with a factor of 1 everywhere', () => {
    const plain = generateWorld(spec(), plainContext);
    const ones = generateWorld(spec([[0, 1]]), plainContext);
    expect(ones.files.map((file) => sha(file.content))).toEqual(
      plain.files.map((file) => sha(file.content)),
    );
  });
});
