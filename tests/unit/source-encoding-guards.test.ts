import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import {
  applyReplacements,
  assignments,
  decodeSource,
  encodeSource,
  parseClausewitz,
  serializeUnchanged,
} from '../../src/hoi4_agent_tools/core/source/index.js';
import { encodeTextDocument, parseTextDocument } from '../../src/hoi4_agent_tools/map/model.js';

// Synthetic fixtures modelled on the HOI4 Factory S01 EXP-02 invalid UTF-8 and Windows-1252 files.
const undefinedWindows1252Bytes = [0x81, 0x8d, 0x8f, 0x90, 0x9d] as const;
const prefix = '# reward caf';
const replacement = String.fromCharCode(0xfffd);

function sourceWith(byte: number): Buffer {
  return Buffer.concat([
    Buffer.from(prefix),
    Buffer.from([byte]),
    Buffer.from('\nfocus = {\n\tid = guard_root\n\tcost = 10\n}\n'),
  ]);
}

function costValue(document: ReturnType<typeof parseClausewitz>) {
  const focus = assignments(document.root, 'focus')[0]!.value;
  if (focus.type !== 'block') throw new Error('Expected the focus block');
  return assignments(focus, 'cost')[0]!.value;
}

function scannedBytes(relativePath: string, bytes: Buffer): ScannedFile {
  return {
    absolutePath: `mod:/${relativePath}`,
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 0,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

describe('source encoding preservation', () => {
  it('shows why the guard exists: iconv-lite maps every undefined byte to 0x9D', () => {
    for (const byte of undefinedWindows1252Bytes) {
      const text = iconv.decode(Buffer.from([byte]), 'windows-1252');
      expect(text).toBe(replacement);
      expect([...iconv.encode(text, 'windows-1252')]).toEqual([0x9d]);
    }
  });

  it.each(undefinedWindows1252Bytes)(
    'reads a file containing byte %i and warns, but refuses to rewrite it',
    (byte) => {
      const bytes = sourceWith(byte);
      const document = parseClausewitz(bytes, 'mod:common/national_focus/bad.txt');
      expect(document.encoding).toBe('windows-1252');
      expect(document.encodingLoss).toMatchObject({
        count: 1,
        firstOffset: prefix.length,
        byteValues: [byte],
      });
      expect(document.diagnostics).toEqual([
        expect.objectContaining({
          code: 'SOURCE_ENCODING_NOT_ROUND_TRIPPABLE',
          severity: 'warning',
          location: expect.objectContaining({
            path: 'mod:common/national_focus/bad.txt',
            start: expect.objectContaining({ line: 1 }),
          }),
        }),
      ]);
      expect(assignments(document.root, 'focus')).toHaveLength(1);
      expect(serializeUnchanged(document).equals(bytes)).toBe(true);
      const value = costValue(document);
      expect(() =>
        applyReplacements(document, [
          { start: value.start, end: value.end, text: '12', description: 'cost' },
        ]),
      ).toThrowError(
        expect.objectContaining({
          code: 'SOURCE_ENCODING_NOT_ROUND_TRIPPABLE',
          details: expect.objectContaining({
            path: 'mod:common/national_focus/bad.txt',
            byteValues: [`0x${byte.toString(16).toUpperCase()}`],
            firstByteOffset: prefix.length,
          }),
        }),
      );
    },
  );

  it('reports every distinct offending byte and the total count', () => {
    const bytes = Buffer.concat([
      Buffer.from('a = '),
      Buffer.from([0x9d, 0x81, 0x9d, 0x8d, 0x8f, 0x90]),
      Buffer.from('\n'),
    ]);
    expect(decodeSource(bytes).encodingLoss).toEqual({
      count: 6,
      firstOffset: 4,
      byteValues: [0x81, 0x8d, 0x8f, 0x90, 0x9d],
    });
  });

  it('keeps editing valid Windows-1252 byte for byte', () => {
    const source = Buffer.concat([
      Buffer.from('# caf'),
      Buffer.from([0xe9, 0x80, 0x9c, 0x9f]),
      Buffer.from('\r\nfocus = {\r\n\tid = guard_root\r\n\tcost = 10\r\n}\r\n'),
    ]);
    const document = parseClausewitz(source, 'mod:common/national_focus/cp1252.txt');
    expect(document.encoding).toBe('windows-1252');
    expect(document.encodingLoss).toBeUndefined();
    expect(document.diagnostics).toEqual([]);
    const value = costValue(document);
    const output = applyReplacements(document, [
      { start: value.start, end: value.end, text: '12', description: 'cost' },
    ]);
    const expected = Buffer.from(
      source.toString('latin1').replace('cost = 10', 'cost = 12'),
      'latin1',
    );
    expect(output.equals(expected)).toBe(true);
  });

  it('leaves valid UTF-8 and BOM files unaffected', () => {
    for (const bytes of [
      Buffer.from('a = "café"\n', 'utf8'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a = "ü"\n', 'utf8')]),
    ]) {
      expect(decodeSource(bytes).encodingLoss).toBeUndefined();
    }
  });

  it('refuses to encode U+FFFD as Windows-1252 even when no document is involved', () => {
    expect(() => encodeSource(`name = ${replacement}\n`, 'windows-1252')).toThrowError(
      expect.objectContaining({ code: 'SOURCE_ENCODING_UNREPRESENTABLE' }),
    );
    expect(encodeSource('name = café\n', 'windows-1252')).toEqual(
      Buffer.from([...Buffer.from('name = caf'), 0xe9, 0x0a]),
    );
  });

  it('applies the same refusal to map text tables', () => {
    const bad = parseTextDocument(
      scannedBytes('map/bad.txt', Buffer.from([0x31, 0x3b, 0x9d, 0x81, 0x0a])),
    );
    expect(bad.lines).toHaveLength(1);
    expect(() => encodeTextDocument(bad, '1;x\n')).toThrowError(
      expect.objectContaining({ code: 'SOURCE_ENCODING_NOT_ROUND_TRIPPABLE' }),
    );
    const good = parseTextDocument(
      scannedBytes('map/good.txt', Buffer.from([0x31, 0x3b, 0xe9, 0x0a])),
    );
    expect(encodeTextDocument(good, '1;é\n')).toEqual(Buffer.from([0x31, 0x3b, 0xe9, 0x0a]));
  });
});
