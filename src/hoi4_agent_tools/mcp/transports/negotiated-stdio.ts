import type { Readable, Writable } from 'node:stream';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Transport as ModernTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CoreEngine } from '../../core/engine.js';
import type { PluginToolFactory } from '../plugins.js';
import { progressReporter } from '../server/progress.js';
import { createMcpServer } from '../server/create.js';
import { createModernOperationServer } from '../server/create-modern-operations.js';
import { BoundedStdioServerTransport, STDIO_MAX_FRAME_BYTES } from './bounded-stdio.js';
import { FinalProtocolTransport } from './protocol-gate.js';

const MAX_QUEUED_MESSAGES = 128;

/**
 * Requests that only describe the server. They are answered while startup recovery still runs;
 * every other message waits for it, in arrival order, so no request reads or writes a workspace
 * whose interrupted rewrite is not yet recovered.
 */
const ANSWERED_BEFORE_RECOVERY: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'server/discover',
  'tools/list',
  'prompts/list',
  'logging/setLevel',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Modern discovery or metadata selects the modern connection; initialize selects legacy. */
export function isModernStdioOpening(message: JSONRPCMessage): boolean {
  if (!('method' in message)) return false;
  if (message.method === 'server/discover') return true;
  if (message.method === 'initialize' || !('params' in message)) return false;
  const params: unknown = message.params;
  const meta = isRecord(params) ? params._meta : undefined;
  return (
    isRecord(meta) && Object.keys(meta).some((key) => key.startsWith('io.modelcontextprotocol/'))
  );
}

/** One logical SDK connection over the already-started bounded physical stream. */
class PinnedStdioTransport implements Transport {
  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  private started = false;
  private queuedBytes = 0;
  private readonly queue: JSONRPCMessage[] = [];

  constructor(
    private readonly physical: BoundedStdioServerTransport,
    private readonly reportError: (error: Error) => void,
  ) {}

  receive(message: JSONRPCMessage): void {
    if (this.started) {
      this.onmessage(message);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (
      this.queue.length >= MAX_QUEUED_MESSAGES ||
      bytes > STDIO_MAX_FRAME_BYTES - this.queuedBytes
    ) {
      const error = new Error('Stdio negotiation queue exceeded its bounded limit');
      this.reportError(error);
      this.onerror(error);
      void this.physical.close();
      return;
    }
    this.queue.push(message);
    this.queuedBytes += bytes;
  }

  start(): Promise<void> {
    if (this.started) throw new Error('Negotiated stdio transport already started');
    this.started = true;
    for (const message of this.queue.splice(0)) this.onmessage(message);
    this.queuedBytes = 0;
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.physical.send(message);
  }

  close(): Promise<void> {
    return this.physical.close();
  }
}

export interface NegotiatedStdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  /** The tools of the configured plugins (M-14); the server lists them beside its own. */
  plugins?: PluginToolFactory;
  onerror: (error: Error) => void;
  onFailure: (error: unknown) => void;
  /** Observes every message in both directions, for example to track client activity. */
  observer?: { received(message: unknown): void; sent(message: unknown): void };
}

/** Pin the protocol generation on the first message while retaining the old bounded wire. */
export async function serveNegotiatedStdio(
  engine: CoreEngine,
  options: NegotiatedStdioOptions,
): Promise<BoundedStdioServerTransport> {
  const physical = new BoundedStdioServerTransport({
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
  });
  let pinned: PinnedStdioTransport | undefined;
  const reportedErrors = new WeakSet<Error>();
  const reportError = (error: Error): void => {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
    options.onerror(error);
  };
  const observer = options.observer;
  if (observer !== undefined) {
    const send = physical.send.bind(physical);
    physical.send = (message) => {
      observer.sent(message);
      return send(message);
    };
  }
  physical.onclose = () => pinned?.onclose();
  physical.onerror = (error) => {
    reportError(error);
    pinned?.onerror(error);
  };
  const deliver = (message: JSONRPCMessage): void => {
    if (pinned === undefined) {
      pinned = new PinnedStdioTransport(physical, reportError);
      try {
        if (isModernStdioOpening(message)) {
          serveStdio(
            () =>
              createModernOperationServer(
                engine,
                {},
                undefined,
                options.plugins === undefined ? {} : { createPrivateTools: options.plugins },
              ),
            {
              transport: pinned as unknown as ModernTransport,
              legacy: 'reject',
              onerror: reportError,
            },
          );
        } else {
          const server = createMcpServer(engine, {});
          if (options.plugins !== undefined)
            for (const tool of options.plugins(engine, {})) {
              const { name, ...definition } = tool.definition;
              server.registerTool(name, definition, (input, extra) =>
                tool.call(input, progressReporter(extra)),
              );
            }
          server.server.onerror = reportError;
          void server.connect(new FinalProtocolTransport(pinned)).catch((error: unknown) => {
            options.onFailure(error);
            void physical.close();
          });
        }
      } catch (error) {
        options.onFailure(error);
        void physical.close();
        return;
      }
    }
    pinned.receive(message);
  };
  // Startup recovery: `held` until it ends, then `open`; `closed` drops every later message.
  let recovery: 'held' | 'open' | 'closed' = 'held';
  let heldBytes = 0;
  const held: JSONRPCMessage[] = [];
  const closeHeld = (): void => {
    recovery = 'closed';
    held.length = 0;
    heldBytes = 0;
    void physical.close();
  };
  engine.recovered().then(
    () => {
      if (recovery === 'closed') return;
      recovery = 'open';
      heldBytes = 0;
      for (const message of held.splice(0)) deliver(message);
    },
    (error: unknown) => {
      if (recovery === 'closed') return;
      options.onFailure(error);
      closeHeld();
    },
  );
  physical.onmessage = (message) => {
    observer?.received(message);
    if (recovery === 'closed') return;
    if (
      recovery === 'open' ||
      (held.length === 0 &&
        (!('method' in message) || ANSWERED_BEFORE_RECOVERY.has(message.method)))
    ) {
      deliver(message);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (held.length >= MAX_QUEUED_MESSAGES || bytes > STDIO_MAX_FRAME_BYTES - heldBytes) {
      reportError(new Error('Requests held during startup recovery exceeded their bounded limit'));
      closeHeld();
      return;
    }
    held.push(message);
    heldBytes += bytes;
  };
  await physical.start();
  return physical;
}
