import { indentedBody, lineIndent } from '../core/block-edit.js';
import { hasBlockingDiagnostics } from '../core/diagnostics.js';
import { DIFF_CONTEXT_LINES, unifiedTextDiff } from '../core/diff.js';
import { ServiceError } from '../core/result.js';
import {
  applyReplacements,
  assignments,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceDocument,
  type SourceReplacement,
} from '../core/source/index.js';

/**
 * The edit behind `hoi4.tech_write` (issue 158): add, replace or remove one technology of a
 * `common/technologies/*.txt` file and nothing else. Every byte outside the touched block, its comments,
 * its neighbours, the newline style and the encoding, comes back exactly as it was read, and a
 * layout the edit cannot place safely is refused with the reason, not guessed.
 */

export type TechWriteOperation = 'add' | 'replace' | 'remove';

export interface TechWriteInput {
  operation: TechWriteOperation;
  /** The technology to add, replace or remove. */
  id: string;
  /** The text between the tech's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface TechWritePlan {
  operation: TechWriteOperation;
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
  /** The technologynologies of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

/** Every `technologies = { <id> = { ... } }` definition of the document. */
function definitions(document: SourceDocument): AssignmentNode[] {
  return assignments(document.root, 'technologies').flatMap((technologies) =>
    technologies.value.type === 'block'
      ? assignments(technologies.value).filter(({ value }) => value.type === 'block')
      : [],
  );
}

/** One level of indentation, read from the file's own technologies, tabs when it has none. */
function indentUnit(document: SourceDocument): string {
  for (const technologies of assignments(document.root, 'technologies')) {
    if (technologies.value.type !== 'block') continue;
    const outer = lineIndent(document.text, technologies.start);
    for (const tech of assignments(technologies.value)) {
      const inner = lineIndent(document.text, tech.start);
      if (inner.length > outer.length && inner.startsWith(outer)) return inner.slice(outer.length);
    }
  }
  return '\t';
}

/** The body, checked on its own as the block it will become. */
function assertBodyIsOneBlock(id: string, body: string): void {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'tech-body');
  const only = probe.root.entries;
  const single = only.length === 1 && only[0]?.type === 'assignment' && only[0].key.value === id;
  if (hasBlockingDiagnostics(probe.diagnostics) || !single || only[0]?.type !== 'assignment')
    fail(
      'TECH_WRITE_BODY_INVALID',
      'The body must be the text between the braces of one technology: balanced braces and no definition of its own',
      { diagnosticCodes: probe.diagnostics.map(({ code }) => code) },
    );
  if (only[0].value.type !== 'block' || only[0].value.entries.length === 0)
    fail('TECH_WRITE_BODY_INVALID', 'The body of a technology cannot be empty');
}

function definitionTexts(document: SourceDocument, skip?: AssignmentNode): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const tech of definitions(document)) {
    if (tech.start === skip?.start) continue;
    const key = tech.key.value;
    byKey.set(key, [...(byKey.get(key) ?? []), document.text.slice(tech.start, tech.end)]);
  }
  return byKey;
}

function checkRequest(input: TechWriteInput): void {
  if (!ID_PATTERN.test(input.id))
    fail('TECH_WRITE_ID_INVALID', `${JSON.stringify(input.id)} is not a valid tech id`, {
      id: input.id,
    });
  if (input.operation === 'remove' && input.body !== undefined)
    fail('TECH_WRITE_BODY_UNEXPECTED', 'remove takes no body');
  if (input.operation !== 'remove' && (input.body === undefined || input.body.trim() === ''))
    fail('TECH_WRITE_BODY_REQUIRED', `${input.operation} needs the body of the tech`);
}

/**
 * The plan that creates a new `common/technologies` file holding one new technology, for
 * `createFile: true`. The file is UTF-8 without a byte order mark and uses tabs and LF, as the
 * game's own tech files do.
 */
export function planNewTechFile(path: string, input: TechWriteInput): TechWritePlan {
  checkRequest(input);
  if (input.operation !== 'add')
    fail('TECH_WRITE_FILE_NOT_FOUND', `${path} does not exist, and only add can create a file`);
  assertBodyIsOneBlock(input.id, input.body!);
  const text = [
    'technologies = {',
    `\t${input.id} = {`,
    indentedBody(input.body!, '\t\t', '\n'),
    '\t}',
    '}',
    '',
  ].join('\n');
  const written = parseClausewitz(Buffer.from(text, 'utf8'), path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('TECH_WRITE_RESULT_INVALID', 'The new file would have syntax errors', {
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

export function planTechWrite(
  source: { bytes: Uint8Array; path: string },
  input: TechWriteInput,
): TechWritePlan {
  checkRequest(input);
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics))
    fail('TECH_WRITE_SOURCE_INVALID', 'The source has syntax errors and cannot be edited safely', {
      path: source.path,
      diagnosticCodes: document.diagnostics.map(({ code }) => code),
    });
  const text = document.text;
  const newline = document.newline;
  if (input.body !== undefined) assertBodyIsOneBlock(input.id, input.body);
  const unit = indentUnit(document);
  const existing = definitions(document).filter(({ key }) => key.value === input.id);

  let edit: SourceReplacement;
  let skip: AssignmentNode | undefined;

  if (input.operation === 'add') {
    if (existing.length > 0)
      fail('TECH_WRITE_DUPLICATE_ID', `${input.id} is already defined in this file`, {
        id: input.id,
        line: existing[0]?.key.token.line,
      });
    const blocks = assignments(document.root, 'technologies').filter(
      ({ value }) => value.type === 'block',
    );
    if (blocks.length !== 1)
      fail(
        'TECH_WRITE_LAYOUT_UNSUPPORTED',
        blocks.length === 0
          ? 'The file has no technologies block to put the new technology in'
          : `The file has ${blocks.length} technologies blocks, so the new technology has no single place`,
        { blocks: blocks.length },
      );
    const technologies = blocks[0]!;
    const block = technologies.value as BlockNode;
    const close = block.close;
    if (close === undefined)
      fail('TECH_WRITE_LAYOUT_UNSUPPORTED', 'The technologynologies block has no closing brace');
    const closeLineStart = text.lastIndexOf('\n', close.start - 1) + 1;
    if (!/^[ \t]*$/u.test(text.slice(closeLineStart, close.start)))
      fail(
        'TECH_WRITE_LAYOUT_UNSUPPORTED',
        'The closing brace of the technologies block shares its line with other text, so the new technology has no line to go on',
        { line: close.line },
      );
    const techIndent = lineIndent(text, technologies.start) + unit;
    const techText = `${techIndent}${input.id} = {${newline}${indentedBody(input.body!, techIndent + unit, newline)}${newline}${techIndent}}${newline}`;
    edit = {
      start: closeLineStart,
      end: closeLineStart,
      text: `${block.entries.length > 0 ? newline : ''}${techText}`,
      description: `add ${input.id}`,
    };
  } else {
    if (existing.length === 0)
      fail('TECH_WRITE_NOT_FOUND', `${input.id} is not defined in this file`, {
        id: input.id,
      });
    if (existing.length > 1)
      fail(
        'TECH_WRITE_DUPLICATE_ID',
        `${input.id} is defined ${existing.length} times in this file`,
        { id: input.id, lines: existing.map(({ key }) => key.token.line) },
      );
    const found = existing[0]!;
    skip = found;
    const techIndent = lineIndent(text, found.start);
    if (input.operation === 'replace') {
      edit = {
        start: found.start,
        end: found.end,
        text: `${input.id} = {${newline}${indentedBody(input.body!, techIndent + unit, newline)}${newline}${techIndent}}`,
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
        // A blank line that only separated this tech from the one before it goes with it.
        const before = text.slice(0, lineStart);
        const blankBefore = /(?:^|\n)[ \t]*\r?\n$/u.test(before) && before.length > 0;
        const after = text.slice(lineEnd);
        const nextIsBlankOrClose = /^[ \t]*(?:\r?\n|\})/u.test(after) || after === '';
        let start = lineStart;
        if (blankBefore && nextIsBlankOrClose)
          start = before.lastIndexOf('\n', before.length - 2) + 1;
        edit = { start, end: lineEnd, text: '', description: `remove ${input.id}` };
      }
    }
  }

  const bytes = applyReplacements(document, [edit]);
  const after = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const written = parseClausewitz(bytes, source.path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('TECH_WRITE_RESULT_INVALID', 'The edit would leave the file with syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  const before = definitionTexts(document, skip);
  const afterTexts = definitionTexts(written, undefined);
  let untouched = 0;
  for (const [key, texts] of before) {
    const now = afterTexts.get(key) ?? [];
    for (const textOfTech of texts)
      if (now.includes(textOfTech)) untouched += 1;
      else
        fail('TECH_WRITE_RESULT_INVALID', `The edit would change ${key}, which it must not touch`, {
          key,
        });
  }
  if (written.text !== after)
    fail('TECH_WRITE_RESULT_INVALID', 'The written file does not match the planned edit');
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
