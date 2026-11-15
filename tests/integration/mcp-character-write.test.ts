import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

interface Envelope {
  status: string;
  code: string;
  proposedFiles: string[];
  changedFiles: string[];
  diagnostics: Array<{ code: string; severity: string }>;
  blockers: Array<{ code: string }>;
  data: {
    operation: string;
    id: string;
    path: string;
    applied: boolean;
    diff: string;
    untouchedDefinitions: number;
    missing: { localisation: string[]; portrait: string[] };
  };
}

const CHARACTERS = [
  'characters = {',
  '\tTST_first = {',
  '\t\tname = TST_first',
  '\t\tportraits = {',
  '\t\t\tcivilian = {',
  '\t\t\t\tlarge = GFX_portrait_TST_first',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-charw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Character write test"\n');
  await put(mod, 'common/characters/TST.txt', CHARACTERS);
  await put(
    mod,
    'interface/my_portraits.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_portrait_TST_first" texturefile = "gfx/leaders/TST/first.dds" }\n}\n',
  );
  await put(
    mod,
    'localisation/english/my_l_english.yml',
    '﻿l_english:\n TST_first: "First Person"\n',
  );
  await put(
    game,
    'common/characters/GER.txt',
    'characters = {\n\tGER_game_person = {\n\t\tname = GER_game_person\n\t}\n}\n',
  );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [
        { id: 'fixture', name: 'Fixture', root: mod, gameRoot: game, includeGameDlc: false },
      ],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const client = new Client({ name: 'character-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: 'hoi4.character_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, put: (relative: string, content: string) => put(mod, relative, content) };
}

describe('hoi4.character_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again is refused', async () => {
    const { call, read } = await fixture();
    const request = {
      operation: 'add',
      id: 'TST_second',
      body: 'name = TST_first\nportraits = { civilian = { large = GFX_portrait_TST_first } }',
    };
    const preview = await call(request);
    expect(preview.code).toBe('CHARACTER_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      id: 'TST_second',
      path: 'common/characters/TST.txt',
      untouchedDefinitions: 1,
    });
    expect(preview.data.diff).toContain('+\tTST_second = {');
    expect(await read('common/characters/TST.txt')).toBe(CHARACTERS);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'CHARACTER_WRITE_APPLIED',
      changedFiles: ['common/characters/TST.txt'],
    });
    const written = await read('common/characters/TST.txt');
    expect(written).toBe(
      CHARACTERS.replace(
        '\t}\n}\n',
        '\t}\n\n\tTST_second = {\n\t\tname = TST_first\n\t\tportraits = { civilian = { large = GFX_portrait_TST_first } }\n\t}\n}\n',
      ),
    );
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(JSON.stringify(again)).toContain('CHARACTER_WRITE_DUPLICATE_ID');
    expect(await read('common/characters/TST.txt')).toBe(written);
  });

  it('replaces and removes a character found by its id, and the round trip restores the file', async () => {
    const { call, read } = await fixture();
    const replaced = await call({
      operation: 'replace',
      id: 'TST_first',
      body: 'name = TST_first\ngender = female',
      apply: true,
    });
    expect(replaced.code).toBe('CHARACTER_WRITE_APPLIED');
    expect(await read('common/characters/TST.txt')).toContain('gender = female');

    const removed = await call({ operation: 'remove', id: 'TST_first', apply: true });
    expect(removed.code).toBe('CHARACTER_WRITE_APPLIED');
    expect(await read('common/characters/TST.txt')).toBe('characters = {\n}\n');
  });

  it('warns about a missing name key and portrait sprite, and still writes', async () => {
    const { call, read } = await fixture();
    const result = await call({
      operation: 'add',
      id: 'TST_bare',
      body: 'name = TST_bare\nportraits = { civilian = { large = GFX_portrait_no_such_sprite } }',
      apply: true,
    });
    expect(result.code).toBe('CHARACTER_WRITE_APPLIED');
    expect(result.data.missing).toEqual({
      localisation: ['TST_bare'],
      portrait: ['GFX_portrait_no_such_sprite'],
    });
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      'CHARACTER_WRITE_LOCALISATION_MISSING',
      'CHARACTER_WRITE_PORTRAIT_UNDEFINED',
    ]);
    expect(await read('common/characters/TST.txt')).toContain('TST_bare = {');
  });

  it('refuses what it cannot place: a game character, a bad body, a wrong file', async () => {
    const { call, read } = await fixture();
    const game = await call({ operation: 'remove', id: 'GER_game_person', apply: true });
    expect(game.status).toBe('error');
    expect(JSON.stringify(game)).toContain('CHARACTER_WRITE_NOT_IN_MOD');
    const body = await call({ operation: 'add', id: 'TST_x', body: 'a = { b = c' });
    expect(JSON.stringify(body)).toContain('CHARACTER_WRITE_BODY_INVALID');
    const file = await call({
      operation: 'add',
      id: 'TST_x',
      body: 'name = x',
      file: 'common/characters/nope.txt',
    });
    expect(JSON.stringify(file)).toContain('CHARACTER_WRITE_FILE_NOT_FOUND');
    expect(await read('common/characters/TST.txt')).toBe(CHARACTERS);
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const request = { operation: 'add', id: 'TST_late', body: 'name = TST_late' };
    expect((await call(request)).code).toBe('CHARACTER_WRITE_PREVIEW');
    await put('common/characters/TST.txt', `${CHARACTERS}# edited by hand\n`);
    const applied = await call({ ...request, apply: true });
    expect(applied.code).toBe('CHARACTER_WRITE_APPLIED');
    const text = await read('common/characters/TST.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('TST_late = {');
  });

  it('needs a file when the mod has two, and creates a new one only when told to', async () => {
    const { call, put, read } = await fixture();
    const file = {
      operation: 'add',
      id: 'TST_fresh',
      body: 'name = TST_fresh',
      file: 'common/characters/fresh.txt',
    };
    expect(JSON.stringify(await call({ ...file, apply: true }))).toContain(
      'CHARACTER_WRITE_FILE_NOT_FOUND',
    );
    const preview = await call({ ...file, createFile: true });
    expect(preview).toMatchObject({ code: 'CHARACTER_WRITE_PREVIEW', proposedFiles: [file.file] });
    expect(preview.data.diff).toContain('+characters = {');
    const made = await call({ ...file, createFile: true, apply: true });
    expect(made).toMatchObject({ code: 'CHARACTER_WRITE_APPLIED', changedFiles: [file.file] });
    expect(await read(file.file)).toBe(
      'characters = {\n\tTST_fresh = {\n\t\tname = TST_fresh\n\t}\n}\n',
    );
    expect(JSON.stringify(await call({ ...file, createFile: true, apply: true }))).toContain(
      'CHARACTER_WRITE_FILE_EXISTS',
    );
    // Two mod files now hold characters, so an add without a file has no single place.
    await put('common/characters/TST2.txt', 'characters = {\n}\n');
    const ambiguous = await call({ operation: 'add', id: 'TST_other', body: 'name = x' });
    expect(JSON.stringify(ambiguous)).toContain('CHARACTER_WRITE_FILE_REQUIRED');
    for (const bad of [
      'common/characters/../../escape.txt',
      'common/other/x.txt',
      'common/characters/x.yml',
    ]) {
      const refused = await call({ ...file, id: 'TST_nope', file: bad, createFile: true });
      expect(refused.status).toBe('error');
    }
  });
});
