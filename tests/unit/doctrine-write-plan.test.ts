import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  planDoctrineWrite,
  planNewDoctrineFile,
  type DoctrineWriteInput,
} from '../../src/hoi4_agent_tools/doctrine/write-plan.js';

const FILE = [
  '# Tracks of the test mod',
  'tst_track_a = {',
  '\tname = TST_TRACK_A',
  '\ttype = infantry',
  '\tmastery = { size = 10 }',
  '}',
  '',
  '# the second track',
  'tst_track_b = {',
  '\tname = TST_TRACK_B',
  '}',
  '',
].join('\n');

const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: DoctrineWriteInput, text = FILE) =>
  planDoctrineWrite({ bytes: bytes(text), path: 'common/doctrines/tracks/test.txt' }, input);
const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('doctrine_write plan: add', () => {
  it('appends a new doctrine after a blank line and changes nothing else', () => {
    const result = plan({
      operation: 'add',
      id: 'tst_track_c',
      body: 'name = TST_TRACK_C\ntype = armor',
    });
    expect(result.text).toBe(`${FILE}\ntst_track_c = {\n\tname = TST_TRACK_C\n\ttype = armor\n}\n`);
    expect(result.untouchedDefinitions).toBe(2);
    expect(result.diff).toContain('+tst_track_c = {');
    expect(result.diff).not.toContain('\n-');
  });

  it('keeps CRLF line endings, indentation and a missing final newline', () => {
    const crlf = FILE.replaceAll('\n', '\r\n').replaceAll('\t', '  ');
    const result = plan({ operation: 'add', id: 'tst_track_c', body: 'name = X' }, crlf);
    expect(result.text).toBe(`${crlf}\r\ntst_track_c = {\r\n  name = X\r\n}\r\n`);
    const bare = plan({ operation: 'add', id: 'tst_track_c', body: 'name = X' }, FILE.trimEnd());
    expect(bare.text).toBe(`${FILE.trimEnd()}\n\ntst_track_c = {\n\tname = X\n}\n`);
  });

  it('refuses a duplicate id, an invalid id, a missing or broken body, and a damaged file', () => {
    const add = (id: string, body?: string) =>
      codeOf(() => plan({ operation: 'add', id, ...(body === undefined ? {} : { body }) }));
    expect(add('tst_track_a', 'name = X')).toBe('DOCTRINE_WRITE_DUPLICATE_ID');
    expect(add('1 bad', 'name = X')).toBe('DOCTRINE_WRITE_ID_INVALID');
    expect(add('tst_new')).toBe('DOCTRINE_WRITE_BODY_REQUIRED');
    expect(add('tst_new', 'name = {')).toBe('DOCTRINE_WRITE_BODY_INVALID');
    expect(add('tst_new', 'a = b\n}\ntst_x = {\nc = d')).toBe('DOCTRINE_WRITE_BODY_INVALID');
    expect(
      codeOf(() =>
        plan({ operation: 'add', id: 'tst_new', body: 'a = b' }, 'tst_track_a = {\n\tname = X\n'),
      ),
    ).toBe('DOCTRINE_WRITE_SOURCE_INVALID');
  });
});

describe('doctrine_write plan: replace and remove', () => {
  it('replaces one doctrine and leaves the comments and the neighbour as they were', () => {
    const result = plan({
      operation: 'replace',
      id: 'tst_track_a',
      body: 'name = TST_TRACK_A\ntype = air',
    });
    expect(result.text).toBe(
      FILE.replace('\ttype = infantry\n\tmastery = { size = 10 }\n', '\ttype = air\n'),
    );
    expect(result.text).toContain('# the second track');
    expect(result.untouchedDefinitions).toBe(1);
  });

  it('removes one doctrine and only that block, keeping the comment above it', () => {
    const removed = plan({ operation: 'remove', id: 'tst_track_b' });
    // The comment above a block is not part of it, so it stays where it was.
    expect(removed.text).toBe(FILE.replace('tst_track_b = {\n\tname = TST_TRACK_B\n}\n', ''));
    expect(removed.untouchedDefinitions).toBe(1);
    const restored = plan(
      { operation: 'add', id: 'tst_track_b', body: 'name = TST_TRACK_B' },
      removed.text,
    );
    expect(restored.text).toContain('tst_track_b = {\n\tname = TST_TRACK_B\n}\n');
  });

  it('refuses an unknown id, a body on remove, and an id defined twice', () => {
    expect(codeOf(() => plan({ operation: 'remove', id: 'tst_nobody' }))).toBe(
      'DOCTRINE_WRITE_NOT_FOUND',
    );
    expect(codeOf(() => plan({ operation: 'remove', id: 'tst_track_a', body: 'a = b' }))).toBe(
      'DOCTRINE_WRITE_BODY_UNEXPECTED',
    );
    const doubled = `${FILE}\ntst_track_a = {\n\tname = X\n}\n`;
    expect(codeOf(() => plan({ operation: 'remove', id: 'tst_track_a' }, doubled))).toBe(
      'DOCTRINE_WRITE_DUPLICATE_ID',
    );
  });
});

describe('doctrine_write plan: a new file', () => {
  it('makes a file with one doctrine in the game style', () => {
    const result = planNewDoctrineFile('common/doctrines/tracks/new.txt', {
      operation: 'add',
      id: 'tst_new',
      body: 'name = TST_NEW',
    });
    expect(result.text).toBe('tst_new = {\n\tname = TST_NEW\n}\n');
  });

  it('only adds, and needs a valid body', () => {
    const make = (input: DoctrineWriteInput) =>
      codeOf(() => planNewDoctrineFile('common/doctrines/tracks/new.txt', input));
    expect(make({ operation: 'remove', id: 'tst_new' })).toBe('DOCTRINE_WRITE_FILE_NOT_FOUND');
    expect(make({ operation: 'add', id: 'tst_new', body: 'a = {' })).toBe(
      'DOCTRINE_WRITE_BODY_INVALID',
    );
  });
});
