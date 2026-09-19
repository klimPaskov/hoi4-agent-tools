import { describe, expect, it } from 'vitest';
import {
  DependencyPages,
  type DependencyPageInput,
  type DependencyPageRecord,
} from '../../src/hoi4_agent_tools/core/dependency-pages.js';

const input: DependencyPageInput = {
  domain: 'synthetic-helper-pages',
  sourceRevision: 'a'.repeat(64),
  maximumDepth: 64,
  visitPolicy: 'edge_path',
  reverseEdges: false,
  edges: [
    { id: 'root', from: 'entry', to: 'a' },
    { id: 'left', from: 'a', to: 'b' },
    { id: 'parallel', from: 'a', to: 'b' },
    { id: 'right', from: 'a', to: 'c' },
    { id: 'join-left', from: 'b', to: 'd' },
    { id: 'join-right', from: 'c', to: 'd' },
    { id: 'cycle', from: 'd', to: 'a' },
    { id: 'leaf', from: 'd', to: 'outcome' },
    { id: 'other', from: 'another', to: 'c' },
  ],
  roots: ['root', 'other'],
  branches: ['a', 'b', 'c', 'd'],
};
function drain(scenario: DependencyPageInput, rows: number, work: number): DependencyPageRecord[] {
  let pager = new DependencyPages(scenario);
  const result: DependencyPageRecord[] = [];
  for (;;) {
    const page = pager.page(rows, work);
    expect(page.records.length).toBeLessThanOrEqual(rows);
    expect(page.work).toBeLessThanOrEqual(work);
    expect(page.cursor.frames.length).toBeLessThanOrEqual(scenario.maximumDepth);
    result.push(...page.records);
    if (page.finished) return result;
    pager = new DependencyPages(
      scenario,
      JSON.parse(JSON.stringify(page.cursor)) as typeof page.cursor,
    );
  }
}
describe('compact source-revision-bound dependency pages', () => {
  it.each(['node', 'edge_path'] as const)(
    'resumes every transition and page boundary exactly for %s policy',
    (visitPolicy) => {
      for (const reverseEdges of [false, true])
        for (const maximumDepth of [1, 2, 64]) {
          const scenario = { ...input, visitPolicy, reverseEdges, maximumDepth };
          const full = drain(scenario, 5_000, 100_000);
          expect(drain(scenario, 1, 1)).toEqual(full);
          expect(drain(scenario, 2, 7)).toEqual(full);
          expect(full.some(({ kind }) => kind === (maximumDepth < 3 ? 'depth' : 'cycle'))).toBe(
            true,
          );
        }
      const paths = drain({ ...input, visitPolicy }, 2, 7).filter(
        ({ kind, root, path }) => kind === 'visit' && root === 0 && path.at(-1) === 4,
      );
      expect(paths).toHaveLength(visitPolicy === 'node' ? 1 : 2);
    },
  );

  it('rejects stale contracts and malformed ancestry without mutating a cancelled cursor', () => {
    const pager = new DependencyPages(input);
    const cursor = pager.page(1, 3).cursor;
    expect(
      () => new DependencyPages({ ...input, sourceRevision: 'b'.repeat(64) }, cursor),
    ).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_CURSOR_STALE' }));
    expect(
      () =>
        new DependencyPages(input, { ...cursor, frames: [{ edge: 999, next: 0, entered: false }] }),
    ).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_CURSOR_INVALID' }));
    expect(() => new DependencyPages(input, { ...cursor, visited: ['a'] })).toThrowError(
      expect.objectContaining({ code: 'DEPENDENCY_CURSOR_INVALID' }),
    );
    const before = pager.cursor();
    expect(() => pager.page(5, 10, AbortSignal.abort(new Error('stop')))).toThrow('stop');
    expect(pager.cursor()).toEqual(before);
  });

  it('enumerates more than 500,000 path records without retaining completed paths in its cursor', () => {
    const levels = 18;
    const edges = [{ id: 'root', from: 'entry', to: 'level-0' }];
    for (let level = 0; level < levels; level++)
      for (const side of ['left', 'right'])
        edges.push({ id: `${level}-${side}`, from: `level-${level}`, to: `level-${level + 1}` });
    edges.push({ id: 'leaf', from: `level-${levels}`, to: 'outcome' });
    const scenario = {
      ...input,
      edges,
      roots: ['root'],
      branches: Array.from({ length: levels + 1 }, (_, index) => `level-${index}`),
    };
    const pager = new DependencyPages(scenario);
    let records = 0;
    for (;;) {
      const page = pager.page(1_000, 10_000);
      records += page.records.length;
      expect(page.cursor.visited).toEqual([]);
      expect(page.cursor.frames.length).toBeLessThanOrEqual(levels + 1);
      expect(JSON.stringify(page.cursor).length).toBeLessThan(2_000);
      if (page.finished) break;
    }
    expect(records).toBe(3 * 2 ** levels - 1);
  });
});
