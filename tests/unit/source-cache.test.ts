import { describe, expect, it } from 'vitest';
import { SourceDocumentCache } from '../../src/hoi4_agent_tools/core/source/cache.js';
import {
  parseClausewitz,
  serializeUnchanged,
} from '../../src/hoi4_agent_tools/core/source/parser.js';

describe('content-addressed parsed source cache', () => {
  it.each([
    Buffer.from('# comment\r\nx = { value = "hello" unknown = { token } }\r\n'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name = "colour"\n')]),
    Buffer.from([0x78, 0x20, 0x3d, 0x20, 0x22, 0xe9, 0x22, 0x0d]),
  ])('retains exact bytes and encoding without sharing mutable records', (bytes) => {
    const cache = new SourceDocumentCache();
    const expected = parseClausewitz(bytes, 'fixture.txt', new SourceDocumentCache(0));
    const first = parseClausewitz(bytes, 'fixture.txt', cache);
    first.root.entries.length = 0;
    first.bytes.fill(0);
    first.diagnostics.push({
      code: 'POISON',
      severity: 'warning',
      category: 'syntax',
      message: 'consumer mutation',
    });
    const second = parseClausewitz(bytes, 'fixture.txt', cache);
    expect(second).toEqual(expected);
    expect(Buffer.isBuffer(second.bytes)).toBe(true);
    expect(serializeUnchanged(second)).toEqual(bytes);
    second.tokens.length = 0;
    expect(parseClausewitz(bytes, 'fixture.txt', cache)).toEqual(expected);
    expect(cache.statistics()).toMatchObject({ hits: 2, misses: 1, retainedDocuments: 1 });
  });

  it('distinguishes source locations and content changes even with identical byte lengths', () => {
    const cache = new SourceDocumentCache();
    const before = Buffer.from('old = 1');
    const after = Buffer.from('new = 2');
    parseClausewitz(before, 'first.txt', cache);
    expect(parseClausewitz(before, 'second.txt', cache).path).toBe('second.txt');
    expect(parseClausewitz(after, 'first.txt', cache).text).toBe('new = 2');
    expect(cache.statistics()).toMatchObject({ hits: 0, misses: 3, retainedDocuments: 3 });
  });

  it('evicts by retained bytes and continues parsing when retention is disabled', () => {
    const bytes = Buffer.from('x = 1');
    const probe = new SourceDocumentCache();
    const expected = parseClausewitz(bytes, 'a.txt', probe);
    const capacity = Math.max(
      probe.statistics().retainedBytes,
      bytes.length * 12 + expected.tokens.length * 512 + 1500,
    );
    const cache = new SourceDocumentCache(capacity);
    parseClausewitz(bytes, 'a.txt', cache);
    for (let index = 0; index < 30; index += 1) parseClausewitz(bytes, `b${index}.txt`, cache);
    expect(cache.statistics().evictions).toBeGreaterThan(0);
    expect(cache.statistics().retainedBytes).toBeLessThanOrEqual(capacity);
    cache.clear();
    expect(cache.statistics().retainedBytes).toBe(0);
    const disabled = new SourceDocumentCache(0);
    expect(parseClausewitz(bytes, 'a.txt', disabled)).toEqual(expected);
    expect(disabled.statistics().retainedDocuments).toBe(0);
  });
});
