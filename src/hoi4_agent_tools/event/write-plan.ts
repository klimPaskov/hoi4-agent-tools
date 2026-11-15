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
 * The edit behind `hoi4.event_write` (issue 159): add, replace or remove one event block of an
 * `events/*.txt` file and nothing else. Every byte outside the touched block, the other events,
 * unrelated top-level entries, comments, the newline style and the encoding, comes back exactly as it
 * was read, and a layout the edit cannot place safely is refused with the reason, not guessed.
 */

export const EVENT_KINDS = [
  'country_event',
  'news_event',
  'state_event',
  'unit_leader_event',
  'operative_leader_event',
] as const;
export type EventWriteKind = (typeof EVENT_KINDS)[number];
export type EventWriteOperation = 'add' | 'replace' | 'remove';

export interface EventWriteInput {
  operation: EventWriteOperation;
  /** The event id, `namespace.number`. */
  id: string;
  /** add only: the event block kind. replace and remove keep the kind the event has. */
  kind?: EventWriteKind;
  /** The text between the event braces. Required by add and replace, refused by remove. */
  body?: string;
  /** add only: write `add_namespace` for the id's namespace when no mod file declares it. */
  createNamespace?: boolean;
  /** Whether a mod file already declares the id's namespace. The caller reads this across the mod. */
  namespaceDeclared?: boolean;
}

export interface EventWritePlan {
  operation: EventWriteOperation;
  id: string;
  kind: EventWriteKind;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The replacements that were made, the event first. */
  edits: SourceReplacement[];
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
  /** The other events of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
  /** Whether the edit also wrote an `add_namespace` line. */
  namespaceAdded: boolean;
}

export const EVENT_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\.[0-9]+$/u;

export function namespaceOf(id: string): string {
  return id.slice(0, id.indexOf('.'));
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

interface Located {
  event: AssignmentNode;
  kind: EventWriteKind;
  id: string;
}

function isKind(key: string): key is EventWriteKind {
  return (EVENT_KINDS as readonly string[]).includes(key);
}

/** Every top-level event block of the document that has an `id`. */
function definitions(document: SourceDocument): Located[] {
  const found: Located[] = [];
  for (const event of assignments(document.root)) {
    const kind = event.key.value;
    if (!isKind(kind) || event.value.type !== 'block') continue;
    const id = assignments(event.value, 'id')[0];
    if (id?.value.type === 'scalar') found.push({ event, kind, id: id.value.value });
  }
  return found;
}

function namespaces(document: SourceDocument): AssignmentNode[] {
  return assignments(document.root, 'add_namespace');
}

/** One level of indentation, read from the file's own events, tabs when it has none. */
function indentUnit(located: readonly Located[], text: string): string {
  for (const { event } of located) {
    if (event.value.type !== 'block') continue;
    const first = event.value.entries[0];
    if (first === undefined) continue;
    const inner = lineIndent(text, first.start);
    const outer = lineIndent(text, event.start);
    if (inner.length > outer.length && inner.startsWith(outer)) return inner.slice(outer.length);
  }
  return '\t';
}

/** The body, checked on its own as the block it will become, and its own `id` when it has one. */
function checkedBody(kind: EventWriteKind, id: string, body: string): string[] {
  const probe = parseClausewitz(Buffer.from(`${kind} = {\n${body}\n}\n`, 'utf8'), 'event-body');
  const only = probe.root.entries;
  const single = only.length === 1 && only[0]?.type === 'assignment' && only[0].key.value === kind;
  if (hasBlockingDiagnostics(probe.diagnostics) || !single || only[0]?.type !== 'assignment')
    fail(
      'EVENT_WRITE_BODY_INVALID',
      'The body must be the text between the braces of one event: balanced braces and no definition of its own',
      { diagnosticCodes: probe.diagnostics.map(({ code }) => code) },
    );
  if (only[0].value.type !== 'block' || only[0].value.entries.length === 0)
    fail('EVENT_WRITE_BODY_INVALID', 'The body of an event cannot be empty');
  const own = assignments(only[0].value, 'id');
  if (own.length > 1) fail('EVENT_WRITE_BODY_INVALID', 'The body names an id more than once');
  if (own[0] !== undefined && (own[0].value.type !== 'scalar' || own[0].value.value !== id))
    fail(
      'EVENT_WRITE_ID_MISMATCH',
      `The body has its own id, which is not ${id}; leave id out of the body, the tool writes it`,
      { id },
    );
  return own.length === 1 ? [] : [`id = ${id}`];
}

function definitionTexts(document: SourceDocument, skip?: AssignmentNode): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const { event, id } of definitions(document)) {
    if (event.start === skip?.start) continue;
    byId.set(id, [...(byId.get(id) ?? []), document.text.slice(event.start, event.end)]);
  }
  return byId;
}

function checkRequest(input: EventWriteInput): void {
  if (!EVENT_ID_PATTERN.test(input.id))
    fail(
      'EVENT_WRITE_ID_INVALID',
      `${JSON.stringify(input.id)} is not a valid event id; it is a namespace, a dot and a number, as in my_events.1`,
      { id: input.id },
    );
  if (input.operation === 'remove' && input.body !== undefined)
    fail('EVENT_WRITE_BODY_UNEXPECTED', 'remove takes no body');
  if (input.operation !== 'remove' && (input.body === undefined || input.body.trim() === ''))
    fail('EVENT_WRITE_BODY_REQUIRED', `${input.operation} needs the body of the event`);
  if (input.operation !== 'add' && input.createNamespace === true)
    fail('EVENT_WRITE_NAMESPACE_UNEXPECTED', 'createNamespace applies to add only');
}

/** The event block text at `indent`, with `id` first. */
function blockText(
  kind: EventWriteKind,
  id: string,
  body: string,
  idLine: string[],
  indent: string,
  unit: string,
  newline: string,
): string {
  const inner = indent + unit;
  const lines = [
    ...idLine.map((line) => `${inner}${line}`),
    indentedBody(body, inner, newline),
  ].join(newline);
  return `${indent}${kind} = {${newline}${lines}${newline}${indent}}`;
}

function assertWritten(
  document: SourceDocument,
  edits: SourceReplacement[],
  path: string,
  skip: AssignmentNode | undefined,
): { bytes: Buffer; after: string; untouched: number } {
  const bytes = applyReplacements(document, edits);
  const written = parseClausewitz(bytes, path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('EVENT_WRITE_RESULT_INVALID', 'The edit would leave the file with syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  const before = definitionTexts(document, skip);
  const afterTexts = definitionTexts(written, undefined);
  let untouched = 0;
  for (const [id, texts] of before) {
    const now = afterTexts.get(id) ?? [];
    for (const text of texts)
      if (now.includes(text)) untouched += 1;
      else
        fail('EVENT_WRITE_RESULT_INVALID', `The edit would change ${id}, which it must not touch`, {
          id,
        });
  }
  return { bytes, after: written.text, untouched };
}

/**
 * The plan that creates a new `events` file holding the namespace line and one new event, for
 * `createFile: true`. The file is UTF-8 without a byte order mark and uses tabs and LF, as the game's
 * own event files do.
 */
export function planNewEventFile(path: string, input: EventWriteInput): EventWritePlan {
  checkRequest(input);
  if (input.operation !== 'add')
    fail('EVENT_WRITE_FILE_NOT_FOUND', `${path} does not exist, and only add can create a file`);
  const kind = input.kind ?? 'country_event';
  const idLine = checkedBody(kind, input.id, input.body!);
  const namespaceAdded = input.namespaceDeclared !== true;
  if (namespaceAdded && input.createNamespace !== true)
    fail(
      'EVENT_WRITE_NAMESPACE_MISSING',
      `No mod file declares the namespace ${namespaceOf(input.id)}; pass createNamespace: true to write add_namespace`,
      { namespace: namespaceOf(input.id) },
    );
  const text = [
    ...(namespaceAdded ? [`add_namespace = ${namespaceOf(input.id)}`, ''] : []),
    blockText(kind, input.id, input.body!, idLine, '', '\t', '\n'),
    '',
  ].join('\n');
  const written = parseClausewitz(Buffer.from(text, 'utf8'), path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('EVENT_WRITE_RESULT_INVALID', 'The new file would have syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  return {
    operation: 'add',
    id: input.id,
    kind,
    path,
    text,
    bytes: Buffer.from(text, 'utf8'),
    edits: [{ start: 0, end: 0, text, description: `create ${path} with ${input.id}` }],
    diff: unifiedTextDiff('', text, `a/${path}`, `b/${path}`, { context: DIFF_CONTEXT_LINES }),
    untouchedDefinitions: 0,
    namespaceAdded,
  };
}

export function planEventWrite(
  source: { bytes: Uint8Array; path: string },
  input: EventWriteInput,
): EventWritePlan {
  checkRequest(input);
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics))
    fail('EVENT_WRITE_SOURCE_INVALID', 'The source has syntax errors and cannot be edited safely', {
      path: source.path,
      diagnosticCodes: document.diagnostics.map(({ code }) => code),
    });
  const text = document.text;
  const newline = document.newline;
  const located = definitions(document);
  const unit = indentUnit(located, text);
  const existing = located.filter(({ id }) => id === input.id);
  const edits: SourceReplacement[] = [];
  let skip: AssignmentNode | undefined;
  let kind: EventWriteKind;
  let namespaceAdded = false;

  if (input.operation === 'add') {
    kind = input.kind ?? 'country_event';
    if (existing.length > 0)
      fail('EVENT_WRITE_DUPLICATE_ID', `${input.id} is already defined in this file`, {
        id: input.id,
        line: existing[0]?.event.key.token.line,
      });
    const idLine = checkedBody(kind, input.id, input.body!);
    const declaredHere = namespaces(document).some(
      ({ value }) => value.type === 'scalar' && value.value === namespaceOf(input.id),
    );
    if (!declaredHere && input.namespaceDeclared !== true) {
      if (input.createNamespace !== true)
        fail(
          'EVENT_WRITE_NAMESPACE_MISSING',
          `No mod file declares the namespace ${namespaceOf(input.id)}; pass createNamespace: true to write add_namespace`,
          { namespace: namespaceOf(input.id) },
        );
      namespaceAdded = true;
      const lines = namespaces(document);
      const last = lines.at(-1);
      const first = document.root.entries[0];
      if (last !== undefined) {
        const lineEndAt = text.indexOf('\n', last.end);
        const at = lineEndAt === -1 ? text.length : lineEndAt + 1;
        edits.push({
          start: at,
          end: at,
          text: `${lineEndAt === -1 ? newline : ''}add_namespace = ${namespaceOf(input.id)}${newline}`,
          description: `declare the namespace ${namespaceOf(input.id)}`,
        });
      } else if (first !== undefined) {
        const at = text.lastIndexOf('\n', first.start - 1) + 1;
        edits.push({
          start: at,
          end: at,
          text: `add_namespace = ${namespaceOf(input.id)}${newline}${newline}`,
          description: `declare the namespace ${namespaceOf(input.id)}`,
        });
      }
    }
    const block = blockText(kind, input.id, input.body!, idLine, '', unit, newline);
    const lead = text === '' ? '' : `${text.endsWith('\n') ? '' : newline}${newline}`;
    edits.push({
      start: text.length,
      end: text.length,
      text: `${lead}${block}${newline}`,
      description: `add ${input.id}`,
    });
    if (namespaceAdded && document.root.entries.length === 0)
      edits.splice(0, edits.length, {
        start: text.length,
        end: text.length,
        text: `${text === '' ? '' : newline}add_namespace = ${namespaceOf(input.id)}${newline}${newline}${block}${newline}`,
        description: `add ${input.id} and declare its namespace`,
      });
  } else {
    if (existing.length === 0)
      fail('EVENT_WRITE_NOT_FOUND', `${input.id} is not defined in this file`, { id: input.id });
    if (existing.length > 1)
      fail(
        'EVENT_WRITE_DUPLICATE_ID',
        `${input.id} is defined ${existing.length} times in this file`,
        { id: input.id, lines: existing.map(({ event }) => event.key.token.line) },
      );
    const found = existing[0]!;
    kind = found.kind;
    if (input.kind !== undefined && input.kind !== kind)
      fail(
        'EVENT_WRITE_KIND_MISMATCH',
        `${input.id} is a ${kind}, and changing the kind of an event is not supported`,
        { id: input.id, kind },
      );
    skip = found.event;
    if (input.operation === 'replace') {
      const idLine = checkedBody(kind, input.id, input.body!);
      const indent = lineIndent(text, found.event.start);
      edits.push({
        start: found.event.start,
        end: found.event.end,
        text: blockText(kind, input.id, input.body!, idLine, indent, unit, newline).slice(
          indent.length,
        ),
        description: `replace ${input.id}`,
      });
    } else {
      const lineStart = text.lastIndexOf('\n', found.event.start - 1) + 1;
      const lineEndAt = text.indexOf('\n', found.event.end);
      const lineEnd = lineEndAt === -1 ? text.length : lineEndAt + 1;
      const alone =
        /^[ \t]*$/u.test(text.slice(lineStart, found.event.start)) &&
        /^[ \t]*\r?$/u.test(
          text.slice(found.event.end, lineEndAt === -1 ? text.length : lineEndAt),
        );
      if (!alone) {
        edits.push({
          start: found.event.start,
          end: found.event.end,
          text: '',
          description: `remove ${input.id}`,
        });
      } else {
        // A blank line that only separated this event from the one before it goes with it.
        const before = text.slice(0, lineStart);
        const blankBefore = /(?:^|\n)[ \t]*\r?\n$/u.test(before) && before.length > 0;
        const after = text.slice(lineEnd);
        const nextIsBlank = /^[ \t]*\r?(?:\n|$)/u.test(after);
        let start = lineStart;
        if (blankBefore && (nextIsBlank || after === ''))
          start = before.lastIndexOf('\n', before.length - 2) + 1;
        edits.push({ start, end: lineEnd, text: '', description: `remove ${input.id}` });
      }
    }
  }

  const { bytes, after, untouched } = assertWritten(document, edits, source.path, skip);
  return {
    operation: input.operation,
    id: input.id,
    kind,
    path: source.path,
    text: after,
    bytes,
    edits,
    diff: unifiedTextDiff(text, after, `a/${source.path}`, `b/${source.path}`, {
      context: DIFF_CONTEXT_LINES,
    }),
    untouchedDefinitions: untouched,
    namespaceAdded,
  };
}

/** The ids of the events in a source, and the namespaces it declares. */
export function eventFileContents(source: { bytes: Uint8Array; path: string }): {
  ids: string[];
  namespaces: string[];
} {
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics)) return { ids: [], namespaces: [] };
  return {
    ids: definitions(document).map(({ id }) => id),
    namespaces: namespaces(document).flatMap(({ value }) =>
      value.type === 'scalar' ? [value.value] : [],
    ),
  };
}
