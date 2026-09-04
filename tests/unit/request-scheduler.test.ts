import { describe, expect, it } from 'vitest';
import { RequestScheduler } from '../../src/hoi4_agent_tools/core/request-scheduler.js';

describe('shared request scheduler', () => {
  it('finishes a burst of 100 calls without exceeding execution capacity', async () => {
    const scheduler = new RequestScheduler(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, id) =>
        scheduler.run({}, 100, new AbortController().signal, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active -= 1;
          return id;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 100 }, (_, id) => id));
    expect(peak).toBe(3);
  });

  it('removes cancelled waiters, frees byte reservations, and fairly admits another session', async () => {
    const scheduler = new RequestScheduler(1, 3, 300);
    const firstOwner = {};
    const otherOwner = {};
    const order: string[] = [];
    let release!: () => void;
    const first = scheduler.run(
      firstOwner,
      100,
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const controller = new AbortController();
    const cancelled = scheduler.run(firstOwner, 200, controller.signal, async () => {
      throw new Error('Cancelled work must not execute');
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const same = scheduler.run(firstOwner, 100, new AbortController().signal, async () => {
      order.push('same');
    });
    const other = scheduler.run(otherOwner, 100, new AbortController().signal, async () => {
      order.push('other');
    });
    release();
    await Promise.all([first, same, other]);
    expect(order).toEqual(['other', 'same']);
  });

  it('recovers capacity after failures and refuses oversized queued inputs', async () => {
    const scheduler = new RequestScheduler(1, 2, 200);
    await expect(
      scheduler.run({}, 201, new AbortController().signal, async () => 1),
    ).rejects.toMatchObject({ code: 'REQUEST_QUEUE_FULL' });
    await expect(
      scheduler.run({}, 100, new AbortController().signal, async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
    await expect(scheduler.run({}, 100, new AbortController().signal, async () => 2)).resolves.toBe(
      2,
    );
  });

  it('rotates across every waiting session instead of alternating only the first two', async () => {
    const scheduler = new RequestScheduler(1);
    const owners = [{}, {}, {}, {}];
    const order: number[] = [];
    let release!: () => void;
    const first = scheduler.run(owners[0]!, 1, new AbortController().signal, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Promise.resolve();
    const queued = owners.flatMap((owner, id) =>
      Array.from({ length: 12 }, () =>
        scheduler.run(owner, 1, new AbortController().signal, async () => {
          order.push(id);
        }),
      ),
    );
    release();
    await Promise.all([first, ...queued]);
    for (let index = 0; index < order.length; index += owners.length) {
      expect(new Set(order.slice(index, index + owners.length)).size).toBe(owners.length);
    }
  });
});
