import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  serverConfigurationSchema,
  type ServerConfiguration,
} from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import {
  startHttpServer,
  type HttpServerHandle,
} from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const publicResource = 'http://127.0.0.1/mcp';
const metadataUrl = 'http://127.0.0.1/.well-known/oauth-protected-resource/mcp';
const origin = 'https://agent.example.test';
const protocolVersion = '2025-11-25';

describe('MCP Streamable HTTP authorization challenges', () => {
  let jwksServer: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let configuration: ServerConfiguration;
  let handle: HttpServerHandle;
  let localUrl: string;

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: 'http-authorization-fixture', use: 'sig', alg: 'RS256' });
    jwksServer = createServer((request, response) => {
      if (request.url !== '/jwks') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const jwksAddress = jwksServer.address();
    if (typeof jwksAddress !== 'object' || jwksAddress === null) {
      throw new Error('JWKS fixture did not bind');
    }
    issuer = `http://127.0.0.1:${jwksAddress.port}/`;

    configuration = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '127.0.0.1',
        port: 0,
        publicUrl: publicResource,
        allowedOrigins: [origin],
        maxSessions: 1,
        principals: [{ principal: 'fixture-user', workspaceIds: [] }],
        oauth: {
          issuer,
          jwksUri: `${issuer}jwks`,
          audience: publicResource,
          authorizationServers: [issuer],
          requiredScopes: ['hoi4:read'],
          algorithms: ['RS256'],
        },
      },
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    handle = await startHttpServer(engine, configuration, createMcpServer);
    const address = handle.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('HTTP fixture did not bind');
    }
    localUrl = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await handle.close();
    await new Promise<void>((resolve, reject) =>
      jwksServer.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  async function token(
    scopes: string,
    clientId: string | null = 'fixture-client',
    expiration: string | number = '2h',
    tokenId?: string,
  ): Promise<string> {
    let jwt = new SignJWT({
      scope: scopes,
      ...(clientId === null ? {} : { client_id: clientId }),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'http-authorization-fixture' })
      .setIssuer(issuer)
      .setAudience(publicResource)
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime(expiration);
    if (tokenId !== undefined) jwt = jwt.setJti(tokenId);
    return jwt.sign(privateKey);
  }

  function headers(accessToken?: string, sessionId?: string): Record<string, string> {
    return {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      origin,
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
      ...(sessionId === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
    };
  }

  async function post(
    body: Record<string, unknown>,
    accessToken?: string,
    sessionId?: string,
  ): Promise<Response> {
    return fetch(localUrl, {
      method: 'POST',
      headers: headers(accessToken, sessionId),
      body: JSON.stringify(body),
    });
  }

  it('includes authoritative scope and resource metadata in 401 challenges', async () => {
    const missing = await post({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(
      `Bearer scope="hoi4:read", resource_metadata="${metadataUrl}"`,
    );

    const invalid = await post({}, 'not-a-jwt');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", scope="hoi4:read", resource_metadata="${metadataUrl}"`,
    );

    const metadata = await fetch(
      localUrl.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'),
      { headers: { origin } },
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource: publicResource,
      scopes_supported: ['hoi4:read', 'hoi4:write'],
    });
  });

  it('issues a 403 step-up challenge without letting a replacement credential take over', async () => {
    const readToken = await token('hoi4:read');
    const initialize = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'authorization-test', version: '1.0.0' },
        },
      },
      readToken,
    );
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    if (sessionId === null) throw new Error('Session ID was not returned');

    const initialized = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      readToken,
      sessionId,
    );
    expect(initialized.status).toBe(202);

    const writeCall = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'hoi4.transaction_apply',
        arguments: {
          workspaceId: 'not-registered',
          transactionId: 'not-present',
          expectedPlanHash: 'a'.repeat(64),
        },
      },
    };
    const stepUp = await post(writeCall, readToken, sessionId);
    expect(stepUp.status).toBe(403);
    expect(stepUp.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="hoi4:read hoi4:write", resource_metadata="${metadataUrl}"`,
    );

    const upgraded = await post(writeCall, await token('hoi4:read hoi4:write'), sessionId);
    expect(upgraded.status).toBe(403);
    expect(upgraded.headers.get('www-authenticate')).toBeNull();

    const originalCredentialStillWorks = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      readToken,
      sessionId,
    );
    expect(originalCredentialStillWorks.status).toBe(200);
  });

  it('rejects a different same-subject credential when neither token identifies a client', async () => {
    const originalToken = await token('hoi4:read', null, '2h', 'credential-a');
    const initialize = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'authorization-test', version: '1.0.0' },
        },
      },
      originalToken,
    );
    const sessionId = initialize.headers.get('mcp-session-id');
    if (sessionId === null) throw new Error('Session ID was not returned');

    const response = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      await token('hoi4:read', null, '2h', 'credential-b'),
      sessionId,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects expired initialization and releases an expired OAuth session admission slot', async () => {
    const baseline = Date.now();
    const expiredToken = await token(
      'hoi4:read',
      'fixture-client',
      Math.floor(baseline / 1000) - 1,
      'already-expired',
    );
    const expired = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'authorization-test', version: '1.0.0' },
        },
      },
      expiredToken,
    );
    expect(expired.status).toBe(401);

    const shortToken = await token(
      'hoi4:read',
      'fixture-client',
      Math.floor(baseline / 1000) + 60,
      'short-lived',
    );
    const first = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'authorization-test', version: '1.0.0' },
        },
      },
      shortToken,
    );
    expect(first.status).toBe(200);

    const replacementToken = await token('hoi4:read', 'fixture-client', '2h', 'replacement');
    const realNow = Date.now;
    Date.now = () => baseline + 61_000;
    try {
      const replacement = await post(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'initialize',
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'authorization-test', version: '1.0.0' },
          },
        },
        replacementToken,
      );
      expect(replacement.status).toBe(200);
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects a different OAuth client without mislabelling it as a scope failure', async () => {
    const originalToken = await token('hoi4:read');
    const initialize = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'authorization-test', version: '1.0.0' },
        },
      },
      originalToken,
    );
    const sessionId = initialize.headers.get('mcp-session-id');
    if (sessionId === null) throw new Error('Session ID was not returned');

    const response = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      await token('hoi4:read', 'different-client'),
      sessionId,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('does not expose the raw bearer token through MCP handler request context', async () => {
    await handle.close();
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    handle = await startHttpServer(engine, configuration, () => {
      const server = new McpServer({ name: 'auth-context-test', version: '1.0.0' });
      server.registerTool(
        'test.inspect_auth_context',
        { inputSchema: z.object({}).strict() },
        async (_input, extra) => {
          const evidence = {
            authorization: extra.requestInfo?.headers.authorization ?? null,
            authInfo: extra.authInfo ?? null,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(evidence) }],
            structuredContent: evidence,
          };
        },
      );
      return server;
    });
    const address = handle.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('HTTP fixture did not bind');
    }
    localUrl = `http://127.0.0.1:${address.port}/mcp`;

    const accessToken = await token('hoi4:read', null, '2h', 'handler-secret-test');
    const initialize = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'authorization-test', version: '1.0.0' },
        },
      },
      accessToken,
    );
    const sessionId = initialize.headers.get('mcp-session-id');
    if (sessionId === null) throw new Error('Session ID was not returned');
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'test.inspect_auth_context', arguments: {} },
      },
      accessToken,
      sessionId,
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(accessToken);
    expect(responseText).toContain('\\"authorization\\":null');
    expect(responseText).toContain('\\"authInfo\\":null');
  });
});
