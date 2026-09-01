export const DEFAULT_IDLE_CACHE_RELEASE_MS = 30_000;

/** Keeps reusable analysis caches alive across an immediate tool sequence, then releases them. */
export class IdleCacheLifetime {
  #active = 0;
  #timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly releaseCaches: () => void,
    private readonly idleMs = DEFAULT_IDLE_CACHE_RELEASE_MS,
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
  }

  public begin(): () => void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#active += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#active = Math.max(0, this.#active - 1);
      if (this.#active !== 0) return;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        if (this.#active === 0) this.release();
      }, this.idleMs);
      this.#timer.unref();
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
    if (this.#active === 0) this.release();
  }
}
