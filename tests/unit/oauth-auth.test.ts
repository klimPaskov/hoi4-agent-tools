import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import {
  authenticate,
  protectedResourceMetadata,
} from '../../src/hoi4_agent_tools/mcp/security/auth.js';

describe('OAuth/OIDC bearer verification', () => {
  let server: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: 'fixture-key', use: 'sig', alg: 'RS256' });
    server = createServer((request, response) => {
      if (request.url !== '/jwks') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('JWKS server missing');
    issuer = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  async function token(scope = 'hoi4:read', audience = 'hoi4-agent-test'): Promise<string> {
    return new SignJWT({ scope, client_id: 'fixture-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(privateKey);
  }

  async function tokenWithoutExpiration(): Promise<string> {
    return new SignJWT({ scope: 'hoi4:read', client_id: 'fixture-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience('hoi4-agent-test')
      .setSubject('fixture-user')
      .setIssuedAt()
      .sign(privateKey);
  }

  async function tokenExpiredWithinClockTolerance(): Promise<string> {
    return new SignJWT({ scope: 'hoi4:read', client_id: 'fixture-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience('hoi4-agent-test')
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(privateKey);
  }

  async function tokenWithClaims(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience('hoi4-agent-test')
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(privateKey);
  }

  async function tokenWithoutSubject(): Promise<string> {
    return new SignJWT({ scope: 'hoi4:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience('hoi4-agent-test')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(privateKey);
  }

  function configuration() {
    return serverConfigurationSchema.parse({
      version: 1,
      http: {
        publicUrl: 'https://tools.example.test',
        principals: [{ principal: 'fixture-user', workspaceIds: [] }],
        oauth: {
          issuer,
          jwksUri: `${issuer}jwks`,
          audience: 'hoi4-agent-test',
          authorizationServers: [issuer],
          requiredScopes: ['hoi4:read'],
          algorithms: ['RS256'],
        },
      },
    });
  }

  it('verifies signature, issuer, audience, subject, client, expiry, and scopes', async () => {
    const accessToken = await token();
    const principal = await authenticate(`Bearer ${accessToken}`, configuration());
    expect(principal).toMatchObject({
      principal: 'fixture-user',
      clientId: 'fixture-client',
      credentialId: `sha256:${createHash('sha256').update(accessToken).digest('hex')}`,
      scopes: ['hoi4:read'],
    });
    expect(principal).not.toHaveProperty('token');
    expect(JSON.stringify(principal)).not.toContain(accessToken);
  });

  it('rejects invalid audiences and insufficient scopes with deterministic auth errors', async () => {
    await expect(
      authenticate(`Bearer ${await token('hoi4:read', 'wrong-audience')}`, configuration()),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
    await expect(
      authenticate(`Bearer ${await token('profile')}`, configuration()),
    ).rejects.toMatchObject({ status: 403, code: 'AUTH_SCOPE_INSUFFICIENT' });
  });

  it('rejects JWT access tokens without a bounded expiration', async () => {
    await expect(
      authenticate(`Bearer ${await tokenWithoutExpiration()}`, configuration()),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
    await expect(
      authenticate(`Bearer ${await tokenWithoutSubject()}`, configuration()),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
    await expect(
      authenticate(`Bearer ${await tokenExpiredWithinClockTolerance()}`, configuration()),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
  });

  it('accepts scp arrays and binds missing client claims to the exact credential', async () => {
    await expect(
      authenticate(
        `Bearer ${await tokenWithClaims({ scp: ['hoi4:read', 'hoi4:read'], azp: 'fixture-azp' })}`,
        configuration(),
      ),
    ).resolves.toMatchObject({
      clientId: 'fixture-azp',
      scopes: ['hoi4:read'],
    });
    const accessToken = await tokenWithClaims({ scope: 'hoi4:read' });
    const principal = await authenticate(`Bearer ${accessToken}`, configuration());
    expect(principal.clientId).toBe(principal.credentialId);
    expect(principal.clientId).not.toBe(principal.principal);
  });

  it('rejects malformed scp arrays as insufficiently scoped', async () => {
    await expect(
      authenticate(`Bearer ${await tokenWithClaims({ scp: ['hoi4:read', 7] })}`, configuration()),
    ).rejects.toMatchObject({ status: 403, code: 'AUTH_SCOPE_INSUFFICIENT' });
  });

  it('advertises both configured read scopes and the write scope enforced by handlers', () => {
    expect(protectedResourceMetadata(configuration())).toMatchObject({
      scopes_supported: ['hoi4:read', 'hoi4:write'],
    });
  });
});
