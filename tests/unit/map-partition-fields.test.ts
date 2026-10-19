import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  PARTITION_TERRAIN,
  assertPartitionFields,
  chamferDistance,
  defaultTerrainClassTable,
  partitionFieldsFromBitmaps,
  ridgeField,
  slopeField,
  type PartitionFields,
} from '../../src/hoi4_agent_tools/map/partition-fields.js';
import { partitionFieldsFromGeography } from '../../src/hoi4_agent_tools/map/partition-geography.js';
import {
  PARTITION_DEFAULTS,
  resolvePartitionTuning,
} from '../../src/hoi4_agent_tools/map/partition-tuning.js';
import { geographyModelSchema } from '../../src/hoi4_agent_tools/schemas/geography.js';

const W = 64;
const H = 48;

function land(): Uint8Array {
  return new Uint8Array(W * H).fill(1);
}

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

describe('partition fields from bitmaps', () => {
  it('measures the distance to the nearest river with a wrap across the seam', () => {
    const source = new Set([24 * W + 0]);
    const distance = chamferDistance((p) => source.has(p), W, H);
    expect(distance[24 * W]).toBe(0);
    expect(distance[24 * W + 5]).toBe(5);
    expect(distance[24 * W + (W - 2)]).toBe(2);
    expect(distance[19 * W]).toBe(5);
    // Three diagonal steps are about four pixels in the three-four chamfer.
    expect(distance[21 * W + 3]).toBeGreaterThanOrEqual(4);
    expect(distance[21 * W + 3]).toBeLessThanOrEqual(5);
    expect(chamferDistance(() => false, W, H).every((v) => v === 255)).toBe(true);
  });

  it('reads slope as the central gradient times sixteen and ignores the step down to water', () => {
    const kind = land();
    const heights = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) heights[y * W + x] = 100 + 3 * (x % 32);
    for (let y = 0; y < H; y++) kind[y * W + 40] = 0;
    const slope = slopeField(heights, kind, W, H);
    // A ramp of 3 per pixel is a gradient of 3, which is 48.
    expect(slope[10 * W + 10]).toBe(48);
    // The land pixel next to the water has no neighbour on that side: its slope is half.
    expect(slope[10 * W + 39]).toBeLessThan(48);
    // Water pixels carry no slope.
    expect(slope[10 * W + 40]).toBe(0);
    // A flat plain has none.
    expect(slopeField(new Uint8Array(W * H).fill(100), kind, W, H).every((v) => v === 0)).toBe(
      true,
    );
  });

  it('finds a crest and nothing on flat ground or on a coast', () => {
    const kind = land();
    const heights = new Uint8Array(W * H).fill(100);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) heights[y * W + x] = 100 + Math.max(0, 12 - Math.abs(x - 30) * 2);
    const ridge = ridgeField(heights, kind, W, H);
    expect(ridge[20 * W + 30]).toBe(60);
    expect(ridge[20 * W + 10]).toBe(0);
    for (let y = 0; y < H; y++) for (let x = 50; x < W; x++) kind[y * W + x] = 0;
    // The edge of the land above the water is not a ridge.
    const coast = ridgeField(new Uint8Array(W * H).fill(100), kind, W, H);
    expect(coast.every((v) => v === 0)).toBe(true);
  });

  it('builds every plane from the bitmaps a map has and defaults the ones it lacks', () => {
    const kind = land();
    for (let x = 0; x < W; x++) kind[x] = 0;
    const plain = partitionFieldsFromBitmaps({ width: W, height: H, kind });
    expect(plain.riverDistance.every((v) => v === 255)).toBe(true);
    expect(plain.slope.every((v) => v === 0)).toBe(true);
    expect(plain.terrainClass[0]).toBe(PARTITION_TERRAIN.water);
    expect(plain.terrainClass[W + 1]).toBe(PARTITION_TERRAIN.plains);
    expect(() => assertPartitionFields(plain)).not.toThrow();

    const rivers = new Uint8Array(W * H).fill(255);
    for (let y = 1; y < H; y++) rivers[y * W + 20] = 4;
    // 254 and 255 are not river indices.
    rivers[5 * W + 40] = 254;
    const terrain = new Uint8Array(W * H).fill(6);
    terrain[10 * W + 50] = 5;
    const fields = partitionFieldsFromBitmaps({ width: W, height: H, kind, rivers, terrain });
    expect(fields.riverDistance[10 * W + 20]).toBe(0);
    expect(fields.riverDistance[10 * W + 23]).toBe(3);
    expect(fields.riverDistance[5 * W + 40]).toBeGreaterThan(10);
    expect(fields.terrainClass[10 * W + 10]).toBe(PARTITION_TERRAIN.mountain);
    expect(fields.terrainClass[10 * W + 50]).toBe(PARTITION_TERRAIN.farmland);
    // The valley is richer than the mountain, and farmland richer than both.
    expect(fields.fertility[10 * W + 21]).toBeGreaterThan(fields.fertility[10 * W + 10]!);
    expect(fields.fertility[10 * W + 50]).toBeGreaterThan(fields.fertility[10 * W + 21]!);
    // A custom class table replaces the default.
    const table = defaultTerrainClassTable();
    table[6] = PARTITION_TERRAIN.desert;
    const custom = partitionFieldsFromBitmaps({
      width: W,
      height: H,
      kind,
      terrain,
      terrainClasses: table,
    });
    expect(custom.terrainClass[10 * W + 10]).toBe(PARTITION_TERRAIN.desert);
  });
});

describe('partition fields validation', () => {
  function base(): PartitionFields {
    return partitionFieldsFromBitmaps({ width: W, height: H, kind: land() });
  }

  it('refuses planes of the wrong size, kind or type', () => {
    expectCode(
      () => assertPartitionFields({ ...base(), slope: new Uint8Array(10) }),
      'MAP_PARTITION_FIELDS_INVALID',
    );
    expectCode(
      () => assertPartitionFields({ ...base(), regionId: new Uint8Array(W * H) as never }),
      'MAP_PARTITION_FIELDS_INVALID',
    );
    const kind = land();
    kind[7] = 3;
    expectCode(() => assertPartitionFields({ ...base(), kind }), 'MAP_PARTITION_FIELDS_INVALID');
    expectCode(
      () => assertPartitionFields({ ...base(), width: 8, height: 8 }),
      'MAP_PARTITION_FIELDS_INVALID',
    );
    expectCode(
      () => assertPartitionFields({ ...base(), width: 4_096, height: 4_096 }),
      'MAP_PARTITION_FIELDS_INVALID',
    );
  });

  it('refuses a region plane that disagrees with its table', () => {
    const fields = base();
    const regionId = new Uint16Array(W * H);
    regionId[100] = 3;
    expectCode(
      () =>
        assertPartitionFields({
          ...fields,
          regionId,
          regions: [{ id: 1, kind: 'land' }],
        }),
      'MAP_PARTITION_FIELDS_INVALID',
    );
    for (const regions of [
      [
        { id: 1, kind: 'land' as const },
        { id: 1, kind: 'sea' as const },
      ],
      [{ id: 0, kind: 'land' as const }],
      [{ id: 1, kind: 'land' as const, provinceAreaPx: 5 }],
      [{ id: 1, kind: 'land' as const, provincesPerState: [6, 4, 9] as const }],
    ])
      expectCode(
        () => assertPartitionFields({ ...fields, regions }),
        'MAP_PARTITION_FIELDS_INVALID',
      );
    expect(() =>
      assertPartitionFields({
        ...fields,
        regionId,
        regions: [{ id: 3, kind: 'land', provinceAreaPx: 90, provincesPerState: [4, 6, 9] }],
      }),
    ).not.toThrow();
  });
});

describe('partition tuning', () => {
  const base = {
    width: 2_048,
    height: 1_024,
    landProvincePixels: 400,
    seaProvincePixels: 2_500,
    provincesPerState: 6,
    landProvincesPerRegion: 25,
    seaProvincesPerRegion: 10,
  };

  it('derives the bands from the request and keeps them ordered', () => {
    const tuning = resolvePartitionTuning(undefined, base);
    expect(tuning.landArea.fertile).toBe(Math.round(400 * PARTITION_DEFAULTS.fertile));
    expect(tuning.landArea.fertile).toBeLessThanOrEqual(tuning.landArea.plains);
    expect(tuning.landArea.plains).toBeLessThanOrEqual(tuning.landArea.hills);
    expect(tuning.landArea.hills).toBeLessThanOrEqual(tuning.landArea.mountain);
    expect(tuning.seaArea.coastal).toBeLessThan(tuning.seaArea.open);
    expect(tuning.states).toEqual({ min: 3, target: 6, max: 11 });
    expect(tuning.regions.target).toBe(25);
    expect(tuning.normalizeLand).toBe(true);
    expect(tuning.normalizeSea).toBe(true);
    // Provinces stay inside an eighth of the map.
    expect(tuning.maxProvincePixels).toBe(73 ** 2);
  });

  it('takes explicit bands as written, without scaling them', () => {
    const tuning = resolvePartitionTuning(
      {
        landArea: { fertile: 90, hills: 300, mountain: 700, waste: 1_000 },
        seaArea: { coastal: 800, open: 5_000 },
        provincesPerState: [6, 12],
        regionSize: [20, 45],
        barrierStrength: 30,
        minProvincePixels: 50,
        narrowStraitPx: 16,
      },
      base,
    );
    expect(tuning.landArea).toMatchObject({ fertile: 90, hills: 300, mountain: 700, waste: 1_000 });
    expect(tuning.seaArea).toEqual({ coastal: 800, open: 5_000 });
    expect(tuning.states).toEqual({ min: 6, target: 8, max: 12 });
    expect(tuning.regions).toMatchObject({ min: 20, max: 45 });
    expect(tuning.normalizeLand).toBe(false);
    expect(tuning.normalizeSea).toBe(false);
    expect(tuning.barrierStrength).toBe(30);
    expect(tuning.narrowStraitPx).toBe(16);
  });

  it('refuses contradictory size bands, a map too small for the minimum, and bad strengths', () => {
    expectCode(
      () => resolvePartitionTuning({ landArea: { fertile: 900, hills: 300 } }, base),
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
    );
    expectCode(
      () => resolvePartitionTuning({ landArea: { hills: 500, mountain: 400 } }, base),
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
    );
    expectCode(
      () => resolvePartitionTuning({ landArea: { fertile: 30 }, minProvincePixels: 60 }, base),
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
    );
    expectCode(
      () => resolvePartitionTuning({ seaArea: { coastal: 5_000, open: 1_000 } }, base),
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
    );
    expectCode(
      () => resolvePartitionTuning({ provincesPerState: [9, 3] }, base),
      'MAP_PARTITION_STATE_SIZE_CONTRADICTORY',
    );
    expectCode(
      () => resolvePartitionTuning({ regionSize: [40, 10] }, base),
      'MAP_PARTITION_REGION_SIZE_CONTRADICTORY',
    );
    expectCode(
      () =>
        resolvePartitionTuning({ minProvincePixels: 400 }, { ...base, width: 256, height: 256 }),
      'MAP_PARTITION_MAP_TOO_SMALL',
    );
    expectCode(
      () => resolvePartitionTuning({ barrierStrength: 90 }, base),
      'MAP_PARTITION_STRENGTH_INVALID',
    );
    expectCode(
      () => resolvePartitionTuning({ narrowStraitPx: 2 }, base),
      'MAP_PARTITION_STRENGTH_INVALID',
    );
  });
});

describe('partition fields from the geography model', () => {
  const frame = { width: 512, height: 256 };
  function resolved() {
    const model = geographyModelSchema.parse({
      version: 1,
      seas: [
        {
          id: 'outer_sea',
          name: 'Outer Sea',
          polygons: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      ],
      lands: [
        {
          id: 'main',
          polygons: [
            [
              [0.1, 0.2],
              [0.9, 0.2],
              [0.9, 0.8],
              [0.1, 0.8],
            ],
          ],
        },
      ],
      regions: [
        {
          id: 'west',
          name: 'West',
          polygons: [
            [
              [0, 0],
              [0.5, 0],
              [0.5, 1],
              [0, 1],
            ],
          ],
          density: { provinceAreaPx: 90, provincesPerState: [3, 5, 8] },
        },
        {
          id: 'east',
          name: 'East',
          polygons: [
            [
              [0.5, 0],
              [1, 0],
              [1, 1],
              [0.5, 1],
            ],
          ],
        },
        { id: 'unplaced' },
      ],
      ranges: [
        {
          id: 'wall',
          path: [
            [0.3, 0.1],
            [0.3, 0.9],
          ],
          halfWidth: 0.01,
          profile: 'wall',
          barrier: 'impassable',
        },
        {
          id: 'soft',
          path: [
            [0.7, 0.1],
            [0.7, 0.9],
          ],
          halfWidth: 0.01,
        },
      ],
    });
    return resolveGeography(model, { frame, edge: { mode: 'none' } }).geography;
  }

  it('writes the regions, the named sea and the wall onto the planes', () => {
    const kind = new Uint8Array(512 * 256);
    for (let y = 51; y < 205; y++) for (let x = 52; x < 460; x++) kind[y * 512 + x] = 1;
    const fields = partitionFieldsFromBitmaps({ width: 512, height: 256, kind });
    const next = partitionFieldsFromGeography(fields, resolved());
    expect(() => assertPartitionFields(next)).not.toThrow();
    const ids = new Map((next.regions ?? []).map((region) => [region.name, region]));
    const west = ids.get('West')!;
    const east = ids.get('East')!;
    const sea = ids.get('Outer Sea')!;
    expect(west).toMatchObject({ kind: 'land', provinceAreaPx: 90, provincesPerState: [3, 5, 8] });
    expect(sea.kind).toBe('sea');
    // Land pixels get the land regions, sea pixels the sea, nothing is mixed.
    expect(next.regionId[100 * 512 + 100]).toBe(west.id);
    expect(next.regionId[100 * 512 + 400]).toBe(east.id);
    expect(next.regionId[10 * 512 + 10]).toBe(sea.id);
    // The wall is a barrier line three pixels thick; the soft range is not drawn.
    const wallX = Math.round(0.3 * 512);
    expect(next.barrier[100 * 512 + wallX]).toBe(255);
    expect(next.barrier[100 * 512 + wallX - 1]).toBe(255);
    expect(next.barrier[100 * 512 + Math.round(0.7 * 512)]).toBe(0);
    // The input planes are not modified.
    expect(fields.regionId.every((value) => value === 0)).toBe(true);
    expect(fields.barrier.every((value) => value === 0)).toBe(true);
  });
});
