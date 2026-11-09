import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
 * `hoi4.source_lookup` without references on the shared Rust engine (ADR 0082): what the server
 * sends, how it reports an engine that is missing, refuses the request or answers out of shape,
 * and what it refuses to read. The answers themselves are covered by `reference-service.test.ts`
 * and `source-navigation.test.ts` against the real engine.
 */

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

const EVENTS = 'country_event = {\n  id = e.1\n  title = e.1.t\n}\ncountry_event = { id = e.2 }\n';

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A stand-in engine that records its request and prints `answer` with `status`. */
async function fakeEngine(root: string, answer: string, status: number): Promise<void> {
  const recorded = path.join(root, 'request.json');
  await writeFile(
    path.join(root, 'fake-engine.mjs'),
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
}

async function client(environment: Record<string, string | undefined>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-source-lookup-engine-')));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await write(path.join(mod, 'descriptor.mod'), 'name="Engine fixture"\n');
  await write(path.join(mod, 'events', 'a.txt'), EVENTS);
  await write(path.join(game, 'events', 'b.txt'), 'country_event = { id = e.4 }\n');
  await write(path.join(root, 'outside.txt'), 'country_event = { id = e.9 }\n');
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
      workspaces: [
        { id: 'fixture', name: 'Fixture', root: mod, gameRoot: game, includeGameDlc: false },
      ],
    }),
  );
  const core = new CoreEngine(resolver);
  const server = createMcpServer(core);
  const mcp = new Client({ name: 'source-lookup-engine-test', version: '1' });
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
    core,
    call: (args: Record<string, unknown>) =>
      mcp.callTool({
        name: 'hoi4.source_lookup',
        arguments: { workspaceId: 'fixture', includeReferences: false, ...args },
      }),
    recorded: async () =>
      JSON.parse(await readFile(path.join(root, 'request.json'), 'utf8')) as {
        command: string;
        request: {
          schema: string;
          roots: Array<{ kind: string; path: string }>;
          patterns: string[];
          symbol: string;
          kind?: string;
          maxDefinitions: number;
        };
      },
  };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const REVISION = 'a'.repeat(64);

function answer(
  mod: string,
  overrides: { file?: string; text?: string; sha256?: string; candidates?: unknown[] } = {},
): string {
  const file = overrides.file ?? path.join(mod, 'events', 'a.txt');
  return JSON.stringify({
    schema: 'hoi4-source-lookup/1',
    status: 'ok',
    revision: REVISION,
    complete: true,
    skippedSourceCount: 0,
    definitionCount: 1,
    kindCount: 1,
    definitions: [
      {
        kind: 'event',
        id: 'e.1',
        path: 'mod:events/a.txt',
        rootKind: 'mod',
        loadOrder: 1,
        overridden: false,
        sourceShadowed: false,
        startLine: 1,
        endLine: 4,
        absolutePath: file,
        sha256: overrides.sha256 ?? sha(overrides.text ?? EVENTS),
      },
    ],
    suggestionCandidates: overrides.candidates ?? [],
  });
}

describe('hoi4.source_lookup on the engine', () => {
  it('sends the roots, the narrow patterns and the symbol, and reads only the chosen file', async () => {
    const { call, recorded, mod, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(root, answer(mod), 0);
    const result = await call({ symbol: 'e.1', kind: 'event' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      data: {
        sourceScope: 'event_definitions',
        revision: REVISION,
        complete: true,
        definitionCount: 1,
        definitionsTruncated: false,
        referencesIncluded: false,
        referenceCount: 0,
        definitions: [
          {
            kind: 'event',
            id: 'e.1',
            path: 'mod:events/a.txt',
            startLine: 1,
            endLine: 4,
            fromLine: 1,
            toLine: 4,
            text: EVENTS.split('\n').slice(0, 4).join('\n'),
          },
        ],
        references: [],
      },
    });
    const { command, request } = await recorded();
    expect(command).toBe('source-lookup');
    expect(request.schema).toBe('hoi4-source-lookup-request/1');
    expect(request.symbol).toBe('e.1');
    expect(request.kind).toBe('event');
    expect(request.patterns).toEqual(['events/**/*.txt']);
    expect(request.roots.map(({ kind }) => kind).sort()).toEqual(['game', 'mod']);
    expect(request.maxDefinitions).toBeGreaterThan(0);
  });

  it('answers a missed lookup with the near names, nearest first', async () => {
    const { call, mod, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(
      root,
      JSON.stringify({
        ...JSON.parse(answer(mod)),
        definitionCount: 0,
        kindCount: 0,
        definitions: [],
        suggestionCandidates: [
          { id: 'e.30', distance: 2 },
          { id: 'e.2', distance: 1 },
          { id: 'e.1', distance: 1 },
        ],
      }),
      0,
    );
    const result = await call({ symbol: 'e.3' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SYMBOL_NOT_FOUND' });
    expect(JSON.stringify(result.structuredContent)).toContain(
      '"suggestions":["e.1","e.2","e.30"]',
    );
  });

  it('refuses a stale expected revision with the current one', async () => {
    const { call, mod, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(root, answer(mod), 0);
    const result = await call({ symbol: 'e.1', expectedRevision: 'b'.repeat(64) });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SOURCE_REVISION_STALE' });
    expect(JSON.stringify(result.structuredContent)).toContain(REVISION);
  });

  it('refuses a file that changed after the engine scanned it', async () => {
    const { call, mod, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(root, answer(mod, { text: `${EVENTS}# edited\n` }), 0);
    const result = await call({ symbol: 'e.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SOURCE_REVISION_STALE' });
  });

  it('refuses a file outside the configured roots', async () => {
    const { call, mod, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    const outside = path.join(root, 'outside.txt');
    await fakeEngine(
      root,
      answer(mod, { file: outside, text: 'country_event = { id = e.9 }\n' }),
      0,
    );
    const result = await call({ symbol: 'e.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SOURCE_FILE_NOT_INDEXED' });
  });
});

describe('hoi4.source_lookup without a working engine', () => {
  it('says the engine is unavailable instead of answering from TypeScript', async () => {
    const { call } = await client({ HOI4_ENGINE: '<root>/no-such-engine/hoi4-engine.exe' });
    const result = await call({ symbol: 'e.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('reports the code of a request the engine refuses', async () => {
    const { call, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(
      root,
      JSON.stringify({
        schema: 'hoi4-source-lookup/1',
        status: 'invalid',
        error: { code: 'SCAN_PATTERN_UNSUPPORTED', message: 'The engine does not support it' },
      }),
      2,
    );
    const result = await call({ symbol: 'e.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SCAN_PATTERN_UNSUPPORTED' });
  });

  it('refuses an answer that does not match the engine schema', async () => {
    const { call, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(
      root,
      JSON.stringify({ schema: 'hoi4-source-lookup/1', status: 'ok', complete: 'yes' }),
      0,
    );
    const result = await call({ symbol: 'e.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect(JSON.stringify(result.structuredContent)).toContain('invalid_output');
  });

  it('reports an engine that crashes as unavailable', async () => {
    const { call, root } = await client({ HOI4_ENGINE: '<root>/fake-engine.mjs' });
    await fakeEngine(root, 'not json', 3);
    const result = await call({ symbol: 'e.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('needs the engine for the references too', async () => {
    const { call } = await client({ HOI4_ENGINE: '<root>/no-such-engine/hoi4-engine.exe' });
    const result = await call({ symbol: 'e.1', includeReferences: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});

describe.skipIf(process.env.HOI4_ENGINE === undefined || process.env.HOI4_ENGINE === '')(
  'hoi4.source_lookup on the real engine',
  () => {
    it('reports the revision the TypeScript scan computes for the same files', async () => {
      const { call, core } = await client({});
      const result = await call({ symbol: 'e.1', kind: 'event' });
      expect(result.isError).toBeFalsy();
      const data = (result.structuredContent as { data: { revision: string } }).data;
      const snapshot = await core.scan('fixture', { patterns: ['events/**/*.txt'] });
      expect(data.revision).toBe(snapshot.revision);
      // The whole workspace scan agrees too.
      const wide = await call({ symbol: 'e.4' });
      const everything = await core.scan('fixture', {});
      expect((wide.structuredContent as { data: { revision: string } }).data.revision).toBe(
        everything.revision,
      );
    });

    it('finds the lines, the overridden definition and the near names', async () => {
      const { call } = await client({});
      const found = await call({ symbol: 'e.2', kind: 'event' });
      expect(found.structuredContent).toMatchObject({
        data: {
          definitionCount: 1,
          definitions: [
            { path: expect.stringMatching(/events\/a\.txt$/u), startLine: 5, endLine: 5 },
          ],
        },
      });
      const missed = await call({ symbol: 'e.3', kind: 'event' });
      expect(missed.isError).toBe(true);
      expect(missed.structuredContent).toMatchObject({ code: 'SYMBOL_NOT_FOUND' });
      expect(JSON.stringify(missed.structuredContent)).toMatch(/"suggestions":\[[^\]]*"e\.1"/u);
    });
  },
);
