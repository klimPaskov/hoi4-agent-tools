import { indentedBody, lineIndent } from '../core/block-edit.js';
import { hasBlockingDiagnostics } from '../core/diagnostics.js';
import { DIFF_CONTEXT_LINES, unifiedTextDiff } from '../core/diff.js';
import { ServiceError } from '../core/result.js';
import {
  applyReplacements,
  assignments,
  parseClausewitz,
  type AssignmentNode,
  type SourceDocument,
  type SourceReplacement,
} from '../core/source/index.js';

/**
 * The edit behind `hoi4.doctrine_write` (issue 160): add, replace or remove one grand doctrine, track
 * or subdoctrine of a `common/doctrines/**` file and nothing else. These files are flat: each
 * top-level block is one definition, keyed by its name. Every byte outside the touched block, its
 * comments, its neighbours, the newline style and the encoding, comes back exactly as it was read, and
 * a layout the edit cannot place safely is refused with the reason, not guessed.
 */

export type DoctrineWriteOperation = 'add' | 'replace' | 'remove';

export interface DoctrineWriteInput {
  operation: DoctrineWriteOperation;
  /** The doctrine to add, replace or remove. */
  id: string;
  /** The text between the doctrine's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface DoctrineWritePlan {
  operation: DoctrineWriteOperation;
  id: string;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The one replacement that was made. */
  edit: SourceReplacement;
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
  /** The doctrines of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

/** Every top-level block of the document: one doctrine definition each. */
function definitions(document: SourceDocument): AssignmentNode[] {
  return assignments(document.root).filter(({ value }) => value.type === 'block');
}

/** One level of indentation, read from the file's own doctrines, tabs when it has none. */
function indentUnit(definitionsOfFile: readonly AssignmentNode[], text: string): string {
  for (const doctrine of definitionsOfFile) {
    if (doctrine.value.type !== 'block') continue;
    const first = doctrine.value.entries[0];
    if (first === undefined) continue;
    const inner = lineIndent(text, first.start);
    const outer = lineIndent(text, doctrine.start);
    if (inner.length > outer.length && inner.startsWith(outer)) return inner.slice(outer.length);
  }
  return '\t';
}

/** The body, checked on its own as the block it will become. */
function assertBodyIsOneBlock(id: string, body: string): void {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'doctrine-body');
  const only = probe.root.entries;
  const single = only.length === 1 && only[0]?.type === 'assignment' && only[0].key.value === id;
  if (hasBlockingDiagnostics(probe.diagnostics) || !single || only[0]?.type !== 'assignment')
    fail(
      'DOCTRINE_WRITE_BODY_INVALID',
      'The body must be the text between the braces of one doctrine: balanced braces and no definition of its own',
      { diagnosticCodes: probe.diagnostics.map(({ code }) => code) },
    );
  if (only[0].value.type !== 'block' || only[0].value.entries.length === 0)
    fail('DOCTRINE_WRITE_BODY_INVALID', 'The body of a doctrine cannot be empty');
}

function definitionTexts(document: SourceDocument, skip?: AssignmentNode): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const doctrine of definitions(document)) {
    if (doctrine.start === skip?.start) continue;
    const key = doctrine.key.value;
    byKey.set(key, [...(byKey.get(key) ?? []), document.text.slice(doctrine.start, doctrine.end)]);
  }
  return byKey;
}

function checkRequest(input: DoctrineWriteInput): void {
  if (!ID_PATTERN.test(input.id))
    fail('DOCTRINE_WRITE_ID_INVALID', `${JSON.stringify(input.id)} is not a valid doctrine id`, {
      id: input.id,
    });
  if (input.operation === 'remove' && input.body !== undefined)
    fail('DOCTRINE_WRITE_BODY_UNEXPECTED', 'remove takes no body');
  if (input.operation !== 'remove' && (input.body === undefined || input.body.trim() === ''))
    fail('DOCTRINE_WRITE_BODY_REQUIRED', `${input.operation} needs the body of the doctrine`);
}

/**
 * The plan that creates a new doctrine file holding one new doctrine, for `createFile: true`. The file
 * is UTF-8 without a byte order mark and uses tabs and LF, as the game's own doctrine files do.
 */
export function planNewDoctrineFile(path: string, input: DoctrineWriteInput): DoctrineWritePlan {
  checkRequest(input);
  if (input.operation !== 'add')
    fail('DOCTRINE_WRITE_FILE_NOT_FOUND', `${path} does not exist, and only add can create a file`);
  assertBodyIsOneBlock(input.id, input.body!);
  const text = [`${input.id} = {`, indentedBody(input.body!, '\t', '\n'), '}', ''].join('\n');
  const written = parseClausewitz(Buffer.from(text, 'utf8'), path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('DOCTRINE_WRITE_RESULT_INVALID', 'The new file would have syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  return {
    operation: 'add',
    id: input.id,
    path,
    text,
    bytes: Buffer.from(text, 'utf8'),
    edit: { start: 0, end: 0, text, description: `create ${path} with ${input.id}` },
    diff: unifiedTextDiff('', text, `a/${path}`, `b/${path}`, { context: DIFF_CONTEXT_LINES }),
    untouchedDefinitions: 0,
  };
}

export function planDoctrineWrite(
  source: { bytes: Uint8Array; path: string },
  input: DoctrineWriteInput,
): DoctrineWritePlan {
  checkRequest(input);
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics))
    fail(
      'DOCTRINE_WRITE_SOURCE_INVALID',
      'The source has syntax errors and cannot be edited safely',
      { path: source.path, diagnosticCodes: document.diagnostics.map(({ code }) => code) },
    );
  const text = document.text;
  const newline = document.newline;
  if (input.body !== undefined) assertBodyIsOneBlock(input.id, input.body);
  const located = definitions(document);
  const unit = indentUnit(located, text);
  const existing = located.filter(({ key }) => key.value === input.id);

  let edit: SourceReplacement;
  let skip: AssignmentNode | undefined;

  if (input.operation === 'add') {
    if (existing.length > 0)
      fail('DOCTRINE_WRITE_DUPLICATE_ID', `${input.id} is already defined in this file`, {
        id: input.id,
        line: existing[0]?.key.token.line,
      });
    const lead = text === '' ? '' : `${text.endsWith('\n') ? '' : newline}${newline}`;
    edit = {
      start: text.length,
      end: text.length,
      text: `${lead}${input.id} = {${newline}${indentedBody(input.body!, unit, newline)}${newline}}${newline}`,
      description: `add ${input.id}`,
    };
  } else {
    if (existing.length === 0)
      fail('DOCTRINE_WRITE_NOT_FOUND', `${input.id} is not defined in this file`, {
        id: input.id,
      });
    if (existing.length > 1)
      fail(
        'DOCTRINE_WRITE_DUPLICATE_ID',
        `${input.id} is defined ${existing.length} times in this file`,
        { id: input.id, lines: existing.map(({ key }) => key.token.line) },
      );
    const found = existing[0]!;
    skip = found;
    const indent = lineIndent(text, found.start);
    if (input.operation === 'replace') {
      edit = {
        start: found.start,
        end: found.end,
        text: `${input.id} = {${newline}${indentedBody(input.body!, indent + unit, newline)}${newline}${indent}}`,
        description: `replace ${input.id}`,
      };
    } else {
      const lineStart = text.lastIndexOf('\n', found.start - 1) + 1;
      const lineEndAt = text.indexOf('\n', found.end);
      const lineEnd = lineEndAt === -1 ? text.length : lineEndAt + 1;
      const alone =
        /^[ \t]*$/u.test(text.slice(lineStart, found.start)) &&
        /^[ \t]*\r?$/u.test(text.slice(found.end, lineEndAt === -1 ? text.length : lineEndAt));
      if (!alone) {
        edit = { start: found.start, end: found.end, text: '', description: `remove ${input.id}` };
      } else {
        // A blank line that only separated this doctrine from the one before it goes with it.
        const before = text.slice(0, lineStart);
        const blankBefore = /(?:^|\n)[ \t]*\r?\n$/u.test(before) && before.length > 0;
        const after = text.slice(lineEnd);
        const nextIsBlankOrEnd = /^[ \t]*\r?(?:\n|$)/u.test(after);
        let start = lineStart;
        if (blankBefore && nextIsBlankOrEnd)
          start = before.lastIndexOf('\n', before.length - 2) + 1;
        edit = { start, end: lineEnd, text: '', description: `remove ${input.id}` };
      }
    }
  }

  const bytes = applyReplacements(document, [edit]);
  const after = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const written = parseClausewitz(bytes, source.path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('DOCTRINE_WRITE_RESULT_INVALID', 'The edit would leave the file with syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  const before = definitionTexts(document, skip);
  const afterTexts = definitionTexts(written, undefined);
  let untouched = 0;
  for (const [key, texts] of before) {
    const now = afterTexts.get(key) ?? [];
    for (const textOfDoctrine of texts)
      if (now.includes(textOfDoctrine)) untouched += 1;
      else
        fail(
          'DOCTRINE_WRITE_RESULT_INVALID',
          `The edit would change ${key}, which it must not touch`,
          { key },
        );
  }
  if (written.text !== after)
    fail('DOCTRINE_WRITE_RESULT_INVALID', 'The written file does not match the planned edit');
  return {
    operation: input.operation,
    id: input.id,
    path: source.path,
    text: after,
    bytes,
    edit,
    diff: unifiedTextDiff(text, after, `a/${source.path}`, `b/${source.path}`, {
      context: DIFF_CONTEXT_LINES,
    }),
    untouchedDefinitions: untouched,
  };
}
