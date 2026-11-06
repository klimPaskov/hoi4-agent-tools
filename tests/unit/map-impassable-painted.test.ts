import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  extractReferenceWorld,
  REFERENCE_TERRAIN,
} from '../../src/hoi4_agent_tools/map/reference-world.js';
import { realmReachNotes } from '../../src/hoi4_agent_tools/map/gameplay/reachability.js';
import { generateWorld, type WorldSpec } from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import {
  filesOf,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';
import { reliefGeography } from '../helpers/relief-fixture.js';

describe('painted impassable land in the reference picture', () => {
  it('reads impassable_mountain as mountain land with an impassable mask', async () => {
    const width = 64;
    const height = 32;
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const colour = x < 8 ? [20, 60, 200] : x >= 30 && x < 40 ? [90, 90, 90] : [130, 205, 60];
        data.set(colour, (y * width + x) * 3);
      }
    const bytes = await sharp(data, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const raster = await extractReferenceWorld(bytes, {
      width,
      height,
      seed: 1,
      fit: 'stretch',
      paletteMatch: 'exact',
      palette: [
        { kind: 'sea', color: { r: 20, g: 60, b: 200 } },
        { kind: 'plains', color: { r: 130, g: 205, b: 60 } },
        { kind: 'impassable_mountain', color: { r: 90, g: 90, b: 90 } },
      ],
    });
    const at = (x: number, y: number) => y * width + x;
    expect(raster.kind[at(35, 10)]).toBe(1);
    expect(raster.terrain[at(35, 10)]).toBe(REFERENCE_TERRAIN.mountain);
    expect(raster.impassable?.[at(35, 10)]).toBe(1);
    expect(raster.impassable?.[at(20, 10)]).toBe(0);
    expect(raster.terrain[at(20, 10)]).toBe(REFERENCE_TERRAIN.plains);
  });

  it('adds no mask when nothing is painted impassable and accepts the kind in the schema', async () => {
    const bytes = await sharp(Buffer.alloc(8 * 4 * 3, 200), {
      raw: { width: 8, height: 4, channels: 3 },
    })
      .png()
      .toBuffer();
    const raster = await extractReferenceWorld(bytes, {
      width: 8,
      height: 4,
      seed: 1,
      fit: 'stretch',
      paletteMatch: 'exact',
      palette: [{ kind: 'plains', color: { r: 200, g: 200, b: 200 } }],
    });
    expect(raster.impassable).toBeUndefined();
    const parse = (kind: string) =>
      mapOperationSchema.safeParse({
        kind: 'create_world',
        id: 'w',
        reference: {
          imagePath: 'map.png',
          paletteMatch: 'exact',
          palette: [{ kind, color: { r: 1, g: 2, b: 3 } }],
        },
      }).success;
    expect(parse('impassable_mountain')).toBe(true);
    expect(parse('impassable_swamp')).toBe(false);
  });
});

describe('impassable land in a generated world', () => {
  const width = 256;
  const height = 256;
  // One continent with an impassable massif in its middle.
  const massif = (x: number, y: number) => x >= 110 && x < 150 && y >= 60 && y < 200;
  const surface = syntheticRaster(width, height, {
    at: (x, y) => (x > 30 && x < 226 && y > 30 && y < 226 ? 1 : 0),
    terrain: (x, y) => (massif(x, y) ? REFERENCE_TERRAIN.mountain : 0),
  });
  surface.impassable = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) if (massif(x, y)) surface.impassable[y * width + x] = 1;
  const spec = (overrides: Partial<WorldSpec> = {}): WorldSpec =>
    worldSpec(surface, {
      countries: [
        { tag: 'AAA', name: 'Alpha' },
        { tag: 'BBB', name: 'Beta' },
      ],
      ...overrides,
    });
  const world = generateWorld(spec(), plainContext);
  const states = [...filesOf(world)]
    .filter(([file]) => file.startsWith('history/states/'))
    .map(([, content]) => content.toString());

  it('puts the massif in impassable states linked to passable ones', () => {
    const blocked = states.filter((text) => text.includes('\timpassable = yes'));
    const open = states.filter((text) => !text.includes('\timpassable = yes'));
    expect(blocked.length).toBeGreaterThan(0);
    const openIds = new Set(open.map((text) => Number(/\tid = (\d+)/u.exec(text)![1])));
    for (const text of blocked) {
      const link = /\tforce_link_ownership_to = (\d+)/u.exec(text);
      expect(link).not.toBeNull();
      expect(openIds.has(Number(link![1]))).toBe(true);
      expect(text).not.toMatch(/industrial_complex|arms_factory|victory_points/u);
    }
  });

  it('refuses a city on impassable land', () => {
    expect(() =>
      generateWorld(
        spec({ referenceCities: [{ name: 'Peakhold', x: 130, y: 120 }] }),
        plainContext,
      ),
    ).toThrow(expect.objectContaining({ code: 'MAP_FEATURE_IN_IMPASSABLE' }));
  });

  it('raises impassable land highest in a geography world, even without relief.painted', () => {
    const big = 1024;
    const tall = 512;
    const block = (x: number, y: number) => x >= 600 && x < 760 && y >= 300 && y < 420;
    const picture = syntheticRaster(big, tall, {
      at: (x, y) => (x > 120 && x < 900 && y > 70 && y < 440 ? 1 : 0),
      terrain: (x, y) => (block(x, y) ? REFERENCE_TERRAIN.mountain : 0),
    });
    picture.impassable = new Uint8Array(big * tall);
    for (let y = 0; y < tall; y += 1)
      for (let x = 0; x < big; x += 1) if (block(x, y)) picture.impassable[y * big + x] = 1;
    const model = reliefGeography();
    delete model.rivers;
    delete model.lakes;
    const geography = resolveGeography(model, {
      frame: { width: big, height: tall },
      hasReference: true,
    }).geography;
    const generated = generateWorld(
      worldSpec(picture, {
        geography,
        landProvincePixels: 3_000,
        seaProvincePixels: 12_000,
        provincesPerState: 6,
        landProvincesPerRegion: 30,
      }),
      plainContext,
    );
    expect(generated.terrain!.heights[360 * big + 680]!).toBeGreaterThan(200);
    expect(generated.notes.map(({ code }) => code)).toContain('MAP_RELIEF_PAINTED');
  });
});

describe('impassable regions of the geography model', () => {
  const width = 1024;
  const height = 512;
  const withRegion = (impassable: boolean, polygons = true) => {
    const model = reliefGeography();
    delete model.rivers;
    delete model.lakes;
    model.regions = [
      ...(model.regions ?? []),
      {
        id: 'giants_ring',
        name: 'Giants Ring',
        ...(polygons
          ? {
              polygons: [
                [
                  [0.3, 0.45],
                  [0.4, 0.45],
                  [0.4, 0.62],
                  [0.3, 0.62],
                ] as [number, number][],
              ],
            }
          : {}),
        impassable,
      },
    ];
    return resolveGeography(model, { frame: { width, height }, hasReference: false });
  };
  const spec = (geography: WorldSpec['geography']): WorldSpec => ({
    width,
    height,
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
    countries: [{ tag: 'AAA', name: 'Alpha' }],
    ...(geography === undefined ? {} : { geography }),
  });

  it('makes the region impassable states and the highest ground', () => {
    const resolution = withRegion(true);
    expect(resolution.valid).toBe(true);
    expect(resolution.geography.regions.find(({ id }) => id === 'giants_ring')?.impassable).toBe(
      true,
    );
    const world = generateWorld(spec(resolution.geography), plainContext);
    const states = [...filesOf(world)]
      .filter(([file]) => file.startsWith('history/states/'))
      .map(([, content]) => content.toString());
    expect(states.some((text) => text.includes('\timpassable = yes'))).toBe(true);
    expect(
      world.terrain!.heights[Math.round(0.535 * height) * width + Math.round(0.35 * width)]!,
    ).toBeGreaterThan(200);
    const open = generateWorld(spec(withRegion(false).geography), plainContext);
    expect(
      [...filesOf(open)].some(
        ([file, content]) =>
          file.startsWith('history/states/') && content.toString().includes('impassable = yes'),
      ),
    ).toBe(false);
  });

  it('refuses an impassable region without polygons', () => {
    const resolution = withRegion(true, false);
    expect(resolution.valid).toBe(false);
    expect(resolution.diagnostics.map(({ code }) => code)).toContain(
      'MAP_GEOGRAPHY_IMPASSABLE_WITHOUT_AREA',
    );
  });
});

describe('reach of realms through impassable land', () => {
  // Five land provinces in a row: 0 - 1 - 2 - 3 - 4, with province 5 an island.
  const neighbors = [
    new Set([1]),
    new Set([0, 2]),
    new Set([1, 3]),
    new Set([2, 4]),
    new Set([3]),
    new Set<number>(),
  ];
  const kind = [1, 1, 1, 1, 1, 1];
  const base = {
    kind,
    neighbors,
    blocked: [] as Array<readonly [number, number]>,
    crossings: [] as Array<readonly [number, number]>,
    tags: ['AAA', 'BBB'],
  };

  it('reports land cut from its capital by an impassable province, and not an island', () => {
    const notes = realmReachNotes({
      ...base,
      impassable: new Set([2]),
      owner: new Map([
        [0, 0],
        [1, 0],
        [3, 0],
        [4, 1],
        [5, 0],
      ]),
      capitals: [0, 4],
    });
    expect(notes).toContainEqual(
      expect.objectContaining({
        code: 'MAP_REALM_CUT_OFF',
        details: expect.objectContaining({ tag: 'AAA', provinces: 1, sample: [4] }),
      }),
    );
    expect(notes.filter(({ code }) => code === 'MAP_REALM_CUT_OFF')).toHaveLength(1);
  });

  it('reports a realm boxed in by impassable borders, unless a sea crossing or pass opens it', () => {
    const owner = new Map([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    const enclosed = realmReachNotes({
      ...base,
      impassable: new Set(),
      blocked: [[1, 2]],
      owner,
      capitals: [0, 4],
    });
    expect(enclosed.map(({ code, details }) => `${code}:${String(details.tag)}`)).toEqual([
      'MAP_REALM_ENCLOSED:AAA',
      'MAP_REALM_ENCLOSED:BBB',
    ]);
    const opened = realmReachNotes({
      ...base,
      impassable: new Set(),
      blocked: [[1, 2]],
      crossings: [[0, 4]],
      owner,
      capitals: [0, 4],
    });
    expect(opened).toEqual([]);
  });
});
