import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';
import {
  forEachPolylinePixel,
  resolveGeography,
  type ResolvedGeography,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import {
  generateWorld,
  type GeneratedWorld,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { readHeights, readProvinceTypes } from '../helpers/map-appearance-metrics.js';
import { filesOf, plainContext, syntheticRaster } from '../helpers/map-appearance-world.js';
import { reliefGeography } from '../helpers/relief-fixture.js';

/**
 * `create_world` with a geography model and the feature-aware partition (ADR 0058): the model's
 * regions, their densities and its wall ranges reach the partition, the mask smoothing happens
 * before the synthesis so heights follow it, and a cancelled request stops.
 */

const WIDTH = 1024;
const HEIGHT = 512;
/** The two regions meet on this row: the north region covers the rows above it. */
const BORDER_ROW = HEIGHT / 2;

function regionModel(): GeographyModelInput {
  const model = reliefGeography();
  model.regions = [
    {
      id: 'north_march',
      name: 'North March',
      polygons: [
        [
          [0, 0],
          [1, 0],
          [1, 0.5],
          [0, 0.5],
        ],
      ],
      density: { provinceAreaPx: 450, provincesPerState: [2, 3, 4] },
    },
    {
      id: 'south_reach',
      name: 'South Reach',
      polygons: [
        [
          [0, 0.5],
          [1, 0.5],
          [1, 1],
          [0, 1],
        ],
      ],
      density: { provinceAreaPx: 1_600, provincesPerState: [6, 8, 10] },
    },
  ];
  return model;
}

function resolved(model: GeographyModelInput, hasReference = false): ResolvedGeography {
  return resolveGeography(model, { frame: { width: WIDTH, height: HEIGHT }, hasReference })
    .geography;
}

function spec(geography: ResolvedGeography, overrides: Partial<WorldSpec> = {}): WorldSpec {
  return {
    width: WIDTH,
    height: HEIGHT,
    seed: 7,
    landCoverage: 0.4,
    continents: 1,
    landProvincePixels: 900,
    seaProvincePixels: 8_000,
    provincesPerState: 5,
    landProvincesPerRegion: 30,
    seaProvincesPerRegion: 10,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [
      { tag: 'AAA', name: 'Alpha' },
      { tag: 'BBB', name: 'Beta' },
    ],
    geography,
    colormapProfile: 'calibrated',
    partition: { mode: 'feature-aware' },
    ...overrides,
  };
}

interface ProvinceRead {
  /** Province id per pixel. */
  id: Int32Array;
  land: Set<number>;
}

function readProvinces(files: Map<string, Buffer>): ProvinceRead {
  const image = BmpImage.decode(files.get('map/provinces.bmp')!);
  const byColour = new Map<number, number>();
  const land = new Set<number>();
  for (const line of files.get('map/definition.csv')!.toString().split(/\r?\n/u)) {
    const row = line.split(';');
    if (row.length < 5 || !/^\d+$/u.test(row[0]!) || row[0] === '0') continue;
    const id = Number(row[0]);
    byColour.set((Number(row[1]) << 16) | (Number(row[2]) << 8) | Number(row[3]), id);
    if (row[4] === 'land') land.add(id);
  }
  const id = new Int32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const colour = image.rgbAt(x, y);
      id[y * WIDTH + x] = byColour.get((colour.r << 16) | (colour.g << 8) | colour.b) ?? -1;
    }
  return { id, land };
}

/** Province lists of the states or strategic regions, one list per file under `prefix`. */
function groups(files: Map<string, Buffer>, prefix: string, pattern: RegExp): number[][] {
  const lists: number[][] = [];
  for (const [file, bytes] of files) {
    if (!file.startsWith(prefix)) continue;
    const match = pattern.exec(bytes.toString('utf8'));
    if (match === null) continue;
    lists.push(match[1]!.trim().split(/\s+/u).map(Number));
  }
  return lists;
}

describe('create_world with a geography model and the feature-aware partition', () => {
  let world: GeneratedWorld;
  let files: Map<string, Buffer>;
  let provinces: ProvinceRead;
  /** Land pixels of each province north and south of the region border. */
  const north = new Map<number, number>();
  const south = new Map<number, number>();
  const regionOf = (id: number): 'north' | 'south' =>
    (north.get(id) ?? 0) >= (south.get(id) ?? 0) ? 'north' : 'south';

  beforeAll(() => {
    world = generateWorld(spec(resolved(regionModel())), plainContext);
    files = filesOf(world);
    provinces = readProvinces(files);
    for (let p = 0; p < WIDTH * HEIGHT; p += 1) {
      const id = provinces.id[p]!;
      if (!provinces.land.has(id)) continue;
      const side = p < BORDER_ROW * WIDTH ? north : south;
      side.set(id, (side.get(id) ?? 0) + 1);
    }
  }, 120_000);

  it('keeps every state and strategic region inside one geography region', () => {
    const states = groups(files, 'history/states/', /provinces = \{([^}]*)\}/u);
    expect(states.length).toBeGreaterThan(20);
    for (const members of states)
      expect(new Set(members.map(regionOf)).size, `state ${members.join(' ')}`).toBe(1);
    // Lakes join the land regions around them; only land provinces lie in a geography region.
    const regions = groups(files, 'map/strategicregions/', /provinces=\{([^}]*)\}/u)
      .map((members) => members.filter((id) => provinces.land.has(id)))
      .filter((members) => members.length > 0);
    expect(regions.length).toBeGreaterThan(2);
    for (const members of regions)
      expect(new Set(members.map(regionOf)).size, `region ${members.join(' ')}`).toBe(1);
    // Provinces follow the region border too: hardly any has land on both sides of it.
    const straddling = [...provinces.land].filter(
      (id) => (north.get(id) ?? 0) > 0 && (south.get(id) ?? 0) > 0,
    );
    expect(straddling.length).toBeLessThanOrEqual(2);
  });

  it('gives each region the province size and state size it asks for', () => {
    const sizes = (side: 'north' | 'south'): number[] =>
      [...provinces.land]
        .filter((id) => regionOf(id) === side)
        .map((id) => (north.get(id) ?? 0) + (south.get(id) ?? 0))
        .sort((a, b) => a - b);
    const median = (values: number[]): number => values[Math.floor(values.length / 2)]!;
    const small = sizes('north');
    const large = sizes('south');
    expect(small.length).toBeGreaterThan(30);
    expect(large.length).toBeGreaterThan(10);
    expect(median(small) / median(large)).toBeLessThan(0.6);
    const states = groups(files, 'history/states/', /provinces = \{([^}]*)\}/u);
    const mean = (side: 'north' | 'south'): number => {
      const chosen = states.filter((members) => regionOf(members[0]!) === side);
      return chosen.reduce((sum, members) => sum + members.length, 0) / chosen.length;
    };
    expect(mean('north')).toBeLessThan(4.5);
    expect(mean('south')).toBeGreaterThan(mean('north') + 1.5);
  });

  it('never lets a province straddle the wall range', () => {
    const wall = resolved(regionModel()).ranges.find(({ id }) => id === 'great_wall')!;
    // The wall runs north to south; the westmost wall pixel of each row splits that row.
    const wallX = new Int32Array(HEIGHT).fill(-1);
    forEachPolylinePixel(
      wall.path,
      { width: WIDTH, height: HEIGHT },
      { y0: 0, y1: HEIGHT },
      (x, y) => {
        if (wallX[y] === -1 || x < wallX[y]!) wallX[y] = x;
      },
    );
    const rows = [...wallX.keys()].filter((y) => wallX[y]! >= 0);
    // A province is at most an eighth of the map tall, so rows this far inside the wall's ends
    // cannot belong to a province that went around an end.
    const first = rows[0]! + HEIGHT / 8;
    const last = rows[rows.length - 1]! - HEIGHT / 8;
    expect(last - first).toBeGreaterThan(100);
    const west = new Set<number>();
    const east = new Set<number>();
    for (let y = first; y <= last; y += 1) {
      const split = wallX[y]!;
      for (let x = split - 60; x <= split + 60; x += 1) {
        if (Math.abs(x - split) <= 3) continue;
        const id = provinces.id[y * WIDTH + x]!;
        if (!provinces.land.has(id)) continue;
        (x < split ? west : east).add(id);
      }
    }
    expect(west.size).toBeGreaterThan(5);
    expect(east.size).toBeGreaterThan(5);
    expect([...west].filter((id) => east.has(id))).toEqual([]);
  });
});

describe('the mask smoothing of a geography world', () => {
  it('raises the land the smoothing adds and lowers the water, so heights match provinces', () => {
    const coast = Math.floor(WIDTH * 0.12);
    // Land east of the coast, plus one pixel on the coast's diagonal every eight rows: each pair
    // touches the coast only at a corner, which the partition must smooth.
    const land = (x: number, y: number): boolean => {
      if (y <= HEIGHT * 0.15 || y >= HEIGHT * 0.85) return false;
      if (x >= coast && x < WIDTH * 0.88) return true;
      return y % 8 === 0 ? x === coast - 2 : y % 8 === 1 && x === coast - 1;
    };
    const raster = syntheticRaster(WIDTH, HEIGHT, {
      at: (x, y) => (land(x, y) ? 1 : 0),
      terrain: () => 0,
    });
    const model = reliefGeography();
    delete model.rivers;
    delete model.lakes;
    const world = generateWorld(
      spec(resolved(model, true), { referenceSurface: raster, rivers: 0 }),
      plainContext,
    );
    const note = world.notes.find(({ code }) => code === 'MAP_PARTITION_MASK_SMOOTHED');
    expect(note).toBeDefined();
    expect((note!.details as { pixels: number }).pixels).toBeGreaterThan(20);
    const outputs = filesOf(world);
    const { type } = readProvinceTypes(outputs);
    const heights = readHeights(outputs);
    let wrongLand = 0;
    let wrongWater = 0;
    for (let p = 0; p < type.length; p += 1) {
      if (type[p] === 1 && heights[p]! < 96) wrongLand += 1;
      if (type[p] !== 1 && heights[p]! > 94) wrongWater += 1;
    }
    expect(wrongLand).toBe(0);
    expect(wrongWater).toBe(0);
    // The synthesis saw the smoothed mask: its heights are the bitmap's.
    expect(Buffer.from(heights).equals(Buffer.from(world.terrain!.heights))).toBe(true);
  }, 120_000);
});

describe('cancelling a geography world', () => {
  it('stops before the synthesis when the request is already cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      generateWorld(spec(resolved(regionModel())), plainContext, { signal: controller.signal }),
    ).toThrow(expect.objectContaining({ name: 'AbortError' }) as Error);
  });

  async function service(): Promise<AgentNudger> {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-world-cancel-'));
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

  /**
   * A real request signal that is cancelled the first time code in a file matching `where` checks
   * it, so the test proves the planner's signal reaches that stage.
   */
  function cancelledIn(where: RegExp): { signal: AbortSignal; reached: () => boolean } {
    const controller = new AbortController();
    const { signal } = controller;
    const check = signal.throwIfAborted.bind(signal);
    let reached = false;
    signal.throwIfAborted = (): void => {
      if (!reached && where.test(new Error().stack ?? '')) {
        reached = true;
        controller.abort();
      }
      check();
    };
    return { signal, reached: () => reached };
  }

  it.each([
    ['the terrain synthesis', /[\\/]relief[\\/]/u],
    ['the feature-aware partition', /partition-(?:provinces|watershed)\.ts/u],
  ])(
    'cancels a create_world request inside %s',
    async (_stage, where) => {
      const nudger = await service();
      const { signal, reached } = cancelledIn(where);
      await expect(
        nudger.plan({
          workspaceId: 'w',
          operations: [
            {
              id: 'world',
              kind: 'create_world',
              width: WIDTH,
              height: HEIGHT,
              seed: 3,
              landProvincePixels: 900,
              seaProvincePixels: 8_000,
              countries: [{ tag: 'AAA', name: 'Aster' }],
              geography: regionModel(),
              partition: 'feature-aware',
            },
          ] as never,
          signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(reached()).toBe(true);
    },
    120_000,
  );
});
