import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  planNewTechFile,
  planTechWrite,
  type TechWriteInput,
} from '../../src/hoi4_agent_tools/technology/write-plan.js';

const FILE = [
  '# Technologies of the test mod',
  'technologies = {',
  '\t@1936 = 2',
  '\t@1940 = 8',
  '',
  '\t# the first technology',
  '\ttst_tech_a = {',
  '\t\tresearch_cost = 1.5',
  '\t\tstart_year = @1936',
  '\t\tfolder = {',
  '\t\t\tname = tst_folder',
  '\t\t\tposition = { x = 0 y = 0 }',
  '\t\t}',
  '\t}',
  '',
  '\ttst_tech_b = {',
  '\t\tresearch_cost = 2',
  '\t\tpath = { leads_to_tech = tst_tech_c research_cost_coeff = 1 }',
  '\t}',
  '}',
  '',
].join('\n');

const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: TechWriteInput, text = FILE) =>
  planTechWrite({ bytes: bytes(text), path: 'common/technologies/test.txt' }, input);
const codeOf = async (action: () => unknown): Promise<string> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('tech_write plan: add', () => {
  it('puts a new technology at the end of the block, after a blank line, and keeps the variables', async () => {
    const result = await plan({
      operation: 'add',
      id: 'tst_tech_c',
      body: 'research_cost = 3\nstart_year = @1940',
    });
    expect(result.text).toBe(
      FILE.replace(
        '\t\tpath = { leads_to_tech = tst_tech_c research_cost_coeff = 1 }\n\t}\n}',
        [
          '\t\tpath = { leads_to_tech = tst_tech_c research_cost_coeff = 1 }',
          '\t}',
          '',
          '\ttst_tech_c = {',
          '\t\tresearch_cost = 3',
          '\t\tstart_year = @1940',
          '\t}',
          '}',
        ].join('\n'),
      ),
    );
    expect(result.untouchedDefinitions).toBe(2);
    expect(result.text).toContain('\t@1936 = 2\n\t@1940 = 8');
    expect(result.diff).toContain('+\ttst_tech_c = {');
    expect(result.diff).not.toContain('\n-');
  });

  it('keeps CRLF line endings and the file indentation', async () => {
    const crlf = FILE.replaceAll('\n', '\r\n').replaceAll('\t', '  ');
    const result = await plan(
      { operation: 'add', id: 'tst_tech_c', body: 'research_cost = 3' },
      crlf,
    );
    expect(result.text).toContain('\r\n\r\n  tst_tech_c = {\r\n    research_cost = 3\r\n  }\r\n}');
    expect(result.text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('puts a technology into a block that holds only variables', async () => {
    const result = await plan(
      { operation: 'add', id: 'tst_only', body: 'research_cost = 1' },
      'technologies = {\n\t@1936 = 2\n}\n',
    );
    expect(result.text).toBe(
      'technologies = {\n\t@1936 = 2\n\n\ttst_only = {\n\t\tresearch_cost = 1\n\t}\n}\n',
    );
  });

  it('refuses a duplicate id, an invalid id, a missing or broken body, and a missing block', async () => {
    const add = async (id: string, body?: string) =>
      await codeOf(() => plan({ operation: 'add', id, ...(body === undefined ? {} : { body }) }));
    expect(await add('tst_tech_a', 'research_cost = 1')).toBe('TECH_WRITE_DUPLICATE_ID');
    expect(await add('1 bad', 'research_cost = 1')).toBe('TECH_WRITE_ID_INVALID');
    expect(await add('tst_new')).toBe('TECH_WRITE_BODY_REQUIRED');
    expect(await add('tst_new', 'research_cost = {')).toBe('TECH_WRITE_BODY_INVALID');
    expect(await add('tst_new', 'a = b\n}\ntst_x = {\nc = d')).toBe('TECH_WRITE_BODY_INVALID');
    expect(
      await codeOf(() =>
        plan({ operation: 'add', id: 'tst_new', body: 'a = b' }, '# nothing here\nfoo = bar\n'),
      ),
    ).toBe('TECH_WRITE_LAYOUT_UNSUPPORTED');
    expect(
      await codeOf(() =>
        plan(
          { operation: 'add', id: 'tst_new', body: 'a = b' },
          'technologies = { tst_a = { b = c } }\n',
        ),
      ),
    ).toBe('TECH_WRITE_LAYOUT_UNSUPPORTED');
  });

  it('refuses a file with syntax errors', async () => {
    expect(
      await codeOf(() =>
        plan({ operation: 'add', id: 'tst_new', body: 'a = b' }, 'technologies = {\n\ttst_a = {\n'),
      ),
    ).toBe('TECH_WRITE_SOURCE_INVALID');
  });
});

describe('tech_write plan: replace and remove', () => {
  it('replaces one technology, which is how a move in the tree is made, and keeps the rest', async () => {
    const moved = await plan({
      operation: 'replace',
      id: 'tst_tech_a',
      body: 'research_cost = 1.5\nstart_year = @1936\nfolder = {\n\tname = tst_folder\n\tposition = { x = 2 y = 4 }\n}',
    });
    expect(moved.text).toBe(
      FILE.replace('position = { x = 0 y = 0 }', 'position = { x = 2 y = 4 }'),
    );
    expect(moved.text).toContain('# the first technology');
    expect(moved.untouchedDefinitions).toBe(1);
  });

  it('removes one technology with its blank separator and restores by add', async () => {
    const removed = await plan({ operation: 'remove', id: 'tst_tech_b' });
    expect(removed.text).toBe(
      FILE.replace(
        '\n\ttst_tech_b = {\n\t\tresearch_cost = 2\n\t\tpath = { leads_to_tech = tst_tech_c research_cost_coeff = 1 }\n\t}\n',
        '',
      ),
    );
    const restored = await plan(
      {
        operation: 'add',
        id: 'tst_tech_b',
        body: 'research_cost = 2\npath = { leads_to_tech = tst_tech_c research_cost_coeff = 1 }',
      },
      removed.text,
    );
    expect(restored.text).toBe(FILE);
  });

  it('refuses an unknown id, a body on remove, and an id defined twice', async () => {
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst_nobody' }))).toBe(
      'TECH_WRITE_NOT_FOUND',
    );
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst_tech_a', body: 'a = b' }))).toBe(
      'TECH_WRITE_BODY_UNEXPECTED',
    );
    const doubled = `${FILE.slice(0, -2)}\ttst_tech_a = { research_cost = 9 }\n}\n`;
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst_tech_a' }, doubled))).toBe(
      'TECH_WRITE_DUPLICATE_ID',
    );
  });
});

describe('tech_write plan: a new file', () => {
  it('makes a file with one technology in the game style', async () => {
    const result = await planNewTechFile('common/technologies/new.txt', {
      operation: 'add',
      id: 'tst_new',
      body: 'research_cost = 1',
    });
    expect(result.text).toBe('technologies = {\n\ttst_new = {\n\t\tresearch_cost = 1\n\t}\n}\n');
    expect(result.untouchedDefinitions).toBe(0);
  });

  it('only adds, and needs a valid body', async () => {
    const make = async (input: TechWriteInput) =>
      await codeOf(() => planNewTechFile('common/technologies/new.txt', input));
    expect(await make({ operation: 'remove', id: 'tst_new' })).toBe('TECH_WRITE_FILE_NOT_FOUND');
    expect(await make({ operation: 'add', id: 'tst_new', body: 'a = {' })).toBe(
      'TECH_WRITE_BODY_INVALID',
    );
  });
});
