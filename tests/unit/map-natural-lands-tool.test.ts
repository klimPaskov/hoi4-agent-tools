import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { toolResult } from '../../src/hoi4_agent_tools/core/operation-result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import { naturalLandsFromIndex } from '../../src/hoi4_agent_tools/map/natural-lands.js';
import { planMapOperations, type MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { inspectMap } from '../../src/hoi4_agent_tools/map/tool-operations.js';
import { mapTaskTools } from '../../src/hoi4_agent_tools/mcp/tools/map.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { mapInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/map-requests.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

const COLUMNS = 6;
const ROWS = 6;
const CELL = 10;
const WIDTH = COLUMNS * CELL;
const HEIGHT = ROWS * CELL;
const grayscale: RgbColor[] = Array.from({ length: 256 }, (_, value) => ({
  r: value,
  g: value,
  b: value,
}));

/** Land provinces 1 to 24 in columns 1 to 4, row by row; columns 0 and 5 are sea 25 and 26. */
function provinceAt(column: number, row: number): number {
  if (column === 0) return 25;
  if (column === COLUMNS - 1) return 26;
  return row * 4 + column;
}
const colorOf = (id: number): RgbColor => ({ r: id * 9, g: 20, b: 30 });

async function workspace(options: { provinces?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-natural-lands-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'map/strategicregions'), { recursive: true });
  await mkdir(path.join(mod, 'history/states'), { recursive: true });
  const write = (relative: string, content: string | Buffer): Promise<void> =>
    writeFile(path.join(mod, relative), content);
  await write(
    'map/default.map',
    'definitions = "definition.csv"\nprovinces = "provinces.bmp"\nheightmap = "heightmap.bmp"\nrivers = "rivers.bmp"\n',
  );
  const definitions = ['0;0;0;0;sea;false;ocean;0'];
  for (let id = 1; id <= 24; id += 1) {
    const { r, g, b } = colorOf(id);
    definitions.push(`${id};${r};${g};${b};land;false;plains;1`);
  }
  for (const id of [25, 26]) {
    const { r, g, b } = colorOf(id);
    definitions.push(`${id};${r};${g};${b};sea;true;ocean;0`);
  }
  await write('map/definition.csv', `${definitions.join('\n')}\n`);
  if (options.provinces !== false)
    await write(
      'map/provinces.bmp',
      createBmp({
        width: WIDTH,
        height: HEIGHT,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: WIDTH * HEIGHT }, (_, offset) =>
          colorOf(
            provinceAt(Math.floor((offset % WIDTH) / CELL), Math.floor(offset / WIDTH / CELL)),
          ),
        ),
      }),
    );
  await write(
    'map/heightmap.bmp',
    createBmp({
      width: WIDTH,
      height: HEIGHT,
      bitsPerPixel: 8,
      palette: grayscale,
      indexedPixels: new Uint8Array(WIDTH * HEIGHT).fill(100),
    }),
  );
  // A major river along the last pixel column of column 2.
  await write(
    'map/rivers.bmp',
    createBmp({
      width: WIDTH,
      height: HEIGHT,
      bitsPerPixel: 8,
      palette: grayscale,
      indexedPixels: Uint8Array.from({ length: WIDTH * HEIGHT }, (_, offset) =>
        offset % WIDTH === 29 ? 8 : 255,
      ),
      colorsUsed: 0,
    }),
  );
  await write(
    'history/states/1.txt',
    `state = { id = 1 name = "STATE_1" state_category = rural provinces = { ${Array.from({ length: 12 }, (_, i) => i + 1).join(' ')} } history = { owner = AAA } }\n`,
  );
  // The states run across the river: the north half and the south half.
  await write(
    'history/states/2.txt',
    `state = { id = 2 name = "STATE_2" state_category = rural provinces = { ${Array.from({ length: 12 }, (_, i) => i + 13).join(' ')} } history = { owner = BBB } }\n`,
  );
  await write(
    'map/strategicregions/1.txt',
    `strategic_region = { id = 1 name = "REGION_1" provinces = { ${Array.from({ length: 26 }, (_, i) => i + 1).join(' ')} } }\n`,
  );
  const runtimeRoot = path.join(root, 'runtime');
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        storageRoots: [runtimeRoot],
        workspaces: [
          {
            id: 'test',
            name: 'Natural lands fixture',
            root: mod,
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  return { engine, nudger: new AgentNudger(engine) };
}

const context = { workspaceId: 'test', progress: () => Promise.resolve() };

interface LandsData {
  lands?: {
    count: number;
    counts: Record<string, number>;
    inputs: { heights: boolean; rivers: boolean };
    lands: { id: string; kind: string; provinces: number; coast: boolean }[];
  };
}

describe('natural lands in hoi4.map_inspect', () => {
  it('reports the lands inline and every land in an artifact', async () => {
    const { engine, nudger } = await workspace();
    const result = await inspectMap(
      engine,
      nudger,
      mapInspectRequestSchema.parse({
        workspaceId: 'test',
        lands: true,
        landOptions: { minBasinProvinces: 50 },
      }),
      context,
    );
    const summary = (result.data as LandsData).lands!;
    expect(summary).toMatchObject({
      count: 2,
      counts: { basin: 2, range: 0, forest: 0, marsh: 0, desert: 0, plains: 0 },
      inputs: { heights: true, rivers: true },
      lands: [
        { id: 'L1', kind: 'basin', provinces: 12, coast: true },
        { id: 'L3', kind: 'basin', provinces: 12, coast: true },
      ],
    });
    const artifact = result.artifacts.find(({ name }) => name.startsWith('map-natural-lands.'))!;
    expect(artifact).toBeDefined();
    const stored = JSON.parse(
      (
        await engine.artifacts.readLogical(engine.resolver.get('test'), artifact.uri, {
          mimeType: 'application/json',
          maxBytes: 5_000_000,
          maxChunks: 64,
        })
      ).bytes.toString('utf8'),
    ) as {
      schemaVersion: number;
      options: { minBasinProvinces: number };
      lands: { id: string; provinces: number[]; lines: { river: number }[] }[];
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.options.minBasinProvinces).toBe(50);
    expect(stored.lands[0]!.provinces).toEqual([1, 2, 5, 6, 9, 10, 13, 14, 17, 18, 21, 22]);
    expect(stored.lands[0]!.lines).toEqual([
      { land: 'L3', length: 60, river: 60, crest: 0, terrain: 0, divide: 0 },
    ]);
  });

  it('returns a result the published output schema accepts', async () => {
    const { engine, nudger } = await workspace();
    const outputSchema = mapTaskTools.find(({ name }) => name === 'hoi4.map_inspect')!.outputSchema;
    for (const lands of [true, false]) {
      const result = await inspectMap(
        engine,
        nudger,
        mapInspectRequestSchema.parse({ workspaceId: 'test', lands }),
        context,
      );
      expect('lands' in (result.data as object)).toBe(lands);
      expect(result.artifacts.some(({ name }) => name.startsWith('map-natural-lands.'))).toBe(
        lands,
      );
      const wire = JSON.parse(JSON.stringify(toolResult(result).structuredContent)) as unknown;
      const parsed = outputSchema.safeParse(wire);
      expect(parsed.success ? [] : parsed.error.issues, `lands ${String(lands)}`).toEqual([]);
    }
  });

  it('warns instead of failing when the map has no province bitmap', async () => {
    const { engine, nudger } = await workspace({ provinces: false });
    const result = await inspectMap(
      engine,
      nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', lands: true }),
      context,
    );
    expect('lands' in (result.data as object)).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MAP_NATURAL_LANDS_UNAVAILABLE',
        severity: 'warning',
        details: expect.objectContaining({ reason: 'MAP_NATURAL_LANDS_RASTER_MISSING' }),
      }),
    );
    const snapshot = await nudger.scan('test', undefined, undefined, false, false, true);
    await expect(naturalLandsFromIndex(snapshot.index)).rejects.toMatchObject({
      code: 'MAP_NATURAL_LANDS_RASTER_MISSING',
    });
  });

  it('validates the lands request', () => {
    const parse = (value: Record<string, unknown>) =>
      mapInspectRequestSchema.safeParse({ workspaceId: 'test', ...value }).success;
    expect(mapInspectRequestSchema.parse({ workspaceId: 'test' }).lands).toBe(false);
    expect(parse({ lands: true })).toBe(true);
    expect(
      parse({
        lands: true,
        landOptions: {
          minProvinces: 5,
          minBasinProvinces: 10,
          maxBasinProvinces: 40,
          riverMajorIndex: 6,
          riverShare: 0.4,
          crestExcess: 3.5,
          splitRangesAtCrests: true,
          terrainClasses: { elder_wood: 'forest', salt_flat: 'desert' },
        },
      }),
    ).toBe(true);
    expect(parse({ lands: true, lookupOnly: true })).toBe(false);
    expect(parse({ lands: true, layer: 'state' })).toBe(false);
    expect(parse({ landOptions: { minProvinces: 5 } })).toBe(false);
    for (const landOptions of [
      { minProvinces: 0 },
      { minProvinces: 2.5 },
      { riverMajorIndex: 12 },
      { riverShare: 0 },
      { riverShare: 1.1 },
      { crestExcess: 0 },
      { maxBasinProvinces: 11 },
      { minBasinProvinces: 10, maxBasinProvinces: 19 },
      { terrainClasses: { forest: 'woods' } },
      { terrainClasses: { 'bad name': 'forest' } },
      {
        terrainClasses: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`t${i}`, 'open'])),
      },
      { unknown: 1 },
    ])
      expect(parse({ lands: true, landOptions }), JSON.stringify(landOptions)).toBe(false);
  });

  it('lets assign_territory force, block and seed by natural land', async () => {
    const { nudger } = await workspace();
    const snapshot = await nudger.scan('test', undefined, undefined, false, false, true);
    const assign = (countries: unknown[], extra: Record<string, unknown> = {}) =>
      planMapOperations(snapshot.index, [
        mapOperationSchema.parse({
          id: 'territory',
          kind: 'assign_territory',
          unit: 'province',
          borderQuality: 'off',
          landOptions: { minBasinProvinces: 50 },
          countries,
          ...extra,
        }) as MapOperation,
      ]);
    const west = [1, 2, 5, 6, 9, 10, 13, 14, 17, 18, 21, 22];
    const east = west.map((province) => province + 2);
    // The states run north and south; the lands west and east of the river.
    const result = assign([
      { tag: 'AAA', seeds: [{ land: 'L1' }], forced: { landIds: ['L1'] } },
      { tag: 'BBB', seeds: [{ land: 'L3' }], blocked: { landIds: ['L1'] } },
    ]);
    expect(result.blockers).toEqual([]);
    const ownerOf = (province: number) => result.finalIndex.stateForProvince(province)[0]?.owner;
    expect(west.map(ownerOf)).toEqual(west.map(() => 'AAA'));
    expect(east.map(ownerOf)).toEqual(east.map(() => 'BBB'));

    const unknown = assign([{ tag: 'AAA', seeds: [{ land: 'L2' }] }]);
    expect(unknown.blockers.map(({ code }) => code)).toEqual(['MAP_NATURAL_LAND_UNKNOWN']);
    // Other options cut other lands: with the river minor there is no L3.
    const minor = assign([{ tag: 'AAA', seeds: [{ province: 1 }], forced: { landIds: ['L3'] } }], {
      landOptions: { riverMajorIndex: 9 },
    });
    expect(minor.blockers.map(({ code }) => code)).toEqual(['MAP_NATURAL_LAND_UNKNOWN']);
    for (const bad of [{ land: 'X1' }, { land: 'L' }, { land: 1 }])
      expect(
        mapOperationSchema.safeParse({
          id: 'territory',
          kind: 'assign_territory',
          countries: [{ tag: 'AAA', seeds: [bad] }],
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});
