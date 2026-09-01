import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BoundedStdioServerTransport } from '../../src/hoi4_agent_tools/mcp/transports/bounded-stdio.js';

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('BoundedStdioServerTransport lifecycle', () => {
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
