import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-gui-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await cp(path.resolve('fixtures', 'gui', 'workspace'), workspaceRoot, { recursive: true });
  const runtimeRoot = path.join(root, 'runtime');
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        storageRoots: [runtimeRoot],
        maxSharedTools: 1,
        workspaces: [
          {
            id: 'test',
            name: 'GUI native task fixture',
            root: workspaceRoot,
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'gui-task-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const scenario = JSON.parse(
    await readFile(path.resolve('fixtures', 'gui', 'scenarios', 'baseline.json'), 'utf8'),
  ) as Record<string, unknown>;
  const source = path.join(workspaceRoot, 'interface', 'synthetic_acceptance.gui');
  return { client, engine, scenario, source, workspaceRoot };
}

async function completedTask(client: Client, name: string, arguments_: Record<string, unknown>) {
  const created = await client.request(
    { method: 'tools/call', params: { name, arguments: arguments_ } },
    CreateTaskResultSchema,
    { task: { ttl: 60_000 } },
  );
  await vi.waitFor(
    async () => {
      expect((await client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
        'completed',
      );
    },
    { timeout: 60_000, interval: 50 },
  );
  return {
    taskId: created.task.taskId,
    result: await client.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    ),
  };
}

describe('GUI jobs and negotiated native tasks', () => {
  it('returns exact legacy payloads and publishes result-ready checkpoints', async () => {
    const { client, engine, scenario, source } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const original = await readFile(source);
    const calls = [
      {
        name: 'hoi4.gui_inspect',
        arguments: { workspaceId: 'test' },
      },
      {
        name: 'hoi4.gui_render',
        arguments: {
          workspaceId: 'test',
          windowName: 'synthetic_gui_window',
          scenario,
          states: ['normal'],
          resolutions: [{ width: 960, height: 540, uiScale: 1 }],
          generatedScenarios: { enabled: false },
        },
      },
    ];
    const tools = await client.listTools();
    for (const call of calls) {
      expect(tools.tools.find(({ name }) => name === call.name)?.execution).toEqual({
        taskSupport: 'optional',
      });
      const legacy = await client.callTool(call);
      const task = await completedTask(client, call.name, call.arguments);
      expect(task.result.content).toEqual(legacy.content);
      expect(task.result.structuredContent).toEqual(legacy.structuredContent);
      expect(task.result.isError).toBe(legacy.isError);
      expect(task.result._meta).toMatchObject({
        'io.modelcontextprotocol/related-task': { taskId: task.taskId },
      });
      const separator = task.taskId.indexOf(':');
      const record = await jobs.get('test', task.taskId.slice(separator + 1));
      expect(record.status).toBe('completed');
      expect(record.checkpoint).toMatchObject({
        cursor: 'result-ready',
        resultHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
    expect(await readFile(source)).toEqual(original);
  });

  it('deduplicates native rewrites and returns the exact ordinary-call payload', async () => {
    const { client, engine, workspaceRoot } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const source = path.join(workspaceRoot, 'interface', 'task_rewrite.gui');
    const original = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "task_rewrite_window"',
      '\t\tposition = { x = 10 y = 20 }',
      '\t\tsize = { width = 320 height = 200 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    await writeFile(source, original, 'utf8');
    const rewritten = original.replace('x = 10', 'x = 24');
    const scenario = { id: 'task-rewrite', resolution: { width: 640, height: 360 } };
    const baseArguments = {
      mode: 'source',
      workspaceId: 'test',
      relativePath: 'interface/task_rewrite.gui',
      windowName: 'task_rewrite_window',
      scenario,
      source: rewritten,
    };
    const tools = await client.listTools();
    expect(tools.tools.find(({ name }) => name === 'hoi4.gui_rewrite')?.execution).toEqual({
      taskSupport: 'optional',
    });

    const ordinary = await client.callTool({ name: 'hoi4.gui_rewrite', arguments: baseArguments });
    expect(ordinary.structuredContent).toMatchObject({
      status: 'ok',
      code: 'GUI_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    await writeFile(source, original, 'utf8');
    engine.invalidate('test');

    const taskArguments = { ...baseArguments, requestKey: 'gui-rewrite-exactly-once' };
    const task = await completedTask(client, 'hoi4.gui_rewrite', taskArguments);
    expect(task.result.content).toEqual(ordinary.content);
    expect(task.result.structuredContent).toEqual(ordinary.structuredContent);
    expect(task.result.isError).toBe(ordinary.isError);
    expect(await readFile(source, 'utf8')).toBe(rewritten);

    const duplicate = await completedTask(client, 'hoi4.gui_rewrite', taskArguments);
    expect(duplicate.taskId).toBe(task.taskId);
    expect(duplicate.result.content).toEqual(task.result.content);
    const separator = task.taskId.indexOf(':');
    const record = await jobs.get('test', task.taskId.slice(separator + 1));
    expect(record).toMatchObject({
      status: 'completed',
      request: { mutation: true, requestKey: 'gui-rewrite-exactly-once' },
      writeRecipe: { mode: 'source' },
      transaction: {
        transactionId: expect.stringMatching(/^txn_/u),
        planHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(record.result).toMatchObject({
      content: task.result.content,
      structuredContent: task.result.structuredContent,
    });

    await expect(
      completedTask(client, 'hoi4.gui_rewrite', {
        ...taskArguments,
        source: original.replace('x = 10', 'x = 32'),
      }),
    ).rejects.toThrow();
    await expect(
      client.request(
        { method: 'tools/call', params: { name: 'hoi4.gui_rewrite', arguments: baseArguments } },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      ),
    ).rejects.toThrow();
  });

  it('cancels a native rewrite before source application without publishing a transaction', async () => {
    const { client, engine, workspaceRoot } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const source = path.join(workspaceRoot, 'interface', 'task_cancel.gui');
    const original = [
      'guiTypes = {',
      '\tcontainerWindowType = {',
      '\t\tname = "task_cancel_window"',
      '\t\tposition = { x = 10 y = 20 }',
      '\t\tsize = { width = 320 height = 200 }',
      '\t}',
      '}',
      '',
    ].join('\n');
    await writeFile(source, original, 'utf8');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, () => held);
    const created = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.gui_rewrite',
          arguments: {
            mode: 'source',
            workspaceId: 'test',
            relativePath: 'interface/task_cancel.gui',
            windowName: 'task_cancel_window',
            scenario: { id: 'task-cancel', resolution: { width: 640, height: 360 } },
            source: original.replace('x = 10', 'x = 24'),
            requestKey: 'gui-rewrite-cancel-before-apply',
          },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    await client.experimental.tasks.cancelTask(created.task.taskId);
    release();
    await capacity;
    await vi.waitFor(
      async () => {
        expect((await client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
          'cancelled',
        );
      },
      { timeout: 30_000, interval: 50 },
    );

    expect(await readFile(source, 'utf8')).toBe(original);
    const separator = created.task.taskId.indexOf(':');
    const record = await jobs.get('test', created.task.taskId.slice(separator + 1));
    expect(record).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      request: { mutation: true, requestKey: 'gui-rewrite-cancel-before-apply' },
    });
    expect(record).not.toHaveProperty('transaction');
    expect(record).not.toHaveProperty('writeRecipe');
  });
});
