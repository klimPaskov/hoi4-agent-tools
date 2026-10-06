import { unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { PACKAGE_VERSION } from '../version.js';
import type { WorkspaceResolver } from './workspace.js';

/**
 * Every server process sharing a server state root records a small heartbeat, so one status
 * read shows how many servers and workers a machine runs and how much memory each holds.
 */

const HEARTBEAT_MS = 60_000;
/** A record this old without an update belongs to a process that is blocked or gone. */
const STALE_MS = 5 * HEARTBEAT_MS;
const MAX_RECORDS = 512;

const recordSchema = z
  .object({
    pid: z.number().int().positive(),
    version: z.string().max(64),
    transport: z.enum(['stdio', 'http']),
    startedAt: z.string().max(64),
    updatedAt: z.string().max(64),
    lastActivityAt: z.string().max(64).optional(),
    rssBytes: z.number().int().min(0),
    heapUsedBytes: z.number().int().min(0),
  })
  .strict();
export type ServerRecord = z.infer<typeof recordSchema>;

export interface ServerStatus {
  current: ServerRecord;
  servers: Array<ServerRecord & { state: 'live' | 'stale' }>;
  /** Records removed because their process no longer exists. */
  removed: number;
  limits: Record<string, number | undefined>;
}

function directory(resolver: WorkspaceResolver): string | undefined {
  const state = resolver.serverState();
  return state === undefined ? undefined : path.join(state.root, 'servers');
}

/** Whether a process exists; a permission refusal still proves it exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The registry of this server process, or a status-only one when no server started it. */
export function serverRegistry(resolver: WorkspaceResolver): ServerRegistry {
  return ServerRegistry.active ?? new ServerRegistry(resolver, 'stdio');
}

export class ServerRegistry {
  /** The registry whose heartbeats this process writes. */
  static active: ServerRegistry | undefined;
  readonly #startedAt = new Date().toISOString();
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly resolver: WorkspaceResolver,
    private readonly transport: 'stdio' | 'http',
    private readonly lastActivity: () => number | undefined = () => undefined,
  ) {}

  current(): ServerRecord {
    const memory = process.memoryUsage();
    const activity = this.lastActivity();
    return {
      pid: process.pid,
      version: PACKAGE_VERSION,
      transport: this.transport,
      startedAt: this.#startedAt,
      updatedAt: new Date().toISOString(),
      ...(activity === undefined ? {} : { lastActivityAt: new Date(activity).toISOString() }),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    };
  }

  /** Start heartbeats; the record is removed when the process exits normally. */
  start(): void {
    ServerRegistry.active = this;
    const root = directory(this.resolver);
    if (root === undefined) return;
    const file = path.join(root, `${process.pid}.json`);
    const beat = () =>
      void mkdir(root, { recursive: true })
        .then(async () => {
          const temporary = `${file}.${Date.now()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(this.current())}\n`);
          await rename(temporary, file);
        })
        .catch(() => undefined);
    beat();
    this.#timer = setInterval(beat, HEARTBEAT_MS);
    this.#timer.unref();
    process.once('exit', () => {
      try {
        unlinkSync(file);
      } catch {
        // A record left behind is removed by the next status read once the pid is gone.
      }
    });
  }

  async status(): Promise<ServerStatus> {
    const current = this.current();
    const config = this.resolver.config();
    const limits = {
      maxConcurrentTools: config.maxConcurrentTools,
      maxSharedTools: config.maxSharedTools,
      jobDeadlineSeconds: config.jobDeadlineSeconds,
      jobCancelGraceSeconds: config.jobCancelGraceSeconds,
      stdioIdleExitMinutes: config.stdioIdleExitMinutes,
      jobWorkerMaxHeapMiB: config.jobWorkerMaxHeapMiB,
    };
    const root = directory(this.resolver);
    const servers: ServerStatus['servers'] = [];
    let removed = 0;
    if (root !== undefined) {
      const names = (await readdir(root).catch(() => [] as string[]))
        .filter((name) => /^\d+\.json$/u.test(name))
        .slice(0, MAX_RECORDS);
      for (const name of names) {
        const file = path.join(root, name);
        const parsed = recordSchema.safeParse(
          await readFile(file, 'utf8')
            .then((text) => JSON.parse(text) as unknown)
            .catch(() => undefined),
        );
        if (!parsed.success) continue;
        const record = parsed.data;
        if (record.pid === process.pid) continue;
        if (!processAlive(record.pid)) {
          removed += 1;
          await unlink(file).catch(() => undefined);
          continue;
        }
        const age = Date.now() - Date.parse(record.updatedAt);
        servers.push({ ...record, state: age > STALE_MS ? 'stale' : 'live' });
      }
    }
    servers.push({ ...current, state: 'live' });
    servers.sort((left, right) => right.rssBytes - left.rssBytes || left.pid - right.pid);
    return { current, servers, removed, limits };
  }
}
