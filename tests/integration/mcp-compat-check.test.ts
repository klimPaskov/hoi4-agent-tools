import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  compatModDataSchema,
  compatPatchDataSchema,
} from '../../src/hoi4_agent_tools/schemas/compat.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

/**
 * hoi4.compat_check through an MCP client with a fake `hoi4-engine`: a script that answers
 * `check` with the report written for the checked mod's folder name. No real engine, no game
 * files and no third-party mod files are involved.
 */
const FAKE_ENGINE = `import { readFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(3);
const mod = args[args.indexOf('--mod') + 1];
if (process.argv[2] !== 'check' || mod === undefined) {
  process.stderr.write('unexpected call\\n');
  process.exit(64);
}
const report = JSON.parse(readFileSync(path.join(process.env.FAKE_CHECK_DIR, path.basename(mod) + '.json'), 'utf8'));
report.inputs.game_version = process.env.FAKE_BUILD ?? '1.0';
process.stdout.write(JSON.stringify(report));
`;

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

function layer(kind: string, name: string, folder: string, replacePaths: string[] = []) {
  return { kind, name, path: folder, replace_paths: replacePaths };
}

function report(layers: ReturnType<typeof layer>[], overrides: unknown[], findings: unknown[]) {
  return {
    schema: 'hoi4-engine-report/1',
    engine_version: 'fake',
    verdict: 'pass',
    inputs: { layers, game_version: '1.0' },
    summary: { errors: 0, warnings: 0, infos: 0, by_code: {} },
    stats: {},
    overrides,
    findings,
  };
}

async function connect() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-compat-mcp-'));
  const previous = {
    HOI4_ENGINE: process.env.HOI4_ENGINE,
    FAKE_CHECK_DIR: process.env.FAKE_CHECK_DIR,
    FAKE_BUILD: process.env.FAKE_BUILD,
  };
  close.push(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const game = path.join(root, 'game');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  const checks = path.join(root, 'checks');
  await Promise.all([game, alpha, beta, checks].map((dir) => mkdir(dir, { recursive: true })));
  await mkdir(path.join(game, 'events'), { recursive: true });
  await writeFile(path.join(game, 'events', 'e.txt'), 'one\ntwo\n');
  await writeFile(path.join(alpha, 'descriptor.mod'), 'name="Alpha"\n');
  await writeFile(path.join(beta, 'descriptor.mod'), 'name="Beta"\nreplace_path="events"\n');
  await mkdir(path.join(alpha, 'events'), { recursive: true });
  await writeFile(path.join(alpha, 'events', 'a.txt'), 'x');
  const gameLayer = layer('game', 'game', game);
  // Alpha checked, Beta loaded first.
  await writeFile(
    path.join(checks, 'alpha.json'),
    JSON.stringify(
      report(
        [gameLayer, layer('dependency', 'Beta', beta, ['events']), layer('mod', 'Alpha', alpha)],
        [
          { path: 'events/e.txt', winner: 'Alpha', replaced: ['game:events/e.txt'] },
          { path: 'common/x.txt', winner: 'Alpha', replaced: ['Beta:common/x.txt'] },
        ],
        [
          {
            code: 'LINT_DUPLICATE_ACROSS_LAYERS',
            severity: 'error',
            message:
              'event `shared.1` is also defined by dependency Beta in events/b.txt line 2, and both load',
            path: 'events/a.txt',
            layer: 'Alpha',
            line: 1,
            column: 1,
            subject: 'shared.1',
          },
        ],
      ),
    ),
  );
  // Beta checked, Alpha loaded first: Beta's replace_path unloads Alpha's events/a.txt.
  await writeFile(
    path.join(checks, 'beta.json'),
    JSON.stringify(
      report(
        [gameLayer, layer('dependency', 'Alpha', alpha), layer('mod', 'Beta', beta, ['events'])],
        [],
        [],
      ),
    ),
  );
  await writeFile(path.join(root, 'fake-engine.mjs'), FAKE_ENGINE);
  process.env.HOI4_ENGINE = path.join(root, 'fake-engine.mjs');
  process.env.FAKE_CHECK_DIR = checks;
  process.env.FAKE_BUILD = '1.0';
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [
        { id: 'alpha', name: 'Alpha', root: alpha, gameRoot: game, includeGameDlc: false },
        { id: 'beta', name: 'Beta', root: beta, gameRoot: game, includeGameDlc: false },
      ],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const mcp = new Client({ name: 'compat-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return {
    root,
    game,
    call: (args: Record<string, unknown>) =>
      mcp.callTool({ name: 'hoi4.compat_check', arguments: { workspaceId: 'alpha', ...args } }),
    tools: () => mcp.listTools(),
  };
}

interface Structured {
  status: string;
  code: string;
  validation: { passed: boolean };
  blockers: Array<{ code: string }>;
  data: unknown;
}

describe('hoi4.compat_check through MCP with a fake engine', () => {
  it('is advertised read-only', async () => {
    const { tools } = await connect();
    const tool = (await tools()).tools.find(({ name }) => name === 'hoi4.compat_check');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('compares the mod with another mod in both load orders', async () => {
    const { call } = await connect();
    const result = await call({ mode: 'mod', other: 'beta' });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const structured = result.structuredContent as unknown as Structured;
    expect(structured.code).toBe('COMPAT_MOD_CHECKED');
    expect(structured.validation.passed).toBe(false);
    const data = compatModDataSchema.parse(structured.data);
    expect(data.verdict).toBe('conflicts');
    const betaFirst = data.loadOrders[0];
    const alphaFirst = data.loadOrders[1];
    if (betaFirst === undefined || alphaFirst === undefined) throw new Error('two load orders');
    expect(betaFirst.second.id).toBe('alpha');
    expect(betaFirst.sameFile.items).toEqual([{ path: 'common/x.txt', winner: 'Alpha' }]);
    expect(betaFirst.duplicateDefinitions.items[0]).toMatchObject({ subject: 'shared.1' });
    expect([betaFirst.errors, betaFirst.warnings]).toEqual([1, 0]);
    // Beta's replace_path "events" unloads Alpha's events/a.txt when Beta loads last.
    expect(alphaFirst.replacePathDrops.items).toEqual([
      { folder: 'events', fileCount: 1, files: ['a.txt'] },
    ]);
    expect([alphaFirst.errors, alphaFirst.warnings]).toEqual([0, 1]);
    expect(data.lessLoss).toMatchObject({ loadsLast: { id: 'beta' }, errors: 0, warnings: 1 });
  });

  it('refuses an unknown other mod and a missing other', async () => {
    const { call } = await connect();
    const unknown = await call({ mode: 'mod', other: 'no_such_mod' });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.structuredContent)).toContain('WORKSPACE_NOT_REGISTERED');
    const missing = await call({ mode: 'mod' });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('other');
  });

  it('says so when the engine is unavailable', async () => {
    const { call, root } = await connect();
    process.env.HOI4_ENGINE = path.join(root, process.platform === 'win32' ? 'none.exe' : 'none');
    const result = await call({ mode: 'mod', other: 'beta' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('ENGINE_UNAVAILABLE');
  });

  it('records a baseline and then reports what a game update changed', async () => {
    const { call, game } = await connect();
    const first = await call({ mode: 'patch' });
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    const baseline = first.structuredContent as unknown as Structured;
    expect(baseline.code).toBe('COMPAT_PATCH_CHECKED');
    const base = compatPatchDataSchema.parse(baseline.data);
    expect(base.recorded).toMatchObject({ build: '1.0', files: 1 });
    expect(base.comparison).toBeNull();
    process.env.FAKE_BUILD = '1.1';
    await writeFile(path.join(game, 'events', 'e.txt'), 'one\nTWO\nthree\n');
    const second = await call({ mode: 'patch' });
    const compared = compatPatchDataSchema.parse(
      (second.structuredContent as unknown as Structured).data,
    );
    expect(compared.comparison).toMatchObject({ from: '1.0', to: '1.1', changed: 1 });
    expect(compared.comparison?.files[0]).toMatchObject({
      path: 'events/e.txt',
      change: 'changed',
      linesAdded: 2,
      linesRemoved: 1,
    });
    expect(compared.comparison?.files[0]?.firstHunk).toContain('+TWO');
  });
});
