import { isUtf8 } from 'node:buffer';

/**
 * The localisation file format, read and written line by line so that every byte a change does
 * not touch stays as it was (newline style, indent, comments, the final newline).
 *
 * Rules checked against the kit wiki page `localisation.md` (1.19.4.1) and the installed game's
 * English files: UTF-8 with a byte order mark; the first line is `l_<language>:`; an entry is
 * ` key: "text"` or ` key:0 "text"` with one leading space; a key has only letters, digits,
 * `_`, `.` and `-`; a value is one line between ASCII quotes and `\"` is a quote inside it.
 */

export type LocEncoding = 'utf8-bom' | 'utf8' | 'utf16le' | 'utf16be';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** One line of a file. `orig` is its index in the file as read, or null for an inserted line. */
export interface LocLine {
  content: string;
  eol: string;
  orig: number | null;
  origContent: string;
  origEol: string;
}

export interface LocDocument {
  /** The encoding the file had when it was read. */
  readonly encoding: LocEncoding | 'new';
  /** The encoding it is written in. */
  target: LocEncoding;
  lines: LocLine[];
}

export function decodeLocBytes(bytes: Uint8Array): LocDocument | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let encoding: LocEncoding;
  let text: string;
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) {
    const rest = buffer.subarray(3);
    if (!isUtf8(rest)) return undefined;
    encoding = 'utf8-bom';
    text = rest.toString('utf8');
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    if (buffer.length % 2 !== 0) return undefined;
    encoding = 'utf16le';
    text = buffer.subarray(2).toString('utf16le');
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    if (buffer.length % 2 !== 0) return undefined;
    encoding = 'utf16be';
    text = Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  } else {
    if (!isUtf8(buffer)) return undefined;
    encoding = 'utf8';
    text = buffer.toString('utf8');
  }
  const lines: LocLine[] = [];
  const breaks = /\r\n|\r|\n/gu;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    const content = text.slice(start, match.index);
    lines.push({
      content,
      eol: match[0],
      orig: lines.length,
      origContent: content,
      origEol: match[0],
    });
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    const content = text.slice(start);
    lines.push({ content, eol: '', orig: lines.length, origContent: content, origEol: '' });
  }
  return { encoding, target: encoding, lines };
}

/** A file that does not exist yet: UTF-8 with a BOM, LF, no lines. */
export function newLocDocument(): LocDocument {
  return { encoding: 'new', target: 'utf8-bom', lines: [] };
}

export function encodeLocDocument(document: LocDocument): Buffer {
  const text = document.lines.map(({ content, eol }) => content + eol).join('');
  switch (document.target) {
    case 'utf8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
    case 'utf8':
      return Buffer.from(text, 'utf8');
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  }
}

/** The newline most lines end with; LF when the file has none or the counts tie. */
export function dominantNewline(document: LocDocument): string {
  const counts = new Map<string, number>();
  for (const { eol } of document.lines) if (eol !== '') counts.set(eol, (counts.get(eol) ?? 0) + 1);
  let best = '\n';
  let bestCount = 0;
  for (const [eol, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > bestCount) {
      best = eol;
      bestCount = count;
    }
  }
  return best;
}

export function documentChanged(document: LocDocument): boolean {
  return (
    document.encoding === 'new' ||
    document.target !== document.encoding ||
    document.lines.some(
      (line) =>
        line.orig === null || line.content !== line.origContent || line.eol !== line.origEol,
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Lines

const HEADER = /^[ \t]*l_([a-z_]+):[ \t]*(?:#.*)?$/u;
const ENTRY = /^([ \t]*)([A-Za-z0-9_.-]+):(\d*)([ \t]*)(.*)$/u;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/u;
const TAIL = /^[ \t]*(?:#.*)?$/u;
const TYPOGRAPHIC_QUOTES = new Set(['“', '”', '„', '‟']);

export interface LocEntry {
  /** Everything before the opening quote: indent, key, version and the gap. */
  prefix: string;
  indent: string;
  key: string;
  version: string;
  /** The raw text between the quotes, escapes as written. */
  value: string;
  /** Everything after the closing quote: spaces and a trailing comment. */
  tail: string;
}

export interface BrokenLine {
  kind: 'broken';
  prefix: string;
  key: string;
  rest: string;
}

export type LocLineKind =
  | { kind: 'blank' }
  | { kind: 'header'; language: string }
  | { kind: 'entry'; entry: LocEntry }
  /** An entry-shaped line whose value is not a well-formed quoted string. */
  | BrokenLine
  | { kind: 'other' };

/** Index of the closing quote of `rest`, which starts with `"`; -1 when it has none. */
function findClosingQuote(rest: string): number {
  for (let index = 1; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"' && TAIL.test(rest.slice(index + 1))) return index;
  }
  return -1;
}

export function classifyLine(content: string): LocLineKind {
  if (BLANK_OR_COMMENT.test(content)) return { kind: 'blank' };
  const header = HEADER.exec(content);
  if (header !== null) return { kind: 'header', language: header[1]! };
  const match = ENTRY.exec(content);
  if (match === null) return { kind: 'other' };
  const [, indent = '', key = '', version = '', gap = '', rest = ''] = match;
  const prefix = `${indent}${key}:${version}${gap}`;
  if (rest.startsWith('"')) {
    const close = findClosingQuote(rest);
    if (close >= 0)
      return {
        kind: 'entry',
        entry: {
          prefix,
          indent,
          key,
          version,
          value: rest.slice(1, close),
          tail: rest.slice(close + 1),
        },
      };
  }
  return { kind: 'broken', prefix, key, rest };
}

/** A value as it is written between the quotes: a bare `"` becomes `\"`. */
export function escapeLocText(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '\\' && index + 1 < text.length) {
      result += char + text[index + 1]!;
      index += 1;
    } else if (char === '"') result += '\\"';
    else result += char;
  }
  return result;
}

/** True when the text ends in a backslash that would escape the closing quote. */
export function endsWithLoneBackslash(text: string): boolean {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) count += 1;
  return count % 2 === 1;
}

export interface EntryStyle {
  indent: string;
  version: string;
}

export function formatEntryLine(style: EntryStyle, key: string, rawValue: string): string {
  return `${style.indent}${key}:${style.version} "${rawValue}"`;
}

/**
 * New files use what most game files use: one leading space and no version number. On the
 * installed 1.19.4.1 English files 116,765 entry lines are ` key: "text"` and 2,067 are
 * ` key:0 "text"`; all 208 files use LF.
 */
export const NEW_FILE_STYLE: EntryStyle = { indent: ' ', version: '' };

export function detectStyle(document: LocDocument): EntryStyle {
  let indent: string | undefined;
  const versions = new Map<string, number>();
  let entries = 0;
  for (const { content } of document.lines) {
    const kind = classifyLine(content);
    if (kind.kind !== 'entry') continue;
    entries += 1;
    indent ??= kind.entry.indent;
    if (kind.entry.version !== '')
      versions.set(kind.entry.version, (versions.get(kind.entry.version) ?? 0) + 1);
  }
  let version = '';
  let withVersion = 0;
  for (const count of versions.values()) withVersion += count;
  if (withVersion * 2 > entries) {
    let best = 0;
    for (const [candidate, count] of [...versions].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (count > best) {
        version = candidate;
        best = count;
      }
  }
  return { indent: indent ?? NEW_FILE_STYLE.indent, version };
}

export interface ScannedEntry {
  lineIndex: number;
  /** The language of the `l_<language>:` header above the line; null before any header. */
  language: string | null;
  entry: LocEntry;
}

export interface ScannedDocument {
  entries: ScannedEntry[];
  headers: Array<{ lineIndex: number; language: string }>;
}

export function scanDocument(document: LocDocument): ScannedDocument {
  const entries: ScannedEntry[] = [];
  const headers: ScannedDocument['headers'] = [];
  let language: string | null = null;
  for (const [lineIndex, { content }] of document.lines.entries()) {
    const kind = classifyLine(content);
    if (kind.kind === 'header') {
      language = kind.language;
      headers.push({ lineIndex, language });
    } else if (kind.kind === 'entry') entries.push({ lineIndex, language, entry: kind.entry });
  }
  return { entries, headers };
}

/**
 * Add entry lines to the section of `language`: after its last entry, or after its header, or
 * (when the file has no such header) under a new header at the end. Returns the 1-based line
 * numbers of the new entry lines. The file's newline style is kept, and a file that had no final
 * newline still has none after the last line.
 */
export function appendEntries(
  document: LocDocument,
  language: string,
  lines: readonly string[],
): number[] {
  if (lines.length === 0) return [];
  const newline = dominantNewline(document);
  const scanned = scanDocument(document);
  const headerIndex = scanned.headers.findIndex((header) => header.language === language);
  const added = [...lines];
  let insertAt: number;
  if (headerIndex < 0) {
    added.unshift(`l_${language}:`);
    insertAt = document.lines.length;
  } else {
    const header = scanned.headers[headerIndex]!;
    const nextHeader = scanned.headers[headerIndex + 1]?.lineIndex ?? document.lines.length;
    const last = scanned.entries
      .filter(({ lineIndex }) => lineIndex > header.lineIndex && lineIndex < nextHeader)
      .at(-1);
    insertAt = (last?.lineIndex ?? header.lineIndex) + 1;
  }
  const atEnd = insertAt === document.lines.length;
  const previous = insertAt === 0 ? undefined : document.lines.at(insertAt - 1);
  const keepNoFinalNewline = atEnd && previous?.eol === '';
  if (keepNoFinalNewline) previous.eol = newline;
  const inserted: LocLine[] = added.map((content, index) => ({
    content,
    eol: index === added.length - 1 && keepNoFinalNewline ? '' : newline,
    orig: null,
    origContent: '',
    origEol: '',
  }));
  document.lines.splice(insertAt, 0, ...inserted);
  const first = insertAt + (headerIndex < 0 ? 1 : 0);
  return lines.map((_line, index) => first + index + 1);
}

// ---------------------------------------------------------------------------------------------
// Quote repair

export type QuoteRepair = { fixed: true; content: string } | { fixed: false; reason: string };

/** `#` that starts a trailing comment: after whitespace and followed by whitespace or the end. */
const COMMENT_START = /[ \t]#(?=[ \t]|$)/u;

function hasTypographicQuote(text: string): boolean {
  for (const char of text) if (TYPOGRAPHIC_QUOTES.has(char)) return true;
  return false;
}

function isQuote(char: string): boolean {
  return char === '"' || TYPOGRAPHIC_QUOTES.has(char);
}

/**
 * Repair a broken value only where the intent is unambiguous: a missing closing quote gets one
 * at the end of the value (before a trailing comment), and typographic quotes that delimit the
 * value become ASCII quotes. Everything else is reported, never guessed.
 */
export function repairValue(line: BrokenLine, nextContent: string | undefined): QuoteRepair {
  const { prefix, rest } = line;
  if (rest === '') return { fixed: false, reason: 'the entry has no value' };
  const first = rest[0]!;
  if (!isQuote(first)) return { fixed: false, reason: 'the value does not start with a quote' };

  // Closing candidates: a quote character after which only blanks or a comment follow.
  const candidates: number[] = [];
  for (let index = 1; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (isQuote(char) && TAIL.test(rest.slice(index + 1))) candidates.push(index);
  }
  const typographic = first !== '"' || candidates.some((index) => rest[index] !== '"');
  if (typographic) {
    if (candidates.length === 1) {
      const close = candidates[0]!;
      const inner = rest.slice(1, close);
      // A plain opening quote with a typographic closing one is clear only when no other
      // typographic quote sits inside.
      const mixed = first === '"' && hasTypographicQuote(inner);
      if (!mixed) return { fixed: true, content: `${prefix}"${inner}"${rest.slice(close + 1)}` };
    }
    return {
      fixed: false,
      reason:
        candidates.length === 0
          ? 'typographic quotes without a clear closing quote'
          : 'more than one possible closing quote',
    };
  }

  // An ASCII opening quote with no closing quote. Another quote inside makes it unclear.
  for (let index = 1; index < rest.length; index += 1) {
    if (rest[index] === '\\') index += 1;
    else if (rest[index] === '"')
      return { fixed: false, reason: 'the value has a quote that is not at its end' };
  }
  if (nextContent !== undefined) {
    const next = classifyLine(nextContent);
    const startsEntry =
      next.kind === 'blank' ||
      next.kind === 'header' ||
      next.kind === 'entry' ||
      (next.kind === 'broken' && (next.rest === '' || isQuote(next.rest[0]!)));
    if (!startsEntry) return { fixed: false, reason: 'the value may continue on the next line' };
  }
  const comment = COMMENT_START.exec(rest);
  const valuePart = comment === null ? rest : rest.slice(0, comment.index);
  const after = comment === null ? '' : rest.slice(comment.index);
  const trimmed = valuePart.trimEnd();
  if (endsWithLoneBackslash(trimmed))
    return { fixed: false, reason: 'the value ends with a backslash that escapes the quote' };
  return { fixed: true, content: `${prefix}${trimmed}"${valuePart.slice(trimmed.length)}${after}` };
}
