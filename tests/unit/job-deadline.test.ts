import { spawn } from 'node:child_process';
import type * as ChildProcesses from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { currentJobOwner, jobOwnerLiveness } from '../../src/hoi4_agent_tools/core/job-store.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const { spawn: actualSpawn } = await vi.importActual<typeof ChildProcesses>('node:child_process');
const roots: string[] = [];
const children: ChildProcesses.ChildProcess[] = [];
afterEach(async () => {
  vi.mocked(spawn).mockReset().mockImplementation(actualSpawn);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

// A worker that accepts its job and then blocks its event loop, so it can never observe its
// own cancellation. This stands in for synchronous analysis that does not yield.
const stuckWorker =
  'process.once("message", () => { process.send({ type: "accepted" }, () => { const end = Date.now() + 600000; while (Date.now() < end) {} }); }); process.send({ type: "ready" });';

async function setup(limits: { jobDeadlineSeconds: number; jobCancelGraceSeconds: number }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-job-deadline-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        ...limits,
        workspaces: [{ id: 'test', name: 'Deadline fixture', root: mod }],
      }),
    ),
  );
  await engine.persistentAnalysisCache;
  const jobs = await JobService.create(engine.resolver);
  const record = (
    await jobs.submit('test', {
      toolName: 'hoi4.event_inspect',
      arguments: { workspaceId: 'test', mode: 'scan' },
      mutation: false,
    })
  ).record;
  // The fake worker claims the job the way a real worker does before it blocks.
  vi.mocked(spawn).mockImplementation((_command, _arguments, options) => {
    const child = actualSpawn(process.execPath, ['-e', stuckWorker], options);
    children.push(child);
    child.once('spawn', () => {
      void jobs.store.claim(jobs.scope('test'), record.id, {
        ...currentJobOwner(),
        pid: child.pid!,
      });
    });
    return child;
  });
  return { jobs, record, host: await JobWorkerHost.create(engine, jobs) };
}

describe('supervised job deadlines and cancellation', () => {
  it('stops a read-only worker that outlives its deadline and reports why', async () => {
    const { host, record } = await setup({ jobDeadlineSeconds: 2, jobCancelGraceSeconds: 600 });
    const started = Date.now();
    const settled = await host.run('test', record.id);
    expect(settled).toMatchObject({
      status: 'failed',
      failure: { code: 'JOB_DEADLINE_EXCEEDED' },
    });
    expect(Date.now() - started).toBeLessThan(30_000);
    const child = children[0]!;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(jobOwnerLiveness({ ...currentJobOwner(), pid: child.pid! })).toBe('dead');
  }, 60_000);

  it('stops a worker that ignores cancellation after the grace period', async () => {
    const { host, jobs, record } = await setup({
      jobDeadlineSeconds: 3_600,
      jobCancelGraceSeconds: 1,
    });
    const running = host.run('test', record.id);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await jobs.get('test', record.id)).status === 'running') break;
      await delay(100);
    }
    const cancelledAt = Date.now();
    await jobs.cancel('test', record.id);
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(Date.now() - cancelledAt).toBeLessThan(20_000);
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
  }, 60_000);
});
