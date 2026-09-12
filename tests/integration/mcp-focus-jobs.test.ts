import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-focus-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  const relativePath = 'common/national_focus/task_focus.txt';
  const source = path.join(mod, ...relativePath.split('/'));
  const continuousRelativePath = 'common/continuous_focus/task_continuous.txt';
  const continuousSource = path.join(mod, ...continuousRelativePath.split('/'));
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.dirname(continuousSource), { recursive: true });
  await writeFile(
    source,
    `focus_tree = {
\tid = task_focus_tree
\tfocus = {
\t\tid = task_focus_root
\t\tx = 0
\t\ty = 0
\t\tcost = 5
\t\tcompletion_reward = { add_political_power = 25 }
\t}
}
`,
  );
  await writeFile(
    continuousSource,
    `continuous_focus_palette = {
\tid = task_continuous_palette
\tdefault = yes
\treset_on_civilwar = no
\tcontinuous_focus = {
\t\tid = task_continuous_focus
\t\tcost = 10
\t}
}
`,
  );
  const runtimeRoot = path.join(root, 'runtime');
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        storageRoots: [runtimeRoot],
        workspaces: [
          {
            id: 'test',
            name: 'Focus native task fixture',
            root: mod,
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'focus-task-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    engine,
    relativePath,
    source,
    continuousRelativePath,
    continuousSource,
  };
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

describe('focus jobs and negotiated native tasks', () => {
  it('returns exact legacy payloads and publishes result-ready checkpoints', async () => {
    const { client, engine, relativePath, source } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const original = await readFile(source);
    const calls = [
      {
        name: 'hoi4.focus_inspect',
        arguments: {
          workspaceId: 'test',
          relativePath,
          treeId: 'task_focus_tree',
        },
      },
      {
        name: 'hoi4.focus_render',
        arguments: {
          workspaceId: 'test',
          relativePath,
          treeId: 'task_focus_tree',
        },
      },
      {
        name: 'hoi4.focus_raster',
        arguments: {
          workspaceId: 'test',
          relativePath,
          treeId: 'task_focus_tree',
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

  it('deduplicates native focus rewrites and preserves ordinary-call output', async () => {
    const { client, engine, relativePath, source } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const original = await readFile(source);
    const inspected = await client.callTool({
      name: 'hoi4.focus_inspect',
      arguments: { workspaceId: 'test', relativePath, treeId: 'task_focus_tree' },
    });
    const artifacts = (inspected.structuredContent as { artifacts: Array<{ uri: string }> })
      .artifacts;
    const resource = await client.readResource({ uri: artifacts[0]!.uri });
    const content = resource.contents[0];
    if (content === undefined || !('text' in content))
      throw new Error('Missing focus plan artifact');
    const inspection = JSON.parse(content.text) as { plans: Array<Record<string, unknown>> };
    const plan = inspection.plans[0]!;
    const focuses = plan.focuses as Array<Record<string, unknown>>;
    focuses[0]!.cost = 6;
    const baseArguments = { workspaceId: 'test', relativePath, plan };
    expect(
      (await client.listTools()).tools.find(({ name }) => name === 'hoi4.focus_rewrite')?.execution,
    ).toEqual({ taskSupport: 'optional' });

    const ordinary = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: baseArguments,
    });
    expect(ordinary.structuredContent).toMatchObject({
      status: 'ok',
      code: 'FOCUS_CHANGES_APPLIED',
      data: { execution: 'applied', treeId: 'task_focus_tree' },
    });
    const sidecar = source.replace(/\.txt$/u, '.focus-plan.json');
    await writeFile(source, original);
    await rm(sidecar, { force: true });
    engine.invalidate('test');

    const taskArguments = { ...baseArguments, requestKey: 'focus-rewrite-exactly-once' };
    const task = await completedTask(client, 'hoi4.focus_rewrite', taskArguments);
    expect(task.result.content).toEqual(ordinary.content);
    expect(task.result.structuredContent).toEqual(ordinary.structuredContent);
    expect(task.result.isError).toBe(ordinary.isError);
    expect(await readFile(source, 'utf8')).toContain('\t\tcost = 6');
    await expect(readFile(sidecar, 'utf8')).resolves.toContain('task_focus_tree');

    const duplicate = await completedTask(client, 'hoi4.focus_rewrite', taskArguments);
    expect(duplicate.taskId).toBe(task.taskId);
    const separator = task.taskId.indexOf(':');
    expect(await jobs.get('test', task.taskId.slice(separator + 1))).toMatchObject({
      status: 'completed',
      request: { mutation: true, requestKey: 'focus-rewrite-exactly-once' },
      transaction: { transactionId: expect.stringMatching(/^txn_/u) },
      writeRecipe: {
        data: {
          mode: 'national',
          treeId: 'task_focus_tree',
          layoutHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
    });

    const conflictingPlan = structuredClone(plan);
    (conflictingPlan.focuses as Array<Record<string, unknown>>)[0]!.cost = 7;
    await expect(
      completedTask(client, 'hoi4.focus_rewrite', {
        ...taskArguments,
        plan: conflictingPlan,
      }),
    ).rejects.toThrow();
  });

  it('preserves continuous-focus rewrite parity through the native task adapter', async () => {
    const { client, engine, continuousRelativePath, continuousSource } = await fixture();
    const original = await readFile(continuousSource);
    const inspected = await client.callTool({
      name: 'hoi4.focus_inspect',
      arguments: {
        mode: 'continuous',
        workspaceId: 'test',
        relativePath: continuousRelativePath,
        paletteId: 'task_continuous_palette',
      },
    });
    const artifacts = (inspected.structuredContent as { artifacts: Array<{ uri: string }> })
      .artifacts;
    const resource = await client.readResource({ uri: artifacts[0]!.uri });
    const content = resource.contents[0];
    if (content === undefined || !('text' in content))
      throw new Error('Missing continuous-focus plan artifact');
    const inspection = JSON.parse(content.text) as {
      continuousFocusPalettes: Array<Record<string, unknown>>;
    };
    const plan = inspection.continuousFocusPalettes[0]!;
    plan.resetOnCivilWar = true;
    const baseArguments = {
      mode: 'continuous',
      workspaceId: 'test',
      relativePath: continuousRelativePath,
      plan,
    };

    const ordinary = await client.callTool({
      name: 'hoi4.focus_rewrite',
      arguments: baseArguments,
    });
    expect(ordinary.structuredContent).toMatchObject({
      status: 'ok',
      code: 'CONTINUOUS_FOCUS_CHANGES_APPLIED',
      data: {
        mode: 'continuous',
        paletteId: 'task_continuous_palette',
        execution: 'applied',
      },
    });
    await writeFile(continuousSource, original);
    engine.invalidate('test');

    const task = await completedTask(client, 'hoi4.focus_rewrite', {
      ...baseArguments,
      requestKey: 'continuous-focus-rewrite-exactly-once',
    });
    expect(task.result.content).toEqual(ordinary.content);
    expect(task.result.structuredContent).toEqual(ordinary.structuredContent);
    expect(task.result.isError).toBe(ordinary.isError);
    expect(await readFile(continuousSource, 'utf8')).toContain('\treset_on_civilwar = yes');
  });
});
