import { ServiceError } from './result.js';

interface PendingRequest {
  owner: object;
  bytes: number;
  start: () => void;
  cancel: () => void;
}

/** Shares execution capacity across all sessions using an engine, with fair, cancellable waits. */
export class RequestScheduler {
  private active = 0;
  private pendingBytes = 0;
  private readonly pending: PendingRequest[] = [];
  private lastOwner: object | undefined;

  constructor(
    private readonly capacity = 2,
    private readonly maxPending = 1024,
    private readonly maxPendingBytes = 134_217_728,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Execution capacity must be a positive integer');
    }
  }

  async run<T>(
    owner: object,
    bytes: number,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      if (
        this.pending.length >= this.maxPending ||
        bytes > this.maxPendingBytes - this.pendingBytes
      ) {
        reject(
          new ServiceError(
            'REQUEST_QUEUE_FULL',
            'The server request queue is full; retry after current work completes',
          ),
        );
        return;
      }
      const entry: PendingRequest = {
        owner,
        bytes,
        start: () => {
          signal.removeEventListener('abort', entry.cancel);
          this.active += 1;
          this.lastOwner = owner;
          resolve();
        },
        cancel: () => {
          const index = this.pending.indexOf(entry);
          if (index < 0) return;
          this.pending.splice(index, 1);
          this.pendingBytes -= bytes;
          signal.removeEventListener('abort', entry.cancel);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException('Request cancelled', 'AbortError'),
          );
          this.drain();
        },
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.pending.push(entry);
      this.pendingBytes += bytes;
      this.drain();
    });
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.capacity && this.pending.length > 0) {
      const other = this.pending.findIndex(({ owner }) => owner !== this.lastOwner);
      const entry = this.pending.splice(Math.max(0, other), 1)[0]!;
      this.pendingBytes -= entry.bytes;
      entry.start();
    }
  }
}
