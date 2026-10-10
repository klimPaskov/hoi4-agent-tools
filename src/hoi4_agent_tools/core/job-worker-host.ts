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
import { isDomainToolName } from './domain-tools.js';

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
    if (!isDomainToolName(initial.request.toolName))
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
    // Resolve the same configured workspace and grants again immediately before dispatch. A
    // job that finished, or that a live worker already runs, needs no new worker: another
    // launcher may have run it while this one waited for capacity.
    const current = await this.jobs.get(workspaceId, id, principal);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) return;
    if (current.owner !== undefined && jobOwnerLiveness(current.owner) === 'alive') return;
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
    const message = {
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
    };
    const warm = configuration.jobWorkerIdleSeconds > 0;
    progress.stage = 'startup';
    const reused = warm ? this.takeIdleWorker() : undefined;
    const child = reused ?? (await this.startWorker(configuration.jobWorkerMaxHeapMiB));
    try {
      progress.stage = 'handoff';
      await lease.handoffToProcess(child.pid!);
    } catch (error) {
      // A reused worker that just exited cannot take the slot; no job reached it.
      if (reused !== undefined && error instanceof ServiceError)
        throw new ServiceError(
          'REQUEST_LEASE_HANDOFF_LOST',
          'The warm worker stopped before it received the job',
        );
      if (reused === undefined) await stopChild(child);
      throw error;
    }
    progress.stage = 'dispatch';
    await this.dispatch(child, message, reused !== undefined);
    // Without warm reuse the persistent job, not the launcher's lifetime, owns execution once
    // the child confirmed receipt, so close the channel.
    if (!warm && child.connected) child.disconnect();
    progress.stage = 'supervision';
    const { jobDeadlineSeconds, jobCancelGraceSeconds } = this.engine.resolver.config();
    const supervisedSince = Date.now();
    let cancellationSeenAt: number | undefined;
    for (;;) {
      const record = await this.jobs.get(workspaceId, id, principal);
      if (['completed', 'failed', 'cancelled'].includes(record.status)) {
        if (warm) await this.keepWarm(child, lease);
        return;
      }
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

  /** Idle warm workers of this host, most recently used last. */
  private readonly idleWorkers: ChildProcess[] = [];
  /**
   * Workers that reported idle since their last dispatch. The report usually arrives before the
   * supervision loop notices the finished job, so it is recorded as it comes.
   */
  private readonly reportedIdle = new WeakSet<ChildProcess>();
  private readonly watched = new WeakSet<ChildProcess>();

  private watchIdle(child: ChildProcess): void {
    if (this.watched.has(child)) return;
    this.watched.add(child);
    child.on('message', (value: unknown) => {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'idle')
        this.reportedIdle.add(child);
    });
  }

  /** Let every idle warm worker exit; a busy one finishes its job first. */
  releaseIdleWorkers(): void {
    for (const child of this.idleWorkers.splice(0)) if (child.connected) child.disconnect();
  }

  private takeIdleWorker(): ChildProcess | undefined {
    for (;;) {
      const child = this.idleWorkers.pop();
      if (child === undefined) return undefined;
      if (
        child.connected &&
        child.exitCode === null &&
        child.signalCode === null &&
        child.pid !== undefined
      ) {
        child.ref();
        child.channel?.ref();
        return child;
      }
    }
  }

  /** Start a fixed-entry worker and wait for its readiness handshake. */
  private async startWorker(maxHeapMiB: number | undefined): Promise<ChildProcess> {
    const sourceMode = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(
      new URL(sourceMode ? './job-worker.ts' : './job-worker.js', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        ...(maxHeapMiB === undefined ? [] : [`--max-old-space-size=${maxHeapMiB}`]),
        ...(sourceMode ? ['--import', import.meta.resolve('tsx')] : []),
        entry,
      ],
      {
        detached: true,
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
          reject(
            new ServiceError(
              'JOB_WORKER_STARTUP_EXIT',
              `The worker exited before completing its startup handshake (phase waiting_for_ready, exit ${code ?? 'none'}, signal ${signal ?? 'none'})`,
            ),
          );
        child.once('error', reject);
        child.once('exit', onExit);
        child.once('message', (value: unknown) => {
          child.off('exit', onExit);
          child.off('error', reject);
          if (
            typeof value !== 'object' ||
            value === null ||
            !('type' in value) ||
            value.type !== 'ready' ||
            child.pid === undefined
          )
            reject(
              new ServiceError(
                'JOB_WORKER_PROTOCOL',
                'The worker did not provide its readiness handshake',
              ),
            );
          else resolve();
        });
      });
    } catch (error) {
      if (child.connected) child.disconnect();
      throw error;
    }
    return child;
  }

  /** Send the job and wait until the worker acknowledges receipt. */
  private async dispatch(
    child: ChildProcess,
    message: Record<string, unknown>,
    reused: boolean,
  ): Promise<void> {
    let acknowledgmentTimer: NodeJS.Timeout | undefined;
    this.watchIdle(child);
    this.reportedIdle.delete(child);
    try {
      await new Promise<void>((resolve, reject) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
          reject(
            reused
              ? new ServiceError(
                  'REQUEST_LEASE_HANDOFF_LOST',
                  'The warm worker stopped before it received the job',
                )
              : new ServiceError(
                  'JOB_WORKER_STARTUP_EXIT',
                  `The worker exited before completing its startup handshake (phase waiting_for_acceptance, exit ${code ?? 'none'}, signal ${signal ?? 'none'})`,
                ),
          );
        child.once('exit', onExit);
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
        const onMessage = (accepted: unknown): void => {
          if (
            typeof accepted === 'object' &&
            accepted !== null &&
            'type' in accepted &&
            accepted.type === 'idle'
          )
            return;
          child.off('message', onMessage);
          child.off('exit', onExit);
          if (
            typeof accepted !== 'object' ||
            accepted === null ||
            !('type' in accepted) ||
            accepted.type !== 'accepted'
          )
            reject(
              new ServiceError(
                'JOB_WORKER_PROTOCOL',
                'The worker did not acknowledge the dispatched job',
              ),
            );
          else resolve();
        };
        child.on('message', onMessage);
        child.send(message, (error) => {
          if (error !== null) reject(error);
        });
      });
    } catch (error) {
      if (child.connected) child.disconnect();
      throw error;
    } finally {
      clearTimeout(acknowledgmentTimer);
    }
  }

  /**
   * After a job, wait briefly for the worker to report itself idle, release its capacity slot
   * and keep it for the next job. A worker that does not report idle is left to exit.
   */
  private async keepWarm(child: ChildProcess, lease: SharedCapacityLease): Promise<void> {
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) return;
    const idle = await new Promise<boolean>((resolve) => {
      if (this.reportedIdle.has(child)) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => finish(false), 10_000);
      const onMessage = (value: unknown): void => {
        if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'idle')
          finish(true);
      };
      const onExit = (): void => finish(false);
      function finish(result: boolean): void {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve(result);
      }
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
    // The channel can close while waiting; read it afresh rather than from the earlier check.
    const connected = (): boolean => child.connected;
    if (!idle || !connected()) {
      if (connected()) child.disconnect();
      return;
    }
    await lease.reclaimFromProcess();
    // An idle worker must not keep this server's event loop alive.
    child.unref();
    child.channel?.unref();
    this.idleWorkers.push(child);
  }
}
