import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  authenticate,
  bearerChallenge,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  validateHttpDeployment,
} from '../../src/hoi4_agent_tools/mcp/security/auth.js';

const tokenEnvironmentNames = [
  'HOI4_TOKEN_MISSING',
  'HOI4_TOKEN_SHORT',
  'HOI4_TOKEN_DIFFERENT_LENGTH',
  'HOI4_TOKEN_WRONG',
  'HOI4_TOKEN_MATCH',
] as const;
const originalEnvironment = new Map(
  tokenEnvironmentNames.map((name) => [name, process.env[name]] as const),
);

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

function staticConfiguration(
  writePolicy: 'read-only' | 'transactions' | 'autonomous' = 'read-only',
) {
  return serverConfigurationSchema.parse({
    version: 1,
    writePolicy,
    ...(writePolicy !== 'read-only'
      ? { serverStateRoot: path.resolve('fixture-server-state') }
      : {}),
    workspaces: [{ id: 'fixture', name: 'Fixture', root: 'C:/fixture' }],
    http: {
      tokens: tokenEnvironmentNames.map((tokenEnv, index) => ({
        principal: index === tokenEnvironmentNames.length - 1 ? 'matched-user' : `user-${index}`,
        tokenEnv,
        workspaceIds: ['fixture'],
      })),
    },
  });
}

const oauth = {
  issuer: 'https://identity.example.test/',
  jwksUri: 'https://identity.example.test/.well-known/jwks.json',
  audience: 'hoi4-agent-tools',
  authorizationServers: ['https://identity.example.test/'],
  requiredScopes: ['hoi4:read'],
};

describe('HTTP authentication edge policy', () => {
  it('rejects missing, malformed, empty, oversized, and invalid-scope bearer inputs', async () => {
    const configuration = serverConfigurationSchema.parse({ version: 1 });
    await expect(authenticate(undefined, configuration)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      bearerError: undefined,
    });
    await expect(authenticate('Basic fixture', configuration)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(authenticate('Bearer   ', configuration)).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      bearerError: 'invalid_token',
    });
    await expect(authenticate(`Bearer ${'x'.repeat(16_385)}`, configuration)).rejects.toMatchObject(
      { code: 'AUTH_INVALID' },
    );
    await expect(
      authenticate('Bearer valid-shape', configuration, ['invalid scope']),
    ).rejects.toMatchObject({ code: 'HTTP_SCOPE_INVALID' });
  });

  it('skips unusable secrets and compares equal-length static tokens safely', async () => {
    const matchingToken = 'a'.repeat(32);
    delete process.env.HOI4_TOKEN_MISSING;
    process.env.HOI4_TOKEN_SHORT = 'short';
    process.env.HOI4_TOKEN_DIFFERENT_LENGTH = 'b'.repeat(33);
    process.env.HOI4_TOKEN_WRONG = 'b'.repeat(32);
    process.env.HOI4_TOKEN_MATCH = matchingToken;

    const principal = await authenticate(`Bearer ${matchingToken}`, staticConfiguration());
    expect(principal).toMatchObject({
      principal: 'matched-user',
      clientId: 'matched-user',
      credentialId: `sha256:${createHash('sha256').update(matchingToken).digest('hex')}`,
      scopes: ['hoi4:read'],
    });
    expect(principal).not.toHaveProperty('token');
    expect(JSON.stringify(principal)).not.toContain(matchingToken);
  });

  it('grants write scope only under an enabled write policy and enforces requested scopes', async () => {
    const matchingToken = 'a'.repeat(32);
    process.env.HOI4_TOKEN_MATCH = matchingToken;

    await expect(
      authenticate(`Bearer ${matchingToken}`, staticConfiguration(), ['hoi4:write']),
    ).rejects.toMatchObject({
      status: 403,
      code: 'AUTH_SCOPE_INSUFFICIENT',
      bearerError: 'insufficient_scope',
    });
    await expect(
      authenticate(`Bearer ${matchingToken}`, staticConfiguration('transactions'), [
        'hoi4:read',
        'hoi4:write',
      ]),
    ).resolves.toMatchObject({ scopes: ['hoi4:read', 'hoi4:write'] });
    await expect(
      authenticate(`Bearer ${matchingToken}`, staticConfiguration('autonomous'), [
        'hoi4:read',
        'hoi4:write',
      ]),
    ).resolves.toMatchObject({ scopes: ['hoi4:read', 'hoi4:write'] });
  });

  it('fails startup for missing, short, or duplicate static-token secrets', () => {
    delete process.env.HOI4_TOKEN_MISSING;
    expect(() => validateHttpDeployment(staticConfiguration())).toThrowError(
      expect.objectContaining({ code: 'HTTP_STATIC_TOKEN_INVALID' }),
    );

    const duplicate = 'd'.repeat(32);
    process.env.HOI4_TOKEN_WRONG = duplicate;
    process.env.HOI4_TOKEN_MATCH = duplicate;
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      http: {
        tokens: [
          {
            principal: 'first-user',
            tokenEnv: 'HOI4_TOKEN_WRONG',
            workspaceIds: ['fixture'],
          },
          {
            principal: 'second-user',
            tokenEnv: 'HOI4_TOKEN_MATCH',
            workspaceIds: ['fixture'],
          },
        ],
      },
    });
    expect(() => validateHttpDeployment(configuration)).toThrowError(
      expect.objectContaining({ code: 'HTTP_STATIC_TOKEN_DUPLICATE' }),
    );
  });

  it('builds empty and complete bearer challenges without inventing OAuth metadata', () => {
    const unconfigured = serverConfigurationSchema.parse({ version: 1 });
    expect(bearerChallenge(unconfigured, { bearerError: undefined, requiredScopes: [] })).toBe(
      'Bearer',
    );
    expect(protectedResourceMetadataUrl(unconfigured)).toBeUndefined();
    expect(() => protectedResourceMetadata(unconfigured)).toThrowError(
      expect.objectContaining({ code: 'HTTP_OAUTH_NOT_CONFIGURED' }),
    );

    const missingPublicUrl = serverConfigurationSchema.parse({
      version: 1,
      http: { oauth },
    });
    expect(protectedResourceMetadataUrl(missingPublicUrl)).toBeUndefined();

    const configured = serverConfigurationSchema.parse({
      version: 1,
      http: { publicUrl: 'https://tools.example.test/base', oauth },
    });
    const metadataUrl = 'https://tools.example.test/.well-known/oauth-protected-resource/mcp';
    expect(protectedResourceMetadataUrl(configured)).toBe(metadataUrl);
    expect(
      bearerChallenge(configured, {
        bearerError: 'insufficient_scope',
        requiredScopes: ['hoi4:write', 'hoi4:write'],
      }),
    ).toBe(
      `Bearer error="insufficient_scope", scope="hoi4:write", resource_metadata="${metadataUrl}"`,
    );
  });
});
