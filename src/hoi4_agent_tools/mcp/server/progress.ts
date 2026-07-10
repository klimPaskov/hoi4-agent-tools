import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export interface ProgressReporter {
  report(progress: number, total: number, message: string): Promise<void>;
  signal: AbortSignal;
}

export function progressReporter(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ProgressReporter {
  let latest = Number.NEGATIVE_INFINITY;
  return {
    signal: extra.signal,
    async report(progress: number, total: number, message: string): Promise<void> {
      extra.signal.throwIfAborted();
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
  };
}
