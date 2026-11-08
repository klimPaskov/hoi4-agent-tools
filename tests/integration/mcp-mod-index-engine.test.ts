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

/**
 * `hoi4.mod_index` on the shared Rust engine (ADR 0080): what the server sends, and how it
 * reports an engine that is missing, refuses the request or answers out of shape. The answers
 * themselves are covered by `mcp-mod-tools.test.ts` against the real engine.
 */

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A stand-in engine that records its request and prints `answer` with `status`. */
async function fakeEngine(root: string, answer: string, status: number): Promise<string> {
  const file = path.join(root, 'fake-engine.mjs');
  const recorded = path.join(root, 'request.json');
  await writeFile(
    file,
    `import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ command: process.argv[2], request: JSON.parse(input) }));
  process.stdout.write(${JSON.stringify(answer)});
  process.exit(${status});
});
`,
  );
  return file;
}

async function client(
  environment: Record<string, string | undefined>,
  options: { scanMaxFiles?: number } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-mod-index-engine-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await write(
    path.join(mod, 'descriptor.mod'),
    'name="Engine fixture"\nreplace_path="common/ideas"\n',
  );
  await write(path.join(mod, 'events', 'a.txt'), 'country_event = { id = e.1 }\n');
  await write(path.join(game, 'events', 'b.txt'), 'country_event = { id = e.4 }\n');
  const resolved = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, value?.replaceAll('<root>', root)]),
  );
  const previous = Object.fromEntries(Object.keys(resolved).map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(resolved))
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  close.push(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
  });
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      ...(options.scanMaxFiles === undefined ? {} : { scanMaxFiles: options.scanMaxFiles }),
      workspaces: [
        { id: 'fixture', name: 'Fixture', root: mod, gameRoot: game, includeGameDlc: false },
      ],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const mcp = new Client({ name: 'mod-index-engine-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return {
    root,
    mod,
    game,
    call: (args: Record<string, unknown>) =>
      mcp.callTool({ name: 'hoi4.mod_index', arguments: { workspaceId: 'fixture', ...args } }),
    recorded: async () =>
      JSON.parse(await readFile(path.join(root, 'request.json'), 'utf8')) as {
        command: string;
        request: {
          schema: string;
          roots: Array<{ kind: string; path: string; replacePaths: string[] }>;
          patterns: string[];
          limits: { maxFiles: number; maxBytes: number; maxFileBytes: number };
          mode: string;
          kind?: string;
          prefix?: string;
        };
      },
  };
}

const overviewAnswer = JSON.stringify({
  schema: 'hoi4-mod-index/1',
  status: 'ok',
  complete: true,
  skippedSourceCount: 0,
  skippedSources: [],
  files: 1,
  kinds: [{ kind: 'event', count: 1 }],
  folders: [{ folder: 'events', files: 1, bytes: 30 }],
  namespaces: [{ namespace: 'e', events: 1, lowest: 1, highest: 1, files: 1 }],
});

describe('hoi4.mod_index on the engine', () => {
  it('sends the mod root alone for an overview of the mod layer', async () => {
    const { call, recorded, mod } = await client({
      HOI4_ENGINE: '<root>/fake-engine.mjs',
    });
    const root = path.dirname(mod);
    await fakeEngine(root, overviewAnswer, 0);
    const result = await call({});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      code: 'MOD_INDEXED',
      data: {
        mode: 'overview',
        layer: 'mod',
        complete: true,
        files: 1,
        kinds: [{ kind: 'event', count: 1 }],
        namespaces: [{ namespace: 'e', events: 1, lowest: 1, highest: 1, files: 1 }],
        omittedNamespaces: 0,
      },
    });
    const { command, request } = await recorded();
    expect(command).toBe('mod-index');
    expect(request.schema).toBe('hoi4-mod-index-request/1');
    expect(request.mode).toBe('overview');
    expect(request.roots.map(({ kind }) => kind)).toEqual(['mod']);
    expect(request.roots[0]!.replacePaths).toEqual(['common/ideas']);
    expect(request.patterns).toContain('events/**/*.txt');
    expect(request.limits.maxFiles).toBeGreaterThan(0);
  });

  it('counts next_id over every layer and builds the identifiers from the prefix', async () => {
    const { call, recorded, mod } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(
      path.dirname(mod),
      JSON.stringify({
        schema: 'hoi4-mod-index/1',
        status: 'ok',
        complete: false,
        skippedSourceCount: 1,
        skippedSources: [
          {
            path: 'mod:events/x.txt',
            reasonCodes: ['SOURCE_NESTING_LIMIT'],
            possibleSymbolKinds: ['event'],
          },
        ],
        next: { used: 2, highest: 4, firstGap: 2 },
      }),
      0,
    );
    const result = await call({ mode: 'next_id', namespace: 'e.' });
    expect(result.structuredContent).toMatchObject({
      code: 'MOD_INDEXED_PARTIAL',
      data: {
        mode: 'next_id',
        complete: false,
        next: {
          kind: 'event',
          prefix: 'e.',
          used: 2,
          highest: 4,
          nextId: 'e.5',
          firstGapId: 'e.2',
        },
      },
    });
    const { request } = await recorded();
    expect(request.mode).toBe('next_id');
    expect(request.kind).toBe('event');
    expect(request.prefix).toBe('e.');
    expect(request.roots.map(({ kind }) => kind).sort()).toEqual(['game', 'mod']);
  });

  it('asks for a prefix before it starts the engine', async () => {
    const { call } = await client({ HOI4_ENGINE: '<root>/no-such-engine.exe' });
    const result = await call({ mode: 'next_id' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'MOD_INDEX_PREFIX_REQUIRED' });
  });
});

describe('hoi4.mod_index without a working engine', () => {
  it('says the engine is unavailable instead of answering from TypeScript', async () => {
    const { call } = await client({ HOI4_ENGINE: '<root>/no-such-engine/hoi4-engine.exe' });
    const result = await call({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('reports the code of a request the engine refuses', async () => {
    const { call, mod } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(
      path.dirname(mod),
      JSON.stringify({
        schema: 'hoi4-mod-index/1',
        status: 'invalid',
        error: { code: 'SCAN_PATTERN_UNSUPPORTED', message: 'The engine does not support it' },
      }),
      2,
    );
    const result = await call({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SCAN_PATTERN_UNSUPPORTED' });
  });

  it('refuses an answer that does not match the engine schema', async () => {
    const { call, mod } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(
      path.dirname(mod),
      JSON.stringify({ schema: 'hoi4-mod-index/1', status: 'ok', complete: 'yes' }),
      0,
    );
    const result = await call({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect(JSON.stringify(result.structuredContent)).toContain('invalid_output');
  });

  it('reports an engine that crashes as unavailable', async () => {
    const { call, mod } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(path.dirname(mod), 'not json', 3);
    const result = await call({ layer: 'all' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});

describe.skipIf(process.env.HOI4_ENGINE === undefined || process.env.HOI4_ENGINE === '')(
  'hoi4.mod_index on the real engine',
  () => {
    it('reports the scan file ceiling with its code', async () => {
      const { call } = await client({}, { scanMaxFiles: 1 });
      const result = await call({ layer: 'all' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'SCAN_FILE_LIMIT' });
    });

    it('leaves out game files under the mod replace_path, subfolders included', async () => {
      const { call, mod, game } = await client({});
      await write(
        path.join(game, 'common', 'ideas', 'sub', 'g.txt'),
        'ideas = { country = { g_idea = { } } }\n',
      );
      await write(
        path.join(mod, 'common', 'ideas', 'm.txt'),
        'ideas = { country = { m_idea = { } } }\n',
      );
      const result = await call({ layer: 'all' });
      const data = (
        result.structuredContent as {
          data: { kinds: Array<{ kind: string; count: number }>; files: number };
        }
      ).data;
      expect(data.kinds).toContainEqual({ kind: 'idea', count: 1 });
      expect(data.files).toBe(3);
    });
  },
);
