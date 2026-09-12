import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobExecutor, JobOperations } from '../../src/hoi4_agent_tools/core/job-executor.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { registerEventJobs } from '../../src/hoi4_agent_tools/event/job-operations.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-native-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const mod = path.join(root, 'mod');
  const source = path.join(mod, 'events', 'synthetic.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    'add_namespace = synthetic\ncountry_event = { id = synthetic.1 is_triggered_only = yes option = { name = synthetic.1.a add_political_power = 1 } }\n',
  );
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        maxSharedTools: 1,
        workspaces: [{ id: 'test', name: 'Native task fixture', root: mod }],
      }),
    ),
  );
  const connect = async () => {
    const server = createMcpServer(engine);
    const client = new Client({ name: 'native-task-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    return { client, server };
  };
  const jobs = await JobService.create(engine.resolver);
  const operations = new JobOperations();
  registerEventJobs(operations, engine);
  return {
    root,
    source,
    engine,
    jobs,
    executor: new JobExecutor(engine, jobs, operations),
    connect,
  };
}

async function waitForStatus(
  client: Client,
  taskId: string,
  expected: 'completed' | 'failed' | 'cancelled',
) {
  let task = await client.experimental.tasks.getTask(taskId);
  await vi.waitFor(
    async () => {
      task = await client.experimental.tasks.getTask(taskId);
      expect(task.status).toBe(expected);
    },
    { timeout: 15_000, interval: 50 },
  );
  return task;
}

describe('native MCP tasks backed by persistent jobs', () => {
  it('negotiates, reconnects, lists, and retrieves the exact completed tool result', async () => {
    const { engine, source, connect } = await fixture();
    const before = await readFile(source);
    const first = await connect();
    const tools = await first.client.listTools();
    expect(tools.tools.find(({ name }) => name === 'hoi4.event_inspect')?.execution).toEqual({
      taskSupport: 'optional',
    });
    expect(first.client.getServerCapabilities()?.tasks).toEqual({
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, () => held);
    const created = await first.client.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.event_inspect',
          arguments: { workspaceId: 'test', mode: 'roots' },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    expect(created.task).toMatchObject({ status: 'working', ttl: 60_000, pollInterval: 250 });

    await first.client.close();
    await first.server.close();
    const second = await connect();
    expect((await second.client.experimental.tasks.getTask(created.task.taskId)).status).toBe(
      'working',
    );
    release();
    await capacity;
    await waitForStatus(second.client, created.task.taskId, 'completed');
    const result = await second.client.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    );
    expect(result).toMatchObject({
      structuredContent: { code: 'EVENT_INSPECTED', data: { mode: 'roots' } },
      _meta: {
        'io.modelcontextprotocol/related-task': { taskId: created.task.taskId },
      },
    });
    expect((await second.client.experimental.tasks.listTasks()).tasks).toContainEqual(
      expect.objectContaining({ taskId: created.task.taskId, status: 'completed' }),
    );
    expect(await readFile(source)).toEqual(before);
  });

  it('maps durable cancellation, tool errors, and execution failures to distinct task states', async () => {
    const { engine, jobs, executor, connect } = await fixture();
    const { client } = await connect();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, () => held);
    const created = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'hoi4.event_inspect',
          arguments: { workspaceId: 'test', mode: 'roots' },
        },
      },
      CreateTaskResultSchema,
      { task: {} },
    );
    await client.experimental.tasks.cancelTask(created.task.taskId);
    release();
    await capacity;
    await waitForStatus(client, created.task.taskId, 'cancelled');

    const toolError = (
      await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        arguments: { workspaceId: 'other', mode: 'roots' },
        mutation: false,
        protocolTask: { ttl: null, pollInterval: 250 },
      })
    ).record;
    await executor.run('test', toolError.id);
    const completedError = await client.experimental.tasks.getTask(`test:${toolError.id}`);
    expect(completedError.status).toBe('completed');
    expect(
      await client.experimental.tasks.getTaskResult(`test:${toolError.id}`, CallToolResultSchema),
    ).toMatchObject({ isError: true, structuredContent: { code: 'JOB_ARGUMENT_SCOPE_MISMATCH' } });

    const failed = (
      await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        arguments: { workspaceId: 'test', mode: 'not_a_mode' },
        mutation: false,
        protocolTask: { ttl: null, pollInterval: 250 },
      })
    ).record;
    await waitForStatus(client, `test:${failed.id}`, 'failed');
  });

  it('retains probability analysis across isolated evaluate and render workers', async () => {
    const { source, connect } = await fixture();
    const before = await readFile(source);
    const { client } = await connect();
    const tools = await client.listTools();
    for (const name of [
      'hoi4.probability_inspect',
      'hoi4.probability_evaluate',
      'hoi4.probability_sweep',
      'hoi4.probability_simulate',
      'hoi4.probability_sequence',
      'hoi4.probability_compare',
      'hoi4.probability_render',
    ]) {
      expect(tools.tools.find((tool) => tool.name === name)?.execution, name).toEqual({
        taskSupport: 'optional',
      });
    }
    const evaluateArguments = {
      workspaceId: 'test',
      customPoolManifest: {
        schemaVersion: '1.0',
        id: 'native-task-pool',
        selection: { mode: 'categorical_weighted', cadence: 'daily' },
        state: {},
        candidates: [
          { id: 'alpha', weight: 3 },
          { id: 'beta', weight: 1 },
        ],
        transitions: [],
      },
      scenarioSet: {
        schemaVersion: '1.0',
        id: 'native-task-scenarios',
        scenarios: [{ id: 'baseline', state: {} }],
      },
      outputs: ['json'],
    };
    const legacyEvaluate = await client.callTool({
      name: 'hoi4.probability_evaluate',
      arguments: evaluateArguments,
    });
    const evaluated = await client.request(
      {
        method: 'tools/call',
        params: { name: 'hoi4.probability_evaluate', arguments: evaluateArguments },
      },
      CreateTaskResultSchema,
      { task: {} },
    );
    await waitForStatus(client, evaluated.task.taskId, 'completed');
    const evaluateResult = await client.experimental.tasks.getTaskResult(
      evaluated.task.taskId,
      CallToolResultSchema,
    );
    expect(evaluateResult.content).toEqual(legacyEvaluate.content);
    expect(evaluateResult.structuredContent).toEqual(legacyEvaluate.structuredContent);
    const analysisId = (evaluateResult.structuredContent as { data: { analysisId: string } }).data
      .analysisId;

    const renderArguments = {
      workspaceId: 'test',
      analysisId,
      outputs: ['matrix'],
      includeHtml: false,
    };
    const legacyRender = await client.callTool({
      name: 'hoi4.probability_render',
      arguments: renderArguments,
    });
    const rendered = await client.request(
      {
        method: 'tools/call',
        params: { name: 'hoi4.probability_render', arguments: renderArguments },
      },
      CreateTaskResultSchema,
      { task: {} },
    );
    await waitForStatus(client, rendered.task.taskId, 'completed');
    const renderResult = await client.experimental.tasks.getTaskResult(
      rendered.task.taskId,
      CallToolResultSchema,
    );
    expect(renderResult.content).toEqual(legacyRender.content);
    expect(renderResult.structuredContent).toEqual(legacyRender.structuredContent);
    expect(renderResult.structuredContent).toMatchObject({
      code: 'PROBABILITY_ANALYZED',
      data: { operation: 'render', analysisId },
    });
    expect(await readFile(source)).toEqual(before);
  });
});
