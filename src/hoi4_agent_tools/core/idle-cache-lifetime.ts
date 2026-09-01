import { compactManagedHeap } from './managed-heap.js';

export const DEFAULT_IDLE_CACHE_RELEASE_MS = 30_000;

let activeCacheOperations = 0;
const deferredReleases = new Set<IdleCacheLifetime>();

function flushDeferredReleases(): void {
  if (activeCacheOperations !== 0) return;
  const ready = [...deferredReleases];
  deferredReleases.clear();
  for (const lifetime of ready) lifetime.releaseDeferred();
}

/** Keeps reusable analysis caches alive across an immediate tool sequence, then releases them. */
export class IdleCacheLifetime {
  #active = 0;
  #timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly releaseCaches: () => void,
    private readonly idleMs = DEFAULT_IDLE_CACHE_RELEASE_MS,
    private readonly compactHeap: () => unknown = compactManagedHeap,
  ) {}

  private release(): void {
    try {
      this.releaseCaches();
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'cache_release_failed',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
    try {
      this.compactHeap();
    } catch {
      // Heap compaction is best-effort maintenance. Cache release already succeeded.
    }
  }

  public releaseDeferred(): void {
    if (this.#active !== 0 || activeCacheOperations !== 0) {
      deferredReleases.add(this);
      return;
    }
    this.release();
  }

  public begin(): () => void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    deferredReleases.delete(this);
    this.#active += 1;
    activeCacheOperations += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#active = Math.max(0, this.#active - 1);
      activeCacheOperations = Math.max(0, activeCacheOperations - 1);
      if (this.#active === 0) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          if (this.#active !== 0) return;
          if (activeCacheOperations === 0) this.release();
          else deferredReleases.add(this);
        }, this.idleMs);
        this.#timer.unref();
      }
      flushDeferredReleases();
    };
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const end = this.begin();
    try {
      return await operation();
    } finally {
      end();
    }
  }

  public clearNow(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#active !== 0 || activeCacheOperations !== 0) deferredReleases.add(this);
    else this.release();
  }
}
