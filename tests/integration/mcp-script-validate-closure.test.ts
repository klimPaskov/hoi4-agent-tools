import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
 * The closure option of `hoi4.script_validate` on the shared Rust engine (ADR 0083): the verdict
 * and counts for a whole mod, an engine that is missing, and the request shapes it refuses.
 */

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function client(files: Record<string, string>, environment: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-closure-')));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'mod');
  const game = path.join(root, 'game');
  await write(path.join(mod, 'descriptor.mod'), 'name="Closure fixture"\n');
  await write(
    path.join(game, 'common', 'ideas', 'g.txt'),
    'ideas = { country = { game_idea = { } } }\n',
  );
  for (const [relative, content] of Object.entries(files))
    await write(path.join(mod, relative), content);
  const resolved = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, value.replaceAll('<root>', root)]),
  );
  const previous = Object.fromEntries(Object.keys(resolved).map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(resolved)) process.env[key] = value;
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
  const server = createMcpServer(new CoreEngine(resolver));
  const mcp = new Client({ name: 'closure-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  return (args: Record<string, unknown>) =>
    mcp.callTool({
      name: 'hoi4.script_validate',
      arguments: { workspaceId: 'fixture', ...args },
    });
}

const EVENT = (body: string) =>
  `country_event = {
  id = ns.1
  option = {
${body}
  }
}
`;

describe('hoi4.script_validate closure', () => {
  it('closes a mod whose references all resolve against the game and the mod', async () => {
    const call = await client({
      'events/a.txt': EVENT('    add_ideas = game_idea\n    add_ideas = mod_idea'),
      'common/ideas/m.txt': 'ideas = { country = { mod_idea = { } } }\n',
    });
    const result = await call({ closure: true });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      data: {
        valid: true,
        checksPerformed: ['closure'],
        parametersChecked: false,
        findings: [],
        closure: {
          verdict: 'closed',
          complete: true,
          sources: 1,
          totals: { resolved: 2, unresolved: 0, unknown: 0 },
          kinds: [{ kind: 'idea', resolved: 2, unresolved: 0, unknown: 0 }],
        },
      },
    });
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('documentation');
    expect(data).not.toHaveProperty('partialReasons');
  });

  it('counts an idea that nothing defines as unresolved', async () => {
    const call = await client({
      'events/a.txt': EVENT('    add_ideas = game_idea\n    add_ideas = nobody_defines_this'),
    });
    const result = await call({ closure: true });
    expect(result.structuredContent).toMatchObject({
      data: {
        valid: false,
        closure: {
          verdict: 'unresolved',
          totals: { resolved: 1, unresolved: 1, unknown: 0 },
          kinds: [{ kind: 'idea', resolved: 1, unresolved: 1, unknown: 0 }],
        },
      },
      diagnostics: [{ code: 'CLOSURE_UNRESOLVED_REFERENCES', severity: 'error' }],
    });
  });

  it('is incomplete whenever a reference cannot be decided', async () => {
    const call = await client({
      'events/a.txt': EVENT('    add_ideas = game_idea\n    has_idea = built_$NAME$'),
    });
    const result = await call({ closure: true });
    expect(result.structuredContent).toMatchObject({
      data: {
        valid: null,
        closure: { verdict: 'incomplete', totals: { resolved: 1, unresolved: 0, unknown: 1 } },
      },
    });
    const data = (result.structuredContent as { data: { partialReasons: string[] } }).data;
    expect(data.partialReasons.join(' ')).toContain('cannot be decided');
  });

  it('says the engine is unavailable instead of checking in TypeScript', async () => {
    const call = await client(
      { 'events/a.txt': EVENT('    add_ideas = game_idea') },
      { HOI4_ENGINE: '<root>/no-such-engine/hoi4-engine.exe' },
    );
    const result = await call({ closure: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('refuses a closure request that also names a snippet, a file, a kind or a scope', async () => {
    const call = await client({ 'events/a.txt': EVENT('    add_ideas = game_idea') });
    for (const extra of [
      { source: 'add_political_power = 1', kind: 'effect', scope: 'country' },
      { path: 'events/a.txt' },
      { kind: 'effect' },
      { scope: 'country' },
    ]) {
      const result = await call({ closure: true, ...extra });
      expect(result.isError, JSON.stringify(extra)).toBe(true);
    }
    const none = await call({});
    expect(none.isError).toBe(true);
  });
});
