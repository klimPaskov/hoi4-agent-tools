import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { WorkspaceScanner, type ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { SOURCE_MAX_BYTES } from '../../src/hoi4_agent_tools/core/source/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

function scannedSourceFile(relativePath: string, content: string): ScannedFile {
  const bytes = Buffer.from(content);
  return {
    absolutePath: path.join('C:\\fixture', relativePath),
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('load-order scanner and shared index', () => {
  it('indexes the definition database selected by default.map', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-selected-definitions-'));
    const game = path.join(root, 'game');
    const mod = path.join(root, 'mod');
    await mkdir(path.join(game, 'map'), { recursive: true });
    await mkdir(path.join(game, 'localisation', 'english'), { recursive: true });
    await mkdir(path.join(game, 'localisation', 'french'), { recursive: true });
    await mkdir(mod, { recursive: true });
    await writeFile(
      path.join(game, 'map', 'default.map'),
      'definitions = "game_definitions.csv"\nprovinces = "custom-provinces.bmp"\n',
    );
    await writeFile(
      path.join(game, 'map', 'game_definitions.csv'),
      '1;10;20;30;land;false;plains;1\n',
    );
    await writeFile(path.join(game, 'map', 'unrelated.csv'), '99;1;2;3;land;false;plains;1\n');
    await writeFile(path.join(game, 'map', 'custom-provinces.bmp'), Buffer.alloc(1024, 1));
    await writeFile(path.join(game, 'map', 'unrelated-heightmap.bmp'), Buffer.alloc(1024, 2));
    await writeFile(
      path.join(game, 'localisation', 'english', 'test_l_english.yml'),
      '\uFEFFl_english:\nTEST_KEY: "English"\n',
    );
    await writeFile(
      path.join(game, 'localisation', 'french', 'test_l_french.yml'),
      '\uFEFFl_french:\nTEST_KEY: "Français"\n',
    );
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          workspaces: [{ id: 'test', name: 'Test', root: mod, gameRoot: game }],
        }),
      ),
    );
    const snapshot = await engine.scan('test');
    const index = snapshot.index;
    expect(index.find('province', '1')).toMatchObject({ metadata: { color: '10,20,30' } });
    expect(index.find('province', '99')).toBeUndefined();
    expect(snapshot.files.some(({ relativePath }) => relativePath.endsWith('.bmp'))).toBe(false);
    expect(snapshot.files.some(({ relativePath }) => relativePath.includes('/english/'))).toBe(
      true,
    );
    expect(snapshot.files.some(({ relativePath }) => relativePath.includes('/french/'))).toBe(
      false,
    );
  });

  it('shadows same-relative files and applies replace_path recursively to lower roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-overlay-'));
    const game = path.join(root, 'game');
    const dependency = path.join(root, 'dependency');
    const mod = path.join(root, 'mod');
    for (const directory of [game, dependency, mod]) {
      await mkdir(path.join(directory, 'common', 'national_focus', 'nested'), { recursive: true });
      await mkdir(path.join(directory, 'common', 'decisions', 'nested'), { recursive: true });
      await mkdir(path.join(directory, 'common', 'ideas'), { recursive: true });
    }
    await writeFile(
      path.join(game, 'common', 'national_focus', 'same.txt'),
      'focus_tree = { id = lower_tree focus = { id = lower_unique x = 0 y = 0 } }\n',
    );
    await writeFile(
      path.join(mod, 'common', 'national_focus', 'same.txt'),
      'focus_tree = { id = active_tree focus = { id = active_focus x = 0 y = 0 } }\n',
    );
    await writeFile(
      path.join(game, 'common', 'decisions', 'direct.txt'),
      'replaced_direct = { value = yes }\n',
    );
    await writeFile(
      path.join(game, 'common', 'decisions', 'nested', 'child.txt'),
      'focus_tree = { id = retained_nested }\n',
    );
    await writeFile(
      path.join(game, 'common', 'ideas', 'lower.txt'),
      'ideas = { country = { hidden_game_idea = { } } }\n',
    );
    await writeFile(
      path.join(dependency, 'common', 'ideas', 'owned.txt'),
      'ideas = { country = { dependency_idea = { } } }\n',
    );
    const config = serverConfigurationSchema.parse({
      version: 1,
      workspaces: [
        {
          id: 'test',
          name: 'Test',
          root: mod,
          gameRoot: game,
          dependencies: [{ root: dependency, replacePaths: ['common/ideas'] }],
          replacePaths: ['common/decisions'],
        },
      ],
    });
    const resolver = await WorkspaceResolver.create(config);
    const workspace = resolver.get('test');
    const files = await new WorkspaceScanner().scan(workspace, {
      patterns: [
        'common/national_focus/**/*.txt',
        'common/decisions/**/*.txt',
        'common/ideas/**/*.txt',
      ],
    });
    expect(files.some(({ relativePath }) => relativePath.endsWith('direct.txt'))).toBe(false);
    expect(files.some(({ relativePath }) => relativePath.endsWith('nested/child.txt'))).toBe(false);
    expect(
      files.some(
        ({ displayPath, relativePath }) =>
          displayPath.startsWith('game:') && relativePath.endsWith('common/ideas/lower.txt'),
      ),
    ).toBe(false);
    expect(
      files.some(
        ({ displayPath, relativePath }) =>
          displayPath.startsWith('dependency-1:') &&
          relativePath.endsWith('common/ideas/owned.txt'),
      ),
    ).toBe(true);
    const lower = files.find(
      ({ displayPath }) => displayPath.startsWith('game:') && displayPath.endsWith('same.txt'),
    );
    expect(lower?.shadowedBy).toMatch(/mod:common\/national_focus\/same\.txt/u);
    const index = SymbolIndex.build(files);
    expect(index.find('focus_tree', 'active_tree')).toBeDefined();
    expect(index.find('focus', 'active_focus')).toBeDefined();
    expect(index.find('focus_tree', 'lower_tree')).toBeUndefined();
    expect(index.find('focus', 'lower_unique')).toBeUndefined();
    expect(index.find('focus_tree', 'retained_nested')).toBeUndefined();
    expect(index.find('idea', 'dependency_idea')).toBeDefined();
    expect(index.find('idea', 'hidden_game_idea')).toBeUndefined();
    expect(index.findAll('focus', 'lower_unique')[0]).toMatchObject({
      sourceShadowed: true,
      overridden: true,
    });
  });

  it('indexes gameplay targets used by focus cross-links in the shared graph', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-symbols-'));
    const files = new Map<string, string>([
      ['events/fixture.txt', 'country_event = { id = fixture.1 title = fixture.1.t }\n'],
      [
        'common/decisions/fixture.txt',
        'fixture_category = { fixture_decision = { cost = 10 complete_effect = { } } }\n',
      ],
      [
        'common/decisions/categories/fixture.txt',
        'fixture_category = { icon = generic_political_reform }\n',
      ],
      ['common/ideas/fixture.txt', 'ideas = { country = { fixture_idea = { } } }\n'],
      [
        'common/characters/fixture.txt',
        'characters = { fixture_leader = { country_leader = { ideology = neutrality } } }\n',
      ],
      ['common/scripted_effects/fixture.txt', 'fixture_helper = { add_political_power = 1 }\n'],
      ['common/scripted_triggers/fixture.txt', 'fixture_condition = { always = yes }\n'],
      [
        'common/decisions/formable_nations/fixture.txt',
        'fixture_formables = { form_fixture = { complete_effect = { } } }\n',
      ],
    ]);
    for (const [relativePath, content] of files) {
      const absolute = path.join(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const config = serverConfigurationSchema.parse({
      version: 1,
      workspaces: [{ id: 'test', name: 'Test', root }],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(config));
    const index = (await engine.scan('test')).index;
    expect(index.find('event', 'fixture.1')).toBeDefined();
    expect(index.find('decision', 'fixture_decision')).toBeDefined();
    expect(index.find('decision_category', 'fixture_category')).toBeDefined();
    expect(index.findAll('decision_category', 'fixture_category')).toHaveLength(2);
    expect(
      index.findAll('decision_category', 'fixture_category').every(({ overridden }) => !overridden),
    ).toBe(true);
    expect(
      index.diagnostics.some(
        ({ code, message }) =>
          code === 'INDEX_SYMBOL_COLLISION' &&
          message.includes('decision_category:fixture_category'),
      ),
    ).toBe(false);
    expect(index.find('idea', 'fixture_idea')).toBeDefined();
    expect(index.find('leader', 'fixture_leader')).toBeDefined();
    expect(index.find('scripted_effect', 'fixture_helper')).toBeDefined();
    expect(index.find('scripted_trigger', 'fixture_condition')).toBeDefined();
    expect(index.find('formable', 'form_fixture')).toBeDefined();
  });

  it('skips a source instead of indexing its partial tree after the nesting ceiling', () => {
    const depth = 5_000;
    const source = `root = ${'{ nested = '.repeat(depth)}yes${' }'.repeat(depth)}\n`;
    const index = SymbolIndex.build([
      scannedSourceFile('common/scripted_effects/deep.txt', source),
    ]);
    expect(index.complete).toBe(false);
    expect(index.find('scripted_effect', 'root')).toBeUndefined();
    expect(index.skippedSources).toEqual([
      expect.objectContaining({ reasonCodes: ['SOURCE_NESTING_LIMIT'] }),
    ]);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INDEX_SOURCE_SKIPPED_LIMIT', severity: 'warning' }),
      ]),
    );
  });

  it('indexes 5,000 valid top-level symbols with exact late-file locations', () => {
    const symbolCount = 5_000;
    const source = `${Array.from(
      { length: symbolCount },
      (_, index) => `effect_${index} = { value = yes }`,
    ).join('\n')}\n`;
    const index = SymbolIndex.build([
      scannedSourceFile('common/scripted_effects/many.txt', source),
    ]);
    const effects = index.symbols.filter(({ kind }) => kind === 'scripted_effect');
    expect(index.diagnostics).toEqual([]);
    expect(effects).toHaveLength(symbolCount);
    expect(effects[0]?.location?.start).toMatchObject({ line: 1, column: 1 });
    expect(effects.at(-1)?.location?.start).toMatchObject({ line: symbolCount, column: 1 });
  });

  it('does not retain non-finite numeric metadata from hostile source literals', () => {
    const huge = '9'.repeat(400);
    const index = SymbolIndex.build([
      scannedSourceFile(
        'common/national_focus/huge.txt',
        `focus_tree = { id = huge_tree focus = { id = huge_focus x = ${huge} y = -${huge} } }\n`,
      ),
    ]);
    expect(index.find('focus', 'huge_focus')?.metadata).toEqual({ x: undefined, y: undefined });
  });

  it('bounds shared-index map tables by bytes, records, and fields without whole-file splitting', () => {
    const defaultMap = scannedSourceFile('map/default.map', 'definitions = "definition.csv"\n');
    const tooLarge = scannedSourceFile('map/definition.csv', 'x'.repeat(SOURCE_MAX_BYTES + 1));
    expect(SymbolIndex.build([defaultMap, tooLarge]).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INDEX_SOURCE_SKIPPED_LIMIT',
          severity: 'warning',
          details: expect.objectContaining({ reasonCodes: ['INDEX_TABLE_FILE_LIMIT'] }),
        }),
      ]),
    );

    const tooManyRows = scannedSourceFile('map/definition.csv', 'malformed\n'.repeat(100_001));
    expect(SymbolIndex.build([defaultMap, tooManyRows]).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INDEX_TABLE_RECORD_LIMIT' })]),
    );

    const tooManyFields = scannedSourceFile('map/railways.txt', '1 '.repeat(10_001));
    expect(SymbolIndex.build([tooManyFields]).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INDEX_TABLE_FIELD_LIMIT' })]),
    );
  });
});
