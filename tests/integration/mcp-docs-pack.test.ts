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
import * as docsPack from '../../src/hoi4_agent_tools/reference/docs-pack.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

const pages: Record<string, string> = {
  'event_modding.md':
    '# Event modding\n## Firing events\nUse country_event with days to fire later.\n',
  'LICENSE.txt': 'CC BY-SA 3.0\n',
};

/** A pack as `--fetch-docs` leaves it: the pinned manifest's folder, its pages and its marker. */
async function installPack(docsRoot: string): Promise<void> {
  const folder = docsPack.docsPackFolder(docsRoot);
  await mkdir(path.join(folder, docsPack.DOCS_PACK_WIKI_FOLDER), { recursive: true });
  for (const [file, text] of Object.entries(pages))
    await writeFile(path.join(folder, docsPack.DOCS_PACK_WIKI_FOLDER, file), text);
  await writeFile(
    path.join(folder, docsPack.DOCS_PACK_MARKER_FILE),
    `${docsPack.docsPackMarker()}
`,
  );
}

async function fixture(options: {
  pack?: boolean;
  game?: boolean;
  mod?: 'none' | 'without_wiki' | 'with_wiki';
  docsRoot?: boolean;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-docs-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'game');
  const docsRoot = path.join(root, 'docs');
  const mods = path.join(root, 'mods');
  await mkdir(mods, { recursive: true });
  if (options.game !== false) {
    await mkdir(path.join(game, 'documentation'), { recursive: true });
    await writeFile(
      path.join(game, 'documentation', 'effects_documentation.md'),
      '# Effects\n## country_event\n* Supported Scopes: COUNTRY\nFires a country event.\n',
    );
  }
  if (options.pack === true) await installPack(docsRoot);
  if (options.mod !== undefined && options.mod !== 'none') {
    const mod = path.join(mods, 'my_mod');
    await mkdir(mod, { recursive: true });
    await writeFile(path.join(mod, 'descriptor.mod'), 'name="My mod"\n');
    if (options.mod === 'with_wiki') {
      await mkdir(path.join(mod, 'hoi4_wiki'));
      await writeFile(path.join(mod, 'hoi4_wiki', 'own_page.md'), '# Own page\nThe mod copy.\n');
    }
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      modRoots: [mods],
      ...(options.game === false ? {} : { gameRoot: game }),
      ...(options.docsRoot === false ? {} : { docsRoot }),
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const client = new Client({ name: 'docs-pack-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface Hit {
  id: string;
  revision: string;
  source: string;
  path: string;
}
interface SearchContent {
  status: string;
  workspaceId: string;
  diagnostics?: Array<{ code: string; message: string }>;
  data: { results: Hit[]; coverage: { wiki: { files: number; unavailable: boolean } } };
}

describe('documentation search through the docs pack', () => {
  it('answers with no mod from the game documentation and the pack', async () => {
    const client = await fixture({ pack: true, mod: 'none' });
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { query: 'fire an event' },
    });
    expect(search.isError, JSON.stringify(search.content)).not.toBe(true);
    const content = search.structuredContent as unknown as SearchContent;
    expect(content.workspaceId).toBe('docs');
    expect(content.diagnostics?.map(({ code }) => code)).toContain('REFERENCE_DOCUMENTATION_ONLY');
    const sources = content.data.results.map((hit) => `${hit.source}:${hit.path}`);
    expect(sources).toContain('wiki:event_modding.md');
    expect(sources).toContain('game_doc:documentation/effects_documentation.md');

    const hit = content.data.results.find((result) => result.source === 'wiki')!;
    const read = await client.callTool({
      name: 'hoi4.reference_read',
      arguments: { id: hit.id, revision: hit.revision },
    });
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true);
    expect((read.structuredContent as { data: { text: string } }).data.text).toContain(
      'country_event',
    );

    const named = await client.callTool({
      name: 'hoi4.reference_context',
      arguments: { workspaceId: 'docs', surface: 'event' },
    });
    expect(named.isError, JSON.stringify(named.content)).not.toBe(true);
    expect(named.structuredContent).toMatchObject({ workspaceId: 'docs' });
  });

  it('answers with no mod and no pack from the game documentation alone, naming the fix', async () => {
    const client = await fixture({ mod: 'none' });
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { query: 'country_event' },
    });
    const content = search.structuredContent as unknown as SearchContent;
    expect(content.status).toBe('ok');
    expect(content.data.coverage.wiki.unavailable).toBe(true);
    expect(content.diagnostics?.map(({ code }) => code)).toEqual([
      'REFERENCE_DOCUMENTATION_ONLY',
      'REFERENCE_WIKI_UNAVAILABLE',
    ]);
    expect(JSON.stringify(content.diagnostics)).toContain('--fetch-docs');
  });

  it('names the fetch step when there is neither a mod, a game folder nor a pack', async () => {
    const client = await fixture({ mod: 'none', game: false });
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { query: 'country_event' },
    });
    expect(search.isError).toBe(true);
    expect(search.structuredContent).toMatchObject({ code: 'WORKSPACE_CONTEXT_NOT_FOUND' });
    expect(JSON.stringify(search.content)).toContain('--fetch-docs');
  });

  it('reads the pack as the wiki of a mod that has no copy of its own', async () => {
    const client = await fixture({ pack: true, mod: 'without_wiki' });
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { query: 'fire an event', sources: ['wiki'] },
    });
    const content = search.structuredContent as unknown as SearchContent;
    expect(content.workspaceId).toMatch(/^mod_my_mod_/u);
    expect(content.data.results.map((hit) => hit.path)).toContain('event_modding.md');
  });

  it("keeps a mod's own wiki ahead of the pack", async () => {
    const client = await fixture({ pack: true, mod: 'with_wiki' });
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { query: 'mod copy', sources: ['wiki'] },
    });
    const content = search.structuredContent as unknown as SearchContent;
    expect(content.data.coverage.wiki.files).toBe(1);
    expect(content.data.results.map((hit) => hit.path)).toEqual(['own_page.md']);
  });

  it('reads no pack when no docs folder is configured', async () => {
    const client = await fixture({ pack: true, mod: 'without_wiki', docsRoot: false });
    const search = await client.callTool({
      name: 'hoi4.reference_search',
      arguments: { query: 'fire an event', sources: ['wiki'] },
    });
    const content = search.structuredContent as unknown as SearchContent;
    expect(content.data.coverage.wiki.unavailable).toBe(true);
    expect(content.diagnostics).toBeUndefined();
  });
});
