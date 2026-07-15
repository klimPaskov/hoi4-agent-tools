import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
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

async function server(host = '127.0.0.1'): Promise<HttpServerHandle> {
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

describe('secured Streamable HTTP', () => {
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
