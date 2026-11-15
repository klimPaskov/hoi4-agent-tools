import { describe, expect, it } from 'vitest';
import type { ReferenceRecord, SymbolRecord } from '../../src/hoi4_agent_tools/core/index.js';
import { ReverseSourceDependencies } from '../../src/hoi4_agent_tools/core/index-segments.js';

describe('typed reverse source dependencies', () => {
  it('follows transitive consumers and cycles while preserving unrelated sources', () => {
    const symbol = (id: string, path: string): SymbolRecord => ({
      id,
      path,
      kind: 'scripted_effect',
      rootKind: 'mod',
      loadOrder: 1,
      metadata: {},
      overridden: false,
      sourceShadowed: false,
    });
    const reference = (from: string, to: string, path: string): ReferenceRecord => ({
      kind: 'call',
      from,
      to,
      toKind: 'scripted_effect',
      path,
    });
    const graph = new ReverseSourceDependencies(
      [
        symbol('a', 'a.txt'),
        symbol('b', 'b.txt'),
        symbol('c', 'c.txt'),
        symbol('unrelated', 'unrelated.txt'),
      ],
      [reference('b', 'a', 'b.txt'), reference('a', 'b', 'a.txt'), reference('c', 'b', 'c.txt')],
    );
    expect(graph.affectedFiles(['a.txt'])).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(graph.consumers('scripted_effect', 'a')).toEqual(['b.txt']);
    expect(graph.affectedFiles(['removed.txt'])).toEqual(['removed.txt']);
  });
});
