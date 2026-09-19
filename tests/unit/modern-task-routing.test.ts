import { setImmediate } from 'node:timers/promises';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModernTaskRoutingServer } from '../../src/hoi4_agent_tools/mcp/transports/modern-task-routing.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'request-id-proof', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

describe.each([0, ''] as const)('SDK cancellation for request ID %j', (id) => {
  it('preserves wire IDs, validates cancellation, bounds duplicate IDs, and permits reuse', async () => {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const responses: JSONRPCMessage[] = [];
    const signals: AbortSignal[] = [];
    const errors: Error[] = [];
    client.onmessage = (message) => {
      responses.push(message);
    };
    const handle = serveStdio(
      () => {
        const server = new ModernTaskRoutingServer(
          { name: 'request-id-proof', version: '1' },
          { capabilities: { tools: {} } },
        );
        server.onerror = (error) => {
          errors.push(error);
        };
        server.setRequestHandler('tools/call', (request, context) => {
          if (request.params.name === 'finish')
            return { content: [{ type: 'text', text: 'done' }] };
          signals.push(context.mcpReq.signal);
          return new Promise((resolve) => {
            context.mcpReq.signal.addEventListener('abort', () => resolve({ content: [] }), {
              once: true,
            });
          });
        });
        return server;
      },
      { transport, legacy: 'reject' },
    );
    cleanup.push(async () => {
      await client.close();
      await handle.close();
    });
    await client.start();
    await client.send({
      jsonrpc: '2.0',
      id: 'probe',
      method: 'server/discover',
      params: { _meta: meta },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    responses.length = 0;
    const call = (name: string) =>
      client.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: {}, _meta: meta },
      });
    await call('wait');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await client.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: id, reason: 42, _meta: meta },
    });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(signals[0]!.aborted).toBe(false);
    await call('finish');
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({ id, error: { code: -32600 } });
    expect(signals).toHaveLength(1);
    responses.length = 0;
    await client.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: id, _meta: meta },
    });
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    await setImmediate();
    expect(responses).toHaveLength(0);
    await call('finish');
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      id,
      result: { content: [{ type: 'text', text: 'done' }], resultType: 'complete' },
    });
    expect(JSON.stringify(responses)).not.toContain('mcp_request_');
    responses.length = 0;
    await call('wait');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await handle.close();
    expect(signals[1]!.aborted).toBe(true);
  });
});
