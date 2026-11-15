import { describe, expect, it } from 'vitest';
import {
  planCharacterWrite,
  planNewCharacterFile,
  type CharacterWriteInput,
} from '../../src/hoi4_agent_tools/characters/write-plan.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';

const FILE = [
  '# Characters of the test mod',
  'characters = {',
  '\t# the first one',
  '\tTST_first = {',
  '\t\tname = TST_first',
  '\t\tportraits = {',
  '\t\t\tcivilian = {',
  '\t\t\t\tlarge = GFX_portrait_TST_first',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '',
  '\tTST_second = {',
  '\t\tname = TST_second',
  '\t}',
  '}',
  '',
].join('\n');

const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: CharacterWriteInput, text = FILE) =>
  planCharacterWrite({ bytes: bytes(text), path: 'common/characters/test.txt' }, input);
const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('character_write plan: add', () => {
  it('puts a new character at the end of the block, after a blank line, and changes nothing else', () => {
    const result = plan({
      operation: 'add',
      id: 'TST_third',
      body: 'name = TST_third\ncountry_leader = {\n\tideology = neutrality\n}',
    });
    expect(result.text).toBe(
      FILE.replace(
        '\t\tname = TST_second\n\t}\n}',
        [
          '\t\tname = TST_second',
          '\t}',
          '',
          '\tTST_third = {',
          '\t\tname = TST_third',
          '\t\tcountry_leader = {',
          '\t\t\tideology = neutrality',
          '\t\t}',
          '\t}',
          '}',
        ].join('\n'),
      ),
    );
    expect(result.untouchedDefinitions).toBe(2);
    expect(result.diff).toContain('+\tTST_third = {');
    expect(result.diff).not.toContain('-\t');
  });

  it('keeps CRLF line endings and the file indentation', () => {
    const crlf = FILE.replaceAll('\n', '\r\n').replaceAll('\t', '  ');
    const result = plan({ operation: 'add', id: 'TST_third', body: 'name = TST_third' }, crlf);
    expect(result.text).toContain('\r\n  TST_third = {\r\n    name = TST_third\r\n  }\r\n}');
    expect(result.text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('puts a character into an empty characters block without a leading blank line', () => {
    const result = plan(
      { operation: 'add', id: 'TST_only', body: 'name = TST_only' },
      'characters = {\n}\n',
    );
    expect(result.text).toBe('characters = {\n\tTST_only = {\n\t\tname = TST_only\n\t}\n}\n');
  });

  it('refuses a duplicate id, an invalid id, a missing or broken body, and a missing block', () => {
    const add = (id: string, body?: string) =>
      codeOf(() => plan({ operation: 'add', id, ...(body === undefined ? {} : { body }) }));
    expect(add('TST_first', 'name = x')).toBe('CHARACTER_WRITE_DUPLICATE_ID');
    expect(add('1 bad', 'name = x')).toBe('CHARACTER_WRITE_ID_INVALID');
    expect(add('TST_new')).toBe('CHARACTER_WRITE_BODY_REQUIRED');
    expect(add('TST_new', '   ')).toBe('CHARACTER_WRITE_BODY_REQUIRED');
    expect(add('TST_new', 'name = { x')).toBe('CHARACTER_WRITE_BODY_INVALID');
    expect(add('TST_new', 'a = b\n}\nTST_other = {\nc = d')).toBe('CHARACTER_WRITE_BODY_INVALID');
    expect(
      codeOf(() =>
        plan({ operation: 'add', id: 'TST_new', body: 'name = x' }, '# nothing here\nfoo = bar\n'),
      ),
    ).toBe('CHARACTER_WRITE_LAYOUT_UNSUPPORTED');
    expect(
      codeOf(() =>
        plan(
          { operation: 'add', id: 'TST_new', body: 'name = x' },
          'characters = { TST_a = { name = a } }\n',
        ),
      ),
    ).toBe('CHARACTER_WRITE_LAYOUT_UNSUPPORTED');
  });

  it('refuses a file with syntax errors', () => {
    expect(
      codeOf(() =>
        plan(
          { operation: 'add', id: 'TST_new', body: 'name = x' },
          'characters = {\n\tTST_a = {\n',
        ),
      ),
    ).toBe('CHARACTER_WRITE_SOURCE_INVALID');
  });
});

describe('character_write plan: replace and remove', () => {
  it('replaces one character and leaves the comment and the neighbour as they were', () => {
    const result = plan({
      operation: 'replace',
      id: 'TST_first',
      body: 'name = TST_first\ngender = female',
    });
    expect(result.text).toBe(
      FILE.replace(
        /\tTST_first = \{[\s\S]*?\n\t\}\n/u,
        '\tTST_first = {\n\t\tname = TST_first\n\t\tgender = female\n\t}\n',
      ),
    );
    expect(result.text).toContain('# the first one');
    expect(result.untouchedDefinitions).toBe(1);
  });

  it('removes one character with its blank separator and restores by add', () => {
    const removed = plan({ operation: 'remove', id: 'TST_second' });
    expect(removed.text).toBe(FILE.replace('\n\tTST_second = {\n\t\tname = TST_second\n\t}\n', ''));
    const restored = plan(
      { operation: 'add', id: 'TST_second', body: 'name = TST_second' },
      removed.text,
    );
    expect(restored.text).toBe(FILE);
  });

  it('refuses an unknown id, and a body on remove', () => {
    expect(codeOf(() => plan({ operation: 'remove', id: 'TST_nobody' }))).toBe(
      'CHARACTER_WRITE_NOT_FOUND',
    );
    expect(codeOf(() => plan({ operation: 'replace', id: 'TST_nobody', body: 'a = b' }))).toBe(
      'CHARACTER_WRITE_NOT_FOUND',
    );
    expect(codeOf(() => plan({ operation: 'remove', id: 'TST_first', body: 'a = b' }))).toBe(
      'CHARACTER_WRITE_BODY_UNEXPECTED',
    );
  });

  it('refuses an id defined twice in the file', () => {
    const doubled = `${FILE.slice(0, -2)}\tTST_first = { name = other }\n}\n`;
    expect(codeOf(() => plan({ operation: 'remove', id: 'TST_first' }, doubled))).toBe(
      'CHARACTER_WRITE_DUPLICATE_ID',
    );
  });
});

describe('character_write plan: a new file', () => {
  it('makes a file with one character in the game style, tabs and LF', () => {
    const result = planNewCharacterFile('common/characters/new.txt', {
      operation: 'add',
      id: 'TST_new',
      body: 'name = TST_new\ngender = female',
    });
    expect(result.text).toBe(
      'characters = {\n\tTST_new = {\n\t\tname = TST_new\n\t\tgender = female\n\t}\n}\n',
    );
    expect(result.untouchedDefinitions).toBe(0);
    expect(result.diff).toContain('+characters = {');
  });

  it('only adds, and needs a valid body', () => {
    const make = (input: CharacterWriteInput) =>
      codeOf(() => planNewCharacterFile('common/characters/new.txt', input));
    expect(make({ operation: 'remove', id: 'TST_new' })).toBe('CHARACTER_WRITE_FILE_NOT_FOUND');
    expect(make({ operation: 'add', id: 'TST_new' })).toBe('CHARACTER_WRITE_BODY_REQUIRED');
    expect(make({ operation: 'add', id: 'TST_new', body: 'a = {' })).toBe(
      'CHARACTER_WRITE_BODY_INVALID',
    );
  });
});
