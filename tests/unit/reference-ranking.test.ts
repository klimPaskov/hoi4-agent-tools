import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  RankingIndex,
  sectionTerms,
  stemTerm,
  textTerms,
} from '../../src/hoi4_agent_tools/reference/ranking.js';
import { ReferenceService } from '../../src/hoi4_agent_tools/reference/service.js';
import {
  referenceContextRequestSchema,
  referenceReadRequestSchema,
  referenceSearchDataSchema,
  referenceSearchRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('reference term analysis', () => {
  it('folds inflected and derived forms onto one stem', () => {
    for (const family of [
      ['controls', 'controlled', 'controlling', 'control'],
      ['capitulation', 'capitulates', 'capitulated', 'capitulating'],
      ['countries', 'country'],
      ['government', 'governs'],
      ['hidden', 'hide'],
      ['flags', 'flagged', 'flag'],
    ])
      expect(new Set(family.map(stemTerm)).size, family.join(',')).toBe(1);
    // Short words, numbers, and identifiers that only look inflected are left alone.
    for (const word of ['add', 'all', 'pass', 'status', 'analysis', 'k10s'])
      expect(stemTerm(word)).toBe(word);
  });

  it('keeps identifiers whole and also indexes their words', () => {
    expect(textTerms("Check a country's is_controlled_by trigger")).toEqual([
      'check',
      'country',
      'is_controlled_by',
      'control',
      'trigger',
    ]);
  });

  it('marks link indexes, console commands and defines', () => {
    const links = ['* [a](#a)', '* [b](#b)', '* [c](#c)', '* [d](#d)'];
    expect(sectionTerms('Effects', 'Table of contents', ['text']).navigation).toBe(true);
    expect(sectionTerms('Effects', 'Effects for scope COUNTRY', links).navigation).toBe(true);
    expect(sectionTerms('Effects', 'add_core_of', ['Adds a core.']).navigation).toBe(false);
    expect(sectionTerms('console commands documentation', 'annex', []).specialty).toBe('console');
    expect(sectionTerms('Defines', 'BASE_RESEARCH_SLOTS', []).specialty).toBe('define');
    expect(sectionTerms('Effects', 'add_research_slot', []).specialty).toBeUndefined();
  });
});

describe('reference ranking model', () => {
  const corpus = [
    [
      'Effects',
      'Table of contents',
      ['* [add_core_of](#add_core_of)', '* [x](#x)', '* [y](#y)', '* [z](#z)'],
    ],
    ['Effects', 'add_core_of', ['Adds a core of the country on the state in scope.']],
    ['Effects', 'add_state_core', ['Adds a state core for the country.']],
    ['Triggers', 'num_divisions', ['Checks the number of divisions a country owns.']],
    ['Triggers', 'any_country_division', ['Checks whether any division of the country matches.']],
    ['Effects', 'create_wargoal', ['Gives the country a war goal against the target.']],
    ['Defines', 'BASE_RESEARCH_SLOTS', ['Number of research slots at the start.']],
    ['Effects', 'add_research_slot', ['Adds research slots to the country.']],
    ['console commands documentation', 'research_slot', ['Adds research slots.']],
    ['Events', 'Overview', ['An event without the identifier.']],
  ] as const;
  const entries = corpus.map(([title, heading, lines]) => ({
    heading: heading as string,
    terms: sectionTerms(title, heading, lines),
  }));
  const index = new RankingIndex(entries.map(({ terms }) => terms));
  const rank = (query: string) => {
    const plan = index.plan(query);
    return entries
      .map(({ heading, terms }) => ({ heading, score: index.score(plan, terms, heading) }))
      .filter((entry): entry is { heading: string; score: number } => entry.score !== undefined)
      .sort((left, right) => right.score - left.score)
      .map(({ heading }) => heading);
  };

  it('returns an exact heading first with a decisive score', () => {
    const plan = index.plan('add_core_of');
    expect(index.score(plan, entries[1]!.terms, 'add_core_of')).toBe(1000);
    expect(rank('add_core_of')[0]).toBe('add_core_of');
  });

  it('requires a named identifier rather than its separate words', () => {
    expect(rank('add_core_of')).not.toContain('add_state_core');
    expect(rank('country_event')).toEqual([]);
  });

  it('prefers an explanation over a table of contents that names the same topic', () => {
    const ranked = rank('add a core of a country on a state');
    expect(ranked.indexOf('add_core_of')).toBeLessThan(ranked.indexOf('Table of contents'));
  });

  it('connects counting questions to num_ names and joined words to identifiers', () => {
    expect(rank('number of divisions a country has')[0]).toBe('num_divisions');
    expect(rank('give a country a war goal')[0]).toBe('create_wargoal');
  });

  it('ranks defines and console commands below script answers unless asked', () => {
    expect(rank('add research slots')[0]).toBe('add_research_slot');
    expect(rank('research slots define')[0]).toBe('BASE_RESEARCH_SLOTS');
    expect(rank('console command research slots')[0]).toBe('research_slot');
  });

  it('returns nothing for unrelated words and names the line that answers', () => {
    expect(rank('zxqv flurble wombat')).toEqual([]);
    const plan = index.plan('war goal');
    expect(index.bestLine(plan, ['Intro line.', 'Gives the country a war goal.', 'More.'])).toBe(1);
    expect(index.phraseBonus(plan, ['a war goal here'])).toBeGreaterThan(0);
    expect(index.phraseBonus(plan, ['goal of the war'])).toBe(0);
  });
});

async function workspace(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-reference-ranking-')));
  roots.push(root);
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await mkdir(path.join(mod, 'paradox_wiki'), { recursive: true });
  await mkdir(path.join(game, 'documentation'), { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(
      name.startsWith('game/')
        ? path.join(game, name.slice(5))
        : path.join(mod, 'paradox_wiki', name),
      content,
    );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: mod, gameRoot: game }],
    }),
  );
  return resolver.get('fixture');
}

const triggersPage = [
  '# Triggers',
  '## Country scope',
  'General country triggers follow.',
  '',
  '| Name | Parameters | Examples | Description |',
  '| --- | --- | --- | --- |',
  '| has_war_with | `<country>` | `has_war_with = GER` | Checks if the country is at war with the target. |',
  '| is_major | `<bool>` | `is_major = yes` | Checks if the country is a major power. |',
  '',
  '````text',
  '# Not a heading inside a fence',
  '| not_a_row | inside | a fence |',
  '```',
  '# Still inside: a shorter fence or another fence character does not close the block',
  '~~~',
  '````',
  '## After the fence',
  'Real heading after the fenced example.',
  '',
].join('\n');

describe('reference sections and citations', () => {
  it('indexes identifier table rows as exact one-line citations', async () => {
    const service = new ReferenceService();
    const target = await workspace({ 'Triggers - Hearts of Iron 4 Wiki.md': triggersPage });
    const inventory = await service.inventory(target);
    const headings = inventory.sections.map(({ heading, startLine, endLine }) => [
      heading,
      startLine,
      endLine,
    ]);
    expect(headings).toEqual([
      ['Triggers', 1, 1],
      ['Country scope', 2, 16],
      ['After the fence', 17, 19],
      ['has_war_with', 7, 7],
      ['is_major', 8, 8],
    ]);
    const result = await service.search(
      target,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'check if the country is at war',
      }),
    );
    expect(referenceSearchDataSchema.safeParse(result).success).toBe(true);
    expect(result.results[0]).toMatchObject({
      heading: 'has_war_with',
      startLine: 7,
      matchLine: 7,
    });
    // The containing section is not repeated below the more exact row.
    expect(result.results.map(({ heading }) => heading)).not.toContain('Country scope');
    const read = await service.read(
      target,
      referenceReadRequestSchema.parse({
        workspaceId: 'fixture',
        id: result.results[0]!.id,
        revision: result.results[0]!.revision,
      }),
    );
    expect(read.text).toContain('has_war_with');
    expect(read.text).not.toContain('is_major');
    expect(read.nextLine).toBeNull();
  });

  it('lands a long-section citation on the answering line and orders equal answers by authority', async () => {
    const filler = Array.from({ length: 120 }, (_, line) => `Unrelated line ${line}.`);
    const service = new ReferenceService();
    const target = await workspace({
      'Event modding - Hearts of Iron 4 Wiki.md': [
        '# Event modding',
        '## Triggering',
        ...filler,
        'Use fire_only_once = yes so the event can only fire once.',
        ...filler,
      ].join('\n'),
      'Effects - Hearts of Iron 4 Wiki.md': '# Effects\n| country_event | Fires an event. |\n',
      'game/documentation/effects_documentation.md':
        '# Effects\n## country_event\nFires an event.\n',
    });
    const once = await service.search(
      target,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'event that fires once',
      }),
    );
    expect(once.results[0]).toMatchObject({ heading: 'Triggering', startLine: 2, matchLine: 123 });
    expect(once.results[0]!.excerpt).toContain('fire_only_once');
    const exact = await service.search(
      target,
      referenceSearchRequestSchema.parse({ workspaceId: 'fixture', query: 'country_event' }),
    );
    expect(exact.results.map(({ source }) => source)).toEqual(['game_doc', 'wiki']);
    const context = await service.context(
      target,
      referenceContextRequestSchema.parse({
        workspaceId: 'fixture',
        surface: 'event',
        question: 'event that fires once',
        limit: 4,
      }),
    );
    expect(context.sections.find(({ heading }) => heading === 'Triggering')?.matchLine).toBe(123);
  });

  it('places repeated copies of one heading behind distinct answers', async () => {
    const service = new ReferenceService();
    const target = await workspace({
      'game/documentation/effects_documentation.md': [
        '# Effects',
        '## add_stability',
        'Adds stability to the country.',
        '## add_war_support',
        'Adds war support to the country.',
      ].join('\n'),
      'Effects - Hearts of Iron 4 Wiki.md':
        '# Effects' + '\n' + '| add_stability | `<float>` | Adds stability to the country. |',
      'Data structures - Hearts of Iron 4 Wiki.md':
        '# Data structures' + '\n' + '| add_stability | Adds stability to the country. |',
    });
    const result = await service.search(
      target,
      referenceSearchRequestSchema.parse({
        workspaceId: 'fixture',
        query: 'adds stability to the country',
      }),
    );
    const order = result.results.map(({ heading, source }) => `${source}:${heading}`);
    expect(order.slice(0, 2)).toEqual(['game_doc:add_stability', 'game_doc:add_war_support']);
    expect(order.filter((entry) => entry.endsWith(':add_stability'))).toHaveLength(3);
    // An exact identifier keeps every copy together, installed documentation first.
    const exact = await service.search(
      target,
      referenceSearchRequestSchema.parse({ workspaceId: 'fixture', query: 'add_stability' }),
    );
    expect(exact.results.map(({ source }) => source)).toEqual(['game_doc', 'wiki', 'wiki']);
  });
});
