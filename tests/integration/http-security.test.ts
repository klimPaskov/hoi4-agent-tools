import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHttpTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { TASKS_EXTENSION } from '../../src/hoi4_agent_tools/mcp/server/modern-tasks.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import {
  startHttpServer,
  type HttpServerHandle,
} from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const secret = 'test-secret-that-is-at-least-thirty-two-characters';
const handles: HttpServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  delete process.env.HOI4_AGENT_TEST_TOKEN;
  delete process.env.HOI4_AGENT_ALPHA_TOKEN;
  delete process.env.HOI4_AGENT_BETA_TOKEN;
});

async function server(
  host = '127.0.0.1',
  onEngine?: (engine: CoreEngine) => void,
): Promise<HttpServerHandle> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-http-'));
  const mod = path.join(root, 'mod');
  const focusDirectory = path.join(mod, 'common', 'national_focus');
  await mkdir(focusDirectory, { recursive: true });
  await writeFile(
    path.join(focusDirectory, 'http_test.txt'),
    'focus_tree = {\n\tid = http_test_tree\n\tdefault = no\n\tcontinuous_focus_position = { x = 0 y = 0 }\n\tfocus = { id = http_test_focus x = 0 y = 0 cost = 10 }\n}\n',
  );
  process.env.HOI4_AGENT_TEST_TOKEN = secret;
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: [{ id: 'test', name: 'Test', root: mod }],
    http: {
      host,
      port: 0,
      allowedOrigins: ['https://agent.example.test'],
      tokens: [
        {
          principal: 'test-user',
          tokenEnv: 'HOI4_AGENT_TEST_TOKEN',
          workspaceIds: ['test'],
        },
      ],
      principals: [],
    },
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(config));
  onEngine?.(engine);
  const handle = await startHttpServer(engine, config, createMcpServer);
  handles.push(handle);
  return handle;
}

async function isolatedServer(): Promise<{
  handle: HttpServerHandle;
  alphaSecret: string;
  discoveredWorkspaceId: string;
  betaSecret: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-isolation-'));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  const modRoot = path.join(root, 'mods');
  const discovered = path.join(modRoot, 'discovered');
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(discovered, { recursive: true })]);
  const alphaSecret = 'alpha-secret-that-is-at-least-thirty-two-characters';
  const betaSecret = 'beta-secret-that-is-at-least-thirty-two-characters';
  process.env.HOI4_AGENT_ALPHA_TOKEN = alphaSecret;
  process.env.HOI4_AGENT_BETA_TOKEN = betaSecret;
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'server-state'),
    modRoots: [modRoot],
    workspaceStorageRoot: path.join(root, 'workspace-storage'),
    workspaces: [
      { id: 'alpha', name: 'Alpha', root: alpha },
      { id: 'beta', name: 'Beta', root: beta },
    ],
    http: {
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: ['https://agent.example.test'],
      tokens: [
        {
          principal: 'alpha-user',
          tokenEnv: 'HOI4_AGENT_ALPHA_TOKEN',
          workspaceIds: ['alpha'],
          allowDiscoveredMods: true,
        },
        {
          principal: 'beta-user',
          tokenEnv: 'HOI4_AGENT_BETA_TOKEN',
          workspaceIds: ['beta'],
        },
      ],
      principals: [],
    },
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(config));
  const discoveredWorkspaceId = engine.list().find(({ name }) => name === 'discovered')!.id;
  const handle = await startHttpServer(engine, config, createMcpServer);
  handles.push(handle);
  return { handle, alphaSecret, discoveredWorkspaceId, betaSecret };
}

async function httpClient(
  url: string,
  token: string,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: 'http-isolation-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://agent.example.test',
      },
    },
  });
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

async function modernHttpClient(
  url: string,
  token: string,
  exchanges?: Array<{ method: string | null; contentType: string | null }>,
): Promise<ModernClient> {
  const client = new ModernClient(
    { name: 'http-modern-security-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new ModernHttpTransport(new URL(url), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.set('origin', 'https://agent.example.test');
      const response = await fetch(input, { ...init, headers });
      exchanges?.push({
        method: headers.get('mcp-method'),
        contentType: response.headers.get('content-type'),
      });
      return response;
    },
  });
  await client.connect(transport);
  return client;
}

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'http-modern-security-test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
    },
  };
}

async function modernFetch(
  url: string,
  token: string,
  body: unknown,
  method: string,
  name?: string,
) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      origin: 'https://agent.example.test',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(name === undefined ? {} : { 'mcp-name': name }),
    },
    body: JSON.stringify(body),
  });
}

describe('secured Streamable HTTP', () => {
  it('serves the official modern client through the production authenticated endpoint', async () => {
    const handle = await server();
    const client = await modernHttpClient(handle.url, secret);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect((await client.listTools()).tools).toHaveLength(30);
      expect(
        await client.callTool({
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'test', treeId: 'http_test_tree' },
        }),
      ).toMatchObject({ structuredContent: { status: 'ok' } });
      const manifest = {
        schemaVersion: '1.0',
        id: 'http-focus',
        definitions: [{ kind: 'focus_tree', id: 'http_test_tree' }],
      };
      expect(
        await client.callTool({
          name: 'hoi4.package_check',
          arguments: { workspaceId: 'test', manifest },
        }),
      ).toMatchObject({
        structuredContent: { code: 'PACKAGE_CHECK_PASSED', data: { complete: true } },
      });
      expect(
        await client.callTool({
          name: 'hoi4.scenario_test',
          arguments: {
            workspaceId: 'test',
            suite: {
              schemaVersion: '1.0',
              id: 'http-suite',
              cases: [{ id: 'focus-package', domain: 'package', manifest }],
            },
          },
        }),
      ).toMatchObject({
        structuredContent: {
          code: 'SCENARIO_SUITE_PASSED',
          data: { completed: 1, pending: 0 },
        },
      });
    } finally {
      await client.close();
    }
  });

  it('streams progress through the production endpoint before completion and uses JSON for silent calls', async () => {
    let engine!: CoreEngine;
    const handle = await server('127.0.0.1', (created) => {
      engine = created;
    });
    const exchanges: Array<{ method: string | null; contentType: string | null }> = [];
    const client = await modernHttpClient(handle.url, secret, exchanges);
    let admitted!: () => void;
    let unblock!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const capacity = engine.sharedRequests.run(new AbortController().signal, () => {
      admitted();
      return held;
    });
    await ready;
    const updates: number[] = [];
    let settled = false;
    const call = client
      .callTool(
        {
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'test', treeId: 'http_test_tree' },
        },
        { onprogress: ({ progress }) => updates.push(progress) },
      )
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
    try {
      await vi.waitFor(() => expect(updates).toContain(0), { timeout: 5_000 });
      expect(settled).toBe(false);
    } finally {
      unblock();
      await capacity;
    }
    try {
      expect(await call).toMatchObject({ structuredContent: { status: 'ok' } });
      expect(updates.at(-1)).toBe(3);
      const count = updates.length;
      expect(
        await client.callTool({
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'test', treeId: 'http_test_tree' },
        }),
      ).toMatchObject({ structuredContent: { status: 'ok' } });
      expect(updates).toHaveLength(count);
      expect(
        exchanges
          .filter(({ method }) => method === 'tools/call')
          .map(({ contentType }) => contentType),
      ).toEqual([
        expect.stringContaining('text/event-stream'),
        expect.stringContaining('application/json'),
      ]);
    } finally {
      await client.close();
    }
  });

  it('keeps authenticated modern requests out of legacy sessions and rejects mismatched claims', async () => {
    const handle = await server();
    const discover = await modernFetch(
      handle.url,
      secret,
      modernRequest('server/discover'),
      'server/discover',
    );
    expect(discover.status).toBe(200);
    expect(discover.headers.get('mcp-session-id')).toBeNull();
    expect(await discover.json()).toMatchObject({ result: { supportedVersions: ['2026-07-28'] } });

    const mismatched = await modernFetch(
      handle.url,
      secret,
      modernRequest('server/discover'),
      'tools/list',
    );
    expect(mismatched.status).toBe(400);
    expect(await mismatched.text()).not.toContain('No valid session ID or initialize request');

    const missingEnvelope = await modernFetch(
      handle.url,
      secret,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      'tools/list',
    );
    expect(missingEnvelope.status).toBe(400);
    expect(await missingEnvelope.text()).not.toContain('No valid session ID or initialize request');
  });

  it('applies bearer and Origin gates to modern requests before protocol routing', async () => {
    const handle = await server();
    const body = JSON.stringify(modernRequest('server/discover'));
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'server/discover',
    };
    const missingBearer = await fetch(handle.url, {
      method: 'POST',
      headers: { ...headers, origin: 'https://agent.example.test' },
      body,
    });
    expect(missingBearer.status).toBe(401);
    const forbiddenOrigin = await fetch(handle.url, {
      method: 'POST',
      headers: {
        ...headers,
        origin: 'https://evil.example.test',
        authorization: `Bearer ${secret}`,
      },
      body,
    });
    expect(forbiddenOrigin.status).toBe(403);
  });

  it('isolates modern tools and persistent tasks by authenticated principal across stateless requests', async () => {
    const { handle, alphaSecret, betaSecret } = await isolatedServer();
    const alpha = await modernHttpClient(handle.url, alphaSecret);
    const beta = await modernHttpClient(handle.url, betaSecret);
    try {
      expect(
        await alpha.callTool({ name: 'hoi4.gui_inspect', arguments: { workspaceId: 'alpha' } }),
      ).toMatchObject({ structuredContent: { status: 'ok' } });
      expect(
        await alpha.callTool({ name: 'hoi4.gui_inspect', arguments: { workspaceId: 'beta' } }),
      ).toMatchObject({ isError: true, structuredContent: { code: 'WORKSPACE_INACCESSIBLE' } });
      expect(
        await beta.callTool({ name: 'hoi4.gui_inspect', arguments: { workspaceId: 'beta' } }),
      ).toMatchObject({ structuredContent: { status: 'ok' } });

      const capabilities = { extensions: { [TASKS_EXTENSION]: {} } };
      const createdResponse = await modernFetch(
        handle.url,
        alphaSecret,
        modernRequest(
          'tools/call',
          { name: 'hoi4.event_inspect', arguments: { workspaceId: 'alpha', mode: 'roots' } },
          capabilities,
        ),
        'tools/call',
        'hoi4.event_inspect',
      );
      expect(createdResponse.status).toBe(200);
      const created = (await createdResponse.json()) as { result: { taskId: string } };
      expect(created.result).toMatchObject({ resultType: 'task', taskId: expect.any(String) });
      let completed!: { result: { status: string; result?: unknown } };
      await vi.waitFor(
        async () => {
          const response = await modernFetch(
            handle.url,
            alphaSecret,
            modernRequest('tasks/get', { taskId: created.result.taskId }, capabilities),
            'tasks/get',
            created.result.taskId,
          );
          expect(response.status).toBe(200);
          completed = (await response.json()) as typeof completed;
          expect(completed.result.status).toBe('completed');
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(completed.result.result).toMatchObject({
        structuredContent: { workspaceId: 'alpha', status: 'ok' },
      });

      const foreign = await modernFetch(
        handle.url,
        betaSecret,
        modernRequest('tasks/get', { taskId: created.result.taskId }, capabilities),
        'tasks/get',
        created.result.taskId,
      );
      expect(foreign.status).toBe(200);
      expect(await foreign.json()).toMatchObject({ error: { code: -32602 } });
    } finally {
      await Promise.all([alpha.close(), beta.close()]);
    }
  });
  it('negotiates over an IPv6 loopback endpoint when the host supports it', async () => {
    let handle: HttpServerHandle;
    try {
      handle = await server('::1');
    } catch (error) {
      if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return;
      }
      throw error;
    }
    expect(handle.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/u);
    const connected = await httpClient(handle.url, secret);
    await expect(connected.client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    await connected.client.close();
  });

  it('negotiates a stateful authenticated MCP session', async () => {
    const handle = await server();
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${secret}`,
          origin: 'https://agent.example.test',
        },
      },
    });
    // SDK 1.29's concrete HTTP transport exposes an optional sessionId while
    // the shared Transport declaration predates exactOptionalPropertyTypes.
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    expect(tools.tools.some(({ name }) => name === 'hoi4.focus_inspect')).toBe(true);
    expect(tools.tools.some(({ name }) => name === 'hoi4.tech_inspect')).toBe(true);
    const progress: number[] = [];
    await client.callTool(
      {
        name: 'hoi4.focus_inspect',
        arguments: { workspaceId: 'test', treeId: 'http_test_tree' },
      },
      undefined,
      { onprogress: ({ progress: value }) => progress.push(value) },
    );
    expect(progress).toEqual([0, 2, 3]);
    const technology = await client.callTool({
      name: 'hoi4.tech_inspect',
      arguments: { workspaceId: 'test', mode: 'scan' },
    });
    expect(technology.structuredContent).toMatchObject({ status: 'ok', code: 'TECH_INSPECTED' });
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    await transport.terminateSession();
    await client.close();
  });

  it('rejects missing authentication and invalid origins before MCP handling', async () => {
    const handle = await server();
    const unauthenticated = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://agent.example.test' },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);
    const badOrigin = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        origin: 'https://evil.example.test',
      },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
  });

  it('isolates workspace discovery, tool access, and sessions between principals', async () => {
    const { handle, alphaSecret, discoveredWorkspaceId, betaSecret } = await isolatedServer();
    const alpha = await httpClient(handle.url, alphaSecret);
    const beta = await httpClient(handle.url, betaSecret);
    const alphaStatus = await alpha.client.callTool({
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: 'alpha' },
    });
    expect(alphaStatus).not.toMatchObject({ isError: true });
    const forbidden = await alpha.client.callTool({
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: 'beta' },
    });
    expect(forbidden).toMatchObject({
      isError: true,
      structuredContent: { code: 'WORKSPACE_INACCESSIBLE' },
    });
    const discoveredForAlpha = await alpha.client.callTool({
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: discoveredWorkspaceId },
    });
    expect(discoveredForAlpha).toMatchObject({
      structuredContent: { status: 'ok' },
    });
    const discoveredForBeta = await beta.client.callTool({
      name: 'hoi4.gui_inspect',
      arguments: { workspaceId: discoveredWorkspaceId },
    });
    expect(discoveredForBeta).toMatchObject({
      isError: true,
      structuredContent: { code: 'WORKSPACE_INACCESSIBLE' },
    });

    const hijack = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${betaSecret}`,
        origin: 'https://agent.example.test',
        'mcp-session-id': alpha.transport.sessionId!,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    expect(hijack.status).toBe(403);

    await Promise.all([alpha.client.close(), beta.client.close()]);
  });
});
