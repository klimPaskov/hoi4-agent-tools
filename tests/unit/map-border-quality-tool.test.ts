import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { toolResult } from '../../src/hoi4_agent_tools/core/operation-result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createBmp, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import {
  borderQualityInputFromIndex,
  terrainClassTable,
} from '../../src/hoi4_agent_tools/map/border-quality-input.js';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  BORDER_QUALITY_TARGETS,
  borderQualityDiagnostics,
} from '../../src/hoi4_agent_tools/map/border-quality.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { planMapOperations, type MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';
import { measureIndexBorderNaturalness } from '../../src/hoi4_agent_tools/map/border-quality-input.js';
import { renderMap } from '../../src/hoi4_agent_tools/map/render.js';
import { AgentNudger } from '../../src/hoi4_agent_tools/map/service.js';
import { inspectMap, renderMapView } from '../../src/hoi4_agent_tools/map/tool-operations.js';
import { mapTaskTools } from '../../src/hoi4_agent_tools/mcp/tools/map.js';
import { mapInspectRequestSchema } from '../../src/hoi4_agent_tools/schemas/map-requests.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

const SIZE = 256;
const meanderX = (y: number): number => 100 + Math.round(8 * Math.sin(y / 10));

interface WorkspaceOptions {
  /** Where the state border runs: along the meandering river or as a straight line. */
  border: 'river' | 'ruler';
  /** Heightmap size, to exercise a bitmap that does not match the province map. */
  heightSize?: number;
  /** Leave out the province bitmap, as in a workspace that has no map yet. */
  noProvinces?: boolean;
  terrain?: boolean;
}

const grayscale: RgbColor[] = Array.from({ length: 256 }, (_, value) => ({
  r: value,
  g: value,
  b: value,
}));

async function workspace(options: WorkspaceOptions) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-border-quality-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'map/strategicregions'), { recursive: true });
  await mkdir(path.join(mod, 'history/states'), { recursive: true });
  await mkdir(path.join(mod, 'common/terrain'), { recursive: true });
  const colors: RgbColor[] = [
    { r: 0, g: 0, b: 0 },
    { r: 10, g: 20, b: 30 },
    { r: 40, g: 50, b: 60 },
    { r: 70, g: 80, b: 90 },
  ];
  const provinceAt = (x: number, y: number): number =>
    x < 8 || x >= SIZE - 8 ? 3 : (options.border === 'river' ? x <= meanderX(y) : x < 160) ? 1 : 2;
  const write = (relative: string, content: string | Buffer): Promise<void> =>
    writeFile(path.join(mod, relative), content);
  await write(
    'map/default.map',
    'definitions = "definition.csv"\nprovinces = "provinces.bmp"\nheightmap = "heightmap.bmp"\nrivers = "rivers.bmp"\nterrain = "terrain.bmp"\n',
  );
  await write(
    'map/definition.csv',
    '0;0;0;0;sea;false;ocean;0\n1;10;20;30;land;true;plains;1\n2;40;50;60;land;true;forest;1\n3;70;80;90;sea;true;ocean;0\n',
  );
  if (options.noProvinces !== true)
    await write(
      'map/provinces.bmp',
      createBmp({
        width: SIZE,
        height: SIZE,
        bitsPerPixel: 24,
        rgbPixels: Array.from(
          { length: SIZE * SIZE },
          (_, offset) => colors[provinceAt(offset % SIZE, Math.floor(offset / SIZE))]!,
        ),
      }),
    );
  const heightSize = options.heightSize ?? SIZE;
  await write(
    'map/heightmap.bmp',
    createBmp({
      width: heightSize,
      height: heightSize,
      bitsPerPixel: 8,
      palette: grayscale,
      indexedPixels: new Uint8Array(heightSize * heightSize).fill(100),
    }),
  );
  // Rivers: the meander, plus a straight one on each side as a chance baseline.
  const rivers = new Uint8Array(SIZE * SIZE).fill(255);
  for (let y = 0; y < SIZE; y += 1)
    for (const x of [meanderX(y), 40, 220]) rivers[y * SIZE + x] = 3;
  await write(
    'map/rivers.bmp',
    createBmp({
      width: SIZE,
      height: SIZE,
      bitsPerPixel: 8,
      palette: grayscale,
      indexedPixels: rivers,
      colorsUsed: 0,
    }),
  );
  if (options.terrain === true) {
    await write(
      'map/terrain.bmp',
      createBmp({
        width: SIZE,
        height: SIZE,
        bitsPerPixel: 8,
        palette: grayscale,
        indexedPixels: Uint8Array.from({ length: SIZE * SIZE }, (_, offset) =>
          provinceAt(offset % SIZE, Math.floor(offset / SIZE)) === 1 ? 6 : 0,
        ),
      }),
    );
    await write(
      'common/terrain/00_terrain.txt',
      'categories = {\n plains = { }\n forest = { }\n mountain = { }\n ocean = { is_water = yes naval_terrain = yes }\n}\nterrain = {\n a = { type = plains color = { 0 } texture = 1 }\n b = { type = mountain color = { 6 } texture = 11 }\n c = { type = ocean color = { 15 } texture = 9 }\n d = { type = forest color = { 1 } texture = 4 }\n}\n',
    );
  }
  await write(
    'history/states/1.txt',
    'state = { id = 1 name = "STATE_1" provinces = { 1 } history = { owner = AAA } }\n',
  );
  await write(
    'history/states/2.txt',
    'state = { id = 2 name = "STATE_2" provinces = { 2 } history = { owner = BBB } }\n',
  );
  await write(
    'map/strategicregions/1.txt',
    'strategic_region = { id = 1 name = "REGION_1" provinces = { 1 2 3 } }\n',
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
            name: 'Border quality fixture',
            root: mod,
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  return { engine, nudger: new AgentNudger(engine), mod };
}

const context = {
  workspaceId: 'test',
  progress: () => Promise.resolve(),
};

describe('border quality in hoi4.map_inspect', () => {
  it('reports river-following borders as natural and straight ones as artificial', async () => {
    const followed = await workspace({ border: 'river', terrain: true });
    const natural = await inspectMap(
      followed.engine,
      followed.nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', quality: true }),
      context,
    );
    const quality = (natural.data as { quality?: { layers: Record<string, unknown>[] } }).quality!;
    expect(quality.layers.map(({ layer }) => layer)).toEqual([
      'province',
      'state',
      'region',
      'country',
    ]);
    expect(quality.layers[1]).toMatchObject({ layer: 'state', status: 'ok', worstRuns: [] });
    expect(quality.layers[1]!.borderEdges as number).toBeGreaterThanOrEqual(SIZE);
    expect(quality.layers[1]!.naturalShare as number).toBeGreaterThan(0.9);
    expect(quality.layers[1]!.enrichment as number).toBeGreaterThan(5);
    expect(
      natural.diagnostics.filter(({ code }) => code === 'MAP_BORDER_ARTIFICIAL_REVIEW'),
    ).toEqual([]);
    const artifact = natural.artifacts.find(({ name }) => name.startsWith('map-border-quality.'))!;
    expect(artifact).toBeDefined();
    const stored = JSON.parse(
      (
        await followed.engine.artifacts.readLogical(
          followed.engine.resolver.get('test'),
          artifact.uri,
          { mimeType: 'application/json', maxBytes: 5_000_000, maxChunks: 64 },
        )
      ).bytes.toString('utf8'),
    ) as { report: { layers: { layer: string }[] }; skippedInputs: unknown[] };
    expect(stored.report.layers).toHaveLength(4);
    expect(stored.skippedInputs).toEqual([]);

    const ruler = await workspace({ border: 'ruler' });
    const artificial = await inspectMap(
      ruler.engine,
      ruler.nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', quality: true }),
      context,
    );
    const rulerQuality = (artificial.data as { quality?: { layers: Record<string, unknown>[] } })
      .quality!;
    expect(rulerQuality.layers[1]).toMatchObject({ layer: 'state', alignment: 0, naturalShare: 0 });
    expect(rulerQuality.layers[1]!.worstRuns).toHaveLength(1);
    const warnings = artificial.diagnostics.filter(
      ({ code }) => code === 'MAP_BORDER_ARTIFICIAL_REVIEW',
    );
    expect(warnings.map((d) => d.details?.layer)).toEqual(
      expect.arrayContaining(['state', 'country']),
    );
    expect(warnings.every(({ severity }) => severity === 'warning')).toBe(true);
    // Warnings never fail validation.
    expect(artificial.validation.passed).toBe(natural.validation.passed);

    // A straight border where the terrain class changes follows a natural line, though not one
    // of the plan's barrier set (rivers and slopes).
    const terrain = await workspace({ border: 'ruler', terrain: true });
    const changed = await inspectMap(
      terrain.engine,
      terrain.nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', quality: true }),
      context,
    );
    const terrainQuality = (changed.data as { quality?: { layers: Record<string, unknown>[] } })
      .quality!;
    expect(terrainQuality.layers[1]).toMatchObject({
      layer: 'state',
      alignment: 0,
      worstRuns: [],
    });
    expect(terrainQuality.layers[1]!.naturalShare as number).toBeGreaterThan(0.9);
  });

  it('returns a result the published output schema accepts', async () => {
    const { engine, nudger } = await workspace({ border: 'river', terrain: true });
    const outputSchema = mapTaskTools.find(({ name }) => name === 'hoi4.map_inspect')!.outputSchema;
    for (const quality of [true, false]) {
      const result = await inspectMap(
        engine,
        nudger,
        mapInspectRequestSchema.parse({ workspaceId: 'test', quality }),
        context,
      );
      const wire = JSON.parse(JSON.stringify(toolResult(result).structuredContent)) as unknown;
      const parsed = outputSchema.safeParse(wire);
      expect(parsed.success ? [] : parsed.error.issues, `quality ${String(quality)}`).toEqual([]);
    }
  });

  it('does not read a river bitmap that default.map points outside the map folder', async () => {
    const { engine, nudger, mod } = await workspace({ border: 'river' });
    const secret = await readFile(path.join(mod, 'map/rivers.bmp'));
    await writeFile(path.join(mod, 'secret.bmp'), secret);
    await writeFile(
      path.join(mod, 'map/default.map'),
      'definitions = "definition.csv"\nprovinces = "provinces.bmp"\nheightmap = "heightmap.bmp"\nrivers = "../secret.bmp"\n',
    );
    await rm(path.join(mod, 'map/rivers.bmp'));
    const result = await inspectMap(
      engine,
      nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', quality: true }),
      context,
    );
    const quality = (result.data as { quality?: { inputs: { rivers: boolean } } }).quality!;
    expect(quality.inputs.rivers).toBe(false);
    const snapshot = await nudger.scan('test', undefined, undefined, false, false, true);
    expect(snapshot.files.some(({ relativePath }) => relativePath.endsWith('secret.bmp'))).toBe(
      false,
    );
  });

  it('leaves requests without the quality flag unchanged', async () => {
    const { engine, nudger } = await workspace({ border: 'ruler' });
    const plain = await inspectMap(
      engine,
      nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test' }),
      context,
    );
    expect('quality' in (plain.data as object)).toBe(false);
    expect(plain.artifacts.some(({ name }) => name.startsWith('map-border-quality.'))).toBe(false);
    expect(plain.diagnostics.some(({ code }) => code.startsWith('MAP_BORDER_'))).toBe(false);
    const snapshot = await nudger.scan('test');
    expect(snapshot.files.some(({ relativePath }) => relativePath.endsWith('rivers.bmp'))).toBe(
      false,
    );
  });

  it('skips bitmaps of the wrong size and says so, and degrades without a province bitmap', async () => {
    const mismatched = await workspace({ border: 'river', heightSize: 128 });
    const result = await inspectMap(
      mismatched.engine,
      mismatched.nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', quality: true }),
      context,
    );
    const quality = (result.data as { quality?: { inputs: unknown; skippedInputs: unknown[] } })
      .quality!;
    expect(quality.inputs).toEqual({
      heights: false,
      rivers: true,
      terrain: false,
      extra: false,
    });
    expect(quality.skippedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: 'heightmap', reason: expect.stringContaining('128x128') }),
        expect.objectContaining({ input: 'terrain' }),
      ]),
    );
    expect(result.diagnostics.map(({ code }) => code)).toContain('MAP_BORDER_INPUT_MISSING');

    const empty = await workspace({ border: 'river', noProvinces: true });
    const unavailable = await inspectMap(
      empty.engine,
      empty.nudger,
      mapInspectRequestSchema.parse({ workspaceId: 'test', quality: true }),
      context,
    );
    expect('quality' in (unavailable.data as object)).toBe(false);
    expect(unavailable.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MAP_BORDER_QUALITY_UNAVAILABLE',
        severity: 'warning',
        details: expect.objectContaining({ reason: 'MAP_BORDER_QUALITY_RASTER_MISSING' }),
      }),
    );
  });

  it('draws natural borders green and the worst artificial runs in the layer colour', async () => {
    const followed = await workspace({ border: 'river' });
    const ruler = await workspace({ border: 'ruler' });
    const render = async (fixture: Awaited<ReturnType<typeof workspace>>) => {
      const snapshot = await fixture.nudger.scan('test', undefined, undefined, false, false, true);
      const rendered = await renderMap(snapshot.index, {
        layer: 'state',
        overlays: ['border-quality'],
      });
      return sharp(rendered.png).ensureAlpha().raw().toBuffer();
    };
    const pixel = (data: Buffer, x: number, y: number): number[] => [
      ...data.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3),
    ];
    const green = await render(followed);
    expect(pixel(green, meanderX(100), 100)).toEqual([86, 214, 126]);
    const straight = await render(ruler);
    // The country layer's run is drawn last, over the state's: magenta on both sides of x = 160.
    expect(pixel(straight, 159, 100)).toEqual([255, 64, 255]);
    expect(pixel(straight, 160, 100)).toEqual([255, 64, 255]);
    expect(pixel(straight, 100, 100)).not.toEqual([255, 64, 255]);

    const view = await renderMapView(
      ruler.nudger,
      { workspaceId: 'test', overlays: ['border-quality'] },
      context,
    );
    expect(view.code).toBe('MAP_RENDERED');
    expect(view.artifacts.length).toBeGreaterThan(0);
  });

  it('rejects the quality flag where it cannot apply', () => {
    expect(
      mapInspectRequestSchema.safeParse({ workspaceId: 'test', quality: true, lookupOnly: true })
        .success,
    ).toBe(false);
    expect(
      mapInspectRequestSchema.safeParse({ workspaceId: 'test', quality: true, layer: 'state' })
        .success,
    ).toBe(false);
    expect(
      mapInspectRequestSchema.safeParse({ workspaceId: 'test', overlays: ['border-quality'] })
        .success,
    ).toBe(true);
    expect(mapInspectRequestSchema.parse({ workspaceId: 'test' }).quality).toBe(false);
    expect(
      mapInspectRequestSchema.safeParse({ workspaceId: 'test', overlays: ['border-quality-x'] })
        .success,
    ).toBe(false);
  });

  it('builds the input from a scanned map and classifies terrain bitmap indices', async () => {
    const { nudger } = await workspace({ border: 'river', terrain: true });
    const snapshot = await nudger.scan('test', undefined, undefined, false, false, true);
    const { input, skipped } = borderQualityInputFromIndex(snapshot.index);
    expect(skipped).toEqual([]);
    expect(input.layers.map(({ name }) => name)).toEqual([
      'province',
      'state',
      'region',
      'country',
    ]);
    expect(input.features).toMatchObject({
      heights: expect.any(Object),
      rivers: expect.any(Object),
      terrain: { classes: expect.any(Uint8Array) },
    });
    const classes = terrainClassTable(snapshot.index);
    expect(classes[6]).toBe(1); // mountain is the first obstacle type
    expect(classes[1]).toBe(2); // forest is the second
    expect(classes[15]).toBe(255); // ocean is water: ignored
    expect(classes[0]).toBe(0); // plains: open ground
    expect(classes[200]).toBe(0); // unmapped: open ground
    // A state whose province has a different owner gets a different country label.
    const country = input.layers.find(({ name }) => name === 'country')!;
    expect(country.labels[1]).not.toBe(country.labels[2]);
    expect(country.describe?.(country.labels[1]!)).toBe('AAA');
  });

  it('measures the borders of a generated world at chance level, the same every time', async () => {
    // The procedural generator (generator 1) places borders without looking at rivers or slopes,
    // so its enrichment sits near 1; this is the metric's view of the plan's diagnosis.
    const generate = () =>
      planMapOperations(MapWorkspaceIndex.build([]), [
        {
          id: 'world',
          kind: 'create_world',
          width: 512,
          height: 256,
          seed: 11,
          countries: [
            { tag: 'AUR', name: 'Aurelia' },
            { tag: 'BOR', name: 'Borea', share: 2 },
          ],
        },
      ] as MapOperation[]);
    const first = await measureIndexBorderNaturalness(generate().finalIndex);
    const second = await measureIndexBorderNaturalness(generate().finalIndex);
    expect(canonicalJson(second.report)).toBe(canonicalJson(first.report));
    expect(first.skipped).toEqual([]);
    expect(first.report.layers.map(({ layer }) => layer)).toEqual([
      'province',
      'state',
      'region',
      'country',
    ]);
    const state = first.report.layers.find(({ layer }) => layer === 'state')!;
    expect(state.status).toBe('ok');
    expect(state.barrier.enrichment!).toBeGreaterThan(0.6);
    expect(state.barrier.enrichment!).toBeLessThan(BORDER_QUALITY_TARGETS.minEnrichment);
    expect(borderQualityDiagnostics(first.report).map(({ code }) => code)).toContain(
      'MAP_BORDER_ARTIFICIAL_REVIEW',
    );
  });
});
