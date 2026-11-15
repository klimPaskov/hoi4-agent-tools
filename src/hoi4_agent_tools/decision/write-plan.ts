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
 * The edit behind `hoi4.decision_write` (issue 159): add, replace or remove one decision of a
 * `common/decisions/*.txt` file and nothing else. Every byte outside the touched block, its comments,
 * its neighbours, the newline style and the encoding, comes back exactly as it was read, and a layout
 * the edit cannot place safely is refused with the reason, not guessed.
 */

export type DecisionWriteOperation = 'add' | 'replace' | 'remove';

export interface DecisionWriteInput {
  operation: DecisionWriteOperation;
  /** The decision to add, replace or remove. */
  id: string;
  /** The category block the decision lives in. */
  category?: string;
  /** add only: put the decision in a category block the file does not have yet, creating it. */
  createCategory?: boolean;
  /** The text between the decision's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface DecisionWritePlan {
  operation: DecisionWriteOperation;
  id: string;
  category: string;
  path: string;
  /** The source after the edit, decoded. */
  text: string;
  /** The file after the edit, in its own encoding. */
  bytes: Buffer;
  /** The one replacement that was made. */
  edit: SourceReplacement;
  /** A unified diff of the file, empty when nothing changed. */
  diff: string;
  /** The decisions of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

interface Located {
  decision: AssignmentNode;
  category: AssignmentNode;
}

/** The top-level category blocks of a decisions file. */
function categoryBlocks(document: SourceDocument): AssignmentNode[] {
  return assignments(document.root).filter(({ value }) => value.type === 'block');
}

/** Every `<category> = { <decision> = { ... } }` definition of the document. */
function definitions(document: SourceDocument): Located[] {
  return categoryBlocks(document).flatMap((category) =>
    category.value.type === 'block'
      ? assignments(category.value)
          .filter(({ value }) => value.type === 'block')
          .map((decision) => ({ decision, category }))
      : [],
  );
}

/** One level of indentation, read from the file's own decisions, tabs when it has none. */
function indentUnit(document: SourceDocument, located: readonly Located[]): string {
  for (const { decision, category } of located) {
    const outer = lineIndent(document.text, category.start);
    const inner = lineIndent(document.text, decision.start);
    if (inner.length > outer.length && inner.startsWith(outer)) return inner.slice(outer.length);
  }
  return '\t';
}

/** The body, checked on its own as the block it will become. */
function assertBodyIsOneBlock(id: string, body: string): void {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'decision-body');
  const only = probe.root.entries;
  const single = only.length === 1 && only[0]?.type === 'assignment' && only[0].key.value === id;
  if (hasBlockingDiagnostics(probe.diagnostics) || !single || only[0]?.type !== 'assignment')
    fail(
      'DECISION_WRITE_BODY_INVALID',
      'The body must be the text between the braces of one decision: balanced braces and no definition of its own',
      { diagnosticCodes: probe.diagnostics.map(({ code }) => code) },
    );
  if (only[0].value.type !== 'block' || only[0].value.entries.length === 0)
    fail('DECISION_WRITE_BODY_INVALID', 'The body of a decision cannot be empty');
}

function definitionTexts(document: SourceDocument, skip?: AssignmentNode): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const { decision, category } of definitions(document)) {
    if (decision.start === skip?.start) continue;
    const key = `${category.key.value}:${decision.key.value}`;
    byKey.set(key, [...(byKey.get(key) ?? []), document.text.slice(decision.start, decision.end)]);
  }
  return byKey;
}

function checkRequest(input: DecisionWriteInput): void {
  if (!ID_PATTERN.test(input.id))
    fail('DECISION_WRITE_ID_INVALID', `${JSON.stringify(input.id)} is not a valid decision id`, {
      id: input.id,
    });
  if (input.operation === 'remove' && input.body !== undefined)
    fail('DECISION_WRITE_BODY_UNEXPECTED', 'remove takes no body');
  if (input.operation !== 'remove' && (input.body === undefined || input.body.trim() === ''))
    fail('DECISION_WRITE_BODY_REQUIRED', `${input.operation} needs the body of the decision`);
  if (input.operation !== 'add' && input.createCategory === true)
    fail('DECISION_WRITE_CATEGORY_UNEXPECTED', 'createCategory applies to add only');
  if (input.category !== undefined && !ID_PATTERN.test(input.category))
    fail(
      'DECISION_WRITE_CATEGORY_INVALID',
      `${JSON.stringify(input.category)} is not a valid category name`,
      { category: input.category },
    );
}

/**
 * The plan that creates a new `common/decisions` file holding one category block with one new
 * decision, for `createFile: true`. The file is UTF-8 without a byte order mark and uses tabs and LF.
 */
export function planNewDecisionFile(path: string, input: DecisionWriteInput): DecisionWritePlan {
  checkRequest(input);
  if (input.operation !== 'add')
    fail('DECISION_WRITE_FILE_NOT_FOUND', `${path} does not exist, and only add can create a file`);
  if (input.category === undefined)
    fail(
      'DECISION_WRITE_CATEGORY_REQUIRED',
      'a new file needs the category block the decision goes in',
    );
  assertBodyIsOneBlock(input.id, input.body!);
  const text = [
    `${input.category} = {`,
    `\t${input.id} = {`,
    indentedBody(input.body!, '\t\t', '\n'),
    '\t}',
    '}',
    '',
  ].join('\n');
  const written = parseClausewitz(Buffer.from(text, 'utf8'), path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('DECISION_WRITE_RESULT_INVALID', 'The new file would have syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  return {
    operation: 'add',
    id: input.id,
    category: input.category,
    path,
    text,
    bytes: Buffer.from(text, 'utf8'),
    edit: { start: 0, end: 0, text, description: `create ${path} with ${input.id}` },
    diff: unifiedTextDiff('', text, `a/${path}`, `b/${path}`, { context: DIFF_CONTEXT_LINES }),
    untouchedDefinitions: 0,
  };
}

export function planDecisionWrite(
  source: { bytes: Uint8Array; path: string },
  input: DecisionWriteInput,
): DecisionWritePlan {
  checkRequest(input);
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics))
    fail(
      'DECISION_WRITE_SOURCE_INVALID',
      'The source has syntax errors and cannot be edited safely',
      { path: source.path, diagnosticCodes: document.diagnostics.map(({ code }) => code) },
    );
  const text = document.text;
  const newline = document.newline;
  const located = definitions(document);
  if (input.body !== undefined) assertBodyIsOneBlock(input.id, input.body);
  const unit = indentUnit(document, located);
  const existing = located.filter(({ decision }) => decision.key.value === input.id);

  let edit: SourceReplacement;
  let category: string;
  let skip: AssignmentNode | undefined;

  if (input.operation === 'add') {
    if (existing.length > 0)
      fail('DECISION_WRITE_DUPLICATE_ID', `${input.id} is already defined in this file`, {
        id: input.id,
        category: existing[0]?.category.key.value,
        line: existing[0]?.decision.key.token.line,
      });
    if (input.category === undefined)
      fail('DECISION_WRITE_CATEGORY_REQUIRED', 'add needs the category block the decision goes in');
    const wanted = input.category;
    const matching = categoryBlocks(document).filter(({ key }) => key.value === wanted);
    if (matching.length === 0 && input.createCategory !== true)
      fail(
        'DECISION_WRITE_CATEGORY_NOT_FOUND',
        `The file has no ${wanted} category block; pass createCategory: true to create it`,
        {
          category: wanted,
          categories: [...new Set(categoryBlocks(document).map(({ key }) => key.value))],
        },
      );
    if (matching.length > 1)
      fail(
        'DECISION_WRITE_CATEGORY_AMBIGUOUS',
        `The file has ${matching.length} ${wanted} category blocks`,
        { category: wanted, lines: matching.map(({ key }) => key.token.line) },
      );
    if (matching.length === 0) {
      const lead = text === '' ? '' : `${text.endsWith('\n') ? '' : newline}${newline}`;
      edit = {
        start: text.length,
        end: text.length,
        text: `${lead}${wanted} = {${newline}${unit}${input.id} = {${newline}${indentedBody(input.body!, unit + unit, newline)}${newline}${unit}}${newline}}${newline}`,
        description: `add ${input.id} in the new category ${wanted}`,
      };
    } else {
      const target = matching[0]!;
      const block = target.value as BlockNode;
      const close = block.close;
      if (close === undefined)
        fail('DECISION_WRITE_LAYOUT_UNSUPPORTED', `The ${wanted} category has no closing brace`);
      const closeLineStart = text.lastIndexOf('\n', close.start - 1) + 1;
      if (!/^[ \t]*$/u.test(text.slice(closeLineStart, close.start)))
        fail(
          'DECISION_WRITE_LAYOUT_UNSUPPORTED',
          `The closing brace of ${wanted} shares its line with other text, so the new decision has no line to go on`,
          { category: wanted, line: close.line },
        );
      const decisionIndent = lineIndent(text, target.start) + unit;
      const decisionText = `${decisionIndent}${input.id} = {${newline}${indentedBody(input.body!, decisionIndent + unit, newline)}${newline}${decisionIndent}}${newline}`;
      edit = {
        start: closeLineStart,
        end: closeLineStart,
        text: `${block.entries.length > 0 ? newline : ''}${decisionText}`,
        description: `add ${input.id} to ${wanted}`,
      };
    }
    category = wanted;
  } else {
    if (existing.length === 0)
      fail('DECISION_WRITE_NOT_FOUND', `${input.id} is not defined in this file`, {
        id: input.id,
      });
    if (existing.length > 1)
      fail(
        'DECISION_WRITE_DUPLICATE_ID',
        `${input.id} is defined ${existing.length} times in this file`,
        { id: input.id, lines: existing.map(({ decision }) => decision.key.token.line) },
      );
    const found = existing[0]!;
    category = found.category.key.value;
    if (input.category !== undefined && input.category !== category)
      fail(
        'DECISION_WRITE_CATEGORY_MISMATCH',
        `${input.id} is in ${category}, and moving a decision to another category is not supported`,
        { id: input.id, category },
      );
    skip = found.decision;
    const decisionIndent = lineIndent(text, found.decision.start);
    if (input.operation === 'replace') {
      edit = {
        start: found.decision.start,
        end: found.decision.end,
        text: `${input.id} = {${newline}${indentedBody(input.body!, decisionIndent + unit, newline)}${newline}${decisionIndent}}`,
        description: `replace ${input.id}`,
      };
    } else {
      const lineStart = text.lastIndexOf('\n', found.decision.start - 1) + 1;
      const lineEndAt = text.indexOf('\n', found.decision.end);
      const lineEnd = lineEndAt === -1 ? text.length : lineEndAt + 1;
      const alone =
        /^[ \t]*$/u.test(text.slice(lineStart, found.decision.start)) &&
        /^[ \t]*\r?$/u.test(
          text.slice(found.decision.end, lineEndAt === -1 ? text.length : lineEndAt),
        );
      if (!alone) {
        edit = {
          start: found.decision.start,
          end: found.decision.end,
          text: '',
          description: `remove ${input.id}`,
        };
      } else {
        // A blank line that only separated this decision from the one before it goes with it.
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
    fail('DECISION_WRITE_RESULT_INVALID', 'The edit would leave the file with syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  const before = definitionTexts(document, skip);
  const afterTexts = definitionTexts(written, undefined);
  let untouched = 0;
  for (const [key, texts] of before) {
    const now = afterTexts.get(key) ?? [];
    for (const textOfDecision of texts)
      if (now.includes(textOfDecision)) untouched += 1;
      else
        fail(
          'DECISION_WRITE_RESULT_INVALID',
          `The edit would change ${key}, which it must not touch`,
          { key },
        );
  }
  if (written.text !== after)
    fail('DECISION_WRITE_RESULT_INVALID', 'The written file does not match the planned edit');
  return {
    operation: input.operation,
    id: input.id,
    category,
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

/** The category blocks of a `common/decisions` file, or none when the file cannot be parsed. */
export function decisionCategories(source: { bytes: Uint8Array; path: string }): string[] {
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics)) return [];
  return [...new Set(categoryBlocks(document).map(({ key }) => key.value))];
}
