import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export interface ProgressReporter {
  report(progress: number, total: number, message: string): Promise<void>;
  /**
   * Send a keep-alive progress notification without advancing the reported work value.
   * MCP clients can use these notifications to reset their per-request idle timeout while a
   * large operation is still running.
   */
  pulse(message?: string): Promise<void>;
  signal: AbortSignal;
}

/**
 * Interval used for long-running MCP operations. It is shorter than the request timeout used by
 * common MCP clients, while still keeping notification traffic negligible for ordinary calls.
 */
export const PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000;

export function progressReporter(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ProgressReporter {
  let latest = Number.NEGATIVE_INFINITY;
  let latestTotal = 1;
  let latestMessage = '';
  return {
    signal: extra.signal,
    async report(progress: number, total: number, message: string): Promise<void> {
      extra.signal.throwIfAborted();
      latestTotal = total;
      latestMessage = message;
      const normalized = Math.max(latest, Math.min(progress, total));
      const progressToken = extra._meta?.progressToken;
      if (progressToken === undefined) return;
      if (normalized <= latest) return;
      latest = normalized;
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: normalized, total, message },
      });
    },
    async pulse(message = latestMessage): Promise<void> {
      extra.signal.throwIfAborted();
      const progressToken = extra._meta?.progressToken;
      if (progressToken === undefined) return;
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: Number.isFinite(latest) ? latest : 0,
          total: latestTotal,
          message,
        },
      });
    },
  };
}

/**
 * Keep an MCP request alive while a domain service is in a long, opaque asynchronous stage.
 * Progress notifications are best-effort: a disconnected client must not turn a successful
 * server operation into a partial result, while the request's AbortSignal still cancels work.
 */
export async function withProgressHeartbeat<T>(
  operation: Promise<T> | (() => Promise<T>),
  reporter: ProgressReporter,
  message: string,
  intervalMs = PROGRESS_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Progress heartbeat interval must be a positive finite number');
  }
  reporter.signal.throwIfAborted();
  let active = true;
  let inFlight = false;
  const tick = (): void => {
    if (!active || inFlight || reporter.signal.aborted) return;
    inFlight = true;
    void reporter
      .pulse(message)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  // Tell the client which opaque stage has started immediately. Waiting for the first interval
  // leaves short-but-expensive stages silent and makes keep-alive behavior scheduler-dependent.
  tick();
  try {
    return await (typeof operation === 'function' ? operation() : operation);
  } finally {
    active = false;
    clearInterval(timer);
  }
}
