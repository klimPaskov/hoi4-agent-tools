import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { sourceLookup } from '../../src/hoi4_agent_tools/reference/source-lookup.js';
import {
  sourceLookupDataSchema,
  sourceLookupRequestSchema,
} from '../../src/hoi4_agent_tools/schemas/reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  source = 'country_event = { id = navigation.1 option = { name = first hidden_effect = { add_political_power = 1 } } option = { name = second hidden_effect = { add_stability = 0.1 } } }\n',
  gameSource?: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-navigation-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'events'), { recursive: true });
  const file = path.join(mod, 'events', 'navigation.txt');
  await writeFile(file, source);
  const game = path.join(root, 'game');
  if (gameSource !== undefined) {
    await mkdir(path.join(game, 'events'), { recursive: true });
    await writeFile(path.join(game, 'events', 'navigation.txt'), gameSource);
  }
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [
          {
            id: 'fixture',
            name: 'Fixture',
            root: mod,
            ...(gameSource === undefined ? {} : { gameRoot: game }),
          },
        ],
      }),
    ),
  );
  const lookup = (options: Record<string, unknown> = {}) =>
    sourceLookup(
      engine,
      'fixture',
      sourceLookupRequestSchema.parse({
        workspaceId: 'fixture',
        symbol: 'navigation.1',
        includeReferences: false,
        ...options,
      }),
    );
  return { file, lookup };
}

describe('nested source navigation', () => {
  it('lists repeated children and reads an exact same-line nested block without adjacent siblings', async () => {
    const { file, lookup } = await fixture();
    const before = await readFile(file);
    const structure = sourceLookupDataSchema.parse(await lookup({ view: 'structure' }));
    expect(structure.definitions[0]?.text).toBe('');
    expect(
      structure.definitions[0]?.navigation?.children.map(({ key, occurrence }) => [
        key,
        occurrence,
      ]),
    ).toEqual([
      ['id', 0],
      ['option', 0],
      ['option', 1],
    ]);
    const result = sourceLookupDataSchema.parse(
      await lookup({
        expectedRevision: structure.revision,
        keyPath: [{ key: 'option', occurrence: 1 }, { key: 'hidden_effect' }],
      }),
    );
    expect(result.definitions[0]?.text).toBe('hidden_effect = { add_stability = 0.1 }');
    expect(result.definitions[0]?.nextLine).toBeNull();
    expect(result.definitions[0]?.navigation?.keyPath).toEqual([
      { key: 'option', occurrence: 1 },
      { key: 'hidden_effect', occurrence: 0 },
    ]);
    expect(await readFile(file)).toEqual(before);
  });

  it('rejects ambiguous, absent, scalar and out-of-selection paths explicitly', async () => {
    const { lookup } = await fixture();
    await expect(lookup({ keyPath: [{ key: 'option' }] })).rejects.toMatchObject({
      code: 'SOURCE_PATH_AMBIGUOUS',
    });
    await expect(lookup({ keyPath: [{ key: 'option', occurrence: 2 }] })).rejects.toMatchObject({
      code: 'SOURCE_PATH_UNKNOWN',
    });
    await expect(lookup({ keyPath: [{ key: '../../outside' }] })).rejects.toMatchObject({
      code: 'SOURCE_PATH_UNKNOWN',
    });
    await expect(lookup({ keyPath: [{ key: 'id' }, { key: 'x' }] })).rejects.toMatchObject({
      code: 'SOURCE_PATH_NOT_BLOCK',
    });
    await expect(
      lookup({ keyPath: [{ key: 'option', occurrence: 1 }], fromColumn: 1 }),
    ).rejects.toMatchObject({ code: 'SOURCE_POSITION_OUTSIDE_SELECTION' });
  });

  it('bounds structure replies and retains explicit omission counts', async () => {
    const { lookup } = await fixture();
    const result = sourceLookupDataSchema.parse(
      await lookup({ view: 'structure', maxChildren: 1 }),
    );
    expect(result.definitions[0]?.navigation?.children).toHaveLength(1);
    expect(result.definitions[0]?.navigation?.omittedChildren).toBe(2);
    expect(result.definitions[0]?.navigation?.nextChildOffset).toBe(1);
    const next = await lookup({
      view: 'structure',
      maxChildren: 1,
      childOffset: 2,
      expectedRevision: result.revision,
    });
    expect(next.definitions[0]?.navigation?.children[0]).toMatchObject({
      key: 'option',
      occurrence: 1,
    });
    expect(next.definitions[0]?.navigation?.nextChildOffset).toBeNull();
  });

  it('continues long Unicode values at exact source columns without leaking sibling text', async () => {
    const selected = `name = "${'🟢'.repeat(1500)}"`;
    const { lookup } = await fixture(
      `country_event = { id = navigation.1 option = { ${selected} hidden_effect = { add_stability = 0.1 } } }`,
    );
    const options: Record<string, unknown> = { keyPath: [{ key: 'option' }, { key: 'name' }] };
    let combined = '';
    for (let pages = 0; pages < 10; pages++) {
      const result = sourceLookupDataSchema.parse(await lookup(options));
      const definition = result.definitions[0]!;
      expect(Buffer.byteLength(definition.text)).toBeLessThanOrEqual(2000);
      combined += definition.text;
      if (definition.nextLine === null) break;
      Object.assign(options, {
        expectedRevision: result.revision,
        fromLine: definition.nextLine,
        fromColumn: definition.nextColumn,
      });
    }
    expect(combined).toBe(selected);
  });

  it('invalidates navigation when the source changes', async () => {
    const { file, lookup } = await fixture();
    const before = await lookup({ view: 'structure' });
    await writeFile(file, 'country_event = { id = navigation.1 option = { name = changed } }');
    await expect(
      lookup({ view: 'structure', expectedRevision: before.revision }),
    ).rejects.toMatchObject({ code: 'SOURCE_REVISION_STALE' });
    const after = await lookup({ keyPath: [{ key: 'option' }, { key: 'name' }] });
    expect(after.definitions[0]?.text).toBe('name = changed');
  });

  it('selects unkeyed entries by their stable child index and marks long previews', async () => {
    const { lookup } = await fixture(
      `country_event = { id = navigation.1 data = { first { nested = "${'a'.repeat(119)}🟢" } last } }`,
    );
    const structure = await lookup({ view: 'structure', keyPath: [{ key: 'data' }] });
    expect(structure.definitions[0]?.navigation?.children[1]).toMatchObject({
      index: 1,
      key: null,
      kind: 'block',
    });
    const nested = sourceLookupDataSchema.parse(
      await lookup({ view: 'structure', keyPath: [{ key: 'data' }, { index: 1 }] }),
    );
    expect(nested.definitions[0]?.navigation?.children[0]).toMatchObject({
      value: 'a'.repeat(119),
      valueTruncated: true,
    });
    const exact = await lookup({ keyPath: [{ key: 'data' }, { index: 2 }] });
    expect(exact.definitions[0]?.text).toBe('last');
    await expect(lookup({ keyPath: [{ key: 'data' }, { index: 9 }] })).rejects.toMatchObject({
      code: 'SOURCE_INDEX_UNKNOWN',
    });
  });

  it('navigates the active override without trying the same child path in a shadowed definition', async () => {
    const { lookup } = await fixture(undefined, 'country_event = { id = navigation.1 }');
    const selected = await lookup({
      keyPath: [{ key: 'option', occurrence: 1 }, { key: 'name' }],
      kind: 'event',
    });
    expect(selected.definitions).toHaveLength(1);
    expect(selected.definitions[0]).toMatchObject({ rootKind: 'mod', text: 'name = second' });
  });

  it('keeps unusually long keys addressable by index without overflowing the response schema', async () => {
    const key = 'k'.repeat(1300);
    const { lookup } = await fixture(`country_event = { id = navigation.1 ${key} = yes }`);
    const structure = sourceLookupDataSchema.parse(await lookup({ view: 'structure' }));
    expect(structure.definitions[0]?.navigation?.children[1]).toMatchObject({
      keyTruncated: true,
      index: 1,
    });
    const exact = await lookup({ keyPath: [{ index: 1 }] });
    expect(exact.definitions[0]?.text).toBe(`${key} = yes`);
  });
});
