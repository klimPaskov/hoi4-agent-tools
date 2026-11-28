import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    kind: string;
    id: string;
    path: string;
    applied: boolean;
    diff: string;
    untouchedDefinitions: number;
    findings: Array<{ code: string }>;
    missing: { localisation: string[]; sprites: string[]; categories: string[]; focuses: string[] };
    verdict?: string;
    problems?: unknown[];
  };
}

const STRATEGIES = [
  'tst_strategy = {',
  '\tabort_when_not_enabled = yes',
  '\tai_strategy = { type = conquer id = "AAA" value = 10 }',
  '}',
  '',
].join('\n');

const ON_ACTIONS = [
  'on_actions = {',
  '\ton_startup = {',
  '\t\teffect = { log = "one" }',
  '\t\trandom_events = { 100 = tst.1 }',
  '\t}',
  '}',
  '',
].join('\n');

const BOP_BODY = [
  'initial_value = 0',
  'left_side = tst_left',
  'right_side = tst_right',
  'decision_category = tst_bop_category',
  'side = { id = tst_left icon = GFX_tst_left range = { id = tst_left_far min = -1 max = -0.2 } }',
  'side = { id = tst_right icon = GFX_tst_right range = { id = tst_right_far min = 0.2 max = 1 } }',
  'range = { id = tst_mid min = -0.2 max = 0.2 }',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-comw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Common write test"\n');
  await put(mod, 'common/ai_strategy/tst.txt', STRATEGIES);
  await put(mod, 'common/on_actions/tst.txt', ON_ACTIONS);
  await put(
    mod,
    'interface/my.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_tst_left" texturefile = "gfx/a.dds" }\n}\n',
  );
  await put(mod, 'localisation/english/my_l_english.yml', '﻿l_english:\n tst_bop: "Balance"\n');
  await put(
    game,
    'common/ai_strategy/_documentation.md',
    '# AI strategy\n\n## List of available strategy tokens\n\n### Related to diplomacy\n- `alliance`\n- `conquer`\n',
  );
  await put(
    game,
    'common/on_actions/_documentation.md',
    '# On actions\n\n### General\n- `on_startup`\n- `on_daily`\n- `on_daily_TAG`\n',
  );
  await put(
    game,
    'common/ai_strategy/game.txt',
    'game_strategy = {\n\tabort = { always = yes }\n}\n',
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
  const client = new Client({ name: 'common-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>, name = 'hoi4.common_write') => {
    const result = await client.callTool({
      name,
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return {
    call,
    read,
    root,
    mod,
    put: (relative: string, content: string) => put(mod, relative, content),
  };
}

describe('hoi4.common_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again is refused', async () => {
    const { call, read } = await fixture();
    const request = {
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_second',
      body: 'abort_when_not_enabled = yes\nai_strategy = { type = alliance id = "BBB" value = 5 }',
    };
    const preview = await call(request);
    expect(preview.code).toBe('COMMON_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      kind: 'ai_strategy',
      id: 'tst_second',
      path: 'common/ai_strategy/tst.txt',
      untouchedDefinitions: 1,
      findings: [],
    });
    expect(preview.data.diff).toContain('+tst_second = {');
    expect(await read('common/ai_strategy/tst.txt')).toBe(STRATEGIES);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'COMMON_WRITE_APPLIED',
      changedFiles: ['common/ai_strategy/tst.txt'],
    });
    const written = await read('common/ai_strategy/tst.txt');
    expect(written).toBe(
      `${STRATEGIES}\ntst_second = {\n\tabort_when_not_enabled = yes\n\tai_strategy = { type = alliance id = "BBB" value = 5 }\n}\n`,
    );
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(JSON.stringify(again)).toContain('COMMON_WRITE_DUPLICATE_ID');
    expect(await read('common/ai_strategy/tst.txt')).toBe(written);
  });

  it('warns about a type the documentation does not list and a missing abort, and still writes', async () => {
    const { call, read } = await fixture();
    const result = await call({
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_odd',
      body: 'ai_strategy = { type = made_up_token id = "AAA" value = 1 }',
      apply: true,
    });
    expect(result.code).toBe('COMMON_WRITE_APPLIED');
    expect(result.data.findings.map(({ code }) => code)).toEqual([
      'AI_STRATEGY_TYPE_UNKNOWN',
      'AI_STRATEGY_NO_ABORT',
    ]);
    expect(await read('common/ai_strategy/tst.txt')).toContain('tst_odd = {');
  });

  it('writes a balance of power into a new file and warns about what the mod does not define', async () => {
    const { call, read } = await fixture();
    const result = await call({
      kind: 'bop',
      operation: 'add',
      id: 'tst_bop',
      file: 'common/bop/tst_bop.txt',
      createFile: true,
      body: BOP_BODY,
      apply: true,
    });
    expect(result.code).toBe('COMMON_WRITE_APPLIED');
    expect(result.data.missing).toEqual({
      localisation: ['tst_left', 'tst_right', 'tst_mid', 'tst_left_far', 'tst_right_far'],
      sprites: ['GFX_tst_right'],
      categories: ['tst_bop_category'],
      focuses: [],
    });
    expect(await read('common/bop/tst_bop.txt')).toBe(
      `tst_bop = {\n${BOP_BODY.split('\n')
        .map((line) => `\t${line}`)
        .join('\n')}\n}\n`,
    );
  });

  it('refuses a balance of power whose ranges leave a gap, and writes nothing', async () => {
    const { call, mod } = await fixture();
    const refused = await call({
      kind: 'bop',
      operation: 'add',
      id: 'tst_bop',
      file: 'common/bop/tst_bop.txt',
      createFile: true,
      body: BOP_BODY.replace('max = -0.2', 'max = -0.3'),
      apply: true,
    });
    expect(refused.status).toBe('error');
    expect(JSON.stringify(refused)).toContain('BOP_RANGE_GAP');
    await expect(readFile(path.join(mod, 'common', 'bop', 'tst_bop.txt'))).rejects.toThrow();
  });

  it('adds to an on_action key, replaces and removes one child block, and refuses an unknown name', async () => {
    const { call, read } = await fixture();
    const added = await call({
      kind: 'on_action',
      operation: 'add',
      id: 'on_startup',
      body: 'effect = { log = "two" }',
      apply: true,
    });
    expect(added.code).toBe('COMMON_WRITE_APPLIED');
    expect(await read('common/on_actions/tst.txt')).toBe(
      ON_ACTIONS.replace(
        '\t\trandom_events = { 100 = tst.1 }\n',
        '\t\trandom_events = { 100 = tst.1 }\n\t\teffect = { log = "two" }\n',
      ),
    );
    const replaced = await call({
      kind: 'on_action',
      operation: 'replace',
      id: 'on_startup',
      blockIndex: 0,
      body: 'effect = { log = "new" }',
      apply: true,
    });
    expect(replaced.code).toBe('COMMON_WRITE_APPLIED');
    const removed = await call({
      kind: 'on_action',
      operation: 'remove',
      id: 'on_startup',
      blockIndex: 2,
      apply: true,
    });
    expect(removed.code).toBe('COMMON_WRITE_APPLIED');
    expect(await read('common/on_actions/tst.txt')).toBe(
      ON_ACTIONS.replace('effect = { log = "one" }', 'effect = { log = "new" }'),
    );
    const periodic = await call({
      kind: 'on_action',
      operation: 'add',
      id: 'on_daily_TST',
      body: 'effect = { log = "d" }',
      apply: true,
    });
    expect(periodic.code).toBe('COMMON_WRITE_APPLIED');
    const unknown = await call({
      kind: 'on_action',
      operation: 'add',
      id: 'on_made_up',
      body: 'effect = { log = "d" }',
      apply: true,
    });
    expect(unknown.status).toBe('error');
    expect(JSON.stringify(unknown)).toContain('COMMON_WRITE_NAME_UNKNOWN');
    expect(JSON.stringify(unknown)).toContain('on_daily');
  });

  it('round trip: a write leaves mod_health with no new problem', async () => {
    const { call } = await fixture();
    const before = await call({}, 'hoi4.mod_health');
    await call({
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_round',
      body: 'abort_when_not_enabled = yes\nai_strategy = { type = alliance id = "BBB" value = 5 }',
      apply: true,
    });
    await call({
      kind: 'on_action',
      operation: 'add',
      id: 'on_daily',
      body: 'effect = { log = "d" }',
      apply: true,
    });
    const after = await call({}, 'hoi4.mod_health');
    expect(after.data.problems?.length).toBe(before.data.problems?.length);
  });

  it('refuses what it must not touch: a game definition, a file outside the folder, an escape, a bad body', async () => {
    const { call, read, mod, root } = await fixture();
    const game = await call({
      kind: 'ai_strategy',
      operation: 'remove',
      id: 'game_strategy',
      apply: true,
    });
    expect(JSON.stringify(game)).toContain('COMMON_WRITE_NOT_FOUND');
    const outside = await call({
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_x',
      body: 'abort = { always = yes }',
      file: 'common/on_actions/tst.txt',
      apply: true,
    });
    expect(outside.status).toBe('error');
    for (const bad of [
      'common/ai_strategy/../../escape.txt',
      'common/ai_strategy/x.yml',
      '../outside/common/ai_strategy/x.txt',
    ]) {
      const refused = await call({
        kind: 'ai_strategy',
        operation: 'add',
        id: 'tst_x',
        body: 'abort = { always = yes }',
        file: bad,
        createFile: true,
        apply: true,
      });
      expect(refused.status).toBe('error');
    }
    const body = await call({
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_x',
      body: 'a = { b = c',
      apply: true,
    });
    expect(JSON.stringify(body)).toContain('COMMON_WRITE_BODY_INVALID');
    const nothing = await call({ kind: 'bop', operation: 'remove', id: 'tst_none', apply: true });
    expect(JSON.stringify(nothing)).toContain('COMMON_WRITE_NOT_FOUND');
    expect(await read('common/ai_strategy/tst.txt')).toBe(STRATEGIES);
    expect(await read('common/on_actions/tst.txt')).toBe(ON_ACTIONS);
    // A symlink inside the folder that leaves the mod is never written through.
    const outsideDir = path.join(root, 'outside');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      path.join(outsideDir, 'x.txt'),
      'tst_link = {\n\tabort = { always = yes }\n}\n',
    );
    try {
      await symlink(outsideDir, path.join(mod, 'common', 'ai_strategy', 'link'), 'junction');
    } catch {
      return;
    }
    const linked = await call({
      kind: 'ai_strategy',
      operation: 'replace',
      id: 'tst_link',
      body: 'abort = { always = no }',
      apply: true,
    });
    expect(linked.status).toBe('error');
    expect(await readFile(path.join(outsideDir, 'x.txt'), 'utf8')).toBe(
      'tst_link = {\n\tabort = { always = yes }\n}\n',
    );
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const request = {
      kind: 'ai_strategy',
      operation: 'add',
      id: 'tst_late',
      body: 'abort_when_not_enabled = yes\nai_strategy = { type = alliance id = "BBB" value = 5 }',
    };
    expect((await call(request)).code).toBe('COMMON_WRITE_PREVIEW');
    await put('common/ai_strategy/tst.txt', `${STRATEGIES}# edited by hand\n`);
    const applied = await call({ ...request, apply: true });
    expect(applied.code).toBe('COMMON_WRITE_APPLIED');
    const text = await read('common/ai_strategy/tst.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('tst_late = {');
  });
});
