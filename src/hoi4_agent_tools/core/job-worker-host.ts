import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoreEngine } from './engine.js';
import { JobService } from './job-service.js';
import {
  jobFailureFromError,
  jobOwnerLiveness,
  readCheckpointIdentity,
  type JobFailure,
  type JobRecord,
} from './job-store.js';
import { RequestScheduler } from './request-scheduler.js';
import { SharedRequestCapacity, type SharedCapacityLease } from './shared-request-capacity.js';
import { containedGeneratedPath, type ResolvedWorkspace } from './workspace.js';
import { ServiceError } from './result.js';
import { isDomainToolName } from './domain-tools.js';
import {
  classifyWorkerExit,
  defaultWorkerHeapMiB,
  type WorkerExitEvidence,
} from './worker-exit.js';

const maximumCheckpointRecoveries = 2;
const maximumPreDispatchRecoveries = 2;
/** Used only when the exit status of the worker is unknown to this process. */
const WORKER_EXIT_MESSAGE =
  'The worker stopped without publishing a terminal job outcome; its exit status is not available to this server, so retry the call';
/** Bytes of a worker's standard error read back when it exits unexpectedly. */
const STDERR_TAIL_BYTES = 16_384;
/** Standard-error logs of workers that exited unexpectedly kept for diagnosis. */
const RETAINED_STDERR_LOGS = 10;
/**
 * Longest wait for the worker that holds a workspace's newest index while it finishes a rewrite's
 * after-edit check (decision D-98). That check rebuilds the same index a second worker would
 * rebuild, so waiting for it is the cheaper path; past this bound the job takes another worker.
 */
export const WORKSPACE_WORKER_WAIT_MS = 15_000;
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
export function workerFailure(error: unknown, stage: WorkerStage): JobFailure {
  if (error instanceof ServiceError) return jobFailureFromError(error);
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
async function stopChild(child: ChildProcess, stopped?: WeakSet<ChildProcess>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  stopped?.add(child);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await Promise.race([exited, delay(10_000)]);
}

/** Read the last bytes of a worker's standard-error log; empty when it cannot be read. */
function readTail(file: string): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, STDERR_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Keep only the newest few worker logs; the rest are older diagnostics. */
/** A started worker whose process and channel are still up. */
function usableWorker(child: ChildProcess): boolean {
  return (
    child.connected &&
    child.exitCode === null &&
    child.signalCode === null &&
    child.pid !== undefined
  );
}

/** Let a worker taken from the idle list keep the event loop alive while it runs a job. */
function refWorker(child: ChildProcess): ChildProcess {
  child.ref();
  child.channel?.ref();
  return child;
}

function pruneWorkerLogs(logRoot: string): void {
  try {
    const logs = readdirSync(logRoot)
      .filter((name) => name.startsWith('worker-') && name.endsWith('.log'))
      .map((name) => ({ name, modified: statSync(path.join(logRoot, name)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
    // A recent log may belong to a worker that is still running, so only older ones go.
    const cutoff = Date.now() - 10 * 60_000;
    for (const { name, modified } of logs.slice(RETAINED_STDERR_LOGS))
      if (modified < cutoff) rmSync(path.join(logRoot, name), { force: true });
  } catch {
    // Diagnostics are best effort and must never change a job outcome.
  }
}

/**
 * Remove the log of a worker that ended normally or because the host stopped it. Keep the
 * newest few logs of workers that ended unexpectedly, because their stack is the evidence.
 */
function retainOrRemoveLog(file: string, evidence: WorkerExitEvidence, logRoot: string): void {
  try {
    const unexpected =
      !evidence.stoppedByHost &&
      (evidence.signal !== null || (evidence.code !== null && evidence.code !== 0));
    if (!unexpected) {
      rmSync(file, { force: true });
      return;
    }
    pruneWorkerLogs(logRoot);
  } catch {
    // Diagnostics are best effort and must never change a job outcome.
  }
}

/**
 * Bounded, fixed-entry child execution. Client disconnection never kills a worker; an
 * overdue or unresponsive cancelled read-only worker is stopped by its supervising host.
 */
/**
 * Select the workspaces a job worker resolves again. A mod folder removed after the host
 * discovered it must not stop jobs for every other workspace, so absent roots are left out.
 * The job's own workspace is always kept, and a missing root still fails that job explicitly.
 */
export async function workerWorkspaces(
  workspaces: readonly ResolvedWorkspace[],
  workspaceId: string,
): Promise<ResolvedWorkspace[]> {
  const retained = await Promise.all(
    workspaces.map(
      async (workspace) =>
        workspace.id === workspaceId ||
        (await stat(workspace.modRoot).then(
          (metadata) => metadata.isDirectory(),
          () => false,
        )),
    ),
  );
  return workspaces.filter((_workspace, index) => retained[index]);
}

export class JobWorkerHost {
  private readonly owner = {};
  private constructor(
    private readonly engine: CoreEngine,
    private readonly jobs: JobService,
    private readonly capacity: SharedRequestCapacity,
    private readonly scheduler: RequestScheduler,
    private readonly logRoot: string,
  ) {}

  static async create(engine: CoreEngine, jobs?: JobService): Promise<JobWorkerHost> {
    const state = engine.resolver.serverState();
    if (state === undefined)
      throw new ServiceError('JOB_STORAGE_UNAVAILABLE', 'Workers require persistent server state');
    const root = await containedGeneratedPath(state.root, 'job-workers');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const logRoot = path.join(root, 'logs');
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    pruneWorkerLogs(logRoot);
    const config = engine.resolver.config();
    return new JobWorkerHost(
      engine,
      jobs ?? (await JobService.create(engine.resolver)),
      new SharedRequestCapacity(root, config.maxSharedTools),
      new RequestScheduler(config.maxConcurrentTools),
      logRoot,
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
    // A rewrite that answered before its after-edit check is still building the workspace's new
    // index in its worker. When no idle worker has scanned the workspace yet, the next call on it
    // waits for that worker and reads its index instead of building one from nothing.
    if (this.engine.resolver.config().jobWorkerIdleSeconds > 0)
      await this.awaitWorkspaceWorker(workspaceId, WORKSPACE_WORKER_WAIT_MS);
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
        throw new ServiceError('JOB_WORKER_EXIT', WORKER_EXIT_MESSAGE);
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
            : `The replacement worker stopped without publishing a terminal job outcome; its exit status belongs to the server that started it, so retry the call`,
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
    const resolvedWorkspaces = await workerWorkspaces(this.engine.resolver.list(), workspaceId);
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
    const reused = warm ? this.takeIdleWorker(workspaceId) : undefined;
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
      if (reused === undefined) await stopChild(child, this.stoppedByHost);
      throw error;
    }
    progress.stage = 'dispatch';
    await this.dispatch(child, message, reused !== undefined);
    // After this job the worker holds the workspace's newest scan and index.
    if (warm) {
      this.workspaceWorkers.set(workspaceId, { child, mutation: current.request.mutation });
      const scanned = this.scannedWorkers.get(workspaceId) ?? new Set<ChildProcess>();
      this.scannedWorkers.set(workspaceId, scanned.add(child));
    }
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
          await stopChild(child, this.stoppedByHost);
          await this.jobs.failInterrupted(
            workspaceId,
            id,
            {
              code: 'JOB_DEADLINE_EXCEEDED',
              message: `The job ran longer than ${jobDeadlineSeconds} seconds and was stopped${record.progress === undefined ? '' : ` during: ${record.progress.message.slice(0, 160)}`}; narrow its selector or limits, or raise jobDeadlineSeconds`,
            },
            principal,
          );
          return;
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const evidence = await this.exits.get(child);
        const message =
          evidence === undefined ? WORKER_EXIT_MESSAGE : classifyWorkerExit(evidence).message;
        // The job's last progress report says how far the worker got before it stopped.
        throw new ServiceError(
          'JOB_WORKER_EXIT',
          record.progress === undefined
            ? message
            : `${message}; last progress: ${record.progress.message.slice(0, 160)}`,
        );
      }
      await delay(100);
    }
  }

  /** Workers this host stopped itself, so their exit is not reported as a fault. */
  private readonly stoppedByHost = new WeakSet<ChildProcess>();
  /** Settles with the exit status and last standard error of each worker this host started. */
  private readonly exits = new WeakMap<ChildProcess, Promise<WorkerExitEvidence>>();

  /** Idle warm workers of this host, most recently used last. */
  private readonly idleWorkers: ChildProcess[] = [];
  /**
   * Workers that reported idle since their last dispatch. The report usually arrives before the
   * supervision loop notices the finished job, so it is recorded as it comes.
   */
  private readonly reportedIdle = new WeakSet<ChildProcess>();
  private readonly watched = new WeakSet<ChildProcess>();
  private workerSequence = 0;

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

  /** The worker that ran each workspace's last job, and whether that job was a rewrite. */
  private readonly workspaceWorkers = new Map<string, { child: ChildProcess; mutation: boolean }>();
  /** Every warm worker that ran a job on each workspace and so holds a scan of it, maybe older. */
  private readonly scannedWorkers = new Map<string, Set<ChildProcess>>();
  /** Jobs waiting for a busy worker to finish, by worker. */
  private readonly idleWaiters = new Map<ChildProcess, Set<(idle: boolean) => void>>();

  /**
   * An idle warm worker for a job on `workspaceId`: the one that ran the workspace's last job, which
   * holds its newest scan and index, else the most recently used one that scanned the workspace
   * before, else the most recently used one. A reused index is still checked against the files:
   * the worker scans again and rebuilds whatever changed (D-98).
   */
  private takeIdleWorker(workspaceId?: string): ChildProcess | undefined {
    const preferred =
      workspaceId === undefined ? undefined : this.workspaceWorkers.get(workspaceId)?.child;
    const position = preferred === undefined ? -1 : this.idleWorkers.indexOf(preferred);
    if (position >= 0) {
      this.idleWorkers.splice(position, 1);
      if (usableWorker(preferred!)) return refWorker(preferred!);
    }
    const scanned = this.idleScannedWorker(workspaceId);
    if (scanned !== undefined) {
      this.idleWorkers.splice(this.idleWorkers.indexOf(scanned), 1);
      return refWorker(scanned);
    }
    for (;;) {
      const child = this.idleWorkers.pop();
      if (child === undefined) return undefined;
      if (usableWorker(child)) return refWorker(child);
    }
  }

  /** The most recently used idle, usable worker that scanned `workspaceId` before, if any. */
  private idleScannedWorker(workspaceId?: string): ChildProcess | undefined {
    const scanned = workspaceId === undefined ? undefined : this.scannedWorkers.get(workspaceId);
    if (scanned === undefined) return undefined;
    for (const child of scanned) if (!usableWorker(child)) scanned.delete(child);
    for (let index = this.idleWorkers.length - 1; index >= 0; index -= 1) {
      const child = this.idleWorkers[index]!;
      if (scanned.has(child) && usableWorker(child)) return child;
    }
    return undefined;
  }

  /**
   * Wait, at most `limitMs`, while the worker that last ran a rewrite on `workspaceId` is still busy
   * with it, typically the after-edit check of a rewrite that answered early. Returns whether a
   * worker with a scan of the workspace is idle now. No wait happens when another idle worker
   * scanned the workspace before: it rescans only the changed files, which is no slower than
   * waiting for the check. A read that is still running is not waited for: it may run for minutes.
   */
  private async awaitWorkspaceWorker(workspaceId: string, limitMs: number): Promise<boolean> {
    const newest = this.workspaceWorkers.get(workspaceId);
    if (newest === undefined || !usableWorker(newest.child)) return false;
    if (this.idleWorkers.includes(newest.child)) return true;
    if (this.idleScannedWorker(workspaceId) !== undefined) return true;
    if (!newest.mutation) return false;
    const { child } = newest;
    return new Promise<boolean>((resolve) => {
      const waiters = this.idleWaiters.get(child) ?? new Set<(idle: boolean) => void>();
      this.idleWaiters.set(child, waiters);
      const timer = setTimeout(() => finish(false), limitMs);
      const onExit = (): void => finish(false);
      function finish(idle: boolean): void {
        clearTimeout(timer);
        waiters.delete(finish);
        child.off('exit', onExit);
        resolve(idle);
      }
      waiters.add(finish);
      child.once('exit', onExit);
    });
  }

  /** Tell the jobs waiting for `child` that it finished its job, kept warm or not. */
  private notifyIdleWaiters(child: ChildProcess, idle: boolean): void {
    const waiters = this.idleWaiters.get(child);
    if (waiters === undefined) return;
    this.idleWaiters.delete(child);
    for (const finish of [...waiters]) finish(idle);
  }

  /** Start a fixed-entry worker and wait for its readiness handshake. */
  private async startWorker(maxHeapMiB: number | undefined): Promise<ChildProcess> {
    const sourceMode = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(
      new URL(sourceMode ? './job-worker.ts' : './job-worker.js', import.meta.url),
    );
    const heapLimitMiB = maxHeapMiB ?? defaultWorkerHeapMiB();
    const stderrLog = path.join(this.logRoot, `worker-${process.pid}-${++this.workerSequence}.log`);
    const stderrFd = openSync(stderrLog, 'w', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${heapLimitMiB}`,
          ...(sourceMode ? ['--import', import.meta.resolve('tsx')] : []),
          entry,
        ],
        {
          detached: true,
          cwd: process.cwd(),
          stdio: ['ignore', 'ignore', stderrFd, 'ipc'],
          windowsHide: true,
        },
      );
    } finally {
      closeSync(stderrFd);
    }
    this.exits.set(
      child,
      new Promise<WorkerExitEvidence>((resolve) => {
        child.once('exit', (code, signal) => {
          const evidence: WorkerExitEvidence = {
            code,
            signal,
            stderrTail: readTail(stderrLog),
            stoppedByHost: this.stoppedByHost.has(child),
            heapLimitMiB,
          };
          retainOrRemoveLog(stderrLog, evidence, this.logRoot);
          resolve(evidence);
        });
      }),
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
    let idle = false;
    try {
      idle = await this.parkWorker(child, lease);
    } finally {
      this.notifyIdleWaiters(child, idle);
    }
  }

  /** Put a worker that finished its job into the idle list; returns whether it is there. */
  private async parkWorker(child: ChildProcess, lease: SharedCapacityLease): Promise<boolean> {
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) return false;
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
      return false;
    }
    await lease.reclaimFromProcess();
    // An idle worker must not keep this server's event loop alive.
    child.unref();
    child.channel?.unref();
    this.idleWorkers.push(child);
    return true;
  }
}
