import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  protectedResourceMetadata,
  validateHttpDeployment,
} from '../../src/hoi4_agent_tools/mcp/security/auth.js';
import {
  httpAllowedHostname,
  httpUrlHost,
  requiredScopesForMcpRequest,
  sessionAuthorizationMatches,
} from '../../src/hoi4_agent_tools/mcp/transports/http.js';

const oauth = {
  issuer: 'https://identity.example.test/',
  jwksUri: 'https://identity.example.test/.well-known/jwks.json',
  audience: 'https://tools.example.test/mcp',
  authorizationServers: ['https://identity.example.test/'],
  requiredScopes: ['hoi4:read'],
};

describe('Streamable HTTP deployment policy', () => {
  it('formats IPv6 loopback consistently for Host validation and endpoint URLs', () => {
    expect(httpAllowedHostname('::1')).toBe('[::1]');
    expect(httpUrlHost('::1')).toBe('[::1]');
    expect(new URL(`http://${httpUrlHost('::1')}:3210/mcp`).href).toBe('http://[::1]:3210/mcp');
    expect(httpAllowedHostname('127.0.0.1')).toBe('127.0.0.1');
  });

  it('requires authentication even on loopback', () => {
    const config = serverConfigurationSchema.parse({ version: 1 });
    expect(() => validateHttpDeployment(config)).toThrowError(/authentication/u);
  });

  it('forbids static bearer secrets on public bindings', () => {
    const config = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '0.0.0.0',
        publicUrl: 'https://tools.example.test/mcp',
        allowedOrigins: ['https://agent.example.test'],
        tokens: [
          {
            principal: 'user',
            tokenEnv: 'HOI4_AGENT_TOKEN',
            workspaceIds: ['workspace'],
          },
        ],
      },
    });
    expect(() => validateHttpDeployment(config)).toThrowError(/OAuth\/OIDC/u);
  });

  it('treats a loopback listener behind a public reverse-proxy URL as public', () => {
    const staticToken = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '127.0.0.1',
        publicUrl: 'https://tools.example.test/mcp',
        allowedOrigins: ['https://agent.example.test'],
        tokens: [
          {
            principal: 'user',
            tokenEnv: 'HOI4_AGENT_TOKEN',
            workspaceIds: ['workspace'],
          },
        ],
      },
    });
    expect(() => validateHttpDeployment(staticToken)).toThrowError(/OAuth\/OIDC/u);

    const proxiedOauth = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '127.0.0.1',
        publicUrl: 'https://tools.example.test/mcp',
        allowedOrigins: ['https://agent.example.test'],
        principals: [{ principal: 'fixture-user', workspaceIds: [] }],
        oauth,
      },
    });
    expect(() => validateHttpDeployment(proxiedOauth)).not.toThrow();
  });

  it('requires a canonical metadata resource URL whenever OAuth is enabled', () => {
    const missingResource = serverConfigurationSchema.parse({
      version: 1,
      http: { host: '127.0.0.1', oauth },
    });
    expect(() => validateHttpDeployment(missingResource)).toThrowError(
      /Protected Resource Metadata/u,
    );
  });

  it('requires HTTPS and an origin allowlist for public OAuth deployments', () => {
    const insecure = serverConfigurationSchema.parse({
      version: 1,
      http: { host: '0.0.0.0', publicUrl: 'http://tools.example.test/mcp', oauth },
    });
    expect(() => validateHttpDeployment(insecure)).toThrowError(/HTTPS/u);
    const noOrigins = serverConfigurationSchema.parse({
      version: 1,
      http: { host: '0.0.0.0', publicUrl: 'https://tools.example.test/mcp', oauth },
    });
    expect(() => validateHttpDeployment(noOrigins)).toThrowError(/origins/u);
  });

  it('requires canonical HTTPS resource and authorization endpoints off loopback', () => {
    const resourceWithFragment = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '0.0.0.0',
        publicUrl: 'https://tools.example.test/mcp#unexpected',
        allowedOrigins: ['https://agent.example.test'],
        principals: [{ principal: 'fixture-user', workspaceIds: [] }],
        oauth,
      },
    });
    expect(() => validateHttpDeployment(resourceWithFragment)).toThrowError(/without credentials/u);

    const insecureIssuer = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '0.0.0.0',
        publicUrl: 'https://tools.example.test/mcp',
        allowedOrigins: ['https://agent.example.test'],
        oauth: {
          ...oauth,
          issuer: 'http://identity.example.test/',
          authorizationServers: ['http://identity.example.test/'],
        },
      },
    });
    expect(() => validateHttpDeployment(insecureIssuer)).toThrowError(/must use HTTPS/u);
  });

  it('rejects public URLs with unsupported schemes or discarded path prefixes', () => {
    for (const publicUrl of [
      'file:///tmp/mcp',
      'https://tools.example.test/prefix/mcp',
      'https://tools.example.test/mcp/',
    ]) {
      const invalid = serverConfigurationSchema.parse({
        version: 1,
        http: {
          host: '127.0.0.1',
          publicUrl,
          allowedOrigins: ['https://agent.example.test'],
          principals: [{ principal: 'fixture-user', workspaceIds: [] }],
          oauth,
        },
      });
      expect(() => validateHttpDeployment(invalid)).toThrowError(/origin or exact \/mcp/u);
    }
  });

  it('accepts a bounded OAuth deployment and emits protected-resource metadata', () => {
    const config = serverConfigurationSchema.parse({
      version: 1,
      http: {
        host: '0.0.0.0',
        publicUrl: 'https://tools.example.test/mcp',
        allowedOrigins: ['https://agent.example.test'],
        principals: [{ principal: 'fixture-user', workspaceIds: [] }],
        oauth,
      },
    });
    expect(() => validateHttpDeployment(config)).not.toThrow();
    expect(protectedResourceMetadata(config)).toEqual({
      resource: 'https://tools.example.test/mcp',
      authorization_servers: ['https://identity.example.test/'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['hoi4:read', 'hoi4:write'],
      resource_name: 'HOI4 Agent Tools',
    });
  });

  it('does not let a session retain authority across principals, clients, or reduced scopes', () => {
    const session = {
      principal: 'user-a',
      clientId: 'agent-a',
      credentialId: 'sha256:credential-a',
      scopes: ['hoi4:read', 'hoi4:write'],
    };
    expect(
      sessionAuthorizationMatches(session, {
        principal: 'user-a',
        clientId: 'agent-a',
        credentialId: 'sha256:credential-a',
        scopes: ['hoi4:read', 'hoi4:write', 'profile'],
      }),
    ).toBe(true);
    expect(
      sessionAuthorizationMatches(session, {
        principal: 'user-b',
        clientId: 'agent-a',
        credentialId: 'sha256:credential-a',
        scopes: ['hoi4:read', 'hoi4:write'],
      }),
    ).toBe(false);
    expect(
      sessionAuthorizationMatches(session, {
        principal: 'user-a',
        clientId: 'agent-b',
        credentialId: 'sha256:credential-a',
        scopes: ['hoi4:read', 'hoi4:write'],
      }),
    ).toBe(false);
    expect(
      sessionAuthorizationMatches(session, {
        principal: 'user-a',
        clientId: 'agent-a',
        credentialId: 'sha256:credential-a',
        scopes: ['hoi4:read'],
      }),
    ).toBe(false);
    expect(
      sessionAuthorizationMatches(session, {
        principal: 'user-a',
        clientId: 'agent-a',
        credentialId: 'sha256:credential-b',
        scopes: ['hoi4:read', 'hoi4:write'],
      }),
    ).toBe(false);
  });

  it('preflights every handler-protected mutation with the write scope', () => {
    const config = serverConfigurationSchema.parse({
      version: 1,
      http: { publicUrl: 'https://tools.example.test/mcp', oauth },
    });
    const writeTools = [
      'hoi4.project_register',
      'hoi4.focus_plan_changes',
      'hoi4.gui_plan_changes',
      'hoi4.map_plan',
      'hoi4.transaction_apply',
      'hoi4.transaction_rollback',
    ];
    for (const name of writeTools) {
      expect(
        requiredScopesForMcpRequest(config, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
      ).toEqual(['hoi4:read', 'hoi4:write']);
    }
    expect(
      requiredScopesForMcpRequest(config, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'hoi4.project_scan', arguments: {} },
      }),
    ).toEqual(['hoi4:read']);
  });
});
