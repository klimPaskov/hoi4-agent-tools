import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';

const unsupportedVersionSentinel = 'hoi4-agent-tools-final-only';

function gateInitializeVersion(message: JSONRPCMessage): JSONRPCMessage {
  if (
    !isInitializeRequest(message) ||
    SUPPORTED_PROTOCOL_VERSIONS.includes(message.params.protocolVersion)
  ) {
    return message;
  }
  // Unknown revisions cannot be negotiated. Rewrite them to an unsupported sentinel so the
  // SDK applies its documented fallback response (the latest supported revision) instead of
  // claiming unimplemented feature gates.
  return {
    ...message,
    params: { ...message.params, protocolVersion: unsupportedVersionSentinel },
  };
}

/** Let the SDK negotiate any revision it supports and fall back to the latest for unknown ones. */
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
