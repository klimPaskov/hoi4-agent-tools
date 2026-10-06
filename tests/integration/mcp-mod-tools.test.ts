import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A synthetic user-data folder: `<user>/mod/fixture` beside `<user>/logs/error.log`. */
async function client() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-mod-tools-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const user = path.join(root, 'user');
  const mod = path.join(user, 'mod', 'fixture');
  const game = path.join(root, 'game');
  await write(
    path.join(mod, 'descriptor.mod'),
    'name="Mod tools fixture"\nversion="1.2"\nsupported_version="1.16.*"\ntags={ "Gameplay" }\n',
  );
  await write(
    path.join(mod, 'events', 'broken.txt'),
    'add_namespace = fixture\ncountry_event = { id = fixture.1 }\ncountry_event = { id = fixture.2 }\ncountry_event = { id = fixture.5 }\n',
  );
  await write(
    path.join(mod, 'common', 'scripted_effects', 'helpers.txt'),
    'grant = { add_political_power = 1 }\n',
  );
  await write(
    path.join(game, 'events', 'base.txt'),
    'add_namespace = fixture\ncountry_event = { id = fixture.9 }\n',
  );
  await write(path.join(game, 'common', 'decisions', 'base.txt'), 'category = { }\n');
  const log = path.join(user, 'logs', 'error.log');
  await write(
    log,
    [
      '[09:15:02][persistent.cpp:48]: Error: "Unexpected token: }, near line: 12" in file: "events/broken.txt" near line: 14',
      '[09:15:02][effectimplementation.cpp:120]: Unknown effect-type: add_powr, near line: 7 in file: "common/scripted_effects/helpers.txt"',
      '[09:15:03][localisation.cpp:300]: Missing localisation key: missing_title',
      '[09:15:03][localisation.cpp:300]: Missing localisation key: missing_title',
      '[09:15:04][gfx.cpp:22]: Texture file not found: "gfx/interface/missing.dds"',
      '[09:15:05][trigger.cpp:90]: Invalid trigger in file: "common/decisions/base.txt" line: 3',
      '  continued detail for the trigger error',
      '',
    ].join('\n'),
  );
  // The event file changed after the game wrote the log; the helper file did not.
  const logged = new Date('2026-01-01T10:00:00Z');
  await utimes(log, logged, logged);
  const before = new Date('2026-01-01T09:00:00Z');
  await utimes(path.join(game, 'common', 'decisions', 'base.txt'), before, before);
  await utimes(
    path.join(mod, 'common', 'scripted_effects', 'helpers.txt'),
    logged,
    new Date('2026-01-01T09:00:00Z'),
  );
  await utimes(path.join(mod, 'events', 'broken.txt'), logged, new Date('2026-01-01T11:00:00Z'));
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
  const mcp = new Client({ name: 'mod-tools-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close.push(async () => {
    await mcp.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: { workspaceId: 'fixture', ...args } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as { code: string; data: Record<string, unknown> };
  };
  return { call };
}

interface LogEntry {
  category: string;
  count: number;
  message: string;
  source?: { relativePath: string; line?: number; layer: string; changedSinceLog: boolean };
}

describe('error log and mod index tools', () => {
  it('groups the game error log by category with located, layered sources', async () => {
    const { call } = await client();
    const result = await call('hoi4.error_log', {});
    expect(result.code).toBe('ERROR_LOG_READ');
    const data = result.data as {
      log: { entries: number; path: string };
      totalEntries: number;
      distinctEntries: number;
      modEntries: number;
      changedSinceLog: number;
      entries: LogEntry[];
    };
    expect(data.log).toMatchObject({ entries: 6, path: 'user:logs/error.log' });
    expect(data).toMatchObject({
      totalEntries: 6,
      distinctEntries: 5,
      modEntries: 2,
      changedSinceLog: 1,
    });
    // Mod-located entries come first, game-located ones last.
    expect(data.entries.map(({ category, source }) => [category, source?.layer])).toEqual([
      ['syntax', 'mod'],
      ['effect', 'mod'],
      ['localisation', undefined],
      ['graphics', 'unknown'],
      ['trigger', 'game'],
    ]);
    expect(data.entries[0]!.source).toEqual({
      relativePath: 'events/broken.txt',
      line: 14,
      layer: 'mod',
      changedSinceLog: true,
    });
    expect(data.entries[1]!.source).toMatchObject({ line: 7, changedSinceLog: false });
    expect(data.entries[2]!.count).toBe(2);
    // A missing asset is located even though no layer has the file.
    expect(data.entries[3]!.source?.relativePath).toBe('gfx/interface/missing.dds');
    expect(data.entries[4]!.message).toContain('continued detail');

    const modOnly = (await call('hoi4.error_log', { scope: 'mod' })).data as {
      entries: LogEntry[];
    };
    expect(modOnly.entries).toHaveLength(2);
    const unlocated = (await call('hoi4.error_log', { scope: 'unlocated' })).data as {
      entries: LogEntry[];
      nextOffset?: number;
    };
    expect(unlocated.entries.map(({ category }) => category)).toEqual(['localisation']);
    const page = (await call('hoi4.error_log', { limit: 2, offset: 2 })).data as {
      entries: LogEntry[];
      nextOffset?: number;
    };
    expect(page.entries.map(({ category }) => category)).toEqual(['localisation', 'graphics']);
    expect(page.nextOffset).toBe(4);
    const queried = (await call('hoi4.error_log', { query: 'add_powr' })).data as {
      entries: LogEntry[];
    };
    expect(queried.entries.map(({ category }) => category)).toEqual(['effect']);
  });

  it('maps mod definitions and finds the next free numbered ID across layers', async () => {
    const { call } = await client();
    const overview = (await call('hoi4.mod_index', {})).data as {
      kinds: Array<{ kind: string; count: number }>;
      namespaces: Array<{ namespace: string; events: number; lowest: number; highest: number }>;
      descriptor: unknown;
    };
    expect(overview.descriptor).toEqual({
      name: 'Mod tools fixture',
      version: '1.2',
      supportedVersion: '1.16.*',
      tags: ['Gameplay'],
      dependencies: [],
      replacePaths: [],
    });
    expect(overview.kinds).toEqual(
      expect.arrayContaining([
        { kind: 'event', count: 3 },
        { kind: 'scripted_effect', count: 1 },
      ]),
    );
    expect(overview.namespaces).toEqual([
      { namespace: 'fixture', events: 3, lowest: 1, highest: 5, files: 1 },
    ]);
    const next = (await call('hoi4.mod_index', { mode: 'next_id', namespace: 'fixture' })).data as {
      next: { nextId: string; highest: number; used: number; firstGapId: string };
    };
    // The game's fixture.9 counts, so the mod's next event does not collide with it.
    expect(next.next).toMatchObject({
      nextId: 'fixture.10',
      highest: 9,
      used: 4,
      firstGapId: 'fixture.3',
    });
  });
});
