import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BoundedStdioServerTransport } from '../../src/hoi4_agent_tools/mcp/transports/bounded-stdio.js';

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('BoundedStdioServerTransport lifecycle', () => {
  it('serializes 100 writes to a slow pipe without accumulating drain listeners', async () => {
    const lines: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        setImmediate(callback);
      },
    });
    const transport = new BoundedStdioServerTransport({ stdin: new PassThrough(), stdout: output });
    await transport.start();
    const sends = Array.from({ length: 100 }, (_, id) =>
      transport.send({ jsonrpc: '2.0', id, result: { value: id } }),
    );
    expect(output.listenerCount('drain')).toBe(0);
    expect(output.listenerCount('error')).toBe(1);
    await Promise.all(sends);
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual(
      Array.from({ length: 100 }, (_, id) => id),
    );
    await transport.close();
  });

  it('rejects every buffered send when a backpressured pipe closes', async () => {
    const output = new PassThrough({ highWaterMark: 1 });
    const transport = new BoundedStdioServerTransport({ stdin: new PassThrough(), stdout: output });
    await transport.start();
    const sends = Array.from({ length: 30 }, (_, id) =>
      transport.send({ jsonrpc: '2.0', id, result: {} }),
    );
    const settled = Promise.allSettled(sends);
    output.destroy();
    expect((await settled).every(({ status }) => status === 'rejected')).toBe(true);
  });

  it('closes once when the client ends stdin', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport({ stdin: input, stdout: output });
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();

    input.end();
    await nextTurn();

    expect(onclose).toHaveBeenCalledTimes(1);
    await expect(transport.send({ jsonrpc: '2.0', method: 'closed' })).rejects.toThrow(
      'Stdio transport is closed',
    );
  });

  it('closes and reports the error when the client output pipe fails', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport({ stdin: input, stdout: output });
    const onclose = vi.fn();
    const onerror = vi.fn();
    transport.onclose = onclose;
    transport.onerror = onerror;
    await transport.start();

    const failure = new Error('output pipe failed');
    output.emit('error', failure);

    expect(onerror).toHaveBeenCalledWith(failure);
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
