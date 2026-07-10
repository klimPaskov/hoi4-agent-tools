import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import {
  applyReplacements,
  assignments,
  createSourceLineIndex,
  parseClausewitz,
  parseLocalisation,
  positionAt,
  serializeUnchanged,
  SOURCE_DIAGNOSTIC_LIMIT,
  SOURCE_LINE_LIMIT,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_NESTING,
  SOURCE_TOKEN_LIMIT,
} from '../../src/hoi4_agent_tools/core/source/index.js';

function referencePositionAt(
  text: string,
  offset: number,
): {
  line: number;
  column: number;
  offset: number;
} {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    const character = text[index];
    if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (character === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column, offset };
}

describe('lossless Clausewitz source model', () => {
  it('preserves every byte, comment, duplicate key, ordering, and unknown block on no-change round trip', () => {
    const source = Buffer.from(
      '\ufeff# header\r\nfocus_tree = {\r\n\tid = test # inline\r\n\tunknown = { raw = yes raw = no }\r\n\tvalue = var_name?100\r\n}\r\n',
      'utf8',
    );
    const document = parseClausewitz(source, 'mod:common/national_focus/test.txt');
    expect(document.diagnostics).toEqual([]);
    expect(serializeUnchanged(document)).toEqual(source);
    const tree = assignments(document.root, 'focus_tree')[0];
    expect(tree?.value.type).toBe('block');
    if (tree?.value.type === 'block') {
      expect(assignments(tree.value, 'unknown')).toHaveLength(1);
      expect(assignments(tree.value, 'value')[0]?.value).toMatchObject({ value: 'var_name?100' });
    }
  });

  it('rewrites only a selected token and retains original UTF-8 BOM/CRLF bytes elsewhere', () => {
    const source = Buffer.from('\ufeffroot = { value = old # keep\r\n other = yes }\r\n', 'utf8');
    const document = parseClausewitz(source, 'mod:test.txt');
    const root = assignments(document.root, 'root')[0];
    expect(root?.value.type).toBe('block');
    if (root?.value.type !== 'block') throw new Error('fixture parse failed');
    const value = assignments(root.value, 'value')[0]!.value;
    const output = applyReplacements(document, [
      { start: value.start, end: value.end, text: 'new', description: 'change value' },
    ]);
    expect(output.toString('utf8')).toBe('\ufeffroot = { value = new # keep\r\n other = yes }\r\n');
  });

  it('retains Windows-1252 and refuses unrepresentable edits', () => {
    const source = iconv.encode('# café\r\nname = old\r\n', 'windows-1252');
    const document = parseClausewitz(source, 'mod:test.txt');
    expect(document.encoding).toBe('windows-1252');
    const value = assignments(document.root, 'name')[0]!.value;
    expect(() =>
      applyReplacements(document, [
        { start: value.start, end: value.end, text: '日本語', description: 'unrepresentable' },
      ]),
    ).toThrowError(/cannot be represented/u);
  });

  it('blocks rewrites of malformed source with useful locations', () => {
    const document = parseClausewitz(Buffer.from('root = { value = "unterminated'), 'mod:bad.txt');
    expect(document.diagnostics.map(({ code }) => code)).toContain('SOURCE_UNTERMINATED_STRING');
    expect(document.diagnostics[0]?.location?.start).toMatchObject({ line: 1, column: 18 });
    expect(() =>
      applyReplacements(document, [{ start: 0, end: 4, text: 'safe', description: 'rename' }]),
    ).toThrowError(/cannot be rewritten safely/u);
  });

  it('rejects unsupported Clausewitz string escapes', () => {
    const document = parseClausewitz(Buffer.from('name = "bad\\nvalue"\n'), 'mod:bad-escape.txt');
    expect(document.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_UNSUPPORTED_ESCAPE',
          location: expect.objectContaining({
            start: expect.objectContaining({ line: 1, column: 12 }),
          }),
        }),
      ]),
    );
    expect(() =>
      applyReplacements(document, [
        { start: 0, end: 4, text: 'title', description: 'unsafe rename' },
      ]),
    ).toThrowError(/cannot be rewritten safely/u);
  });

  it('caps repeated lexer diagnostics with a deterministic truncation blocker', () => {
    const source = Buffer.from(`name = "${'\\q'.repeat(5_000)}"\n`);
    const document = parseClausewitz(source, 'mod:many-bad-escapes.txt');
    expect(document.diagnostics).toHaveLength(SOURCE_DIAGNOSTIC_LIMIT);
    expect(
      document.diagnostics.filter(({ code }) => code === 'SOURCE_UNSUPPORTED_ESCAPE'),
    ).toHaveLength(SOURCE_DIAGNOSTIC_LIMIT - 1);
    expect(document.diagnostics.at(-1)).toMatchObject({
      code: 'SOURCE_DIAGNOSTICS_TRUNCATED',
      severity: 'blocker',
      details: { limit: SOURCE_DIAGNOSTIC_LIMIT, retained: SOURCE_DIAGNOSTIC_LIMIT - 1 },
      location: { start: { line: 1, column: 207 } },
    });
  });

  it('caps repeated parser diagnostics with the same per-file blocker', () => {
    const document = parseClausewitz(Buffer.from('} '.repeat(5_000)), 'mod:many-braces.txt');
    expect(document.diagnostics).toHaveLength(SOURCE_DIAGNOSTIC_LIMIT);
    expect(document.diagnostics.at(-1)).toMatchObject({
      code: 'SOURCE_DIAGNOSTICS_TRUNCATED',
      severity: 'blocker',
    });
  });

  it('blocks 5,000 nested blocks without overflowing the parser stack', () => {
    const depth = 5_000;
    const source = Buffer.from(
      `root = ${'{ nested = '.repeat(depth)}yes${' }'.repeat(depth)}\nsibling = yes\n`,
    );
    const document = parseClausewitz(source, 'mod:deep.txt');
    expect(document.diagnostics.filter(({ code }) => code === 'SOURCE_NESTING_LIMIT')).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        details: { limit: SOURCE_MAX_NESTING },
      }),
    ]);
    expect(assignments(document.root, 'sibling')[0]?.value).toMatchObject({ value: 'yes' });
    expect(serializeUnchanged(document)).toEqual(source);
    expect(() =>
      applyReplacements(document, [
        { start: 0, end: 4, text: 'safe', description: 'unsafe deep rewrite' },
      ]),
    ).toThrowError(/cannot be rewritten safely/u);
  });

  it('preserves localisation BOM and parses versioned and unversioned keys', () => {
    const bytes = Buffer.from('\ufeffl_english:\r\nkey: "Value"\r\nother:0 "Other"\r\n', 'utf8');
    const document = parseLocalisation(bytes, 'mod:localisation/test_l_english.yml');
    expect(document.diagnostics).toEqual([]);
    expect(document.entries).toMatchObject([
      { key: 'key', value: 'Value', language: 'l_english' },
      { key: 'other', version: 0, value: 'Other', language: 'l_english' },
    ]);
    expect(document.bytes).toEqual(bytes);
  });

  it('caps malformed localisation diagnostics with the shared truncation blocker', () => {
    const bytes = Buffer.from(`\ufeffl_english:\n${'not localisation\n'.repeat(5_000)}`, 'utf8');
    const document = parseLocalisation(bytes, 'mod:localisation/malformed_l_english.yml');
    expect(document.diagnostics).toHaveLength(SOURCE_DIAGNOSTIC_LIMIT);
    expect(document.diagnostics.at(-1)).toMatchObject({
      code: 'SOURCE_DIAGNOSTICS_TRUNCATED',
      severity: 'blocker',
    });
  });

  it('blocks newline-amplification before lexing or materialising localisation lines', () => {
    const newlineBomb = '\n'.repeat(SOURCE_LINE_LIMIT);
    const clausewitz = parseClausewitz(Buffer.from(newlineBomb), 'mod:many-lines.txt');
    expect(clausewitz.tokens).toEqual([]);
    expect(clausewitz.lineIndex.lineStarts).toHaveLength(SOURCE_LINE_LIMIT);
    expect(clausewitz.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_LINE_LIMIT',
        severity: 'blocker',
        details: { limit: SOURCE_LINE_LIMIT },
      }),
    ]);

    const localisation = parseLocalisation(
      Buffer.from(`\ufeff${newlineBomb}`),
      'mod:localisation/many-lines_l_english.yml',
    );
    expect(localisation.entries).toEqual([]);
    expect(localisation.lineIndex.lineStarts).toHaveLength(SOURCE_LINE_LIMIT);
    expect(localisation.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_LINE_LIMIT',
        severity: 'blocker',
        details: { limit: SOURCE_LINE_LIMIT },
      }),
    ]);
  });

  it('stops at the shared token ceiling with one blocking diagnostic', () => {
    const source = Buffer.from('key = '.repeat(Math.ceil(SOURCE_TOKEN_LIMIT / 3) + 1));
    const document = parseClausewitz(source, 'mod:too-many-tokens.txt');
    expect(document.tokens).toHaveLength(SOURCE_TOKEN_LIMIT);
    expect(document.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_TOKEN_LIMIT',
          severity: 'blocker',
          details: { limit: SOURCE_TOKEN_LIMIT },
        }),
      ]),
    );
  });

  it('rejects oversized Clausewitz and localisation sources before indexing or parsing', () => {
    const oversized = Buffer.alloc(SOURCE_MAX_BYTES + 1, 0x61);
    const clausewitz = parseClausewitz(oversized, 'mod:oversized.txt');
    expect(clausewitz.tokens).toEqual([]);
    expect(clausewitz.lineIndex.lineStarts).toEqual([0]);
    expect(clausewitz.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_FILE_SIZE_LIMIT',
        severity: 'blocker',
        details: { limit: SOURCE_MAX_BYTES },
      }),
    ]);

    const localisation = parseLocalisation(oversized, 'mod:localisation/oversized_l_english.yml');
    expect(localisation.entries).toEqual([]);
    expect(localisation.lineIndex.lineStarts).toEqual([0]);
    expect(localisation.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_FILE_SIZE_LIMIT',
        severity: 'blocker',
        details: { limit: SOURCE_MAX_BYTES },
      }),
    ]);
  });

  it('returns exact bytes for no-op rewrites and rejects overlapping equal-start ranges', () => {
    const bytes = Buffer.from('name = old\n', 'utf8');
    const document = parseClausewitz(bytes, 'mod:test.txt');
    expect(applyReplacements(document, [])).toEqual(bytes);
    expect(() =>
      applyReplacements(document, [
        { start: 0, end: 1, text: 'n', description: 'short replacement' },
        { start: 0, end: 4, text: 'name', description: 'overlapping replacement' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_REPLACEMENT_OVERLAP' }));
  });

  it('detects CR-only source newlines', () => {
    const document = parseClausewitz(Buffer.from('first = yes\rsecond = no\r'), 'mod:cr.txt');
    expect(document.newline).toBe('\r');
  });

  it('preserves exact mixed-newline positions through the shared line index', () => {
    const text = 'a\r\nbb\nc\rd';
    const lineIndex = createSourceLineIndex(text);
    expect(lineIndex.lineStarts).toEqual([0, 3, 6, 8]);
    for (let offset = 0; offset <= text.length; offset += 1) {
      expect(positionAt(lineIndex, offset)).toEqual(referencePositionAt(text, offset));
    }
  });
});
