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

/** A mod with a scope mistake, a game with documentation, and a user folder with an error.log. */
async function connect() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-health-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const user = path.join(root, 'user');
  const mod = path.join(user, 'mod', 'health_mod');
  const game = path.join(root, 'game');
  await Promise.all([
    mkdir(path.join(mod, 'events'), { recursive: true }),
    mkdir(path.join(game, 'documentation'), { recursive: true }),
    mkdir(path.join(user, 'logs'), { recursive: true }),
  ]);
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Health mod"\n');
  await writeFile(
    path.join(mod, 'events', 'health.txt'),
    [
      'add_namespace = health',
      'country_event = {',
      '  id = health.1',
      '  is_triggered_only = yes',
      '  trigger = { stability > 0.5 }',
      '  option = { name = health.1.a add_political_power = 10 }',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(game, 'documentation', 'effects_documentation.md'),
    '# Effects\n## add_political_power\n* Supported Scopes: COUNTRY\nAdds power.\n',
  );
  await writeFile(
    path.join(game, 'documentation', 'triggers_documentation.md'),
    '# Triggers\n## has_stability\n* Supported Scopes: COUNTRY\nChecks stability.\n',
  );
  await writeFile(
    path.join(user, 'logs', 'error.log'),
    "[12:00:01][no_game_date]: Invalid trigger 'stability' in events/health.txt line : 5\n",
  );
  await writeFile(path.join(user, 'logs', 'system.log'), '[12:00:00][x]: Active Mod: Health mod\n');
  // The log must be newer than every mod file, whatever the clock resolution of the disk.
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(user, 'logs', 'error.log'), later, later);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'health', name: 'Health', root: mod, gameRoot: game }],
      gameUserRoot: user,
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const client = new Client({ name: 'health-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('modder tools through a client', () => {
  it('explains an error.log line against the mod and the game documentation', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'hoi4.explain_error',
      arguments: {
        workspaceId: 'health',
        line: "[12:00:01][no_game_date]: Invalid trigger 'stability' in events/health.txt line : 5",
      },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      data: {
        explained: 1,
        explanations: [
          {
            id: 'invalid_trigger',
            subject: 'stability',
            suggestions: ['has_stability'],
            source: { relativePath: 'events/health.txt', line: 5, layer: 'mod' },
          },
        ],
      },
    });
  });

  it('refuses a call without a line, naming the field', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'hoi4.explain_error',
      arguments: { workspaceId: 'health' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('line');
  });

  it('runs the audits it can and ranks what they find', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'hoi4.mod_health',
      arguments: { workspaceId: 'health', checks: ['error_log', 'script'] },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const data = (
      result.structuredContent as {
        data: {
          verdict: string;
          problems: Array<{ check: string; code: string; next?: { tool: string } }>;
          checks: Array<{ check: string; status: string }>;
        };
      }
    ).data;
    expect(data.verdict).toBe('problems');
    expect(data.checks.map(({ check, status }) => `${check}:${status}`)).toEqual([
      'error_log:ran',
      'engine_check:skipped',
      'script:ran',
      'localisation:skipped',
      'assets:skipped',
    ]);
    expect(data.problems[0]).toMatchObject({
      check: 'error_log',
      code: 'LOG_INVALID_TRIGGER',
      next: { tool: 'hoi4.explain_error' },
    });
    expect(result.structuredContent).toMatchObject({ validation: { passed: false } });
  });
});
