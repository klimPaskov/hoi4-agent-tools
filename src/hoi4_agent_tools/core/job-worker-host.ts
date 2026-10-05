import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoreEngine } from './engine.js';
import { JobService } from './job-service.js';
import { jobOwnerLiveness, readCheckpointIdentity, type JobRecord } from './job-store.js';
import { RequestScheduler } from './request-scheduler.js';
import { SharedRequestCapacity, type SharedCapacityLease } from './shared-request-capacity.js';
import { containedGeneratedPath } from './workspace.js';
import { ServiceError } from './result.js';

const maximumCheckpointRecoveries = 2;
const maximumPreDispatchRecoveries = 2;
// Native and IPC codes are fixed vocabulary. Error messages can contain paths or source
// text, so only an allowlisted code and the fixed coordination stage are reported.
const nativeFailureCodes = new Set([
  'EACCES',
  'EAGAIN',
  'EBADF',
  'EBUSY',
  'ECHILD',
  'ECONNRESET',
  'EEXIST',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EPIPE',
  'ESRCH',
  'ETIMEDOUT',
  'ERR_IPC_CHANNEL_CLOSED',
  'ERR_IPC_DISCONNECTED',
]);

/** Fixed coordination steps between job admission and a terminal record. */
export type WorkerStage = 'admission' | 'startup' | 'handoff' | 'dispatch' | 'supervision';

function nativeFailureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' && nativeFailureCodes.has(error.code)
    ? error.code
    : undefined;
}

/** Map a launcher failure to a stable, path-free job failure. */
export function workerFailure(
  error: unknown,
  stage: WorkerStage,
): { code: string; message: string } {
  if (error instanceof ServiceError) return { code: error.code, message: error.message };
  const nativeCode = nativeFailureCode(error);
  return nativeCode === undefined
    ? {
        code: 'JOB_WORKER_FAILED',
        message: `The isolated worker stopped without publishing a result (stage ${stage})`,
      }
    : {
        code: `JOB_WORKER_${nativeCode}`,
        message: `Worker coordination could not complete (${nativeCode}, stage ${stage}); inspect the retained job outcome`,
      };
}

/** Stop a supervised worker and wait, bounded, until the operating system reports its exit. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await Promise.race([exited, delay(10_000)]);
}

/**
 * Bounded, fixed-entry child execution. Client disconnection never kills a worker; an
 * overdue or unresponsive cancelled read-only worker is stopped by its supervising host.
 */
export class JobWorkerHost {
  private readonly owner = {};
  private constructor(
    private readonly engine: CoreEngine,
    private readonly jobs: JobService,
    private readonly capacity: SharedRequestCapacity,
    private readonly scheduler: RequestScheduler,
  ) {}

  static async create(engine: CoreEngine, jobs?: JobService): Promise<JobWorkerHost> {
    const state = engine.resolver.serverState();
    if (state === undefined)
      throw new ServiceError('JOB_STORAGE_UNAVAILABLE', 'Workers require persistent server state');
    const root = await containedGeneratedPath(state.root, 'job-workers');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const config = engine.resolver.config();
    return new JobWorkerHost(
      engine,
      jobs ?? (await JobService.create(engine.resolver)),
      new SharedRequestCapacity(root, config.maxSharedTools),
      new RequestScheduler(config.maxConcurrentTools),
    );
  }

  async run(workspaceId: string, id: string, principal?: string): Promise<JobRecord> {
    const initial = await this.jobs.get(workspaceId, id, principal);
    if (['completed', 'cancelled', 'failed'].includes(initial.status)) return initial;
    if (
      ![
        'hoi4.impact_inspect',
        'hoi4.decision_inspect',
        'hoi4.mechanic_test',
        'hoi4.package_check',
        'hoi4.scenario_test',
        'hoi4.event_inspect',
        'hoi4.event_render',
        'hoi4.event_compare',
        'hoi4.tech_inspect',
        'hoi4.tech_render',
        'hoi4.tech_compare',
        'hoi4.probability_inspect',
        'hoi4.probability_evaluate',
        'hoi4.probability_sweep',
        'hoi4.probability_simulate',
        'hoi4.probability_sequence',
        'hoi4.probability_compare',
        'hoi4.probability_render',
        'hoi4.map_inspect',
        'hoi4.map_render',
        'hoi4.map_rewrite',
        'hoi4.gui_inspect',
        'hoi4.gui_render',
        'hoi4.gui_rewrite',
        'hoi4.focus_inspect',
        'hoi4.focus_render',
        'hoi4.focus_raster',
        'hoi4.focus_rewrite',
      ].includes(initial.request.toolName)
    )
      throw new ServiceError(
        'JOB_OPERATION_UNAVAILABLE',
        'This domain has not yet been registered for worker execution',
      );
    const signal = new AbortController().signal;
    const recovered = new Set<string>();
    const progress: { stage: WorkerStage } = { stage: 'admission' };
    let preDispatchRecoveries = 0;
    for (;;) {
      try {
        progress.stage = 'admission';
        await this.scheduler.run(this.owner, 1024, signal, () =>
          this.capacity.run(signal, (lease) =>
            this.launch(workspaceId, id, lease, progress, principal),
          ),
        );
        progress.stage = 'supervision';
        const current = await this.jobs.get(workspaceId, id, principal);
        if (['completed', 'cancelled', 'failed'].includes(current.status)) return current;
        if (current.owner !== undefined && jobOwnerLiveness(current.owner) === 'alive')
          return await this.followOwner(workspaceId, id, principal);
        throw new ServiceError(
          'JOB_WORKER_EXIT',
          'The worker stopped without publishing a terminal job outcome',
        );
      } catch (error) {
        const current = await this.jobs.get(workspaceId, id, principal);
        if (
          error instanceof ServiceError &&
          error.code === 'REQUEST_LEASE_HANDOFF_LOST' &&
          (current.status === 'queued' ||
            (current.owner !== undefined && jobOwnerLiveness(current.owner) === 'dead')) &&
          preDispatchRecoveries < maximumPreDispatchRecoveries
        ) {
          // No job request was sent to the child: another bounded admission attempt
          // cannot replay a read or a rewrite.
          preDispatchRecoveries += 1;
          await delay(preDispatchRecoveries * 100);
          continue;
        }
        const checkpoint = readCheckpointIdentity(current);
        if (
          checkpoint !== undefined &&
          current.owner !== undefined &&
          jobOwnerLiveness(current.owner) === 'dead' &&
          recovered.size < maximumCheckpointRecoveries &&
          !recovered.has(checkpoint)
        ) {
          // A replacement revalidates source identity and checkpoint bytes in the normal
          // executor. Never replay writes, repeat a stalled frontier, or reclaim a live owner.
          recovered.add(checkpoint);
          continue;
        }
        return await this.jobs.failInterrupted(
          workspaceId,
          id,
          workerFailure(error, progress.stage),
          principal,
        );
      }
    }
  }

  private async followOwner(
    workspaceId: string,
    id: string,
    principal?: string,
  ): Promise<JobRecord> {
    for (;;) {
      const record = await this.jobs.get(workspaceId, id, principal);
      if (['completed', 'failed', 'cancelled'].includes(record.status)) return record;
      const liveness = record.owner === undefined ? 'dead' : jobOwnerLiveness(record.owner);
      if (liveness !== 'alive')
        throw new ServiceError(
          liveness === 'unknown' ? 'JOB_OWNER_UNRESOLVED' : 'JOB_WORKER_EXIT',
          liveness === 'unknown'
            ? 'The replacement execution owner cannot be verified on this host'
            : 'The replacement worker stopped without publishing a terminal job outcome',
        );
      await delay(100);
    }
  }

  private async launch(
    workspaceId: string,
    id: string,
    lease: SharedCapacityLease,
    progress: { stage: WorkerStage },
    principal?: string,
  ): Promise<void> {
    // Resolve the same configured workspace and grants again immediately before dispatch.
    await this.jobs.get(workspaceId, id, principal);
    const sourceMode = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(
      new URL(sourceMode ? './job-worker.ts' : './job-worker.js', import.meta.url),
    );
    const configuration = this.engine.resolver.config();
    const registeredWorkspaceIds = new Set(
      configuration.workspaces.map((workspace) => workspace.id),
    );
    const resolvedWorkspaces = this.engine.resolver.list();
    const discoveredWorkspaceIds = resolvedWorkspaces
      .map((workspace) => workspace.id)
      .filter((workspaceId) => !registeredWorkspaceIds.has(workspaceId));
    const preserveDiscoveredGrants = <
      T extends { allowDiscoveredMods: boolean; workspaceIds: string[] },
    >(
      grant: T,
    ): T =>
      grant.allowDiscoveredMods
        ? {
            ...grant,
            workspaceIds: [...new Set([...grant.workspaceIds, ...discoveredWorkspaceIds])],
          }
        : grant;
    progress.stage = 'startup';
    const child = spawn(
      process.execPath,
      [...(sourceMode ? ['--import', import.meta.resolve('tsx')] : []), entry],
      {
        detached: true,
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    let phase = 'waiting_for_ready';
    let acknowledgmentTimer: NodeJS.Timeout | undefined;
    const initialized = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        reject(
          new ServiceError(
            'JOB_WORKER_STARTUP_EXIT',
            `The worker exited before completing its startup handshake (phase ${phase}, exit ${code ?? 'none'}, signal ${signal ?? 'none'})`,
          ),
        ),
      );
      child.once('message', (value: unknown) => {
        void (async () => {
          if (
            typeof value !== 'object' ||
            value === null ||
            !('type' in value) ||
            value.type !== 'ready' ||
            child.pid === undefined
          )
            throw new ServiceError(
              'JOB_WORKER_PROTOCOL',
              'The worker did not provide its readiness handshake',
            );
          progress.stage = 'handoff';
          await lease.handoffToProcess(child.pid);
          progress.stage = 'dispatch';
          await new Promise<void>((resolve, reject) => {
            phase = 'waiting_for_acceptance';
            acknowledgmentTimer = setTimeout(
              () =>
                reject(
                  new ServiceError(
                    'JOB_WORKER_ACCEPT_TIMEOUT',
                    'The worker did not acknowledge receipt within its startup window',
                  ),
                ),
              30_000,
            );
            child.once('message', (accepted: unknown) => {
              if (
                typeof accepted !== 'object' ||
                accepted === null ||
                !('type' in accepted) ||
                accepted.type !== 'accepted'
              ) {
                reject(
                  new ServiceError(
                    'JOB_WORKER_PROTOCOL',
                    'The worker did not acknowledge the dispatched job',
                  ),
                );
                return;
              }
              phase = 'accepted';
              // Only close IPC after the child confirms receipt. The persistent job,
              // rather than the launcher's lifetime, owns execution after this point.
              if (child.connected) child.disconnect();
              resolve();
            });
            child.send(
              {
                configuration: {
                  ...configuration,
                  modRoots: [],
                  workspaces: resolvedWorkspaces.map(({ registration }) => registration),
                  http: {
                    ...configuration.http,
                    tokens: configuration.http.tokens.map(preserveDiscoveredGrants),
                    principals: configuration.http.principals.map(preserveDiscoveredGrants),
                  },
                },
                workspaceId,
                jobId: id,
                ...(principal === undefined ? {} : { principal }),
              },
              (error) => {
                if (error !== null) reject(error);
              },
            );
          });
          resolve();
        })().catch((error: unknown) => {
          if (child.connected) child.disconnect();
          reject(
            error instanceof Error
              ? error
              : new ServiceError('JOB_WORKER_PROTOCOL', 'Worker initialization failed'),
          );
        });
      });
    });
    try {
      await initialized;
    } finally {
      clearTimeout(acknowledgmentTimer);
    }
    progress.stage = 'supervision';
    const { jobDeadlineSeconds, jobCancelGraceSeconds } = this.engine.resolver.config();
    const supervisedSince = Date.now();
    let cancellationSeenAt: number | undefined;
    for (;;) {
      const record = await this.jobs.get(workspaceId, id, principal);
      if (['completed', 'failed', 'cancelled'].includes(record.status)) return;
      if (record.owner !== undefined && record.owner.pid !== child.pid) {
        if (jobOwnerLiveness(record.owner) === 'alive') return;
      }
      // A worker blocked in synchronous analysis never reaches its own cancellation check,
      // so this process enforces the deadline and cancellation through the child handle.
      // Rewrites are never stopped here: their transaction journal owns write recovery.
      if (!record.request.mutation) {
        if (record.cancelRequested) cancellationSeenAt ??= Date.now();
        const overdue = Date.now() - supervisedSince > jobDeadlineSeconds * 1000;
        const unresponsive =
          cancellationSeenAt !== undefined &&
          Date.now() - cancellationSeenAt > jobCancelGraceSeconds * 1000;
        if (overdue || unresponsive) {
          await stopChild(child);
          await this.jobs.failInterrupted(
            workspaceId,
            id,
            {
              code: 'JOB_DEADLINE_EXCEEDED',
              message: `The job ran longer than ${jobDeadlineSeconds} seconds and was stopped; narrow its selector or limits, or raise jobDeadlineSeconds`,
            },
            principal,
          );
          return;
        }
      }
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH')
            throw new ServiceError(
              'JOB_WORKER_EXIT',
              'The worker stopped without publishing a terminal job outcome',
            );
        }
      }
      await delay(100);
    }
  }
}
