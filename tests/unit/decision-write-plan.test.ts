import { describe, expect, it } from 'vitest';
import {
  decisionCategories,
  planDecisionWrite,
  planNewDecisionFile,
  type DecisionWriteInput,
} from '../../src/hoi4_agent_tools/decision/write-plan.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';

const FILE = [
  '# Decisions of the test mod',
  'tst_category = {',
  '\t# the first decision',
  '\ttst_first = {',
  '\t\ticon = generic_research',
  '\t\tcost = 50',
  '\t\tcomplete_effect = { add_political_power = 10 }',
  '\t}',
  '',
  '\ttst_second = {',
  '\t\tcost = 25',
  '\t}',
  '}',
  '',
  'tst_other = {',
  '}',
  '',
].join('\n');

const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: DecisionWriteInput, text = FILE) =>
  planDecisionWrite({ bytes: bytes(text), path: 'common/decisions/test.txt' }, input);
const codeOf = async (action: () => unknown): Promise<string> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('decision_write plan: add', () => {
  it('puts a new decision at the end of its category, after a blank line, and changes nothing else', async () => {
    const result = await plan({
      operation: 'add',
      id: 'tst_third',
      category: 'tst_category',
      body: 'cost = 5\nremove_effect = {\n\tadd_stability = 0.01\n}',
    });
    expect(result.text).toBe(
      FILE.replace(
        '\t\tcost = 25\n\t}\n}',
        [
          '\t\tcost = 25',
          '\t}',
          '',
          '\ttst_third = {',
          '\t\tcost = 5',
          '\t\tremove_effect = {',
          '\t\t\tadd_stability = 0.01',
          '\t\t}',
          '\t}',
          '}',
        ].join('\n'),
      ),
    );
    expect(result.category).toBe('tst_category');
    expect(result.untouchedDefinitions).toBe(2);
    expect(result.diff).toContain('+\ttst_third = {');
    expect(result.diff).not.toContain('\n-');
  });

  it('puts a decision into an empty category block without a leading blank line', async () => {
    const result = await plan({
      operation: 'add',
      id: 'tst_only',
      category: 'tst_other',
      body: 'cost = 1',
    });
    expect(result.text).toBe(
      FILE.replace('tst_other = {\n}', 'tst_other = {\n\ttst_only = {\n\t\tcost = 1\n\t}\n}'),
    );
  });

  it('keeps CRLF line endings and the file indentation', async () => {
    const crlf = FILE.replaceAll('\n', '\r\n').replaceAll('\t', '  ');
    const result = await plan(
      { operation: 'add', id: 'tst_third', category: 'tst_category', body: 'cost = 5' },
      crlf,
    );
    expect(result.text).toContain('\r\n\r\n  tst_third = {\r\n    cost = 5\r\n  }\r\n}');
    expect(result.text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('refuses an unknown category unless told to create it, then appends a block', async () => {
    const add = async (extra: Partial<DecisionWriteInput>) =>
      plan({ operation: 'add', id: 'tst_new', category: 'tst_fresh', body: 'cost = 1', ...extra });
    expect(await codeOf(() => add({}))).toBe('DECISION_WRITE_CATEGORY_NOT_FOUND');
    const made = await add({ createCategory: true });
    expect(made.text).toBe(`${FILE}\ntst_fresh = {\n\ttst_new = {\n\t\tcost = 1\n\t}\n}\n`);
    expect(made.untouchedDefinitions).toBe(2);
  });

  it('refuses a duplicate id, an invalid id or category, and a missing or broken body', async () => {
    const add = async (id: string, body?: string, category = 'tst_category') =>
      await codeOf(() =>
        plan({ operation: 'add', id, category, ...(body === undefined ? {} : { body }) }),
      );
    expect(await add('tst_first', 'cost = 1')).toBe('DECISION_WRITE_DUPLICATE_ID');
    expect(await add('1 bad', 'cost = 1')).toBe('DECISION_WRITE_ID_INVALID');
    expect(await add('tst_new', 'cost = 1', 'bad name')).toBe('DECISION_WRITE_CATEGORY_INVALID');
    expect(await add('tst_new')).toBe('DECISION_WRITE_BODY_REQUIRED');
    expect(await add('tst_new', 'cost = { x')).toBe('DECISION_WRITE_BODY_INVALID');
    expect(await add('tst_new', 'a = b\n}\ntst_x = {\nc = d')).toBe('DECISION_WRITE_BODY_INVALID');
    expect(await codeOf(() => plan({ operation: 'add', id: 'tst_new', body: 'cost = 1' }))).toBe(
      'DECISION_WRITE_CATEGORY_REQUIRED',
    );
  });

  it('refuses a file with syntax errors and createCategory on replace', async () => {
    expect(
      await codeOf(() =>
        plan(
          { operation: 'add', id: 'tst_new', category: 'tst_category', body: 'cost = 1' },
          'tst_category = {\n\ttst_a = {\n',
        ),
      ),
    ).toBe('DECISION_WRITE_SOURCE_INVALID');
    expect(
      await codeOf(() =>
        plan({ operation: 'replace', id: 'tst_first', body: 'cost = 1', createCategory: true }),
      ),
    ).toBe('DECISION_WRITE_CATEGORY_UNEXPECTED');
  });
});

describe('decision_write plan: replace and remove', () => {
  it('replaces one decision and leaves the comment and the neighbour as they were', async () => {
    const result = await plan({
      operation: 'replace',
      id: 'tst_first',
      body: 'icon = generic_research\ncost = 75',
    });
    expect(result.text).toBe(
      FILE.replace(
        /\ttst_first = \{[\s\S]*?\n\t\}\n/u,
        '\ttst_first = {\n\t\ticon = generic_research\n\t\tcost = 75\n\t}\n',
      ),
    );
    expect(result.text).toContain('# the first decision');
    expect(result.untouchedDefinitions).toBe(1);
  });

  it('removes one decision with its blank separator and restores by add', async () => {
    const removed = await plan({ operation: 'remove', id: 'tst_second' });
    expect(removed.text).toBe(FILE.replace('\n\ttst_second = {\n\t\tcost = 25\n\t}\n', ''));
    const restored = await plan(
      { operation: 'add', id: 'tst_second', category: 'tst_category', body: 'cost = 25' },
      removed.text,
    );
    expect(restored.text).toBe(FILE);
  });

  it('refuses an unknown id, a body on remove, a category move, and an id defined twice', async () => {
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst_nobody' }))).toBe(
      'DECISION_WRITE_NOT_FOUND',
    );
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst_first', body: 'a = b' }))).toBe(
      'DECISION_WRITE_BODY_UNEXPECTED',
    );
    expect(
      await codeOf(() =>
        plan({ operation: 'replace', id: 'tst_first', category: 'tst_other', body: 'cost = 1' }),
      ),
    ).toBe('DECISION_WRITE_CATEGORY_MISMATCH');
    const doubled = FILE.replace(
      'tst_other = {\n}',
      'tst_other = {\n\ttst_first = {\n\t\tcost = 1\n\t}\n}',
    );
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst_first' }, doubled))).toBe(
      'DECISION_WRITE_DUPLICATE_ID',
    );
  });
});

describe('decision_write plan: a new file and categories', () => {
  it('makes a file with one category block and one decision in the game style', async () => {
    const result = await planNewDecisionFile('common/decisions/new.txt', {
      operation: 'add',
      id: 'tst_new',
      category: 'tst_category',
      body: 'cost = 1',
    });
    expect(result.text).toBe('tst_category = {\n\ttst_new = {\n\t\tcost = 1\n\t}\n}\n');
    expect(result.untouchedDefinitions).toBe(0);
  });

  it('only adds, and needs a category and a valid body', async () => {
    const make = async (input: DecisionWriteInput) =>
      await codeOf(() => planNewDecisionFile('common/decisions/new.txt', input));
    expect(await make({ operation: 'remove', id: 'tst_new' })).toBe(
      'DECISION_WRITE_FILE_NOT_FOUND',
    );
    expect(await make({ operation: 'add', id: 'tst_new', body: 'a = b' })).toBe(
      'DECISION_WRITE_CATEGORY_REQUIRED',
    );
    expect(await make({ operation: 'add', id: 'tst_new', category: 'c', body: 'a = {' })).toBe(
      'DECISION_WRITE_BODY_INVALID',
    );
  });

  it('lists the category blocks of a file', async () => {
    expect(decisionCategories({ bytes: bytes(FILE), path: 'common/decisions/test.txt' })).toEqual([
      'tst_category',
      'tst_other',
    ]);
  });
});
