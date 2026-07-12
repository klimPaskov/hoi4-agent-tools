import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HTTP_MAX_BODY_BYTES,
  serverConfigurationSchema,
} from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SOURCE_MAX_BYTES } from '../../src/hoi4_agent_tools/core/source/limits.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { GUI_TEXT_PACKAGE_MAX_BYTES } from '../../src/hoi4_agent_tools/gui/studio.js';
import { MAP_MASK_CELL_LIMIT } from '../../src/hoi4_agent_tools/map/limits.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import {
  startHttpServer,
  type HttpServerHandle,
} from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const token = 'limit-test-secret-that-is-at-least-thirty-two-characters';
const origin = 'https://agent.example.test';
const protocolVersion = '2025-11-25';
const handles: HttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  delete process.env.HOI4_AGENT_LIMIT_TOKEN;
  delete process.env.HOI4_AGENT_SECOND_LIMIT_TOKEN;
});

async function limitedServer(
  limits: Partial<{
    maxBodyBytes: number;
    headersTimeoutMs: number;
    requestTimeoutMs: number;
    keepAliveTimeoutMs: number;
    maxConnections: number;
    maxRequestsPerSocket: number;
    maxConcurrentRequests: number;
    maxSessions: number;
    maxSessionsPerPrincipal: number;
    maxEventStreams: number;
    maxEventStreamsPerPrincipal: number;
    maxSessionEventBytes: number;
    requestsPerMinute: number;
    sessionTtlSeconds: number;
    trustedProxyAddresses: string[];
  }>,
): Promise<HttpServerHandle> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-http-limits-'));
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  process.env.HOI4_AGENT_LIMIT_TOKEN = token;
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'server-state'),
    workspaces: [{ id: 'limited', name: 'Limited', root: mod }],
    http: {
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [origin],
      tokens: [
        {
          principal: 'limited-user',
          tokenEnv: 'HOI4_AGENT_LIMIT_TOKEN',
          workspaceIds: ['limited'],
        },
      ],
      ...limits,
    },
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  const handle = await startHttpServer(engine, configuration, createMcpServer);
  handles.push(handle);
  return handle;
}

function headers(extra: Record<string, string> = {}, bearerToken = token): Record<string, string> {
  return {
    authorization: `Bearer ${bearerToken}`,
    origin,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(extra['mcp-session-id'] === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
    ...extra,
  };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'limit-test', version: '1.0.0' },
  },
};

async function initializeSession(handle: HttpServerHandle): Promise<string> {
  const response = await fetch(handle.url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(initialize),
  });
  expect(response.status).toBe(200);
  const session = response.headers.get('mcp-session-id');
  expect(session).toMatch(/^[0-9a-f-]{36}$/u);
  await response.body?.cancel();
  return session!;
}

async function rawHttpResponse(
  handle: HttpServerHandle,
  headerLines: string[],
  body: string,
  requestTarget = '/mcp',
): Promise<{ status: number; body: string }> {
  const address = handle.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server not bound');
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    const chunks: Buffer[] = [];
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      const separator = response.indexOf('\r\n\r\n');
      const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1]);
      if (!Number.isInteger(status) || separator < 0) {
        reject(new Error(`Malformed raw HTTP response: ${response.slice(0, 200)}`));
        return;
      }
      resolve({ status, body: response.slice(separator + 4) });
    });
    socket.once('connect', () => {
      socket.end(
        [
          `POST ${requestTarget} HTTP/1.1`,
          ...headerLines,
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });
  });
}

describe('Streamable HTTP deployment limits', () => {
  it('enforces the configured request-body limit before MCP dispatch', async () => {
    const handle = await limitedServer({ maxBodyBytes: 1024 });
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...initialize, padding: 'x'.repeat(4096) }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Payload too large' },
      id: null,
    });
  });

  it('admits escaped full GUI packages and maximum map-mask envelopes under defaults', async () => {
    const handle = await limitedServer({});
    const session = await initializeSession(handle);
    const sourceFile = '\n'.repeat(SOURCE_MAX_BYTES);
    expect(SOURCE_MAX_BYTES * 2).toBe(GUI_TEXT_PACKAGE_MAX_BYTES);
    const guiRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'limits/escaped-package-probe',
      params: {
        source: sourceFile,
        additionalFiles: [{ relativePath: 'interface/large_additional.gui', source: sourceFile }],
      },
    });
    const guiRequestBytes = Buffer.byteLength(guiRequest);
    expect(guiRequestBytes).toBeGreaterThan(GUI_TEXT_PACKAGE_MAX_BYTES);
    expect(guiRequestBytes).toBeLessThan(HTTP_MAX_BODY_BYTES);

    const mapMaskBase64Bytes = Math.ceil(MAP_MASK_CELL_LIMIT / 3) * 4;
    const mapEnvelopeBytes =
      Buffer.byteLength(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'hoi4.map_rewrite',
            arguments: {
              workspaceId: 'limited',
              operations: [
                {
                  geometry: {
                    kind: 'mask',
                    width: 5_000,
                    height: 4_000,
                    origin: { x: 0, y: 0 },
                    selectedPixelCount: 1_000_000,
                    sha256: '0'.repeat(64),
                    data: '',
                  },
                },
              ],
            },
          },
        }),
      ) + mapMaskBase64Bytes;
    expect(mapEnvelopeBytes).toBeLessThan(HTTP_MAX_BODY_BYTES);

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: headers({ 'mcp-session-id': session }),
      body: guiRequest,
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }, 30_000);

  it('enforces the body limit on established sessions and rejects alternate JSON-like media types', async () => {
    const handle = await limitedServer({ maxBodyBytes: 1024 });
    const session = await initializeSession(handle);
    const request = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    const oversized = await fetch(handle.url, {
      method: 'POST',
      headers: headers({ 'mcp-session-id': session }),
      body: JSON.stringify({ ...request, padding: 'x'.repeat(4096) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Payload too large' },
      id: null,
    });

    for (const contentType of [
      'text/plain; profile="application/json"',
      'application/json-patch+json',
      'application/json; malformed-parameter',
      'application / json',
      'application/json; charset=utf-8; charset=utf-8',
      'application/json; charset = utf-8',
    ]) {
      const response = await fetch(handle.url, {
        method: 'POST',
        headers: headers({ 'mcp-session-id': session, 'content-type': contentType }),
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32_000,
          message: 'Unsupported Media Type: Content-Type must be UTF-8 application/json',
        },
        id: null,
      });
    }

    const empty = await fetch(handle.url, {
      method: 'POST',
      headers: headers({ 'mcp-session-id': session }),
      body: '',
    });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32_700, message: 'Parse error: Invalid JSON-RPC message' },
      id: null,
    });

    const valid = await fetch(handle.url, {
      method: 'POST',
      headers: headers({
        'mcp-session-id': session,
        'content-type': 'application/json; charset=utf-8',
      }),
      body: JSON.stringify(request),
    });
    expect(valid.status).toBe(200);
    await valid.body?.cancel();
  });

  it('rejects encoded entities, malformed UTF-8, and non-UTF-8 JSON charsets', async () => {
    const handle = await limitedServer({ maxBodyBytes: 1024 });
    const compressed = gzipSync(Buffer.from(JSON.stringify(initialize), 'utf8'));
    const encoded = await fetch(handle.url, {
      method: 'POST',
      headers: headers({ 'content-encoding': 'gzip' }),
      body: Buffer.concat([compressed, Buffer.alloc(1_048_576)]),
    });
    expect(encoded.status).toBe(415);
    await expect(encoded.json()).resolves.toMatchObject({
      error: { message: 'Unsupported Media Type: Content-Encoding must be identity' },
    });

    const utf16 = await fetch(handle.url, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json; charset=utf-16le' }),
      body: Buffer.from(JSON.stringify(initialize), 'utf16le'),
    });
    expect(utf16.status).toBe(415);
    await expect(utf16.json()).resolves.toMatchObject({
      error: { message: 'Unsupported Media Type: Content-Type must be UTF-8 application/json' },
    });

    const json = JSON.stringify(initialize);
    const marker = 'limit-test';
    const markerOffset = json.indexOf(marker);
    expect(markerOffset).toBeGreaterThan(0);
    const malformedUtf8 = Buffer.concat([
      Buffer.from(json.slice(0, markerOffset), 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(json.slice(markerOffset + marker.length), 'utf8'),
    ]);
    const malformed = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: malformedUtf8,
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32_700, message: 'Parse error: Invalid UTF-8 JSON' },
      id: null,
    });
  });

  it('requires exact positively weighted MCP response media types', async () => {
    const handle = await limitedServer({});
    for (const accept of [
      'xapplication/json, xtext/event-stream',
      'application/json, text/event-stream;q=0',
      'application/json, text/event-stream;q="1"',
      'application/json;q = 1, text/event-stream',
      'application/json; profile="text/event-stream"',
      'application / json, text/event-stream',
      'application/json;q=0, application/json;profile=custom;q=1, text/event-stream',
      'application/json, text/event-stream;q=0, text/event-stream;profile=custom;q=1',
      '*/*',
    ]) {
      const response = await fetch(handle.url, {
        method: 'POST',
        headers: headers({ accept }),
        body: JSON.stringify(initialize),
      });
      expect(response.status).toBe(406);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          message: 'Not Acceptable: Accept must include application/json and text/event-stream',
        },
      });
    }

    const session = await initializeSession(handle);
    const invalidGet = await fetch(handle.url, {
      method: 'GET',
      headers: headers({
        accept: 'xtext/event-stream',
        'mcp-session-id': session,
      }),
    });
    expect(invalidGet.status).toBe(406);
    await invalidGet.body?.cancel();
  });

  it('rejects duplicate security-sensitive singleton fields before header normalization', async () => {
    const handle = await limitedServer({});
    const address = handle.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('server not bound');
    const host = `127.0.0.1:${address.port}`;
    const body = JSON.stringify(initialize);
    const common = [
      `Host: ${host}`,
      `Authorization: Bearer ${token}`,
      `Origin: ${origin}`,
      'Accept: application/json, text/event-stream',
      'Content-Type: application/json',
    ];
    const cases = [
      [`Host: ${host}`, 'Host: evil.example.test', ...common.slice(1)],
      [
        common[0]!,
        `Authorization: Bearer ${token}`,
        'Authorization: Bearer invalid',
        ...common.slice(2),
      ],
      [...common.slice(0, 4), 'Content-Type: application/json', 'Content-Type: text/plain'],
      [
        common[0]!,
        common[1]!,
        `Origin: ${origin}`,
        'Origin: https://evil.example.test',
        ...common.slice(3),
      ],
      [...common, 'Content-Encoding: identity', 'Content-Encoding: gzip'],
    ];

    for (const headerLines of cases) {
      const response = await rawHttpResponse(handle, headerLines, body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { message: 'Ambiguous or duplicate security-sensitive HTTP header' },
      });
    }
  });

  it('binds absolute-form request-target authority to the validated Host authority', async () => {
    const handle = await limitedServer({});
    const address = handle.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('server not bound');
    const host = `127.0.0.1:${address.port}`;
    const body = JSON.stringify(initialize);
    const headersFor = (authority: string) => [
      `Host: ${authority}`,
      `Authorization: Bearer ${token}`,
      `Origin: ${origin}`,
      'Accept: application/json, text/event-stream',
      'Content-Type: application/json',
    ];

    const mismatches: Array<readonly [string, string]> = [
      ['http://evil.example.test/mcp', host],
      [`http://${host}/mcp`, 'evil.example.test'],
    ];
    for (const [target, authority] of mismatches) {
      const rejected = await rawHttpResponse(handle, headersFor(authority), body, target);
      expect(rejected.status).toBe(400);
      expect(JSON.parse(rejected.body)).toMatchObject({
        error: { message: 'Absolute request-target authority does not match Host' },
      });
    }

    const accepted = await rawHttpResponse(handle, headersFor(host), body, `http://${host}/mcp`);
    expect(accepted.status).toBe(200);
  });

  it('reserves concurrency before waiting for a request body', async () => {
    const handle = await limitedServer({
      maxConcurrentRequests: 1,
      headersTimeoutMs: 1_500,
      requestTimeoutMs: 2_000,
      keepAliveTimeoutMs: 1_000,
      maxConnections: 8,
      maxRequestsPerSocket: 5,
    });
    expect(handle.server.headersTimeout).toBe(1_500);
    expect(handle.server.requestTimeout).toBe(2_000);
    expect(handle.server.keepAliveTimeout).toBe(1_000);
    expect(handle.server.maxConnections).toBe(8);
    expect(handle.server.maxRequestsPerSocket).toBe(5);
    const address = handle.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('server not bound');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      [
        'POST /mcp HTTP/1.1',
        `Host: 127.0.0.1:${address.port}`,
        `Origin: ${origin}`,
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        'Content-Length: 1000',
        '',
        '{',
      ].join('\r\n'),
    );
    try {
      const rejected = await fetch(handle.url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(initialize),
      });
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('retry-after')).toBe('1');
    } finally {
      socket.destroy();
    }
  });

  it('enforces bounded session count and request rate', async () => {
    const sessionLimited = await limitedServer({ maxSessions: 1 });
    await initializeSession(sessionLimited);
    const second = await fetch(sessionLimited.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...initialize, id: 2 }),
    });
    expect(second.status).toBe(429);

    const rateLimited = await limitedServer({ requestsPerMinute: 1 });
    const session = await initializeSession(rateLimited);
    const overRate = await fetch(rateLimited.url, {
      method: 'POST',
      headers: headers({ 'mcp-session-id': session }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(overRate.status).toBe(429);
    expect(overRate.headers.get('retry-after')).toBe('60');
  });

  it('rate-limits invalid credentials before authentication work', async () => {
    const handle = await limitedServer({ requestsPerMinute: 1 });
    const invalidHeaders = headers({ authorization: `Bearer ${'x'.repeat(32)}` });
    const invalid = await fetch(handle.url, {
      method: 'POST',
      headers: invalidHeaders,
      body: JSON.stringify(initialize),
    });
    expect(invalid.status).toBe(401);
    const rejected = await fetch(handle.url, {
      method: 'POST',
      headers: invalidHeaders,
      body: JSON.stringify({ ...initialize, id: 2 }),
    });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('60');
  });

  it('uses forwarded client addresses only from explicitly trusted proxies', async () => {
    const trusted = await limitedServer({
      requestsPerMinute: 1,
      trustedProxyAddresses: ['127.0.0.1'],
    });
    const first = await fetch(trusted.url, {
      method: 'POST',
      headers: headers({
        authorization: `Bearer ${'x'.repeat(32)}`,
        'x-forwarded-for': '192.0.2.10',
      }),
      body: JSON.stringify(initialize),
    });
    expect(first.status).toBe(401);
    const independent = await fetch(trusted.url, {
      method: 'POST',
      headers: headers({
        authorization: `Bearer ${'x'.repeat(32)}`,
        'x-forwarded-for': '192.0.2.11',
      }),
      body: JSON.stringify({ ...initialize, id: 2 }),
    });
    expect(independent.status).toBe(401);

    const untrusted = await limitedServer({ requestsPerMinute: 1 });
    const spoofedFirst = await fetch(untrusted.url, {
      method: 'POST',
      headers: headers({
        authorization: `Bearer ${'x'.repeat(32)}`,
        'x-forwarded-for': '192.0.2.20',
      }),
      body: JSON.stringify(initialize),
    });
    expect(spoofedFirst.status).toBe(401);
    const spoofedSecond = await fetch(untrusted.url, {
      method: 'POST',
      headers: headers({
        authorization: `Bearer ${'x'.repeat(32)}`,
        'x-forwarded-for': '192.0.2.21',
      }),
      body: JSON.stringify({ ...initialize, id: 2 }),
    });
    expect(spoofedSecond.status).toBe(429);
  });

  it('enforces per-principal session admission without starving another principal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-http-principal-limits-'));
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const secondToken = 'second-limit-test-secret-that-is-at-least-thirty-two-characters';
    process.env.HOI4_AGENT_LIMIT_TOKEN = token;
    process.env.HOI4_AGENT_SECOND_LIMIT_TOKEN = secondToken;
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'server-state'),
      workspaces: [{ id: 'limited', name: 'Limited', root: mod }],
      http: {
        host: '127.0.0.1',
        port: 0,
        allowedOrigins: [origin],
        maxSessions: 3,
        maxSessionsPerPrincipal: 1,
        tokens: [
          {
            principal: 'first-user',
            tokenEnv: 'HOI4_AGENT_LIMIT_TOKEN',
            workspaceIds: ['limited'],
          },
          {
            principal: 'second-user',
            tokenEnv: 'HOI4_AGENT_SECOND_LIMIT_TOKEN',
            workspaceIds: ['limited'],
          },
        ],
      },
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const handle = await startHttpServer(engine, configuration, createMcpServer);
    handles.push(handle);
    const first = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(initialize),
    });
    expect(first.status).toBe(200);
    await first.body?.cancel();
    const samePrincipal = await fetch(handle.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...initialize, id: 2 }),
    });
    expect(samePrincipal.status).toBe(429);
    await expect(samePrincipal.json()).resolves.toMatchObject({
      error: 'principal_session_limit',
    });
    const otherPrincipal = await fetch(handle.url, {
      method: 'POST',
      headers: headers({}, secondToken),
      body: JSON.stringify({ ...initialize, id: 3 }),
    });
    expect(otherPrincipal.status).toBe(200);
    await otherPrincipal.body?.cancel();
  });

  it('expires sessions and isolates long-lived event streams from request concurrency', async () => {
    const expiring = await limitedServer({ sessionTtlSeconds: 60 });
    const session = await initializeSession(expiring);
    const realNow = Date.now;
    const baseline = realNow();
    Date.now = () => baseline + 61_000;
    try {
      const expired = await fetch(expiring.url, {
        method: 'POST',
        headers: headers({ 'mcp-session-id': session }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(expired.status).toBe(404);
    } finally {
      Date.now = realNow;
    }

    const concurrent = await limitedServer({ maxConcurrentRequests: 1 });
    const concurrentSession = await initializeSession(concurrent);
    const controller = new AbortController();
    const stream = await fetch(concurrent.url, {
      method: 'GET',
      headers: headers({ 'mcp-session-id': concurrentSession }),
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const rejected = await fetch(concurrent.url, {
      method: 'POST',
      headers: headers({ 'mcp-session-id': concurrentSession }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(rejected.status).toBe(200);
    await rejected.body?.cancel();
    controller.abort();
    await stream.body?.cancel().catch(() => undefined);
  });

  it('keeps static-token sessions on the configured sliding inactivity lifetime', async () => {
    const handle = await limitedServer({ sessionTtlSeconds: 60 });
    const session = await initializeSession(handle);
    const realNow = Date.now;
    const baseline = realNow();
    Date.now = () => baseline + 59_000;
    try {
      const firstRefresh = await fetch(handle.url, {
        method: 'POST',
        headers: headers({ 'mcp-session-id': session }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(firstRefresh.status).toBe(200);
      await firstRefresh.text();

      Date.now = () => baseline + 118_000;
      const afterOriginalTtl = await fetch(handle.url, {
        method: 'POST',
        headers: headers({ 'mcp-session-id': session }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      expect(afterOriginalTtl.status).toBe(200);
      await afterOriginalTtl.text();
    } finally {
      Date.now = realNow;
    }
  });

  it('bounds long-lived event streams separately per principal', async () => {
    const handle = await limitedServer({
      maxConcurrentRequests: 1,
      maxEventStreams: 2,
      maxEventStreamsPerPrincipal: 1,
    });
    const session = await initializeSession(handle);
    const firstController = new AbortController();
    const first = await fetch(handle.url, {
      method: 'GET',
      headers: headers({ 'mcp-session-id': session }),
      signal: firstController.signal,
    });
    expect(first.status).toBe(200);
    const second = await fetch(handle.url, {
      method: 'GET',
      headers: headers({ 'mcp-session-id': session }),
    });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: 'principal_event_stream_limit',
    });
    firstController.abort();
    await first.body?.cancel().catch(() => undefined);
  });
});
