import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256Bytes } from './canonical.js';
import { canonicalPath, containedGeneratedPath } from './workspace.js';
import { ServiceError } from './result.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Bounds heavy work across task processes sharing the same private server state. */
export class SharedRequestCapacity {
  constructor(
    private readonly stateRoot: string | undefined,
    private readonly capacity = 4,
  ) {}

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.stateRoot === undefined) return action();
    const root = await containedGeneratedPath(
      await canonicalPath(this.stateRoot, signal),
      'request-capacity',
      sha256Bytes(hostname().toLowerCase()).slice(0, 16),
    );
    await mkdir(root, { recursive: true });
    const lease = `${process.pid}-${randomUUID()}.lease`;
    for (;;) {
      signal.throwIfAborted();
      for (let index = 0; index < this.capacity; index += 1) {
        // Only the stable private parent is canonicalized. A slot can disappear during
        // another owner's release; realpath on that ephemeral directory races on Windows.
        // The numeric component cannot escape, and mkdir atomically proves new ownership.
        const slot = path.join(root, String(index));
        try {
          await mkdir(slot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await this.reap(slot);
          continue;
        }
        let owner: string;
        try {
          owner = path.join(slot, lease);
          await writeFile(owner, '', { flag: 'wx', mode: 0o600 });
        } catch (error) {
          // A competing stale-owner cleanup can remove an empty slot before our
          // owner file is published. No work starts until the owner exists.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          await rmdir(slot).catch(() => undefined);
          throw error;
        }
        try {
          signal.throwIfAborted();
          return await action();
        } finally {
          await unlink(owner);
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
      await delay(100, undefined, { signal });
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
