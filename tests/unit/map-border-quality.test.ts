import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  BORDER_PROVINCE_KIND,
  BORDER_QUALITY_TARGETS,
  borderPlaneFromBytes,
  borderQualityDiagnostics,
  buildBorderEdgeTable,
  checkBorderTargets,
  measureBorderNaturalness,
  scoreBorderAssignment,
  type BorderLayerInput,
  type BorderQualityInput,
} from '../../src/hoi4_agent_tools/map/border-quality.js';

const LAND = BORDER_PROVINCE_KIND.land;

interface World {
  width: number;
  height: number;
  provinceAt: (x: number, y: number) => number;
  kinds?: Record<number, number>;
  rivers?: (x: number, y: number) => boolean;
  heights?: (x: number, y: number) => number;
  terrain?: { at: (x: number, y: number) => number; classes?: Record<number, number> };
  layers?: (kinds: Uint8Array) => BorderLayerInput[];
}

function build(world: World): BorderQualityInput {
  const { width, height } = world;
  const provinceIds = new Int32Array(width * height);
  let highest = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const id = world.provinceAt(x, y);
      provinceIds[y * width + x] = id;
      highest = Math.max(highest, id);
    }
  const kinds = new Uint8Array(highest + 1);
  for (let id = 1; id <= highest; id += 1) kinds[id] = world.kinds?.[id] ?? LAND;
  const plane = (value: (x: number, y: number) => number) => {
    const bytes = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) bytes[y * width + x] = value(x, y);
    return borderPlaneFromBytes(width, height, bytes);
  };
  const classes = new Uint8Array(256);
  for (const [index, value] of Object.entries(world.terrain?.classes ?? { 1: 1 }))
    classes[Number(index)] = value;
  const labels = new Int32Array(kinds.length);
  for (let id = 0; id < kinds.length; id += 1) labels[id] = id;
  return {
    width,
    height,
    provinceIds,
    provinceKinds: kinds,
    layers: world.layers?.(kinds) ?? [{ name: 'province', labels }],
    features: {
      ...(world.rivers === undefined
        ? {}
        : { rivers: plane((x, y) => (world.rivers!(x, y) ? 3 : 255)) }),
      ...(world.heights === undefined ? {} : { heights: plane(world.heights) }),
      ...(world.terrain === undefined
        ? {}
        : { terrain: { plane: plane(world.terrain.at), classes } }),
    },
  };
}

const SEA = 9;
const SEA_KINDS = { [SEA]: BORDER_PROVINCE_KIND.sea };
/** Open sea along both edges, so the east-west seam never joins two provinces of land. */
const isSeaStrip = (x: number, width: number): boolean => x < 4 || x >= width - 4;

const meanderX = (y: number): number => 90 + Math.round(7 * Math.sin(y / 10));
/** Three rivers: a meander near x = 90 and two straight ones far from the test borders. */
function isRiver(x: number, y: number): boolean {
  return x === meanderX(y) || x === 30 || x === 225;
}

describe('border naturalness metric', () => {
  it('measures a border drawn along a river as natural and a straight one as artificial', async () => {
    const followed = await measureBorderNaturalness(
      build({
        width: 256,
        height: 128,
        provinceAt: (x, y) => (isSeaStrip(x, 256) ? SEA : x <= meanderX(y) ? 1 : 2),
        kinds: SEA_KINDS,
        rivers: isRiver,
      }),
    );
    const straight = await measureBorderNaturalness(
      build({
        width: 256,
        height: 128,
        provinceAt: (x) => (isSeaStrip(x, 256) ? SEA : x < 150 ? 1 : 2),
        kinds: SEA_KINDS,
        rivers: isRiver,
      }),
    );
    const river = followed.report.layers[0]!;
    const ruler = straight.report.layers[0]!;
    expect(river.status).toBe('ok');
    expect(ruler.status).toBe('ok');
    // The chance baseline is the same river set, a few percent of the land.
    expect(river.barrier.baseRate).toBeGreaterThan(0.03);
    expect(river.barrier.baseRate).toBe(ruler.barrier.baseRate);
    expect(river.barrier.alignment).toBeGreaterThan(0.95);
    expect(river.barrier.enrichment!).toBeGreaterThan(10);
    expect(river.natural.share).toBeGreaterThan(0.95);
    expect(river.natural.byFeature.river).toBeGreaterThan(0.95);
    expect(ruler.barrier.alignment).toBe(0);
    expect(ruler.barrier.enrichment).toBe(0);
    expect(ruler.natural.share).toBe(0);
    // Straightness: the meander is never locally straight, the ruler line always is.
    expect(river.straightness.fraction!).toBeLessThan(0.1);
    expect(ruler.straightness.fraction).toBe(1);
    // Long runs and the worst artificial runs.
    expect(river.longRuns.share!).toBeLessThan(0.1);
    expect(river.worstRuns).toEqual([]);
    expect(ruler.longRuns.share!).toBeGreaterThan(0.95);
    expect(ruler.artificialRuns.count).toBe(1);
    expect(ruler.worstRuns).toHaveLength(1);
    expect(ruler.worstRuns[0]).toMatchObject({
      sides: ['1', '2'],
      labels: [1, 2],
      edges: 128,
      from: { x: 150, y: 0 },
      to: { x: 150, y: 128 },
      straightRatio: 1,
      naturalShare: 0,
    });
    // The plan's targets: the river-following border passes enrichment, the ruler line fails.
    expect(checkBorderTargets(river, BORDER_QUALITY_TARGETS).failures.map((f) => f.metric)).toEqual(
      [],
    );
    expect(checkBorderTargets(ruler, BORDER_QUALITY_TARGETS).failures.map((f) => f.metric)).toEqual(
      ['enrichment', 'straightness'],
    );
    expect(borderQualityDiagnostics(straight.report).map((d) => d.code)).toContain(
      'MAP_BORDER_ARTIFICIAL_REVIEW',
    );
    expect(
      borderQualityDiagnostics(followed.report).filter((d) => d.severity === 'warning'),
    ).toEqual([]);
  });

  it('counts steep slopes, terrain-class changes and lake shores as natural lines', async () => {
    const ramp = (x: number): number => 100 + Math.min(60, Math.max(0, (x - 90) * 4));
    const slope = await measureBorderNaturalness(
      build({
        width: 256,
        height: 128,
        provinceAt: (x) => (isSeaStrip(x, 256) ? SEA : x < 96 ? 1 : x < 200 ? 2 : 3),
        kinds: SEA_KINDS,
        heights: (x) => ramp(x),
      }),
    );
    const layer = slope.report.layers[0]!;
    expect(layer.borderEdges).toBe(256);
    // One of the two borders (x = 96) lies on the ramp, the other (x = 200) on flat ground.
    expect(layer.barrier.alignment).toBe(0.5);
    expect(layer.natural.byFeature.slope).toBe(0.5);
    expect(layer.barrier.enrichment!).toBeGreaterThan(4);

    const terrain = await measureBorderNaturalness(
      build({
        width: 256,
        height: 128,
        provinceAt: (x) => (isSeaStrip(x, 256) ? SEA : x < 128 ? 1 : 2),
        kinds: SEA_KINDS,
        terrain: { at: (x) => (x < 128 ? 1 : 0) },
      }),
    );
    const change = terrain.report.layers[0]!;
    expect(change.natural.share).toBe(1);
    expect(change.natural.byFeature.terrainChange).toBe(1);
    // The plan's barrier set does not include terrain classes.
    expect(change.barrier.alignment).toBe(0);

    const lake = await measureBorderNaturalness(
      build({
        width: 128,
        height: 64,
        provinceAt: (x) => (isSeaStrip(x, 128) ? SEA : x < 60 ? 1 : x < 64 ? 4 : x < 65 ? 2 : 3),
        kinds: { 4: BORDER_PROVINCE_KIND.lake, ...SEA_KINDS },
      }),
    );
    const shore = lake.report.layers[0]!;
    // Only the 2|3 border touches the lake shore; 1|3 does not exist (the lake is between).
    expect(shore.natural.byFeature.lakeShore).toBe(1);
    expect(shore.coastEdges).toBeGreaterThan(0);
  });

  it('counts the seam as a border and the coast apart from land borders', async () => {
    const result = await measureBorderNaturalness(
      build({
        width: 64,
        height: 32,
        provinceAt: (x) => (x < 32 ? 1 : 2),
      }),
    );
    // x = 31|32 and the wrap x = 63|0.
    expect(result.report.layers[0]!.borderEdges).toBe(64);

    const coast = await measureBorderNaturalness(
      build({
        width: 64,
        height: 32,
        provinceAt: (x) => (x < 20 ? 1 : x < 40 ? 2 : 3),
        kinds: { 3: BORDER_PROVINCE_KIND.sea },
      }),
    );
    const layer = coast.report.layers[0]!;
    // Land borders: 1|2 once; the land-sea edges (2|3 at x = 39|40 and the wrap 3|1) are coast.
    expect(layer.borderEdges).toBe(32);
    expect(layer.coastEdges).toBe(64);
    expect(layer.natural.shareWithCoast).toBeCloseTo(64 / 96, 3);
  });

  it('reports a map without natural features as not meaningful and a single province as no borders', async () => {
    const bare = await measureBorderNaturalness(
      build({ width: 128, height: 64, provinceAt: (x) => (x < 64 ? 1 : 2) }),
    );
    const layer = bare.report.layers[0]!;
    expect(layer.status).toBe('not-meaningful');
    expect(layer.barrier.enrichment).toBeNull();
    expect(layer.natural.share).toBe(0);
    // Province borders are too short for a straightness target, and enrichment cannot be judged.
    expect(borderQualityDiagnostics(bare.report).map((d) => d.code)).toEqual([
      'MAP_BORDER_INPUT_MISSING',
      'MAP_BORDER_NOT_MEANINGFUL',
    ]);

    const single = await measureBorderNaturalness(
      build({ width: 64, height: 64, provinceAt: () => 1, rivers: (x) => x === 10 }),
    );
    const only = single.report.layers[0]!;
    expect(only.status).toBe('no-borders');
    expect(only.borderEdges).toBe(0);
    expect(only.straightness.fraction).toBeNull();
    expect(only.barrier.alignment).toBeNull();
    expect(only.worstRuns).toEqual([]);
    expect(borderQualityDiagnostics(single.report).map((d) => d.code)).not.toContain(
      'MAP_BORDER_ARTIFICIAL_REVIEW',
    );
  });

  it('scores groupings of provinces, such as states and countries, from the same raster', async () => {
    const cell = 32;
    const provinceAt = (x: number, y: number): number =>
      1 + Math.floor(x / cell) + 4 * Math.floor(y / cell);
    const groupings: BorderLayerInput[] = [];
    const input = build({
      width: 128,
      height: 64,
      provinceAt,
      rivers: (x) => x === 64 || x === 20 || x === 100 || x === 0,
      layers: (kinds) => {
        const columns = new Int32Array(kinds.length).fill(-1);
        const rows = new Int32Array(kinds.length).fill(-1);
        const provinces = new Int32Array(kinds.length);
        for (let id = 1; id < kinds.length; id += 1) {
          columns[id] = id - 1 < 8 ? ((id - 1) % 4 < 2 ? 0 : 1) : 0;
          rows[id] = id - 1 < 4 ? 0 : 1;
          provinces[id] = id;
        }
        groupings.push(
          { name: 'province', labels: provinces },
          { name: 'west-east', labels: columns, describe: (label) => (label === 0 ? 'W' : 'E') },
          { name: 'north-south', labels: rows },
        );
        return groupings;
      },
    });
    const { report, table } = await measureBorderNaturalness(input);
    const westEast = report.layers.find(({ layer }) => layer === 'west-east')!;
    const northSouth = report.layers.find(({ layer }) => layer === 'north-south')!;
    // The west-east border (x = 64) lies on the river; the north-south one (y = 32) crosses it.
    expect(westEast.barrier.alignment).toBe(1);
    expect(northSouth.barrier.alignment!).toBeLessThan(0.2);
    expect(westEast.worstRuns).toEqual([]);
    expect(northSouth.worstRuns[0]!.sides).toEqual(['0', '1']);
    // The quick score for a candidate grouping agrees with the full report.
    const quick = scoreBorderAssignment(table, groupings[1]!.labels);
    expect(quick.borderEdges).toBe(westEast.borderEdges);
    expect(quick.alignment).toBe(westEast.barrier.alignment);
    expect(quick.enrichment).toBe(westEast.barrier.enrichment);
    expect(quick.naturalShare).toBe(westEast.natural.share);
    const worse = scoreBorderAssignment(table, groupings[2]!.labels);
    expect(worse.alignment!).toBeLessThan(quick.alignment!);
    // Excluding a province (negative label) drops its borders and counts them as unlabelled.
    const partial = Int32Array.from(groupings[1]!.labels);
    partial[1] = -1;
    const excluded = scoreBorderAssignment(table, partial);
    expect(excluded.unlabelledEdges).toBeGreaterThan(0);
    expect(excluded.borderEdges).toBeLessThan(quick.borderEdges);
  });

  it('is deterministic and independent of cooperative yielding', async () => {
    const world = (): BorderQualityInput =>
      build({
        width: 256,
        height: 128,
        provinceAt: (x, y) => (x <= meanderX(y) ? 1 : x < 170 ? 2 : 3),
        rivers: isRiver,
        heights: (x, y) => 100 + ((x * 7 + y * 3) % 5),
      });
    const first = await measureBorderNaturalness(world());
    const second = await measureBorderNaturalness(world(), { collectPaint: true });
    expect(canonicalJson(second.report)).toBe(canonicalJson(first.report));
    expect(second.paint?.get('province')).toBeDefined();
  });

  it('rejects malformed input and refuses to exceed the edge budget', async () => {
    const base = build({ width: 64, height: 32, provinceAt: (x) => (x < 32 ? 1 : 2) });
    await expect(
      measureBorderNaturalness({ ...base, provinceIds: new Int32Array(10) }),
    ).rejects.toMatchObject({ code: 'MAP_BORDER_QUALITY_INPUT_INVALID' });
    await expect(
      measureBorderNaturalness({
        ...base,
        layers: [{ name: 'province', labels: new Int32Array(1) }],
      }),
    ).rejects.toMatchObject({ code: 'MAP_BORDER_QUALITY_INPUT_INVALID' });
    await expect(
      measureBorderNaturalness({
        ...base,
        layers: [base.layers[0]!, base.layers[0]!],
      }),
    ).rejects.toMatchObject({ code: 'MAP_BORDER_QUALITY_INPUT_INVALID' });
    await expect(
      measureBorderNaturalness({
        ...base,
        features: { rivers: borderPlaneFromBytes(8, 8, new Uint8Array(64)) },
      }),
    ).rejects.toMatchObject({ code: 'MAP_BORDER_QUALITY_INPUT_INVALID' });
    await expect(
      measureBorderNaturalness({
        ...base,
        features: {
          terrain: {
            plane: borderPlaneFromBytes(64, 32, new Uint8Array(64 * 32)),
            classes: new Uint8Array(4),
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'MAP_BORDER_QUALITY_INPUT_INVALID' });
    expect(() => borderPlaneFromBytes(4, 4, new Uint8Array(3))).toThrow(/does not match/u);
    await expect(measureBorderNaturalness(base, { sampleStride: 0 })).rejects.toMatchObject({
      code: 'MAP_BORDER_QUALITY_OPTION_INVALID',
    });
    await expect(measureBorderNaturalness(base, { straightRmsPx: -1 })).rejects.toMatchObject({
      code: 'MAP_BORDER_QUALITY_OPTION_INVALID',
    });
    await expect(measureBorderNaturalness(base, { worstRunLimit: 101 })).rejects.toMatchObject({
      code: 'MAP_BORDER_QUALITY_OPTION_INVALID',
    });
    // An adversarial map made of single-pixel provinces cannot grow the edge table without bound.
    const checker = build({ width: 64, height: 64, provinceAt: (x, y) => 1 + ((x + y) % 2) });
    await expect(buildBorderEdgeTable(checker, { maxEdges: 1_000 })).rejects.toMatchObject({
      code: 'MAP_BORDER_QUALITY_BUDGET_EXCEEDED',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      measureBorderNaturalness(base, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stays bounded on a map of the engine pixel limit', async () => {
    // 4096 x 3232 is exactly the engine's 13,238,272 pixel ceiling. Provinces are jittered
    // rectangles; a river and a height ridge give the features something to find.
    const width = 4096;
    const height = 3232;
    const provinceIds = new Int32Array(width * height);
    const columns = Math.ceil(width / 40);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const column = Math.floor((x + ((y >> 5) % 3) * 9) / 40);
        provinceIds[y * width + x] = 1 + column + columns * Math.floor(y / 32);
      }
    const highest = 1 + columns + columns * Math.floor((height - 1) / 32);
    const kinds = new Uint8Array(highest + 1).fill(LAND);
    kinds[0] = 0;
    const labels = new Int32Array(kinds.length);
    const stateLabels = new Int32Array(kinds.length);
    for (let id = 0; id < kinds.length; id += 1) {
      labels[id] = id;
      stateLabels[id] = Math.floor(id / 48);
    }
    const heights = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        heights[y * width + x] = 100 + (Math.abs(x - 2000) < 30 ? Math.abs(x - 2000) * 3 : 0);
    const before = process.memoryUsage();
    const started = Date.now();
    const { report, table } = await measureBorderNaturalness({
      width,
      height,
      provinceIds,
      provinceKinds: kinds,
      layers: [
        { name: 'province', labels },
        { name: 'state', labels: stateLabels },
      ],
      features: { heights: borderPlaneFromBytes(width, height, heights) },
    });
    const after = process.memoryUsage();
    expect(table.landPixels).toBe(width * height);
    expect(report.layers.map(({ layer }) => layer)).toEqual(['province', 'state']);
    expect(report.layers[0]!.borderEdges).toBeGreaterThan(300_000);
    expect(report.layers[0]!.barrier.alignment).toBeGreaterThan(0);
    // Streamed strips: well under the cost of copying every plane (a few hundred MiB of arrays).
    expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(700 * 1_048_576);
    expect(Date.now() - started).toBeLessThan(120_000);
  }, 180_000);
});

describe('border naturalness runs and edge cases', () => {
  it('reports the longest artificial runs first, bounded by the limit', async () => {
    // Province 2 sits above province 3 and both sit beside province 1: several borders of
    // different lengths.
    const bands = build({
      width: 256,
      height: 96,
      provinceAt: (x, y) => {
        if (isSeaStrip(x, 256)) return SEA;
        if (y < 48) return x < 60 ? 2 : 1;
        return x < 200 ? 3 : 1;
      },
      kinds: SEA_KINDS,
      rivers: (x) => x === 250 || x === 20,
    });
    const full = await measureBorderNaturalness(bands);
    const runs = full.report.layers[0]!.worstRuns;
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.map(({ edges }) => edges)).toEqual(
      [...runs.map(({ edges }) => edges)].sort((a, b) => b - a),
    );
    const limited = await measureBorderNaturalness(bands, { worstRunLimit: 2 });
    expect(limited.report.layers[0]!.worstRuns).toEqual(runs.slice(0, 2));
    expect(limited.report.layers[0]!.artificialRuns).toEqual(full.report.layers[0]!.artificialRuns);
    const none = await measureBorderNaturalness(bands, { worstRunLimit: 0 });
    expect(none.report.layers[0]!.worstRuns).toEqual([]);
    expect(none.report.layers[0]!.artificialRuns.count).toBe(
      full.report.layers[0]!.artificialRuns.count,
    );
  });

  it('bridges a short natural crossing only when the allowed gap is wide enough', async () => {
    // A river along y = 62 crosses the straight border for five edges; one far away adds baseline.
    const withRiver = build({
      width: 256,
      height: 128,
      provinceAt: (x) => (isSeaStrip(x, 256) ? SEA : x < 150 ? 1 : 2),
      kinds: SEA_KINDS,
      rivers: (x, y) => y === 62 || x === 20,
    });
    const split = (await measureBorderNaturalness(withRiver)).report.layers[0]!;
    const bridged = (await measureBorderNaturalness(withRiver, { naturalGapEdges: 10 })).report
      .layers[0]!;
    expect(split.artificialRuns.count).toBe(2);
    expect(bridged.artificialRuns.count).toBe(1);
    expect(bridged.worstRuns[0]!.edges).toBe(128);
    expect(bridged.worstRuns[0]!.naturalShare).toBeGreaterThan(0.03);
    expect(bridged.worstRuns[0]!.naturalShare).toBeLessThan(0.1);
  });

  it('follows a border across the east-west seam as one chain', async () => {
    const loop = await measureBorderNaturalness(
      build({
        width: 64,
        height: 32,
        provinceAt: (_x, y) => (y < 16 ? 1 : 2),
      }),
      { minBorderEdges: 8 },
    );
    const layer = loop.report.layers[0]!;
    // The horizontal border wraps the whole map: one closed chain of 64 edges.
    expect(layer.borderEdges).toBe(64);
    expect(layer.artificialRuns.count).toBe(1);
    expect(layer.worstRuns[0]!.edges).toBe(64);
  });

  it('ignores pixels of unknown provinces and ids beyond the province table', async () => {
    const input = build({
      width: 64,
      height: 32,
      provinceAt: (x) => (x < 16 ? 1 : x < 32 ? 2 : x < 48 ? 0 : 3),
    });
    // Shorten the kind table so province 3 is outside it, and mark one pixel as no province.
    const shorter: BorderQualityInput = {
      ...input,
      provinceKinds: input.provinceKinds.slice(0, 3),
      layers: [{ name: 'province', labels: Int32Array.from([0, 1, 2]) }],
    };
    shorter.provinceIds[5] = -1;
    const result = await measureBorderNaturalness(shorter, { minBorderEdges: 8 });
    // Only 1|2 is a land border; 0 is unknown, 3 is unknown to the table, -1 is no province.
    expect(result.report.layers[0]!.borderEdges).toBe(32);
    expect(result.report.landPixels).toBe(32 * 32 - 1);
  });

  it('uses extra barrier planes alongside heights', async () => {
    const walled = await measureBorderNaturalness({
      ...build({
        width: 128,
        height: 64,
        provinceAt: (x) => (isSeaStrip(x, 128) ? SEA : x < 64 ? 1 : 2),
        kinds: SEA_KINDS,
      }),
      features: {
        extra: borderPlaneFromBytes(
          128,
          64,
          Uint8Array.from({ length: 128 * 64 }, (_, offset) => (offset % 128 === 64 ? 1 : 0)),
        ),
        // Low sea and high land: the coast step does not reach the border far inland.
        heights: borderPlaneFromBytes(
          128,
          64,
          Uint8Array.from({ length: 128 * 64 }, (_, offset) =>
            isSeaStrip(offset % 128, 128) ? 89 : 110,
          ),
        ),
      },
    });
    const layer = walled.report.layers[0]!;
    expect(layer.natural.byFeature.extra).toBe(1);
    expect(layer.barrier.alignment).toBe(1);
  });
});
