import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';

const OWNER_FILE = '.hoi4-temp-owner.json';
const SWEEP_LOCK = '.hoi4-temp-sweep.lock';
export const TEMPORARY_MAX_BYTES = 256 * 1024 * 1024;
export const TEMPORARY_STALE_MS = 3 * 60 * 60 * 1000;
// Dated event evaluation directories contain retained benchmark evidence, not scratch files.
const scratchName = /^hoi4-(?:reference-source|event-eval)-[A-Za-z0-9]{6}$/u;
const ownerSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    host: z.string().min(1).max(256),
    token: z.uuid(),
  })
  .strict();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function owner(
  directory: string,
  name = OWNER_FILE,
): Promise<z.infer<typeof ownerSchema> | null | undefined> {
  const file = path.join(directory, name);
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) return undefined;
    const result = ownerSchema.safeParse(JSON.parse(await readFile(file, 'utf8')) as unknown);
    return result.success ? result.data : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

interface Inventory {
  bytes: number;
  modified: number;
  locked: boolean;
}

async function inventory(directory: string): Promise<Inventory> {
  const result: Inventory = { bytes: 0, modified: 0, locked: false };
  const pending = [directory];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const metadata = await lstat(current);
    if (++entries > 100_000) throw new Error('Temporary directory inventory limit exceeded');
    result.modified = Math.max(result.modified, metadata.mtimeMs, metadata.birthtimeMs);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isFile()) result.bytes += metadata.size;
    else if (metadata.isDirectory()) {
      for (const name of await readdir(current)) {
        if (name === OWNER_FILE) continue;
        if (/\.(?:lock|lease)$/u.test(name)) result.locked = true;
        pending.push(path.join(current, name));
      }
    }
  }
  return result;
}

export interface TemporarySweepOptions {
  now?: number;
  staleMs?: number;
  maxBytes?: number;
  isAlive?: (pid: number) => boolean;
  /** Canonical workspace and storage roots are never swept, including their ancestors. */
  protectedRoots?: readonly string[];
  /** Effective user on systems exposing file UIDs; injectable for cross-platform tests. */
  currentUid?: number;
}

function overlaps(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const a = normalize(left);
  const b = normalize(right);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  return contains(a, b) || contains(b, a);
}

/** Trusted startup maintenance only; never follows a junction or accepts an MCP path. */
export async function sweepTemporaryDirectories(
  parent: string,
  options: TemporarySweepOptions = {},
): Promise<{ removed: number; retainedBytes: number }> {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? TEMPORARY_STALE_MS;
  const maxBytes = options.maxBytes ?? TEMPORARY_MAX_BYTES;
  const currentUid =
    options.currentUid ?? (process.platform === 'win32' ? undefined : process.geteuid?.());
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(staleMs) ||
    staleMs < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    (currentUid !== undefined && (!Number.isSafeInteger(currentUid) || currentUid < 0))
  )
    throw new RangeError('Invalid temporary storage limits');
  const root = await realpath(parent);
  // A Windows runner reaches %TEMP% through an 8.3 alias; match protected roots by both spellings.
  const protectedRoots = (
    await Promise.all(
      (options.protectedRoots ?? []).map(async (protectedRoot) => {
        try {
          return [protectedRoot, await realpath(protectedRoot)];
        } catch {
          return [protectedRoot];
        }
      }),
    )
  ).flat();
  const candidates: Array<{
    directory: string;
    bytes: number;
    modified: number;
    eligible: boolean;
  }> = [];
  for (const name of (await readdir(root)).filter((name) => scratchName.test(name)).sort()) {
    const directory = path.join(root, name);
    if (protectedRoots.some((protectedRoot) => overlaps(directory, protectedRoot))) continue;
    try {
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (currentUid !== undefined && metadata.uid !== currentUid) ||
        (await realpath(directory)) !== directory
      )
        continue;
      const record = await owner(directory);
      // An interrupted sweep must not leave a permanent lock. Malformed or live locks
      // stay protected; only a confirmed dead local owner can relinquish its lock.
      const previousSweep = await owner(directory, SWEEP_LOCK);
      const deadSweep =
        previousSweep?.host === hostname() &&
        !(options.isAlive ?? alive)(previousSweep.pid) &&
        (await owner(directory, SWEEP_LOCK))?.token === previousSweep.token;
      if (deadSweep) await rm(path.join(directory, SWEEP_LOCK));
      const data = await inventory(directory);
      const dead = record?.host === hostname() && !(options.isAlive ?? alive)(record.pid);
      candidates.push({
        directory,
        ...data,
        eligible:
          !data.locked && (dead || deadSweep || (record === null && now - data.modified > staleMs)),
      });
    } catch {
      // Sharing violations, malformed leases and incomplete inventories fail closed.
    }
  }
  let retainedBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  let removed = 0;
  candidates.sort((a, b) => a.modified - b.modified || (a.directory < b.directory ? -1 : 1));
  for (const entry of candidates) {
    if (!entry.eligible || (now - entry.modified <= staleMs && retainedBytes <= maxBytes)) continue;
    const lockPath = path.join(entry.directory, SWEEP_LOCK);
    let lock;
    let claimed = false;
    const token = randomUUID();
    try {
      lock = await open(lockPath, 'wx', 0o600);
      claimed = true;
      await lock.writeFile(
        JSON.stringify({ version: 1, pid: process.pid, host: hostname(), token }),
      );
      const record = await owner(entry.directory);
      if (
        record === undefined ||
        (record !== null && (record.host !== hostname() || (options.isAlive ?? alive)(record.pid)))
      )
        continue;
      // Check containment again immediately before recursive removal.
      if (
        (await lstat(entry.directory)).isSymbolicLink() ||
        (await realpath(entry.directory)) !== entry.directory
      )
        continue;
      if ((await owner(entry.directory, SWEEP_LOCK))?.token !== token) continue;
      await lock.close();
      lock = undefined;
      await rm(entry.directory, { recursive: true, force: true });
      retainedBytes -= entry.bytes;
      removed += 1;
    } catch {
      // Windows may still hold a file open. Leave it for a later sweep.
    } finally {
      await lock?.close().catch(() => undefined);
      if (claimed && (await owner(entry.directory, SWEEP_LOCK))?.token === token)
        await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
  return { removed, retainedBytes };
}

/** Own only directories allocated by this process; exit cleanup never uses a prefix sweep. */
export class TemporaryDirectoryLifetime {
  readonly #owned = new Map<string, string>();
  readonly #reservedFiles = new Map<string, number>();
  #reservedBytes = 0;
  readonly #onExit = (): void => this.disposeSync();

  constructor(private readonly maxBytes = TEMPORARY_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('Invalid temporary storage budget');
    process.once('exit', this.#onExit);
  }

  /** Reject an oversized fixture before truncate allocates its disk blocks on Windows. */
  assertFileSize(file: string, bytes: number): void {
    const requested = path.resolve(file);
    // Fixture paths are canonical, so resolve an aliased parent before matching them.
    let absolute = requested;
    try {
      absolute = path.join(realpathSync.native(path.dirname(requested)), path.basename(requested));
    } catch {
      // A file in a directory that does not exist yet cannot be inside an owned fixture.
    }
    if (!this.paths().some((directory) => absolute.startsWith(`${directory}${path.sep}`))) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes)
      throw new RangeError('Temporary fixture exceeds the disk budget; use a small injected limit');
    const previous = this.#reservedFiles.get(absolute) ?? 0;
    if (this.#reservedBytes - previous + bytes > this.maxBytes)
      throw new RangeError('Temporary fixtures exceed the disk budget');
    // Reserve before the caller writes, so concurrent allocations cannot oversubscribe.
    // Failed writes remain reserved until teardown, which fails safely rather than undercounts.
    this.#reservedBytes += bytes - previous;
    this.#reservedFiles.set(absolute, bytes);
  }

  async own(directory: string): Promise<void> {
    const canonical = await realpath(directory);
    // The parent may be reached through an alias, such as a Windows 8.3 short name for the user
    // profile; the fixture directory itself must be a real directory, not a link.
    const resolved = path.resolve(directory);
    const viaParent = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
    if ((await lstat(directory)).isSymbolicLink() || canonical !== viaParent)
      throw new Error('Temporary directory must be canonical and unlinked');
    const sweepLock = path.join(canonical, SWEEP_LOCK);
    if (await lstat(sweepLock).catch(() => undefined))
      throw new Error('Temporary directory is being swept');
    const token = randomUUID();
    const handle = await open(path.join(canonical, OWNER_FILE), 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ version: 1, pid: process.pid, host: hostname(), token }),
      );
      this.#owned.set(canonical, token);
      if (await lstat(sweepLock).catch(() => undefined))
        throw new Error('Temporary directory is being swept');
    } finally {
      await handle.close();
    }
  }

  paths(): string[] {
    return [...this.#owned.keys()];
  }

  async release(requested: string): Promise<void> {
    let directory = requested;
    if (!this.#owned.has(directory)) {
      // Owned paths are canonical; a caller may still hold an 8.3 or symlinked spelling.
      try {
        directory = await realpath(requested);
      } catch {
        return;
      }
    }
    const token = this.#owned.get(directory);
    if (token === undefined) return;
    if ((await owner(directory))?.token !== token) {
      this.#owned.delete(directory);
      this.#forgetFiles(directory);
      return;
    }
    if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error('Temporary directory changed before cleanup');
    await rm(directory, { recursive: true, force: true });
    this.#owned.delete(directory);
    this.#forgetFiles(directory);
  }

  #forgetFiles(directory: string): void {
    for (const [file, bytes] of this.#reservedFiles)
      if (file.startsWith(`${directory}${path.sep}`)) {
        this.#reservedBytes -= bytes;
        this.#reservedFiles.delete(file);
      }
  }

  async dispose(): Promise<void> {
    for (const directory of this.paths()) await this.release(directory);
    process.removeListener('exit', this.#onExit);
  }

  disposeSync(): void {
    for (const [directory, token] of this.#owned) {
      try {
        if (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory) !== directory)
          continue;
        const parsed = ownerSchema.safeParse(
          JSON.parse(readFileSync(path.join(directory, OWNER_FILE), 'utf8')) as unknown,
        );
        if (parsed.success && parsed.data.token === token)
          rmSync(directory, { recursive: true, force: true });
      } catch {
        // A crash or sharing violation is recovered by the next stale sweep.
      }
    }
    this.#owned.clear();
    this.#reservedFiles.clear();
    this.#reservedBytes = 0;
    process.removeListener('exit', this.#onExit);
  }
}
