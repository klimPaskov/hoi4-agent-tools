import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { JobService } from '../../src/hoi4_agent_tools/core/job-service.js';
import { JobWorkerHost } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import {
  currentJobOwner,
  readCheckpointIdentity,
} from '../../src/hoi4_agent_tools/core/job-store.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { hashCanonical } from '../../src/hoi4_agent_tools/core/canonical.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(mutation = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-recovery-policy-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [{ id: 'test', name: 'Synthetic worker policy', root: mod }],
      }),
    ),
  );
  await engine.persistentAnalysisCache;
  const jobs = await JobService.create(engine.resolver);
  const record = (
    await jobs.submit('test', {
      toolName: mutation ? 'hoi4.gui_rewrite' : 'hoi4.event_inspect',
      arguments: {},
      mutation,
      requestKey: 'bounded-recovery',
    })
  ).record;
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  const pid = child.pid!;
  await once(child, 'close');
  const owner = { ...currentJobOwner(), pid };
  const scope = jobs.scope('test');
  await jobs.store.claim(scope, record.id, owner);
  const checkpoint = {
    sourceRevision: 'a'.repeat(64),
    cursor: `analysis:${'b'.repeat(64)}`,
    stateHash: 'c'.repeat(64),
    resourceUri: 'synthetic-test-checkpoint',
  };
  await jobs.store.updateOwned(scope, record.id, owner.token, { checkpoint });
  const host = await JobWorkerHost.create(engine, jobs);
  // Only the process-boundary implementation is replaced here; durable job transitions and retry policy are real.
  const launch = vi
    .spyOn(host as unknown as { launch(): Promise<void> }, 'launch')
    .mockRejectedValue(new ServiceError('JOB_WORKER_EXIT', 'Synthetic stopped attempt'));
  return { host, launch, jobs, record, owner, scope, checkpoint };
}

describe('bounded checkpoint worker recovery policy', () => {
  it('does not retry the same stopped frontier twice', async () => {
    const { host, launch, record } = await fixture();
    expect(await host.run('test', record.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'JOB_WORKER_EXIT' },
    });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('bounds recovery even when each failed attempt advances its checkpoint', async () => {
    const { host, launch, record, jobs, scope, owner, checkpoint } = await fixture();
    let attempts = 0;
    launch.mockImplementation(async () => {
      attempts++;
      await jobs.store.updateOwned(scope, record.id, owner.token, {
        checkpoint: { ...checkpoint, stateHash: hashCanonical(attempts) },
      });
      throw new ServiceError('JOB_WORKER_EXIT', 'Synthetic stopped attempt');
    });
    expect(await host.run('test', record.id)).toMatchObject({ status: 'failed' });
    expect(attempts).toBe(3);
  });

  it('does not replay a write because it happens to contain a read-like checkpoint', async () => {
    const { host, launch, record } = await fixture(true);
    expect(await host.run('test', record.id)).toMatchObject({ status: 'failed' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('preserves a cancellation after the owner stops instead of restarting or failing it', async () => {
    const { host, launch, record, jobs } = await fixture();
    await jobs.cancel('test', record.id);
    expect(await host.run('test', record.id)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('waits for a live replacement owner to publish a terminal outcome', async () => {
    const { host, launch, record, jobs, scope } = await fixture();
    const owner = currentJobOwner();
    let resolvePublication!: () => void;
    let rejectPublication!: (error: unknown) => void;
    const publication = new Promise<void>((resolve, reject) => {
      resolvePublication = resolve;
      rejectPublication = reject;
    });
    void publication.catch(() => undefined);
    launch.mockImplementation(async () => {
      const claimed = await jobs.store.claim(scope, record.id, owner);
      await jobs.store.updateOwned(scope, record.id, owner.token, { status: 'running' });
      setTimeout(() => {
        void jobs.store
          .updateOwned(scope, record.id, owner.token, {
            status: 'completed',
            result: { structuredContent: { status: 'ok' } },
          })
          .then(() => resolvePublication(), rejectPublication);
      }, 25);
      expect(claimed.recovery).toBe(true);
    });
    await expect(host.run('test', record.id)).resolves.toMatchObject({ status: 'completed' });
    await expect(publication).resolves.toBeUndefined();
  });

  it('recognizes a committed result but rejects incomplete or mismatched commitments', async () => {
    const { jobs, record, scope, owner } = await fixture();
    const result = { exact: true };
    const current = await jobs.store.updateOwned(scope, record.id, owner.token, {
      result,
      checkpoint: {
        cursor: 'result-ready',
        sourceRevision: 'a'.repeat(64),
        resultHash: hashCanonical(result),
      },
    });
    expect(readCheckpointIdentity(current)).toBe(`result:${hashCanonical(result)}`);
    expect(
      readCheckpointIdentity({
        ...current,
        checkpoint: { ...current.checkpoint!, resultHash: 'f'.repeat(64) },
      }),
    ).toBeUndefined();
    expect(
      readCheckpointIdentity({
        ...current,
        checkpoint: { cursor: `analysis:${'a'.repeat(64)}`, sourceRevision: 'a'.repeat(64) },
      }),
    ).toBeUndefined();
  });
});
