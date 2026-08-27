import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  progressReporter,
  withProgressHeartbeat,
} from '../../src/hoi4_agent_tools/mcp/server/progress.js';

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

  it('sends repeated pulse notifications without changing progress ordering', async () => {
    const notifications: Array<{ progress: number; total: number; message?: string }> = [];
    const extra = {
      _meta: { progressToken: 'fixture-progress' },
      signal: new AbortController().signal,
      sendNotification: async (notification: ServerNotification) => {
        if (notification.method === 'notifications/progress') {
          notifications.push({
            progress: notification.params.progress,
            total: notification.params.total ?? 0,
            ...(notification.params.message === undefined
              ? {}
              : { message: notification.params.message }),
          });
        }
      },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
    const reporter = progressReporter(extra);

    await reporter.report(1, 4, 'scanning');
    await reporter.pulse('still scanning');
    await reporter.pulse('still scanning');

    expect(notifications).toEqual([
      { progress: 1, total: 4, message: 'scanning' },
      { progress: 1, total: 4, message: 'still scanning' },
      { progress: 1, total: 4, message: 'still scanning' },
    ]);
  });

  it('keeps a long operation alive with heartbeats and clears the timer on completion', async () => {
    const messages: string[] = [];
    const extra = {
      _meta: { progressToken: 'fixture-progress' },
      signal: new AbortController().signal,
      sendNotification: async (notification: ServerNotification) => {
        if (notification.method === 'notifications/progress') {
          messages.push(notification.params.message ?? '');
        }
      },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
    const reporter = progressReporter(extra);

    const result = await withProgressHeartbeat(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('complete'), 35);
        }),
      reporter,
      'large GUI stage',
      5,
    );

    expect(result).toBe('complete');
    expect(
      messages.filter((message) => message === 'large GUI stage').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('does not start an operation after the request has been cancelled', async () => {
    const controller = new AbortController();
    let started = false;
    const extra = {
      _meta: { progressToken: 'fixture-progress' },
      signal: controller.signal,
      sendNotification: async () => undefined,
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
    const reporter = progressReporter(extra);
    controller.abort();

    await expect(
      withProgressHeartbeat(
        () => {
          started = true;
          return Promise.resolve('unreachable');
        },
        reporter,
        'cancelled',
        5,
      ),
    ).rejects.toThrow();
    expect(started).toBe(false);
  });
});
