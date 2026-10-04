import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256Bytes } from './canonical.js';
import { canonicalPath, containedGeneratedPath } from './workspace.js';
import { ServiceError } from './result.js';
import { retryWindowsSharing, sharingRetryDelay } from './windows-sharing.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Bounds heavy work across task processes sharing the same private server state. */
export interface SharedCapacityLease {
  /** Transfer a worker slot before admitting work in a newly started child process. */
  handoffToProcess(pid: number): Promise<void>;
}

export interface SharedCapacityOptions {
  /** How long one slot may stay delete-pending on Windows before admission fails. */
  deletePendingLimitMs?: number;
  now?: () => number;
}

export class SharedRequestCapacity {
  private readonly deletePendingLimitMs: number;
  private readonly now: () => number;

  constructor(
    private readonly stateRoot: string | undefined,
    private readonly capacity = 4,
    options: SharedCapacityOptions = {},
  ) {
    this.deletePendingLimitMs = options.deletePendingLimitMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    signal: AbortSignal,
    action: (lease: SharedCapacityLease) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.stateRoot === undefined)
      return action({
        handoffToProcess: () => {
          return Promise.reject(
            new ServiceError(
              'REQUEST_LEASE_STORAGE_REQUIRED',
              'Worker ownership transfer requires persistent capacity storage',
            ),
          );
        },
      });
    const root = await containedGeneratedPath(
      await canonicalPath(this.stateRoot, signal),
      'request-capacity',
      sha256Bytes(hostname().toLowerCase()).slice(0, 16),
    );
    await mkdir(root, { recursive: true });
    const lease = `${process.pid}-${randomUUID()}.lease`;
    // First observation time of each slot that Windows still reports as delete-pending.
    const pendingDeletionSince = new Map<number, number>();
    let waits = 0;
    for (;;) {
      signal.throwIfAborted();
      for (let index = 0; index < this.capacity; index += 1) {
        // Only the stable private parent is canonicalized. A slot can disappear during
        // another owner's release; realpath on that ephemeral directory races on Windows.
        // The numeric component cannot escape, and mkdir atomically proves new ownership.
        const slot = path.join(root, String(index));
        try {
          await mkdir(slot);
          pendingDeletionSince.delete(index);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows can retain a delete-pending directory handle after rmdir
          // returns. Recreating that slot reports EPERM/EBUSY, not EEXIST.
          // Contending waiters keep such a slot pending while they inspect it, so the
          // bound is elapsed time rather than a count of observations. No work is
          // admitted until a later mkdir actually succeeds.
          if (process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(code ?? '')) {
            const since = pendingDeletionSince.get(index) ?? this.now();
            pendingDeletionSince.set(index, since);
            if (this.now() - since >= this.deletePendingLimitMs)
              throw new ServiceError(
                'REQUEST_CAPACITY_UNAVAILABLE',
                `An execution capacity slot stayed unavailable (${code}) beyond its admission window`,
              );
            await this.reap(slot);
            continue;
          }
          if (code !== 'EEXIST') throw error;
          pendingDeletionSince.delete(index);
          await this.reap(slot);
          continue;
        }
        let owner: string;
        try {
          owner = path.join(slot, lease);
          await retryWindowsSharing(() => writeFile(owner, '', { flag: 'wx', mode: 0o600 }), {
            signal,
          });
        } catch (error) {
          // A competing stale-owner cleanup can remove an empty slot before our
          // owner file is published. No work starts until the owner exists.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          await rmdir(slot).catch(() => undefined);
          throw error;
        }
        let transferredPid: number | undefined;
        try {
          signal.throwIfAborted();
          return await action({
            handoffToProcess: async (pid) => {
              if (transferredPid !== undefined)
                throw new ServiceError(
                  'REQUEST_LEASE_ALREADY_TRANSFERRED',
                  'The capacity lease already belongs to a child process',
                );
              if (
                !Number.isSafeInteger(pid) ||
                pid <= 0 ||
                pid === process.pid ||
                !processAlive(pid)
              )
                throw new ServiceError(
                  'REQUEST_LEASE_OWNER_INVALID',
                  'Capacity can only transfer to another live process',
                );
              const next = path.join(slot, `${pid}-${randomUUID()}.lease`);
              try {
                await retryWindowsSharing(() => rename(owner, next));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                  throw new ServiceError(
                    'REQUEST_LEASE_HANDOFF_LOST',
                    'The capacity lease disappeared before worker dispatch',
                  );
                throw error;
              }
              owner = next;
              transferredPid = pid;
            },
          });
        } finally {
          // A launcher can fail while its admitted child still runs. Keep that child's
          // lease until process-exit evidence permits a later reaper to reclaim it.
          if (transferredPid === undefined || !processAlive(transferredPid)) {
            await retryWindowsSharing(() => unlink(owner)).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            });
            await rmdir(slot).catch((error: unknown) => {
              const code = (error as NodeJS.ErrnoException).code;
              if (
                !['ENOENT', 'ENOTEMPTY'].includes(code ?? '') &&
                !(process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(code ?? ''))
              )
                throw error;
            });
          }
        }
      }
      // Short first waits keep a briefly held lock responsive; the cap and jitter keep
      // many contending processes from polling the shared directory in lockstep.
      waits += 1;
      await delay(sharingRetryDelay(waits) * (0.75 + Math.random() / 2), undefined, { signal });
    }
  }

  private async reap(slot: string): Promise<void> {
    try {
      const metadata = await lstat(slot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        throw new ServiceError(
          'PATH_GENERATED_ROOT_ESCAPE',
          'Execution capacity slot must be a real directory beneath its private root',
        );
      const owners = await readdir(slot);
      if (owners.length === 0) {
        if (Date.now() - metadata.mtimeMs < 30_000) return;
      } else {
        for (const name of owners) {
          const match = /^([1-9][0-9]*)-[0-9a-f-]{36}\.lease$/u.exec(name);
          if (match === null || processAlive(Number(match[1]))) return;
          // Unique owner names prevent a concurrent reaper from deleting a new lease.
          await unlink(path.join(slot, name)).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
        }
      }
      await rmdir(slot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (
        !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code) &&
        !(process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(code))
      )
        throw error;
    }
  }
}
