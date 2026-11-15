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
    missing: { localisation: string[]; icon: string[]; category: string[] };
  };
}

const DECISIONS = [
  'tst_category = {',
  '\ttst_first = {',
  '\t\ticon = tst_icon',
  '\t\tcost = 50',
  '\t}',
  '}',
  '',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-decw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Decision write test"\n');
  await put(mod, 'common/decisions/tst.txt', DECISIONS);
  await put(
    mod,
    'common/decisions/categories/tst_categories.txt',
    'tst_category = {\n\ticon = x\n}\n',
  );
  await put(
    mod,
    'interface/my_decisions.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_decision_tst_icon" texturefile = "gfx/interface/decisions/tst.dds" }\n}\n',
  );
  await put(mod, 'localisation/english/my_l_english.yml', '﻿l_english:\n tst_first: "First"\n');
  await put(
    game,
    'common/decisions/GER.txt',
    'ger_category = {\n\tger_game_decision = {\n\t\tcost = 1\n\t}\n}\n',
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
  const client = new Client({ name: 'decision-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: 'hoi4.decision_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, put: (relative: string, content: string) => put(mod, relative, content) };
}

describe('hoi4.decision_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again is refused', async () => {
    const { call, read } = await fixture();
    const request = {
      operation: 'add',
      id: 'tst_second',
      category: 'tst_category',
      body: 'icon = tst_icon\ncost = 10',
    };
    const preview = await call(request);
    expect(preview.code).toBe('DECISION_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      id: 'tst_second',
      category: 'tst_category',
      path: 'common/decisions/tst.txt',
      untouchedDefinitions: 1,
    });
    expect(preview.data.diff).toContain('+\ttst_second = {');
    expect(await read('common/decisions/tst.txt')).toBe(DECISIONS);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'DECISION_WRITE_APPLIED',
      changedFiles: ['common/decisions/tst.txt'],
    });
    const written = await read('common/decisions/tst.txt');
    expect(written).toBe(
      DECISIONS.replace(
        '\t}\n}\n',
        '\t}\n\n\ttst_second = {\n\t\ticon = tst_icon\n\t\tcost = 10\n\t}\n}\n',
      ),
    );
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(JSON.stringify(again)).toContain('DECISION_WRITE_DUPLICATE_ID');
    expect(await read('common/decisions/tst.txt')).toBe(written);
  });

  it('replaces and removes a decision found by its id, and the round trip restores the file', async () => {
    const { call, read } = await fixture();
    const replaced = await call({
      operation: 'replace',
      id: 'tst_first',
      body: 'icon = tst_icon\ncost = 99',
      apply: true,
    });
    expect(replaced.code).toBe('DECISION_WRITE_APPLIED');
    expect(await read('common/decisions/tst.txt')).toContain('cost = 99');
    const removed = await call({ operation: 'remove', id: 'tst_first', apply: true });
    expect(removed.code).toBe('DECISION_WRITE_APPLIED');
    expect(await read('common/decisions/tst.txt')).toBe('tst_category = {\n}\n');
  });

  it('warns about a missing localisation key, icon sprite and category definition, and still writes', async () => {
    const { call, read } = await fixture();
    const result = await call({
      operation: 'add',
      id: 'tst_bare',
      category: 'tst_category',
      body: 'icon = no_such_icon',
      apply: true,
    });
    expect(result.code).toBe('DECISION_WRITE_APPLIED');
    expect(result.data.missing).toEqual({
      localisation: ['tst_bare'],
      icon: ['GFX_decision_no_such_icon'],
      category: [],
    });
    const fresh = await call({
      operation: 'add',
      id: 'tst_undefined',
      category: 'tst_undefined_category',
      createCategory: true,
      body: 'cost = 1',
      apply: true,
    });
    expect(fresh.data.missing.category).toEqual(['tst_undefined_category']);
    expect(fresh.diagnostics.map(({ code }) => code)).toContain(
      'DECISION_WRITE_CATEGORY_UNDEFINED',
    );
    expect(await read('common/decisions/tst.txt')).toContain('tst_undefined_category = {');
  });

  it('refuses what it cannot place: a game decision, an unknown category, a bad body', async () => {
    const { call, read } = await fixture();
    const game = await call({ operation: 'remove', id: 'ger_game_decision', apply: true });
    expect(JSON.stringify(game)).toContain('DECISION_WRITE_NOT_IN_MOD');
    const category = await call({
      operation: 'add',
      id: 'tst_x',
      category: 'nowhere',
      body: 'a = b',
    });
    expect(JSON.stringify(category)).toContain('DECISION_WRITE_CATEGORY_NOT_FOUND');
    const body = await call({
      operation: 'add',
      id: 'tst_x',
      category: 'tst_category',
      body: 'a = { b = c',
    });
    expect(JSON.stringify(body)).toContain('DECISION_WRITE_BODY_INVALID');
    expect(await read('common/decisions/tst.txt')).toBe(DECISIONS);
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const request = {
      operation: 'add',
      id: 'tst_late',
      category: 'tst_category',
      body: 'cost = 1',
    };
    expect((await call(request)).code).toBe('DECISION_WRITE_PREVIEW');
    await put('common/decisions/tst.txt', `${DECISIONS}# edited by hand\n`);
    const applied = await call({ ...request, apply: true });
    expect(applied.code).toBe('DECISION_WRITE_APPLIED');
    const text = await read('common/decisions/tst.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('tst_late = {');
  });

  it('creates a new file only when told to, never in the categories folder', async () => {
    const { call, read } = await fixture();
    const file = {
      operation: 'add',
      id: 'tst_fresh',
      category: 'tst_category',
      body: 'cost = 1',
      file: 'common/decisions/fresh.txt',
    };
    expect(JSON.stringify(await call({ ...file, apply: true }))).toContain(
      'DECISION_WRITE_FILE_NOT_FOUND',
    );
    const preview = await call({ ...file, createFile: true });
    expect(preview).toMatchObject({ code: 'DECISION_WRITE_PREVIEW', proposedFiles: [file.file] });
    const made = await call({ ...file, createFile: true, apply: true });
    expect(made).toMatchObject({ code: 'DECISION_WRITE_APPLIED', changedFiles: [file.file] });
    expect(await read(file.file)).toBe('tst_category = {\n\ttst_fresh = {\n\t\tcost = 1\n\t}\n}\n');
    expect(JSON.stringify(await call({ ...file, createFile: true, apply: true }))).toContain(
      'DECISION_WRITE_FILE_EXISTS',
    );
    // Two mod files now have the category, so an add without a file has no single place.
    const ambiguous = await call({
      operation: 'add',
      id: 'tst_other',
      category: 'tst_category',
      body: 'cost = 1',
    });
    expect(JSON.stringify(ambiguous)).toContain('DECISION_WRITE_FILE_REQUIRED');
    for (const bad of [
      'common/decisions/../../escape.txt',
      'common/other/x.txt',
      'common/decisions/x.yml',
      'common/decisions/categories/new.txt',
    ]) {
      const refused = await call({ ...file, id: 'tst_nope', file: bad, createFile: true });
      expect(refused.status).toBe('error');
    }
  });
});
