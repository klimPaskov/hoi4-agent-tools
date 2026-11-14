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

/**
 * Tools whose analysis builds the shared symbol index (ADR 0085) need the engine. Without one (no bundle for the platform, or
 * `HOI4_ENGINE` naming a missing file) each answers `ENGINE_UNAVAILABLE` with a message that
 * names the engine, instead of crashing or answering from TypeScript.
 */

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

async function write(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function clientWithoutEngine() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-index-engine-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  await write(path.join(mod, 'descriptor.mod'), 'name="Engine fixture"\n');
  await write(
    path.join(mod, 'common', 'decisions', 'a.txt'),
    'category_a = { decision_a = { cost = 10 } }\n',
  );
  await write(
    path.join(mod, 'common', 'technologies', 'a.txt'),
    'technologies = { tech_a = { research_cost = 1 } }\n',
  );
  const previous = process.env.HOI4_ENGINE;
  process.env.HOI4_ENGINE = path.join(root, 'no-such-engine', 'hoi4-engine.exe');
  close.push(async () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'HOI4_ENGINE');
    else process.env.HOI4_ENGINE = previous;
  });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod }],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const mcp = new Client({ name: 'index-engine-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return mcp;
}

describe('tools on the shared engine without an engine', () => {
  for (const [tool, args] of [
    ['hoi4.decision_inspect', { mode: 'inventory' }],
    ['hoi4.tech_inspect', { mode: 'explain', technologyId: 'tech_a' }],
    ['hoi4.impact_inspect', { symbols: [{ kind: 'decision', id: 'decision_a' }] }],
    [
      'hoi4.package_check',
      {
        manifest: {
          schemaVersion: '1.0',
          id: 'fixture_package',
          definitions: [{ kind: 'decision', id: 'decision_a' }],
        },
      },
    ],
  ] as const)
    it(`${tool} answers ENGINE_UNAVAILABLE`, async () => {
      const mcp = await clientWithoutEngine();
      const result = await mcp.callTool({
        name: tool,
        arguments: { workspaceId: 'fixture', ...args },
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
      expect(JSON.stringify(result.structuredContent)).toMatch(/hoi4-engine|HOI4_ENGINE/u);
    });
});
