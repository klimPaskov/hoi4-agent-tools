import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CoreEngine } from '../../core/engine.js';
import type { ServerConfiguration } from '../../core/configuration.js';
import { canonicalJson } from '../../core/canonical.js';
import { MCP_PROTOCOL_VERSION } from '../../version.js';
import {
  authenticate,
  bearerChallenge,
  HttpAuthError,
  protectedResourceMetadata,
  validateHttpDeployment,
  type AuthenticatedPrincipal,
} from '../security/auth.js';
import { BoundedEventStore, SharedEventStoreBudget } from './event-store.js';
import type { ServerContext } from '../server/base-tools.js';
import { FinalProtocolTransport } from './protocol-gate.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  eventStore: BoundedEventStore;
  principal: string;
  clientId: string;
  credentialId: string;
  scopes: string[];
  authorizationContext: ServerContext;
  expiresAt: number;
  expiryTimer?: NodeJS.Timeout;
}

export interface HttpServerHandle {
  server: HttpServer;
  url: string;
  close(): Promise<void>;
}

type ServerFactory = (engine: CoreEngine, context: ServerContext) => McpServer;
type AuthenticatedRequest = Request & {
  authPrincipal?: AuthenticatedPrincipal;
  releaseAdmission?: () => void;
};

const WRITE_SCOPED_TOOLS = new Set(['hoi4.focus_rewrite', 'hoi4.gui_rewrite', 'hoi4.map_rewrite']);
const MCP_ALLOWED_METHODS = 'GET, POST, DELETE';
const SINGLETON_SECURITY_HEADERS = new Set([
  'authorization',
  'content-encoding',
  'content-type',
  'host',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
  'x-forwarded-for',
]);
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const HTTP_QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Format a configured bind host for an authority component without changing the listen host. */
export function httpUrlHost(host: string): string {
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
}

/** Match the WHATWG hostname representation used by the SDK Host-header middleware. */
export function httpAllowedHostname(host: string): string {
  return new URL(`http://${httpUrlHost(host)}`).hostname;
}

function normalizeIpAddress(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

export function rateLimitClientAddress(
  request: Request,
  configuration: ServerConfiguration,
): string | undefined {
  const socketAddress = normalizeIpAddress(request.socket.remoteAddress ?? 'unknown');
  const trusted = new Set(
    configuration.http.trustedProxyAddresses.map((address) => normalizeIpAddress(address)),
  );
  if (!trusted.has(socketAddress)) return socketAddress;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return undefined;
  const client = forwarded.split(',')[0]?.trim();
  if (client === undefined || isIP(client) === 0) return undefined;
  return normalizeIpAddress(client);
}

export function requiredScopesForMcpRequest(
  configuration: ServerConfiguration,
  body: unknown,
): string[] {
  const scopes = [...(configuration.http.oauth?.requiredScopes ?? ['hoi4:read'])];
  if (!isRecord(body) || body.method !== 'tools/call' || !isRecord(body.params)) {
    return [...new Set(scopes)];
  }
  if (typeof body.params.name === 'string' && WRITE_SCOPED_TOOLS.has(body.params.name)) {
    scopes.push('hoi4:write');
  }
  return [...new Set(scopes)];
}

function sessionHeader(request: Request): string | undefined {
  const value = request.headers['mcp-session-id'];
  return Array.isArray(value) ? undefined : value;
}

function scrubAuthorizationHeader(request: Request): void {
  delete request.headers.authorization;
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') {
      request.rawHeaders.splice(index, 2);
    }
  }
}

function jsonRpcError(response: Response, status: number, message: string, code = -32_000): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function splitHttpHeader(value: string, separator: ',' | ';'): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x00) return undefined;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === separator) {
      const part = value.slice(start, index).trim();
      if (part.length === 0) return undefined;
      parts.push(part);
      start = index + 1;
    }
  }
  if (quoted || escaped) return undefined;
  const finalPart = value.slice(start).trim();
  if (finalPart.length === 0) return undefined;
  parts.push(finalPart);
  return parts;
}

function decodeHttpParameterValue(raw: string): string | undefined {
  if (HTTP_TOKEN.test(raw)) return raw;
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  let value = '';
  let escaped = false;
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index]!;
    const code = raw.charCodeAt(index);
    if (escaped) {
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) return undefined;
      value += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"' || (code < 0x20 && code !== 0x09) || code === 0x7f) return undefined;
    value += character;
  }
  return escaped ? undefined : value;
}

interface ParsedMediaType {
  mediaType: string;
  parameters: Map<string, string>;
  quotedParameters: Set<string>;
}

function parseMediaType(value: string): ParsedMediaType | undefined {
  const segments = splitHttpHeader(value, ';');
  if (segments === undefined) return undefined;
  const [rawMediaType, ...rawParameters] = segments;
  const mediaType = rawMediaType?.trim() ?? '';
  const slash = mediaType.indexOf('/');
  if (slash < 1 || mediaType.includes('/', slash + 1)) return undefined;
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);
  if (!HTTP_TOKEN.test(type) || !HTTP_TOKEN.test(subtype)) return undefined;
  const parameters = new Map<string, string>();
  const quotedParameters = new Set<string>();
  for (const rawParameter of rawParameters) {
    const equals = rawParameter.indexOf('=');
    if (equals < 1) return undefined;
    const rawName = rawParameter.slice(0, equals);
    const rawValue = rawParameter.slice(equals + 1);
    if (rawName !== rawName.trim() || rawValue !== rawValue.trim()) return undefined;
    const name = rawName.toLowerCase();
    const parameterValue = decodeHttpParameterValue(rawValue);
    if (!HTTP_TOKEN.test(name) || parameterValue === undefined || parameters.has(name)) {
      return undefined;
    }
    parameters.set(name, parameterValue);
    if (rawValue.startsWith('"')) quotedParameters.add(name);
  }
  return {
    mediaType: `${type.toLowerCase()}/${subtype.toLowerCase()}`,
    parameters,
    quotedParameters,
  };
}

function acceptsExactMediaTypes(value: string | string[] | undefined, required: string[]): boolean {
  if (typeof value !== 'string') return false;
  const entries = splitHttpHeader(value, ',');
  if (entries === undefined) return false;
  const accepted = new Set<string>();
  for (const entry of entries) {
    const parsed = parseMediaType(entry);
    if (parsed === undefined) return false;
    const quality = parsed.parameters.get('q') ?? '1';
    if (parsed.quotedParameters.has('q') || !HTTP_QVALUE.test(quality)) return false;
    const representationParameters = [...parsed.parameters.keys()].filter((name) => name !== 'q');
    if (representationParameters.length === 0 && Number(quality) > 0) {
      accepted.add(parsed.mediaType);
    }
  }
  return required.every((mediaType) => accepted.has(mediaType));
}

function rejectAmbiguousSecurityHeaders(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name !== undefined && SINGLETON_SECURITY_HEADERS.has(name)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const invalid = [...counts].find(([, count]) => count > 1);
  if ((counts.get('host') ?? 0) !== 1 || invalid !== undefined) {
    jsonRpcError(response, 400, 'Ambiguous or duplicate security-sensitive HTTP header');
    return;
  }
  next();
}

function validateRequestTargetAuthority(
  allowedHosts: readonly string[],
): (request: Request, response: Response, next: NextFunction) => void {
  const normalizedAllowedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return (request, response, next): void => {
    if (request.url.startsWith('/')) {
      next();
      return;
    }
    if (!/^https?:\/\//iu.test(request.url)) {
      jsonRpcError(response, 400, 'Unsupported HTTP request-target form');
      return;
    }
    try {
      const target = new URL(request.url);
      const hostHeader = request.headers.host;
      if (typeof hostHeader !== 'string') throw new Error('Host is missing');
      const headerAuthority = new URL(`${target.protocol}//${hostHeader}`);
      if (
        target.username.length > 0 ||
        target.password.length > 0 ||
        target.hash.length > 0 ||
        !normalizedAllowedHosts.has(target.hostname.toLowerCase()) ||
        target.host.toLowerCase() !== headerAuthority.host.toLowerCase()
      ) {
        throw new Error('Absolute request target has an untrusted authority');
      }
    } catch {
      jsonRpcError(response, 400, 'Absolute request-target authority does not match Host');
      return;
    }
    next();
  };
}

function rejectUnacceptableMcpAccept(
  request: Request,
  response: Response,
  required: string[],
): boolean {
  if (acceptsExactMediaTypes(request.headers.accept, required)) return false;
  jsonRpcError(response, 406, `Not Acceptable: Accept must include ${required.join(' and ')}`);
  return true;
}

function requireMcpJsonContentType(request: Request, response: Response, next: NextFunction): void {
  // Validate the complete field value instead of using the SDK's substring check or a
  // lenient MIME parser. This accepts syntactically valid parameters on application/json,
  // but not structured suffixes, malformed parameters, duplicate field values, or a
  // parameter whose value merely contains "application/json".
  const contentType = request.headers['content-type'];
  const parsed = typeof contentType === 'string' ? parseMediaType(contentType) : undefined;
  const charset = parsed?.parameters.get('charset');
  if (
    parsed?.mediaType !== 'application/json' ||
    (charset !== undefined && charset.toLowerCase() !== 'utf-8')
  ) {
    jsonRpcError(
      response,
      415,
      'Unsupported Media Type: Content-Type must be UTF-8 application/json',
    );
    return;
  }
  next();
}

function requireIdentityContentEncoding(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const encoding = request.headers['content-encoding'];
  if (
    encoding !== undefined &&
    (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')
  ) {
    jsonRpcError(response, 415, 'Unsupported Media Type: Content-Encoding must be identity');
    return;
  }
  next();
}

function verifyMcpUtf8(
  _request: Request,
  _response: Response,
  buffer: Buffer,
  _encoding: string,
): void {
  UTF8_DECODER.decode(buffer);
}

function requireParsedMcpJsonBody(request: Request, response: Response, next: NextFunction): void {
  if (request.body === undefined) {
    jsonRpcError(response, 400, 'Parse error: Invalid JSON', -32_700);
    return;
  }
  next();
}

function rejectInvalidProtocolHeader(
  request: Request,
  response: Response,
  required: boolean,
): boolean {
  const value = request.headers['mcp-protocol-version'];
  if (value === MCP_PROTOCOL_VERSION) return false;
  if (value === undefined && !required) return false;
  if (value === undefined) {
    jsonRpcError(
      response,
      400,
      `Missing MCP-Protocol-Version header; this server requires ${MCP_PROTOCOL_VERSION}`,
    );
    return true;
  }
  jsonRpcError(
    response,
    400,
    `Unsupported MCP protocol version; this server requires ${MCP_PROTOCOL_VERSION}`,
  );
  return true;
}

function sendAuthError(
  response: Response,
  configuration: ServerConfiguration,
  error: HttpAuthError,
): void {
  response.setHeader('WWW-Authenticate', bearerChallenge(configuration, error));
  response.status(error.status).json({ error: error.code });
}

export function sessionAuthorizationMatches(
  session: {
    principal: string;
    clientId: string;
    credentialId: string;
    scopes: readonly string[];
  },
  principal: Pick<AuthenticatedPrincipal, 'principal' | 'clientId' | 'credentialId' | 'scopes'>,
): boolean {
  return (
    session.principal === principal.principal &&
    session.clientId === principal.clientId &&
    session.credentialId === principal.credentialId &&
    session.scopes.every((scope) => principal.scopes.includes(scope))
  );
}

function boundedSessionExpiration(
  principal: Pick<AuthenticatedPrincipal, 'expiresAt'>,
  now: number,
  sessionTtlMs: number,
): number {
  const inactivityExpiration = now + sessionTtlMs;
  return principal.expiresAt === undefined
    ? inactivityExpiration
    : Math.min(inactivityExpiration, principal.expiresAt * 1000);
}

export async function startHttpServer(
  engine: CoreEngine,
  configuration: ServerConfiguration,
  serverFactory: ServerFactory,
): Promise<HttpServerHandle> {
  validateHttpDeployment(configuration);
  const http = configuration.http;
  const allowedHosts = [httpAllowedHostname(http.host)];
  if (http.publicUrl !== undefined) allowedHosts.push(new URL(http.publicUrl).hostname);
  const app = express();
  app.disable('x-powered-by');
  app.use(rejectAmbiguousSecurityHeaders);
  app.use(validateRequestTargetAuthority(allowedHosts));
  app.use(hostHeaderValidation([...new Set(allowedHosts)]));

  const allowedOrigins = new Set(http.allowedOrigins.map((origin) => new URL(origin).origin));
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: 'origin_not_allowed' });
      return;
    }
    next();
  });

  const preAuthRates = new Map<string, { minute: number; count: number }>();
  const rates = new Map<string, { minute: number; count: number }>();
  let lastRatePruneMinute = -1;
  let concurrent = 0;
  const admissionMiddleware = (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): void => {
    if (concurrent >= http.maxConcurrentRequests) {
      response.status(429).setHeader('Retry-After', '1').json({ error: 'concurrency_limit' });
      return;
    }
    concurrent += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      concurrent = Math.max(0, concurrent - 1);
    };
    response.once('finish', release);
    response.once('close', release);
    request.releaseAdmission = release;

    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== lastRatePruneMinute) {
      for (const windows of [preAuthRates, rates]) {
        for (const [key, window] of windows) {
          if (window.minute < minute) windows.delete(key);
        }
      }
      lastRatePruneMinute = minute;
    }
    const remoteAddress = rateLimitClientAddress(request, configuration);
    if (remoteAddress === undefined) {
      response.status(400).json({ error: 'invalid_forwarded_for' });
      return;
    }
    const preAuthRate = preAuthRates.get(remoteAddress);
    const currentPreAuthRate = preAuthRate?.minute === minute ? preAuthRate : { minute, count: 0 };
    currentPreAuthRate.count += 1;
    preAuthRates.set(remoteAddress, currentPreAuthRate);
    if (currentPreAuthRate.count > http.requestsPerMinute) {
      response.status(429).setHeader('Retry-After', '60').json({ error: 'rate_limit' });
      return;
    }
    next();
  };
  app.use(admissionMiddleware);

  const authenticateMiddleware = async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const authorization = request.headers.authorization;
      request.authPrincipal = await authenticate(
        Array.isArray(authorization) ? undefined : authorization,
        configuration,
        requiredScopesForMcpRequest(configuration, request.body),
      );
      // Authentication is complete; do not let the SDK copy the bearer secret
      // into MessageExtraInfo.requestInfo for downstream MCP handlers.
      scrubAuthorizationHeader(request);
      const minute = Math.floor(Date.now() / 60_000);
      const rate = rates.get(request.authPrincipal.principal);
      const current = rate?.minute === minute ? rate : { minute, count: 0 };
      current.count += 1;
      rates.set(request.authPrincipal.principal, current);
      if (current.count > http.requestsPerMinute) {
        response.status(429).setHeader('Retry-After', '60').json({ error: 'rate_limit' });
        return;
      }
      next();
    } catch (error) {
      const authError =
        error instanceof HttpAuthError
          ? error
          : new HttpAuthError(
              401,
              'AUTH_INVALID',
              'Authentication failed',
              'invalid_token',
              requiredScopesForMcpRequest(configuration, request.body),
            );
      sendAuthError(response, configuration, authError);
    }
  };

  app.all('/mcp', async (request: AuthenticatedRequest, response, next) => {
    if (['GET', 'POST', 'DELETE'].includes(request.method)) {
      next();
      return;
    }
    await authenticateMiddleware(request, response, () => {
      response.setHeader('Allow', MCP_ALLOWED_METHODS);
      jsonRpcError(response, 405, 'Method not allowed.');
    });
  });
  // Every MCP POST is media-type gated and parsed here under the configured byte limit.
  // Supplying a defined parsed body to handleRequest prevents the SDK from falling back to
  // an unbounded Request.json() parse for alternate media types or empty established-session
  // requests. GET and DELETE deliberately remain bodyless.
  app.post('/mcp', requireMcpJsonContentType);
  app.post('/mcp', requireIdentityContentEncoding);
  app.post(
    '/mcp',
    express.json({
      limit: http.maxBodyBytes,
      strict: true,
      type: () => true,
      inflate: false,
      verify: verifyMcpUtf8,
    }),
  );
  app.post('/mcp', requireParsedMcpJsonBody);

  if (http.oauth !== undefined && http.publicUrl !== undefined) {
    const metadata = protectedResourceMetadata(configuration);
    app.get('/.well-known/oauth-protected-resource', (_request, response) =>
      response.json(metadata),
    );
    app.get('/.well-known/oauth-protected-resource/mcp', (_request, response) =>
      response.json(metadata),
    );
  }

  const sessions = new Map<string, Session>();
  const eventStoreBudget = new SharedEventStoreBudget(http.maxEventStoreBytes);
  let pendingSessions = 0;
  const pendingSessionsByPrincipal = new Map<string, number>();
  let eventStreams = 0;
  const eventStreamsByPrincipal = new Map<string, number>();
  const sessionTtlMs = http.sessionTtlSeconds * 1000;
  const removeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
    session.eventStore.clear();
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };
  const scheduleSessionExpiry = (sessionId: string, session: Session): void => {
    if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(
      () => void removeSession(sessionId),
      Math.max(0, session.expiresAt - Date.now()),
    );
    session.expiryTimer.unref();
  };
  const pruneExpiredSessions = async (): Promise<void> => {
    const now = Date.now();
    await Promise.all(
      [...sessions]
        .filter(([, session]) => session.expiresAt <= now)
        .map(([sessionId]) => removeSession(sessionId)),
    );
  };

  const findSession = async (
    request: AuthenticatedRequest,
    response: Response,
  ): Promise<Session | undefined> => {
    const id = sessionHeader(request);
    if (id === undefined) {
      jsonRpcError(response, 400, 'Missing MCP session ID');
      return undefined;
    }
    const session = sessions.get(id);
    if (session === undefined || session.expiresAt <= Date.now()) {
      if (session !== undefined) await removeSession(id);
      jsonRpcError(response, 404, 'Unknown or expired MCP session');
      return undefined;
    }
    const principal = request.authPrincipal;
    if (session.principal !== principal?.principal) {
      jsonRpcError(response, 403, 'MCP session belongs to another principal');
      return undefined;
    }
    if (
      session.clientId !== principal.clientId ||
      session.credentialId !== principal.credentialId
    ) {
      jsonRpcError(response, 403, 'MCP session authorization context does not match');
      return undefined;
    }
    const missingSessionScopes = session.scopes.filter(
      (scope) => !principal.scopes.includes(scope),
    );
    if (missingSessionScopes.length > 0) {
      sendAuthError(
        response,
        configuration,
        new HttpAuthError(
          403,
          'AUTH_SCOPE_INSUFFICIENT',
          'Bearer token cannot reduce the session authorization scope',
          'insufficient_scope',
          session.scopes,
        ),
      );
      return undefined;
    }
    const expandedScopes = [...new Set([...session.scopes, ...principal.scopes])];
    session.scopes = expandedScopes;
    session.authorizationContext.scopes = expandedScopes;
    session.expiresAt = boundedSessionExpiration(principal, Date.now(), sessionTtlMs);
    scheduleSessionExpiry(id, session);
    return session;
  };

  app.post('/mcp', authenticateMiddleware, async (request: AuthenticatedRequest, response) => {
    try {
      const sessionId = sessionHeader(request);
      if (rejectInvalidProtocolHeader(request, response, sessionId !== undefined)) return;
      if (Array.isArray(request.body)) {
        jsonRpcError(response, 400, 'JSON-RPC batching is not supported');
        return;
      }
      let session: Session | undefined;
      if (sessionId !== undefined) {
        session = await findSession(request, response);
        if (session === undefined) return;
      } else if (isInitializeRequest(request.body)) {
        if (
          rejectUnacceptableMcpAccept(request, response, ['application/json', 'text/event-stream'])
        ) {
          return;
        }
        await pruneExpiredSessions();
        const principal = request.authPrincipal;
        if (principal === undefined) {
          jsonRpcError(response, 401, 'Authentication context is missing');
          return;
        }
        const initialExpiration = boundedSessionExpiration(principal, Date.now(), sessionTtlMs);
        if (initialExpiration <= Date.now()) {
          sendAuthError(
            response,
            configuration,
            new HttpAuthError(
              401,
              'AUTH_INVALID',
              'Bearer token has expired',
              'invalid_token',
              requiredScopesForMcpRequest(configuration, request.body),
            ),
          );
          return;
        }
        if (sessions.size + pendingSessions >= http.maxSessions) {
          response.status(429).json({ error: 'session_limit' });
          return;
        }
        const principalSessionCount = [...sessions.values()].filter(
          (session) => session.principal === principal.principal,
        ).length;
        const pendingForPrincipal = pendingSessionsByPrincipal.get(principal.principal) ?? 0;
        if (
          principalSessionCount + pendingForPrincipal >=
          Math.min(http.maxSessions, http.maxSessionsPerPrincipal)
        ) {
          response.status(429).json({ error: 'principal_session_limit' });
          return;
        }
        pendingSessions += 1;
        pendingSessionsByPrincipal.set(principal.principal, pendingForPrincipal + 1);
        const authorizationContext: ServerContext = {
          principal: principal.principal,
          scopes: [...principal.scopes],
        };
        const server = serverFactory(engine, authorizationContext);
        const eventStore = new BoundedEventStore(
          1000,
          sessionTtlMs,
          Math.min(http.maxSessionEventBytes, http.maxEventStoreBytes),
          eventStoreBudget,
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          eventStore,
          onsessioninitialized: (newId) => {
            const session: Session = {
              transport,
              server,
              eventStore,
              principal: principal.principal,
              clientId: principal.clientId,
              credentialId: principal.credentialId,
              scopes: [...principal.scopes],
              authorizationContext,
              expiresAt: Math.min(
                initialExpiration,
                boundedSessionExpiration(principal, Date.now(), sessionTtlMs),
              ),
            };
            sessions.set(newId, session);
            scheduleSessionExpiry(newId, session);
          },
          onsessionclosed: async (closedId) => removeSession(closedId),
        });
        let initializedSessionId: string | undefined;
        try {
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id !== undefined) {
              const closed = sessions.get(id);
              if (closed !== undefined) clearTimeout(closed.expiryTimer);
              closed?.eventStore.clear();
              sessions.delete(id);
            }
          };
          await server.connect(new FinalProtocolTransport(transport as unknown as Transport));
          await transport.handleRequest(request, response, request.body);
          initializedSessionId = transport.sessionId;
        } finally {
          if (
            initializedSessionId === undefined ||
            sessions.get(initializedSessionId)?.transport !== transport
          ) {
            const registeredId = transport.sessionId;
            if (registeredId !== undefined && sessions.get(registeredId)?.transport === transport) {
              clearTimeout(sessions.get(registeredId)!.expiryTimer);
              sessions.delete(registeredId);
            }
            eventStore.clear();
            await transport.close().catch(() => undefined);
            await server.close().catch(() => undefined);
          }
          pendingSessions = Math.max(0, pendingSessions - 1);
          const remaining = (pendingSessionsByPrincipal.get(principal.principal) ?? 1) - 1;
          if (remaining <= 0) pendingSessionsByPrincipal.delete(principal.principal);
          else pendingSessionsByPrincipal.set(principal.principal, remaining);
        }
        return;
      } else {
        jsonRpcError(response, 400, 'No valid session ID or initialize request');
        return;
      }
      if (
        rejectUnacceptableMcpAccept(request, response, ['application/json', 'text/event-stream'])
      ) {
        return;
      }
      await session.transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) jsonRpcError(response, 500, 'Internal server error');
    }
  });

  app.get('/mcp', authenticateMiddleware, async (request: AuthenticatedRequest, response) => {
    if (rejectInvalidProtocolHeader(request, response, true)) return;
    const session = await findSession(request, response);
    if (session === undefined) return;
    if (rejectUnacceptableMcpAccept(request, response, ['text/event-stream'])) return;
    const principal = request.authPrincipal?.principal;
    if (principal === undefined) {
      jsonRpcError(response, 401, 'Authentication context is missing');
      return;
    }
    const principalStreams = eventStreamsByPrincipal.get(principal) ?? 0;
    if (eventStreams >= http.maxEventStreams) {
      response.status(429).setHeader('Retry-After', '1').json({ error: 'event_stream_limit' });
      return;
    }
    if (principalStreams >= http.maxEventStreamsPerPrincipal) {
      response
        .status(429)
        .setHeader('Retry-After', '1')
        .json({ error: 'principal_event_stream_limit' });
      return;
    }
    eventStreams += 1;
    eventStreamsByPrincipal.set(principal, principalStreams + 1);
    let streamReleased = false;
    const releaseStream = (): void => {
      if (streamReleased) return;
      streamReleased = true;
      eventStreams = Math.max(0, eventStreams - 1);
      const remaining = (eventStreamsByPrincipal.get(principal) ?? 1) - 1;
      if (remaining <= 0) eventStreamsByPrincipal.delete(principal);
      else eventStreamsByPrincipal.set(principal, remaining);
    };
    response.once('finish', releaseStream);
    response.once('close', releaseStream);
    request.releaseAdmission?.();
    await session.transport.handleRequest(request, response);
  });
  app.delete('/mcp', authenticateMiddleware, async (request: AuthenticatedRequest, response) => {
    if (rejectInvalidProtocolHeader(request, response, true)) return;
    const session = await findSession(request, response);
    if (session !== undefined) await session.transport.handleRequest(request, response);
  });

  app.use(
    (
      error: Error & { type?: string },
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (error.type === 'entity.too.large') {
        jsonRpcError(response, 413, 'Payload too large');
        return;
      }
      if (error.type === 'entity.parse.failed') {
        jsonRpcError(response, 400, 'Parse error: Invalid JSON', -32_700);
        return;
      }
      if (error.type === 'entity.verify.failed') {
        jsonRpcError(response, 400, 'Parse error: Invalid UTF-8 JSON', -32_700);
        return;
      }
      if (error.type === 'encoding.unsupported') {
        jsonRpcError(response, 415, 'Unsupported Media Type: Content-Encoding must be identity');
        return;
      }
      jsonRpcError(response, 500, 'Internal server error');
    },
  );

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(http.port, http.host, () => resolve(listener));
    listener.headersTimeout = http.headersTimeoutMs;
    listener.requestTimeout = http.requestTimeoutMs;
    listener.keepAliveTimeout = http.keepAliveTimeoutMs;
    listener.maxConnections = http.maxConnections;
    listener.maxRequestsPerSocket = http.maxRequestsPerSocket;
    listener.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : http.port;
  const url =
    http.publicUrl === undefined
      ? `http://${httpUrlHost(http.host)}:${port}/mcp`
      : new URL('/mcp', http.publicUrl).href;
  process.stderr.write(`${canonicalJson({ level: 'info', event: 'http_listening', url })}\n`);
  const cleanup = setInterval(
    () => {
      for (const [sessionId, session] of sessions) {
        if (session.expiresAt <= Date.now()) void removeSession(sessionId);
      }
    },
    Math.min(60_000, sessionTtlMs),
  );
  cleanup.unref();
  return {
    server,
    url,
    async close(): Promise<void> {
      clearInterval(cleanup);
      await Promise.all([...sessions.keys()].map(removeSession));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
