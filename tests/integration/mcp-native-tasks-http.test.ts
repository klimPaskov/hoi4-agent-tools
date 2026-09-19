import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import {
  startHttpServer,
  type HttpServerHandle,
} from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const alphaSecret = 'alpha-native-task-secret-is-long-enough';
const betaSecret = 'beta-native-task-secret-is-long-enough';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
  delete process.env.HOI4_NATIVE_TASK_ALPHA_TOKEN;
  delete process.env.HOI4_NATIVE_TASK_BETA_TOKEN;
});

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'native-task-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://agent.example.test',
      },
    },
  });
  await client.connect(transport as unknown as Transport);
  cleanup.push(() => client.close());
  return client;
}

async function fixture(): Promise<{
  engine: CoreEngine;
  handle: HttpServerHandle;
  source: string;
  guiSource: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-native-task-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  const source = path.join(alpha, 'events', 'synthetic.txt');
  const guiSource = path.join(alpha, 'interface', 'task_window.gui');
  await Promise.all([
    mkdir(path.dirname(source), { recursive: true }),
    mkdir(path.dirname(guiSource), { recursive: true }),
    mkdir(path.join(beta, 'events'), { recursive: true }),
  ]);
  await writeFile(
    source,
    'add_namespace = synthetic\ncountry_event = { id = synthetic.1 is_triggered_only = yes option = { name = synthetic.1.a add_political_power = 1 } }\n',
  );
  await writeFile(
    guiSource,
    [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "task_window"',
      '\t\tposition = { x = 10 y = 20 }',
      '\t\tsize = { width = 320 height = 200 }',
      '\t}',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(beta, 'events', 'synthetic.txt'),
    'add_namespace = other\ncountry_event = { id = other.1 is_triggered_only = yes option = { name = other.1.a } }\n',
  );
  process.env.HOI4_NATIVE_TASK_ALPHA_TOKEN = alphaSecret;
  process.env.HOI4_NATIVE_TASK_BETA_TOKEN = betaSecret;
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    maxSharedTools: 1,
    workspaces: [
      { id: 'alpha', name: 'Alpha', root: alpha },
      { id: 'beta', name: 'Beta', root: beta },
    ],
    http: {
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: ['https://agent.example.test'],
      tokens: [
        {
          principal: 'alpha-user',
          tokenEnv: 'HOI4_NATIVE_TASK_ALPHA_TOKEN',
          workspaceIds: ['alpha'],
        },
        {
          principal: 'beta-user',
          tokenEnv: 'HOI4_NATIVE_TASK_BETA_TOKEN',
          workspaceIds: ['beta'],
        },
      ],
      principals: [],
    },
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  const handle = await startHttpServer(engine, configuration, createMcpServer);
  cleanup.push(() => handle.close());
  return { engine, handle, source, guiSource };
}

describe('authenticated native MCP tasks over Streamable HTTP', () => {
  it('survives session teardown and remains isolated to its principal', async () => {
    const { engine, handle, source } = await fixture();
    const before = await readFile(source);
    const alpha = await connect(handle.url, alphaSecret);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, () => held);
    const created = await alpha.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.event_inspect',
          arguments: { workspaceId: 'alpha', mode: 'roots' },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    expect(created.task).toMatchObject({ status: 'working', ttl: 60_000, pollInterval: 250 });
    await alpha.close();

    const beta = await connect(handle.url, betaSecret);
    expect((await beta.experimental.tasks.listTasks()).tasks).not.toContainEqual(
      expect.objectContaining({ taskId: created.task.taskId }),
    );
    await expect(beta.experimental.tasks.getTask(created.task.taskId)).rejects.toMatchObject({
      code: -32602,
    });

    release();
    await capacity;
    const reconnectedAlpha = await connect(handle.url, alphaSecret);
    await vi.waitFor(
      async () => {
        expect(
          (await reconnectedAlpha.experimental.tasks.getTask(created.task.taskId)).status,
        ).toBe('completed');
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(
      await reconnectedAlpha.experimental.tasks.getTaskResult(
        created.task.taskId,
        CallToolResultSchema,
      ),
    ).toMatchObject({
      structuredContent: { code: 'EVENT_INSPECTED', data: { mode: 'roots' } },
      _meta: {
        'io.modelcontextprotocol/related-task': { taskId: created.task.taskId },
      },
    });
    expect(await readFile(source)).toEqual(before);
  });

  it('retains and deduplicates an authenticated rewrite across HTTP reconnects', async () => {
    const { engine, handle, guiSource } = await fixture();
    const alpha = await connect(handle.url, alphaSecret);
    const original = await readFile(guiSource, 'utf8');
    const rewritten = original.replace('x = 10', 'x = 24');
    const arguments_ = {
      mode: 'source',
      workspaceId: 'alpha',
      relativePath: 'interface/task_window.gui',
      windowName: 'task_window',
      scenario: { id: 'http-task', resolution: { width: 640, height: 360 } },
      source: rewritten,
      requestKey: 'http-gui-rewrite-once',
    };
    const created = await alpha.request(
      { method: 'tools/call', params: { name: 'hoi4.gui_rewrite', arguments: arguments_ } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    await alpha.close();

    const beta = await connect(handle.url, betaSecret);
    await expect(beta.experimental.tasks.getTask(created.task.taskId)).rejects.toMatchObject({
      code: -32602,
    });
    const reconnectedAlpha = await connect(handle.url, alphaSecret);
    await vi.waitFor(
      async () => {
        expect(
          (await reconnectedAlpha.experimental.tasks.getTask(created.task.taskId)).status,
        ).toBe('completed');
      },
      { timeout: 60_000, interval: 50 },
    );
    const result = await reconnectedAlpha.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    );
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    expect(await readFile(guiSource, 'utf8')).toBe(rewritten);

    const duplicate = await reconnectedAlpha.request(
      { method: 'tools/call', params: { name: 'hoi4.gui_rewrite', arguments: arguments_ } },
      CreateTaskResultSchema,
      { task: { ttl: 120_000 } },
    );
    expect(duplicate.task.taskId).toBe(created.task.taskId);
    const jobs = await JobService.create(engine.resolver);
    const jobId = created.task.taskId.split(':')[1]!;
    const stored = await jobs.get('alpha', jobId, 'alpha-user');
    const independent = `${rewritten}# independent source change\n`;
    await writeFile(guiSource, independent);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(stored.updatedAt) + 60_001);
    await expect(
      reconnectedAlpha.experimental.tasks.getTask(created.task.taskId),
    ).rejects.toMatchObject({ code: -32602 });
    const renewed = await reconnectedAlpha.request(
      { method: 'tools/call', params: { name: 'hoi4.gui_rewrite', arguments: arguments_ } },
      CreateTaskResultSchema,
      { task: { ttl: 120_000 } },
    );
    expect(renewed.task).toMatchObject({ taskId: created.task.taskId, status: 'completed' });
    expect(renewed.task.ttl).toBeGreaterThan(120_000);
    expect((await reconnectedAlpha.experimental.tasks.getTask(created.task.taskId)).status).toBe(
      'completed',
    );
    expect(
      (
        await reconnectedAlpha.experimental.tasks.getTaskResult(
          created.task.taskId,
          CallToolResultSchema,
        )
      ).structuredContent,
    ).toEqual(result.structuredContent);
    expect(await readFile(guiSource, 'utf8')).toBe(independent);
    const retained = await jobs.get('alpha', jobId, 'alpha-user');
    expect(retained.result).toEqual(stored.result);
    expect(retained.transaction).toEqual(stored.transaction);
    expect(retained.requestHash).toBe(stored.requestHash);
    expect(retained.revision).toBe(stored.revision + 1);
  });
});
