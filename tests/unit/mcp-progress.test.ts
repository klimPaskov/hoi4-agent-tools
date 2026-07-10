import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { progressReporter } from '../../src/hoi4_agent_tools/mcp/server/progress.js';

describe('MCP progress reporting', () => {
  it('emits only strictly increasing values for the active progress token', async () => {
    const notifications: number[] = [];
    const extra = {
      _meta: { progressToken: 'fixture-progress' },
      signal: new AbortController().signal,
      sendNotification: async (notification: ServerNotification) => {
        if (notification.method === 'notifications/progress') {
          notifications.push(notification.params.progress);
        }
      },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
    const reporter = progressReporter(extra);

    await reporter.report(0, 3, 'start');
    await reporter.report(0, 3, 'duplicate');
    await reporter.report(-1, 3, 'regression');
    await reporter.report(2, 3, 'work');
    await reporter.report(2, 3, 'duplicate');
    await reporter.report(4, 3, 'complete');

    expect(notifications).toEqual([0, 2, 3]);
  });
});
