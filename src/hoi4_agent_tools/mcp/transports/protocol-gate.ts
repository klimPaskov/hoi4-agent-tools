import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCP_PROTOCOL_VERSION } from '../../version.js';

const unsupportedVersionSentinel = 'hoi4-agent-tools-final-only';

function gateInitializeVersion(message: JSONRPCMessage): JSONRPCMessage {
  if (!isInitializeRequest(message) || message.params.protocolVersion === MCP_PROTOCOL_VERSION) {
    return message;
  }
  // SDK v1 negotiates every historical revision it knows. This server uses current-final
  // resource-link and structured-output semantics, so force the SDK's documented fallback
  // response to the sole production revision instead of claiming unimplemented feature gates.
  return {
    ...message,
    params: { ...message.params, protocolVersion: unsupportedVersionSentinel },
  };
}

/** Restrict a concrete product transport to the documented final MCP revision. */
export class FinalProtocolTransport implements Transport {
  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  public constructor(private readonly inner: Transport) {}

  async start(): Promise<void> {
    const innerClose = this.inner.onclose;
    const innerError = this.inner.onerror;
    this.inner.onclose = () => {
      innerClose?.();
      this.onclose();
    };
    this.inner.onerror = (error) => {
      innerError?.(error);
      this.onerror(error);
    };
    this.inner.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo): void => {
      this.onmessage(gateInitializeVersion(message), extra);
    };
    await this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}
