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

  it('records the files a later operation creates', () => {
    // ZIN, 14 November 2026: 124 state files created by assign_territory and create_state never
    // entered the record, and a sync that copies the recorded files left the game without them.
    const province = first!.provinces.find((id) => id !== first!.capital) ?? first!.provinces[0]!;
    const result = plan(written, [
      { id: 'split', kind: 'split_state', sourceStateId: first!.id, provinceIds: [province] },
    ]);
    const created = result.changes.filter(
      ({ relativePath, content }) =>
        content !== null &&
        relativePath.startsWith('history/states/') &&
        !written.some((file) => file.relativePath === relativePath),
    );
    expect(created.length).toBeGreaterThan(0);
    const after = applied(written, result.changes);
    for (const { relativePath } of created) expect(recorded(after).has(relativePath)).toBe(true);
    expect(stale(after)).toEqual([]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_REFRESHED')!;
    expect((note.details as { added: number }).added).toBe(created.length);
    plan(after, [world]);
  });

  it('adopts unrecorded files at world output paths with adoptUnrecorded', () => {
    const stray = source('history/states/9999-Stray.txt', 'state = { id = 9999 }');
    const notes = source('notes/readme.txt', 'authored');
    const before = [...written, stray, notes];
    const plain = plan(before, [{ id: 'adopt', kind: 'record_world_outputs' }]);
    expect(plain.changes).toEqual([]);
    const result = plan(before, [
      { id: 'adopt', kind: 'record_world_outputs', adoptUnrecorded: true },
    ]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_WORLD_OUTPUTS_RECORDED')!;
    expect(note.details).toMatchObject({ added: 1, addedPaths: [stray.relativePath] });
    const after = applied(before, result.changes);
    expect(recorded(after).has(stray.relativePath)).toBe(true);
    expect(recorded(after).has(notes.relativePath)).toBe(false);
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
