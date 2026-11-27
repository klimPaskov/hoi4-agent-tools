import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  eventFileContents,
  planEventWrite,
  planNewEventFile,
  type EventWriteInput,
} from '../../src/hoi4_agent_tools/event/write-plan.js';

const FILE = [
  '# Events of the test mod',
  'add_namespace = tst',
  '',
  '# the first event',
  'country_event = {',
  '\tid = tst.1',
  '\ttitle = tst.1.t',
  '\tis_triggered_only = yes',
  '\toption = {',
  '\t\tname = tst.1.a',
  '\t}',
  '}',
  '',
  'news_event = {',
  '\tid = tst.2',
  '\ttitle = tst.2.t',
  '}',
  '',
].join('\n');

const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: EventWriteInput, text = FILE) =>
  planEventWrite({ bytes: bytes(text), path: 'events/test.txt' }, input);
const codeOf = async (action: () => unknown): Promise<string> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('event_write plan: add', () => {
  it('appends a new event with its id first, after a blank line, and changes nothing else', async () => {
    const result = await plan({
      operation: 'add',
      id: 'tst.3',
      body: 'title = tst.3.t\nis_triggered_only = yes',
    });
    expect(result.text).toBe(
      `${FILE}\ncountry_event = {\n\tid = tst.3\n\ttitle = tst.3.t\n\tis_triggered_only = yes\n}\n`,
    );
    expect(result.kind).toBe('country_event');
    expect(result.untouchedDefinitions).toBe(2);
    expect(result.namespaceAdded).toBe(false);
    expect(result.diff).toContain('+\tid = tst.3');
    expect(result.diff).not.toContain('\n-');
  });

  it('takes the kind asked for, and keeps an id the body already carries', async () => {
    const result = await plan({
      operation: 'add',
      id: 'tst.3',
      kind: 'state_event',
      body: 'id = tst.3\ntitle = tst.3.t',
    });
    expect(result.text.endsWith('\nstate_event = {\n\tid = tst.3\n\ttitle = tst.3.t\n}\n')).toBe(
      true,
    );
  });

  it('keeps CRLF line endings and the file indentation', async () => {
    const crlf = FILE.replaceAll('\n', '\r\n').replaceAll('\t', '  ');
    const result = await plan({ operation: 'add', id: 'tst.3', body: 'title = tst.3.t' }, crlf);
    expect(
      result.text.endsWith(
        '\r\n\r\ncountry_event = {\r\n  id = tst.3\r\n  title = tst.3.t\r\n}\r\n',
      ),
    ).toBe(true);
    expect(result.text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('keeps unrelated top-level entries and the file without a final newline', async () => {
    const odd = `${FILE.trimEnd()}\n\nsome_other_block = {\n\ta = b\n}`;
    const result = await plan({ operation: 'add', id: 'tst.3', body: 'title = tst.3.t' }, odd);
    expect(result.text.startsWith(odd)).toBe(true);
    expect(result.text.slice(odd.length)).toBe(
      '\n\ncountry_event = {\n\tid = tst.3\n\ttitle = tst.3.t\n}\n',
    );
  });

  it('needs a declared namespace, and writes add_namespace only when told to', async () => {
    const add = async (input: Partial<EventWriteInput>) =>
      plan({ operation: 'add', id: 'fresh.1', body: 'title = fresh.1.t', ...input });
    expect(await codeOf(() => add({}))).toBe('EVENT_WRITE_NAMESPACE_MISSING');
    // Another mod file declares it, so this file need not.
    expect(await codeOf(() => add({ namespaceDeclared: true }))).toBe('NO_ERROR');
    const made = await add({ createNamespace: true });
    expect(made.namespaceAdded).toBe(true);
    expect(made.text).toContain('add_namespace = tst\nadd_namespace = fresh\n\n# the first event');
    expect(made.text.endsWith('country_event = {\n\tid = fresh.1\n\ttitle = fresh.1.t\n}\n')).toBe(
      true,
    );
  });

  it('writes the namespace line above the first entry of a file that has none', async () => {
    const made = await plan(
      { operation: 'add', id: 'fresh.1', body: 'title = fresh.1.t', createNamespace: true },
      '# header\nsome_block = {\n\ta = b\n}\n',
    );
    expect(made.text.startsWith('# header\nadd_namespace = fresh\n\nsome_block = {')).toBe(true);
  });

  it('refuses a duplicate id, an invalid id, and a missing or broken body', async () => {
    const add = async (id: string, body?: string) =>
      await codeOf(() => plan({ operation: 'add', id, ...(body === undefined ? {} : { body }) }));
    expect(await add('tst.1', 'title = x')).toBe('EVENT_WRITE_DUPLICATE_ID');
    expect(await add('tst', 'title = x')).toBe('EVENT_WRITE_ID_INVALID');
    expect(await add('tst.x', 'title = x')).toBe('EVENT_WRITE_ID_INVALID');
    expect(await add('tst.3')).toBe('EVENT_WRITE_BODY_REQUIRED');
    expect(await add('tst.3', 'title = { x')).toBe('EVENT_WRITE_BODY_INVALID');
    expect(await add('tst.3', 'a = b\n}\ncountry_event = {\nc = d')).toBe(
      'EVENT_WRITE_BODY_INVALID',
    );
    expect(await add('tst.3', 'id = tst.9\ntitle = x')).toBe('EVENT_WRITE_ID_MISMATCH');
  });

  it('refuses createNamespace on replace, and a file with syntax errors', async () => {
    expect(
      await codeOf(() =>
        plan({ operation: 'replace', id: 'tst.1', body: 'title = x', createNamespace: true }),
      ),
    ).toBe('EVENT_WRITE_NAMESPACE_UNEXPECTED');
    expect(
      await codeOf(() =>
        plan(
          { operation: 'add', id: 'tst.3', body: 'title = x' },
          'country_event = {\n\tid = tst.1\n',
        ),
      ),
    ).toBe('EVENT_WRITE_SOURCE_INVALID');
  });
});

describe('event_write plan: replace and remove', () => {
  it('replaces one event and leaves the comment, the namespace and the neighbour as they were', async () => {
    const result = await plan({ operation: 'replace', id: 'tst.1', body: 'title = tst.1.new' });
    expect(result.text).toBe(
      FILE.replace(
        /country_event = \{[\s\S]*?\n\}\n/u,
        'country_event = {\n\tid = tst.1\n\ttitle = tst.1.new\n}\n',
      ),
    );
    expect(result.untouchedDefinitions).toBe(1);
    expect(result.text).toContain('# the first event');
    expect(result.kind).toBe('country_event');
  });

  it('refuses to change the kind of an event', async () => {
    expect(
      await codeOf(() =>
        plan({ operation: 'replace', id: 'tst.2', kind: 'country_event', body: 'title = x' }),
      ),
    ).toBe('EVENT_WRITE_KIND_MISMATCH');
  });

  it('removes one event with its blank separator, keeps the namespace, and restores by add', async () => {
    const removed = await plan({ operation: 'remove', id: 'tst.2' });
    expect(removed.text).toBe(
      FILE.replace('\nnews_event = {\n\tid = tst.2\n\ttitle = tst.2.t\n}\n', ''),
    );
    expect(removed.text).toContain('add_namespace = tst');
    const restored = await plan(
      { operation: 'add', id: 'tst.2', kind: 'news_event', body: 'title = tst.2.t' },
      removed.text,
    );
    expect(restored.text).toBe(FILE);
  });

  it('refuses an unknown id, a body on remove, and an id defined twice in the file', async () => {
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst.9' }))).toBe(
      'EVENT_WRITE_NOT_FOUND',
    );
    expect(await codeOf(() => plan({ operation: 'replace', id: 'tst.9', body: 'a = b' }))).toBe(
      'EVENT_WRITE_NOT_FOUND',
    );
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst.1', body: 'a = b' }))).toBe(
      'EVENT_WRITE_BODY_UNEXPECTED',
    );
    const doubled = `${FILE}\ncountry_event = {\n\tid = tst.1\n}\n`;
    expect(await codeOf(() => plan({ operation: 'remove', id: 'tst.1' }, doubled))).toBe(
      'EVENT_WRITE_DUPLICATE_ID',
    );
  });
});

describe('event_write plan: a new file and file contents', () => {
  it('makes a file with the namespace line and one event, in the game style', async () => {
    const result = await planNewEventFile('events/new.txt', {
      operation: 'add',
      id: 'fresh.1',
      body: 'title = fresh.1.t',
      createNamespace: true,
    });
    expect(result.text).toBe(
      'add_namespace = fresh\n\ncountry_event = {\n\tid = fresh.1\n\ttitle = fresh.1.t\n}\n',
    );
    expect(result.namespaceAdded).toBe(true);
  });

  it('leaves the namespace line out when another file declares it, and needs the flag otherwise', async () => {
    const input: EventWriteInput = { operation: 'add', id: 'fresh.1', body: 'title = x' };
    expect(
      (
        await planNewEventFile('events/new.txt', { ...input, namespaceDeclared: true })
      ).text.startsWith('country_event = {'),
    ).toBe(true);
    expect(await codeOf(() => planNewEventFile('events/new.txt', input))).toBe(
      'EVENT_WRITE_NAMESPACE_MISSING',
    );
    expect(
      await codeOf(() =>
        planNewEventFile('events/new.txt', { operation: 'remove', id: 'fresh.1' }),
      ),
    ).toBe('EVENT_WRITE_FILE_NOT_FOUND');
  });

  it('reads the ids and namespaces of a file', async () => {
    expect(eventFileContents({ bytes: bytes(FILE), path: 'events/test.txt' })).toEqual({
      ids: ['tst.1', 'tst.2'],
      namespaces: ['tst'],
    });
  });
});
