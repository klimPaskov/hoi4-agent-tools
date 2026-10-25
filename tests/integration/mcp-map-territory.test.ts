import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

/**
 * assign_territory over the in-memory MCP transport, on the project-owned map fixture: two land
 * states (1 in the game root, 2 in a dependency) and an empty mod state.
 */
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-map-territory-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = path.resolve('fixtures', 'map', 'roots');
  for (const kind of ['mod', 'game', 'dependency'])
    await cp(path.join(fixtureRoot, kind), path.join(root, kind), { recursive: true });
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
            name: 'Map territory fixture',
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
  const client = new Client({ name: 'map-territory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, modRoot: path.join(root, 'mod') };
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

interface PublicResult {
  status: string;
  code: string;
  changedFiles: string[];
  data: {
    execution?: string;
    territory?: Array<Record<string, unknown>>;
  };
  artifacts: Array<{ name: string; mimeType: string; uri: string }>;
  blockers: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  diagnostics: Array<{ code: string; severity: string }>;
}

const territory = (extra: Record<string, unknown> = {}) => ({
  id: 'politics',
  kind: 'assign_territory',
  seed: 1,
  countries: [
    { tag: 'DDD', seeds: [{ state: 1 }] },
    { tag: 'EEE', seeds: [{ province: 2 }] },
  ],
  ownership: { cores: 'owner' },
  ...extra,
});

async function rewrite(
  client: Client,
  operations: unknown[],
  preview = false,
): Promise<{ isError: boolean | undefined; content: PublicResult }> {
  const result = await client.callTool({
    name: 'hoi4.map_rewrite',
    arguments: { workspaceId: 'test', ...(preview ? { preview: true } : {}), operations },
  });
  return {
    isError: result.isError as boolean | undefined,
    content: result.structuredContent as unknown as PublicResult,
  };
}

describe('assign_territory through hoi4.map_rewrite', () => {
  it('previews the assignment with its territory report and touches nothing', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    const { content } = await rewrite(client, [territory()], true);
    expect(content.status).toBe('ok');
    expect(content.changedFiles).toEqual([]);
    expect(content.data.territory).toEqual([
      expect.objectContaining({ operationId: 'politics', kind: 'assign_territory', unit: 'state' }),
    ]);
    expect(content.diagnostics.map(({ code }) => code)).toContain('MAP_TERRITORY_ASSIGNED');
    expect(JSON.stringify(content)).not.toMatch(/transactionId|planHash/u);
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('writes owners, controllers and cores in one call and reports the artifact', async () => {
    const { client, modRoot } = await fixture();
    const { content } = await rewrite(client, [territory()]);
    expect(content.status).toBe('ok');
    expect([...content.changedFiles].sort()).toEqual([
      'history/states/1-GAME.txt',
      'history/states/2-DEPENDENCY.txt',
    ]);
    expect(content.artifacts.map(({ name }) => name)).toContain('map-territory-report.json');
    const first = await readFile(path.join(modRoot, 'history', 'states', '1-GAME.txt'), 'utf8');
    const second = await readFile(
      path.join(modRoot, 'history', 'states', '2-DEPENDENCY.txt'),
      'utf8',
    );
    expect(first).toMatch(/owner = DDD/u);
    expect(first).toMatch(/add_core_of = DDD/u);
    // Comments and unknown blocks of the source survive the targeted edit.
    expect(first).toContain('# Project-owned game-root state');
    expect(first).toContain('unknown_fixture_block = { preserve = yes }');
    expect(second).toMatch(/owner = EEE/u);
    expect(second).not.toMatch(/owner = BBB/u);
    // The empty mod state has no land and is left as it was.
    expect(await readFile(path.join(modRoot, 'history', 'states', '5-MOD.txt'), 'utf8')).toContain(
      'owner = CCC',
    );
    // A second identical call changes nothing.
    const again = await rewrite(client, [territory()]);
    expect(again.content.status).not.toBe('error');
    expect(again.content.changedFiles).toEqual([]);
  });

  it('blocks unknown states, water seeds and contradictory land without writing', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        territory({
          countries: [
            { tag: 'DDD', seeds: [{ state: 1 }] },
            { tag: 'EEE', seeds: [{ state: 99_999 }] },
          ],
        }),
        'MAP_TERRITORY_STATE_UNKNOWN',
      ],
      [
        territory({
          countries: [
            { tag: 'DDD', seeds: [{ state: 1 }] },
            { tag: 'EEE', seeds: [{ x: 1_000_000, y: 0 }] },
          ],
        }),
        'MAP_TERRITORY_POINT_OUTSIDE_MAP',
      ],
      [
        territory({
          countries: [
            { tag: 'DDD', seeds: [{ state: 1 }], blocked: { stateIds: [1] } },
            { tag: 'EEE', seeds: [{ state: 2 }] },
          ],
        }),
        'MAP_TERRITORY_FORCED_BLOCKED',
      ],
      [
        territory({
          countries: [
            { tag: 'DDD', seeds: [{ state: 1 }], forced: { stateIds: [2] } },
            { tag: 'EEE', seeds: [{ state: 2 }] },
          ],
        }),
        'MAP_TERRITORY_FORCED_CONFLICT',
      ],
      [territory({ unowned: { stateIds: [2] } }), 'MAP_TERRITORY_SEED_UNAVAILABLE'],
    ];
    for (const [operation, code] of cases) {
      const { content } = await rewrite(client, [operation]);
      expect(content.status, code).toBe('blocked');
      expect(content.blockers.map((blocker) => blocker.code)).toContain(code);
      expect(content.changedFiles).toEqual([]);
    }
    const unavailable = await rewrite(client, [territory({ unowned: { stateIds: [2] } })]);
    expect(unavailable.content.blockers[0]!.message).toMatch(/^State 2 /u);
    expect(await sourceInventory(modRoot)).toEqual(before);
  });

  it('rejects arguments outside the schema as invalid', async () => {
    const { client, modRoot } = await fixture();
    const before = await sourceInventory(modRoot);
    for (const operation of [
      territory({ countries: [{ tag: 'ddd', seeds: [{ state: 1 }] }] }),
      territory({ countries: [{ tag: 'DDD', seeds: [] }] }),
      territory({ countries: [{ tag: 'DDD', seeds: [{ state: 1 }], weight: -1 }] }),
      territory({ unit: 'region' }),
      territory({ transactionId: 'abc' }),
    ]) {
      const { isError, content } = await rewrite(client, [operation]);
      expect({ isError, status: content.status, code: content.code }).toEqual({
        isError: true,
        status: 'error',
        code: 'INVALID_ARGUMENTS',
      });
    }
    expect(await sourceInventory(modRoot)).toEqual(before);
  });
});
