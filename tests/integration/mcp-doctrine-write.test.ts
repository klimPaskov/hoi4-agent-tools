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
    kind: string;
    path: string;
    applied: boolean;
    diff: string;
    untouchedDefinitions: number;
    missing: { localisation: string[]; icon: string[]; folder: string[]; track: string[] };
  };
}

const TRACKS = ['tst_track_a = {', '\tname = TST_TRACK_A', '\ttype = infantry', '}', ''].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-docw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Doctrine write test"\n');
  await put(mod, 'common/doctrines/tracks/tst_tracks.txt', TRACKS);
  await put(
    mod,
    'common/doctrines/folders/tst_folders.txt',
    'tst_folder = {\n\tname = TST_FOLDER\n}\n',
  );
  await put(
    mod,
    'interface/my_doctrines.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_tst_doctrine_medium" texturefile = "gfx/interface/doctrines/a.dds" }\n}\n',
  );
  await put(mod, 'localisation/english/my_l_english.yml', '﻿l_english:\n TST_TRACK_A: "Track A"\n');
  await put(game, 'common/doctrines/tracks/game.txt', 'game_track = {\n\tname = GAME_TRACK\n}\n');
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
  const client = new Client({ name: 'doctrine-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: 'hoi4.doctrine_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, put: (relative: string, content: string) => put(mod, relative, content) };
}

describe('hoi4.doctrine_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again is refused', async () => {
    const { call, read } = await fixture();
    const request = {
      operation: 'add',
      kind: 'track',
      id: 'tst_track_b',
      body: 'name = TST_TRACK_A',
    };
    const preview = await call(request);
    expect(preview.code).toBe('DOCTRINE_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      id: 'tst_track_b',
      kind: 'track',
      path: 'common/doctrines/tracks/tst_tracks.txt',
      untouchedDefinitions: 1,
    });
    expect(preview.data.diff).toContain('+tst_track_b = {');
    expect(await read('common/doctrines/tracks/tst_tracks.txt')).toBe(TRACKS);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'DOCTRINE_WRITE_APPLIED',
      changedFiles: ['common/doctrines/tracks/tst_tracks.txt'],
    });
    const written = await read('common/doctrines/tracks/tst_tracks.txt');
    expect(written).toBe(`${TRACKS}\ntst_track_b = {\n\tname = TST_TRACK_A\n}\n`);
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(JSON.stringify(again)).toContain('DOCTRINE_WRITE_DUPLICATE_ID');
    expect(await read('common/doctrines/tracks/tst_tracks.txt')).toBe(written);
  });

  it('replaces and removes a doctrine found by its id, without naming its kind', async () => {
    const { call, read } = await fixture();
    const replaced = await call({
      operation: 'replace',
      id: 'tst_track_a',
      body: 'name = TST_TRACK_A\ntype = armor',
      apply: true,
    });
    expect(replaced.code).toBe('DOCTRINE_WRITE_APPLIED');
    expect(replaced.data.kind).toBe('track');
    expect(await read('common/doctrines/tracks/tst_tracks.txt')).toBe(
      'tst_track_a = {\n\tname = TST_TRACK_A\n\ttype = armor\n}\n',
    );
    const removed = await call({ operation: 'remove', id: 'tst_track_a', apply: true });
    expect(removed.code).toBe('DOCTRINE_WRITE_APPLIED');
    expect(await read('common/doctrines/tracks/tst_tracks.txt')).toBe('');
  });

  it('warns about a missing name, icon, folder and track, and still writes', async () => {
    const { call, read } = await fixture();
    const result = await call({
      operation: 'add',
      kind: 'grand_doctrine',
      id: 'tst_grand',
      file: 'common/doctrines/grand_doctrines/tst_grand.txt',
      createFile: true,
      body: 'folder = no_folder\nname = TST_GRAND\nicon = GFX_no_such_icon\ntracks = { tst_track_a no_such_track }',
      apply: true,
    });
    expect(result.code).toBe('DOCTRINE_WRITE_APPLIED');
    expect(result.data.missing).toEqual({
      localisation: ['TST_GRAND'],
      icon: ['GFX_no_such_icon'],
      folder: ['no_folder'],
      track: ['no_such_track'],
    });
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      'DOCTRINE_WRITE_FOLDER_UNDEFINED',
      'DOCTRINE_WRITE_ICON_UNDEFINED',
      'DOCTRINE_WRITE_LOCALISATION_MISSING',
      'DOCTRINE_WRITE_TRACK_UNDEFINED',
    ]);
    expect(await read('common/doctrines/grand_doctrines/tst_grand.txt')).toContain('tst_grand = {');
  });

  it('refuses what it cannot place: a game doctrine, no kind, a wrong kind, a bad body', async () => {
    const { call, read } = await fixture();
    const game = await call({ operation: 'remove', id: 'game_track', apply: true });
    expect(JSON.stringify(game)).toContain('DOCTRINE_WRITE_NOT_IN_MOD');
    const none = await call({ operation: 'add', id: 'tst_x', body: 'name = X' });
    expect(JSON.stringify(none)).toContain('DOCTRINE_WRITE_KIND_REQUIRED');
    const wrong = await call({
      operation: 'add',
      kind: 'subdoctrine',
      id: 'tst_x',
      body: 'name = X',
      file: 'common/doctrines/tracks/tst_tracks.txt',
    });
    expect(JSON.stringify(wrong)).toContain('DOCTRINE_WRITE_KIND_MISMATCH');
    const body = await call({ operation: 'add', kind: 'track', id: 'tst_x', body: 'a = { b = c' });
    expect(JSON.stringify(body)).toContain('DOCTRINE_WRITE_BODY_INVALID');
    expect(await read('common/doctrines/tracks/tst_tracks.txt')).toBe(TRACKS);
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const request = { operation: 'add', kind: 'track', id: 'tst_late', body: 'name = X' };
    expect((await call(request)).code).toBe('DOCTRINE_WRITE_PREVIEW');
    await put('common/doctrines/tracks/tst_tracks.txt', `${TRACKS}# edited by hand\n`);
    const applied = await call({ ...request, apply: true });
    expect(applied.code).toBe('DOCTRINE_WRITE_APPLIED');
    const text = await read('common/doctrines/tracks/tst_tracks.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('tst_late = {');
  });

  it('creates a file only when told to, in the folder of its kind, and needs a file when there are two', async () => {
    const { call, read } = await fixture();
    const file = {
      operation: 'add',
      id: 'tst_fresh',
      body: 'name = X',
      file: 'common/doctrines/tracks/fresh.txt',
    };
    expect(JSON.stringify(await call({ ...file, apply: true }))).toContain(
      'DOCTRINE_WRITE_FILE_NOT_FOUND',
    );
    const made = await call({ ...file, createFile: true, apply: true });
    expect(made).toMatchObject({ code: 'DOCTRINE_WRITE_APPLIED', changedFiles: [file.file] });
    expect(made.data.kind).toBe('track');
    expect(await read(file.file)).toBe('tst_fresh = {\n\tname = X\n}\n');
    expect(JSON.stringify(await call({ ...file, createFile: true, apply: true }))).toContain(
      'DOCTRINE_WRITE_FILE_EXISTS',
    );
    const ambiguous = await call({
      operation: 'add',
      kind: 'track',
      id: 'tst_other',
      body: 'name = X',
    });
    expect(JSON.stringify(ambiguous)).toContain('DOCTRINE_WRITE_FILE_REQUIRED');
    for (const bad of [
      'common/doctrines/tracks/../../escape.txt',
      'common/doctrines/other/x.txt',
      'common/doctrines/tracks/x.yml',
    ]) {
      const refused = await call({ ...file, id: 'tst_nope', file: bad, createFile: true });
      expect(refused.status).toBe('error');
    }
  });
});
