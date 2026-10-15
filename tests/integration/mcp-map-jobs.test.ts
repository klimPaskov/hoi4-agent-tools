import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture(emptyMod = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-map-task-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = path.resolve('fixtures', 'map', 'roots');
  for (const kind of ['mod', 'game', 'dependency']) {
    if (kind === 'mod' && emptyMod) {
      await mkdir(path.join(root, kind, 'map'), { recursive: true });
      await writeFile(
        path.join(root, kind, 'descriptor.mod'),
        'name="Synthetic reference world"\n',
      );
    } else await cp(path.join(fixtureRoot, kind), path.join(root, kind), { recursive: true });
  }
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
            name: 'Map native task fixture',
            root: path.join(root, 'mod'),
            gameRoot: path.join(root, 'game'),
            dependencyRoots: [path.join(root, 'dependency')],
            artifactRoot: path.join(runtimeRoot, 'artifacts'),
            cacheRoot: path.join(runtimeRoot, 'cache'),
          },
        ],
      }),
    ),
  );
  await engine.initialize();
  const server = createMcpServer(engine);
  const client = new Client({ name: 'map-task-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const source = path.join(root, 'mod', 'map', 'default.map');
  const stateSource = path.join(root, 'mod', 'history', 'states', '5-MOD.txt');
  return { client, engine, source, stateSource, modRoot: path.join(root, 'mod') };
}

async function sourceInventory(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [relative, content] of Object.entries(await sourceInventory(target)))
        files[`${entry.name}/${relative}`] = content;
    } else if (entry.isFile()) files[entry.name] = (await readFile(target)).toString('base64');
  }
  return files;
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

describe('map jobs and negotiated native tasks', () => {
  it('previews a synthetic reference world without source changes or a write transaction', async () => {
    const { client, engine, modRoot } = await fixture(true);
    const png = await sharp({
      create: { width: 512, height: 256, channels: 3, background: '#2b6ba0' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="512" height="256"><ellipse cx="230" cy="120" rx="140" ry="80" fill="#91aa60"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    await writeFile(path.join(modRoot, 'map', 'synthetic-reference.png'), png);
    const original = await sourceInventory(modRoot);
    const input = {
      workspaceId: 'test',
      preview: true,
      operations: [
        {
          kind: 'create_world',
          reference: { imagePath: 'map/synthetic-reference.png' },
          width: 512,
          height: 256,
          seed: 3,
          countries: [{ tag: 'AUR', name: 'Aurelia' }],
        },
      ],
    };
    const ordinary = await client.callTool({ name: 'hoi4.map_rewrite', arguments: input });
    expect(ordinary.structuredContent).toMatchObject({
      status: 'ok',
      code: 'MAP_PREVIEW_READY',
      changedFiles: [],
      data: {
        execution: 'preview',
        preview: { offlineRepresentation: true, width: 512, height: 256, countries: 1 },
      },
    });
    const preview = await completedTask(client, 'hoi4.map_rewrite', {
      ...input,
      requestKey: 'synthetic-reference-preview',
    });
    expect(preview.result.structuredContent).toEqual(ordinary.structuredContent);
    const publicResult = preview.result.structuredContent as {
      artifacts: Array<{ name: string; mimeType: string }>;
    };
    expect(publicResult.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'map-world-preview.png', mimeType: 'image/png' }),
      ]),
    );
    expect(await sourceInventory(modRoot)).toEqual(original);
    const jobs = await JobService.create(engine.resolver);
    const separator = preview.taskId.indexOf(':');
    const record = await jobs.get('test', preview.taskId.slice(separator + 1));
    expect(record.transaction).toBeUndefined();
    expect(record.writeRecipe).toBeUndefined();
    expect(JSON.stringify(preview.result.structuredContent)).not.toMatch(/transactionId|planHash/u);
  }, 90_000);

  it('returns blocked previews without applying any of their proposed edits', async () => {
    const { client, modRoot } = await fixture();
    const original = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [
          { id: 'missing-state', kind: 'update_state', stateId: 9999, changes: { manpower: 12 } },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      code: 'MAP_PREVIEW_BLOCKED',
      changedFiles: [],
      data: { execution: 'preview' },
    });
    expect(await sourceInventory(modRoot)).toEqual(original);
  });

  it('omits generated world evidence when generation rolls back to the existing map', async () => {
    const { client, modRoot } = await fixture();
    const original = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [
          {
            id: 'failed-world',
            kind: 'create_world',
            width: 256,
            height: 256,
            countries: [
              { tag: 'AUR', name: 'Aurelia' },
              { tag: 'AUR', name: 'Duplicate' },
            ],
          },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      code: 'MAP_PREVIEW_BLOCKED',
      changedFiles: [],
      data: {
        execution: 'preview',
        changedProvinceCount: 0,
        operationBlockers: [
          expect.objectContaining({
            code: 'MAP_WORLD_COUNTRY_TAG_INVALID',
            operationId: 'failed-world',
          }),
        ],
      },
    });
    const publicResult = result.structuredContent as {
      data: Record<string, unknown>;
      artifacts: Array<{ name: string }>;
    };
    expect(publicResult.data).not.toHaveProperty('preview');
    expect(publicResult.artifacts.some(({ name }) => name.startsWith('map-world-'))).toBe(false);
    expect(publicResult.artifacts.some(({ name }) => name.endsWith('.png'))).toBe(false);
    expect(publicResult.artifacts.some(({ name }) => name === 'map-generation-failure.json')).toBe(
      true,
    );
    expect(await sourceInventory(modRoot)).toEqual(original);
  });

  it('retains actual generated world evidence when later validation blocks the rewrite', async () => {
    const { client, modRoot } = await fixture();
    const original = await sourceInventory(modRoot);
    const result = await client.callTool({
      name: 'hoi4.map_rewrite',
      arguments: {
        workspaceId: 'test',
        preview: true,
        operations: [
          {
            id: 'generated-world',
            kind: 'create_world',
            width: 512,
            height: 256,
            seed: 3,
            countries: [{ tag: 'AUR', name: 'Aurelia' }],
          },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      code: 'MAP_PREVIEW_BLOCKED',
      changedFiles: [],
      data: { execution: 'preview', operationBlockers: [], preview: { width: 512, height: 256 } },
    });
    const publicResult = result.structuredContent as { artifacts: Array<{ name: string }> };
    expect(publicResult.artifacts.some(({ name }) => name === 'map-world-preview.png')).toBe(true);
    expect(await sourceInventory(modRoot)).toEqual(original);
  });

  it('returns exact legacy payloads and publishes result-ready checkpoints', async () => {
    const { client, engine, source } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const original = await readFile(source);
    const calls = [
      {
        name: 'hoi4.map_inspect',
        arguments: { workspaceId: 'test', includeOverview: false, provinceIds: [1] },
      },
      {
        name: 'hoi4.map_inspect',
        arguments: { workspaceId: 'test', layer: 'province', scale: 1 },
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

  it('deduplicates native map rewrites and preserves ordinary-call output', async () => {
    const { client, engine, stateSource } = await fixture();
    const jobs = await JobService.create(engine.resolver);
    const original = await readFile(stateSource, 'utf8');
    expect(original).toContain('manpower = 50');
    const baseArguments = {
      workspaceId: 'test',
      operations: [
        {
          id: 'native-task-update-state',
          kind: 'update_state',
          stateId: 5,
          changes: { manpower: 60 },
        },
      ],
    };
    expect(
      (await client.listTools()).tools.find(({ name }) => name === 'hoi4.map_rewrite')?.execution,
    ).toEqual({ taskSupport: 'optional' });

    const ordinary = await client.callTool({ name: 'hoi4.map_rewrite', arguments: baseArguments });
    expect(ordinary.structuredContent).toMatchObject({
      status: 'ok',
      code: 'MAP_CHANGES_APPLIED',
      data: { execution: 'applied' },
    });
    await writeFile(stateSource, original, 'utf8');
    engine.invalidate('test');

    const taskArguments = { ...baseArguments, requestKey: 'map-rewrite-exactly-once' };
    const task = await completedTask(client, 'hoi4.map_rewrite', taskArguments);
    expect(task.result.content).toEqual(ordinary.content);
    expect(task.result.structuredContent).toEqual(ordinary.structuredContent);
    expect(task.result.isError).toBe(ordinary.isError);
    expect(await readFile(stateSource, 'utf8')).toContain('manpower = 60');

    const duplicate = await completedTask(client, 'hoi4.map_rewrite', taskArguments);
    expect(duplicate.taskId).toBe(task.taskId);
    const separator = task.taskId.indexOf(':');
    expect(await jobs.get('test', task.taskId.slice(separator + 1))).toMatchObject({
      status: 'completed',
      request: { mutation: true, requestKey: 'map-rewrite-exactly-once' },
      transaction: { transactionId: expect.stringMatching(/^txn_/u) },
      writeRecipe: { data: { changedProvinceCount: expect.any(Number) } },
    });

    await expect(
      completedTask(client, 'hoi4.map_rewrite', {
        ...taskArguments,
        operations: [
          {
            id: 'native-task-update-state',
            kind: 'update_state',
            stateId: 5,
            changes: { manpower: 70 },
          },
        ],
      }),
    ).rejects.toThrow();
  });
});
