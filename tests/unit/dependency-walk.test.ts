import { describe, expect, it } from 'vitest';
import type { z } from 'zod/v4';
import {
  DependencyWalk,
  walkDependencies,
  walkDependenciesAsync,
  type DependencyWalkInput,
  type DependencyWalkState,
} from '../../src/hoi4_agent_tools/core/dependency-walk.js';
import {
  withAnalysisCheckpoints,
  type AnalysisCheckpoints,
} from '../../src/hoi4_agent_tools/core/analysis-checkpoints.js';

const input: DependencyWalkInput = {
  domain: 'synthetic-helper-closure',
  sourceRevision: 'a'.repeat(64),
  edges: [
    { id: 'root', from: 'entry', to: 'a' },
    { id: 'left', from: 'a', to: 'b' },
    { id: 'right', from: 'a', to: 'c' },
    { id: 'join-left', from: 'b', to: 'd' },
    { id: 'join-right', from: 'c', to: 'd' },
    { id: 'cycle', from: 'd', to: 'a' },
    { id: 'leaf', from: 'd', to: 'outcome' },
    { id: 'other-root', from: 'other', to: 'c' },
  ],
  roots: ['root', 'other-root'],
  branches: ['a', 'b', 'c', 'd'],
  maximumDepth: 8,
  maximumSteps: 10_000,
  visitPolicy: 'node',
  reverseEdges: false,
};

const snapshot = (walk: DependencyWalk): DependencyWalkState =>
  JSON.parse(JSON.stringify(walk.checkpoint())) as DependencyWalkState;
describe('revision-bound dependency frontiers', () => {
  it.each(['node', 'path'] as const)(
    'resumes exactly after every elementary transition for %s traversal',
    (visitPolicy) => {
      for (const reverseEdges of [false, true])
        for (const maximumDepth of [1, 2, 8]) {
          const scenario = { ...input, visitPolicy, reverseEdges, maximumDepth };
          const expected = snapshot(walkDependencies(scenario));
          let walk = new DependencyWalk(scenario);
          while (!walk.state.complete) {
            walk.advance(1);
            walk = new DependencyWalk(scenario, snapshot(walk));
          }
          expect(snapshot(walk)).toEqual(expected);
          expect(
            walk.state.records.some(({ kind }) => kind === (maximumDepth < 3 ? 'depth' : 'cycle')),
          ).toBe(true);
        }
    },
  );

  it('does not corrupt a retained frontier when work or cancellation stops a batch', () => {
    const bounded = { ...input, maximumSteps: 2 };
    const walk = new DependencyWalk(bounded);
    walk.advance(2);
    const before = snapshot(walk);
    expect(() => walk.advance(1)).toThrowError(
      expect.objectContaining({ code: 'DEPENDENCY_WORK_LIMIT' }),
    );
    expect(snapshot(walk)).toEqual(before);
    expect(() => new DependencyWalk(bounded, before)).not.toThrow();
    const cancelled = new DependencyWalk(input);
    cancelled.advance(3);
    const original = snapshot(cancelled);
    expect(() => cancelled.advance(256, AbortSignal.abort(new Error('stop')))).toThrow('stop');
    expect(snapshot(cancelled)).toEqual(original);
  });

  it('validates the version, root, adjacency cursor and path continuity before resuming', () => {
    const walk = new DependencyWalk(input);
    walk.advance(5);
    const state = snapshot(walk);
    const invalid: DependencyWalkState[] = [
      { ...state, version: 2 as 1 },
      { ...state, complete: true },
      { ...state, started: false },
      { ...state, current: { path: 0, edge: 999 } },
      { ...state, paths: [...state.paths, { edge: 7, parent: 0 }] },
      { ...state, stack: [...state.stack, 999] },
      { ...state, records: [...state.records, { kind: 'visit', root: 1, path: 0 }] },
    ];
    for (const candidate of invalid)
      expect(() => new DependencyWalk(input, candidate)).toThrowError(
        expect.objectContaining({ code: 'DEPENDENCY_CHECKPOINT_INVALID' }),
      );
    expect(
      () => new DependencyWalk({ ...input, sourceRevision: 'b'.repeat(64) }, state),
    ).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_CHECKPOINT_STALE' }));
  });

  it('hydrates the saved wide-graph cursor and completes with identical evidence without restarting at zero', async () => {
    const wide: DependencyWalkInput = {
      ...input,
      roots: ['root'],
      branches: ['a'],
      edges: [
        input.edges[0]!,
        ...Array.from({ length: 4_000 }, (_, index) => ({
          id: `leaf-${index}`,
          from: 'a',
          to: `outcome-${index}`,
        })),
      ],
    };
    let saved: unknown;
    let savedKey: string | undefined;
    let savedRevision: string | undefined;
    let interrupt = true;
    const loaded: number[] = [];
    const checkpoints: AnalysisCheckpoints = {
      async load<T>(key: string, revision: string, schema: z.ZodType<T>): Promise<T | undefined> {
        if (key !== savedKey || revision !== savedRevision) return undefined;
        const result = schema.parse(saved);
        loaded.push((result as { steps: number }).steps);
        return result;
      },
      async save(key, revision, state) {
        saved = structuredClone(state);
        savedKey = key;
        savedRevision = revision;
        if (interrupt) throw new Error('synthetic process boundary after durable save');
      },
    };
    await expect(
      withAnalysisCheckpoints(checkpoints, () => walkDependenciesAsync(wide)),
    ).rejects.toThrow('synthetic process boundary');
    expect((saved as DependencyWalkState).steps).toBe(2_048);
    expect((saved as DependencyWalkState).current!.edge).toBeGreaterThan(2_000);
    interrupt = false;
    const resumed = await withAnalysisCheckpoints(checkpoints, () => walkDependenciesAsync(wide));
    expect(loaded).toEqual([2_048]);
    expect(snapshot(resumed)).toEqual(snapshot(walkDependencies(wide)));
  });
});
