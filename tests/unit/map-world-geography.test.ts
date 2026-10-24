import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { BmpImage, createBmp } from '../../src/hoi4_agent_tools/map/bmp.js';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import { unsupportedGeographyParts } from '../../src/hoi4_agent_tools/map/relief/index.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import {
  generateWorld,
  type GeneratedWorld,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { syntheticGeography } from '../helpers/geography-fixture.js';
import {
  appearanceDiagnostics,
  filesOf,
  plainContext,
  syntheticRaster,
} from '../helpers/map-appearance-world.js';
import { reliefGeography } from '../helpers/relief-fixture.js';
import { indexedPixels } from '../helpers/relief-checks.js';

const WIDTH = 1024;
const HEIGHT = 512;

function spec(overrides: Partial<WorldSpec>): WorldSpec {
  const resolution = resolveGeography(reliefGeography(), {
    frame: { width: WIDTH, height: HEIGHT },
    hasReference: false,
  });
  return {
    width: WIDTH,
    height: HEIGHT,
    seed: 7,
    landCoverage: 0.4,
    continents: 1,
    landProvincePixels: 3_000,
    seaProvincePixels: 12_000,
    provincesPerState: 6,
    landProvincesPerRegion: 30,
    seaProvincesPerRegion: 10,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [
      { tag: 'AAA', name: 'Alpha' },
      { tag: 'BBB', name: 'Beta' },
    ],
    geography: resolution.geography,
    colormapProfile: 'calibrated',
    ...overrides,
  };
}

function decoded(world: GeneratedWorld, name: string): BmpImage {
  return BmpImage.decode(filesOf(world).get(`map/${name}`)!);
}

function pixels(world: GeneratedWorld, name: string): Uint8Array {
  return indexedPixels(filesOf(world).get(`map/${name}`)!);
}

describe('a world built from a geography model', () => {
  let world: GeneratedWorld;

  beforeAll(() => {
    world = generateWorld(spec({}), plainContext);
  });

  it('writes the synthesised heights, rivers and normals', () => {
    expect(world.terrain).toBeDefined();
    expect(decoded(world, 'heightmap.bmp').bitsPerPixel).toBe(8);
    expect(
      Buffer.from(pixels(world, 'heightmap.bmp')).equals(Buffer.from(world.terrain!.heights)),
    ).toBe(true);
    expect(pixels(world, 'rivers.bmp').filter((value) => value <= 11).length).toBe(
      world.terrain!.riverStatistics.pixels,
    );
    // The header palette count stays 0, as the engine wants.
    expect(filesOf(world).get('map/rivers.bmp')!.readUInt32LE(46)).toBe(0);
    const normals = decoded(world, 'world_normal.bmp');
    expect(normals.bitsPerPixel).toBe(24);
    expect([normals.width, normals.height]).toEqual([WIDTH / 2, HEIGHT / 2]);
    // The relief reaches the engine's range: high ground exists and the sea stays at 89.
    expect(world.terrain!.relief.maximum).toBeGreaterThan(200);
    expect(world.summary.rivers).toBe(world.terrain!.riverStatistics.count);
  });

  it('reports what it made and passes the appearance validators', () => {
    const note = world.notes.find(({ code }) => code === 'MAP_RELIEF_SYNTHESIZED')!;
    expect(note.severity).toBe('info');
    expect(note.message).toContain('rivers');
    const named = (note.details as { namedRivers: Array<{ id: string; complete: boolean }> })
      .namedRivers;
    expect(named.map(({ id }) => id)).toContain('longwater');
    expect(named.every(({ complete }) => complete)).toBe(true);
    const findings = appearanceDiagnostics(filesOf(world));
    expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(findings.map(({ code }) => code)).not.toContain('MAP_NORMAL_RESPONSE');
    expect(findings.map(({ code }) => code)).not.toContain('MAP_RIVER_BLOCK');
  });

  it('marks permanent snow above a snow line in the terrain bitmap', () => {
    const terrainBitmap = pixels(world, 'terrain.bmp');
    let snow = 0;
    let marked = 0;
    for (let index = 0; index < terrainBitmap.length; index += 1)
      if (world.terrain!.snow[index] === 1) {
        snow += 1;
        if (terrainBitmap[index] === 16) marked += 1;
      }
    expect(snow).toBeGreaterThan(50);
    expect(marked).toBe(snow);
  });

  it('refuses a model resolved for another map size', () => {
    const other = resolveGeography(reliefGeography(), {
      frame: { width: 2048, height: 1024 },
      hasReference: false,
    }).geography;
    expect(() => generateWorld(spec({ geography: other }), plainContext)).toThrow(
      expect.objectContaining({ code: 'MAP_GEOGRAPHY_FRAME_MISMATCH' }) as Error,
    );
  });

  it('clears land from the edge bands and keeps the relief outside them', () => {
    const banded = generateWorld(
      spec({ edge: { mode: 'sea-band', bandPx: 192, polarPx: 32, rimPx: 0 } }),
      plainContext,
    );
    const heights = pixels(banded, 'heightmap.bmp');
    for (let y = 0; y < HEIGHT; y += 1) {
      expect(heights[y * WIDTH]).toBe(89);
      expect(heights[y * WIDTH + 100]!).toBeLessThanOrEqual(93);
    }
    expect(banded.notes.map(({ code }) => code)).toContain('MAP_EDGE_LAND_CLEARED');
    expect(banded.terrain!.relief.maximum).toBeGreaterThan(200);
  });

  it('raises a rim range at the seam and routes the rivers around it', () => {
    const rimmed = generateWorld(
      spec({ edge: { mode: 'rim', bandPx: 0, polarPx: 32, rimPx: 160 } }),
      plainContext,
    );
    const rim = pixels(rimmed, 'heightmap.bmp');
    const plain = pixels(world, 'heightmap.bmp');
    // The fixture's west coast stands near x = 105, inside the rim's foot (it reaches 160 pixels).
    let lifted = 0;
    let compared = 0;
    for (let y = 0; y < HEIGHT; y += 1)
      for (let x = 100; x < 118; x += 1) {
        const index = y * WIDTH + x;
        if (world.terrain!.riverBitmap[index] === 255 && plain[index]! >= 96) {
          compared += 1;
          lifted += rim[index]! - plain[index]!;
        }
      }
    expect(compared).toBeGreaterThan(100);
    expect(lifted / compared).toBeGreaterThan(5);
    // Rivers do not run uphill on the raised ground.
    for (const { pixels: path } of rimmed.terrain!.riverPaths) {
      let level = Infinity;
      for (const pixel of path) {
        expect(rim[pixel]!).toBeLessThanOrEqual(level);
        level = rim[pixel]!;
      }
    }
  });
});

describe('a geography model over a reference picture', () => {
  it('takes the coast and terrain classes from the picture and the relief from the model', () => {
    const land = (x: number, y: number): boolean =>
      x > WIDTH * 0.12 && x < WIDTH * 0.88 && y > HEIGHT * 0.15 && y < HEIGHT * 0.85;
    const raster = syntheticRaster(WIDTH, HEIGHT, {
      at: (x, y) => (land(x, y) ? 1 : 0),
      terrain: () => 0,
    });
    const model = reliefGeography();
    delete model.rivers;
    delete model.lakes;
    const geography = resolveGeography(model, {
      frame: { width: WIDTH, height: HEIGHT },
      hasReference: true,
    }).geography;
    const world = generateWorld(
      spec({ geography, referenceSurface: raster, rivers: 0 }),
      plainContext,
    );
    expect(world.terrain).toBeDefined();
    const heights = pixels(world, 'heightmap.bmp');
    // The coast is the picture's: a pixel inside it is land, one outside is sea.
    expect(
      heights[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH * 0.2)]!,
    ).toBeGreaterThanOrEqual(96);
    expect(heights[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH * 0.05)]).toBe(89);
    // The relief is the model's: a high range stands inside the picture's land.
    expect(world.terrain!.relief.maximum).toBeGreaterThan(200);
  });
});

describe('create_world with a geography through the planner', () => {
  async function service(): Promise<AgentNudger> {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-world-geography-'));
    const mod = path.join(base, 'mod');
    await mkdir(mod);
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'state'),
        workspaces: [{ id: 'w', name: 'W', root: mod }],
      }),
    );
    return new AgentNudger(resolver);
  }

  const world = (extra: Record<string, unknown>) =>
    [
      {
        id: 'world',
        kind: 'create_world',
        width: WIDTH,
        height: HEIGHT,
        seed: 3,
        landProvincePixels: 4_000,
        seaProvincePixels: 15_000,
        countries: [{ tag: 'AAA', name: 'Aster' }],
        ...extra,
      },
    ] as never;

  it('synthesises relief and rivers and writes them', async () => {
    const nudger = await service();
    const preview = await nudger.previewRewriteWithDiff({
      workspaceId: 'w',
      operations: world({ geography: reliefGeography(), rivers: { density: 0.015 } }),
    });
    expect(preview.plan.blockers).toEqual([]);
    const paths = preview.plan.changes.map((change) => change.relativePath);
    expect(paths).toContain('map/heightmap.bmp');
    expect(paths).toContain('map/rivers.bmp');
    expect(preview.validation.diagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    const codes = preview.plan.diagnostics.map(({ code }) => code);
    expect(codes).toContain('MAP_RELIEF_SYNTHESIZED');
    expect(codes).not.toContain('MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE');
  }, 120_000);

  it('blocks a model whose biomes and climate the synthesis cannot use yet, and says which', async () => {
    const nudger = await service();
    const plan = await nudger.plan({
      workspaceId: 'w',
      operations: world({ geography: syntheticGeography(), width: 4096, height: 2048 }),
    });
    const blocker = plan.plan.blockers.find(
      ({ code }) => code === 'MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE',
    );
    expect(blocker).toBeDefined();
    expect(blocker!.message).toContain('biome');
    expect(blocker!.message).toContain('climate');
    expect(blocker!.message).toContain('relief');
    const details = blocker!.details as { available: string[]; unavailable: string[] };
    expect(details.available).toEqual(['relief', 'rivers', 'lakes']);
    expect(details.unavailable.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('writes nothing for a model with errors, whatever relief it asks for', async () => {
    const nudger = await service();
    const model = reliefGeography();
    // A pass far from the wall it names.
    model.passes!.push({ id: 'lost_pass', range: 'great_wall', position: [0.9, 0.9] });
    const plan = await nudger.plan({
      workspaceId: 'w',
      operations: world({ geography: model, relief: { scale: 'dramatic' } }),
    });
    const codes = plan.plan.blockers.map(({ code }) => code);
    expect(codes).toContain('MAP_GEOGRAPHY_INVALID');
    expect(plan.plan.diagnostics.map(({ code }) => code)).toContain('MAP_GEOGRAPHY_PASS_OFF_RANGE');
    expect(plan.plan.diagnostics.map(({ code }) => code)).not.toContain('MAP_RELIEF_SYNTHESIZED');
  }, 60_000);

  it('refuses relief and river density without a geography', async () => {
    const nudger = await service();
    const relief = await nudger.plan({
      workspaceId: 'w',
      operations: world({ relief: { scale: 'dramatic' } }),
    });
    expect(relief.plan.blockers.map(({ code }) => code)).toEqual(['MAP_RELIEF_REQUIRES_GEOGRAPHY']);
    const density = await nudger.plan({
      workspaceId: 'w',
      operations: world({ rivers: { density: 0.02 } }),
    });
    expect(density.plan.blockers.map(({ code }) => code)).toEqual([
      'MAP_RIVER_DENSITY_REQUIRES_GEOGRAPHY',
    ]);
  }, 60_000);
});

describe('schema and helpers', () => {
  const operation = (extra: Record<string, unknown>) =>
    mapOperationSchema.safeParse({ id: 'w', kind: 'create_world', ...extra });

  it('accepts a river count or a river density and a relief object, and rejects others', () => {
    expect(operation({ rivers: 12 }).success).toBe(true);
    expect(operation({ rivers: { density: 0.02 } }).success).toBe(true);
    expect(operation({ rivers: { density: 0.5 } }).success).toBe(false);
    expect(operation({ rivers: { density: 0.02, count: 3 } }).success).toBe(false);
    expect(operation({ relief: { scale: 'dramatic', detail: 0.8 } }).success).toBe(true);
    expect(operation({ relief: { scale: 'huge' } }).success).toBe(false);
    expect(operation({ relief: { detail: 2 } }).success).toBe(false);
    expect(operation({ relief: { detail: 0.5, extra: 1 } }).success).toBe(false);
  });

  it('lists the parts of a model the synthesis cannot use yet', () => {
    const relief = resolveGeography(reliefGeography(), {
      frame: { width: 2048, height: 1024 },
      hasReference: false,
    }).geography;
    expect(unsupportedGeographyParts(relief)).toEqual([]);
    const full = resolveGeography(syntheticGeography(), {
      frame: { width: 4096, height: 2048 },
      hasReference: false,
    }).geography;
    const parts = unsupportedGeographyParts(full);
    expect(parts.join(' ')).toContain('biome');
    expect(parts.join(' ')).toContain('climate');
  });

  it('writes 24-bit bitmaps from packed bytes exactly like pixel objects', () => {
    const pixels = Array.from({ length: 12 }, (_, index) => ({
      r: index * 20,
      g: 255 - index * 9,
      b: index,
    }));
    const bytes = new Uint8Array(pixels.flatMap(({ r, g, b }) => [r, g, b]));
    const a = createBmp({ width: 4, height: 3, bitsPerPixel: 24, rgbPixels: pixels });
    const b = createBmp({ width: 4, height: 3, bitsPerPixel: 24, rgbBytes: bytes });
    expect(b.equals(a)).toBe(true);
    expect(() =>
      createBmp({ width: 4, height: 3, bitsPerPixel: 24, rgbBytes: bytes.slice(0, 30) }),
    ).toThrow(expect.objectContaining({ code: 'MAP_BMP_PIXEL_COUNT_INVALID' }) as Error);
  });
});
