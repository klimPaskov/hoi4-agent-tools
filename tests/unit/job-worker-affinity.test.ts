import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import {
  JobWorkerHost,
  WORKSPACE_WORKER_WAIT_MS,
} from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import type { SharedCapacityLease } from '../../src/hoi4_agent_tools/core/shared-request-capacity.js';

// Decision D-98 (issue #137): the call after a rewrite reads the index that rewrite built, which
// lives in the worker that ran it.

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(workspaceIds: readonly string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-affinity-'));
  roots.push(root);
  const workspaces = [];
  for (const id of workspaceIds) {
    const mod = path.join(root, id);
    await mkdir(mod);
    workspaces.push({ id, name: `Affinity fixture ${id}`, root: mod });
  }
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        jobWorkerIdleSeconds: 30,
        workspaces,
      }),
    ),
  );
  const jobs = await JobService.create(engine.resolver);
  const host = await JobWorkerHost.create(engine, jobs);
  return { engine, jobs, host };
}

interface HostInternals {
  idleWorkers: ChildProcess[];
  workspaceWorkers: Map<string, { child: ChildProcess; mutation: boolean }>;
  takeIdleWorker(workspaceId?: string): ChildProcess | undefined;
  awaitWorkspaceWorker(workspaceId: string, limitMs: number): Promise<boolean>;
  keepWarm(child: ChildProcess, lease: SharedCapacityLease): Promise<void>;
  reportedIdle: WeakSet<ChildProcess>;
}

/** A stand-in for a running worker process: connected, with a pid, never spawned. */
function fakeWorker(pid: number): ChildProcess & { disconnected: boolean } {
  const child = new EventEmitter() as unknown as ChildProcess & { disconnected: boolean };
  Object.assign(child, {
    pid,
    connected: true,
    exitCode: null,
    signalCode: null,
    disconnected: false,
    channel: { ref: () => undefined, unref: () => undefined },
    ref: () => undefined,
    unref: () => undefined,
    disconnect() {
      Object.assign(child, { connected: false, disconnected: true });
    },
  });
  return child;
}

const lease: SharedCapacityLease = {
  handoffToProcess: () => Promise.resolve(),
  reclaimFromProcess: () => Promise.resolve(),
} as unknown as SharedCapacityLease;

describe('worker affinity after a rewrite (D-98)', () => {
  it('takes the idle worker that ran the workspace last, not the most recently used one', async () => {
    const { host } = await fixture(['first']);
    const internals = host as unknown as HostInternals;
    const holder = fakeWorker(101);
    const other = fakeWorker(102);
    internals.workspaceWorkers.set('first', { child: holder, mutation: true });
    // The other worker ran a later call on another workspace, so it is the last one parked.
    internals.idleWorkers.push(holder, other);
    expect(internals.takeIdleWorker('first')).toBe(holder);
    expect(internals.idleWorkers).toEqual([other]);
    // A workspace with no recorded worker takes the most recently used one, as before.
    internals.idleWorkers.push(holder);
    expect(internals.takeIdleWorker('second')).toBe(holder);
  });

  it('skips a recorded worker that has stopped and takes another idle one', async () => {
    const { host } = await fixture(['first']);
    const internals = host as unknown as HostInternals;
    const stopped = fakeWorker(103);
    const other = fakeWorker(104);
    Object.assign(stopped, { exitCode: 1, connected: false });
    internals.workspaceWorkers.set('first', { child: stopped, mutation: true });
    internals.idleWorkers.push(other, stopped);
    expect(internals.takeIdleWorker('first')).toBe(other);
    expect(internals.idleWorkers).toEqual([]);
  });

  it('waits for a busy rewrite worker until it is parked, then hands it to the next job', async () => {
    const { host } = await fixture(['first']);
    const internals = host as unknown as HostInternals;
    const holder = fakeWorker(105);
    const later = fakeWorker(106);
    internals.workspaceWorkers.set('first', { child: holder, mutation: true });
    const waited = internals.awaitWorkspaceWorker('first', WORKSPACE_WORKER_WAIT_MS);
    let settled: boolean | undefined;
    void waited.then((idle) => (settled = idle));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    // Another worker is parked meanwhile; it must not wake the waiting job.
    internals.reportedIdle.add(later);
    await internals.keepWarm(later, lease);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    internals.reportedIdle.add(holder);
    await internals.keepWarm(holder, lease);
    await expect(waited).resolves.toBe(true);
    expect(internals.takeIdleWorker('first')).toBe(holder);
  });

  it('stops waiting at the bound, on exit, and when the worker is not kept warm', async () => {
    vi.useFakeTimers();
    const { host } = await fixture(['first']);
    const internals = host as unknown as HostInternals;
    const slow = fakeWorker(107);
    internals.workspaceWorkers.set('first', { child: slow, mutation: true });
    const bounded = internals.awaitWorkspaceWorker('first', WORKSPACE_WORKER_WAIT_MS);
    await vi.advanceTimersByTimeAsync(WORKSPACE_WORKER_WAIT_MS - 1);
    let settled: boolean | undefined;
    void bounded.then((idle) => (settled = idle));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(bounded).resolves.toBe(false);

    const exited = internals.awaitWorkspaceWorker('first', WORKSPACE_WORKER_WAIT_MS);
    slow.emit('exit', 1, null);
    await expect(exited).resolves.toBe(false);

    // A worker that never reports idle is disconnected instead of parked; the job goes on.
    const unparked = internals.awaitWorkspaceWorker('first', WORKSPACE_WORKER_WAIT_MS);
    const parking = internals.keepWarm(slow, lease);
    await vi.advanceTimersByTimeAsync(10_000);
    await parking;
    await expect(unparked).resolves.toBe(false);
    expect(slow.disconnected).toBe(true);
    expect(internals.idleWorkers).toEqual([]);
  });

  it('does not wait for a busy worker whose last job is a read, which may run for minutes', async () => {
    vi.useFakeTimers();
    const { host } = await fixture(['first']);
    const internals = host as unknown as HostInternals;
    internals.workspaceWorkers.set('first', { child: fakeWorker(108), mutation: false });
    await expect(internals.awaitWorkspaceWorker('first', WORKSPACE_WORKER_WAIT_MS)).resolves.toBe(
      false,
    );
    await expect(internals.awaitWorkspaceWorker('unknown', WORKSPACE_WORKER_WAIT_MS)).resolves.toBe(
      false,
    );
  });

  it('runs the next job of a workspace on the worker that ran its last job', async () => {
    const { jobs, host } = await fixture(['first', 'second']);
    const submit = async (workspaceId: string) =>
      (
        await jobs.submit(workspaceId, {
          toolName: 'hoi4.event_inspect',
          arguments: { workspaceId, mode: 'lint' },
          mutation: false,
        })
      ).record;
    const ownerPid = async (workspaceId: string) => {
      const record = await submit(workspaceId);
      const done = await host.run(workspaceId, record.id);
      expect(done).toMatchObject({ status: 'completed' });
      return done.owner?.pid;
    };
    // Two jobs at once start two warm workers, one per workspace.
    const [first, second] = await Promise.all([submit('first'), submit('second')]);
    const [firstDone, secondDone] = await Promise.all([
      host.run('first', first.id),
      host.run('second', second.id),
    ]);
    const firstPid = firstDone.owner?.pid;
    const secondPid = secondDone.owner?.pid;
    expect(firstPid).toBeDefined();
    expect(secondPid).toBeDefined();
    expect(firstPid).not.toBe(secondPid);
    // Without affinity both calls below would take the most recently parked worker.
    expect(await ownerPid('second')).toBe(secondPid);
    expect(await ownerPid('first')).toBe(firstPid);
    const internals = host as unknown as HostInternals;
    for (const child of internals.idleWorkers) child.kill();
  }, 120_000);
});
