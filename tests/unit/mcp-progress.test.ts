import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  modernProgressReporter,
  progressReporter,
  withProgressHeartbeat,
} from '../../src/hoi4_agent_tools/mcp/server/progress.js';

afterEach(() => vi.useRealTimers());

type ProgressNotification = Extract<ServerNotification, { method: 'notifications/progress' }>;

function modernContext(
  notify: (notification: ProgressNotification) => Promise<void>,
  token: string | number | undefined,
  signal = new AbortController().signal,
): ServerContext {
  return {
    mcpReq: {
      signal,
      ...(token === undefined ? {} : { _meta: { progressToken: token } }),
      notify,
    },
  } as unknown as ServerContext;
}

describe('MCP progress reporting', () => {
  it.each([0, '', 'modern-progress'])(
    'preserves modern progress token %j and per-request ordering',
    async (token) => {
      const notifications: ProgressNotification[] = [];
      const context = modernContext(async (notification) => {
        notifications.push(notification);
      }, token);
      const reporter = modernProgressReporter(context);
      expect(modernProgressReporter({ ...context })).toBe(reporter);
      await reporter.report(0, 3, 'started');
      await modernProgressReporter(context).report(0, 3, 'duplicate');
      await reporter.report(2, 3, 'retrieving');
      await reporter.report(3, 3, 'complete');
      expect(notifications).toEqual(
        [0, 2, 3].map((progress) => ({
          method: 'notifications/progress',
          params: { progressToken: token, progress, total: 3, message: expect.any(String) },
        })),
      );
    },
  );

  it('does not notify an unrequested modern token or share state between request contexts', async () => {
    const notify = vi.fn(async (_notification: ProgressNotification) => undefined);
    const silent = modernProgressReporter(modernContext(notify, undefined));
    await silent.report(1, 3, 'silent');
    await silent.pulse();
    expect(notify).not.toHaveBeenCalled();
    const first = modernProgressReporter(modernContext(notify, 'reused-after-completion'));
    const second = modernProgressReporter(modernContext(notify, 'reused-after-completion'));
    expect(first).not.toBe(second);
    await first.report(3, 3, 'first complete');
    await second.report(0, 3, 'next request');
    expect(notify.mock.calls.map(([notification]) => notification.params.progress)).toEqual([3, 0]);
  });

  it('treats modern notification delivery failures as best-effort without losing cancellation', async () => {
    const controller = new AbortController();
    const notify = vi.fn(async (_notification: ProgressNotification) => {
      throw new Error('Disconnected test transport');
    });
    const reporter = modernProgressReporter(modernContext(notify, 0, controller.signal));
    await expect(reporter.report(0, 3, 'start')).resolves.toBeUndefined();
    await expect(reporter.pulse()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(reporter.report(3, 3, 'cancelled')).rejects.toThrow();
    await expect(reporter.pulse()).rejects.toThrow();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  describe.each(['legacy', 'modern'] as const)('%s heartbeat lifecycle', (era) => {
    it.each(['success', 'failure', 'abort'] as const)(
      'clears nested heartbeat timers after %s',
      async (ending) => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const notify = vi.fn(async (_notification: ProgressNotification) => undefined);
        const reporter =
          era === 'modern'
            ? modernProgressReporter(modernContext(notify, 'timer-proof', controller.signal))
            : progressReporter({
                signal: controller.signal,
                _meta: { progressToken: 'timer-proof' },
                sendNotification: notify,
              } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>);
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const operation = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const error = new Error('Synthetic operation end');
        controller.signal.addEventListener('abort', () => reject(error), { once: true });
        const outcome = withProgressHeartbeat(
          () => withProgressHeartbeat(operation, reporter, 'nested', 5),
          reporter,
          'outer',
          5,
        ).then(
          () => 'success',
          (reason: unknown) => reason,
        );
        await vi.advanceTimersByTimeAsync(20);
        expect(vi.getTimerCount()).toBe(1);
        expect(notify.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(
          notify.mock.calls.every(([notification]) => notification.params.message === 'outer'),
        ).toBe(true);
        if (ending === 'success') resolve();
        else if (ending === 'failure') reject(error);
        else controller.abort();
        expect(await outcome).toBe(ending === 'success' ? 'success' : error);
        const count = notify.mock.calls.length;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(notify).toHaveBeenCalledTimes(count);
      },
    );
  });

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

  it('sends strictly increasing pulses and shares ordering across lifecycle and domain reporters', async () => {
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
    await progressReporter(extra).pulse('still scanning');
    await reporter.pulse('still scanning');

    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toEqual({ progress: 1, total: 4, message: 'scanning' });
    expect(notifications[1]!.progress).toBeGreaterThan(notifications[0]!.progress);
    expect(notifications[2]!.progress).toBeGreaterThan(notifications[1]!.progress);
    await reporter.report(2, 4, 'next stage');
    expect(notifications.at(-1)!.progress).toBe(2);
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
