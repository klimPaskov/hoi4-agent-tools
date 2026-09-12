import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobExecutor, JobOperations } from '../../src/hoi4_agent_tools/core/job-executor.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { SharedRequestCapacity } from '../../src/hoi4_agent_tools/core/shared-request-capacity.js';
import type { JobRequest } from '../../src/hoi4_agent_tools/core/job-store.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { registerEventJobs } from '../../src/hoi4_agent_tools/event/job-operations.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-event-job-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'events'), { recursive: true });
  const source = path.join(mod, 'events', 'synthetic.txt');
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
        workspaces: [{ id: 'test', name: 'Synthetic event job', root: mod }],
      }),
    ),
  );
  const jobs = await JobService.create(engine.resolver);
  const operations = new JobOperations();
  registerEventJobs(operations, engine);
  const executor = new JobExecutor(engine, jobs, operations);
  const server = createMcpServer(engine);
  const client = new Client({ name: 'event-job-equivalence', version: '1.0.0' });
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { jobs, executor, client, source, engine };
}

function stopOwnedProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

describe('production event inspection jobs', () => {
  it('inspects, cancels, and retrieves durable results through compatibility tools', async () => {
    const { jobs, executor, client, engine } = await fixture();
    const input = { workspaceId: 'test', mode: 'roots' };
    const active = (
      await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        mutation: false,
        arguments: input,
        requestKey: 'compat-active',
      })
    ).record;
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, async () => {
      admitted();
      await held;
    });
    await ready;
    try {
      const status = await client.callTool(
        {
          name: 'hoi4.job_inspect',
          arguments: { workspaceId: 'test', jobId: active.id },
        },
        undefined,
        { timeout: 2_000 },
      );
      expect(status).toMatchObject({
        structuredContent: {
          code: 'JOB_STATUS',
          data: { jobId: active.id, status: 'queued', resultReady: false },
        },
      });
      const cancelled = await client.callTool(
        {
          name: 'hoi4.job_cancel',
          arguments: { workspaceId: 'test', jobId: active.id },
        },
        undefined,
        { timeout: 2_000 },
      );
      expect(cancelled).toMatchObject({
        structuredContent: {
          code: 'JOB_CANCELLED',
          data: { jobId: active.id, status: 'cancelled', cancelRequested: true },
        },
      });
    } finally {
      release();
      await capacity;
    }

    const completedJob = (
      await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        mutation: false,
        arguments: input,
        requestKey: 'compat-result',
      })
    ).record;
    const completed = await executor.run('test', completedJob.id);
    const retrieved = await client.callTool({
      name: 'hoi4.job_inspect',
      arguments: { workspaceId: 'test', jobId: completedJob.id },
    });
    expect(retrieved.content).toEqual((completed.result as { content: unknown }).content);
    expect(retrieved.structuredContent).toEqual(
      (completed.result as { structuredContent: unknown }).structuredContent,
    );
    expect(retrieved._meta).toMatchObject({
      'io.github.klimPaskov/hoi4-agent-tools/job': {
        jobId: completedJob.id,
        status: 'completed',
      },
    });
  });
  it('finishes a persisted job after its real launcher exits while execution is queued', async () => {
    const { engine, jobs, client, source } = await fixture();
    const original = await readFile(source);
    const input = { workspaceId: 'test', mode: 'roots' };
    const foreground = await client.callTool({ name: 'hoi4.event_inspect', arguments: input });
    const { record } = await jobs.submit('test', {
      toolName: 'hoi4.event_inspect',
      mutation: false,
      arguments: input,
      requestKey: 'launcher-exit',
    });
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, async () => {
      admitted();
      await held;
    });
    await ready;
    const launcher = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../fixtures/job-launcher.ts', import.meta.url)),
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
    );
    let workerPid: number | undefined;
    try {
      await once(launcher, 'spawn');
      launcher.send({
        configuration: engine.resolver.config(),
        workspaceId: 'test',
        jobId: record.id,
      });
      await vi.waitFor(
        async () => {
          const current = await jobs.get('test', record.id);
          expect(current.status).toBe('running');
          expect(current.owner?.pid).toBeGreaterThan(0);
          workerPid = current.owner!.pid;
        },
        { timeout: 15_000, interval: 50 },
      );
      expect(workerPid).not.toBe(launcher.pid);
      const stopped = once(launcher, 'close');
      launcher.kill();
      await stopped;
      expect(() => process.kill(workerPid!, 0)).not.toThrow();
      const workerCapacity = new SharedRequestCapacity(
        path.join(engine.resolver.serverState()!.root, 'job-workers'),
        1,
      );
      await expect(
        workerCapacity.run(AbortSignal.timeout(250), async () => 'unexpected'),
      ).rejects.toThrow();
      release();
      await capacity;
      await vi.waitFor(
        async () => {
          expect((await jobs.get('test', record.id)).status).toBe('completed');
        },
        { timeout: 15_000, interval: 50 },
      );
      expect((await jobs.get('test', record.id)).result).toEqual(
        JSON.parse(JSON.stringify(foreground)),
      );
      await vi.waitFor(
        () => {
          expect(() => process.kill(workerPid!, 0)).toThrow();
        },
        { timeout: 5000, interval: 50 },
      );
      expect(await workerCapacity.run(AbortSignal.timeout(5000), async () => 'reclaimed')).toBe(
        'reclaimed',
      );
      expect(await readFile(source)).toEqual(original);
    } finally {
      release();
      await capacity;
      if (launcher.exitCode === null && launcher.signalCode === null) {
        const stopped = once(launcher, 'close');
        launcher.kill();
        await stopped;
      }
      // Only the child created for this isolated fixture is eligible for failure cleanup.
      if (workerPid !== undefined) stopOwnedProcess(workerPid);
    }
  });
  it.each(['hoi4.event_inspect', 'hoi4.event_render', 'hoi4.event_compare'] as const)(
    'executes %s in a distinct process and retrieves its persisted result',
    async (toolName) => {
      const { engine, jobs, client, source } = await fixture();
      const before = await readFile(source);
      const input: JobRequest['arguments'] = {
        workspaceId: 'test',
        ...(toolName === 'hoi4.event_inspect' ? { mode: 'roots' } : {}),
        ...(toolName === 'hoi4.event_render' ? { view: 'overview', includeHtml: true } : {}),
        ...(toolName === 'hoi4.event_compare'
          ? {
              render: true,
              proposedSources: [
                {
                  relativePath: 'events/synthetic.txt',
                  source:
                    before.toString('utf8') +
                    'country_event = { id = synthetic.2 is_triggered_only = yes option = { name = synthetic.2.a } }\n',
                },
              ],
            }
          : {}),
      };
      const foreground = await client.callTool({ name: toolName, arguments: input });
      const { record } = await jobs.submit('test', {
        toolName,
        arguments: input,
        mutation: false,
        requestKey: 'worker-roots',
      });
      const host = await JobWorkerHost.create(engine);
      const completed = await host.run('test', record.id);
      expect(completed.status).toBe('completed');
      expect(completed.owner?.pid).toBeGreaterThan(0);
      expect(completed.owner?.pid).not.toBe(process.pid);
      expect(completed.result).toEqual(JSON.parse(JSON.stringify(foreground)));
      expect(await host.run('test', record.id)).toEqual(completed);
      expect(await readFile(source)).toEqual(before);
    },
  );
  it.each([
    'overview',
    'neighborhood',
    'options',
    'entries',
    'reachability',
    'timing',
    'state',
    'targets',
    'scope',
    'terminals',
    'unresolved',
  ] as const)('preserves foreground %s render hashes and linked artifacts', async (view) => {
    const { jobs, executor, client, source } = await fixture();
    const before = await readFile(source);
    const input = {
      workspaceId: 'test',
      view,
      selector: { kind: 'event', eventId: 'synthetic.1' },
      includeHtml: true,
    };
    const foreground = await client.callTool({ name: 'hoi4.event_render', arguments: input });
    expect(foreground.isError).not.toBe(true);
    const { record } = await jobs.submit('test', {
      toolName: 'hoi4.event_render',
      arguments: input,
      mutation: false,
    });
    const completed = await executor.run('test', record.id);
    expect(completed.failure).toBeUndefined();
    expect(completed.result).toEqual(JSON.parse(JSON.stringify(foreground)));
    expect(completed.result).toMatchObject({
      structuredContent: {
        data: { view, hashes: { svg: expect.any(String), png: expect.any(String) } },
      },
    });
    expect(await readFile(source)).toEqual(before);
  });

  it.each([false, true])(
    'preserves foreground overlay comparison with render=%s without source writes',
    async (render) => {
      const { jobs, executor, client, source } = await fixture();
      const before = await readFile(source);
      const proposed =
        before.toString('utf8') +
        'country_event = { id = synthetic.2 is_triggered_only = yes option = { name = synthetic.2.a } }\n';
      const input = {
        workspaceId: 'test',
        render,
        proposedSources: [{ relativePath: 'events/synthetic.txt', source: proposed }],
      };
      const foreground = await client.callTool({ name: 'hoi4.event_compare', arguments: input });
      expect(foreground.isError).not.toBe(true);
      const { record } = await jobs.submit('test', {
        toolName: 'hoi4.event_compare',
        arguments: input,
        mutation: false,
      });
      const completed = await executor.run('test', record.id);
      expect(completed.failure).toBeUndefined();
      expect(completed.result).toEqual(JSON.parse(JSON.stringify(foreground)));
      const structured = completed.result?.structuredContent as {
        data: { counts: { addedNodes: number } };
      };
      expect(structured.data.counts.addedNodes).toBeGreaterThan(0);
      expect(await readFile(source)).toEqual(before);
    },
  );
  it.each(['roots', 'scan', 'trace', 'explain_path', 'state_flow', 'lint', 'impact'] as const)(
    'preserves the complete foreground %s result and source bytes through typed job execution',
    async (mode) => {
      const { jobs, executor, client, source } = await fixture();
      const before = await readFile(source);
      const input: JobRequest['arguments'] = {
        workspaceId: 'test',
        mode,
        ...(mode === 'trace' ? { selector: { kind: 'event', eventId: 'synthetic.1' } } : {}),
        ...(mode === 'explain_path'
          ? {
              from: { kind: 'event', eventId: 'synthetic.1' },
              to: { kind: 'event', eventId: 'synthetic.1' },
            }
          : {}),
        ...(mode === 'impact' ? { impactSubject: { kind: 'event', name: 'synthetic.1' } } : {}),
      };
      const foreground = await client.callTool({ name: 'hoi4.event_inspect', arguments: input });
      const { record } = await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        arguments: input,
        mutation: false,
        requestKey: 'event-roots',
      });
      const completed = await executor.run('test', record.id);
      expect(completed.failure).toBeUndefined();
      expect(completed.status).toBe('completed');
      expect(completed.result).toEqual(JSON.parse(JSON.stringify(foreground)));
      expect(completed.result).toMatchObject({
        structuredContent: {
          code:
            mode === 'trace' || mode === 'explain_path'
              ? 'EVENT_INSPECTED_PARTIAL'
              : 'EVENT_INSPECTED',
          data: { mode, counts: { events: 1 } },
        },
      });
      expect(await readFile(source)).toEqual(before);
    },
  );

  it('retains tool-error semantics while refusing an argument workspace outside the job scope', async () => {
    const { jobs, executor, source } = await fixture();
    const before = await readFile(source);
    const { record } = await jobs.submit('test', {
      toolName: 'hoi4.event_inspect',
      arguments: { workspaceId: 'other', mode: 'roots' },
      mutation: false,
    });
    expect(await executor.run('test', record.id)).toMatchObject({
      status: 'completed',
      result: { isError: true, structuredContent: { code: 'JOB_ARGUMENT_SCOPE_MISMATCH' } },
    });
    expect(await readFile(source)).toEqual(before);
  });
});
