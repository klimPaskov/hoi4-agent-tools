import { randomUUID } from 'node:crypto';
import type {
  EventId,
  EventStore,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface StoredEvent {
  eventId: string;
  streamId: string;
  message: JSONRPCMessage;
  createdAt: number;
  size: number;
}

export class BoundedEventStore implements EventStore {
  readonly #events: StoredEvent[] = [];
  #bytes = 0;

  public constructor(
    private readonly maxEvents = 1000,
    private readonly ttlMs = 3_600_000,
    private readonly maxBytes = 4_194_304,
    private readonly sharedBudget?: SharedEventStoreBudget,
  ) {}

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    this.prune();
    const eventId = randomUUID();
    const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (size > this.maxBytes || this.sharedBudget?.reserve(size) === false) {
      return Promise.resolve(eventId);
    }
    this.#events.push({ eventId, streamId, message, createdAt: Date.now(), size });
    this.#bytes += size;
    while (this.#events.length > this.maxEvents || this.#bytes > this.maxBytes) {
      const removed = this.#events.shift();
      if (removed !== undefined) this.release(removed);
    }
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    this.prune();
    return Promise.resolve(this.#events.find((event) => event.eventId === eventId)?.streamId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    this.prune();
    const index = this.#events.findIndex((event) => event.eventId === lastEventId);
    if (index < 0) throw new Error('Event ID is unknown or expired');
    const streamId = this.#events[index]!.streamId;
    for (const event of this.#events.slice(index + 1)) {
      if (event.streamId === streamId) await send(event.eventId, event.message);
    }
    return streamId;
  }

  private prune(): void {
    const minimum = Date.now() - this.ttlMs;
    while (this.#events[0] !== undefined && this.#events[0].createdAt < minimum) {
      const removed = this.#events.shift();
      if (removed !== undefined) this.release(removed);
    }
  }

  clear(): void {
    for (const event of this.#events) this.sharedBudget?.release(event.size);
    this.#events.splice(0);
    this.#bytes = 0;
  }

  private release(event: StoredEvent): void {
    this.#bytes -= event.size;
    this.sharedBudget?.release(event.size);
  }
}

export class SharedEventStoreBudget {
  #bytes = 0;

  public constructor(private readonly maxBytes: number) {}

  reserve(bytes: number): boolean {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.maxBytes ||
      this.#bytes > this.maxBytes - bytes
    ) {
      return false;
    }
    this.#bytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.#bytes = Math.max(0, this.#bytes - bytes);
  }
}
