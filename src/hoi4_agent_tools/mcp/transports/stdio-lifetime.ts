/**
 * Ends a stdio server that no client can reach. A client normally closes stdin, which the
 * transport turns into a clean exit. Two cases leave stdin open: the launching process
 * (for example a `cmd.exe` shim that a client terminated) dies while the client keeps the
 * pipe, and a client keeps an idle connection it will never use again. The first is detected
 * by polling the parent process; the second by an optional idle limit.
 */

import { processAlive } from '../../core/server-registry.js';

const PARENT_POLL_MS = 5_000;

export type StdioExitReason = 'parent_exited' | 'idle';

export interface StdioLifetimeOptions {
  /** Exit after this many minutes without client traffic or open requests; 0 disables it. */
  idleExitMinutes: number;
  onExit: (reason: StdioExitReason) => void;
  parentPid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pollMs?: number;
}

export { processAlive };

export class StdioLifetime {
  readonly #options: Required<Omit<StdioLifetimeOptions, 'parentPid'>> & { parentPid: number };
  /** Open client requests and when each arrived. */
  readonly #open = new Map<string | number, number>();
  #parentGone = false;
  #lastActivity: number;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: StdioLifetimeOptions) {
    this.#options = {
      parentPid: options.parentPid ?? process.ppid,
      isAlive: options.isAlive ?? processAlive,
      now: options.now ?? Date.now,
      pollMs: options.pollMs ?? PARENT_POLL_MS,
      idleExitMinutes: options.idleExitMinutes,
      onExit: options.onExit,
    };
    this.#lastActivity = this.#options.now();
  }

  start(): void {
    this.#timer = setInterval(() => this.check(), this.#options.pollMs);
    // The poll never keeps an otherwise finished server alive.
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** A client message: a request opens until its response is sent. */
  received(message: unknown): void {
    this.#lastActivity = this.#options.now();
    const id = requestId(message, 'method');
    if (id !== undefined) this.#open.set(id, this.#lastActivity);
    // A cancelled request gets no response, so the cancellation closes it.
    const cancelled = cancelledRequestId(message);
    if (cancelled !== undefined) this.#open.delete(cancelled);
  }

  /** A server message: a response closes its request. */
  sent(message: unknown): void {
    this.#lastActivity = this.#options.now();
    const id = requestId(message, 'result') ?? requestId(message, 'error');
    if (id !== undefined) this.#open.delete(id);
  }

  /** When the client last sent or received a message, in epoch milliseconds. */
  lastActivity(): number {
    return this.#lastActivity;
  }

  check(): void {
    if (this.#stopped) return;
    const { parentPid, isAlive, idleExitMinutes, now, onExit, pollMs } = this.#options;
    const idleMs = idleExitMinutes * 60_000;
    // A request open for twice the idle limit was abandoned by its client.
    if (idleMs > 0)
      for (const [id, openedAt] of this.#open)
        if (now() - openedAt > 2 * idleMs) this.#open.delete(id);
    // A parent pid of 0 or 1 means the server was already reparented at start. Once the
    // parent is gone, the server finishes open requests and waits for a quiet poll first,
    // since some launchers exit while the client keeps using the pipes.
    if (parentPid > 1 && !this.#parentGone && !isAlive(parentPid)) this.#parentGone = true;
    if (this.#parentGone && this.#open.size === 0 && now() - this.#lastActivity >= pollMs) {
      this.stop();
      onExit('parent_exited');
      return;
    }
    if (idleMs > 0 && this.#open.size === 0 && now() - this.#lastActivity > idleMs) {
      this.stop();
      onExit('idle');
    }
  }
}

function cancelledRequestId(message: unknown): string | number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { method, params } = message as { method?: unknown; params?: { requestId?: unknown } };
  if (method !== 'notifications/cancelled') return undefined;
  const id = params?.requestId;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function requestId(message: unknown, field: string): string | number | undefined {
  if (typeof message !== 'object' || message === null || !(field in message)) return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}
