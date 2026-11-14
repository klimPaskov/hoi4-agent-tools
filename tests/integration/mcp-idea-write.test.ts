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
    category: string;
    path: string;
    applied: boolean;
    diff: string;
    untouchedDefinitions: number;
    missing: { localisation: string[]; picture: string[] };
  };
}

const IDEAS = [
  'ideas = {',
  '\tcountry = {',
  '\t\tfirst_spirit = {',
  '\t\t\tpicture = first_spirit',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-ideaw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Idea write test"\n');
  await put(mod, 'common/ideas/my_ideas.txt', IDEAS);
  await put(
    mod,
    'interface/my_ideas.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_idea_first_spirit" texturefile = "gfx/interface/ideas/first.dds" }\n}\n',
  );
  await put(mod, 'localisation/english/my_l_english.yml', '﻿l_english:\n first_spirit: "First"\n');
  await put(
    game,
    'common/ideas/GER.txt',
    'ideas = {\n\tcountry = {\n\t\tgame_spirit = { picture = game_spirit }\n\t}\n}\n',
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
  const client = new Client({ name: 'idea-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: 'hoi4.idea_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, put: (relative: string, content: string) => put(mod, relative, content) };
}

describe('hoi4.idea_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again changes nothing', async () => {
    const { call, read } = await fixture();
    const request = {
      operation: 'add',
      id: 'new_spirit',
      category: 'country',
      body: 'picture = first_spirit\nmodifier = { stability_factor = 0.05 }',
    };
    const preview = await call(request);
    expect(preview.code).toBe('IDEA_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      id: 'new_spirit',
      category: 'country',
      path: 'common/ideas/my_ideas.txt',
      untouchedDefinitions: 1,
    });
    expect(preview.data.diff).toContain('+\t\tnew_spirit = {');
    expect(await read('common/ideas/my_ideas.txt')).toBe(IDEAS);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'IDEA_WRITE_APPLIED',
      changedFiles: ['common/ideas/my_ideas.txt'],
    });
    const written = await read('common/ideas/my_ideas.txt');
    expect(written).toBe(
      IDEAS.replace(
        '\t\t}\n\t}\n}',
        '\t\t}\n\n\t\tnew_spirit = {\n\t\t\tpicture = first_spirit\n\t\t\tmodifier = { stability_factor = 0.05 }\n\t\t}\n\t}\n}',
      ),
    );

    // The idea is there now, so adding it again is refused and nothing moves.
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(await read('common/ideas/my_ideas.txt')).toBe(written);
  });

  it('replaces and removes an idea found by its id, and the round trip restores the file', async () => {
    const { call, read } = await fixture();
    const replaced = await call({
      operation: 'replace',
      id: 'first_spirit',
      body: 'picture = first_spirit\nmodifier = { stability_factor = 0.2 }',
      apply: true,
    });
    expect(replaced.code).toBe('IDEA_WRITE_APPLIED');
    expect(await read('common/ideas/my_ideas.txt')).toContain('stability_factor = 0.2');

    const removed = await call({ operation: 'remove', id: 'first_spirit', apply: true });
    expect(removed.code).toBe('IDEA_WRITE_APPLIED');
    expect(await read('common/ideas/my_ideas.txt')).toBe('ideas = {\n\tcountry = {\n\t}\n}\n');
  });

  it('warns about a missing localisation key and picture sprite, and still writes', async () => {
    const { call, read } = await fixture();
    const result = await call({
      operation: 'add',
      id: 'bare_spirit',
      category: 'country',
      body: 'picture = no_such_picture',
      apply: true,
    });
    expect(result.code).toBe('IDEA_WRITE_APPLIED');
    expect(result.data.missing).toEqual({
      localisation: ['bare_spirit'],
      picture: ['GFX_idea_no_such_picture'],
    });
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      'IDEA_WRITE_LOCALISATION_MISSING',
      'IDEA_WRITE_PICTURE_UNDEFINED',
    ]);
    expect(await read('common/ideas/my_ideas.txt')).toContain('bare_spirit = {');
  });

  it('refuses what it cannot place: a game idea, an unknown category, a bad body', async () => {
    const { call, read } = await fixture();
    const game = await call({ operation: 'remove', id: 'game_spirit', apply: true });
    expect(game.status).toBe('error');
    expect(JSON.stringify(game)).toContain('IDEA_WRITE_NOT_IN_MOD');
    const category = await call({
      operation: 'add',
      id: 'x_spirit',
      category: 'nowhere',
      body: 'a = b',
    });
    expect(JSON.stringify(category)).toContain('IDEA_WRITE_CATEGORY_NOT_FOUND');
    const body = await call({
      operation: 'add',
      id: 'x_spirit',
      category: 'country',
      body: 'a = { b = c',
    });
    expect(JSON.stringify(body)).toContain('IDEA_WRITE_BODY_INVALID');
    expect(await read('common/ideas/my_ideas.txt')).toBe(IDEAS);
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const preview = await call({
      operation: 'add',
      id: 'late_spirit',
      category: 'country',
      body: 'picture = first_spirit',
    });
    expect(preview.code).toBe('IDEA_WRITE_PREVIEW');
    await put('common/ideas/my_ideas.txt', `${IDEAS}# edited by hand\n`);
    // A fresh apply plans from the edited file, so the hand edit is kept and the idea is added.
    const applied = await call({
      operation: 'add',
      id: 'late_spirit',
      category: 'country',
      body: 'picture = first_spirit',
      apply: true,
    });
    expect(applied.code).toBe('IDEA_WRITE_APPLIED');
    const text = await read('common/ideas/my_ideas.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('late_spirit = {');
  });

  it('creates a missing category and a new file only when told to, and the file path stays in common/ideas', async () => {
    const { call, read } = await fixture();
    const category = {
      operation: 'add',
      id: 'adviser_one',
      category: 'political_advisor',
      body: 'slot = political_advisor',
    };
    expect(JSON.stringify(await call({ ...category, apply: true }))).toContain(
      'IDEA_WRITE_CATEGORY_NOT_FOUND',
    );
    const madeCategory = await call({ ...category, createCategory: true, apply: true });
    expect(madeCategory.code).toBe('IDEA_WRITE_APPLIED');
    expect(await read('common/ideas/my_ideas.txt')).toContain(
      '\n\tpolitical_advisor = {\n\t\tadviser_one = {\n\t\t\tslot = political_advisor\n\t\t}\n\t}\n}',
    );

    const file = {
      operation: 'add',
      id: 'fresh_spirit',
      category: 'country',
      body: 'picture = first_spirit',
      file: 'common/ideas/fresh_ideas.txt',
    };
    expect(JSON.stringify(await call({ ...file, apply: true }))).toContain(
      'IDEA_WRITE_FILE_NOT_FOUND',
    );
    const preview = await call({ ...file, createFile: true });
    expect(preview).toMatchObject({ code: 'IDEA_WRITE_PREVIEW', proposedFiles: [file.file] });
    expect(preview.data.diff).toContain('+ideas = {');
    const made = await call({ ...file, createFile: true, apply: true });
    expect(made).toMatchObject({ code: 'IDEA_WRITE_APPLIED', changedFiles: [file.file] });
    expect(await read(file.file)).toBe(
      'ideas = {\n\tcountry = {\n\t\tfresh_spirit = {\n\t\t\tpicture = first_spirit\n\t\t}\n\t}\n}\n',
    );
    // The file exists now, so the flag is refused and the idea is a duplicate.
    expect(JSON.stringify(await call({ ...file, createFile: true, apply: true }))).toContain(
      'IDEA_WRITE_FILE_EXISTS',
    );
    for (const bad of [
      'common/ideas/../../escape.txt',
      'common/other/x.txt',
      'common/ideas/x.yml',
    ]) {
      const refused = await call({ ...file, id: 'other_spirit', file: bad, createFile: true });
      expect(refused.status).toBe('error');
    }
  });
});
