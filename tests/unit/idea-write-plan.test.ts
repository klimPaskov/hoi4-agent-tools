import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  planIdeaWrite,
  planNewIdeaFile,
  type IdeaWriteInput,
} from '../../src/hoi4_agent_tools/ideas/write-plan.js';

const FILE = [
  '# Ideas of the test mod',
  'ideas = {',
  '\tcountry = {',
  '\t\t# the first spirit',
  '\t\tfirst_spirit = {',
  '\t\t\tpicture = first_spirit',
  '\t\t\tmodifier = { stability_factor = 0.1 }',
  '\t\t}',
  '',
  '\t\tsecond_spirit = {',
  '\t\t\tpicture = second_spirit',
  '\t\t}',
  '\t}',
  '',
  '\thidden_ideas = {',
  '\t}',
  '}',
  '',
].join('\n');

const bytes = (text: string) => Buffer.from(text, 'utf8');
const plan = (input: IdeaWriteInput, text = FILE) =>
  planIdeaWrite({ bytes: bytes(text), path: 'common/ideas/test.txt' }, input);
const codeOf = async (action: () => unknown): Promise<string> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('idea_write plan: add', () => {
  it('puts a new idea at the end of its category, after a blank line, and changes nothing else', async () => {
    const result = await plan({
      operation: 'add',
      id: 'third_spirit',
      category: 'country',
      body: 'picture = third_spirit\nmodifier = {\n\tstability_factor = 0.05\n}',
    });
    expect(result.text).toBe(
      FILE.replace(
        '\t\t\tpicture = second_spirit\n\t\t}\n\t}',
        [
          '\t\t\tpicture = second_spirit',
          '\t\t}',
          '',
          '\t\tthird_spirit = {',
          '\t\t\tpicture = third_spirit',
          '\t\t\tmodifier = {',
          '\t\t\t\tstability_factor = 0.05',
          '\t\t\t}',
          '\t\t}',
          '\t}',
        ].join('\n'),
      ),
    );
    expect(result.category).toBe('country');
    expect(result.untouchedDefinitions).toBe(2);
    expect(result.diff).toContain('+\t\tthird_spirit = {');
    expect(result.diff).not.toContain('-\t\t');
  });

  it('puts an idea into an empty category without a leading blank line', async () => {
    const result = await plan({
      operation: 'add',
      id: 'hidden_one',
      category: 'hidden_ideas',
      body: 'allowed = { always = no }',
    });
    expect(result.text).toContain(
      '\thidden_ideas = {\n\t\thidden_one = {\n\t\t\tallowed = { always = no }\n\t\t}\n\t}\n}',
    );
  });

  it('indents with the file own indentation unit', async () => {
    const spaced = FILE.replaceAll('\t', '    ');
    const result = await plan(
      { operation: 'add', id: 'spaced_one', category: 'country', body: 'picture = x' },
      spaced,
    );
    expect(result.text).toContain('\n        spaced_one = {\n            picture = x\n        }\n');
  });

  it('keeps CRLF line endings and a byte order mark', async () => {
    const crlf = `${String.fromCharCode(0xfeff)}${FILE.replaceAll('\n', '\r\n')}`;
    const result = await plan(
      { operation: 'add', id: 'crlf_one', category: 'country', body: 'picture = x\nname = y' },
      crlf,
    );
    expect(result.text).toContain(
      '\r\n\t\tcrlf_one = {\r\n\t\t\tpicture = x\r\n\t\t\tname = y\r\n\t\t}\r\n',
    );
    expect(result.text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/u);
    expect([...result.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('refuses a duplicate id, a missing or unknown category and a body that is not one block', async () => {
    expect(
      await codeOf(() =>
        plan({ operation: 'add', id: 'first_spirit', category: 'country', body: 'a = b' }),
      ),
    ).toBe('IDEA_WRITE_DUPLICATE_ID');
    expect(await codeOf(() => plan({ operation: 'add', id: 'x_one', body: 'a = b' }))).toBe(
      'IDEA_WRITE_CATEGORY_REQUIRED',
    );
    expect(
      await codeOf(() =>
        plan({ operation: 'add', id: 'x_one', category: 'nowhere', body: 'a = b' }),
      ),
    ).toBe('IDEA_WRITE_CATEGORY_NOT_FOUND');
    for (const body of ['a = { b = c', 'a = b }\nother = {', '', '   \n']) {
      expect(
        await codeOf(() => plan({ operation: 'add', id: 'x_one', category: 'country', body })),
      ).toMatch(/^IDEA_WRITE_BODY_(INVALID|REQUIRED)$/u);
    }
    expect(
      await codeOf(() =>
        plan({ operation: 'add', id: '9bad id', category: 'country', body: 'a = b' }),
      ),
    ).toBe('IDEA_WRITE_ID_INVALID');
  });

  it('refuses a source with syntax errors', async () => {
    expect(
      await codeOf(() =>
        plan(
          { operation: 'add', id: 'x_one', category: 'country', body: 'a = b' },
          'ideas = { country = {',
        ),
      ),
    ).toBe('IDEA_WRITE_SOURCE_INVALID');
  });
});

describe('idea_write plan: replace and remove', () => {
  it('replaces only the idea block and keeps the comment above it', async () => {
    const result = await plan({
      operation: 'replace',
      id: 'first_spirit',
      body: '\tpicture = other\n\tmodifier = { stability_factor = 0.2 }',
    });
    expect(result.text).toBe(
      FILE.replace(
        'first_spirit = {\n\t\t\tpicture = first_spirit\n\t\t\tmodifier = { stability_factor = 0.1 }\n\t\t}',
        'first_spirit = {\n\t\t\tpicture = other\n\t\t\tmodifier = { stability_factor = 0.2 }\n\t\t}',
      ),
    );
    expect(result.text).toContain('\t\t# the first spirit\n');
    expect(result.category).toBe('country');
    expect(result.untouchedDefinitions).toBe(1);
  });

  it('removes the idea, its line and the blank line that separated it', async () => {
    const result = await plan({ operation: 'remove', id: 'second_spirit' });
    expect(result.text).toBe(
      FILE.replace('\n\n\t\tsecond_spirit = {\n\t\t\tpicture = second_spirit\n\t\t}', ''),
    );
    expect(result.untouchedDefinitions).toBe(1);
  });

  it('gives back the original bytes after an add and a remove of the same idea', async () => {
    const added = await plan({
      operation: 'add',
      id: 'round_trip',
      category: 'country',
      body: 'picture = x',
    });
    const removed = await planIdeaWrite(
      { bytes: added.bytes, path: 'common/ideas/test.txt' },
      { operation: 'remove', id: 'round_trip' },
    );
    expect(removed.bytes.equals(bytes(FILE))).toBe(true);
  });

  it('refuses an id that is not in the file, a move between categories and a body on remove', async () => {
    expect(await codeOf(() => plan({ operation: 'replace', id: 'nope_one', body: 'a = b' }))).toBe(
      'IDEA_WRITE_NOT_FOUND',
    );
    expect(await codeOf(() => plan({ operation: 'remove', id: 'nope_one' }))).toBe(
      'IDEA_WRITE_NOT_FOUND',
    );
    expect(
      await codeOf(() =>
        plan({ operation: 'replace', id: 'first_spirit', category: 'hidden_ideas', body: 'a = b' }),
      ),
    ).toBe('IDEA_WRITE_CATEGORY_MISMATCH');
    expect(
      await codeOf(() => plan({ operation: 'remove', id: 'first_spirit', body: 'a = b' })),
    ).toBe('IDEA_WRITE_BODY_UNEXPECTED');
  });

  it('refuses an id defined twice rather than guessing which one', async () => {
    const twice = FILE.replace(
      '\thidden_ideas = {\n\t}',
      '\thidden_ideas = {\n\t\tfirst_spirit = { picture = dup }\n\t}',
    );
    expect(await codeOf(() => plan({ operation: 'remove', id: 'first_spirit' }, twice))).toBe(
      'IDEA_WRITE_DUPLICATE_ID',
    );
  });
});

describe('idea_write plan: creating a category or a file', () => {
  it('adds a missing category with the idea in it, only when asked to', async () => {
    const input = {
      operation: 'add',
      id: 'adviser_one',
      category: 'political_advisor',
      body: 'slot = political_advisor',
    } as const;
    expect(await codeOf(() => plan(input))).toBe('IDEA_WRITE_CATEGORY_NOT_FOUND');
    const result = await plan({ ...input, createCategory: true });
    expect(result.text).toBe(
      FILE.replace(
        '\thidden_ideas = {\n\t}\n}',
        '\thidden_ideas = {\n\t}\n\n\tpolitical_advisor = {\n\t\tadviser_one = {\n\t\t\tslot = political_advisor\n\t\t}\n\t}\n}',
      ),
    );
    expect(result.category).toBe('political_advisor');
    expect(result.untouchedDefinitions).toBe(2);
  });

  it('refuses a bad category name and a file with no single ideas block', async () => {
    expect(
      await codeOf(() =>
        plan({
          operation: 'add',
          id: 'x_one',
          category: 'bad name',
          body: 'a = b',
          createCategory: true,
        }),
      ),
    ).toBe('IDEA_WRITE_CATEGORY_INVALID');
    expect(
      await codeOf(() =>
        plan(
          { operation: 'add', id: 'x_one', category: 'extra', body: 'a = b', createCategory: true },
          'ideas = {\n}\nideas = {\n}\n',
        ),
      ),
    ).toBe('IDEA_WRITE_LAYOUT_UNSUPPORTED');
  });

  it('makes a new file with one category and one idea, in the game own layout', async () => {
    const result = await planNewIdeaFile('common/ideas/new_ideas.txt', {
      operation: 'add',
      id: 'fresh_spirit',
      category: 'country',
      body: 'picture = fresh_spirit\nmodifier = {\n\tstability_factor = 0.05\n}',
    });
    expect(result.text).toBe(
      [
        'ideas = {',
        '\tcountry = {',
        '\t\tfresh_spirit = {',
        '\t\t\tpicture = fresh_spirit',
        '\t\t\tmodifier = {',
        '\t\t\t\tstability_factor = 0.05',
        '\t\t\t}',
        '\t\t}',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    expect(result.diff).toContain('+ideas = {');
    expect(result.untouchedDefinitions).toBe(0);
  });

  it('refuses a new file without a category or body, and anything but add', async () => {
    const base = {
      operation: 'add',
      id: 'fresh_spirit',
      category: 'country',
      body: 'a = b',
    } as const;
    const { category: _category, ...withoutCategory } = base;
    expect(await codeOf(() => planNewIdeaFile('common/ideas/n.txt', withoutCategory))).toBe(
      'IDEA_WRITE_CATEGORY_REQUIRED',
    );
    expect(await codeOf(() => planNewIdeaFile('common/ideas/n.txt', { ...base, body: '' }))).toBe(
      'IDEA_WRITE_BODY_REQUIRED',
    );
    expect(
      await codeOf(() => planNewIdeaFile('common/ideas/n.txt', { ...base, operation: 'remove' })),
    ).toBe('IDEA_WRITE_FILE_NOT_FOUND');
  });
});
