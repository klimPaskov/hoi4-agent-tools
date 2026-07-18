import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { registerChaosxTools } from '../../src/hoi4_agent_tools/mcp/tools/chaosx.js';

const cleanup: Array<() => Promise<void>> = [];

function decodedResource(content: { blob?: string; text?: string }): Buffer {
  if (content.blob !== undefined) return Buffer.from(content.blob, 'base64');
  if (content.text !== undefined) return Buffer.from(content.text, 'utf8');
  throw new Error('Expected MCP artifact bytes');
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

describe('ChaosX-only country assets MCP integration', () => {
  it('is gated from normal servers and returns flag and leader PNGs for ChaosX', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-chaosx-country-assets-'));
    const mod = path.join(temporary, 'mod');
    const artifactRoot = path.join(temporary, 'artifacts');
    const cacheRoot = path.join(temporary, 'cache');
    const historyPath = path.join(mod, 'history', 'countries', 'AAA - Asset Fixture.txt');
    const interfacePath = path.join(mod, 'interface', 'assets.gfx');
    const flagPath = path.join(mod, 'gfx', 'flags', 'AAA.png');
    const leaderPath = path.join(mod, 'gfx', 'leaders', 'AAA.png');
    for (const file of [historyPath, interfacePath, flagPath, leaderPath])
      await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      historyPath,
      'create_country_leader = { name = "Fixture Leader" picture = GFX_portrait_AAA_fixture ideology = despotism }\n',
    );
    await writeFile(
      interfacePath,
      'spriteTypes = { spriteType = { name = GFX_portrait_AAA_fixture texturefile = "gfx/leaders/AAA.png" } }\n',
    );
    await writeFile(
      flagPath,
      await sharp({
        create: { width: 82, height: 52, channels: 4, background: '#2448aa' },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(
      leaderPath,
      await sharp({
        create: { width: 156, height: 210, channels: 4, background: '#aa4824' },
      })
        .png()
        .toBuffer(),
    );

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      storageRoots: [artifactRoot, cacheRoot],
      workspaces: [
        {
          id: 'chaosx-assets',
          name: 'ChaosX asset fixture',
          root: mod,
          artifactRoot,
          cacheRoot,
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();

    const ordinaryServer = createMcpServer(engine);
    const ordinaryClient = new Client({ name: 'ordinary-agent-test', version: '1.0.0' });
    const [ordinaryClientTransport, ordinaryServerTransport] = InMemoryTransport.createLinkedPair();
    await ordinaryServer.connect(ordinaryServerTransport as unknown as Transport);
    await ordinaryClient.connect(ordinaryClientTransport as unknown as Transport);
    expect((await ordinaryClient.listTools()).tools.map(({ name }) => name)).not.toContain(
      'chaosx.focus_country_assets',
    );
    await ordinaryClient.close();
    await ordinaryServer.close();

    const server = createMcpServer(engine);
    registerChaosxTools(server, engine, {});
    const client = new Client({ name: 'chaosx-integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    expect((await client.listTools()).tools.map(({ name }) => name)).toContain(
      'chaosx.focus_country_assets',
    );
    const response = await client.callTool({
      name: 'chaosx.focus_country_assets',
      arguments: {
        workspaceId: 'chaosx-assets',
        countryTags: ['AAA'],
        eventId: 3,
        treeId: 'AAA_focus',
      },
    });
    const result = response.structuredContent as {
      status: string;
      code: string;
      artifacts: Array<{ name: string; uri: string; mimeType: string }>;
      data: {
        artifactCount: number;
        countries: Array<{
          tag: string;
          flagArtifactName?: string;
          leaderPortraitArtifactName?: string;
          leaderSprite?: string;
        }>;
      };
    };
    expect(result).toMatchObject({
      status: 'ok',
      code: 'CHAOSX_COUNTRY_ASSETS_RENDERED',
      data: {
        artifactCount: 2,
        countries: [
          {
            tag: 'AAA',
            flagArtifactName: 'chaosx-AAA-flag.png',
            leaderPortraitArtifactName: 'chaosx-AAA-leader.png',
            leaderSprite: 'GFX_portrait_AAA_fixture',
          },
        ],
      },
    });
    expect(result.artifacts.map(({ name }) => name)).toEqual([
      'chaosx-AAA-flag.png',
      'chaosx-AAA-leader.png',
    ]);
    for (const artifact of result.artifacts) {
      expect(artifact.mimeType).toBe('image/png');
      const resource = await client.readResource({ uri: artifact.uri });
      const content = resource.contents[0];
      if (content === undefined) throw new Error('Expected country asset resource');
      expect(decodedResource(content).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
  });
});
