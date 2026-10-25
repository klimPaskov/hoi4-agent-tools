import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { syntheticGeography } from '../helpers/geography-fixture.js';
import { gameplayGeography } from '../helpers/gameplay-fixture.js';
import { reliefGeography } from '../helpers/relief-fixture.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture(options: { emptyMod?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-map-geography-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = path.resolve('fixtures', 'map', 'roots');
  for (const kind of ['mod', 'game', 'dependency'])
    await cp(path.join(fixtureRoot, kind), path.join(root, kind), { recursive: true });
  if (options.emptyMod === true) {
    // A world replaces the whole map; start from a mod with none of the fixture's states.
    await rm(path.join(root, 'mod'), { recursive: true, force: true });
    await mkdir(path.join(root, 'mod'));
  }
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
            name: 'Map geography fixture',
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
  const client = new Client({ name: 'map-geography-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, root, modRoot: path.join(root, 'mod') };
}

async function sourceInventory(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [relative, content] of Object.entries(await sourceInventory(target)))
        files[`${entry.name}/${relative}`] = content;
    } else if (entry.isFile()) files[entry.name] = (await readFile(target)).toString('base64');
  }
  return files;
}

async function completedTask(client: Client, name: string, arguments_: Record<string, unknown>) {
  const created = await client.request(
    { method: 'tools/call', params: { name, arguments: arguments_ } },
    CreateTaskResultSchema,
    { task: { ttl: 60_000 } },
  );
  await vi.waitFor(
    async () => {
      expect((await client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
        'completed',
      );
    },
    { timeout: 60_000, interval: 50 },
  );
  return client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema);
}

interface PublicResult {
  status: string;
  code: string;
  changedFiles: string[];
  data: {
    execution: string;
    geography?: Array<Record<string, unknown>>;
    fileCount: number;
    artifactCount: number;
  };
  artifacts: Array<{ name: string; mimeType: string }>;
  blockers: Array<{ code: string; message: string }>;
  diagnostics: Array<{ code: string; severity: string }>;
}

/** A wall between two brooks and the river they would join: each brook is carved through it. */
function walledGeography() {
  return {
    version: 1,
    seas: [
      {
        id: 'sea',
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
        id: 'land',
        polygons: [
          [
            [0.15, 0.2],
            [0.85, 0.2],
            [0.85, 0.8],
            [0.15, 0.8],
          ],
        ],
      },
    ],
    ranges: [
      {
        id: 'divide',
        profile: 'wall',
        path: [
          [0.5, 0.1],
          [0.5, 0.9],
        ],
        halfWidth: 0.01,
        peak: 0.9,
      },
    ],
    rivers: [
      { id: 'east', source: [0.7, 0.5], mouth: { sea: 'sea' }, size: 3 },
      { id: 'west_brook', source: [0.3, 0.5], mouth: { river: 'east' }, size: 1 },
      { id: 'north_brook', source: [0.3, 0.3], mouth: { river: 'east' }, size: 1 },
    ],
  };
}

/** Two lands: brooks on the west land cannot reach a river that lies on the east land. */
function isolatedGeography() {
  return {
    version: 1,
    seas: [
      {
        id: 'sea',
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
        id: 'west',
        polygons: [
          [
            [0.1, 0.2],
            [0.4, 0.2],
            [0.4, 0.8],
            [0.1, 0.8],
          ],
        ],
      },
      {
        id: 'east',
        polygons: [
          [
            [0.6, 0.2],
            [0.9, 0.2],
            [0.9, 0.8],
            [0.6, 0.8],
          ],
        ],
      },
    ],
    rivers: [
      { id: 'east_river', source: [0.75, 0.5], mouth: { sea: 'sea' }, size: 3 },
      { id: 'west_brook', source: [0.2, 0.5], mouth: { river: 'east_river' }, size: 1 },
      { id: 'north_brook', source: [0.2, 0.3], mouth: { river: 'east_river' }, size: 1 },
    ],
  };
}

const create = (extra: Record<string, unknown>) => ({
  id: 'world',
  kind: 'create_world',
  width: 4096,
  height: 2048,
  ...extra,
});

describe('geography model through hoi4.map_rewrite', () => {
  it('previews an inline model: overlay, report and counts, without touching the mod', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [create({ geography: syntheticGeography() })],
      },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content).toMatchObject({
      status: 'ok',
      code: 'MAP_GEOGRAPHY_PREVIEW_READY',
      changedFiles: [],
      data: { execution: 'preview', fileCount: 0, artifactCount: 2 },
    });
    expect(content.data.geography).toEqual([
      expect.objectContaining({
        operationId: 'world',
        valid: true,
        source: 'inline',
        width: 4096,
        height: 2048,
        featureCount: 16,
        errorCount: 0,
        warningCount: 0,
        synthesis: 'unavailable',
        unsupported: expect.arrayContaining([expect.stringContaining('biome')]) as string[],
        counts: expect.objectContaining({ land: 2, sea: 1, river: 2, range: 1, pass: 1 }),
      }),
    ]);
    expect(content.artifacts.map(({ name, mimeType }) => [name, mimeType])).toEqual([
      ['map-geography-overlay.png', 'image/png'],
      ['map-geography-report.json', 'application/json'],
    ]);
    expect(content.diagnostics.map(({ code }) => code)).toContain(
      'MAP_GEOGRAPHY_PREVIEW_MODEL_ONLY',
    );
    expect(JSON.stringify(content)).not.toMatch(/transactionId|planHash/u);
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('previews a model read from a workspace file and links its hash into the report', async () => {
    const { client, modRoot } = await fixture();
    await mkdir(path.join(modRoot, 'geography'), { recursive: true });
    const text = JSON.stringify(syntheticGeography(), null, 2);
    await writeFile(path.join(modRoot, 'geography', 'world.json'), text);
    const before = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [create({ geographyPath: 'geography/world.json' })],
      },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.status).toBe('ok');
    expect(content.data.geography?.[0]).toMatchObject({ source: 'file', valid: true });
    expect(content.data.geography?.[0]?.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('serves the overlay and report as readable resources', async () => {
    const { client } = await fixture();
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [create({ geography: syntheticGeography() })],
      },
    });
    const content = result.structuredContent as unknown as {
      artifacts: Array<{ name: string; uri: string }>;
    };
    const overlay = content.artifacts.find(({ name }) => name === 'map-geography-overlay.png')!;
    const report = content.artifacts.find(({ name }) => name === 'map-geography-report.json')!;
    const png = await client.readResource({ uri: overlay.uri });
    const blob = (png.contents[0] as { blob?: string }).blob!;
    const metadata = await sharp(Buffer.from(blob, 'base64')).metadata();
    expect([metadata.width, metadata.height]).toEqual([1536, 768]);
    const json = await client.readResource({ uri: report.uri });
    const parsed = JSON.parse((json.contents[0] as { text: string }).text) as {
      valid: boolean;
      features: Array<{ id: string }>;
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.features.map(({ id }) => id)).toContain('spine_gap');
  });

  it('returns a blocked preview with the defects of an invalid model', async () => {
    const { client, modRoot } = await fixture();
    const model = syntheticGeography();
    model.sites?.push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] });
    const before = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: { workspaceId: 'test', preview: true, operations: [create({ geography: model })] },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content).toMatchObject({ status: 'blocked', code: 'MAP_GEOGRAPHY_PREVIEW_BLOCKED' });
    expect(content.blockers.map(({ code }) => code)).toContain('MAP_GEOGRAPHY_SITE_IN_WATER');
    expect(content.data.geography?.[0]).toMatchObject({ valid: false, errorCount: 1 });
    expect(content.artifacts.map(({ name }) => name)).toContain('map-geography-overlay.png');
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('writes relief, rivers and lakes for a model without biomes or climate', async () => {
    const { client, modRoot } = await fixture({ emptyMod: true });
    const preview = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [create({ geography: reliefGeography(), width: 1024, height: 512 })],
      },
    });
    expect(
      (preview.structuredContent as unknown as PublicResult).data.geography?.[0],
    ).toMatchObject({ valid: true, synthesis: 'available', unsupported: [] });
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        operations: [
          create({
            geography: reliefGeography(),
            width: 1024,
            height: 512,
            landProvincePixels: 4000,
            seaProvincePixels: 15000,
            rivers: { density: 0.015 },
            relief: { scale: 'vanilla', detail: 0.6 },
            countries: [{ tag: 'AAA', name: 'Aster' }],
          }),
        ],
      },
    });
    const content = result.structuredContent as unknown as PublicResult;
    // The list of written files is long enough that the response is cut to its essentials.
    expect(content.status).toBe('ok');
    expect(JSON.stringify(content)).not.toMatch(/transactionId|planHash/u);
    const heights = await readFile(path.join(modRoot, 'map', 'heightmap.bmp'));
    expect(heights.readInt32LE(18)).toBe(1024);
    const rivers = await readFile(path.join(modRoot, 'map', 'rivers.bmp'));
    expect(rivers.readUInt32LE(46)).toBe(0);
    expect((await readFile(path.join(modRoot, 'map', 'world_normal.bmp'))).readInt32LE(18)).toBe(
      512,
    );
  }, 180_000);

  it('writes straits, a gated wall, ports and names for a model, and rejects bad options', async () => {
    const { client, modRoot } = await fixture({ emptyMod: true });
    const rejected = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        operations: [
          create({
            geography: gameplayGeography(),
            width: 1024,
            height: 512,
            autoStraits: { maxGapPx: 3 },
          }),
        ],
      },
    });
    expect(rejected.isError).toBe(true);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        operations: [
          create({
            geography: gameplayGeography(),
            width: 1024,
            height: 512,
            landProvincePixels: 520,
            seaProvincePixels: 2400,
            countries: [
              { tag: 'AAA', name: 'Westmarkland' },
              { tag: 'BBB', name: 'Beta' },
            ],
            development: { model: 'geography' },
            autoStraits: true,
          }),
        ],
      },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.status).toBe('ok');
    const adjacencies = (await readFile(path.join(modRoot, 'map', 'adjacencies.csv'))).toString();
    expect(adjacencies).toContain('BRIGHT_STRAIT;Bright Strait');
    expect(adjacencies).toContain(';impassable;');
    expect((await readFile(path.join(modRoot, 'map', 'adjacency_rules.txt'))).toString()).toContain(
      'name = "INNER_SEA_CANAL"',
    );
    const localisation = (
      await readFile(path.join(modRoot, 'localisation', 'replace', 'world_l_english.yml'))
    ).toString();
    expect(localisation).toContain('Westhold');
    expect(localisation).not.toMatch(/District d+/u);
  }, 180_000);

  it('checks every river without writing, and reports each failure with its divide', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    const ok = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [
          create({
            geography: reliefGeography(),
            width: 1024,
            height: 512,
            synthesisCheck: true,
          }),
        ],
      },
    });
    expect(ok.structuredContent).toMatchObject({
      status: 'ok',
      code: 'MAP_SYNTHESIS_CHECK_READY',
      data: { fileCount: 0, synthesisCheck: { passed: true, unreachableRivers: 0 } },
    });
    const walled = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [
          create({
            geography: walledGeography(),
            width: 1024,
            height: 512,
            synthesisCheck: true,
          }),
        ],
      },
    });
    const carved = walled.structuredContent as unknown as PublicResult & {
      data: {
        synthesisCheck: { carvedCrossings: number; crossings: Array<Record<string, unknown>> };
      };
    };
    expect(carved).toMatchObject({ status: 'ok', code: 'MAP_SYNTHESIS_CHECK_READY' });
    expect(carved.data.synthesisCheck.carvedCrossings).toBe(2);
    expect(carved.data.synthesisCheck.crossings.map(({ riverId }) => riverId).sort()).toEqual([
      'north_brook',
      'west_brook',
    ]);
    expect(carved.diagnostics.map(({ code }) => code)).toContain('MAP_RIVER_CARVED_CROSSING');
    const bad = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [
          create({
            geography: isolatedGeography(),
            width: 1024,
            height: 512,
            synthesisCheck: true,
          }),
        ],
      },
    });
    const content = bad.structuredContent as unknown as PublicResult & {
      data: {
        synthesisCheck: { unreachableRivers: number; rivers: Array<Record<string, unknown>> };
      };
    };
    expect(content).toMatchObject({ status: 'blocked', code: 'MAP_SYNTHESIS_CHECK_BLOCKED' });
    expect(content.data.synthesisCheck.unreachableRivers).toBe(2);
    expect(content.data.synthesisCheck.rivers.map(({ riverId }) => riverId).sort()).toEqual([
      'north_brook',
      'west_brook',
    ]);
    for (const river of content.data.synthesisCheck.rivers)
      expect(river).toMatchObject({ reason: expect.stringContaining('not reachable over land') });
    expect(content.blockers.map(({ code }) => code)).toEqual(['MAP_RIVER_UNREACHABLE_MOUTH']);
    expect(await sourceInventory(modRoot)).toEqual(before);
    // Without preview, or without a geography, the check is refused and nothing is written.
    for (const [operation, preview, code] of [
      [
        create({ geography: reliefGeography(), width: 1024, height: 512, synthesisCheck: true }),
        false,
        'MAP_SYNTHESIS_CHECK_REQUIRES_PREVIEW',
      ],
    ] as const) {
      const refused = await client.callTool({
        name: 'hoi4.map_rewrite',
        arguments: { workspaceId: 'test', preview, operations: [operation] },
      });
      expect(
        (refused.structuredContent as unknown as PublicResult).blockers.map((b) => b.code),
      ).toContain(code);
    }
    expect(await sourceInventory(modRoot)).toEqual(before);
  }, 180_000);

  it('reports only the generation blocker when a world fails over an existing map', async () => {
    const { client, modRoot } = await fixture({ emptyMod: true });
    const first = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        operations: [
          create({
            width: 512,
            height: 256,
            seed: 3,
            rivers: 0,
            countries: [{ tag: 'AAA', name: 'Aster' }],
          }),
        ],
      },
    });
    expect((first.structuredContent as unknown as PublicResult).status).toBe('ok');
    // The map being replaced has a defect of its own: a controller without an owner. It is an
    // error of the old map and must not become a blocker of the world that replaces it.
    const states = path.join(modRoot, 'history', 'states');
    const file = (await readdir(states))[0]!;
    const text = await readFile(path.join(states, file), 'utf8');
    expect(text).toContain('owner = AAA');
    await writeFile(path.join(states, file), text.replace('owner = AAA', 'controller = AAA'));
    const before = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        operations: [
          create({
            geography: isolatedGeography(),
            width: 1024,
            height: 512,
            landProvincePixels: 4000,
            seaProvincePixels: 15000,
          }),
        ],
      },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.status).toBe('blocked');
    expect([...new Set(content.blockers.map(({ code }) => code))]).toEqual([
      'MAP_RIVER_UNREACHABLE_MOUTH',
    ]);
    expect(JSON.stringify(content)).not.toContain('MAP_VALIDATION_OPERATION_UNOWNED');
    expect(JSON.stringify(content)).not.toContain('MAP_STATE_CONTROLLER_WITHOUT_OWNER');
    expect(await sourceInventory(modRoot)).toEqual(before);
  }, 180_000);

  it('blocks a write of a model with biomes because the climate stage is not implemented yet', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: { workspaceId: 'test', operations: [create({ geography: syntheticGeography() })] },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.status).toBe('blocked');
    expect(content.changedFiles).toEqual([]);
    expect(content.blockers.map(({ code }) => code)).toContain(
      'MAP_GEOGRAPHY_SYNTHESIS_UNAVAILABLE',
    );
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('blocks a write of an invalid model with its own code', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: { workspaceId: 'test', operations: [create({ geography: { version: 1 } })] },
    });
    const content = result.structuredContent as unknown as PublicResult;
    expect(content.status).toBe('blocked');
    expect(content.blockers.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['MAP_GEOGRAPHY_INVALID', 'MAP_GEOGRAPHY_NO_LAND']),
    );
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('runs the same preview as a background task with an identical result', async () => {
    const { client } = await fixture();
    const input = {
      workspaceId: 'test',
      preview: true,
      operations: [create({ geography: syntheticGeography() })],
    };
    const ordinary = await client.callTool({ name: 'hoi4.map_rewrite', arguments: input });
    const task = await completedTask(client, 'hoi4.map_rewrite', {
      ...input,
      requestKey: 'geography-preview',
    });
    expect(task.structuredContent).toEqual(ordinary.structuredContent);
  }, 60_000);

  async function failure(client: Client, operation: Record<string, unknown>, preview = true) {
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: { workspaceId: 'test', preview, operations: [operation] },
    });
    const content = result.structuredContent as unknown as { status: string; code: string };
    return { isError: result.isError, status: content.status, code: content.code };
  }

  it.each([
    ['a parent traversal', '../outside.json'],
    ['an absolute path', 'C:\\outside.json'],
    ['a non-json file', 'geography/world.txt'],
    ['an alternate data stream', 'geography/world.json:stream'],
  ])('rejects %s in geographyPath before reading anything', async (_label, geographyPath) => {
    const { client } = await fixture();
    expect(await failure(client, create({ geographyPath }))).toEqual({
      isError: true,
      status: 'error',
      code: 'INVALID_ARGUMENTS',
    });
  });

  it('rejects both sources, an unknown key and a model that fails its schema', async () => {
    const { client } = await fixture();
    const expected = { isError: true, status: 'error', code: 'INVALID_ARGUMENTS' };
    expect(
      await failure(
        client,
        create({ geography: syntheticGeography(), geographyPath: 'geography/world.json' }),
      ),
    ).toEqual(expected);
    expect(await failure(client, create({ geography: { version: 1, mountains: [] } }))).toEqual(
      expected,
    );
    expect(
      await failure(
        client,
        create({
          geography: {
            version: 1,
            lands: [
              {
                id: 'a',
                polygons: [
                  [
                    [0, 0],
                    [2, 0],
                    [0, 1],
                  ],
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual(expected);
  });

  it('refuses a model file that escapes the workspace through a junction', async () => {
    const { client, root, modRoot } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'world.json'), JSON.stringify(syntheticGeography()));
    await mkdir(path.join(modRoot, 'geography'), { recursive: true });
    await symlink(
      outside,
      path.join(modRoot, 'geography', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await failure(client, create({ geographyPath: 'geography/escape/world.json' }))).toEqual(
      {
        isError: true,
        status: 'error',
        code: 'PATH_NOT_FOUND_IN_ROOTS',
      },
    );
  });

  it('reports unusable model files as errors, never as a partial preview or write', async () => {
    const { client, modRoot } = await fixture();
    await mkdir(path.join(modRoot, 'geography'), { recursive: true });
    await writeFile(path.join(modRoot, 'geography', 'broken.json'), '{ "version": 1, ');
    await writeFile(
      path.join(modRoot, 'geography', 'wrong.json'),
      JSON.stringify({ version: 2, lands: [] }),
    );
    const before = await sourceInventory(modRoot);
    for (const preview of [true, false]) {
      expect(
        await failure(client, create({ geographyPath: 'geography/broken.json' }), preview),
      ).toEqual({ isError: true, status: 'error', code: 'MAP_GEOGRAPHY_JSON_INVALID' });
      expect(
        await failure(client, create({ geographyPath: 'geography/wrong.json' }), preview),
      ).toEqual({ isError: true, status: 'error', code: 'MAP_GEOGRAPHY_SCHEMA_INVALID' });
      expect(
        await failure(client, create({ geographyPath: 'geography/missing.json' }), preview),
      ).toMatchObject({ isError: true, status: 'error' });
    }
    expect(await sourceInventory(modRoot)).toEqual(before);
  });
});
