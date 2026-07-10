import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { progressReporter } from '../../src/hoi4_agent_tools/mcp/server/progress.js';
import {
  startHttpServer,
  type HttpServerHandle,
} from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const token = 'stream-test-secret-that-is-at-least-thirty-two-characters';
const origin = 'https://agent.example.test';
const protocolVersion = '2025-11-25';
const handles: HttpServerHandle[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  delete process.env.HOI4_AGENT_STREAM_TOKEN;
});

async function instrumentedServer(factory: () => McpServer): Promise<HttpServerHandle> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-http-streaming-'));
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  process.env.HOI4_AGENT_STREAM_TOKEN = token;
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    workspaces: [{ id: 'stream', name: 'Stream fixture', root: mod }],
    http: {
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [origin],
      tokens: [
        {
          principal: 'stream-user',
          tokenEnv: 'HOI4_AGENT_STREAM_TOKEN',
          workspaceIds: ['stream'],
        },
      ],
    },
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  const handle = await startHttpServer(engine, configuration, factory);
  handles.push(handle);
  return handle;
}

function headers(sessionId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    origin,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    ...(sessionId === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
  };
}

async function initialize(url: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'streaming-test', version: '1.0.0' },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
  await response.text();
  if (sessionId === null) throw new Error('HTTP initialization omitted the session ID');
  const initialized = await fetch(url, {
    method: 'POST',
    headers: headers(sessionId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }),
  });
  expect(initialized.status).toBe(202);
  return sessionId;
}

async function firstSseEvent(response: Response): Promise<{ id: string; remainder: string }> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE stream ended before its first event');
    buffer += decoder.decode(chunk.value, { stream: true });
    const boundary = buffer.indexOf('\n\n');
    if (boundary < 0) continue;
    const event = buffer.slice(0, boundary);
    const id = /^id:\s*(.+)$/mu.exec(event)?.[1]?.trim();
    if (id === undefined) throw new Error(`SSE event omitted an ID: ${event}`);
    await reader.cancel();
    return { id, remainder: buffer.slice(boundary + 2) };
  }
}

async function readSseUntil(response: Response, pattern: RegExp): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE replay has no body');
  const decoder = new TextDecoder();
  let body = '';
  const timeout = setTimeout(() => void reader.cancel(), 5000);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`SSE replay ended before ${pattern}`);
      body += decoder.decode(chunk.value, { stream: true });
      if (pattern.test(body)) return body;
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
}

describe('Streamable HTTP progress, cancellation, and resumption', () => {
  it('closes failed pre-session initialization servers instead of leaking them', async () => {
    const closed = vi.fn(() => Promise.resolve());
    const handle = await instrumentedServer(() => {
      const server = new McpServer({ name: 'http-failed-init-fixture', version: '1.0.0' });
      vi.spyOn(server, 'connect').mockRejectedValue(new Error('synthetic connect failure'));
      vi.spyOn(server, 'close').mockImplementation(closed);
      return server;
    });
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'failed-init-test', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(500);
    await response.text();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('advertises the current final revision when HTTP requests an older SDK revision', async () => {
    const handle = await instrumentedServer(
      () => new McpServer({ name: 'http-version-fixture', version: '1.0.0' }),
    );
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old-version-test', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const message = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(
          responseText
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice('data: '.length),
        )
      : JSON.parse(responseText);
    expect(message).toMatchObject({
      result: { protocolVersion },
    });
  });

  it('rejects a non-current protocol header after final-only negotiation', async () => {
    const handle = await instrumentedServer(
      () => new McpServer({ name: 'http-version-fixture', version: '1.0.0' }),
    );
    const sessionId = await initialize(handle.url);
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: { ...headers(sessionId), 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32_000,
        message: `Unsupported MCP protocol version; this server requires ${protocolVersion}`,
      },
      id: null,
    });
  });

  it('requires the negotiated protocol header on every subsequent HTTP method', async () => {
    const handle = await instrumentedServer(
      () => new McpServer({ name: 'http-version-fixture', version: '1.0.0' }),
    );
    const sessionId = await initialize(handle.url);
    for (const method of ['POST', 'GET', 'DELETE']) {
      const requestHeaders = headers(sessionId);
      delete requestHeaders['mcp-protocol-version'];
      const options: RequestInit = { method, headers: requestHeaders };
      if (method === 'POST') {
        options.body = JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });
      }
      const response = await fetch(handle.url, options);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32_000,
          message: `Missing MCP-Protocol-Version header; this server requires ${protocolVersion}`,
        },
        id: null,
      });
    }
  });

  it('returns a JSON-RPC parse error without reflecting malformed JSON details', async () => {
    const handle = await instrumentedServer(
      () => new McpServer({ name: 'http-parser-fixture', version: '1.0.0' }),
    );
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: '{"jsonrpc":"2.0","private":"do-not-reflect",',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    const responseText = await response.text();
    expect(responseText).not.toContain('do-not-reflect');
    expect(responseText).not.toContain('Unexpected');
    expect(JSON.parse(responseText)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32_700, message: 'Parse error: Invalid JSON' },
      id: null,
    });
  });

  it('returns the Streamable HTTP method error for unsupported MCP methods', async () => {
    const handle = await instrumentedServer(
      () => new McpServer({ name: 'http-method-fixture', version: '1.0.0' }),
    );
    for (const method of ['PUT', 'PATCH']) {
      const response = await fetch(handle.url, {
        method,
        headers: headers(),
        body: method === 'PUT' ? JSON.stringify({}) : '{"private":"do-not-reflect",',
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, POST, DELETE');
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Method not allowed.' },
        id: null,
      });
    }
  });

  it('delivers a protocol cancellation notification to the active HTTP tool', async () => {
    const started = deferred<undefined>();
    const aborted = deferred<undefined>();
    const handle = await instrumentedServer(() => {
      const server = new McpServer({ name: 'http-cancellation-fixture', version: '1.0.0' });
      server.registerTool(
        'fixture.wait',
        { inputSchema: z.object({}).strict() },
        async (_input, extra) => {
          started.resolve(undefined);
          return new Promise<never>((_resolve, reject) => {
            const cancel = (): void => {
              aborted.resolve(undefined);
              reject(new Error('fixture request cancelled'));
            };
            if (extra.signal.aborted) cancel();
            else extra.signal.addEventListener('abort', cancel, { once: true });
          });
        },
      );
      return server;
    });
    const client = new Client({ name: 'http-cancellation-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, origin },
      },
    });
    await client.connect(transport as unknown as Transport);
    const controller = new AbortController();
    const call = client.callTool({ name: 'fixture.wait', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await expect(call).rejects.toThrow(/abort/iu);
    await expect(aborted.promise).resolves.toBeUndefined();
    await client.close();
  });

  it('replays request progress and result after the priming event ID', async () => {
    const completed = deferred<undefined>();
    const handle = await instrumentedServer(() => {
      const server = new McpServer({ name: 'http-resumption-fixture', version: '1.0.0' });
      server.registerTool(
        'fixture.stream',
        { inputSchema: z.object({}).strict() },
        async (_input, extra) => {
          const progress = progressReporter(extra);
          await progress.report(1, 2, 'first');
          await progress.report(2, 2, 'second');
          completed.resolve(undefined);
          return { content: [{ type: 'text', text: 'stream complete' }] };
        },
      );
      return server;
    });
    const sessionId = await initialize(handle.url);
    const call = await fetch(handle.url, {
      method: 'POST',
      headers: headers(sessionId),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'fixture.stream',
          arguments: {},
          _meta: { progressToken: 'resume-progress' },
        },
      }),
    });
    expect(call.status).toBe(200);
    expect(call.headers.get('content-type')).toContain('text/event-stream');
    await completed.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const priming = await firstSseEvent(call);
    expect(priming.id).toMatch(/^[0-9a-f-]{36}$/u);

    const replay = await fetch(handle.url, {
      method: 'GET',
      headers: {
        ...headers(sessionId),
        accept: 'text/event-stream',
        'last-event-id': priming.id,
      },
    });
    expect(replay.status).toBe(200);
    const replayed = await readSseUntil(replay, /"id":42/u);
    expect(replayed).toContain('notifications/progress');
    expect(replayed).toContain('resume-progress');
    expect(replayed).toContain('stream complete');
  });
});
