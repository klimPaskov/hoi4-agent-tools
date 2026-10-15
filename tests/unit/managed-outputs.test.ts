import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { reconcileManagedOutputs } from '../../src/hoi4_agent_tools/core/managed-outputs.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
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
  it.each([
    '../secret.txt',
    '/absolute.txt',
    'history/states/../2-B.txt',
    'history\\states\\2-B.txt',
    'notes.txt',
    'C:/secret.txt',
  ])('rejects unsupported manifest path %s', (relativePath) => {
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
