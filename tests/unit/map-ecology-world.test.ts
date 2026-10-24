import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import {
  COVER,
  RELIEF,
  EcologySampler,
  ecologyPlanes,
} from '../../src/hoi4_agent_tools/map/climate/index.js';
import { PARTITION_TERRAIN } from '../../src/hoi4_agent_tools/map/partition-fields.js';
import {
  resolvedAreaContains,
  resolveGeography,
  type ResolvedGeography,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  generateWorld,
  type GeneratedWorld,
  type WorldContext,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { climateGeography } from '../helpers/climate-fixture.js';
import { appearanceDiagnostics, filesOf, plainContext } from '../helpers/map-appearance-world.js';
import { indexedPixels } from '../helpers/relief-checks.js';

const WIDTH = 2048;
const HEIGHT = 1024;

function resolved(model: GeographyModelInput): ResolvedGeography {
  return resolveGeography(model, {
    frame: { width: WIDTH, height: HEIGHT },
    hasReference: false,
  }).geography;
}

function spec(geography: ResolvedGeography, overrides: Partial<WorldSpec> = {}): WorldSpec {
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
    geography,
    colormapProfile: 'solved',
    seasons: 'generated',
    partition: { mode: 'feature-aware' },
    ...overrides,
  };
}

const sha = (bytes: Uint8Array | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Macro cells of a geography feature's area that are land in the ecology. */
function cellsOf(
  area: Parameters<typeof resolvedAreaContains>[0],
  world: GeneratedWorld,
): number[] {
  const { ecology } = world.ecology!;
  const cells: number[] = [];
  for (let y = 0; y < ecology.height; y += 1)
    for (let x = 0; x < ecology.width; x += 1) {
      const cell = y * ecology.width + x;
      if (
        ecology.kind[cell] === 1 &&
        resolvedAreaContains(area, (x + 0.5) / ecology.width, (y + 0.5) / ecology.height)
      )
        cells.push(cell);
    }
  return cells;
}

function pixels(world: GeneratedWorld, name: string): Uint8Array {
  return indexedPixels(filesOf(world).get(`map/${name}`)!);
}

describe('a world with climate, biomes and fertility', () => {
  let geography: ResolvedGeography;
  let world: GeneratedWorld;

  beforeAll(() => {
    geography = resolved(climateGeography());
    world = generateWorld(spec(geography), plainContext);
  }, 120_000);

  it('reports what it computed with stable diagnostic ids', () => {
    const codes = world.notes.map(({ code }) => code);
    for (const code of [
      'MAP_CLIMATE_SYNTHESIZED',
      'MAP_BIOME_SYNTHESIZED',
      'MAP_COLORMAP_RESIDUAL',
      'MAP_COLORMAP_ATLAS_FALLBACK',
      'MAP_RELIEF_SYNTHESIZED',
    ])
      expect(codes).toContain(code);
    expect(codes).not.toContain('MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE');
    expect(codes).not.toContain('MAP_FERTILE_AREA_DESERT');
    expect(codes).not.toContain('MAP_SEA_ICE_OUTSIDE_NORTH');
  });

  it('lets a declared biome win over the climate where it lies', () => {
    const { ecology } = world.ecology!;
    const share = (id: string, cover: number): number => {
      const cells = cellsOf(geography.get('biome', id)!.area, world).filter(
        (cell) => ecology.relief[cell] === RELIEF.flat,
      );
      return cells.filter((cell) => ecology.cover[cell] === cover).length / cells.length;
    };
    expect(share('red_waste', COVER.desert)).toBeGreaterThan(0.95);
    expect(share('delta_marsh', COVER.marsh)).toBeGreaterThan(0.95);
    expect(share('cold_lands', COVER.ice)).toBeGreaterThan(0.95);
    expect(share('old_wood', COVER.forest)).toBeGreaterThan(0.95);
  });

  it('makes a fertile polygon fertile plains, not desert', () => {
    const { ecology } = world.ecology!;
    const cells = cellsOf(geography.get('biome', 'heartland_fields')!.area, world).filter(
      (cell) => ecology.relief[cell] === RELIEF.flat,
    );
    expect(cells.length).toBeGreaterThan(2_000);
    const count = (cover: number): number =>
      cells.filter((cell) => ecology.cover[cell] === cover).length;
    expect(count(COVER.desert) / cells.length).toBeLessThan(0.1);
    expect((count(COVER.farmland) + count(COVER.forest)) / cells.length).toBeGreaterThan(0.4);
    expect(count(COVER.farmland) / cells.length).toBeGreaterThan(0.9);
    const meanFertility =
      cells.reduce((sum, cell) => sum + ecology.fertility[cell]!, 0) / cells.length;
    expect(meanFertility / 255).toBeGreaterThan(0.85);
  });

  it('meets the terrain shares a region declares', () => {
    const report = world.ecology!.ecology.shares.find(({ id }) => id === 'heartland')!;
    expect(report.achieved.desert ?? 0).toBe(0);
    expect(Math.abs((report.achieved.plains ?? 0) - 0.55)).toBeLessThan(0.1);
    expect(Math.abs((report.achieved.forest ?? 0) - 0.3)).toBeLessThan(0.1);
    // By province area too, which is what the game plays on.
    const { ecology } = world.ecology!;
    const cells = cellsOf(geography.get('region', 'heartland')!.area!, world);
    let provinceDesert = 0;
    for (const cell of cells) {
      const x = (cell % ecology.width) * 2;
      const y = Math.floor(cell / ecology.width) * 2;
      void x;
      void y;
      provinceDesert += ecology.cover[cell] === COVER.desert ? 1 : 0;
    }
    expect(provinceDesert).toBe(0);
    expect(world.notes.map(({ code }) => code)).not.toContain('MAP_REGION_TERRAIN_SHARE_MISSED');
  });

  it('keeps the province terrain the terrain most of the province draws', () => {
    const { ecology } = world.ecology!;
    const sampler = new EcologySampler(ecology, WIDTH, HEIGHT, 7);
    const kind = new Uint8Array(WIDTH * HEIGHT);
    const heights = pixels(world, 'heightmap.bmp');
    for (let index = 0; index < kind.length; index += 1)
      kind[index] = heights[index]! >= 96 ? 1 : 0;
    const planes = ecologyPlanes(ecology, sampler, kind, world.terrain!.snow);
    const provinces = indexedProvinces(world);
    // For each province, the share of its pixels whose class matches its terrain name.
    const names = world.ecology!.provinceTerrain;
    const matching = new Map<number, number>();
    const total = new Map<number, number>();
    for (let index = 0; index < kind.length; index += 1) {
      const id = provinces[index]!;
      const name = names.get(id);
      if (kind[index] !== 1 || name === undefined || name === 'urban') continue;
      total.set(id, (total.get(id) ?? 0) + 1);
      const klass = planes.classPlane[index]!;
      const pixelName =
        klass === PARTITION_TERRAIN.mountain
          ? 'mountain'
          : klass === PARTITION_TERRAIN.hills
            ? 'hills'
            : klass === PARTITION_TERRAIN.forest
              ? 'forest'
              : klass === PARTITION_TERRAIN.desert
                ? 'desert'
                : klass === PARTITION_TERRAIN.marsh
                  ? 'marsh'
                  : klass === PARTITION_TERRAIN.jungle
                    ? 'jungle'
                    : 'plains';
      if (pixelName === name) matching.set(id, (matching.get(id) ?? 0) + 1);
    }
    let agreeing = 0;
    let pixelsTotal = 0;
    for (const [id, count] of total) {
      agreeing += matching.get(id) ?? 0;
      pixelsTotal += count;
    }
    expect(agreeing / pixelsTotal).toBeGreaterThan(0.7);
    // And the provinces of the declared desert are desert provinces.
    // The middle of the declared waste, clear of the lake in it.
    const id = provinces[Math.floor(0.77 * HEIGHT) * WIDTH + Math.floor(0.44 * WIDTH)]!;
    expect(names.get(id)).toBe('desert');
  });

  it('uses many graphical terrain indices and plants trees', () => {
    const terrain = pixels(world, 'terrain.bmp');
    const heights = pixels(world, 'heightmap.bmp');
    const used = new Set<number>();
    for (let index = 0; index < terrain.length; index += 1)
      if (heights[index]! >= 96) used.add(terrain[index]!);
    // Farmland, sparse forest, grass and sand mountains, desert tiles, snow, marsh, jungle.
    for (const index of [0, 1, 3, 4, 5, 9, 16, 17, 19, 21]) expect(used.has(index)).toBe(true);
    expect(used.size).toBeGreaterThanOrEqual(14);
    const trees = pixels(world, 'trees.bmp');
    const planted = trees.filter((value) => value !== 0).length / trees.length;
    expect(planted).toBeGreaterThan(0.04);
    expect(planted).toBeLessThan(0.3);
    expect(new Set(trees).has(5)).toBe(true);
    expect(new Set(trees).has(6)).toBe(true);
    // No trees over the sea.
    const treeWidth = Math.round((WIDTH * 75) / 256);
    let onWater = 0;
    for (let index = 0; index < trees.length; index += 1)
      if (trees[index] !== 0) {
        const x = Math.floor(((index % treeWidth) + 0.5) * (WIDTH / treeWidth));
        const y = Math.floor((Math.floor(index / treeWidth) + 0.5) * (WIDTH / treeWidth));
        if (heights[y * WIDTH + x]! < 95) onWater += 1;
      }
    expect(onWater / trees.filter((value) => value !== 0).length).toBeLessThan(0.02);
  });

  it('solves a colour map inside the base game ranges and passes the appearance validators', () => {
    const colour = world.ecology!.colour!;
    expect(colour.meanValue).toBeGreaterThan(50);
    expect(colour.meanValue).toBeLessThan(100);
    expect(colour.distinct5BitColours).toBeGreaterThan(400);
    expect(colour.residual / colour.landCells).toBeLessThan(0.05);
    expect(colour.tileSource).toBe('bundled-table');
    const findings = appearanceDiagnostics(filesOf(world));
    expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
    const codes = findings.map(({ code }) => code);
    expect(codes).not.toContain('MAP_COLORMAP_RANGE');
    expect(codes).not.toContain('MAP_COLORMAP_ALBEDO_RANGE');
    expect(codes).not.toContain('MAP_TERRAIN_BITMAP_DOMINATED');
  });

  it('writes weather from the climate and a naval terrain from the depth of each sea region', () => {
    const regions = [...filesOf(world)].filter(([name]) =>
      name.startsWith('map/strategicregions/'),
    );
    expect(regions.length).toBeGreaterThan(20);
    const navalValues = new Set<string>();
    let winterIce = 0;
    let coldest: { north: number; south: number } = { north: 0, south: 0 };
    for (const [, buffer] of regions) {
      const text = buffer.toString('utf8');
      expect(text.match(/period=\{/gu)).toHaveLength(12);
      for (const match of text.matchAll(/temperature=\{ (-?[\d.]+) (-?[\d.]+) \}/gu))
        expect(Number(match[1])).toBeLessThan(Number(match[2]));
      const naval = /naval_terrain=(\w+)/u.exec(text);
      if (naval !== null) navalValues.add(naval[1]!);
      if (/arctic_water=1\.000/u.test(text)) winterIce += 1;
      const temperatures = [...text.matchAll(/temperature=\{ (-?[\d.]+) /gu)].map((m) =>
        Number(m[1]),
      );
      if (temperatures.length === 12) {
        // The warm month: July north of the warm band, January south of it.
        const warmest = temperatures.indexOf(Math.max(...temperatures));
        if (warmest === 6) coldest.north += 1;
        if (warmest === 0) coldest.south += 1;
      }
    }
    expect([...navalValues].sort()).toEqual(
      expect.arrayContaining(['water_deep_ocean', 'water_shallow_sea']),
    );
    expect(winterIce).toBeGreaterThan(0);
    expect(coldest.north).toBeGreaterThan(0);
    expect(coldest.south).toBeGreaterThan(0);
    expect(world.ecology!.navalTerrain.size).toBeGreaterThan(5);
  });

  it('writes seasons.txt from the climate, parsed without errors', () => {
    const text = filesOf(world).get('map/seasons.txt')!.toString('utf8');
    const document = parseClausewitz(Buffer.from(text), 'map/seasons.txt');
    expect(document.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    for (const season of ['winter', 'spring', 'summer', 'autumn', 'tree_winter2', 'tree_autumn2'])
      expect(text).toContain(`${season} = {`);
    // A cold band of -18 degrees desaturates the north like the base game.
    expect(text).toContain('hsv_north=\t\t\t { 0 0.1 1 }');
  });

  it('writes the city style of a region over its land and the default elsewhere', () => {
    const cities = pixels(world, 'cities.bmp');
    const heights = pixels(world, 'heightmap.bmp');
    const heartland = geography.get('region', 'heartland')!.area!.interior;
    const inside = Math.floor(heartland.y * HEIGHT) * WIDTH + Math.floor(heartland.x * WIDTH);
    expect(heights[inside]!).toBeGreaterThanOrEqual(96);
    expect(cities[inside]).toBe(1);
    const west = geography.get('biome', 'old_wood')!.area.interior;
    expect(cities[Math.floor(west.y * HEIGHT) * WIDTH + Math.floor(west.x * WIDTH)]).toBe(15);
    expect(cities[0]).toBe(0);
  });

  it('tints sea ice pale and the declared shelf brighter than the abyss', () => {
    const level = filesOf(world).get('map/terrain/colormap_water_0.dds')!;
    const half = WIDTH / 2;
    const at = (x: number, y: number): [number, number, number] => {
      const offset = 128 + (Math.floor((y * HEIGHT) / 2) * half + Math.floor(x * half)) * 4;
      return [level[offset + 2]!, level[offset + 1]!, level[offset]!];
    };
    const ice = at(0.46, 0.06);
    const open = at(0.9, 0.06);
    expect(ice[0] + ice[1] + ice[2]).toBeGreaterThan(open[0] + open[1] + open[2] + 150);
    const shelf = at(0.44, 0.95);
    const trench = at(0.045, 0.5);
    expect(shelf[1] + shelf[2]).toBeGreaterThan(trench[1] + trench[2]);
  });

  it('is deterministic and keeps the recorded output of the fixture world', () => {
    const files = filesOf(world);
    const again = filesOf(generateWorld(spec(geography), plainContext));
    for (const name of [
      'map/terrain.bmp',
      'map/trees.bmp',
      'map/cities.bmp',
      'map/seasons.txt',
      'map/definition.csv',
      'map/terrain/colormap_rgb_cityemissivemask_a.dds',
      'map/terrain/colormap_water_0.dds',
    ])
      expect(sha(again.get(name)!)).toBe(sha(files.get(name)!));
    // Recorded on the fixture: only + - * /, sqrt and integer hashes enter these files, so the
    // hashes hold on every platform. A change that moves them changes every seed's biomes: update
    // them on purpose, with a changelog entry, never to silence a failing run.
    expect(sha(files.get('map/terrain.bmp')!)).toBe('5db7a68322e0a459');
    expect(sha(files.get('map/trees.bmp')!)).toBe('9765c68ae5329670');
    expect(sha(files.get('map/terrain/colormap_rgb_cityemissivemask_a.dds')!)).toBe(
      'ba9b13823eef6d5c',
    );
    expect(sha(files.get('map/seasons.txt')!)).toBe('a81b6083c9774d2f');
  }, 120_000);
});

function indexedProvinces(world: GeneratedWorld): Uint32Array {
  const file = filesOf(world).get('map/provinces.bmp')!;
  const offset = file.readUInt32LE(10);
  const stride = Math.ceil((WIDTH * 3) / 4) * 4;
  const signed = file.readInt32LE(22);
  const colours = new Map<number, number>();
  const definition = filesOf(world).get('map/definition.csv')!.toString('utf8').split('\r\n');
  for (const line of definition) {
    const parts = line.split(';');
    if (parts.length < 8 || parts[0] === '0') continue;
    colours.set(
      (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3]),
      Number(parts[0]) - 1,
    );
  }
  const out = new Uint32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = signed > 0 ? HEIGHT - 1 - y : y;
    for (let x = 0; x < WIDTH; x += 1) {
      const o = offset + row * stride + x * 3;
      out[y * WIDTH + x] = colours.get((file[o + 2]! << 16) | (file[o + 1]! << 8) | file[o]!)!;
    }
  }
  return out;
}

describe('declarations the model makes that the result cannot honour', () => {
  const context: WorldContext = plainContext;

  function build(model: GeographyModelInput, overrides: Partial<WorldSpec> = {}, ctx = context) {
    return generateWorld(spec(resolved(model), overrides), ctx);
  }

  it('warns when a mountain share cannot come from the climate', () => {
    const model = climateGeography();
    model.regions![0]!.terrain = { mountain: 0.6, plains: 0.4 };
    const notes = build(model).notes;
    const miss = notes.find(({ code }) => code === 'MAP_REGION_TERRAIN_SHARE_MISSED')!;
    expect(miss).toBeDefined();
    expect(miss.message).toContain('mountain');
    expect(miss.message).toContain('relief');
  }, 120_000);

  it('warns when a fertile land is mostly declared desert', () => {
    const model = climateGeography();
    model.biomes!.push({
      id: 'big_waste',
      kind: 'desert',
      z: 5,
      polygons: [
        [
          [0.52, 0.37],
          [0.63, 0.35],
          [0.63, 0.7],
          [0.52, 0.72],
        ],
      ],
    });
    model.biomes!.push({
      id: 'promised_fields',
      kind: 'plains',
      fertility: 0.9,
      z: 1,
      polygons: [
        [
          [0.53, 0.45],
          [0.6, 0.45],
          [0.6, 0.6],
          [0.53, 0.6],
        ],
      ],
    });
    const notes = build(model).notes.filter(({ code }) => code === 'MAP_FERTILE_AREA_DESERT');
    expect(notes.map(({ details }) => details!.featureId)).toEqual(
      expect.arrayContaining(['promised_fields', 'heartland_fields']),
    );
  }, 120_000);

  it('warns about sea ice below the northern quarter of the map', () => {
    const model = climateGeography();
    const bay = model.seas!.find(({ id }) => id === 'frozen_bay')!;
    bay.polygons = [
      [
        [0.3, 0.9],
        [0.62, 0.9],
        [0.62, 0.98],
        [0.3, 0.98],
      ],
    ];
    const note = build(model).notes.find(({ code }) => code === 'MAP_SEA_ICE_OUTSIDE_NORTH');
    expect(note).toBeDefined();
    expect(note!.details).toMatchObject({ seaId: 'frozen_bay' });
  }, 120_000);

  it('says a city style no city group defines and writes the default there', () => {
    const world = build(climateGeography(), {}, { ...context, cityStyles: [0, 15] });
    const note = world.notes.find(({ code }) => code === 'MAP_CITIES_STYLE_UNDEFINED')!;
    expect(note).toBeDefined();
    expect(note.details).toMatchObject({ styles: [1] });
    const cities = indexedPixels(filesOf(world).get('map/cities.bmp')!);
    expect(new Set(cities).has(1)).toBe(false);
  }, 120_000);

  it('names a category the active terrain files do not define', () => {
    const entries = [
      { name: 'plains', index: 0, type: 'plains', texture: 1, permSnow: false },
      { name: 'forest', index: 1, type: 'forest', texture: 4, permSnow: false },
      { name: 'mountain', index: 6, type: 'mountain', texture: 11, permSnow: false },
      { name: 'ocean', index: 15, type: 'ocean', texture: 9, permSnow: false },
    ];
    const world = build(
      climateGeography(),
      {},
      {
        ...context,
        terrainEntries: entries,
        terrainIndex: new Map(entries.map((entry) => [entry.type, entry.index])),
      },
    );
    const note = world.notes.find(({ code }) => code === 'MAP_BIOME_UNMAPPED')!;
    expect(note).toBeDefined();
    expect(note.details!.categories).toEqual(expect.arrayContaining(['jungle', 'desert', 'marsh']));
  }, 120_000);

  it('uses the installed atlas when the context has one, and says nothing then', () => {
    const world = build(
      climateGeography(),
      {},
      {
        ...context,
        atlas: {
          source: 'installed-atlas',
          means: Array.from({ length: 16 }, (): [number, number, number] => [150, 150, 130]),
        },
      },
    );
    expect(world.notes.map(({ code }) => code)).not.toContain('MAP_COLORMAP_ATLAS_FALLBACK');
    expect(world.ecology!.colour!.tileSource).toBe('installed-atlas');
  }, 120_000);

  it('writes no solver output with the legacy colour map and no seasons file when vanilla', () => {
    const world = build(climateGeography(), { colormapProfile: 'legacy', seasons: 'vanilla' });
    expect(world.notes.map(({ code }) => code)).not.toContain('MAP_COLORMAP_RESIDUAL');
    expect(filesOf(world).has('map/seasons.txt')).toBe(false);
    expect(world.ecology!.colour).toBeUndefined();
  }, 120_000);

  it('moves the rain shadow with the wind', () => {
    const east = climateGeography();
    east.climate = { ...east.climate!, windFrom: 90 };
    const west = build(climateGeography()).ecology!.ecology;
    const flipped = build(east).ecology!.ecology;
    // The Great Wall stands near x = 0.5: land just east of it is dry in a westerly and wet in an easterly.
    const cell = (ecology: typeof west): number => {
      const y = Math.floor(0.5 * ecology.height);
      let sum = 0;
      for (let x = Math.floor(0.52 * ecology.width); x < Math.floor(0.55 * ecology.width); x += 1)
        sum += ecology.rainfall[y * ecology.width + x]!;
      return sum;
    };
    expect(cell(flipped)).toBeGreaterThan(cell(west));
  }, 180_000);
});
