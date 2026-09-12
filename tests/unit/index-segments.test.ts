import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  SymbolIndex,
  type ReferenceRecord,
  type SymbolRecord,
} from '../../src/hoi4_agent_tools/core/index.js';
import {
  IndexSegmentCache,
  ReverseSourceDependencies,
  indexSegmentAddress,
} from '../../src/hoi4_agent_tools/core/index-segments.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { SOURCE_MAX_NESTING } from '../../src/hoi4_agent_tools/core/source/index.js';

function file(relativePath: string, source: string, extra: Partial<ScannedFile> = {}): ScannedFile {
  const bytes = Buffer.from(source);
  return {
    absolutePath: `/fixture/${relativePath}`,
    relativePath,
    displayPath: `mod:${relativePath}`,
    rootKind: 'mod',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    bytes,
    sha256: sha256Bytes(bytes),
    ...extra,
  };
}

const root = file(
  'common/national_focus/root.txt',
  'focus_tree = { id = tree focus = { id = root x = 0 y = 0 } }',
);
const branch = file(
  'common/national_focus/branch.txt',
  'focus_tree = { id = branch focus = { id = child prerequisite = { focus = root } x = 0 y = 1 } }',
);

function evidence(index: SymbolIndex): string {
  return canonicalJson({
    symbols: index.symbols,
    references: index.references,
    diagnostics: index.diagnostics,
    complete: index.complete,
    skippedSources: index.skippedSources,
    skippedSourceCount: index.skippedSourceCount,
    skippedPossibleSymbolKinds: index.skippedPossibleSymbolKinds,
  });
}

describe('immutable file-local index segments', () => {
  it.each([1024, 4096, 10000])(
    'retains a complete %i-focus inventory through cache reconstruction',
    async (count) => {
      const source = file(
        'common/national_focus/large.txt',
        `focus_tree = { id = large_tree ${Array.from(
          { length: count },
          (_, index) =>
            `focus = { id = node_${index} x = 0 y = ${index} ${index === 0 ? '' : `prerequisite = { focus = node_${index - 1} }`} }`,
        ).join('\n')} }`,
      );
      const cache = new IndexSegmentCache();
      const first = await SymbolIndex.buildAsync([source], undefined, cache);
      expect(first.complete).toBe(true);
      expect(first.findAll('focus')).toHaveLength(count);
      const second = await SymbolIndex.buildAsync([source], undefined, cache);
      expect(evidence(second)).toBe(evidence(first));
      expect(cache.statistics()).toMatchObject({ hits: 1, misses: 1 });
    },
  );

  it('reuses unchanged files without retaining mutations from index finalization or consumers', () => {
    const cache = new IndexSegmentCache();
    const expected = evidence(SymbolIndex.build([root, branch]));
    const first = SymbolIndex.build([root, branch], cache);
    expect(evidence(first)).toBe(expected);
    first.symbols[0]!.metadata.poisoned = true;
    expect(evidence(SymbolIndex.build([root, branch], cache))).toBe(expected);
    expect(cache.statistics()).toMatchObject({ misses: 2, hits: 2, retainedSegments: 2 });
  });

  it('matches a clean rebuild after edits, additions, removals, renames, shadowing and load-order changes', async () => {
    const cache = new IndexSegmentCache();
    const edited = file(
      root.relativePath,
      'focus_tree = { id = tree focus = { id = other x = 0 y = 0 } }',
    );
    const renamed = file('common/national_focus/renamed.txt', root.bytes.toString());
    const duplicate = file('common/national_focus/override.txt', root.bytes.toString(), {
      loadOrder: 2,
    });
    const variants = [
      [root, branch],
      [edited, branch],
      [root, branch, duplicate],
      [branch],
      [renamed, branch],
      [{ ...root, shadowedBy: duplicate.displayPath }, branch, duplicate],
      [root, branch, { ...duplicate, loadOrder: 0 }],
      [root, branch],
    ];
    for (const files of variants)
      expect(evidence(await SymbolIndex.buildAsync(files, undefined, cache))).toBe(
        evidence(SymbolIndex.build(files)),
      );
    expect(cache.statistics().hits).toBeGreaterThan(0);
  });

  it('invalidates province-table interpretation when default.map selects another source', () => {
    const cache = new IndexSegmentCache();
    const tables = [
      file('map/definition.csv', '1;10;20;30;land;false;plains;1\n'),
      file('map/alternate.csv', '2;40;50;60;land;false;plains;1\n'),
    ];
    for (const selected of ['definition.csv', 'alternate.csv', 'definition.csv']) {
      const files = [...tables, file('map/default.map', `definitions = "${selected}"`)];
      const actual = SymbolIndex.build(files, cache);
      expect(evidence(actual)).toBe(evidence(SymbolIndex.build(files)));
      expect(actual.findAll('province').map(({ id }) => id)).toEqual([
        selected === 'definition.csv' ? '1' : '2',
      ]);
    }
  });

  it('reindexes only the changed file in a multi-file package', () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      file(
        `common/national_focus/part_${index}.txt`,
        `focus_tree = { id = tree_${index} focus = { id = focus_${index} x = ${index} y = 0 } }`,
      ),
    );
    const cache = new IndexSegmentCache();
    SymbolIndex.build(files, cache);
    files[50] = file(
      files[50]!.relativePath,
      files[50]!.bytes.toString().replace('x = 50', 'x = 51'),
    );
    expect(evidence(SymbolIndex.build(files, cache))).toBe(evidence(SymbolIndex.build(files)));
    expect(cache.statistics()).toMatchObject({ hits: 99, misses: 101 });
  });

  it('keeps partial-source diagnostics identical instead of caching them as complete', () => {
    const cache = new IndexSegmentCache();
    const depth = SOURCE_MAX_NESTING + 10;
    const deep = file(
      'common/national_focus/deep.txt',
      `${'a = { '.repeat(depth)}x = 1 ${'} '.repeat(depth)}`,
    );
    const expected = SymbolIndex.build([root, deep]);
    expect(expected.complete).toBe(false);
    for (let run = 0; run < 2; run += 1)
      expect(evidence(SymbolIndex.build([root, deep], cache))).toBe(evidence(expected));
    expect(cache.statistics()).toMatchObject({ hits: 1, misses: 3, retainedSegments: 1 });
  });

  it('bounds retention and rejects conflicting facts at an immutable address', () => {
    const disabled = new IndexSegmentCache(0);
    expect(evidence(SymbolIndex.build([root], disabled))).toBe(evidence(SymbolIndex.build([root])));
    expect(disabled.statistics()).toMatchObject({
      retainedBytes: 0,
      retainedSegments: 0,
      oversized: 1,
    });
    const cache = new IndexSegmentCache();
    SymbolIndex.build([root], cache);
    const address = indexSegmentAddress(root, false);
    const changed = cache.get(address)!;
    changed.symbols[0]!.id = 'conflicting';
    expect(() => cache.put(address, changed)).toThrow('immutable index segment address');
    cache.clear();
    expect(cache.statistics().retainedBytes).toBe(0);
  });

  it('never promotes an over-wide map table row to complete through a cache hit', () => {
    const cache = new IndexSegmentCache();
    const network = file('map/railways.txt', `1 10000 ${'2 '.repeat(10000)}\n`);
    const expected = SymbolIndex.build([network]);
    expect(expected.complete).toBe(false);
    expect(expected.diagnostics.some(({ code }) => code === 'INDEX_TABLE_FIELD_LIMIT')).toBe(true);
    for (let run = 0; run < 2; run += 1)
      expect(evidence(SymbolIndex.build([network], cache))).toBe(evidence(expected));
    expect(cache.statistics().retainedSegments).toBe(0);
  });
});

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
