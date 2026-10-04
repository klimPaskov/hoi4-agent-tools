import { describe, expect, it } from 'vitest';
import {
  isWindowsSharingViolation,
  retryWindowsSharing,
  sharingRetryDelay,
} from '../../src/hoi4_agent_tools/core/windows-sharing.js';

const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

describe('Windows sharing-violation retries', () => {
  it('backs off from five milliseconds to a one-hundred-millisecond cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(sharingRetryDelay)).toEqual([
      5, 10, 20, 40, 80, 100, 100, 100,
    ]);
  });

  it('classifies only transient Windows sharing codes', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES'])
      expect(isWindowsSharingViolation(failure(code), 'win32')).toBe(true);
    for (const code of ['ENOENT', 'EEXIST', 'EMFILE'])
      expect(isWindowsSharingViolation(failure(code), 'win32')).toBe(false);
    expect(isWindowsSharingViolation(failure('EPERM'), 'linux')).toBe(false);
    expect(isWindowsSharingViolation('EPERM', 'win32')).toBe(false);
    expect(isWindowsSharingViolation({ code: 7 }, 'win32')).toBe(false);
  });

  it('returns the first success after transient failures', async () => {
    const waits: number[] = [];
    let attempts = 0;
    expect(
      await retryWindowsSharing(
        async () => {
          attempts += 1;
          if (attempts < 4) throw failure(attempts % 2 === 0 ? 'EBUSY' : 'EPERM');
          return 'published';
        },
        { platform: 'win32', wait: async (milliseconds) => void waits.push(milliseconds) },
      ),
    ).toBe('published');
    expect(waits).toEqual([5, 10, 20]);
  });

  it('rethrows the final error unchanged after the bounded attempts', async () => {
    const persistent = failure('EACCES');
    let attempts = 0;
    await expect(
      retryWindowsSharing(
        async () => {
          attempts += 1;
          throw persistent;
        },
        { platform: 'win32', maxAttempts: 7, wait: async () => undefined },
      ),
    ).rejects.toBe(persistent);
    expect(attempts).toBe(7);
  });

  it('never retries other codes or other platforms', async () => {
    for (const [platform, code] of [
      ['win32', 'ENOENT'],
      ['linux', 'EPERM'],
      ['darwin', 'EBUSY'],
    ] as const) {
      let attempts = 0;
      await expect(
        retryWindowsSharing(
          async () => {
            attempts += 1;
            throw failure(code);
          },
          { platform, wait: async () => undefined },
        ),
      ).rejects.toMatchObject({ code });
      expect(attempts).toBe(1);
    }
  });

  it('stops waiting when its signal is aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;
    await expect(
      retryWindowsSharing(
        async () => {
          attempts += 1;
          controller.abort(new Error('cancelled by caller'));
          throw failure('EBUSY');
        },
        { platform: 'win32', signal: controller.signal, wait: async () => undefined },
      ),
    ).rejects.toThrow('cancelled by caller');
    expect(attempts).toBe(1);
  });

  it('rejects an invalid attempt budget before touching the filesystem', async () => {
    let attempts = 0;
    for (const maxAttempts of [0, 1.5, Number.NaN])
      await expect(
        retryWindowsSharing(
          async () => {
            attempts += 1;
          },
          { maxAttempts },
        ),
      ).rejects.toBeInstanceOf(RangeError);
    expect(attempts).toBe(0);
  });
});
