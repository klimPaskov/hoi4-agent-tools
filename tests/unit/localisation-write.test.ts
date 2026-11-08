import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { emptyServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import {
  MAX_TOOL_RESULT_BYTES,
  toolResult,
} from '../../src/hoi4_agent_tools/core/operation-result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { summarizePlan } from '../../src/hoi4_agent_tools/localisation/write-operations.js';
import {
  appendEntries,
  classifyLine,
  decodeLocBytes,
  encodeLocDocument,
  escapeLocText,
  newLocDocument,
  repairValue,
} from '../../src/hoi4_agent_tools/localisation/write-format.js';
import { documentDiff } from '../../src/hoi4_agent_tools/localisation/write-diff.js';
import {
  normalizeLocalisationPath,
  planAdd,
  planFix,
  type LocalisationPlan,
  type UndefinedKeyReport,
} from '../../src/hoi4_agent_tools/localisation/write-plan.js';
import { localisationWriteRequestSchema } from '../../src/hoi4_agent_tools/schemas/localisation-write.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const bom = (text: string): Buffer => Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
const noEngine = (): Promise<UndefinedKeyReport> =>
  Promise.resolve({ available: false, reason: 'test' });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function workspace(
  mod: Record<string, Buffer | string>,
  game: Record<string, Buffer | string> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-locw-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const put = async (base: string, files: Record<string, Buffer | string>) => {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(base, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  };
  await put(path.join(root, 'my_mod'), { 'descriptor.mod': 'name="Test"\n', ...mod });
  await mkdir(path.join(root, 'game'), { recursive: true });
  await put(path.join(root, 'game'), game);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [
        {
          id: 'fixture',
          name: 'Fixture',
          root: path.join(root, 'my_mod'),
          gameRoot: path.join(root, 'game'),
          includeGameDlc: false,
        },
      ],
    }),
  );
  return { root, workspace: resolver.get('fixture') };
}

function after(plan: LocalisationPlan, file: string): string {
  const planned = plan.files.find(({ path: candidate }) => candidate === file);
  if (planned === undefined) throw new Error(`${file} is not planned`);
  return planned.after.toString('utf8');
}

describe('localisation line format', () => {
  it('reads entries with and without a version number and keeps comments', () => {
    expect(classifyLine(' a.b-c:0 "Text" # note')).toMatchObject({
      kind: 'entry',
      entry: { key: 'a.b-c', version: '0', value: 'Text', tail: ' # note' },
    });
    expect(classifyLine(' k: "He said \\"hi\\""')).toMatchObject({
      kind: 'entry',
      entry: { value: 'He said \\"hi\\"' },
    });
    expect(classifyLine(' k: "He said "hi" now"')).toMatchObject({ kind: 'entry' });
    expect(classifyLine('l_english:')).toEqual({ kind: 'header', language: 'english' });
    expect(classifyLine('  # comment')).toEqual({ kind: 'blank' });
    expect(classifyLine(' k: "open')).toMatchObject({ kind: 'broken' });
  });

  it('escapes a bare quote and leaves an existing escape alone', () => {
    expect(escapeLocText('Say "no" and \\"yes\\" and \\n')).toBe(
      'Say \\"no\\" and \\"yes\\" and \\n',
    );
  });

  it('adds a missing closing quote before a trailing comment', () => {
    const broken = classifyLine(' k: "Open text  # note');
    if (broken.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(broken, ' next: "x"')).toEqual({
      fixed: true,
      content: ' k: "Open text"  # note',
    });
  });

  it('does not guess when the value may continue or holds another quote', () => {
    const open = classifyLine(' k: "first part');
    if (open.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(open, 'second part of the same value"')).toMatchObject({ fixed: false });
    const inner = classifyLine(' k: "a "b" c');
    if (inner.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(inner, undefined)).toMatchObject({ fixed: false });
    const noOpen = classifyLine(' k: no quotes');
    if (noOpen.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(noOpen, undefined)).toMatchObject({ fixed: false });
    const twice = classifyLine(' k: \u201ca\u201d # \u201cb\u201d');
    if (twice.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(twice, undefined)).toMatchObject({ fixed: false });
  });

  it('turns typographic delimiters into ASCII quotes', () => {
    const typographic = classifyLine(' k: \u201cHello\u201d');
    if (typographic.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(typographic, undefined)).toEqual({ fixed: true, content: ' k: "Hello"' });
    const mixed = classifyLine(' k: "Hello\u201d  ');
    if (mixed.kind !== 'broken') throw new Error('expected a broken line');
    expect(repairValue(mixed, undefined)).toEqual({ fixed: true, content: ' k: "Hello"  ' });
  });

  it('builds a new file with a BOM, a header and one leading space', () => {
    const document = newLocDocument();
    appendEntries(document, 'english', [' a: "A"']);
    expect(encodeLocDocument(document)).toEqual(bom('l_english:\n a: "A"\n'));
  });

  it('keeps CRLF and a missing final newline when it appends', () => {
    const decoded = decodeLocBytes(bom('l_english:\r\n a: "A"'))!;
    const lines = appendEntries(decoded, 'english', [' b: "B"', ' c: "C"']);
    expect(lines).toEqual([3, 4]);
    expect(encodeLocDocument(decoded)).toEqual(bom('l_english:\r\n a: "A"\r\n b: "B"\r\n c: "C"'));
  });

  it('puts new entries under the right header of a two-language file', () => {
    const decoded = decodeLocBytes(bom('l_english:\n a: "A"\nl_german:\n a: "AA"\n'))!;
    appendEntries(decoded, 'english', [' b: "B"']);
    expect(encodeLocDocument(decoded).toString('utf8')).toBe(
      '\ufeffl_english:\n a: "A"\n b: "B"\nl_german:\n a: "AA"\n',
    );
  });
});

describe('hoi4.localisation_write mode add', () => {
  it('creates the mod file with the style most game files use', async () => {
    const { workspace: ws } = await workspace({});
    const plan = await planAdd(
      { workspace: ws },
      {
        language: 'english',
        replace: false,
        entries: [
          { key: 'my_focus', text: 'My focus' },
          { key: 'my_focus_desc', text: 'Say "go" now' },
        ],
      },
    );
    expect(plan.files.map(({ path: p, action }) => [p, action])).toEqual([
      ['localisation/english/my_mod_l_english.yml', 'create'],
    ]);
    expect(plan.files[0]!.after).toEqual(
      bom('l_english:\n my_focus: "My focus"\n my_focus_desc: "Say \\"go\\" now"\n'),
    );
    expect(plan.counts.keysAdded).toBe(2);
  });

  it('appends to the file with the most keys and follows its style', async () => {
    const { workspace: ws } = await workspace({
      'localisation/english/small_l_english.yml': bom('l_english:\n one:0 "1"\n'),
      'localisation/english/big_l_english.yml': bom(
        'l_english:\r\n a:0 "A"\r\n b:0 "B"\r\n c:0 "C" # keep',
      ),
    });
    const plan = await planAdd(
      { workspace: ws },
      { language: 'english', replace: false, entries: [{ key: 'd', text: 'D' }] },
    );
    expect(plan.files.map(({ path: p }) => p)).toEqual(['localisation/english/big_l_english.yml']);
    expect(plan.files[0]!.after).toEqual(
      bom('l_english:\r\n a:0 "A"\r\n b:0 "B"\r\n c:0 "C" # keep\r\n d:0 "D"'),
    );
    expect(plan.files[0]!.changes).toEqual([{ kind: 'add_key', key: 'd', line: 5 }]);
  });

  it('skips an unchanged key, skips a different one, and rewrites it with replace', async () => {
    const files = {
      'localisation/english/a_l_english.yml': bom(
        'l_english:\n same: "Same"\n other: "Old" # why\n',
      ),
    };
    const { workspace: ws } = await workspace(files);
    const entries = [
      { key: 'same', text: 'Same' },
      { key: 'other', text: 'New' },
    ];
    const plain = await planAdd(
      { workspace: ws },
      { language: 'english', replace: false, entries },
    );
    expect(plain.files).toEqual([]);
    expect(plain.skipped.map(({ key }) => key)).toEqual(['same', 'other']);
    expect(plain.skipped[0]!.reason).toContain('unchanged');
    expect(plain.skipped[1]!.reason).toContain('replace');
    const replaced = await planAdd(
      { workspace: ws },
      { language: 'english', replace: true, entries },
    );
    expect(after(replaced, 'localisation/english/a_l_english.yml')).toBe(
      '\ufeffl_english:\n same: "Same"\n other: "New" # why\n',
    );
    expect(replaced.files[0]!.changes).toEqual([{ kind: 'replace_key', key: 'other', line: 3 }]);
  });

  it('puts a key the game defines into a replace folder and says it overrides', async () => {
    const { workspace: ws } = await workspace(
      { 'localisation/english/a_l_english.yml': bom('l_english:\n mine: "Mine"\n') },
      { 'localisation/english/v_l_english.yml': bom('l_english:\n GAME_KEY: "Game"\n') },
    );
    const plan = await planAdd(
      { workspace: ws },
      {
        language: 'english',
        replace: false,
        entries: [
          { key: 'GAME_KEY', text: 'Mod text' },
          { key: 'fresh', text: 'Fresh' },
        ],
      },
    );
    expect(plan.files.map(({ path: p }) => p)).toEqual([
      'localisation/english/a_l_english.yml',
      'localisation/english/replace/my_mod_replace_l_english.yml',
    ]);
    expect(after(plan, 'localisation/english/replace/my_mod_replace_l_english.yml')).toBe(
      '\ufeffl_english:\n GAME_KEY: "Mod text"\n',
    );
    expect(after(plan, 'localisation/english/a_l_english.yml')).toContain(' fresh: "Fresh"');
    expect(plan.files[1]!.changes).toContainEqual({
      kind: 'override_key',
      key: 'GAME_KEY',
      line: 2,
    });
    expect(plan.counts).toMatchObject({ keysOverridden: 1, keysAdded: 1 });
    expect(plan.notes.join(' ')).toContain('override');
    expect(plan.notes.join(' ')).toContain('replace folder');
  });

  it('refuses paths outside localisation/, parent segments, absolute paths and game files', async () => {
    const { workspace: ws, root } = await workspace({});
    const add = (file: string) =>
      planAdd(
        { workspace: ws },
        { language: 'english', replace: false, file, entries: [{ key: 'a', text: 'A' }] },
      );
    await expect(add('events/x_l_english.yml')).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    await expect(add('localisation/../events/x_l_english.yml')).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    await expect(add('../game/localisation/english/v_l_english.yml')).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    await expect(add('/etc/passwd')).rejects.toMatchObject({ code: 'LOCALISATION_PATH_INVALID' });
    await expect(add('C:\\Windows\\x_l_english.yml')).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    await expect(
      add(path.join(root, 'game', 'localisation', 'v_l_english.yml')),
    ).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    await expect(add('localisation/english/wrong_l_german.yml')).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    await expect(add('localisation/english/notes.txt')).rejects.toMatchObject({
      code: 'LOCALISATION_PATH_INVALID',
    });
    expect(normalizeLocalisationPath('localisation\\english\\a_l_english.yml', 'file')).toBe(
      'localisation/english/a_l_english.yml',
    );
  });

  it('rejects the same paths at the schema', () => {
    const parse = (extra: Record<string, unknown>) =>
      localisationWriteRequestSchema.safeParse({
        mode: 'add',
        entries: [{ key: 'a', text: 'A' }],
        ...extra,
      });
    expect(parse({ file: '../x_l_english.yml' }).success).toBe(false);
    expect(parse({ file: '/x_l_english.yml' }).success).toBe(false);
    expect(parse({ entries: [{ key: 'a b', text: 'A' }] }).success).toBe(false);
    expect(parse({ entries: [{ key: 'a', text: 'two\nlines' }] }).success).toBe(false);
    expect(
      parse({
        entries: [
          { key: 'a', text: 'A' },
          { key: 'a', text: 'B' },
        ],
      }).success,
    ).toBe(false);
    expect(
      localisationWriteRequestSchema.safeParse({ mode: 'fix', paths: ['localisation/x.yml'] })
        .success,
    ).toBe(true);
    expect(
      localisationWriteRequestSchema.safeParse({ mode: 'fix', entries: [{ key: 'a', text: 'A' }] })
        .success,
    ).toBe(false);
  });

  it('never targets a file that is not in the mod', async () => {
    const { workspace: ws } = await workspace({});
    const plan = await planAdd(
      { workspace: ws },
      { language: 'german', replace: false, entries: [{ key: 'a', text: 'A' }] },
    );
    expect(plan.files.map(({ path: p }) => p)).toEqual(['localisation/german/my_mod_l_german.yml']);
  });
});

describe('hoi4.localisation_write mode fix', () => {
  const all = ['bom', 'quotes', 'missing_languages'] as const;

  it('adds a missing BOM and changes nothing else', async () => {
    const original = 'l_english:\r\n a: "A"\r\n b: "B"';
    const { workspace: ws } = await workspace({
      'localisation/english/a_l_english.yml': Buffer.from(original),
      'localisation/english/ok_l_english.yml': bom('l_english:\n c: "C"\n'),
    });
    const plan = await planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: ['bom'] });
    expect(plan.files.map(({ path: p }) => p)).toEqual(['localisation/english/a_l_english.yml']);
    expect(plan.files[0]!.after).toEqual(bom(original));
    expect(plan.files[0]!.changes).toEqual([{ kind: 'add_bom' }]);
    expect(plan.counts.bomsAdded).toBe(1);
  });

  it('re-encodes UTF-16 to UTF-8 with a BOM', async () => {
    const text = 'l_english:\n a: "\u00e4\u00f6"\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const { workspace: ws } = await workspace({ 'localisation/english/u_l_english.yml': utf16 });
    const plan = await planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: ['bom'] });
    expect(plan.files[0]!.after).toEqual(bom(text));
    expect(plan.files[0]!.changes).toEqual([{ kind: 'reencode_utf16' }]);
  });

  it('reports a file whose encoding is unclear instead of guessing', async () => {
    const { workspace: ws } = await workspace({
      'localisation/english/legacy_l_english.yml': Buffer.from([0x6c, 0x5f, 0xe4, 0x0a]),
    });
    const plan = await planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: ['bom'] });
    expect(plan.files).toEqual([]);
    expect(plan.unfixable).toMatchObject([
      { kind: 'encoding', path: 'localisation/english/legacy_l_english.yml' },
    ]);
  });

  it('repairs unambiguous quotes in LF and CRLF files and reports the rest', async () => {
    const { workspace: ws } = await workspace({
      'localisation/english/lf_l_english.yml': bom(
        'l_english:\n a: "Open\n b: \u201cSmart\u201d\n c: "ok"\n d: "x" y\n',
      ),
      'localisation/english/crlf_l_english.yml': bom('l_english:\r\n e: "Open # c\r\n f: "ok"'),
    });
    const plan = await planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: ['quotes'] });
    expect(after(plan, 'localisation/english/lf_l_english.yml')).toBe(
      '\ufeffl_english:\n a: "Open"\n b: "Smart"\n c: "ok"\n d: "x" y\n',
    );
    expect(after(plan, 'localisation/english/crlf_l_english.yml')).toBe(
      '\ufeffl_english:\r\n e: "Open" # c\r\n f: "ok"',
    );
    expect(plan.counts.quotesFixed).toBe(3);
    expect(plan.unfixable).toMatchObject([
      { kind: 'quote', key: 'd', path: 'localisation/english/lf_l_english.yml' },
    ]);
  });

  it('limits the files with paths and reports a path nothing matches', async () => {
    const { workspace: ws } = await workspace({
      'localisation/english/a_l_english.yml': Buffer.from('l_english:\n a: "A"\n'),
      'localisation/english/b_l_english.yml': Buffer.from('l_english:\n b: "B"\n'),
    });
    const plan = await planFix(
      { workspace: ws, undefinedKeys: noEngine },
      { fixes: ['bom'], paths: ['localisation/english/a_l_english.yml', 'localisation/german'] },
    );
    expect(plan.files.map(({ path: p }) => p)).toEqual(['localisation/english/a_l_english.yml']);
    expect(plan.unfixable).toMatchObject([{ kind: 'path', path: 'localisation/german' }]);
    await expect(
      planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: ['bom'], paths: ['../x.yml'] }),
    ).rejects.toMatchObject({ code: 'LOCALISATION_PATH_INVALID' });
    await expect(
      planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: ['bom'], paths: ['/etc'] }),
    ).rejects.toMatchObject({ code: 'LOCALISATION_PATH_INVALID' });
  });

  it('copies English text into a supported language and leaves unsupported ones alone', async () => {
    const english = Array.from({ length: 8 }, (_unused, index) => ` k${index}: "English ${index}"`);
    const { workspace: ws } = await workspace(
      {
        'localisation/english/m_l_english.yml': bom(`l_english:\n${english.join('\n')}\n`),
        'localisation/german/m_l_german.yml': bom(
          'l_german:\n k0:0 "Deutsch 0"\n k1:0 "Deutsch 1"\n k2:0 "Deutsch 2"',
        ),
        'localisation/french/m_l_french.yml': bom('l_french:\n k0: "Francais 0"\n'),
      },
      { 'localisation/german/v_l_german.yml': bom('l_german:\n k7: "Vanilla 7"\n') },
    );
    const plan = await planFix(
      { workspace: ws, undefinedKeys: noEngine },
      { fixes: ['missing_languages'] },
    );
    // French holds 1 of 8 English keys, below a quarter, so it is not supported.
    expect(plan.files.map(({ path: p }) => p)).toEqual(['localisation/german/m_l_german.yml']);
    const german = after(plan, 'localisation/german/m_l_german.yml');
    expect(german).toBe(
      '\ufeffl_german:\n k0:0 "Deutsch 0"\n k1:0 "Deutsch 1"\n k2:0 "Deutsch 2"\n' +
        [3, 4, 5, 6].map((index) => ` k${index}:0 "English ${index}"`).join('\n'),
    );
    // k7 has a German text in the game, which a copy would hide.
    expect(german).not.toContain('k7');
    expect(plan.counts.keysCopied).toBe(4);
    expect(plan.notes.join(' ')).toContain('engine is unavailable');
  });

  it('reports keys the script uses and nothing defines, without inventing text', async () => {
    const { workspace: ws } = await workspace({
      'localisation/english/m_l_english.yml': bom('l_english:\n a: "A"\n'),
    });
    const plan = await planFix(
      {
        workspace: ws,
        undefinedKeys: () =>
          Promise.resolve({
            available: true,
            total: 1,
            keys: [{ key: 'ghost.1.t', path: 'events/e.txt' }],
          }),
      },
      { fixes: ['missing_languages'] },
    );
    expect(plan.files).toEqual([]);
    expect(plan.unfixable).toMatchObject([
      { kind: 'undefined_key', key: 'ghost.1.t', path: 'events/e.txt' },
    ]);
    expect(plan.unfixable[0]!.reason).toContain('mode "add"');
  });

  it('does everything in one pass when all fixes run together', async () => {
    const { workspace: ws } = await workspace({
      'localisation/english/m_l_english.yml': Buffer.from('l_english:\n a: "A\n b: "B"\n'),
      'localisation/german/m_l_german.yml': Buffer.from('l_german:\n a: "AA"\n'),
    });
    const plan = await planFix({ workspace: ws, undefinedKeys: noEngine }, { fixes: [...all] });
    expect(after(plan, 'localisation/german/m_l_german.yml')).toBe(
      '\ufeffl_german:\n a: "AA"\n b: "B"\n',
    );
    expect(after(plan, 'localisation/english/m_l_english.yml')).toBe(
      '\ufeffl_english:\n a: "A"\n b: "B"\n',
    );
  });
});

describe('localisation diffs', () => {
  it('shows a changed line with context and marks a BOM', () => {
    const decoded = decodeLocBytes(
      Buffer.from('l_english:\n a: "A"\n b: "B"\n c: "C"\n d: "D"\n'),
    )!;
    decoded.target = 'utf8-bom';
    decoded.lines[3]!.content = ' c: "CC"';
    const { diff, truncated } = documentDiff(decoded, 'localisation/english/x_l_english.yml', 5000);
    expect(truncated).toBe(false);
    expect(diff).toContain('+[BOM]l_english:');
    expect(diff).toContain('- c: "C"');
    expect(diff).toContain('+ c: "CC"');
  });

  it('cuts a long diff at a line boundary and says so', () => {
    const decoded = newLocDocument();
    appendEntries(
      decoded,
      'english',
      Array.from({ length: 500 }, (_unused, index) => ` key_${index}: "Text ${index}"`),
    );
    const { diff, truncated } = documentDiff(decoded, 'localisation/english/n_l_english.yml', 1000);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(diff)).toBeLessThan(1300);
    expect(diff).toContain('diff truncated');
  });
});

describe('localisation write result size', () => {
  it('keeps a result for many files and findings under the wire budget', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      const lines = Array.from(
        { length: 40 },
        (_unused, line) => ` key_${index}_${line}: "Text for ${index} ${line} ${'x'.repeat(60)}`,
      );
      files[`localisation/english/f${String(index).padStart(2, '0')}_l_english.yml`] =
        `l_english:\n${lines.join('\n')}\n`;
    }
    const { workspace: ws } = await workspace(files);
    const plan = await planFix(
      { workspace: ws, undefinedKeys: noEngine },
      { fixes: ['bom', 'quotes'] },
    );
    expect(plan.files).toHaveLength(60);
    expect(plan.unfixable).toHaveLength(0);
    const data = summarizePlan('fix', plan, false);
    expect(data.files).toHaveLength(10);
    expect(data.counts).toMatchObject({ filesChanged: 60, filesOmitted: 50, quotesFixed: 2400 });
    const result = emptyServiceResult('fixture', data);
    result.proposedFiles = plan.files.map(({ path: p }) => p).slice(0, 64);
    const wire = toolResult(result);
    expect(JSON.stringify(wire.structuredContent).length).toBeLessThan(MAX_TOOL_RESULT_BYTES);
    expect(wire.structuredContent.code).toBe('OK');
    expect(JSON.stringify(wire.structuredContent)).not.toContain('MCP_RESPONSE_TRUNCATED');
  });
});
