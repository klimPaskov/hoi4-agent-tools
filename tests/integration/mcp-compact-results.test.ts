import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { emptyServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import {
  strictOperationResultSchema,
  toolResult,
  withoutEmptyCollections,
} from '../../src/hoi4_agent_tools/core/operation-result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { z } from 'zod/v4';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

async function referenceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-compact-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await Promise.all([
    mkdir(path.join(mod, 'hoi4_wiki'), { recursive: true }),
    mkdir(path.join(game, 'documentation'), { recursive: true }),
  ]);
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Compact test"\n');
  await writeFile(
    path.join(mod, 'hoi4_wiki', 'event_modding.md'),
    '# Event modding\n## Events\nUse country_event to fire an event.\n',
  );
  await writeFile(
    path.join(game, 'documentation', 'effects_documentation.md'),
    '# Effects\n## country_event\n* Supported Scopes: COUNTRY\nFires an event.\n',
  );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod, gameRoot: game }],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const client = new Client({ name: 'compact-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, root };
}

describe('compact tool results', () => {
  it('leaves empty collections and empty checks out of a compact result', () => {
    const output = toolResult(emptyServiceResult('fixture', { answer: 1 }), { compact: true });
    expect(output.structuredContent).toEqual({
      status: 'ok',
      code: 'OK',
      workspaceId: 'fixture',
      validation: { passed: true },
      data: { answer: 1 },
    });
    // The advertised schema accepts the compact envelope and a full one alike.
    const schema = strictOperationResultSchema(z.object({ answer: z.number() }).strict());
    expect(schema.safeParse(output.structuredContent).success).toBe(true);
    expect(
      schema.safeParse({
        ...output.structuredContent,
        filesScanned: [],
        proposedFiles: [],
        changedFiles: [],
        diagnostics: [],
        artifacts: [],
        blockers: [],
        validation: { passed: true, checks: [] },
      }).success,
    ).toBe(true);
  });

  it('keeps the full envelope unless a tool asks for the compact one', () => {
    const output = toolResult(emptyServiceResult('fixture', {}));
    expect(output.structuredContent).toMatchObject({
      filesScanned: [],
      changedFiles: [],
      diagnostics: [],
      artifacts: [],
      blockers: [],
      validation: { passed: true, checks: [] },
    });
  });

  it('keeps every collection that has entries', () => {
    const result = emptyServiceResult('fixture', {});
    result.changedFiles = ['events/a.txt'];
    result.validation = { passed: false, checks: [{ id: 'one', passed: false, message: 'm' }] };
    expect(withoutEmptyCollections(result as unknown as Record<string, unknown>)).toEqual({
      status: 'ok',
      code: 'OK',
      workspaceId: 'fixture',
      changedFiles: ['events/a.txt'],
      validation: { passed: false, checks: [{ id: 'one', passed: false, message: 'm' }] },
      data: {},
    });
  });

  it('returns search hits without absolute paths or full hashes, and reads them back', async () => {
    const { client, root } = await referenceFixture();
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { workspaceId: 'fixture', query: 'country_event' },
    });
    expect(search.isError, JSON.stringify(search.content)).not.toBe(true);
    const data = (
      search.structuredContent as {
        data: {
          results: Array<{
            id: string;
            revision: string;
            source: string;
            path: string;
            heading: string;
            title?: string;
            authority?: string;
          }>;
        };
      }
    ).data;
    expect(data.results.length).toBeGreaterThanOrEqual(2);
    // A reference tool's answer leaves its empty lists out.
    expect(search.structuredContent).not.toHaveProperty('changedFiles');
    expect(search.structuredContent).not.toHaveProperty('blockers');
    for (const hit of data.results) {
      expect(hit.id).toMatch(/^[a-f0-9]{16}$/u);
      expect(hit.revision).toMatch(/^[a-f0-9]{12}$/u);
      expect(hit.authority).toBeUndefined();
      expect(path.isAbsolute(hit.path)).toBe(false);
      expect(hit.path).not.toContain('\\');
    }
    expect(JSON.stringify(search.structuredContent)).not.toContain(
      JSON.stringify(root).slice(1, -1),
    );
    const paths = data.results.map((hit) => `${hit.source}:${hit.path}`);
    expect(paths).toContain('game_doc:documentation/effects_documentation.md');
    expect(paths).toContain('wiki:event_modding.md');

    const hit = data.results[0]!;
    const read = await client.callTool({
      name: 'hoi4.reference_read',
      arguments: { workspaceId: 'fixture', id: hit.id, revision: hit.revision, maxLines: 8 },
    });
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true);
    expect((read.structuredContent as { data: { text: string } }).data.text).toContain(
      'country_event',
    );

    // A changed source is still caught through the short revision.
    const stale = await client.callTool({
      name: 'hoi4.reference_read',
      arguments: { workspaceId: 'fixture', id: hit.id, revision: '000000000000' },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ code: 'REFERENCE_REVISION_STALE' });

    const context = await client.callTool({
      name: 'hoi4.reference_context',
      arguments: { workspaceId: 'fixture', surface: 'event', limit: 2 },
    });
    const sections = (
      context.structuredContent as { data: { sections: Array<{ id: string; path: string }> } }
    ).data.sections;
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.id).toMatch(/^[a-f0-9]{16}$/u);
      expect(path.isAbsolute(section.path)).toBe(false);
    }
  });
});
