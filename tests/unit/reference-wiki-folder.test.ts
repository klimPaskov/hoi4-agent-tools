import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ReferenceService } from '../../src/hoi4_agent_tools/reference/service.js';
import {
  referenceContextRequestSchema,
  referenceSearchRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A mod whose wiki pages sit in each named folder (the kit renamed `paradox_wiki` to `hoi4_wiki`). */
async function modWith(folders: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-wiki-folder-')));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod, { recursive: true });
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Wiki folder test"\n');
  const pages: Record<string, string> = {};
  for (const [folder, marker] of Object.entries(folders)) {
    await mkdir(path.join(mod, folder), { recursive: true });
    const page = path.join(mod, folder, 'event_modding.md');
    await writeFile(
      page,
      `# Event modding\n## Events\nThe ${marker} wiki explains country_event.\n`,
    );
    pages[folder] = page;
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod }],
    }),
  );
  return { workspace: resolver.get('fixture'), pages };
}

const search = (workspace: Awaited<ReturnType<typeof modWith>>['workspace'], query: string) =>
  new ReferenceService().search(
    workspace,
    referenceSearchRequestSchema.parse({ workspaceId: 'fixture', query }),
  );

describe('the kit wiki folder name', () => {
  it('reads hoi4_wiki/ and labels the hits as the kit wiki', async () => {
    const { workspace, pages } = await modWith({ hoi4_wiki: 'renamed' });
    const found = await search(workspace, 'renamed');
    expect(found.coverage.wiki.unavailable).toBe(false);
    expect(found.results.map(({ path: source }) => source)).toContain(pages.hoi4_wiki);
    expect(found.results.find(({ source }) => source === 'wiki')?.authority).toBe(
      'HOI4 wiki (kit)',
    );
  });

  it('still reads paradox_wiki/ in a mod the kit has not updated', async () => {
    const { workspace, pages } = await modWith({ paradox_wiki: 'legacy' });
    const found = await search(workspace, 'legacy');
    expect(found.coverage.wiki.unavailable).toBe(false);
    expect(found.results.map(({ path: source }) => source)).toContain(pages.paradox_wiki);
    expect(found.results.find(({ source }) => source === 'wiki')?.authority).toBe(
      'HOI4 wiki (kit)',
    );
  });

  it('prefers hoi4_wiki/ and does not mix in a leftover paradox_wiki/', async () => {
    const { workspace, pages } = await modWith({ hoi4_wiki: 'current', paradox_wiki: 'stale' });
    const current = await search(workspace, 'current');
    expect(current.results.map(({ path: source }) => source)).toEqual([pages.hoi4_wiki]);
    const stale = await search(workspace, 'stale');
    expect(stale.results.map(({ path: source }) => source)).not.toContain(pages.paradox_wiki);
  });

  it('reports the wiki unavailable when the mod has neither folder', async () => {
    const { workspace } = await modWith({});
    const context = await new ReferenceService().context(
      workspace,
      referenceContextRequestSchema.parse({ workspaceId: 'fixture', surface: 'event' }),
    );
    expect(context.coverage.wiki.unavailable).toBe(true);
    expect(context.sections.some(({ source }) => source === 'wiki')).toBe(false);
  });
});
