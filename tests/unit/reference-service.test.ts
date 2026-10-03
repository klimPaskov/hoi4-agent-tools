import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { ReferenceService } from '../../src/hoi4_agent_tools/reference/service.js';
import { readBoundedLines } from '../../src/hoi4_agent_tools/reference/lines.js';
import { sourceLookup } from '../../src/hoi4_agent_tools/reference/source-lookup.js';
import {
  referenceContextRequestSchema,
  referenceReadRequestSchema,
  referenceSearchRequestSchema,
  sourceLookupRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-reference-')));
  roots.push(root);
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await mkdir(path.join(mod, 'paradox_wiki'), { recursive: true });
  await mkdir(path.join(mod, 'events'), { recursive: true });
  await mkdir(path.join(mod, 'common', 'on_actions'), { recursive: true });
  await mkdir(path.join(game, 'documentation'), { recursive: true });
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Reference test"\n');
  const wiki = path.join(mod, 'paradox_wiki', 'Event modding - Hearts of Iron 4 Wiki.md');
  const gameDoc = path.join(game, 'documentation', 'effects_documentation.md');
  await writeFile(
    wiki,
    '# Event modding\nIntro.\n## Events\nUse country_event for an event.\n## Options\nEach option has effects.\n',
  );
  await writeFile(
    gameDoc,
    '# Effects\n## country_event\nThe installed game documents country_event.\n',
  );
  await writeFile(
    path.join(mod, 'events', 'reference.txt'),
    'country_event = {\n id = reference.1\n title = reference.1.t\n}\n',
  );
  await writeFile(
    path.join(mod, 'common', 'on_actions', 'reference.txt'),
    'on_actions = { on_startup = { effect = { country_event = { id = reference.1 } } } }\n',
  );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod, gameRoot: game }],
    }),
  );
  return { workspace: resolver.get('fixture'), resolver, wiki, gameDoc, mod, game };
}

describe('bounded local HOI4 references', () => {
  it('returns canonical citations through a configured directory alias', async () => {
    const { mod, game, wiki } = await fixture();
    const root = path.dirname(mod);
    const alias = path.join(root, 'mod-alias');
    await symlink(mod, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'alias-state'),
        workspaces: [{ id: 'alias', name: 'Aliased source', root: alias, gameRoot: game }],
      }),
    );
    const result = await new ReferenceService().search(
      resolver.get('alias'),
      referenceSearchRequestSchema.parse({
        workspaceId: 'alias',
        query: 'country_event',
      }),
    );
    expect(result.results.map(({ path: source }) => source)).toContain(wiki);
    for (const section of result.results) expect(section.path).toBe(await realpath(section.path));
  });

  it('searches actual wiki and installed documentation with exact source spans', async () => {
    const { workspace, wiki, gameDoc } = await fixture();
    const service = new ReferenceService();
    const result = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({ query: 'country_event', workspaceId: 'fixture' }),
    );
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.results.map(({ path: source }) => source)).toContain(wiki);
    expect(result.results.map(({ path: source }) => source)).toContain(gameDoc);
    for (const section of result.results) {
      const lines = (await readFile(section.path, 'utf8')).split('\n');
      expect(
        lines
          .slice(section.startLine - 1, section.endLine)
          .join('\n')
          .toLowerCase(),
      ).toContain('country_event');
      expect(section.excerpt.length).toBeLessThanOrEqual(300);
    }
    expect(result.coverage.wiki.files).toBe(1);
    expect(result.coverage.game_doc.files).toBe(1);
    expect(result.coverage.script_doc.unavailable).toBe(true);
  });

  it('reads only a section and rejects a stale source revision', async () => {
    const { workspace, wiki } = await fixture();
    const service = new ReferenceService();
    const found = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({ query: 'Each option', workspaceId: 'fixture' }),
    );
    expect(found.results.map(({ path: source }) => source)).toContain(wiki);
    const section = found.results.find((result) => result.path === wiki)!;
    const input = referenceReadRequestSchema.parse({
      workspaceId: 'fixture',
      id: section.id,
      revision: section.revision,
      maxLines: 1,
    });
    const first = await service.read(workspace, input);
    expect(first.text).toContain('## Options');
    expect(first.nextLine).toBeDefined();
    const second = await service.read(workspace, { ...input, startLine: first.nextLine! });
    expect(second.text).toContain('Each option');
    await writeFile(
      wiki,
      '# Event modding\nIntro changed.\n## Events\nUse country_event for an event.\n## Options\nEach option has effects.\n',
    );
    await expect(service.read(workspace, input)).rejects.toMatchObject({
      code: 'REFERENCE_REVISION_STALE',
    });
  });

  it('continues an unusually long source line without a silent response truncation', () => {
    const line = 'A'.repeat(19_000) + '✓';
    let position = { nextLine: 10 as number | null, nextColumn: 1 as number | null };
    let collected = '';
    while (position.nextLine !== null) {
      const part = readBoundedLines(
        [line],
        10,
        position.nextLine,
        position.nextColumn ?? 1,
        80,
        8_000,
      );
      expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(8_000);
      collected += part.text;
      position = part;
    }
    expect(collected).toBe(line);
  });

  it('rejects unknown citation IDs and invalid read positions', async () => {
    const { workspace } = await fixture();
    const service = new ReferenceService();
    await expect(
      service.read(
        workspace,
        referenceReadRequestSchema.parse({
          workspaceId: 'fixture',
          id: '0'.repeat(64),
          revision: '0'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_SECTION_UNKNOWN' });
    const search = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({ workspaceId: 'fixture', query: 'country_event' }),
    );
    const section = search.results[0]!;
    await expect(
      service.read(
        workspace,
        referenceReadRequestSchema.parse({
          workspaceId: 'fixture',
          id: section.id,
          revision: section.revision,
          startLine: section.endLine + 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_POSITION_OUTSIDE_SECTION' });
  });

  it('refuses an unregistered wiki-root link outside the workspace', async () => {
    const { workspace, mod } = await fixture();
    const wikiRoot = path.join(mod, 'paradox_wiki');
    const external = path.join(path.dirname(mod), 'private_docs');
    await mkdir(external);
    await writeFile(path.join(external, 'secret.md'), '# Private\nNot registered.\n');
    await rm(wikiRoot, { recursive: true });
    await symlink(external, wikiRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      new ReferenceService().search(
        workspace,
        referenceSearchRequestSchema.parse({ workspaceId: 'fixture', query: 'Private' }),
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_ROOT_ESCAPE' });
  });

  it('reports missing and oversized references instead of claiming complete coverage', async () => {
    const { workspace, mod } = await fixture();
    await writeFile(path.join(mod, 'paradox_wiki', 'oversized.md'), 'x'.repeat(2_000_001));
    const service = new ReferenceService();
    const found = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({ workspaceId: 'fixture', query: 'country_event' }),
    );
    expect(found.skipped).toBe(1);
    await rm(path.join(mod, 'paradox_wiki'), { recursive: true });
    const missing = await service.context(
      workspace,
      referenceContextRequestSchema.parse({ workspaceId: 'fixture', surface: 'event' }),
    );
    expect(missing.coverage.wiki.unavailable).toBe(true);
    expect(missing.missing).toContain('Event modding');
    expect(missing.sections.some(({ source }) => source === 'wiki')).toBe(false);
    const { gameRoot: _gameRoot, ...withoutGame } = workspace;
    const noGame = await service.context(
      withoutGame,
      referenceContextRequestSchema.parse({ workspaceId: 'fixture', surface: 'event' }),
    );
    expect(noGame.coverage.game_doc.unavailable).toBe(true);
  });

  it('returns required source citations and reports absent pages', async () => {
    const { workspace } = await fixture();
    const result = await new ReferenceService().context(
      workspace,
      referenceContextRequestSchema.parse({ workspaceId: 'fixture', surface: 'event' }),
    );
    expect(result.sections.some(({ title }) => title === 'Event modding')).toBe(true);
    expect(result.sections.some(({ source }) => source === 'game_doc')).toBe(true);
    expect(result.missing).toContain('Data structures');
    expect(result.sections.length).toBeLessThanOrEqual(16);
    const focused = await new ReferenceService().context(
      workspace,
      referenceContextRequestSchema.parse({
        workspaceId: 'fixture',
        surface: 'event',
        question: 'country_event',
      }),
    );
    expect(focused.sections[0]?.heading).toBe('country_event');
  });

  it('retains installed documentation when matching wiki sections exhaust a compact context', async () => {
    const { workspace, mod, game } = await fixture();
    const topics = [
      'Interface modding',
      'Scripted GUI modding',
      'Graphical asset modding',
      'Localisation',
      'Scopes',
    ];
    for (const title of topics) {
      await writeFile(
        path.join(mod, 'paradox_wiki', `${title} - Hearts of Iron 4 Wiki.md`),
        `# ${title}\nIntroduction.\n` +
          (title === 'Scripted GUI modding'
            ? Array.from(
                { length: 5 },
                (_, index) =>
                  `## Click effects and triggers ${index}\nScripted GUI click effects and triggers.\n`,
              ).join('')
            : ''),
      );
    }
    const nativeDirectory = path.join(game, 'common', 'scripted_guis');
    await mkdir(nativeDirectory, { recursive: true });
    const nativeDocumentation = path.join(nativeDirectory, '_documentation.md');
    await writeFile(
      nativeDocumentation,
      '# Native callback documentation\nRegistered callbacks.\n',
    );
    const result = await new ReferenceService().context(
      workspace,
      referenceContextRequestSchema.parse({
        workspaceId: 'fixture',
        surface: 'gui',
        question: 'scripted GUI click effects triggers',
        limit: 8,
      }),
    );
    expect(result.sections.map(({ path: source }) => source)).toContain(nativeDocumentation);
    expect(result.sections.some(({ source }) => source === 'wiki')).toBe(true);
    expect(result.sections).toHaveLength(8);
    expect(result.missing).toEqual([]);
    expect(result.omittedSources).toEqual([]);
    expect(result.omitted).toBeGreaterThan(0);

    for (const question of [undefined, 'scripted GUI click effects triggers']) {
      const service = new ReferenceService();
      const single = await service.context(
        workspace,
        referenceContextRequestSchema.parse({ surface: 'gui', question, limit: 1 }),
      );
      expect(single.sections.map(({ source }) => source)).toEqual(['game_doc']);
      expect(single.omittedSources).toEqual(topics);
      expect(single.missing).toEqual([]);
      const pair = await service.context(
        workspace,
        referenceContextRequestSchema.parse({ surface: 'gui', question, limit: 2 }),
      );
      expect(pair.sections.map(({ source }) => source)).toEqual(['game_doc', 'wiki']);
      expect(pair.omittedSources).toHaveLength(4);
      expect(pair.omittedSources).not.toContain('common/scripted_guis/_documentation');
      expect(pair.missing).toEqual([]);
    }

    await rm(nativeDocumentation);
    const missingNative = await new ReferenceService().context(
      workspace,
      referenceContextRequestSchema.parse({ surface: 'gui', limit: 1 }),
    );
    expect(missingNative.sections.map(({ source }) => source)).toEqual(['wiki']);
    expect(missingNative.missing).toEqual(['common/scripted_guis/_documentation']);
    expect(missingNative.omittedSources).not.toContain('common/scripted_guis/_documentation');
  });

  it('reopens the same citation after unrelated retrieval without carrying a page in conversation state', async () => {
    const { workspace } = await fixture();
    const service = new ReferenceService();
    const input = referenceSearchRequestSchema.parse({
      workspaceId: 'fixture',
      query: 'country_event',
    });
    const first = await service.search(workspace, input);
    await service.context(
      workspace,
      referenceContextRequestSchema.parse({ workspaceId: 'fixture', surface: 'decision' }),
    );
    const second = await service.search(workspace, input);
    expect(second.results.map(({ id, revision }) => ({ id, revision }))).toEqual(
      first.results.map(({ id, revision }) => ({ id, revision })),
    );
    const selected = first.results[0]!;
    const read = await service.read(
      workspace,
      referenceReadRequestSchema.parse({
        workspaceId: 'fixture',
        id: selected.id,
        revision: selected.revision,
        maxLines: 8,
      }),
    );
    expect(read.text).toContain('country_event');
    const reopened = await new ReferenceService().read(
      workspace,
      referenceReadRequestSchema.parse({
        workspaceId: 'fixture',
        id: selected.id,
        revision: selected.revision,
        maxLines: 8,
      }),
    );
    expect(reopened.text).toBe(read.text);
    expect(reopened.source).toEqual(read.source);
  });

  it('looks up an exact indexed symbol with a bounded source block', async () => {
    const { resolver } = await fixture();
    const engine = new CoreEngine(resolver);
    const input = sourceLookupRequestSchema.parse({
      workspaceId: 'fixture',
      symbol: 'reference.1',
      kind: 'event',
      maxLines: 2,
    });
    const result = await sourceLookup(engine, 'fixture', input);
    expect(result.definitionCount).toBe(1);
    expect(result.definitions[0]).toMatchObject({ kind: 'event', id: 'reference.1', fromLine: 1 });
    expect(result.definitions[0]?.text.split('\n')).toHaveLength(2);
    expect(result.definitions[0]?.nextLine).toBe(3);
    expect(result.referenceCount).toBeGreaterThanOrEqual(1);
    expect(result.sourceScope).toBe('event_consumers');
    expect(
      result.references.some(({ path: source }) =>
        source.includes('common/on_actions/reference.txt'),
      ),
    ).toBe(true);
    const bounded = await sourceLookup(engine, 'fixture', { ...input, maxReferences: 0 });
    expect(bounded.references).toEqual([]);
    expect(bounded.referencesTruncated).toBe(true);
    await expect(
      sourceLookup(engine, 'fixture', { ...input, expectedRevision: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'SOURCE_REVISION_STALE' });
  });

  it('retains event consumers in focus rewards, decisions, helpers and scripted GUI effects', async () => {
    const { resolver, mod } = await fixture();
    const sources = [
      [
        'common/national_focus/consumer.txt',
        'focus_tree = { id = consumers focus = { id = consumer_focus x = 0 y = 0 completion_reward = { country_event = { id = reference.1 } } } }',
      ],
      [
        'common/decisions/consumer.txt',
        'consumer_category = { consumer_decision = { complete_effect = { country_event = { id = reference.1 } } } }',
      ],
      [
        'common/scripted_effects/consumer.txt',
        'consumer_helper = { country_event = { id = reference.1 } }',
      ],
      [
        'common/scripted_guis/consumer.txt',
        'scripted_gui = { consumer_gui = { context_type = player_context effects = { consumer_click = { country_event = { id = reference.1 } } } } }',
      ],
    ] as const;
    for (const [relative, text] of sources) {
      await mkdir(path.dirname(path.join(mod, relative)), { recursive: true });
      await writeFile(path.join(mod, relative), text);
    }
    const result = await sourceLookup(
      new CoreEngine(resolver),
      'fixture',
      sourceLookupRequestSchema.parse({
        workspaceId: 'fixture',
        symbol: 'reference.1',
        kind: 'event',
        maxReferences: 20,
      }),
    );
    for (const [relative] of sources)
      expect(result.references.some(({ path: source }) => source.endsWith(relative))).toBe(true);
    expect(result.sourceScope).toBe('event_consumers');
  });

  it('scans only explicitly selected authorities and labels unselected coverage', async () => {
    const { workspace } = await fixture();
    const result = await new ReferenceService().search(
      workspace,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'country_event',
        sources: ['game_doc'],
      }),
    );
    expect(result.results.every(({ source }) => source === 'game_doc')).toBe(true);
    expect(result.coverage.game_doc.included).toBe(true);
    expect(result.coverage.wiki).toMatchObject({ included: false, files: 0 });
  });

  it('uses the citation authority hint without treating another authority as a substitute', async () => {
    const { workspace } = await fixture();
    const service = new ReferenceService();
    const found = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'country_event',
        sources: ['game_doc'],
      }),
    );
    const section = found.results[0]!;
    const input = referenceReadRequestSchema.parse({
      workspaceId: 'fixture',
      id: section.id,
      revision: section.revision,
      source: section.source,
    });
    expect((await new ReferenceService().read(workspace, input)).source).toBe('game_doc');
    await expect(service.read(workspace, { ...input, source: 'wiki' })).rejects.toMatchObject({
      code: 'REFERENCE_SECTION_UNKNOWN',
    });
  });

  it('decodes BOM-marked generated text and recognizes uppercase log filenames', async () => {
    const { workspace, mod } = await fixture();
    await mkdir(path.join(mod, 'script_docs'));
    await writeFile(
      path.join(mod, 'script_docs', 'EFFECT_DOCS.LOG'),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('generated_command\n\tSupported Scopes: COUNTRY\n', 'utf16le'),
      ]),
    );
    const service = new ReferenceService();
    const found = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'generated_command',
        sources: ['script_doc'],
      }),
    );
    expect(found.results[0]?.heading).toBe('generated_command');
    const section = found.results[0]!;
    const read = await service.read(
      workspace,
      referenceReadRequestSchema.parse({
        workspaceId: 'fixture',
        id: section.id,
        revision: section.revision,
      }),
    );
    expect(read.text).toContain('Supported Scopes: COUNTRY');
  });

  it('preserves heavily escaped text across bounded JSON pages', async () => {
    const { workspace, wiki } = await fixture();
    const content = `# Event modding\n${'\0'.repeat(12_000)}`;
    await writeFile(wiki, content);
    const service = new ReferenceService();
    const found = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'Event modding',
        sources: ['wiki'],
      }),
    );
    const section = found.results[0]!;
    const options = referenceReadRequestSchema.parse({
      workspaceId: 'fixture',
      id: section.id,
      revision: section.revision,
      source: 'wiki',
    });
    const pages: string[] = [];
    for (let page = 0; page < 30; page++) {
      const read = await service.read(workspace, options);
      expect(Buffer.byteLength(JSON.stringify(read.text))).toBeLessThanOrEqual(8192);
      pages.push(read.text);
      if (read.nextLine === null) break;
      options.startLine = read.nextLine;
      options.startColumn = read.nextColumn!;
    }
    expect(pages.join('')).toBe(content);
  });

  it('reports metadata omitted by byte limits while preserving primary authorities', async () => {
    const { workspace, mod, game } = await fixture();
    const heading = '\0'.repeat(512);
    for (const title of ['Data structures', 'Triggers', 'Effects', 'Modifiers', 'Scopes'])
      await writeFile(
        path.join(mod, 'paradox_wiki', `${title} - Hearts of Iron 4 Wiki.md`),
        `# ${heading}\nNative reference topic.\n`,
      );
    const searchFile = path.join(mod, 'paradox_wiki', 'Event modding - Hearts of Iron 4 Wiki.md');
    await writeFile(
      searchFile,
      Array.from({ length: 12 }, () => `## ${heading}\nevent rule\n`).join(''),
    );
    for (const name of ['script_concept', 'effects', 'triggers', 'modifiers'])
      await writeFile(
        path.join(game, 'documentation', `${name}_documentation.md`),
        `# ${heading}\nNative documentation.\n`,
      );
    const service = new ReferenceService();
    const search = await service.search(
      workspace,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'event rule',
        sources: ['wiki'],
        limit: 12,
      }),
    );
    expect(search.limitedByBytes).toBe(true);
    expect(search.omitted).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(search.results))).toBeLessThanOrEqual(24_000);
    const context = await service.context(
      workspace,
      referenceContextRequestSchema.parse({
        workspaceId: 'fixture',
        surface: 'general',
        limit: 24,
      }),
    );
    expect(context.limitedByBytes).toBe(true);
    expect(new Set(context.sections.map(({ source }) => source))).toEqual(
      new Set(['game_doc', 'wiki']),
    );
    expect(context.omittedSources.length).toBeGreaterThan(0);
  });

  it('accepts a registered external script documentation root and indexes entries separately', async () => {
    const { mod, game } = await fixture();
    const root = path.dirname(mod);
    const docs = path.join(root, 'generated_docs');
    await mkdir(docs);
    await writeFile(
      path.join(docs, 'effect_docs.log'),
      '== EFFECT DOCUMENTATION ==\n\nadd_prestige\n\tAdds prestige\n\tSupported Scopes: country\n\nadd_treasury\n\tAdds treasury\n',
    );
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'other_state'),
        workspaces: [
          { id: 'fixture', name: 'Fixture', root: mod, gameRoot: game, scriptDocsRoot: docs },
        ],
      }),
    );
    const result = await new ReferenceService().search(
      resolver.get('fixture'),
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'add_treasury',
        sources: ['script_doc'],
      }),
    );
    expect(result.total).toBe(1);
    expect(result.results[0]?.heading).toBe('add_treasury');
    expect(result.coverage.script_doc.sections).toBe(3);
  });
});
