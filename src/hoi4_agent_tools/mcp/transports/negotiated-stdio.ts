import type { Readable, Writable } from 'node:stream';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Transport as ModernTransport } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CoreEngine } from '../../core/engine.js';
import type { createChaosxToolOperations } from '../tools/chaosx.js';
import { createMcpServer } from '../server/create.js';
import { createModernOperationServer } from '../server/create-modern-operations.js';
import { BoundedStdioServerTransport, STDIO_MAX_FRAME_BYTES } from './bounded-stdio.js';
import { FinalProtocolTransport } from './protocol-gate.js';

const MAX_QUEUED_MESSAGES = 128;

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
  createModernPrivateTools?: typeof createChaosxToolOperations;
  registerLegacy?: (server: McpServer) => void;
  onerror: (error: Error) => void;
  onFailure: (error: unknown) => void;
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
  physical.onclose = () => pinned?.onclose();
  physical.onerror = (error) => {
    reportError(error);
    pinned?.onerror(error);
  };
  physical.onmessage = (message) => {
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
                options.createModernPrivateTools === undefined
                  ? {}
                  : { createPrivateTools: options.createModernPrivateTools },
              ),
            {
              transport: pinned as unknown as ModernTransport,
              legacy: 'reject',
              onerror: reportError,
            },
          );
        } else {
          const server = createMcpServer(engine, {});
          options.registerLegacy?.(server);
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
  await physical.start();
  return physical;
}
