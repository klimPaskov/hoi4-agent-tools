import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

describe('MCP local reference tools', () => {
  it('returns cited sections and exact source blocks through a client', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-mcp-'));
    close.push(() => rm(root, { recursive: true, force: true }));
    const mod = path.join(root, 'mod');
    const game = path.join(root, 'game');
    await Promise.all([
      mkdir(path.join(mod, 'paradox_wiki'), { recursive: true }),
      mkdir(path.join(mod, 'events'), { recursive: true }),
      mkdir(path.join(game, 'documentation'), { recursive: true }),
    ]);
    await writeFile(path.join(mod, 'descriptor.mod'), 'name="Reference test"\n');
    await writeFile(
      path.join(mod, 'paradox_wiki', 'Event modding - Hearts of Iron 4 Wiki.md'),
      '# Event modding\n## Events\nUse country_event.\n',
    );
    await writeFile(
      path.join(game, 'documentation', 'effects_documentation.md'),
      '# Effects\n## country_event\nFires an event.\n',
    );
    await writeFile(
      path.join(mod, 'events', 'test.txt'),
      'country_event = { id = reference.1 title = reference.1.t }\n',
    );
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [{ id: 'fixture', name: 'Fixture', root: mod, gameRoot: game }],
      }),
    );
    const server = createMcpServer(new CoreEngine(resolver));
    const client = new Client({ name: 'reference-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(async () => {
      await client.close();
      await server.close();
    });

    const listed = await client.listTools();
    for (const name of [
      'hoi4.reference_search',
      'hoi4.reference_read',
      'hoi4.reference_context',
      'hoi4.source_lookup',
    ]) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { workspaceId: 'fixture', query: 'country_event' },
    });
    expect(search.isError).not.toBe(true);
    const searchData = (
      search.structuredContent as {
        data: {
          results: Array<{ id: string; revision: string }>;
        };
      }
    ).data;
    expect(searchData.results.length).toBeGreaterThanOrEqual(1);
    const read = await client.callTool({
      name: 'hoi4.reference_read',
      arguments: {
        workspaceId: 'fixture',
        id: searchData.results[0]!.id,
        revision: searchData.results[0]!.revision,
        maxLines: 8,
      },
    });
    expect((read.structuredContent as { data: { text: string } }).data.text).toContain(
      'country_event',
    );
    const context = await client.callTool({
      name: 'hoi4.reference_context',
      arguments: { workspaceId: 'fixture', surface: 'event' },
    });
    expect(
      (context.structuredContent as { data: { sections: unknown[] } }).data.sections.length,
    ).toBeGreaterThan(0);
    const source = await client.callTool({
      name: 'hoi4.source_lookup',
      arguments: { workspaceId: 'fixture', symbol: 'reference.1', kind: 'event' },
    });
    expect(
      (source.structuredContent as { data: { definitionCount: number } }).data.definitionCount,
    ).toBe(1);
  });
});
