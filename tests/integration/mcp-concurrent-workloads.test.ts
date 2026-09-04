import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { ScriptedGuiStudio } from '../../src/hoi4_agent_tools/gui/studio.js';
import { startHttpServer } from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const repository = path.resolve(import.meta.dirname, '../..');
const token = 'concurrency-test-token-at-least-thirty-two-characters';
const origin = 'https://concurrent.example.test';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-concurrency-'));
  const workspaces = [];
  for (const domain of ['focus', 'gui', 'event', 'technology', 'probability', 'map']) {
    const mod = path.join(root, domain);
    if (domain === 'map') {
      for (const kind of ['mod', 'game', 'dependency']) {
        await cp(path.join(repository, 'fixtures/map/roots', kind), path.join(mod, kind), {
          recursive: true,
        });
      }
      workspaces.push({
        id: domain,
        name: domain,
        root: path.join(mod, 'mod'),
        gameRoot: path.join(mod, 'game'),
        dependencyRoots: [path.join(mod, 'dependency')],
      });
    } else {
      await cp(path.join(repository, 'fixtures', domain, 'workspace'), mod, { recursive: true });
      workspaces.push({ id: domain, name: domain, root: mod });
    }
  }
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces,
    http: {
      port: 0,
      allowedOrigins: [origin],
      tokens: [
        {
          principal: 'load-test',
          tokenEnv: 'HOI4_CONCURRENCY_TOKEN',
          workspaceIds: workspaces.map(({ id }) => id),
        },
      ],
    },
  });
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return { root, config, configPath };
}

async function mixedCalls() {
  const scenario = JSON.parse(
    await readFile(path.join(repository, 'fixtures/gui/scenarios/baseline.json'), 'utf8'),
  ) as Record<string, unknown>;
  return [
    {
      name: 'hoi4.focus_inspect',
      arguments: {
        workspaceId: 'focus',
        relativePath: 'common/national_focus/synthetic_acceptance.txt',
      },
    },
    {
      name: 'hoi4.focus_render',
      arguments: {
        workspaceId: 'focus',
        relativePath: 'common/national_focus/synthetic_acceptance.txt',
      },
    },
    {
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: 'gui', windowName: 'synthetic_gui_window', scenario },
    },
    {
      name: 'hoi4.gui_render',
      arguments: {
        workspaceId: 'gui',
        windowName: 'synthetic_gui_window',
        scenario,
        states: ['normal'],
        resolutions: [{ width: 960, height: 540 }],
      },
    },
    { name: 'hoi4.event_inspect', arguments: { workspaceId: 'event', mode: 'scan' } },
    {
      name: 'hoi4.event_render',
      arguments: { workspaceId: 'event', view: 'overview', includeHtml: false },
    },
    { name: 'hoi4.tech_inspect', arguments: { workspaceId: 'technology', mode: 'scan' } },
    {
      name: 'hoi4.tech_render',
      arguments: {
        workspaceId: 'technology',
        view: 'folder',
        folderId: 'synthetic_folder_00',
        includeHtml: false,
      },
    },
    {
      name: 'hoi4.probability_inspect',
      arguments: {
        workspaceId: 'probability',
        adapter: 'event_option_ai_chance',
        source: { identifier: 'synthetic_options.1' },
      },
    },
    { name: 'hoi4.map_inspect', arguments: { workspaceId: 'map' } },
  ];
}

async function exercise(clients: Client[]) {
  const calls = await mixedCalls();
  const durations: number[] = [];
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, async (_, index) => {
      const call = calls[index % calls.length]!;
      const client = clients[index % clients.length]!;
      const started = performance.now();
      const progress: number[] = [];
      const result = await client.callTool(call, undefined, {
        timeout: 30_000,
        maxTotalTimeout: 240_000,
        resetTimeoutOnProgress: true,
        onprogress: ({ progress: value }) => {
          progress.push(value);
        },
      });
      durations.push(performance.now() - started);
      expect(result.isError, `${call.name}: ${JSON.stringify(result)}`).not.toBe(true);
      expect(result.structuredContent, call.name).toMatchObject({
        status: 'ok',
        workspaceId: call.arguments.workspaceId,
      });
      expect(progress.length, call.name).toBeGreaterThan(0);
      expect(
        progress.every((value, i) => i === 0 || value > progress[i - 1]!),
        `${call.name}: progress ${progress.join(',')}`,
      ).toBe(true);
      const artifacts = (result.structuredContent as { artifacts: Array<{ uri: string }> })
        .artifacts;
      expect(artifacts.length, call.name).toBeGreaterThan(0);
      const resource = await client.readResource({ uri: artifacts[0]!.uri });
      expect(resource.contents.length, call.name).toBeGreaterThan(0);
      return result;
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Concurrent domain calls failed',
    );
  expect(results).toHaveLength(30);
  for (const client of clients) expect((await client.listTools()).tools).toHaveLength(23);
  console.info(
    JSON.stringify({
      workload: '30 concurrent mixed domain calls',
      clients: clients.length,
      maxMs: Math.round(Math.max(...durations)),
    }),
  );
}

describe('concurrent production MCP workloads', () => {
  it('serves six HTTP sessions sharing one engine through a simultaneous mixed workload', async () => {
    const setup = await fixture();
    process.env.HOI4_CONCURRENCY_TOKEN = token;
    const engine = new CoreEngine(await WorkspaceResolver.create(setup.config));
    await engine.initialize();
    const firstGuiGraph = (await new ScriptedGuiStudio(engine).scan('gui')).graph;
    expect((await new ScriptedGuiStudio(engine).scan('gui')).graph).toBe(firstGuiGraph);
    const handle = await startHttpServer(engine, setup.config, createMcpServer);
    const clients: Client[] = [];
    try {
      await Promise.all(
        Array.from({ length: 6 }, async (_, id) => {
          const client = new Client({ name: `http-load-${id}`, version: '1' });
          clients.push(client);
          await client.connect(
            new StreamableHTTPClientTransport(new URL(handle.url), {
              requestInit: { headers: { authorization: `Bearer ${token}`, origin } },
            }) as unknown as Transport,
          );
        }),
      );
      await exercise(clients);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await handle.close();
      delete process.env.HOI4_CONCURRENCY_TOKEN;
      await rm(setup.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('serves four independent stdio processes using the same workspaces and artifacts', async () => {
    const setup = await fixture();
    const clients: Client[] = [];
    const stderr: string[] = [];
    try {
      await Promise.all(
        Array.from({ length: 4 }, async (_, id) => {
          const client = new Client({ name: `stdio-load-${id}`, version: '1' });
          clients.push(client);
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              '--import',
              'tsx',
              path.join(repository, 'src/bin/stdio.ts'),
              '--config',
              setup.configPath,
            ],
            cwd: repository,
            stderr: 'pipe',
          });
          transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
          await client.connect(transport as unknown as Transport);
        }),
      );
      await exercise(clients);
      expect(stderr.join('')).not.toMatch(
        /MaxListenersExceededWarning|transport_error|heap out of memory/u,
      );
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await rm(setup.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('keeps waiting calls alive and discovery responsive while cancelling a queued call', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-waiting-'));
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          maxConcurrentTools: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaces: [{ id: 'waiting', name: 'Waiting', root: mod }],
        }),
      ),
    );
    const server = createMcpServer(engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: number[] = [];
    server.registerTool(
      'fixture.wait',
      { inputSchema: z.object({ id: z.number() }) },
      async ({ id }) => {
        started.push(id);
        if (id === 1) await gate;
        return { content: [{ type: 'text', text: String(id) }] };
      },
    );
    const client = new Client({ name: 'waiting-test', version: '1' });
    const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
    await server.connect(outgoing as unknown as Transport);
    await client.connect(incoming as unknown as Transport);
    try {
      const first = client.callTool({ name: 'fixture.wait', arguments: { id: 1 } }, undefined, {
        timeout: 60_000,
      });
      const controller = new AbortController();
      const cancelled = client.callTool({ name: 'fixture.wait', arguments: { id: 2 } }, undefined, {
        signal: controller.signal,
      });
      const progress: number[] = [];
      const waiting = client.callTool({ name: 'fixture.wait', arguments: { id: 3 } }, undefined, {
        timeout: 12_000,
        maxTotalTimeout: 30_000,
        resetTimeoutOnProgress: true,
        onprogress: ({ progress: value }) => progress.push(value),
      });
      controller.abort();
      await expect(cancelled).rejects.toThrow();
      const discoveryStarted = performance.now();
      expect((await client.listTools()).tools.length).toBe(24);
      expect(performance.now() - discoveryStarted).toBeLessThan(2_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 14_000));
      expect(started).toEqual([1]);
      expect(progress.length).toBeGreaterThanOrEqual(2);
      release();
      await Promise.all([first, waiting]);
      expect(started).toEqual([1, 3]);
    } finally {
      release();
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
