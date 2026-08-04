import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((callback) => callback()));
});

describe('MCP client workspace roots', () => {
  it.each([
    ['the active Ireland root', 'ireland'],
    ['a stale Slop Redux root with Ireland source', 'slop'],
  ])('routes Ireland focus inspection from %s', async (_label, advertisedRoot) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-client-roots-'));
    const mods = path.join(temporary, 'mods');
    const slop = path.join(mods, 'slop_redux');
    const ireland = path.join(mods, 'ireland_total_overhaul');
    const relativePath = 'common/national_focus/ireland_focus_tree.txt';
    await Promise.all([
      mkdir(path.join(slop, 'common', 'national_focus'), { recursive: true }),
      mkdir(path.dirname(path.join(ireland, relativePath)), { recursive: true }),
    ]);
    await writeFile(
      path.join(ireland, relativePath),
      'focus_tree = { id = ireland_tree focus = { id = ireland_root x = 0 y = 0 } }\n',
    );

    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state'),
        workspaceStorageRoot: path.join(temporary, 'storage'),
        modRoots: [mods],
      }),
    );
    const engine = new CoreEngine(resolver);
    await engine.initialize();
    const server = createMcpServer(engine);
    const client = new Client(
      { name: 'ireland-root-client', version: '1.0.0' },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [
        {
          uri: pathToFileURL(advertisedRoot === 'ireland' ? ireland : slop).href,
          name: advertisedRoot === 'ireland' ? 'Ireland Total Overhaul' : 'Slop Redux',
        },
      ],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(temporary, { recursive: true, force: true }),
    );

    const called = await client.callTool({
      name: 'hoi4.focus_inspect',
      arguments: { relativePath },
    });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({
      status: 'ok',
      code: 'FOCUS_INSPECTED',
      workspaceId: expect.stringMatching(/^mod_ireland_total_overhaul_/u),
    });
  });
});
