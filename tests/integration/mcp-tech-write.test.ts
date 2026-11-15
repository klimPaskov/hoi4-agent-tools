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
    missing: { localisation: string[]; sprite: string[]; unlock: string[]; folder: string[] };
  };
}

const TECHS = [
  'technologies = {',
  '\t@1936 = 2',
  '',
  '\ttst_tech_a = {',
  '\t\tresearch_cost = 1.5',
  '\t\tstart_year = @1936',
  '\t\tfolder = {',
  '\t\t\tname = tst_folder',
  '\t\t\tposition = { x = 0 y = 0 }',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-techw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Tech write test"\n');
  await put(mod, 'common/technologies/tst.txt', TECHS);
  await put(
    mod,
    'common/technology_tags/tst_folders.txt',
    'technology_folders = {\n\ttst_folder = {\n\t}\n}\n',
  );
  await put(
    mod,
    'common/units/equipment/tst_equipment.txt',
    'equipments = {\n\ttst_gun_1 = {\n\t\tyear = 1936\n\t}\n}\n',
  );
  await put(
    mod,
    'interface/my_techs.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_tst_tech_a_medium" texturefile = "gfx/interface/technologies/a.dds" }\n}\n',
  );
  await put(
    mod,
    'localisation/english/my_l_english.yml',
    '﻿l_english:\n tst_tech_a: "Tech A"\n tst_tech_a_desc: "About A"\n',
  );
  await put(
    game,
    'common/technologies/game.txt',
    'technologies = {\n\tgame_tech = {\n\t\tresearch_cost = 1\n\t}\n}\n',
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
  const client = new Client({ name: 'tech-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: 'hoi4.tech_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, put: (relative: string, content: string) => put(mod, relative, content) };
}

describe('hoi4.tech_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again is refused', async () => {
    const { call, read } = await fixture();
    const request = {
      operation: 'add',
      id: 'tst_tech_b',
      body: 'research_cost = 2\nfolder = { name = tst_folder position = { x = 1 y = 1 } }',
    };
    const preview = await call(request);
    expect(preview.code).toBe('TECH_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      id: 'tst_tech_b',
      path: 'common/technologies/tst.txt',
      untouchedDefinitions: 1,
    });
    expect(preview.data.diff).toContain('+\ttst_tech_b = {');
    expect(await read('common/technologies/tst.txt')).toBe(TECHS);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'TECH_WRITE_APPLIED',
      changedFiles: ['common/technologies/tst.txt'],
    });
    const written = await read('common/technologies/tst.txt');
    expect(written).toBe(
      TECHS.replace(
        '\t}\n}\n',
        '\t}\n\n\ttst_tech_b = {\n\t\tresearch_cost = 2\n\t\tfolder = { name = tst_folder position = { x = 1 y = 1 } }\n\t}\n}\n',
      ),
    );
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(JSON.stringify(again)).toContain('TECH_WRITE_DUPLICATE_ID');
    expect(await read('common/technologies/tst.txt')).toBe(written);
  });

  it('moves a technology with a replace, and removes it, restoring the file', async () => {
    const { call, read } = await fixture();
    const moved = await call({
      operation: 'replace',
      id: 'tst_tech_a',
      body: 'research_cost = 1.5\nstart_year = @1936\nfolder = {\n\tname = tst_folder\n\tposition = { x = 3 y = 2 }\n}',
      apply: true,
    });
    expect(moved.code).toBe('TECH_WRITE_APPLIED');
    expect(await read('common/technologies/tst.txt')).toBe(
      TECHS.replace('position = { x = 0 y = 0 }', 'position = { x = 3 y = 2 }'),
    );
    const removed = await call({ operation: 'remove', id: 'tst_tech_a', apply: true });
    expect(removed.code).toBe('TECH_WRITE_APPLIED');
    expect(await read('common/technologies/tst.txt')).toBe('technologies = {\n\t@1936 = 2\n}\n');
  });

  it('warns about missing text, sprite, folder and unlocks in a preview', async () => {
    const { call, read } = await fixture();
    const result = await call({
      operation: 'add',
      id: 'tst_tech_c',
      body: 'research_cost = 2 folder = { name = no_folder position = { x = 0 y = 0 } } enable_equipments = { tst_gun_1 no_such_gun }',
    });
    expect(result.code).toBe('TECH_WRITE_PREVIEW');
    expect(result.data.missing).toEqual({
      localisation: ['tst_tech_c', 'tst_tech_c_desc'],
      sprite: ['GFX_tst_tech_c_medium'],
      unlock: ['no_such_gun'],
      folder: ['no_folder'],
    });
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      'TECH_WRITE_FOLDER_UNDEFINED',
      'TECH_WRITE_LOCALISATION_MISSING',
      'TECH_WRITE_LOCALISATION_MISSING',
      'TECH_WRITE_SPRITE_UNDEFINED',
      'TECH_WRITE_UNLOCK_UNRESOLVED',
    ]);
    expect(await read('common/technologies/tst.txt')).toBe(TECHS);
  });

  it('writes with only text and sprite missing, and refuses an apply that names an undefined folder', async () => {
    const { call, read } = await fixture();
    const fine = await call({
      operation: 'add',
      id: 'tst_tech_c',
      body: 'research_cost = 2 folder = { name = tst_folder position = { x = 0 y = 0 } } enable_equipments = { tst_gun_1 }',
      apply: true,
    });
    expect(fine.code).toBe('TECH_WRITE_APPLIED');
    expect(fine.data.missing).toEqual({
      localisation: ['tst_tech_c', 'tst_tech_c_desc'],
      sprite: ['GFX_tst_tech_c_medium'],
      unlock: [],
      folder: [],
    });
    const written = await read('common/technologies/tst.txt');
    // The game rejects a folder nothing defines, so the post-write check restores the file.
    const refused = await call({
      operation: 'add',
      id: 'tst_tech_d',
      body: 'research_cost = 2 folder = { name = no_folder position = { x = 0 y = 0 } }',
      apply: true,
    });
    expect(refused.status).toBe('error');
    expect(JSON.stringify(refused)).toContain('no_folder');
    expect(await read('common/technologies/tst.txt')).toBe(written);
  });

  it('refuses what it cannot place: a game technology, a bad body, a wrong file', async () => {
    const { call, read } = await fixture();
    const game = await call({ operation: 'remove', id: 'game_tech', apply: true });
    expect(JSON.stringify(game)).toContain('TECH_WRITE_NOT_IN_MOD');
    const body = await call({ operation: 'add', id: 'tst_x', body: 'a = { b = c' });
    expect(JSON.stringify(body)).toContain('TECH_WRITE_BODY_INVALID');
    const file = await call({
      operation: 'add',
      id: 'tst_x',
      body: 'research_cost = 1',
      file: 'common/technologies/nope.txt',
    });
    expect(JSON.stringify(file)).toContain('TECH_WRITE_FILE_NOT_FOUND');
    expect(await read('common/technologies/tst.txt')).toBe(TECHS);
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const request = { operation: 'add', id: 'tst_late', body: 'research_cost = 1' };
    expect((await call(request)).code).toBe('TECH_WRITE_PREVIEW');
    await put('common/technologies/tst.txt', `${TECHS}# edited by hand\n`);
    const applied = await call({ ...request, apply: true });
    expect(applied.code).toBe('TECH_WRITE_APPLIED');
    const text = await read('common/technologies/tst.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('tst_late = {');
  });

  it('creates a new file only when told to, and needs a file when the mod has two', async () => {
    const { call, read } = await fixture();
    const file = {
      operation: 'add',
      id: 'tst_fresh',
      body: 'research_cost = 1',
      file: 'common/technologies/fresh.txt',
    };
    expect(JSON.stringify(await call({ ...file, apply: true }))).toContain(
      'TECH_WRITE_FILE_NOT_FOUND',
    );
    const preview = await call({ ...file, createFile: true });
    expect(preview).toMatchObject({ code: 'TECH_WRITE_PREVIEW', proposedFiles: [file.file] });
    const made = await call({ ...file, createFile: true, apply: true });
    expect(made).toMatchObject({ code: 'TECH_WRITE_APPLIED', changedFiles: [file.file] });
    expect(await read(file.file)).toBe(
      'technologies = {\n\ttst_fresh = {\n\t\tresearch_cost = 1\n\t}\n}\n',
    );
    expect(JSON.stringify(await call({ ...file, createFile: true, apply: true }))).toContain(
      'TECH_WRITE_FILE_EXISTS',
    );
    const ambiguous = await call({ operation: 'add', id: 'tst_other', body: 'research_cost = 1' });
    expect(JSON.stringify(ambiguous)).toContain('TECH_WRITE_FILE_REQUIRED');
    for (const bad of [
      'common/technologies/../../escape.txt',
      'common/other/x.txt',
      'common/technologies/x.yml',
    ]) {
      const refused = await call({ ...file, id: 'tst_nope', file: bad, createFile: true });
      expect(refused.status).toBe('error');
    }
  });
});
