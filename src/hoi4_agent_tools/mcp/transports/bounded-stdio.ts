import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Stdio is a trusted local transport, but its byte stream is still untrusted input. This fixed
 * ceiling is large enough for the server's bounded inline tool arguments and matches the maximum
 * configurable Streamable HTTP JSON body size.
 */
export const STDIO_MAX_FRAME_BYTES = 16_777_216;
const INITIAL_FRAME_CAPACITY = 65_536;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class StdioFrameLimitError extends Error {
  readonly code = 'STDIO_FRAME_TOO_LARGE';

  public constructor(readonly maxFrameBytes: number) {
    super(`Stdio JSON-RPC frame exceeds the fixed ${maxFrameBytes}-byte limit`);
    this.name = 'StdioFrameLimitError';
  }
}

export class StdioInvalidUtf8Error extends Error {
  readonly code = 'STDIO_INVALID_UTF8';

  public constructor() {
    super('Stdio JSON-RPC frame is not valid UTF-8');
    this.name = 'StdioInvalidUtf8Error';
  }
}

export class StdioInvalidMessageError extends Error {
  readonly code = 'STDIO_INVALID_MESSAGE';

  public constructor() {
    super('Stdio frame is not a valid JSON-RPC message');
    this.name = 'StdioInvalidMessageError';
  }
}

export interface BoundedStdioTransportOptions {
  stdin?: Readable;
  stdout?: Writable;
  maxFrameBytes?: number;
}

/**
 * SDK-compatible newline-delimited stdio transport with a bounded, single-copy frame assembler.
 *
 * The upstream SDK ReadBuffer repeatedly concatenates an unterminated frame. This implementation
 * scans every byte once and uses a geometrically grown buffer, bounding both retained bytes and
 * chunk metadata while keeping aggregate copy work linear.
 */
export class BoundedStdioServerTransport implements Transport {
  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  private readonly input: Readable;
  private readonly output: Writable;
  private readonly maxFrameBytes: number;
  private frameBuffer: Buffer | undefined;
  private frameBytes = 0;
  private started = false;
  private closed = false;
  private writing = false;
  private queuedBytes = 0;
  private readonly writes: Array<{
    data: string;
    bytes: number;
    resolve(): void;
    reject(error: Error): void;
  }> = [];

  public constructor(options: BoundedStdioTransportOptions = {}) {
    this.input = options.stdin ?? process.stdin;
    this.output = options.stdout ?? process.stdout;
    this.maxFrameBytes = options.maxFrameBytes ?? STDIO_MAX_FRAME_BYTES;
    if (
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes < 1 ||
      this.maxFrameBytes > STDIO_MAX_FRAME_BYTES
    ) {
      throw new RangeError(
        `maxFrameBytes must be a positive safe integer no greater than ${STDIO_MAX_FRAME_BYTES}`,
      );
    }
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;

    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline;
      const partBytes = end - offset;
      if (this.frameBytes + partBytes > this.maxFrameBytes) {
        this.refuseOversizedFrame();
        return;
      }
      if (partBytes > 0) this.appendFramePart(bytes, offset, end);
      if (newline < 0) return;

      if (!this.processCompleteFrame()) return;
      offset = newline + 1;
    }
  };

  private appendFramePart(source: Buffer, start: number, end: number): void {
    const requiredBytes = this.frameBytes + end - start;
    if (this.frameBuffer === undefined || this.frameBuffer.length < requiredBytes) {
      let capacity =
        this.frameBuffer?.length ?? Math.min(INITIAL_FRAME_CAPACITY, this.maxFrameBytes);
      while (capacity < requiredBytes) capacity = Math.min(this.maxFrameBytes, capacity * 2);
      const grown = Buffer.allocUnsafe(capacity);
      if (this.frameBuffer !== undefined && this.frameBytes > 0) {
        this.frameBuffer.copy(grown, 0, 0, this.frameBytes);
      }
      this.frameBuffer = grown;
    }
    source.copy(this.frameBuffer, this.frameBytes, start, end);
    this.frameBytes = requiredBytes;
  }

  private readonly handleInputError = (error: Error): void => {
    this.onerror(error);
  };

  private readonly handleInputEnd = (): void => {
    this.finish();
  };

  private readonly handleInputClose = (): void => {
    this.finish();
  };

  private readonly handleOutputError = (error: Error): void => {
    this.onerror(error);
    this.finish(true);
  };

  private readonly handleOutputClose = (): void => {
    this.finish(true);
  };

  private processCompleteFrame(): boolean {
    let line: string;
    try {
      line = fatalUtf8Decoder
        .decode(this.frameBuffer?.subarray(0, this.frameBytes) ?? new Uint8Array())
        .replace(/\r$/, '');
    } catch {
      this.refuseFrame(new StdioInvalidUtf8Error());
      return false;
    }
    this.frameBytes = 0;
    try {
      this.onmessage(deserializeMessage(line));
    } catch {
      this.onerror(new StdioInvalidMessageError());
    }
    return true;
  }

  private refuseOversizedFrame(): void {
    this.refuseFrame(new StdioFrameLimitError(this.maxFrameBytes));
  }

  private refuseFrame(error: Error): void {
    this.frameBuffer = undefined;
    this.frameBytes = 0;
    this.onerror(error);
    this.finish(true);
  }

  private finish(destroyInput = false): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.handleData);
    this.input.off('error', this.handleInputError);
    this.input.off('end', this.handleInputEnd);
    this.input.off('close', this.handleInputClose);
    if (!this.writing) this.output.off('error', this.handleOutputError);
    this.output.off('close', this.handleOutputClose);
    const error = new Error('Stdio transport is closed');
    for (const write of this.writes.splice(0)) write.reject(error);
    this.queuedBytes = 0;
    if (destroyInput) this.input.destroy();
    else if (this.input.listenerCount('data') === 0) this.input.pause();
    this.onclose();
  }

  start(): Promise<void> {
    if (this.started) {
      throw new Error(
        'BoundedStdioServerTransport already started! If using Server class, note that connect() calls start() automatically.',
      );
    }
    this.started = true;
    this.input.on('data', this.handleData);
    this.input.on('error', this.handleInputError);
    this.input.once('end', this.handleInputEnd);
    this.input.once('close', this.handleInputClose);
    this.output.on('error', this.handleOutputError);
    this.output.once('close', this.handleOutputClose);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.frameBuffer = undefined;
    this.frameBytes = 0;
    this.finish();
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Stdio transport is closed'));
    const data = serializeMessage(message);
    const bytes = Buffer.byteLength(data);
    if (bytes > 134_217_728 - this.queuedBytes) {
      return Promise.reject(new Error('Stdio output queue is full'));
    }
    return new Promise((resolve, reject) => {
      this.queuedBytes += bytes;
      this.writes.push({ data, bytes, resolve, reject });
      this.flushWrites();
    });
  }

  private flushWrites(): void {
    if (this.writing || this.closed) return;
    const write = this.writes[0];
    if (write === undefined) return;
    this.writing = true;
    this.output.write(write.data, (error) => {
      this.writing = false;
      if (this.closed) {
        // A stream error is emitted after its write callback. Keep the listener through
        // that turn so closing an output with buffered writes cannot crash the process.
        setImmediate(() => this.output.off('error', this.handleOutputError));
        return;
      }
      this.writes.shift();
      this.queuedBytes -= write.bytes;
      if (error != null) {
        write.reject(error);
        this.writing = true;
        this.finish(true);
        this.writing = false;
        setImmediate(() => this.output.off('error', this.handleOutputError));
      } else {
        write.resolve();
        this.flushWrites();
      }
    });
  }
}
