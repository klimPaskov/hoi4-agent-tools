import { describe, expect, it } from 'vitest';
import {
  BoundedEventStore,
  SharedEventStoreBudget,
} from '../../src/hoi4_agent_tools/mcp/transports/event-store.js';

describe('bounded Streamable HTTP event store', () => {
  it('replays only the selected stream after an event ID and evicts bounded history', async () => {
    const store = new BoundedEventStore(3, 60_000);
    const first = await store.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'a', progress: 1 },
    });
    const second = await store.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'a', progress: 2 },
    });
    await store.storeEvent('stream-b', {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'b', progress: 1 },
    });
    const fourth = await store.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'a', progress: 3 },
    });

    await expect(store.getStreamIdForEventId(first)).resolves.toBeUndefined();
    const replayed: string[] = [];
    await expect(
      store.replayEventsAfter(second, {
        send: async (eventId) => {
          replayed.push(eventId);
        },
      }),
    ).resolves.toBe('stream-a');
    expect(replayed).toEqual([fourth]);
  });

  it('expires old event IDs deterministically', async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const store = new BoundedEventStore(10, 1000);
      const eventId = await store.storeEvent('stream-a', {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'a', progress: 1 },
      });
      now += 1001;
      await expect(store.getStreamIdForEventId(eventId)).resolves.toBeUndefined();
      await expect(
        store.replayEventsAfter(eventId, { send: async () => undefined }),
      ).rejects.toThrow(/unknown or expired/iu);
    } finally {
      Date.now = realNow;
    }
  });

  it('evicts by serialized bytes and never retains one oversized event', async () => {
    const store = new BoundedEventStore(100, 60_000, 220);
    const first = await store.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'a'.repeat(40) },
    });
    const second = await store.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'b'.repeat(40) },
    });
    expect(await store.getStreamIdForEventId(first)).toBeUndefined();
    expect(await store.getStreamIdForEventId(second)).toBe('stream-a');

    const oversized = await store.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'x'.repeat(1000) },
    });
    expect(await store.getStreamIdForEventId(second)).toBe('stream-a');
    expect(await store.getStreamIdForEventId(oversized)).toBeUndefined();
  });

  it('shares one global byte ceiling across session stores and releases it on close', async () => {
    const budget = new SharedEventStoreBudget(240);
    const firstStore = new BoundedEventStore(10, 60_000, 220, budget);
    const secondStore = new BoundedEventStore(10, 60_000, 220, budget);
    const first = await firstStore.storeEvent('stream-a', {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'a'.repeat(40) },
    });
    const blocked = await secondStore.storeEvent('stream-b', {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'b'.repeat(40) },
    });
    expect(await firstStore.getStreamIdForEventId(first)).toBe('stream-a');
    expect(await secondStore.getStreamIdForEventId(blocked)).toBeUndefined();
    firstStore.clear();
    const admitted = await secondStore.storeEvent('stream-b', {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'c'.repeat(40) },
    });
    expect(await secondStore.getStreamIdForEventId(admitted)).toBe('stream-b');
  });
});
