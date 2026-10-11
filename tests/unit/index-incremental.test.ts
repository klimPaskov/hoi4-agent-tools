import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { IndexSegmentCache } from '../../src/hoi4_agent_tools/core/index-segments.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { sourceDocuments } from '../../src/hoi4_agent_tools/core/source/cache.js';

function scanned(relativePath: string, content: string, loadOrder = 10): ScannedFile {
  const bytes = Buffer.from(content, 'utf8');
  return {
    absolutePath: path.join('C:/fixture', relativePath),
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

const view = (index: SymbolIndex) => ({
  symbols: index.symbols,
  references: index.references,
  diagnostics: index.diagnostics,
});

describe('incremental symbol index rebuilds', () => {
  it('reuses unchanged files from the previous index and matches a fresh build', () => {
    const files = [
      scanned(
        'events/a.txt',
        'add_namespace = a\ncountry_event = { id = a.1 immediate = { shared_effect = yes country_event = b.1 } }\n',
      ),
      scanned('events/b.txt', 'add_namespace = b\ncountry_event = { id = b.1 }\n'),
      scanned(
        'common/scripted_effects/shared.txt',
        'shared_effect = { add_political_power = 1 }\n',
      ),
      scanned('common/scripted_effects/dupe.txt', 'shared_effect = { add_stability = 0.1 }\n'),
      scanned('localisation/english/a_l_english.yml', '\uFEFFl_english:\n a.1.t: "Title"\n'),
    ];
    const previous = SymbolIndex.build(files, new IndexSegmentCache(0));
    const edited = files.map((file) =>
      file.relativePath === 'events/b.txt'
        ? scanned('events/b.txt', 'add_namespace = b\ncountry_event = { id = b.2 }\n')
        : file,
    );
    const parses = () => sourceDocuments.statistics().hits + sourceDocuments.statistics().misses;
    let before = parses();
    const fresh = SymbolIndex.build(edited, new IndexSegmentCache(0));
    const freshParses = parses() - before;
    before = parses();
    const incremental = SymbolIndex.build(edited, new IndexSegmentCache(0), previous);
    // Only the edited script file is parsed again.
    expect(parses() - before).toBe(1);
    expect(freshParses).toBeGreaterThan(1);
    expect(view(incremental)).toEqual(view(fresh));
    expect(incremental.unresolvedReferences()).toEqual(fresh.unresolvedReferences());
    // The edit is visible: b.1 is gone and the reference from a.1 no longer resolves.
    expect(incremental.symbols.some(({ id }) => id === 'b.2')).toBe(true);
    expect(incremental.symbols.some(({ id }) => id === 'b.1')).toBe(false);
    // Reused records are copies: finalizing the new index leaves the previous one intact.
    expect(view(previous)).toEqual(view(SymbolIndex.build(files, new IndexSegmentCache(0))));
  });
});

describe('incremental rebuilds with diagnostics', () => {
  it('keeps per-file parse errors and cross-file collisions exact across successive edits', () => {
    const base = [
      scanned('events/a.txt', 'add_namespace = a\ncountry_event = { id = a.1 }\n'),
      scanned('events/a2.txt', 'add_namespace = a\ncountry_event = { id = a.1 }\n'),
      scanned('events/b.txt', 'add_namespace = b\ncountry_event = { id = b.1\n'),
      scanned('events/c.txt', 'add_namespace = c\ncountry_event = { id = c.1 }\n'),
      scanned('events/d.txt', 'add_namespace = d\ncountry_event = { id = d.1 } }\n'),
    ];
    const codes = (index: SymbolIndex) =>
      index.diagnostics.map(({ code, location }) => `${code}@${location?.path ?? ''}`);
    const replace = (files: ScannedFile[], relativePath: string, content: string) =>
      files.map((file) =>
        file.relativePath === relativePath ? scanned(relativePath, content) : file,
      );
    const first = SymbolIndex.build(base, new IndexSegmentCache(0));
    const editC = replace(
      base,
      'events/c.txt',
      'add_namespace = c\ncountry_event = { id = c.2 }\n',
    );
    const second = SymbolIndex.build(editC, new IndexSegmentCache(0), first);
    expect(codes(second)).toEqual(codes(SymbolIndex.build(editC, new IndexSegmentCache(0))));
    const fixDuplicate = replace(
      editC,
      'events/a2.txt',
      'add_namespace = a\ncountry_event = { id = a.2 }\n',
    );
    const third = SymbolIndex.build(fixDuplicate, new IndexSegmentCache(0), second);
    const fresh = SymbolIndex.build(fixDuplicate, new IndexSegmentCache(0));
    expect(codes(third)).toEqual(codes(fresh));
    expect(view(third)).toEqual(view(fresh));
    expect(codes(fresh).some((code) => code.startsWith('INDEX_SYMBOL_COLLISION'))).toBe(false);
    expect(codes(fresh).length).toBeGreaterThanOrEqual(2);
  });
});
