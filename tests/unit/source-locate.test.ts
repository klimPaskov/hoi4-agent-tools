import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { sourceLookup } from '../../src/hoi4_agent_tools/reference/source-lookup.js';
import { editDistance, nearestNames } from '../../src/hoi4_agent_tools/reference/suggestions.js';
import {
  sourceLookupDataSchema,
  sourceLookupRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

const events = [
  'namespace = locate',
  'country_event = {',
  '\tid = locate.1',
  '\toption = {',
  '\t\tname = locate.1.a',
  '\t\tadd_political_power = 10',
  '\t}',
  '\toption = {',
  '\t\tname = locate.1.b',
  '',
  '\t\tadd_political_power = 25',
  '\t}',
  '}',
  '',
].join('\n');

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-source-locate-')));
  roots.push(root);
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await mkdir(path.join(mod, 'events'), { recursive: true });
  await mkdir(path.join(game, 'events'), { recursive: true });
  await writeFile(path.join(mod, 'descriptor.mod'), 'name = "Locate"\n');
  await writeFile(path.join(mod, 'events', 'locate.txt'), events);
  await writeFile(path.join(game, 'events', 'locate.txt'), 'country_event = { id = vanilla.1 }\n');
  await writeFile(path.join(mod, 'events', 'broken.txt'), 'country_event = {\n\tid = broken.1\n');
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'locate', name: 'Locate', root: mod, gameRoot: game }],
    }),
  );
  const engine = new CoreEngine(resolver);
  await engine.persistentAnalysisCache;
  return { mod, engine };
}

const request = (input: Record<string, unknown>) =>
  sourceLookupRequestSchema.parse({ workspaceId: 'locate', ...input });

describe('source position lookup', () => {
  it('returns owners, the parser chain, and a key path that navigates back to the line', async () => {
    const { engine } = await fixture();
    const result = await sourceLookup(
      engine,
      'locate',
      request({ path: 'events/locate.txt', line: 11 }),
    );
    expect(sourceLookupDataSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ sourceScope: 'source_location', definitions: [] });
    expect(result.location).toMatchObject({
      path: 'mod:events/locate.txt',
      rootKind: 'mod',
      shadowed: false,
      line: 11,
      column: 3,
      text: '\t\tadd_political_power = 25',
      owners: [{ kind: 'event', id: 'locate.1', startLine: 2, endLine: 13 }],
      chain: [
        { key: 'country_event', occurrence: 0, startLine: 2, endLine: 13 },
        { key: 'option', occurrence: 1, startLine: 8, endLine: 12 },
        { key: 'add_political_power', occurrence: 0, startLine: 11, endLine: 11 },
      ],
      keyPath: [
        { key: 'option', occurrence: 1 },
        { key: 'add_political_power', occurrence: 0 },
      ],
      structureAvailable: true,
    });
    const navigated = await sourceLookup(
      engine,
      'locate',
      request({
        symbol: 'locate.1',
        kind: 'event',
        keyPath: result.location!.keyPath,
        includeReferences: false,
      }),
    );
    expect(navigated.definitions[0]).toMatchObject({
      fromLine: 11,
      text: 'add_political_power = 25',
    });
  });

  it('accepts display and absolute paths and reports an inactive layer as shadowed', async () => {
    const { engine, mod } = await fixture();
    const absolute = await sourceLookup(
      engine,
      'locate',
      request({ path: path.join(mod, 'events', 'locate.txt'), line: 6 }),
    );
    expect(absolute.location?.chain.map(({ key }) => key)).toEqual([
      'country_event',
      'option',
      'add_political_power',
    ]);
    const game = await sourceLookup(
      engine,
      'locate',
      request({ path: 'game:events/locate.txt', line: 1, column: 20 }),
    );
    expect(game.location).toMatchObject({
      path: 'game:events/locate.txt',
      rootKind: 'game',
      shadowed: true,
      owners: [{ id: 'vanilla.1' }],
      keyPath: [{ key: 'id', occurrence: 0 }],
    });
  });

  it('lands a blank line on its enclosing block', async () => {
    const { engine } = await fixture();
    const result = await sourceLookup(
      engine,
      'locate',
      request({ path: 'mod:events/locate.txt', line: 10 }),
    );
    expect(result.location).toMatchObject({ column: 1, text: '' });
    expect(result.location?.chain.at(-1)).toMatchObject({ key: 'option', occurrence: 1 });
  });

  it('withholds a structural path from a file with parse errors', async () => {
    const { engine } = await fixture();
    const result = await sourceLookup(
      engine,
      'locate',
      request({ path: 'events/broken.txt', line: 2 }),
    );
    expect(result.location).toMatchObject({
      structureAvailable: false,
      chain: [],
      keyPath: null,
    });
  });

  it('rejects unknown files, out-of-range positions, and mixed request modes', async () => {
    const { engine } = await fixture();
    await expect(
      sourceLookup(engine, 'locate', request({ path: 'events/missing.txt', line: 1 })),
    ).rejects.toMatchObject({ code: 'SOURCE_FILE_NOT_INDEXED' });
    await expect(
      sourceLookup(engine, 'locate', request({ path: 'events/locate.txt', line: 99 })),
    ).rejects.toMatchObject({ code: 'SOURCE_LINE_OUTSIDE_FILE' });
    await expect(
      sourceLookup(engine, 'locate', request({ path: 'events/locate.txt', line: 3, column: 40 })),
    ).rejects.toMatchObject({ code: 'SOURCE_COLUMN_OUTSIDE_LINE' });
    for (const input of [
      { symbol: 'locate.1', path: 'events/locate.txt', line: 1 },
      { path: 'events/locate.txt' },
      { line: 4 },
      { symbol: 'locate.1', column: 2 },
      { path: 'events/locate.txt', line: 4, keyPath: [{ key: 'option' }] },
      { path: 'events/locate.txt', line: 4, view: 'structure' },
      {},
    ])
      expect(
        sourceLookupRequestSchema.safeParse({ workspaceId: 'locate', ...input }).success,
        JSON.stringify(input),
      ).toBe(false);
  });
});

describe('near-miss identifier suggestions', () => {
  it('suggests indexed identifiers within three edits when a symbol has no definition', async () => {
    const { engine } = await fixture();
    const missing = await sourceLookup(
      engine,
      'locate',
      request({ symbol: 'locate.2', kind: 'event', includeReferences: false }),
    );
    expect(missing.definitionCount).toBe(0);
    expect(missing.suggestions).toEqual(['locate.1']);
    const found = await sourceLookup(
      engine,
      'locate',
      request({ symbol: 'locate.1', kind: 'event', includeReferences: false }),
    );
    expect(found.suggestions).toBeUndefined();
  });

  it('orders by distance, bounds work and skips distant or oversized names', () => {
    expect(nearestNames('add_politcal_power', ['add_political_power', 'add_power', 'x'])).toEqual([
      'add_political_power',
    ]);
    expect(nearestNames('abcd', ['abce', 'abxe', 'abcde', 'zzzz'], { limit: 2 })).toEqual([
      'abcde',
      'abce',
    ]);
    expect(nearestNames('abcd', ['abce', 'abcf'], { budget: 1 })).toEqual(['abce']);
    expect(nearestNames('a'.repeat(129), ['a'.repeat(129)])).toEqual([]);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abcdefgh', 'zyxwvuts')).toBe(4);
  });
});
