import { spawn } from 'node:child_process';
import type * as ChildProcesses from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  classifyWorkerExit,
  defaultWorkerHeapMiB,
  type WorkerExitEvidence,
} from '../../src/hoi4_agent_tools/core/worker-exit.js';

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

function evidence(overrides: Partial<WorkerExitEvidence>): WorkerExitEvidence {
  return {
    code: 1,
    signal: null,
    stderrTail: '',
    stoppedByHost: false,
    heapLimitMiB: 4096,
    ...overrides,
  };
}

describe('worker exit classification', () => {
  it('names a V8 heap exhaustion with its limit and does not guess at memory otherwise', () => {
    const heap = classifyWorkerExit(
      evidence({
        code: 134,
        stderrTail:
          'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      }),
    );
    expect(heap.cause).toBe('heap_out_of_memory');
    expect(heap.message).toContain('4096 MiB');
    expect(heap.message).toContain('exit code 134');
    expect(classifyWorkerExit(evidence({ code: 1 })).cause).toBe('exited');
    expect(classifyWorkerExit(evidence({ code: 1 })).message).not.toMatch(/memory/iu);
  });

  it('separates native crashes, external termination, host stops and reported job errors', () => {
    expect(classifyWorkerExit(evidence({ code: 0xc0000005 })).cause).toBe('native_crash');
    expect(classifyWorkerExit(evidence({ code: -1073741819 })).cause).toBe('native_crash');
    expect(classifyWorkerExit(evidence({ code: null, signal: 'SIGSEGV' })).cause).toBe(
      'native_crash',
    );
    expect(classifyWorkerExit(evidence({ code: null, signal: 'SIGKILL' })).cause).toBe(
      'terminated_externally',
    );
    expect(
      classifyWorkerExit(evidence({ code: null, signal: 'SIGKILL', stoppedByHost: true })).cause,
    ).toBe('stopped_by_host');
    const reported = classifyWorkerExit(
      evidence({ stderrTail: 'worker-error: JOB_VERSION_MISMATCH\nstack with /private/path' }),
    );
    expect(reported.cause).toBe('uncaught_error');
    expect(reported.message).toContain('JOB_VERSION_MISMATCH');
    expect(reported.message).not.toContain('/private/path');
    expect(
      classifyWorkerExit(evidence({ stderrTail: 'Allocation failed - process out of memory' }))
        .cause,
    ).toBe('native_out_of_memory');
  });

  it('sizes the default worker heap from physical memory within fixed bounds', () => {
    const gib = 1024 ** 3;
    expect(defaultWorkerHeapMiB(4 * gib)).toBe(2048);
    expect(defaultWorkerHeapMiB(16 * gib)).toBe(4096);
    expect(defaultWorkerHeapMiB(32 * gib)).toBe(8192);
    expect(defaultWorkerHeapMiB(256 * gib)).toBe(8192);
  });
});

describe('worker exit reporting through the host', () => {
  async function hostFor(script: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-exit-'));
    roots.push(root);
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(root, 'state'),
          jobWorkerIdleSeconds: 0,
          jobWorkerMaxHeapMiB: 256,
          workspaces: [{ id: 'test', name: 'Worker exit fixture', root: mod }],
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
    // Fault injection exists only at this test's spawn boundary: the host still chooses the
    // heap flag and the standard-error redirection, and the script is a stand-in worker.
    const flags: string[] = [];
    vi.mocked(spawn).mockImplementation((_command, args, options) => {
      flags.push(...(args as string[]).filter((value) => value.startsWith('--max-old-space-size')));
      return actualSpawn(
        process.execPath,
        [...(args as string[]).filter((value) => value.startsWith('--max-')), '-e', script],
        options,
      );
    });
    return { host: await JobWorkerHost.create(engine, jobs), record, flags };
  }

  const handshake =
    'process.send({ type: "ready" }); process.once("message", () => { process.send({ type: "accepted" }); setTimeout(() => {';

  it('reports a real V8 heap exhaustion with the configured limit', async () => {
    const { host, record, flags } = await hostFor(
      `${handshake} const held = []; for (;;) held.push(new Array(1e6).fill(held.length)); }, 300); });`,
    );
    const failed = await host.run('test', record.id);
    expect(failed.failure?.code).toBe('JOB_WORKER_EXIT');
    expect(failed.failure?.message).toContain('V8 heap limit of 256 MiB');
    expect(flags).toEqual(['--max-old-space-size=256']);
  }, 60_000);

  it('does not blame memory when the worker reports an uncaught job error', async () => {
    const { host, record } = await hostFor(
      `${handshake} process.stderr.write("worker-error: JOB_VERSION_MISMATCH\\nstack\\n"); process.exit(1); }, 300); });`,
    );
    const failed = await host.run('test', record.id);
    expect(failed.failure?.code).toBe('JOB_WORKER_EXIT');
    expect(failed.failure?.message).toContain('JOB_VERSION_MISMATCH');
    expect(failed.failure?.message).not.toMatch(/run out of memory|V8 heap/iu);
  }, 30_000);

  it('reports an external kill by signal or exit status without guessing at memory', async () => {
    // 0xC0000005 is a Windows access violation; elsewhere a native crash arrives as SIGSEGV.
    const crash =
      process.platform === 'win32'
        ? 'process.exit(3221225477);'
        : "process.kill(process.pid, 'SIGSEGV');";
    const { host, record } = await hostFor(`${handshake} ${crash} }, 300); });`);
    const failed = await host.run('test', record.id);
    expect(failed.failure?.message).toContain('crashed in native code');
    expect(failed.failure?.message).not.toMatch(/V8 heap/iu);
  }, 30_000);
});
