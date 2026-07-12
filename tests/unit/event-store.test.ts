import { describe, expect, it } from 'vitest';
import {
  HTTP_DEFAULT_SESSION_EVENT_BYTES,
  serverConfigurationSchema,
} from '../../src/hoi4_agent_tools/core/configuration.js';
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

  it('retains one maximum raw artifact chunk under the default session budget', async () => {
    const http = serverConfigurationSchema.parse({ version: 1 }).http;
    expect(http.maxSessionEventBytes).toBe(HTTP_DEFAULT_SESSION_EVENT_BYTES);
    expect(http.maxEventStoreBytes).toBe(16_777_216);
    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      result: {
        contents: [
          {
            uri: 'artifact://limited/review.bin',
            mimeType: 'application/octet-stream',
            blob: Buffer.alloc(1_048_576).toString('base64'),
          },
        ],
      },
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(message));
    expect(serializedBytes).toBeGreaterThan(1_048_576);
    expect(serializedBytes).toBeLessThan(http.maxSessionEventBytes);

    const store = new BoundedEventStore(
      1000,
      60_000,
      http.maxSessionEventBytes,
      new SharedEventStoreBudget(http.maxEventStoreBytes),
    );
    const eventId = await store.storeEvent('stream-a', message);
    await expect(store.getStreamIdForEventId(eventId)).resolves.toBe('stream-a');
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
