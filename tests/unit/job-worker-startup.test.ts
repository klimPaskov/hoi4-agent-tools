import { spawn } from 'node:child_process';
import type * as ChildProcesses from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { currentJobOwner } from '../../src/hoi4_agent_tools/core/job-store.js';
import type { SharedRequestCapacity } from '../../src/hoi4_agent_tools/core/shared-request-capacity.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const { spawn: actualSpawn } = await vi.importActual<typeof ChildProcesses>('node:child_process');
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(spawn).mockReset().mockImplementation(actualSpawn);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('worker startup failure boundaries', () => {
  it.each(['EBUSY', 'EPERM', 'PRIVATE_SOURCE_TOKEN'])(
    'reports only recognized native coordination codes without exposing error text: %s',
    async (code) => {
      const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-native-failure-'));
      roots.push(root);
      const mod = path.join(root, 'mod');
      await mkdir(mod);
      const engine = new CoreEngine(
        await WorkspaceResolver.create(
          serverConfigurationSchema.parse({
            version: 1,
            serverStateRoot: path.join(root, 'state'),
            workspaces: [{ id: 'test', name: 'Native failure fixture', root: mod }],
          }),
        ),
      );
      await engine.persistentAnalysisCache;
      const jobs = await JobService.create(engine.resolver);
      const record = (
        await jobs.submit('test', {
          toolName: 'hoi4.event_inspect',
          arguments: { workspaceId: 'test', mode: 'lint' },
          mutation: false,
        })
      ).record;
      const host = await JobWorkerHost.create(engine, jobs);
      const capacity = (host as unknown as { capacity: SharedRequestCapacity }).capacity;
      const capacityRun = vi
        .spyOn(capacity, 'run')
        .mockRejectedValue(Object.assign(new Error('private-path-and-source-sentinel'), { code }));
      try {
        const failed = await host.run('test', record.id);
        expect(failed).toMatchObject({
          status: 'failed',
          failure: {
            code: code === 'PRIVATE_SOURCE_TOKEN' ? 'JOB_WORKER_FAILED' : `JOB_WORKER_${code}`,
          },
        });
        expect(failed.failure?.message).toContain('stage admission');
        expect(JSON.stringify(failed.failure)).not.toContain('private-path-and-source-sentinel');
        expect(JSON.stringify(failed.failure)).not.toContain('PRIVATE_SOURCE_TOKEN');
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        capacityRun.mockRestore();
      }
    },
  );

  it('retries a lost pre-dispatch lease without executing the job twice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-handoff-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaces: [{ id: 'test', name: 'Synthetic worker handoff', root: mod }],
        }),
      ),
    );
    await engine.persistentAnalysisCache;
    const jobs = await JobService.create(engine.resolver);
    const record = (
      await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        arguments: { workspaceId: 'test', mode: 'lint' },
        mutation: false,
      })
    ).record;
    const host = await JobWorkerHost.create(engine, jobs);
    const workerCapacity = (host as unknown as { capacity: SharedRequestCapacity }).capacity;
    const capacityRun = vi.spyOn(workerCapacity, 'run');
    capacityRun.mockRejectedValueOnce(
      new ServiceError('REQUEST_LEASE_HANDOFF_LOST', 'Injected pre-dispatch lease loss'),
    );
    try {
      await expect(host.run('test', record.id)).resolves.toMatchObject({ status: 'completed' });
      expect(capacityRun).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      capacityRun.mockRestore();
    }
  }, 30_000);

  it('bounds repeated lost-lease admission without starting a worker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-handoff-failed-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          workspaces: [{ id: 'test', name: 'Synthetic failed handoff', root: mod }],
        }),
      ),
    );
    await engine.persistentAnalysisCache;
    const jobs = await JobService.create(engine.resolver);
    const record = (
      await jobs.submit('test', {
        toolName: 'hoi4.event_inspect',
        arguments: { workspaceId: 'test', mode: 'lint' },
        mutation: false,
      })
    ).record;
    const host = await JobWorkerHost.create(engine, jobs);
    const workerCapacity = (host as unknown as { capacity: SharedRequestCapacity }).capacity;
    const capacityRun = vi.spyOn(workerCapacity, 'run');
    capacityRun.mockRejectedValue(
      new ServiceError('REQUEST_LEASE_HANDOFF_LOST', 'Injected persistent lease loss'),
    );
    try {
      await expect(host.run('test', record.id)).resolves.toMatchObject({
        status: 'failed',
        failure: { code: 'REQUEST_LEASE_HANDOFF_LOST' },
      });
      expect(capacityRun).toHaveBeenCalledTimes(3);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      capacityRun.mockRestore();
    }
  }, 30_000);

  it.each([false, true])(
    'settles a stopped worker without hanging, handshake completed=%s',
    async (ready) => {
      const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-startup-'));
      roots.push(root);
      const mod = path.join(root, 'mod');
      await mkdir(mod);
      const engine = new CoreEngine(
        await WorkspaceResolver.create(
          serverConfigurationSchema.parse({
            version: 1,
            serverStateRoot: path.join(root, 'state'),
            // The cold path: each job gets its own worker, which exits on disconnect.
            jobWorkerIdleSeconds: 0,
            workspaces: [{ id: 'test', name: 'Synthetic worker startup', root: mod }],
          }),
        ),
      );
      await engine.persistentAnalysisCache;
      const jobs = await JobService.create(engine.resolver);
      const record = (
        await jobs.submit('test', {
          toolName: 'hoi4.event_inspect',
          arguments: { workspaceId: 'test', mode: 'lint' },
          mutation: false,
        })
      ).record;
      if (ready) {
        const previous = actualSpawn(process.execPath, ['-e', ''], {
          stdio: 'ignore',
          windowsHide: true,
        });
        await once(previous, 'spawn');
        const pid = previous.pid!;
        await once(previous, 'close');
        await jobs.store.claim(jobs.scope('test'), record.id, { ...currentJobOwner(), pid });
      }
      const script = ready
        ? 'let accepted = false; process.once("message", () => setTimeout(() => { accepted = true; process.send({ type: "accepted" }); }, 50)); process.once("disconnect", () => process.exit(accepted ? 1 : 2)); process.send({ type: "ready" });'
        : 'process.exit(1);';
      // Fault injection exists only in this test's spawn boundary. The production host
      // still chooses its fixed internal entry point and accepts no executable selector.
      let exitCode: number | null | undefined;
      vi.mocked(spawn).mockImplementation((_command, _arguments, options) => {
        const child = actualSpawn(process.execPath, ['-e', script], options);
        child.once('exit', (code) => {
          exitCode = code;
        });
        return child;
      });
      const host = await JobWorkerHost.create(engine, jobs);
      await expect(host.run('test', record.id)).resolves.toMatchObject({
        status: 'failed',
        failure: { code: ready ? 'JOB_WORKER_EXIT' : 'JOB_WORKER_STARTUP_EXIT' },
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(1);
      expect(vi.mocked(spawn).mock.calls[0]![1]).toContainEqual(
        expect.stringMatching(/job-worker\.ts$/u),
      );
    },
    15_000,
  );
  it('reuses a warm worker for the next job and releases its capacity while idle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-warm-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          jobWorkerIdleSeconds: 30,
          workspaces: [{ id: 'test', name: 'Warm worker fixture', root: mod }],
        }),
      ),
    );
    await engine.persistentAnalysisCache;
    const jobs = await JobService.create(engine.resolver);
    const host = await JobWorkerHost.create(engine, jobs);
    const submit = async () =>
      (
        await jobs.submit('test', {
          toolName: 'hoi4.event_inspect',
          arguments: { workspaceId: 'test', mode: 'lint' },
          mutation: false,
        })
      ).record;
    const first = await submit();
    await expect(host.run('test', first.id)).resolves.toMatchObject({ status: 'completed' });
    const second = await submit();
    await expect(host.run('test', second.id)).resolves.toMatchObject({ status: 'completed' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const idle = (host as unknown as { idleWorkers: Array<{ pid?: number; kill(): boolean }> })
      .idleWorkers;
    expect(idle).toHaveLength(1);
    // An idle warm worker holds no capacity slot, so a full set of slots stays available.
    const capacity = (host as unknown as { capacity: SharedRequestCapacity }).capacity;
    await expect(
      Promise.all(
        Array.from({ length: 4 }, () =>
          capacity.run(new AbortController().signal, () => Promise.resolve(true)),
        ),
      ),
    ).resolves.toEqual([true, true, true, true]);
    for (const child of idle) child.kill();
  }, 60_000);
});
