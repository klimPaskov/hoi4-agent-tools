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
import type { ServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

const sourceText = (secondTechnology = 'task_technology_beta') => `technologies = {
\ttask_technology_alpha = {
\t\tstart_year = 1936
\t\tresearch_cost = 1
\t\tfolder = { name = task_folder position = { x = 0 y = 0 } }
\t\tpath = { leads_to_tech = ${secondTechnology} }
\t}
\t${secondTechnology} = {
\t\tstart_year = 1938
\t\tresearch_cost = 1
\t\tfolder = { name = task_folder position = { x = 1 y = 0 } }
\t}
}
`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-technology-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  const source = path.join(mod, 'common', 'technologies', 'task_technologies.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.join(mod, 'common', 'technology_tags'), { recursive: true });
  await writeFile(source, sourceText());
  await writeFile(
    path.join(mod, 'common', 'technology_tags', 'task_tags.txt'),
    'technology_folders = { task_folder = { ledger = army } }\n',
  );
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    storageRoots: [path.join(root, 'runtime')],
    workspaces: [
      {
        id: 'test',
        name: 'Technology native task fixture',
        root: mod,
        artifactRoot: path.join(root, 'runtime', 'artifacts'),
        cacheRoot: path.join(root, 'runtime', 'cache'),
      },
    ],
  });
  const createEngine = async () => {
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    await engine.initialize();
    return engine;
  };
  const connect = async (engine: CoreEngine) => {
    const server = createMcpServer(engine);
    const client = new Client({ name: 'technology-task-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let open = true;
    const close = async () => {
      if (!open) return;
      open = false;
      await client.close();
      await server.close();
    };
    cleanup.push(close);
    return { client, server, close };
  };
  return { root, source, configuration, createEngine, connect };
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
    { timeout: 30_000, interval: 50 },
  );
  return {
    taskId: created.task.taskId,
    result: await client.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    ),
  };
}

function serviceResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return result.structuredContent as unknown as ServiceResult<Record<string, unknown>>;
}

describe('technology jobs and negotiated native tasks', () => {
  it('returns the exact legacy payload and publishes result-ready checkpoints for every route', async () => {
    const { source, createEngine, connect } = await fixture();
    const engine = await createEngine();
    const jobs = await JobService.create(engine.resolver);
    const { client } = await connect(engine);
    const original = await readFile(source);
    const proposed = sourceText('task_technology_gamma');
    const calls = [
      { name: 'hoi4.tech_inspect', arguments: { workspaceId: 'test', mode: 'scan' } },
      {
        name: 'hoi4.tech_render',
        arguments: { workspaceId: 'test', view: 'folder', folderId: 'task_folder' },
      },
      {
        name: 'hoi4.tech_compare',
        arguments: {
          workspaceId: 'test',
          proposedSources: [
            { relativePath: 'common/technologies/task_technologies.txt', source: proposed },
          ],
          render: false,
        },
      },
    ];
    const tools = await client.listTools();
    for (const call of calls) {
      expect(tools.tools.find(({ name }) => name === call.name)?.execution).toEqual({
        taskSupport: 'optional',
      });
      const legacy = await client.callTool({ name: call.name, arguments: call.arguments });
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

  it('recovers a revision-pinned comparison from artifacts after a fresh engine and server', async () => {
    const { source, createEngine, connect } = await fixture();
    const firstEngine = await createEngine();
    const first = await connect(firstEngine);
    const scan = serviceResult(
      await first.client.callTool({
        name: 'hoi4.tech_inspect',
        arguments: { workspaceId: 'test', mode: 'scan' },
      }),
    );
    expect(scan.status).toBe('ok');
    expect(scan.artifacts.map(({ name }) => name)).toContain(
      `technology-graph-${String(scan.data.revision)}.json`,
    );
    await first.close();

    const changed = sourceText('task_technology_gamma');
    await writeFile(source, changed);
    const secondEngine = await createEngine();
    const second = await connect(secondEngine);
    const comparison = serviceResult(
      await second.client.callTool({
        name: 'hoi4.tech_compare',
        arguments: {
          workspaceId: 'test',
          before: { revision: scan.data.revision },
          render: false,
        },
      }),
    );
    expect(comparison.status).toBe('ok');
    expect(comparison.code).toBe('TECH_COMPARED');
    expect(comparison.data).toMatchObject({
      beforeRevision: scan.data.revision,
      added: 1,
      removed: 1,
    });
    expect(comparison.data.afterRevision).not.toBe(scan.data.revision);
    expect(await readFile(source, 'utf8')).toBe(changed);
  });
});
