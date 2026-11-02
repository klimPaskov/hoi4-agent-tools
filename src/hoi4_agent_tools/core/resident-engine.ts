import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  locateEngineBinary,
  type EngineBinaryLocation,
  type EngineRunOptions,
  type EngineUnavailableReason,
} from './engine-client.js';

/**
 * The resident engine (`hoi4-engine serve`, ADR 0074): one long-lived engine process per server
 * that keeps its caches between calls. Requests and responses are frames: a JSON line, then the
 * raw bytes its `payload` field counts. Requests run in parallel inside the engine and are matched
 * to responses by id.
 *
 * The process is started on first use and kept until the server exits, with no idle eviction. A
 * crash fails the requests in flight and the next request starts a fresh process; after
 * `RESIDENT_ENGINE_MAX_RESTARTS` crashes in a row the engine is reported unavailable.
 */

export const RESIDENT_ENGINE_PROTOCOL = 1;
export const RESIDENT_ENGINE_TIMEOUT_MS = 120_000;
export const RESIDENT_ENGINE_MAX_RESTARTS = 3;
/** The largest response header line; payloads are bounded by `maxPayloadBytes`. */
const RESIDENT_ENGINE_MAX_HEADER_BYTES = 1024 * 1024;
const RESIDENT_ENGINE_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

export interface ResidentEngineResponse {
  result: Record<string, unknown>;
  payload: Buffer;
}

export type ResidentEngineOutcome =
  | { ok: true; response: ResidentEngineResponse }
  | { ok: false; kind: 'error'; code: string; message: string; details: Record<string, unknown> }
  | { ok: false; kind: 'unavailable'; reason: EngineUnavailableReason; message: string };

interface Pending {
  resolve: (outcome: ResidentEngineOutcome) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface ResidentEngineRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ResidentEngine {
  private child: ChildProcessWithoutNullStreams | undefined;
  private binary: EngineBinaryLocation | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private header: { id: number; body: Record<string, unknown>; payload: number } | undefined;
  private stderrTail = '';
  private crashes = 0;
  private closed = false;

  constructor(private readonly options: Pick<EngineRunOptions, 'env' | 'packageRoot'> = {}) {}

  /** The binary in use, once a request has started the process. */
  get location(): EngineBinaryLocation | undefined {
    return this.binary;
  }

  /** Whether a binary can be found, without starting it. */
  available(): boolean {
    return 'path' in locateEngineBinary(this.options);
  }

  async request(
    op: string,
    body: Record<string, unknown> = {},
    payload?: Buffer,
    options: ResidentEngineRequestOptions = {},
  ): Promise<ResidentEngineOutcome> {
    options.signal?.throwIfAborted();
    if (this.closed)
      return { ok: false, kind: 'unavailable', reason: 'spawn_failed', message: 'closed' };
    const started = this.ensureStarted();
    if (started !== undefined) return started;
    const child = this.child!;
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? RESIDENT_ENGINE_TIMEOUT_MS;
    return new Promise<ResidentEngineOutcome>((resolve, reject) => {
      const entry: Pending = {
        resolve,
        timer: setTimeout(() => {
          this.settle(id, {
            ok: false,
            kind: 'unavailable',
            reason: 'timeout',
            message: `hoi4-engine ${op} did not answer within ${timeoutMs} ms`,
          });
        }, timeoutMs),
      };
      if (options.signal !== undefined) {
        const signal = options.signal;
        entry.signal = signal;
        entry.onAbort = () => {
          const current = this.pending.get(id);
          if (current === undefined) return;
          clearTimeout(current.timer);
          this.pending.delete(id);
          this.updateRef();
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new Error('The engine request was cancelled'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.updateRef();
      const line = `${JSON.stringify({ ...body, id, op, payload: payload?.length ?? 0 })}\n`;
      child.stdin.write(line);
      if (payload !== undefined && payload.length > 0) child.stdin.write(payload);
    });
  }

  /** Stops the process; requests in flight fail as unavailable. */
  close(): void {
    this.closed = true;
    this.stop('the resident engine was closed');
  }

  private ensureStarted(): ResidentEngineOutcome | undefined {
    if (this.child !== undefined) return undefined;
    if (this.crashes >= RESIDENT_ENGINE_MAX_RESTARTS)
      return {
        ok: false,
        kind: 'unavailable',
        reason: 'exit_status',
        message: `hoi4-engine serve stopped ${this.crashes} times in a row: ${this.stderrTail.trim().slice(-300)}`,
      };
    const located = locateEngineBinary(this.options);
    if (!('path' in located))
      return { ok: false, kind: 'unavailable', reason: located.reason, message: located.message };
    this.binary = located;
    // A JavaScript engine (a development wrapper or a test double) runs under this Node.
    const script = /\.(?:c|m)?js$/iu.test(located.path);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        script ? process.execPath : located.path,
        script ? [located.path, 'serve'] : ['serve'],
        {
          shell: false,
          windowsHide: true,
          env: this.options.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      return {
        ok: false,
        kind: 'unavailable',
        reason: 'spawn_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.child = child;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.header = undefined;
    child.stdout.on('data', (chunk: Buffer) => this.onData(child, chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => this.onExit(child, `hoi4-engine serve failed: ${error.message}`));
    child.on('close', (code, signal) =>
      this.onExit(
        child,
        `hoi4-engine serve exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`,
      ),
    );
    this.updateRef();
    return undefined;
  }

  /** Keeps Node alive only while a request waits, so an idle engine never holds the server open. */
  private updateRef(): void {
    const child = this.child;
    if (child === undefined) return;
    const waiting = this.pending.size > 0;
    if (waiting) child.ref();
    else child.unref();
    // The pipes are sockets at run time, which Node's stream types do not say.
    for (const stream of [child.stdout, child.stderr, child.stdin]) {
      const socket = stream as unknown as { ref?: () => void; unref?: () => void };
      if (waiting) socket.ref?.();
      else socket.unref?.();
    }
  }

  private take(bytes: number): Buffer {
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const head = all.subarray(0, bytes);
    const rest = all.subarray(bytes);
    this.buffered = rest.length === 0 ? [] : [rest];
    this.bufferedBytes = rest.length;
    return head;
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.length;
    for (;;) {
      if (this.header === undefined) {
        const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
        this.buffered = all.length === 0 ? [] : [all];
        const newline = all.indexOf(0x0a);
        if (newline < 0) {
          if (all.length > RESIDENT_ENGINE_MAX_HEADER_BYTES)
            this.stop('hoi4-engine serve printed an oversized response header');
          return;
        }
        const line = this.take(newline + 1).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.stop('hoi4-engine serve printed a response that is not JSON');
          return;
        }
        const id = typeof body.id === 'number' ? body.id : -1;
        const payload = body.ok === true && typeof body.payload === 'number' ? body.payload : 0;
        if (
          !Number.isSafeInteger(payload) ||
          payload < 0 ||
          payload > RESIDENT_ENGINE_MAX_PAYLOAD_BYTES
        ) {
          this.stop('hoi4-engine serve announced an invalid payload size');
          return;
        }
        this.header = { id, body, payload };
      }
      const header = this.header;
      if (this.bufferedBytes < header.payload) return;
      const payload =
        header.payload === 0 ? Buffer.alloc(0) : Buffer.from(this.take(header.payload));
      this.header = undefined;
      this.crashes = 0;
      const body = header.body;
      if (body.ok === true) {
        const result =
          typeof body.result === 'object' && body.result !== null
            ? (body.result as Record<string, unknown>)
            : {};
        this.settle(header.id, { ok: true, response: { result, payload } });
      } else {
        const error =
          typeof body.error === 'object' && body.error !== null
            ? (body.error as Record<string, unknown>)
            : {};
        const { code, message, ...details } = error;
        this.settle(header.id, {
          ok: false,
          kind: 'error',
          code: typeof code === 'string' ? code : 'error',
          message: typeof message === 'string' ? message : 'the engine reported an error',
          details,
        });
      }
    }
  }

  private settle(id: number, outcome: ResidentEngineOutcome): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    if (entry.onAbort !== undefined) entry.signal?.removeEventListener('abort', entry.onAbort);
    this.pending.delete(id);
    this.updateRef();
    entry.resolve(outcome);
  }

  private onExit(child: ChildProcessWithoutNullStreams, message: string): void {
    if (child !== this.child) return;
    this.child = undefined;
    if (!this.closed) this.crashes += 1;
    this.failAll(
      `${message}${this.stderrTail.trim() === '' ? '' : `: ${this.stderrTail.trim().slice(-300)}`}`,
    );
  }

  private stop(message: string): void {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) {
      if (!this.closed) this.crashes += 1;
      child.kill();
    }
    this.failAll(message);
  }

  private failAll(message: string): void {
    for (const id of [...this.pending.keys()])
      this.settle(id, { ok: false, kind: 'unavailable', reason: 'exit_status', message });
  }
}

let shared: ResidentEngine | undefined;

/** The server-wide resident engine (one process per server). */
export function sharedResidentEngine(): ResidentEngine {
  shared ??= new ResidentEngine();
  return shared;
}

/** Test hook: replaces the shared engine and closes the old one. */
export function replaceSharedResidentEngine(engine: ResidentEngine | undefined): void {
  shared?.close();
  shared = engine;
}
