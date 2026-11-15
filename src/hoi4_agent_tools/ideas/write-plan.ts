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
 * The edit behind `hoi4.idea_write` (issue 158): add, replace or remove one idea definition of a
 * `common/ideas/*.txt` file and nothing else. Every byte outside the touched block, its comments,
 * its neighbours, the newline style and the encoding, comes back exactly as it was read, and a
 * layout the edit cannot place safely is refused with the reason, not guessed.
 */

export type IdeaWriteOperation = 'add' | 'replace' | 'remove';

export interface IdeaWriteInput {
  operation: IdeaWriteOperation;
  /** The idea to add, replace or remove. */
  id: string;
  /** The category block the idea lives in (`country`, `hidden_ideas`, an advisor slot). */
  category?: string;
  /** add only: put the idea in a category the file does not have yet, creating it. */
  createCategory?: boolean;
  /** The text between the idea's braces. Required by add and replace, refused by remove. */
  body?: string;
}

export interface IdeaWritePlan {
  operation: IdeaWriteOperation;
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
  /** The definitions of the file that the edit left untouched, byte for byte. */
  untouchedDefinitions: number;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

interface Located {
  idea: AssignmentNode;
  category: AssignmentNode;
  categoryBlock: BlockNode;
}

/** Every `ideas = { <category> = { <id> = { ... } } }` definition of the document. */
function definitions(document: SourceDocument): Located[] {
  const found: Located[] = [];
  for (const ideas of assignments(document.root, 'ideas')) {
    if (ideas.value.type !== 'block') continue;
    for (const category of assignments(ideas.value)) {
      if (category.value.type !== 'block') continue;
      for (const idea of assignments(category.value)) {
        if (idea.value.type !== 'block') continue;
        found.push({
          idea,
          category,
          categoryBlock: category.value,
        });
      }
    }
  }
  return found;
}

function categoryBlocks(document: SourceDocument): AssignmentNode[] {
  return assignments(document.root, 'ideas').flatMap((ideas) =>
    ideas.value.type === 'block'
      ? assignments(ideas.value).filter(({ value }) => value.type === 'block')
      : [],
  );
}

/** One level of indentation, read from the file's own ideas, tabs when it has none. */
function indentUnit(document: SourceDocument, located: readonly Located[]): string {
  for (const { idea, category } of located) {
    const outer = lineIndent(document.text, category.start);
    const inner = lineIndent(document.text, idea.start);
    if (inner.length > outer.length && inner.startsWith(outer)) return inner.slice(outer.length);
  }
  return '\t';
}

/** The body, checked on its own as the block it will become. */
function assertBodyIsOneBlock(id: string, body: string): void {
  const probe = parseClausewitz(Buffer.from(`${id} = {\n${body}\n}\n`, 'utf8'), 'idea-body');
  const only = probe.root.entries;
  const single = only.length === 1 && only[0]?.type === 'assignment' && only[0].key.value === id;
  if (hasBlockingDiagnostics(probe.diagnostics) || !single || only[0]?.type !== 'assignment')
    fail(
      'IDEA_WRITE_BODY_INVALID',
      'The body must be the text between the braces of one idea: balanced braces and no definition of its own',
      { diagnosticCodes: probe.diagnostics.map(({ code }) => code) },
    );
  if (only[0].value.type !== 'block' || only[0].value.entries.length === 0)
    fail('IDEA_WRITE_BODY_INVALID', 'The body of an idea cannot be empty');
}

function definitionTexts(document: SourceDocument, skip?: AssignmentNode): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const { idea, category } of definitions(document)) {
    if (idea.start === skip?.start) continue;
    const key = `${category.key.value}:${idea.key.value}`;
    byKey.set(key, [...(byKey.get(key) ?? []), document.text.slice(idea.start, idea.end)]);
  }
  return byKey;
}

/**
 * The edit that adds a category block holding the new idea to the file's single `ideas` block, for
 * `createCategory: true`.
 */
function categoryCreation(
  document: SourceDocument,
  input: IdeaWriteInput,
  unit: string,
): SourceReplacement {
  const wanted = input.category!;
  if (!ID_PATTERN.test(wanted))
    fail('IDEA_WRITE_CATEGORY_INVALID', `${JSON.stringify(wanted)} is not a valid category name`, {
      category: wanted,
    });
  const text = document.text;
  const newline = document.newline;
  const ideasBlocks = assignments(document.root, 'ideas').filter(
    ({ value }) => value.type === 'block',
  );
  if (ideasBlocks.length !== 1)
    fail(
      'IDEA_WRITE_LAYOUT_UNSUPPORTED',
      ideasBlocks.length === 0
        ? 'The file has no ideas block to put a new category in'
        : `The file has ${ideasBlocks.length} ideas blocks, so the new category has no single place`,
      { blocks: ideasBlocks.length },
    );
  const ideas = ideasBlocks[0]!;
  const block = ideas.value as BlockNode;
  const close = block.close;
  if (close === undefined)
    fail('IDEA_WRITE_LAYOUT_UNSUPPORTED', 'The ideas block has no closing brace');
  const closeLineStart = text.lastIndexOf('\n', close.start - 1) + 1;
  if (!/^[ \t]*$/u.test(text.slice(closeLineStart, close.start)))
    fail(
      'IDEA_WRITE_LAYOUT_UNSUPPORTED',
      'The closing brace of the ideas block shares its line with other text',
      { line: close.line },
    );
  const categoryIndent = lineIndent(text, ideas.start) + unit;
  const ideaIndent = categoryIndent + unit;
  const ideaText = `${ideaIndent}${input.id} = {${newline}${indentedBody(input.body!, ideaIndent + unit, newline)}${newline}${ideaIndent}}${newline}`;
  return {
    start: closeLineStart,
    end: closeLineStart,
    text: `${block.entries.length > 0 ? newline : ''}${categoryIndent}${wanted} = {${newline}${ideaText}${categoryIndent}}${newline}`,
    description: `add ${input.id} in the new category ${wanted}`,
  };
}

/**
 * The plan that creates a new `common/ideas` file holding one new idea in one category, for
 * `createFile: true`. The file is UTF-8 without a byte order mark and uses tabs and LF, as the
 * game's own ideas files do.
 */
export function planNewIdeaFile(path: string, input: IdeaWriteInput): IdeaWritePlan {
  if (!ID_PATTERN.test(input.id))
    fail('IDEA_WRITE_ID_INVALID', `${JSON.stringify(input.id)} is not a valid idea id`, {
      id: input.id,
    });
  if (input.operation !== 'add')
    fail('IDEA_WRITE_FILE_NOT_FOUND', `${path} does not exist, and only add can create a file`);
  if (input.category === undefined || !ID_PATTERN.test(input.category))
    fail('IDEA_WRITE_CATEGORY_REQUIRED', 'a new file needs the category block the idea goes in');
  if (input.body === undefined || input.body.trim() === '')
    fail('IDEA_WRITE_BODY_REQUIRED', 'add needs the body of the idea');
  assertBodyIsOneBlock(input.id, input.body);
  const text = [
    'ideas = {',
    `\t${input.category} = {`,
    `\t\t${input.id} = {`,
    indentedBody(input.body, '\t\t\t', '\n'),
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n');
  const written = parseClausewitz(Buffer.from(text, 'utf8'), path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('IDEA_WRITE_RESULT_INVALID', 'The new file would have syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  return {
    operation: 'add',
    id: input.id,
    category: input.category,
    path,
    text,
    bytes: Buffer.from(text, 'utf8'),
    edit: {
      start: 0,
      end: 0,
      text,
      description: `create ${path} with ${input.id}`,
    },
    diff: unifiedTextDiff('', text, `a/${path}`, `b/${path}`, { context: DIFF_CONTEXT_LINES }),
    untouchedDefinitions: 0,
  };
}

export function planIdeaWrite(
  source: { bytes: Uint8Array; path: string },
  input: IdeaWriteInput,
): IdeaWritePlan {
  if (!ID_PATTERN.test(input.id))
    fail('IDEA_WRITE_ID_INVALID', `${JSON.stringify(input.id)} is not a valid idea id`, {
      id: input.id,
    });
  if (input.operation === 'remove' && input.body !== undefined)
    fail('IDEA_WRITE_BODY_UNEXPECTED', 'remove takes no body');
  if (input.operation !== 'remove' && (input.body === undefined || input.body.trim() === ''))
    fail('IDEA_WRITE_BODY_REQUIRED', `${input.operation} needs the body of the idea`);

  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics))
    fail('IDEA_WRITE_SOURCE_INVALID', 'The source has syntax errors and cannot be edited safely', {
      path: source.path,
      diagnosticCodes: document.diagnostics.map(({ code }) => code),
    });
  const text = document.text;
  const newline = document.newline;
  const located = definitions(document);
  if (input.body !== undefined) assertBodyIsOneBlock(input.id, input.body);
  const unit = indentUnit(document, located);
  const existing = located.filter(({ idea }) => idea.key.value === input.id);

  let edit: SourceReplacement;
  let category: string;
  let skip: AssignmentNode | undefined;

  if (input.operation === 'add') {
    if (existing.length > 0)
      fail('IDEA_WRITE_DUPLICATE_ID', `${input.id} is already defined in this file`, {
        id: input.id,
        category: existing[0]?.category.key.value,
        line: existing[0]?.idea.key.token.line,
      });
    if (input.category === undefined)
      fail('IDEA_WRITE_CATEGORY_REQUIRED', 'add needs the category block the idea goes in');
    const wanted = input.category;
    const matching = categoryBlocks(document).filter(({ key }) => key.value === wanted);
    if (matching.length === 0 && input.createCategory !== true)
      fail(
        'IDEA_WRITE_CATEGORY_NOT_FOUND',
        `The file has no ${wanted} category; pass createCategory: true to create it`,
        {
          category: wanted,
          categories: [...new Set(categoryBlocks(document).map(({ key }) => key.value))],
        },
      );
    if (matching.length > 1)
      fail(
        'IDEA_WRITE_CATEGORY_AMBIGUOUS',
        `The file has ${matching.length} ${wanted} categories`,
        {
          category: wanted,
          lines: matching.map(({ key }) => key.token.line),
        },
      );
    if (matching.length === 0) {
      edit = categoryCreation(document, input, unit);
    } else {
      const target = matching[0]!;
      const block = target.value as BlockNode;
      const close = block.close;
      if (close === undefined)
        fail('IDEA_WRITE_LAYOUT_UNSUPPORTED', `The ${wanted} category has no closing brace`);
      const closeLineStart = text.lastIndexOf('\n', close.start - 1) + 1;
      if (!/^[ \t]*$/u.test(text.slice(closeLineStart, close.start)))
        fail(
          'IDEA_WRITE_LAYOUT_UNSUPPORTED',
          `The closing brace of ${wanted} shares its line with other text, so the new idea has no line to go on`,
          { category: wanted, line: close.line },
        );
      const categoryIndent = lineIndent(text, target.start);
      const ideaIndent = categoryIndent + unit;
      const hasSiblings = block.entries.length > 0;
      const ideaText = `${ideaIndent}${input.id} = {${newline}${indentedBody(input.body!, ideaIndent + unit, newline)}${newline}${ideaIndent}}${newline}`;
      edit = {
        start: closeLineStart,
        end: closeLineStart,
        text: `${hasSiblings ? newline : ''}${ideaText}`,
        description: `add ${input.id} to ${wanted}`,
      };
    }
    category = wanted;
  } else {
    if (existing.length === 0)
      fail('IDEA_WRITE_NOT_FOUND', `${input.id} is not defined in this file`, { id: input.id });
    if (existing.length > 1)
      fail(
        'IDEA_WRITE_DUPLICATE_ID',
        `${input.id} is defined ${existing.length} times in this file`,
        {
          id: input.id,
          lines: existing.map(({ idea }) => idea.key.token.line),
        },
      );
    const found = existing[0]!;
    category = found.category.key.value;
    if (input.category !== undefined && input.category !== category)
      fail(
        'IDEA_WRITE_CATEGORY_MISMATCH',
        `${input.id} is in ${category}, and moving an idea to another category is not supported`,
        { id: input.id, category },
      );
    skip = found.idea;
    const ideaIndent = lineIndent(text, found.idea.start);
    if (input.operation === 'replace') {
      edit = {
        start: found.idea.start,
        end: found.idea.end,
        text: `${input.id} = {${newline}${indentedBody(input.body!, ideaIndent + unit, newline)}${newline}${ideaIndent}}`,
        description: `replace ${input.id}`,
      };
    } else {
      const lineStart = text.lastIndexOf('\n', found.idea.start - 1) + 1;
      const lineEndAt = text.indexOf('\n', found.idea.end);
      const lineEnd = lineEndAt === -1 ? text.length : lineEndAt + 1;
      const alone =
        /^[ \t]*$/u.test(text.slice(lineStart, found.idea.start)) &&
        /^[ \t]*\r?$/u.test(text.slice(found.idea.end, lineEndAt === -1 ? text.length : lineEndAt));
      if (!alone) {
        edit = {
          start: found.idea.start,
          end: found.idea.end,
          text: '',
          description: `remove ${input.id}`,
        };
      } else {
        // A blank line that only separated this idea from the one before it goes with it.
        const before = text.slice(0, lineStart);
        const blankBefore = /(?:^|\n)[ \t]*\r?\n$/u.test(before) && before.length > 0;
        const after = text.slice(lineEnd);
        const nextIsBlankOrClose = /^[ \t]*(?:\r?\n|\})/u.test(after) || after === '';
        let start = lineStart;
        if (blankBefore && nextIsBlankOrClose) {
          const previousLineStart = before.lastIndexOf('\n', before.length - 2) + 1;
          start = previousLineStart;
        }
        edit = { start, end: lineEnd, text: '', description: `remove ${input.id}` };
      }
    }
  }

  const bytes = applyReplacements(document, [edit]);
  const after = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const written = parseClausewitz(bytes, source.path);
  if (hasBlockingDiagnostics(written.diagnostics))
    fail('IDEA_WRITE_RESULT_INVALID', 'The edit would leave the file with syntax errors', {
      diagnosticCodes: written.diagnostics.map(({ code }) => code),
    });
  const before = definitionTexts(document, skip);
  const afterTexts = definitionTexts(written, undefined);
  let untouched = 0;
  for (const [key, texts] of before) {
    const now = afterTexts.get(key) ?? [];
    for (const textOfIdea of texts)
      if (now.includes(textOfIdea)) untouched += 1;
      else
        fail('IDEA_WRITE_RESULT_INVALID', `The edit would change ${key}, which it must not touch`, {
          key,
        });
  }
  const now = written.text;
  if (now !== after)
    fail('IDEA_WRITE_RESULT_INVALID', 'The written file does not match the planned edit');
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

/** The category blocks of a `common/ideas` file, or none when the file cannot be parsed. */
export function ideaCategories(source: { bytes: Uint8Array; path: string }): string[] {
  const document = parseClausewitz(source.bytes, source.path);
  if (hasBlockingDiagnostics(document.diagnostics)) return [];
  return [...new Set(categoryBlocks(document).map(({ key }) => key.value))];
}
