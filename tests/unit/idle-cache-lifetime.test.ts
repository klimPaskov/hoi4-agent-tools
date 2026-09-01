import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleCacheLifetime } from '../../src/hoi4_agent_tools/core/idle-cache-lifetime.js';

describe('IdleCacheLifetime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases caches only after every concurrent tool call has been idle', async () => {
    vi.useFakeTimers();
    const releaseCaches = vi.fn();
    const compactHeap = vi.fn();
    const lifetime = new IdleCacheLifetime(releaseCaches, 100, compactHeap);
    const endFirst = lifetime.begin();
    const endSecond = lifetime.begin();

    endFirst();
    await vi.advanceTimersByTimeAsync(200);
    expect(releaseCaches).not.toHaveBeenCalled();

    endSecond();
    await vi.advanceTimersByTimeAsync(99);
    expect(releaseCaches).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(releaseCaches).toHaveBeenCalledTimes(1);
    expect(compactHeap).toHaveBeenCalledTimes(1);
  });

  it('cancels pending release when another call starts', async () => {
    vi.useFakeTimers();
    const releaseCaches = vi.fn();
    const lifetime = new IdleCacheLifetime(releaseCaches, 100);
    lifetime.begin()();
    await vi.advanceTimersByTimeAsync(50);

    const endNext = lifetime.begin();
    await vi.advanceTimersByTimeAsync(100);
    expect(releaseCaches).not.toHaveBeenCalled();
    endNext();
    await vi.advanceTimersByTimeAsync(100);
    expect(releaseCaches).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failures on stderr without terminating the server', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const compactHeap = vi.fn();
    const lifetime = new IdleCacheLifetime(
      () => {
        throw new Error('cleanup failed');
      },
      30_000,
      compactHeap,
    );

    expect(() => lifetime.clearNow()).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('cache_release_failed'));
    expect(compactHeap).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it('defers cache release and heap compaction while another domain is active', async () => {
    vi.useFakeTimers();
    const releaseFirst = vi.fn();
    const compactFirst = vi.fn();
    const releaseSecond = vi.fn();
    const compactSecond = vi.fn();
    const first = new IdleCacheLifetime(releaseFirst, 100, compactFirst);
    const second = new IdleCacheLifetime(releaseSecond, 100, compactSecond);
    const endFirst = first.begin();
    const endSecond = second.begin();

    endFirst();
    await vi.advanceTimersByTimeAsync(100);
    expect(releaseFirst).not.toHaveBeenCalled();
    expect(compactFirst).not.toHaveBeenCalled();

    endSecond();
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(compactFirst).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(releaseSecond).toHaveBeenCalledTimes(1);
    expect(compactSecond).toHaveBeenCalledTimes(1);
  });
});
