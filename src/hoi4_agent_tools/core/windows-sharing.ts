import { setTimeout as delay } from 'node:timers/promises';

/**
 * Error codes Windows reports while another handle blocks a replacement, or while a
 * removed name is still delete-pending. Other platforms never retry them.
 */
const sharingCodes: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface SharingRetryOptions {
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => Promise<unknown>;
  /** Total attempts, including the first. The default spans roughly twenty seconds. */
  maxAttempts?: number;
  signal?: AbortSignal;
}

/** Backoff before retry `attempt + 1`: 5, 10, 20, 40, 80, then 100 milliseconds. */
export function sharingRetryDelay(attempt: number): number {
  return Math.min(100, 5 * 2 ** Math.min(attempt - 1, 5));
}

export function isWindowsSharingViolation(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    sharingCodes.has(error.code)
  );
}

/**
 * Retry one idempotent filesystem step while Windows reports a transient sharing
 * violation. Concurrent readers, indexers, and scanners hold short-lived handles that
 * make rename, unlink, and open fail without any persistent permission problem.
 * The final error is rethrown unchanged once the bounded attempts are spent.
 */
export async function retryWindowsSharing<T>(
  operation: () => Promise<T>,
  options: SharingRetryOptions = {},
): Promise<T> {
  const platform = options.platform ?? process.platform;
  const wait = options.wait ?? delay;
  const maxAttempts = options.maxAttempts ?? 200;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError('Sharing-violation retry attempts must be a positive integer');
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isWindowsSharingViolation(error, platform) || attempt >= maxAttempts) throw error;
      options.signal?.throwIfAborted();
      await wait(sharingRetryDelay(attempt));
    }
  }
}
