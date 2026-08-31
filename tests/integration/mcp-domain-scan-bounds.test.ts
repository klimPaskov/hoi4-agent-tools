import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

function resultOf(response: Awaited<ReturnType<Client['callTool']>>): {
  status: string;
  code: string;
} {
  return response.structuredContent as { status: string; code: string };
}

describe('domain-bounded MCP scans', () => {
  it('does not let a large unrelated GUI source break focus, probability, or map tools', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-domain-scan-bounds-'));
    const focusMod = path.join(temporary, 'focus-mod');
    const mapGame = path.join(temporary, 'map-game');
    const mapDependency = path.join(temporary, 'map-dependency');
    const mapMod = path.join(temporary, 'map-mod');
    const fixtureRoots = path.join(repositoryRoot, 'fixtures', 'map', 'roots');
    await Promise.all([
      mkdir(path.join(focusMod, 'common', 'national_focus'), { recursive: true }),
      mkdir(path.join(focusMod, 'interface'), { recursive: true }),
      mkdir(path.join(focusMod, 'common', 'technologies'), { recursive: true }),
      cp(path.join(fixtureRoots, 'game'), mapGame, { recursive: true }),
      cp(path.join(fixtureRoots, 'dependency'), mapDependency, { recursive: true }),
      cp(path.join(fixtureRoots, 'mod'), mapMod, { recursive: true }),
    ]);
    await mkdir(path.join(mapMod, 'interface'), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(focusMod, 'common', 'national_focus', 'bounded.txt'),
        [
          'focus_tree = {',
          '\tid = bounded_tree',
          '\tfocus = {',
          '\t\tid = bounded_focus',
          '\t\tx = 0',
          '\t\ty = 0',
          '\t\tai_will_do = { factor = 1 }',
          '\t}',
          '}',
          '',
        ].join('\n'),
      ),
      writeFile(path.join(focusMod, 'interface', 'unrelated.gui'), Buffer.alloc(1_048_577, 32)),
      writeFile(
        path.join(focusMod, 'common', 'technologies', 'unrelated.txt'),
        Buffer.alloc(1_048_577, 32),
      ),
      writeFile(path.join(mapMod, 'interface', 'unrelated.gui'), Buffer.alloc(1_048_577, 32)),
    ]);

    const focusArtifactRoot = path.join(temporary, 'runtime', 'focus-artifacts');
    const focusCacheRoot = path.join(temporary, 'runtime', 'focus-cache');
    const mapArtifactRoot = path.join(temporary, 'runtime', 'map-artifacts');
    const mapCacheRoot = path.join(temporary, 'runtime', 'map-cache');
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      storageRoots: [focusArtifactRoot, focusCacheRoot, mapArtifactRoot, mapCacheRoot],
      scanMaxBytes: 1_048_576,
      scanMaxFileBytes: 1_048_576,
      workspaces: [
        {
          id: 'bounded-focus',
          name: 'Bounded focus fixture',
          root: focusMod,
          artifactRoot: focusArtifactRoot,
          cacheRoot: focusCacheRoot,
        },
        {
          id: 'bounded-map',
          name: 'Bounded map fixture',
          root: mapMod,
          gameRoot: mapGame,
          dependencyRoots: [mapDependency],
          artifactRoot: mapArtifactRoot,
          cacheRoot: mapCacheRoot,
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client({ name: 'domain-scan-bounds-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const focus = resultOf(
      await client.callTool({
        name: 'hoi4.focus_inspect',
        arguments: {
          workspaceId: 'bounded-focus',
          relativePath: 'common/national_focus/bounded.txt',
          treeId: 'bounded_tree',
        },
      }),
    );
    expect(focus).toMatchObject({ status: 'ok', code: 'FOCUS_INSPECTED' });

    const probability = resultOf(
      await client.callTool({
        name: 'hoi4.probability_inspect',
        arguments: {
          workspaceId: 'bounded-focus',
          adapter: 'national_focus_ai_will_do',
          source: {
            path: 'common/national_focus/bounded.txt',
            identifier: 'bounded_focus',
          },
        },
      }),
    );
    expect(probability).toMatchObject({ status: 'ok', code: 'PROBABILITY_SOURCE_INSPECTED' });

    const map = resultOf(
      await client.callTool({
        name: 'hoi4.map_inspect',
        arguments: { workspaceId: 'bounded-map', provinceIds: [1] },
      }),
    );
    expect(map).toMatchObject({ status: 'ok', code: 'MAP_INSPECTED' });
  });
});
