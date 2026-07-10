import { compareCodeUnits } from '../../core/canonical.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { ServerConfiguration } from '../../core/configuration.js';
import { ServiceError } from '../../core/result.js';

export interface AuthenticatedPrincipal {
  principal: string;
  clientId: string;
  /** Non-secret binding for the exact bearer credential presented on this request. */
  credentialId: string;
  scopes: string[];
  expiresAt?: number;
}

export type BearerErrorCode = 'invalid_token' | 'insufficient_scope';

export class HttpAuthError extends ServiceError {
  public constructor(
    public readonly status: 401 | 403,
    code: string,
    message: string,
    public readonly bearerError: BearerErrorCode | undefined,
    public readonly requiredScopes: readonly string[],
  ) {
    super(code, message);
  }
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const scopeTokenPattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

function normalizedScopes(scopes: readonly string[]): string[] {
  const normalized = [...new Set(scopes)];
  if (normalized.some((scope) => !scopeTokenPattern.test(scope))) {
    throw new ServiceError('HTTP_SCOPE_INVALID', 'OAuth scopes must use the RFC 6750 scope syntax');
  }
  return normalized;
}

function bearer(header: string | undefined, requiredScopes: readonly string[]): string {
  if (header === undefined || !/^Bearer\s+/iu.test(header)) {
    throw new HttpAuthError(
      401,
      'AUTH_REQUIRED',
      'A bearer token is required',
      undefined,
      requiredScopes,
    );
  }
  const token = header.replace(/^Bearer\s+/iu, '').trim();
  if (token.length === 0 || token.length > 16_384) {
    throw new HttpAuthError(
      401,
      'AUTH_INVALID',
      'Bearer token is invalid',
      'invalid_token',
      requiredScopes,
    );
  }
  return token;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function credentialId(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function tokenScopes(payload: Record<string, unknown>): string[] {
  const scope = payload.scope;
  const scp = payload.scp;
  if (typeof scope === 'string') return normalizedScopes(scope.split(/\s+/u).filter(Boolean));
  if (Array.isArray(scp) && scp.every((value) => typeof value === 'string')) {
    return normalizedScopes(scp);
  }
  return [];
}

function requireScopes(actual: readonly string[], required: readonly string[]): void {
  const normalizedRequired = normalizedScopes(required);
  const missing = normalizedRequired.filter((scope) => !actual.includes(scope));
  if (missing.length === 0) return;
  throw new HttpAuthError(
    403,
    'AUTH_SCOPE_INSUFFICIENT',
    'Bearer token lacks a required scope',
    'insufficient_scope',
    normalizedRequired,
  );
}

function defaultRequiredScopes(configuration: ServerConfiguration): string[] {
  return normalizedScopes(configuration.http.oauth?.requiredScopes ?? ['hoi4:read']);
}

function validateStaticTokenSecrets(configuration: ServerConfiguration): void {
  const fingerprints = new Set<string>();
  for (const configured of configuration.http.tokens) {
    const secret = process.env[configured.tokenEnv];
    if (secret === undefined || secret.length < 32) {
      throw new ServiceError(
        'HTTP_STATIC_TOKEN_INVALID',
        'Every configured static-token environment variable must contain at least 32 characters',
      );
    }
    const fingerprint = createHash('sha256').update(secret, 'utf8').digest('hex');
    if (fingerprints.has(fingerprint)) {
      throw new ServiceError(
        'HTTP_STATIC_TOKEN_DUPLICATE',
        'Configured static bearer tokens must have distinct secret values',
      );
    }
    fingerprints.add(fingerprint);
  }
}

export async function authenticate(
  authorization: string | undefined,
  configuration: ServerConfiguration,
  requiredScopes: readonly string[] = defaultRequiredScopes(configuration),
): Promise<AuthenticatedPrincipal> {
  const normalizedRequiredScopes = normalizedScopes(requiredScopes);
  const token = bearer(authorization, normalizedRequiredScopes);
  const presentedCredentialId = credentialId(token);
  const oauth = configuration.http.oauth;
  if (oauth !== undefined) {
    let remote = jwks.get(oauth.jwksUri);
    if (remote === undefined) {
      remote = createRemoteJWKSet(new URL(oauth.jwksUri), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
      });
      jwks.set(oauth.jwksUri, remote);
    }
    try {
      const { payload } = await jwtVerify(token, remote, {
        issuer: oauth.issuer,
        audience: oauth.audience,
        algorithms: oauth.algorithms,
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('Token subject is missing');
      }
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new Error('Token expiration is missing');
      }
      if (payload.exp * 1000 <= Date.now()) {
        throw new Error('Token has expired');
      }
      if (!configuration.http.principals.some(({ principal }) => principal === payload.sub)) {
        throw new HttpAuthError(
          403,
          'AUTH_PRINCIPAL_FORBIDDEN',
          'Bearer-token subject is not an allowlisted principal',
          undefined,
          normalizedRequiredScopes,
        );
      }
      const scopes = tokenScopes(payload);
      requireScopes(scopes, normalizedRequiredScopes);
      return {
        principal: payload.sub,
        clientId:
          typeof payload.client_id === 'string'
            ? payload.client_id
            : typeof payload.azp === 'string'
              ? payload.azp
              : presentedCredentialId,
        credentialId: presentedCredentialId,
        scopes,
        expiresAt: payload.exp,
      };
    } catch (error) {
      if (error instanceof HttpAuthError) throw error;
      throw new HttpAuthError(
        401,
        'AUTH_INVALID',
        'Bearer token verification failed',
        'invalid_token',
        normalizedRequiredScopes,
      );
    }
  }

  for (const configured of configuration.http.tokens) {
    const secret = process.env[configured.tokenEnv];
    if (secret === undefined || secret.length < 32) continue;
    if (equalSecret(token, secret)) {
      const principal = {
        principal: configured.principal,
        clientId: configured.principal,
        credentialId: presentedCredentialId,
        scopes: [
          'hoi4:read',
          ...(configuration.writePolicy === 'transactions' ? ['hoi4:write'] : []),
        ],
      };
      requireScopes(principal.scopes, normalizedRequiredScopes);
      return principal;
    }
  }
  throw new HttpAuthError(
    401,
    'AUTH_INVALID',
    'Bearer token verification failed',
    'invalid_token',
    normalizedRequiredScopes,
  );
}

export function protectedResourceMetadataUrl(
  configuration: ServerConfiguration,
): string | undefined {
  if (configuration.http.oauth === undefined || configuration.http.publicUrl === undefined) {
    return undefined;
  }
  return new URL('/.well-known/oauth-protected-resource/mcp', configuration.http.publicUrl).href;
}

export function bearerChallenge(
  configuration: ServerConfiguration,
  error: Pick<HttpAuthError, 'bearerError' | 'requiredScopes'>,
): string {
  const parameters: string[] = [];
  if (error.bearerError !== undefined) parameters.push(`error="${error.bearerError}"`);
  const scopes = normalizedScopes(error.requiredScopes);
  if (scopes.length > 0) parameters.push(`scope="${scopes.join(' ')}"`);
  const resourceMetadata = protectedResourceMetadataUrl(configuration);
  if (resourceMetadata !== undefined) {
    parameters.push(`resource_metadata="${resourceMetadata}"`);
  }
  return `Bearer${parameters.length === 0 ? '' : ` ${parameters.join(', ')}`}`;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

export function validateHttpDeployment(configuration: ServerConfiguration): void {
  const http = configuration.http;
  void defaultRequiredScopes(configuration);
  if (http.oauth === undefined && http.tokens.length === 0) {
    throw new ServiceError('HTTP_AUTH_NOT_CONFIGURED', 'Streamable HTTP requires authentication');
  }
  const publicUrl = http.publicUrl === undefined ? undefined : new URL(http.publicUrl);
  if (http.oauth !== undefined && publicUrl === undefined) {
    throw new ServiceError(
      'HTTP_OAUTH_PUBLIC_URL_REQUIRED',
      'OAuth Streamable HTTP requires a canonical publicUrl for Protected Resource Metadata',
    );
  }
  if (
    publicUrl !== undefined &&
    (!['http:', 'https:'].includes(publicUrl.protocol) ||
      !['/', '/mcp'].includes(publicUrl.pathname) ||
      publicUrl.username.length > 0 ||
      publicUrl.password.length > 0 ||
      publicUrl.search.length > 0 ||
      publicUrl.hash.length > 0)
  ) {
    throw new ServiceError(
      'HTTP_PUBLIC_URL_INVALID',
      'Streamable HTTP publicUrl must be an HTTP(S) origin or exact /mcp endpoint without credentials, a query, or a fragment',
    );
  }
  const publiclyExposed =
    !isLoopbackHost(http.host) || (publicUrl !== undefined && !isLoopbackHost(publicUrl.hostname));
  if (!publiclyExposed) {
    if (http.oauth !== undefined && http.principals.length === 0) {
      throw new ServiceError(
        'HTTP_PRINCIPAL_ALLOWLIST_REQUIRED',
        'OAuth Streamable HTTP requires an explicit principal allowlist',
      );
    }
    validateStaticTokenSecrets(configuration);
    return;
  }
  if (http.oauth === undefined) {
    throw new ServiceError(
      'HTTP_PUBLIC_OAUTH_REQUIRED',
      'Non-loopback HTTP requires OAuth/OIDC JWT verification; static tokens are loopback-only',
    );
  }
  if (publicUrl?.protocol !== 'https:') {
    throw new ServiceError(
      'HTTP_PUBLIC_HTTPS_REQUIRED',
      'Non-loopback HTTP requires an HTTPS publicUrl',
    );
  }
  const authorizationUrls = [
    http.oauth.issuer,
    http.oauth.jwksUri,
    ...http.oauth.authorizationServers,
  ];
  if (authorizationUrls.some((url) => new URL(url).protocol !== 'https:')) {
    throw new ServiceError(
      'HTTP_PUBLIC_OAUTH_HTTPS_REQUIRED',
      'Non-loopback OAuth issuer, JWKS, and authorization server URLs must use HTTPS',
    );
  }
  if (http.allowedOrigins.length === 0) {
    throw new ServiceError(
      'HTTP_ORIGIN_ALLOWLIST_REQUIRED',
      'Non-loopback HTTP requires allowed origins',
    );
  }
  if (http.principals.length === 0) {
    throw new ServiceError(
      'HTTP_PRINCIPAL_ALLOWLIST_REQUIRED',
      'OAuth Streamable HTTP requires an explicit principal allowlist',
    );
  }
}

export function protectedResourceMetadata(
  configuration: ServerConfiguration,
): Record<string, unknown> {
  const oauth = configuration.http.oauth;
  if (oauth === undefined || configuration.http.publicUrl === undefined) {
    throw new ServiceError('HTTP_OAUTH_NOT_CONFIGURED', 'OAuth metadata is not configured');
  }
  return {
    resource: new URL('/mcp', configuration.http.publicUrl).href,
    authorization_servers: oauth.authorizationServers,
    bearer_methods_supported: ['header'],
    scopes_supported: [...new Set([...oauth.requiredScopes, 'hoi4:write'])].sort((left, right) =>
      compareCodeUnits(left, right),
    ),
    resource_name: 'HOI4 Agent Tools',
  };
}
