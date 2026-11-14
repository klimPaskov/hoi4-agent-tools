import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import type { ProposedFileChange } from '../../src/hoi4_agent_tools/core/transactions.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { planMapOperations, type MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';
import { WORLD_OUTPUT_MANIFEST } from '../../src/hoi4_agent_tools/map/world-outputs.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

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

/** The mod after a write: the earlier files with the plan's changes applied. */
function applied(before: readonly ScannedFile[], changes: readonly ProposedFileChange[]) {
  const files = new Map(before.map((file) => [file.relativePath, file]));
  for (const change of changes)
    if (change.content === null) files.delete(change.relativePath);
    else files.set(change.relativePath, source(change.relativePath, change.content));
  return [...files.values()];
}

function recorded(files: readonly ScannedFile[]): Map<string, string> {
  const manifest = files.find(({ relativePath }) => relativePath === WORLD_OUTPUT_MANIFEST)!;
  const parsed = JSON.parse(manifest.bytes.toString('utf8')) as {
    files: Array<{ relativePath: string; sha256: string }>;
  };
  return new Map(parsed.files.map(({ relativePath, sha256 }) => [relativePath, sha256]));
}

/** State files of the mod that the inventory does not list. */
function unrecordedStates(files: readonly ScannedFile[]): string[] {
  const listed = recorded(files);
  return files
    .map(({ relativePath }) => relativePath)
    .filter(
      (relativePath) => relativePath.startsWith('history/states/') && !listed.has(relativePath),
    )
    .sort();
}

/** The id of the state a file defines. */
function stateIdOf(files: readonly ScannedFile[], relativePath: string): number {
  const state = MapWorkspaceIndex.build([...files]).states.find(
    ({ file }) => file.relativePath === relativePath,
  );
  if (state === undefined) throw new Error(`no state in ${relativePath}`);
  return state.id;
}

/** Recorded outputs whose file no longer matches its recorded hash. */
function stale(files: readonly ScannedFile[]): string[] {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  return [...recorded(files)]
    .filter(([path, sha]) => byPath.has(path) && byPath.get(path)!.sha256 !== sha)
    .map(([path]) => path);
}

const world = {
  id: 'world',
  kind: 'create_world' as const,
  width: 256,
  height: 256,
  seed: 2,
  rivers: 0,
  provincesPerState: 3,
  countries: [
    { tag: 'AAA', name: 'Aster' },
    { tag: 'BBB', name: 'Boreal' },
  ],
};

function plan(files: readonly ScannedFile[], operations: readonly MapOperation[]) {
  const result = planMapOperations(MapWorkspaceIndex.build([...files]), operations);
  expect(result.blockers).toEqual([]);
  return result;
}

describe('world output inventory after later map operations', () => {
  const written = applied([], plan([], [world]).changes);
  const index = MapWorkspaceIndex.build(written);
  const [first, second] = [...index.states].sort((a, b) => a.id - b.id);
  const edits: MapOperation[] = [
    {
      id: 'edit',
      kind: 'update_states',
      updates: [
        { stateId: first!.id, changes: { manpower: 1234, cores: ['BBB'] } },
        { stateId: second!.id, changes: { manpower: 99 } },
      ],
    },
  ];

  it('records the new bytes of the outputs a later call writes', () => {
    // ZIN, 9 November 2026: update_states and move_state_provinces after create_world left 191
    // recorded outputs stale, so the next create_world refused them as hand edits.
    const result = plan(written, edits);
    const after = applied(written, result.changes);
    expect(stale(after)).toEqual([]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_REFRESHED')!;
    expect(note.severity).toBe('info');
    expect(note.details).toMatchObject({ refreshed: 2, dropped: 0, keptEditedCount: 0 });
    // The next create_world accepts the mod.
    plan(after, [world]);
  });

  it('records later operations of the create_world call itself', () => {
    const result = plan([], [world, ...edits]);
    const after = applied([], result.changes);
    expect(stale(after)).toEqual([]);
    plan(after, [world]);
  });

  it('keeps protecting a recorded output edited by hand before the call', () => {
    const path = first!.file.relativePath;
    const edited = written.map((file) =>
      file.relativePath === path
        ? source(path, Buffer.concat([file.bytes, Buffer.from('\n# by hand\n')]))
        : file,
    );
    const result = plan(edited, edits);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_REFRESHED')!;
    expect(note.severity).toBe('warning');
    expect(note.details).toMatchObject({ refreshed: 1, keptEdited: [path] });
    const after = applied(edited, result.changes);
    expect(stale(after)).toEqual([path]);
    const blocked = planMapOperations(MapWorkspaceIndex.build(after), [world]);
    expect(blocked.blockers[0]).toMatchObject({
      code: 'MANAGED_OUTPUT_EDITED',
      details: { relativePath: path },
    });
  });

  it('adopts every recorded output with record_world_outputs', () => {
    const path = first!.file.relativePath;
    const gone = second!.file.relativePath;
    const edited = written
      .filter((file) => file.relativePath !== gone)
      .map((file) =>
        file.relativePath === path
          ? source(path, Buffer.concat([file.bytes, Buffer.from('\n# by hand\n')]))
          : file,
      );
    const result = plan(edited, [{ id: 'adopt', kind: 'record_world_outputs' }]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_RECORDED')!;
    expect(note.details).toMatchObject({
      refreshed: 1,
      dropped: 1,
      refreshedPaths: [path],
      droppedPaths: [gone],
    });
    // Only the inventory changes.
    expect(result.changes.map(({ relativePath }) => relativePath)).toEqual([WORLD_OUTPUT_MANIFEST]);
    const after = applied(edited, result.changes);
    expect(stale(after)).toEqual([]);
    expect(recorded(after).has(gone)).toBe(false);
    plan(after, [world]);
  });

  it('records the state files a later operation creates', () => {
    // ZIN K128, 14 November 2026: 124 state files written after create_world were never recorded,
    // so a copy synced from the inventory loaded without those states and the game crashed.
    const created: MapOperation = {
      id: 'carve',
      kind: 'create_state',
      sourceStateId: first!.id,
      provinceIds: [first!.provinces[0]!],
      name: 'CARVED',
      localisation: {
        method: 'upsert',
        language: 'l_english',
        value: 'Carved',
        file: 'localisation/english/world_l_english.yml',
      },
    };
    const result = plan(written, [created]);
    const after = applied(written, result.changes);
    const newStates = result.changes
      .filter(
        ({ relativePath, content }) =>
          content !== null && !written.some((f) => f.relativePath === relativePath),
      )
      .map(({ relativePath }) => relativePath)
      .filter((relativePath) => relativePath.startsWith('history/states/'));
    expect(newStates).toHaveLength(1);
    expect(recorded(after).has(newStates[0]!)).toBe(true);
    expect(unrecordedStates(after)).toEqual([]);
    expect(stale(after)).toEqual([]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_REFRESHED')!;
    // The new state file and the world localisation file it names its state in are both new.
    expect(note.details).toMatchObject({
      added: 2,
      addedPaths: [newStates[0], 'localisation/english/world_l_english.yml'],
    });
    // Merging it away again drops it from the inventory, and the next create_world accepts the mod.
    const merged = plan(after, [
      {
        id: 'merge',
        kind: 'merge_states',
        sourceStateIds: [stateIdOf(after, newStates[0]!)],
        targetStateId: first!.id,
      },
    ]);
    const final = applied(after, merged.changes);
    expect(recorded(final).has(newStates[0]!)).toBe(false);
    expect(unrecordedStates(final)).toEqual([]);
    plan(final, [world]);
  });

  it('adds every unrecorded world output with record_world_outputs', () => {
    // A mod written before this fix: a state file exists that the inventory does not list.
    const missing = second!.file.relativePath;
    const manifest = written.find(({ relativePath }) => relativePath === WORLD_OUTPUT_MANIFEST)!;
    const parsed = JSON.parse(manifest.bytes.toString('utf8')) as {
      version: number;
      files: Array<{ relativePath: string; sha256: string }>;
    };
    parsed.files = parsed.files.filter(({ relativePath }) => relativePath !== missing);
    const before = written.map((f) =>
      f.relativePath === WORLD_OUTPUT_MANIFEST
        ? source(WORLD_OUTPUT_MANIFEST, `${JSON.stringify(parsed)}\n`)
        : f,
    );
    expect(unrecordedStates(before)).toEqual([missing]);
    const result = plan(before, [{ id: 'adopt', kind: 'record_world_outputs' }]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_RECORDED')!;
    expect(note.details).toMatchObject({ added: 1, addedPaths: [missing] });
    expect(note.message).toContain('1 added that it did not list');
    const after = applied(before, result.changes);
    expect(unrecordedStates(after)).toEqual([]);
    // A file outside the world's paths is never adopted.
    const foreign = [...after, source('common/ideas/mine.txt', 'ideas = { }\n')];
    expect(plan(foreign, [{ id: 'adopt', kind: 'record_world_outputs' }]).changes).toEqual([]);
  });

  it('refuses record_world_outputs in a mod without a world inventory', () => {
    const result = planMapOperations(MapWorkspaceIndex.build([]), [
      { id: 'adopt', kind: 'record_world_outputs' },
    ]);
    expect(result.blockers[0]?.code).toBe('MAP_WORLD_OUTPUTS_MISSING');
    expect(result.changes).toEqual([]);
  });

  it('writes nothing extra when no recorded output changes', () => {
    const result = plan(written, [{ id: 'adopt', kind: 'record_world_outputs' }]);
    expect(result.changes).toEqual([]);
    expect(
      mapOperationSchema.safeParse({ id: 'a', kind: 'record_world_outputs', extra: 1 }).success,
    ).toBe(false);
    expect(mapOperationSchema.safeParse({ id: 'a', kind: 'record_world_outputs' }).success).toBe(
      true,
    );
  });
});
