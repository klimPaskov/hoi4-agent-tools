import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import type { ProposedFileChange } from '../../src/hoi4_agent_tools/core/transactions.js';
import { MapWorkspaceIndex } from '../../src/hoi4_agent_tools/map/model.js';
import { planMapOperations, type MapOperation } from '../../src/hoi4_agent_tools/map/operations.js';

/**
 * Issue 182: the game needs every state id from 1 to the highest, and a merge or a territory edit
 * that removes a state used to leave its id empty ("Missing State ID", then a crash at setup).
 */

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

function applied(before: readonly ScannedFile[], changes: readonly ProposedFileChange[]) {
  const files = new Map(before.map((file) => [file.relativePath, file]));
  for (const change of changes)
    if (change.content === null) files.delete(change.relativePath);
    else files.set(change.relativePath, source(change.relativePath, change.content));
  return [...files.values()];
}

function plan(files: readonly ScannedFile[], operations: readonly MapOperation[]) {
  const result = planMapOperations(MapWorkspaceIndex.build([...files]), operations);
  expect(result.blockers).toEqual([]);
  return result;
}

function stateIds(files: readonly ScannedFile[]): number[] {
  return MapWorkspaceIndex.build([...files])
    .states.map(({ id }) => id)
    .sort((a, b) => a - b);
}

const world: MapOperation = {
  id: 'world',
  kind: 'create_world',
  width: 256,
  height: 256,
  seed: 2,
  rivers: 0,
  provincesPerState: 3,
  countries: [
    { tag: 'AAA', name: 'Aster' },
    { tag: 'BBB', name: 'Boreal' },
  ],
} as MapOperation;

describe('state ids stay contiguous after a write', () => {
  const written = applied([], plan([], [world]).changes);
  const ids = stateIds(written);
  const highest = ids.at(-1)!;
  const index = MapWorkspaceIndex.build(written);

  /** Two states of one owner and one strategic region, so merge_states accepts them. */
  function mergeablePair(): { source: number; target: number } {
    for (const state of index.states) {
      if (state.id === highest) continue;
      const region = index.regions.find(({ provinces }) => provinces.includes(state.provinces[0]!));
      const partner = index.states.find(
        (other) =>
          other.id !== state.id &&
          other.id !== highest &&
          other.owner === state.owner &&
          region?.provinces.includes(other.provinces[0]!) === true,
      );
      if (partner !== undefined) return { source: state.id, target: partner.id };
    }
    throw new Error('the synthetic world has no mergeable pair');
  }

  it('moves the highest state into the id a merge leaves, with its script references', () => {
    expect(ids).toEqual(Array.from({ length: highest }, (_, n) => n + 1));
    const { source: merged, target } = mergeablePair();
    // A mod script that names the highest state by id must follow it to its new id.
    const script = `my_effect = { ${highest} = { add_manpower = 1 } set_capital = { state = ${highest} } }\n`;
    const withScript = [...written, source('common/scripted_effects/mine.txt', script)];
    const result = plan(withScript, [
      { id: 'merge', kind: 'merge_states', sourceStateIds: [merged], targetStateId: target },
    ] as MapOperation[]);
    const after = applied(withScript, result.changes);
    expect(stateIds(after)).toEqual(Array.from({ length: highest - 1 }, (_, n) => n + 1));
    const note = result.diagnostics.find(({ code }) => code === 'MAP_STATE_IDS_COMPACTED')!;
    expect(note.details).toMatchObject({ moves: [{ from: highest, to: merged }], moveCount: 1 });
    expect(result.diagnostics.map(({ code }) => code)).not.toContain('MAP_STATE_ID_GAP');
    const rewritten = after.find(
      ({ relativePath }) => relativePath === 'common/scripted_effects/mine.txt',
    )!;
    expect(rewritten.bytes.toString('utf8')).toContain(`state = ${merged}`);
    // The world record lists exactly the state files left after the write.
    const record = JSON.parse(
      after
        .find(({ relativePath }) => relativePath === '.hoi4-agent-world.json')!
        .bytes.toString('utf8'),
    ) as { files: Array<{ relativePath: string; sha256: string }> };
    const recordedStates = record.files
      .map(({ relativePath }) => relativePath)
      .filter((path) => path.startsWith('history/states/'))
      .sort();
    const stateFiles = after
      .map(({ relativePath }) => relativePath)
      .filter((path) => path.startsWith('history/states/'))
      .sort();
    expect(recordedStates).toEqual(stateFiles);
    const hashes = new Map(record.files.map(({ relativePath, sha256 }) => [relativePath, sha256]));
    for (const file of after.filter(({ relativePath }) =>
      relativePath.startsWith('history/states/'),
    ))
      expect(hashes.get(file.relativePath), file.relativePath).toBe(file.sha256);
  });

  it('keeps a state id the request asks for by name, and reports the holes beside it', () => {
    const firstState = index.states.find(({ id }) => id === 1)!;
    const asked = highest + 5;
    const result = plan(written, [
      {
        id: 'explicit',
        kind: 'create_state',
        sourceStateId: 1,
        stateId: asked,
        provinceIds: [firstState.provinces[0]!],
        name: 'ASKED',
        localisation: {
          method: 'upsert',
          language: 'l_english',
          value: 'Asked',
          file: 'localisation/english/world_l_english.yml',
        },
      },
    ] as MapOperation[]);
    expect(stateIds(applied(written, result.changes))).toContain(asked);
    expect(result.diagnostics.map(({ code }) => code)).not.toContain('MAP_STATE_IDS_COMPACTED');
    const gap = result.diagnostics.find(({ code }) => code === 'MAP_STATE_ID_GAP')!;
    expect(gap.details).toMatchObject({ holeCount: 4 });
  });

  it('reports a hole the mod already had without moving untouched states', () => {
    // A mod whose state file was deleted by hand before the call: that gap is old.
    const { source: merged, target } = mergeablePair();
    const old = ids.find((id) => ![merged, target, highest].includes(id))!;
    const oldFile = index.states.find(({ id }) => id === old)!.file.relativePath;
    const withHole = written.filter(({ relativePath }) => relativePath !== oldFile);
    // An edit that changes no state id says nothing about ids.
    const edit = plan(withHole, [
      {
        id: 'edit',
        kind: 'update_states',
        updates: [{ stateId: target, changes: { manpower: 7 } }],
      },
    ] as MapOperation[]);
    expect(edit.diagnostics.map(({ code }) => code)).not.toContain('MAP_STATE_IDS_COMPACTED');
    expect(edit.diagnostics.map(({ code }) => code)).not.toContain('MAP_STATE_ID_GAP');
    // A merge closes only the hole it makes, and reports the old one with the fix route.
    const result = plan(withHole, [
      { id: 'merge', kind: 'merge_states', sourceStateIds: [merged], targetStateId: target },
    ] as MapOperation[]);
    const note = result.diagnostics.find(({ code }) => code === 'MAP_STATE_IDS_COMPACTED')!;
    expect(note.details).toMatchObject({ moves: [{ from: highest, to: merged }] });
    const gap = result.diagnostics.find(({ code }) => code === 'MAP_STATE_ID_GAP')!;
    expect(gap.severity).toBe('warning');
    expect(gap.details).toMatchObject({ holes: [old], holeCount: 1 });
    expect(gap.message).toContain('renumber_map_entity');
    const after = stateIds(applied(withHole, result.changes));
    expect(after).not.toContain(old);
    expect(after.at(-1)).toBe(highest - 1);
  });
});
