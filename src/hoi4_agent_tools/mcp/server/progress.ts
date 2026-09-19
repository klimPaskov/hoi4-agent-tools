import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ServerContext } from '@modelcontextprotocol/server';

export interface ProgressReporter {
  report(progress: number, total: number, message: string): Promise<void>;
  /**
   * Send a strictly increasing keep-alive notification during a long stage.
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
const reporters = new WeakMap<object, ProgressReporter>();
const heartbeatOwners = new WeakSet<ProgressReporter>();

type ProgressNotification = Extract<ServerNotification, { method: 'notifications/progress' }>;

export function progressReporter(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ProgressReporter {
  return reporterFor(extra, extra.signal, extra._meta?.progressToken, (notification) =>
    extra.sendNotification(notification),
  );
}

/** Use the SDK's request-related notification route, including HTTP response-stream association. */
export function modernProgressReporter(context: ServerContext): ProgressReporter {
  const request = context.mcpReq;
  return reporterFor(request, request.signal, request._meta?.progressToken, (notification) =>
    request.notify(notification),
  );
}

function reporterFor(
  owner: object,
  signal: AbortSignal,
  progressToken: string | number | undefined,
  notify: (notification: ProgressNotification) => Promise<void>,
): ProgressReporter {
  const existing = reporters.get(owner);
  if (existing !== undefined) return existing;
  let latest = Number.NEGATIVE_INFINITY;
  let latestTotal = 1;
  let latestMessage = 'Waiting for server execution capacity';
  const reporter: ProgressReporter = {
    signal,
    async report(progress: number, total: number, message: string): Promise<void> {
      signal.throwIfAborted();
      latestTotal = total;
      latestMessage = message;
      const normalized = Math.max(latest, Math.min(progress, total));
      if (progressToken === undefined) return;
      if (normalized <= latest) return;
      latest = normalized;
      await notify({
        method: 'notifications/progress',
        params: { progressToken, progress: normalized, total, message },
      }).catch(() => undefined);
    },
    async pulse(message = latestMessage): Promise<void> {
      signal.throwIfAborted();
      if (progressToken === undefined) return;
      // Use the next representably larger value rather than repeating a value, which
      // violates MCP progress ordering. These pulses do not invent completed work.
      latest = Number.isFinite(latest)
        ? latest + Math.max(1, Math.abs(latest)) * Number.EPSILON * 2
        : 0;
      await notify({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: latest,
          ...(latest <= latestTotal ? { total: latestTotal } : {}),
          message,
        },
      }).catch(() => undefined);
    },
  };
  reporters.set(owner, reporter);
  return reporter;
}

/**
 * Keep an MCP request alive while a domain service is in a long, opaque asynchronous stage.
 * Progress notifications are best-effort: a disconnected client must not turn a successful
 * server operation into a partial result, while the request's AbortSignal still cancels work.
 */
export async function withProgressHeartbeat<T>(
  operation: Promise<T> | (() => Promise<T>),
  reporter: ProgressReporter,
  message?: string,
  intervalMs = PROGRESS_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Progress heartbeat interval must be a positive finite number');
  }
  reporter.signal.throwIfAborted();
  if (heartbeatOwners.has(reporter)) {
    return typeof operation === 'function' ? operation() : operation;
  }
  heartbeatOwners.add(reporter);
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
    heartbeatOwners.delete(reporter);
  }
}
