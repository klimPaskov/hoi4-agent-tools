import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  planManagedOutputs,
  reconcileManagedOutputs,
} from '../../src/hoi4_agent_tools/core/managed-outputs.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  isWorldCountryOutput,
  planWorldOutputs,
  reconcileWorldOutputs,
  WORLD_OUTPUT_MANIFEST,
} from '../../src/hoi4_agent_tools/map/world-outputs.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { planMapOperations } from '../../src/hoi4_agent_tools/map/operations.js';

function source(relativePath: string, content: Uint8Array | string): ScannedFile {
  const bytes = Buffer.from(content);
  return {
    relativePath,
    absolutePath: `/synthetic/${relativePath}`,
    displayPath: `mod:${relativePath}`,
    rootKind: 'mod',
    loadOrder: 1,
    modifiedMs: 0,
    size: bytes.length,
    bytes,
    sha256: sha256Bytes(bytes),
  };
}
const one = {
  relativePath: 'history/states/1-A.txt',
  content: Buffer.from('one'),
  operationIds: ['world'],
};
const two = {
  relativePath: 'history/states/2-B.txt',
  content: Buffer.from('two'),
  operationIds: ['world'],
};
const input = {
  manifestPath: WORLD_OUTPUT_MANIFEST,
  operationId: 'world',
  permitsPath: (name: string) => /^history\/states\/\d+-[A-Z]\.txt$/u.test(name),
};

describe('managed output regeneration', () => {
  it('removes obsolete unchanged generated files and preserves unrelated source', () => {
    const first = reconcileManagedOutputs({ ...input, sources: [], proposed: [one, two] });
    const sources = [
      source(WORLD_OUTPUT_MANIFEST, first[0]!.content!),
      source(one.relativePath, one.content),
      source(two.relativePath, two.content),
      source('notes.txt', 'authored'),
    ];
    const result = reconcileManagedOutputs({ ...input, sources, proposed: [one] });
    expect(result.find((f) => f.relativePath === two.relativePath)?.content).toBeNull();
    expect(result.some((f) => f.relativePath === 'notes.txt')).toBe(false);
    expect(JSON.parse(Buffer.from(result.at(-1)!.content!).toString()).files).toHaveLength(1);
    expect(() =>
      reconcileManagedOutputs({
        ...input,
        sources: sources.map((f) =>
          f.relativePath === two.relativePath ? source(two.relativePath, 'authored edit') : f,
        ),
        proposed: [one],
      }),
    ).toThrow('edited');
  });
  it('reports written, retired and released outputs', () => {
    const first = planManagedOutputs({ ...input, sources: [], proposed: [one, two] });
    expect(first).toMatchObject({
      written: [one.relativePath, two.relativePath],
      retired: [],
      released: [],
    });
    const manifest = source(WORLD_OUTPUT_MANIFEST, first.changes.at(-1)!.content!);
    const unchanged = [
      manifest,
      source(one.relativePath, one.content),
      source(two.relativePath, two.content),
    ];
    const retired = planManagedOutputs({ ...input, sources: unchanged, proposed: [one] });
    expect(retired).toMatchObject({
      written: [one.relativePath],
      retired: [two.relativePath],
      released: [],
    });
    const edited = [
      manifest,
      source(one.relativePath, one.content),
      source(two.relativePath, 'mine'),
    ];
    const releasable = (name: string) => name === two.relativePath;
    const released = planManagedOutputs({ ...input, sources: edited, proposed: [one], releasable });
    expect(released).toMatchObject({ retired: [], released: [two.relativePath] });
    expect(released.changes.some((f) => f.relativePath === two.relativePath)).toBe(false);
    const inventory = JSON.parse(Buffer.from(released.changes.at(-1)!.content!).toString()) as {
      files: { relativePath: string }[];
    };
    expect(inventory.files.map((f) => f.relativePath)).toEqual([one.relativePath]);
    // A releasable file the write would produce again still blocks: regenerating it would discard the edit.
    expect(() =>
      planManagedOutputs({ ...input, sources: edited, proposed: [one, two], releasable }),
    ).toThrow('edited');
    // Without the predicate an edited file blocks as before.
    expect(() => planManagedOutputs({ ...input, sources: edited, proposed: [one] })).toThrow(
      'edited',
    );
  });
  it('releases only country outputs of a world when the workspace owns its countries', () => {
    expect(
      [
        'common/country_tags/zz_world_countries.txt',
        'common/countries/colors.txt',
        'common/countries/ABC - Aster.txt',
        'history/countries/ABC - Aster.txt',
        'history/units/ABC_world.txt',
        'gfx/flags/ABC.tga',
        'gfx/flags/medium/ABC.tga',
        'gfx/flags/small/ABC.tga',
        'common/bookmarks/world.txt',
      ].every(isWorldCountryOutput),
    ).toBe(true);
    expect(
      [
        'history/states/1-A.txt',
        'map/provinces.bmp',
        'common/on_actions/world.txt',
        'localisation/replace/world_l_english.yml',
        'history/units/ABC_custom.txt',
        'gfx/flags/ABC_fascism.tga',
      ].some(isWorldCountryOutput),
    ).toBe(false);
    const flag = {
      relativePath: 'gfx/flags/ABC.tga',
      content: Buffer.from('flag'),
      operationIds: ['world'],
    };
    const onActions = {
      relativePath: 'common/on_actions/world.txt',
      content: Buffer.from('on_actions = { }'),
      operationIds: ['world'],
    };
    const roots = ['world', 'map', ['history/states'], ['localisation']] as const;
    const first = planWorldOutputs([], [flag, onActions], ...roots);
    const manifest = source(WORLD_OUTPUT_MANIFEST, first.changes.at(-1)!.content!);
    const edited = [
      manifest,
      source(flag.relativePath, 'mod flag'),
      source(onActions.relativePath, 'mod hooks'),
    ];
    expect(() => planWorldOutputs(edited, [], ...roots)).toThrow('edited');
    expect(() => planWorldOutputs(edited, [], ...roots, { releaseCountryOutputs: true })).toThrow(
      'edited',
    );
    const flagOnly = [
      manifest,
      source(flag.relativePath, 'mod flag'),
      source(onActions.relativePath, onActions.content),
    ];
    const plan = planWorldOutputs(flagOnly, [], ...roots, { releaseCountryOutputs: true });
    expect(plan).toMatchObject({
      released: [flag.relativePath],
      retired: [onActions.relativePath],
      written: [],
    });
  });
  it('writes a world over a mod whose inventory records files the world does not manage', () => {
    const operation = {
      id: 'world',
      kind: 'create_world' as const,
      width: 256,
      height: 256,
      seed: 2,
      rivers: 0,
      provincesPerState: 3,
      countries: [{ tag: 'AAA', name: 'Aster' }],
    };
    const first = planMapOperations(MapWorkspaceIndex.build([]), [operation]);
    expect(first.blockers).toEqual([]);
    const authored = [
      [
        'common/country_tags/00_mod_countries.txt',
        'MOD = "countries/MOD.txt"' + String.fromCharCode(10),
      ],
      [
        'localisation/english/state_names_l_english.yml',
        'l_english:' + String.fromCharCode(10) + ' STATE_1:0 "Own"',
      ],
    ] as const;
    const sources = first.changes
      .filter((f) => f.content !== null)
      .map((f) => source(f.relativePath, f.content!))
      .map((f) => {
        if (f.relativePath !== WORLD_OUTPUT_MANIFEST) return f;
        const recorded = JSON.parse(f.bytes.toString()) as {
          version: number;
          files: Array<{ relativePath: string; sha256: string }>;
        };
        // The mod's own tooling recorded files that were never outputs of a world.
        for (const [relativePath, text] of authored)
          recorded.files.push({ relativePath, sha256: sha256Bytes(Buffer.from('older ' + text)) });
        return source(f.relativePath, JSON.stringify(recorded));
      });
    for (const [relativePath, text] of authored) sources.push(source(relativePath, text));
    const next = planMapOperations(MapWorkspaceIndex.build(sources), [operation]);
    expect(next.blockers).toEqual([]);
    expect(next.worldOutputs?.[0]?.ignored).toEqual([...authored.map(([path]) => path)].sort());
    expect(next.changes.filter((f) => authored.some(([path]) => path === f.relativePath))).toEqual(
      [],
    );
    expect(next.diagnostics.map(({ code }) => code)).toContain('MAP_WORLD_OUTPUT_RECORD_IGNORED');
  });
  it('leaves recorded paths it does not manage alone and drops them from the inventory', () => {
    const first = planManagedOutputs({ ...input, sources: [], proposed: [one, two] });
    const foreign = { relativePath: 'notes.txt', sha256: 'a'.repeat(64) };
    const recorded = JSON.parse(Buffer.from(first.changes.at(-1)!.content!).toString()) as {
      version: number;
      files: Array<{ relativePath: string; sha256: string }>;
    };
    recorded.files.push(foreign, { relativePath: 'common/other.txt', sha256: 'b'.repeat(64) });
    const sources = [
      source(WORLD_OUTPUT_MANIFEST, JSON.stringify(recorded)),
      source(one.relativePath, one.content),
      source(two.relativePath, two.content),
      // The file exists and differs from its recorded hash: it is not ours to compare or delete.
      source('notes.txt', 'authored'),
    ];
    const plan = planManagedOutputs({ ...input, sources, proposed: [one] });
    expect(plan.ignored).toEqual(['common/other.txt', 'notes.txt']);
    expect(plan.retired).toEqual([two.relativePath]);
    expect(plan.changes.some((f) => f.relativePath === 'notes.txt')).toBe(false);
    const inventory = JSON.parse(Buffer.from(plan.changes.at(-1)!.content!).toString()) as {
      files: Array<{ relativePath: string }>;
    };
    expect(inventory.files.map((f) => f.relativePath)).toEqual([one.relativePath]);
    // A duplicate record is still refused, whatever it names.
    recorded.files.push(foreign);
    expect(() =>
      planManagedOutputs({
        ...input,
        sources: [source(WORLD_OUTPUT_MANIFEST, JSON.stringify(recorded))],
        proposed: [],
      }),
    ).toThrow('duplicate');
  });
  it.each([
    '../secret.txt',
    '/absolute.txt',
    'history/states/../2-B.txt',
    'history\\states\\2-B.txt',
    'C:/secret.txt',
  ])('rejects an unsafe manifest path %s', (relativePath) => {
    const manifest = source(
      WORLD_OUTPUT_MANIFEST,
      JSON.stringify({ version: 1, files: [{ relativePath, sha256: 'a'.repeat(64) }] }),
    );
    expect(() => reconcileManagedOutputs({ ...input, sources: [manifest], proposed: [] })).toThrow(
      'unsupported',
    );
  });
  it('rejects duplicate, malformed and oversized inventories', () => {
    for (const text of [
      '{}',
      'x'.repeat(2_000_001),
      JSON.stringify({ version: 1, files: [one, one] }),
      JSON.stringify({
        version: 1,
        files: Array.from({ length: 2 }, () => ({
          relativePath: one.relativePath,
          sha256: 'a'.repeat(64),
        })),
      }),
    ])
      expect(() =>
        reconcileManagedOutputs({
          ...input,
          sources: [source(WORLD_OUTPUT_MANIFEST, text)],
          proposed: [],
        }),
      ).toThrow();
  });
  it('regenerates fewer states without retaining stale memberships and rejects edited states', () => {
    const operation = {
      id: 'world',
      kind: 'create_world' as const,
      width: 256,
      height: 256,
      seed: 2,
      rivers: 0,
      provincesPerState: 3,
      countries: [{ tag: 'AAA', name: 'Aster' }],
    };
    const first = planMapOperations(MapWorkspaceIndex.build([]), [operation]);
    expect(first.blockers).toEqual([]);
    const buildings = Buffer.from(
      first.changes.find((f) => f.relativePath === 'map/buildings.txt')!.content!,
    ).toString();
    expect(buildings.endsWith('\n')).toBe(false);
    expect(buildings.split(/\r?\n/u).every((line) => line.split(';').length === 7)).toBe(true);
    const sources = first.changes
      .filter((f) => f.content !== null)
      .map((f) => source(f.relativePath, f.content!));
    const next = planMapOperations(MapWorkspaceIndex.build(sources), [
      { ...operation, provincesPerState: 20 },
    ]);
    expect(next.blockers).toEqual([]);
    expect(
      next.changes.some((f) => f.content === null && f.relativePath.startsWith('history/states/')),
    ).toBe(true);
    expect(new Set(next.finalIndex.states.map((s) => s.id)).size).toBe(
      next.finalIndex.states.length,
    );
    const state = sources.find((f) => f.relativePath.startsWith('history/states/'))!;
    const edited = sources.map((f) =>
      f === state ? source(f.relativePath, Buffer.concat([f.bytes, Buffer.from('# edit')])) : f,
    );
    const report = next.worldOutputs?.[0];
    expect(report?.operationId).toBe('world');
    expect(report?.retired.length).toBeGreaterThan(0);
    expect(report?.retired.every((path) => path.startsWith('history/states/'))).toBe(true);
    expect(report?.released).toEqual([]);
    expect(report?.written).toEqual(
      [...report!.written].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const reconciled = next.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_RECONCILED');
    expect(reconciled?.details).toMatchObject({
      retired: report!.retired.length,
      released: 0,
      written: report!.written.length,
      truncated: false,
    });
    const blocked = planMapOperations(MapWorkspaceIndex.build(edited), [operation]);
    expect(blocked.blockers[0]?.code).toBe('MANAGED_OUTPUT_EDITED');
    expect(blocked.changes).toEqual([]);
    expect(
      reconcileWorldOutputs(
        [],
        first.changes,
        'world',
        'map',
        ['history/states'],
        ['localisation'],
      ).at(-1)?.relativePath,
    ).toBe(WORLD_OUTPUT_MANIFEST);
  });
});
