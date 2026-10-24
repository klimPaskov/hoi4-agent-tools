import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

type Color = readonly [number, number, number];
const SEA: Color = [20, 60, 200];
const PLAINS: Color = [130, 205, 60];
const palette = [
  { kind: 'sea', color: { r: 20, g: 60, b: 200 } },
  { kind: 'plains', color: { r: 130, g: 205, b: 60 } },
];

/** Two sheets side by side, each a sheet of sea with one square island of plains. */
async function drawing(): Promise<Buffer> {
  const width = 400;
  const height = 200;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const u = (x % 200) / 200;
      const v = y / 200;
      data.set(u > 0.25 && u < 0.75 && v > 0.25 && v < 0.75 ? PLAINS : SEA, (y * width + x) * 3);
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** The sheets swap places in the world: the right sheet goes west, the left one east. */
const sheets = {
  version: 1,
  source: { width: 400, height: 200 },
  sheets: [
    { id: 'left', box: [0, 0, 0.5, 1], anchor: [0, 0], target: [0.5, 0], scale: [1, 1] },
    { id: 'right', box: [0.5, 0, 1, 1], anchor: [0.5, 0], target: [0, 0], scale: [1, 1] },
  ],
};

/** World-frame land of both islands: x 0.125..0.375 and 0.625..0.875, y 0.25..0.75. */
function geography(shift = 0) {
  const square = (left: number) => [
    [left + shift, 0.25],
    [left + 0.25 + shift, 0.25],
    [left + 0.25 + shift, 0.75],
    [left + shift, 0.75],
  ];
  return {
    version: 1,
    lands: [
      { id: 'west', polygons: [square(0.125)] },
      { id: 'east', polygons: [square(0.625)] },
    ],
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-map-import-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = path.resolve('fixtures', 'map', 'roots');
  for (const kind of ['mod', 'game', 'dependency'])
    await cp(path.join(fixtureRoot, kind), path.join(root, kind), { recursive: true });
  await mkdir(path.join(root, 'mod', 'reference'), { recursive: true });
  await writeFile(path.join(root, 'mod', 'reference', 'drawing.png'), await drawing());
  await writeFile(path.join(root, 'mod', 'reference', 'sheets.json'), JSON.stringify(sheets));
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
            name: 'Map import fixture',
            root: path.join(root, 'mod'),
            gameRoot: path.join(root, 'game'),
            dependencyRoots: [path.join(root, 'dependency')],
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'map-import-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client };
}

interface PublicResult {
  status: string;
  code: string;
  artifacts: Array<{ name: string }>;
  diagnostics: Array<{ code: string; severity: string; details?: Record<string, unknown> }>;
  validation: { passed: boolean };
}

function createWorld(model: unknown) {
  return {
    id: 'world',
    kind: 'create_world',
    width: 1_024,
    height: 512,
    reference: {
      imagePath: 'reference/drawing.png',
      sheetsPath: 'reference/sheets.json',
      palette,
      paletteMatch: 'exact',
    },
    geography: model,
  };
}

describe('drawn map import through hoi4.map_rewrite', () => {
  it('previews a registered drawing with its import evidence and the measured agreement', async () => {
    const { client } = await fixture();
    const result = await client.callTool(
      {
        name: 'hoi4.map_rewrite',
        arguments: { workspaceId: 'test', preview: true, operations: [createWorld(geography())] },
      },
      undefined,
      { timeout: 200_000 },
    );
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.status).toBe('ok');
    expect(content.artifacts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'map-import-report.json',
        'map-import-classes.png',
        'map-import-alignment.png',
        'map-import-registration.png',
      ]),
    );
    const agreement = content.diagnostics.find(({ code }) => code.startsWith('MAP_IMPORT_SOURCES'));
    expect(agreement).toMatchObject({ code: 'MAP_IMPORT_SOURCES_AGREEMENT', severity: 'info' });
    expect(Number(agreement?.details?.landIou)).toBeGreaterThan(0.95);
  }, 240_000);

  it('blocks a write when the model and the drawing disagree, but still returns the evidence', async () => {
    const { client } = await fixture();
    const result = await client.callTool(
      {
        name: 'hoi4.map_rewrite',
        arguments: {
          workspaceId: 'test',
          preview: true,
          operations: [createWorld(geography(0.12))],
        },
      },
      undefined,
      { timeout: 200_000 },
    );
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MAP_IMPORT_SOURCES_DISAGREE', severity: 'error' }),
      ]),
    );
    expect(content.validation.passed).toBe(false);
    expect(content.artifacts.map(({ name }) => name)).toContain('map-import-alignment.png');
  }, 240_000);
});
