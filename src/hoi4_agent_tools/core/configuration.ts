import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { CONFIG_VERSION } from '../version.js';
import { ServiceError } from './result.js';

export const HTTP_MAX_SAFE_CONCURRENT_REQUESTS = 2;
export const HTTP_MAX_AGGREGATE_BODY_BYTES = 16_777_216;
export const WORKSPACE_MAX_REGISTRATIONS = 1_000;
const WORKSPACE_MAX_SOURCE_ROOTS = 16;
const WORKSPACE_MAX_PATHS = 1_000;

const allowedOriginSchema = z.url().refine(
  (value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin !== 'null' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  },
  { message: 'Allowed origins must be exact HTTP(S) origins without credentials or paths' },
);

const relativeRootPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .superRefine((value, context) => {
    const normalized = value.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/u.test(normalized) ||
      normalized.includes(':') ||
      /[*?[\]{}!]/u.test(normalized) ||
      normalized.split('/').some((segment) => segment === '..') ||
      normalized.includes('\0')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Workspace source roots must be safe relative paths',
      });
    }
  });

const relativeRootsSchema = z
  .object({
    localisation: z
      .array(relativeRootPathSchema)
      .max(WORKSPACE_MAX_SOURCE_ROOTS)
      .default(['localisation', 'localisation_synced']),
    interface: z
      .array(relativeRootPathSchema)
      .max(WORKSPACE_MAX_SOURCE_ROOTS)
      .default(['interface']),
    gfx: z.array(relativeRootPathSchema).max(WORKSPACE_MAX_SOURCE_ROOTS).default(['gfx']),
    map: z.array(relativeRootPathSchema).max(WORKSPACE_MAX_SOURCE_ROOTS).default(['map']),
    focus: z
      .array(relativeRootPathSchema)
      .max(WORKSPACE_MAX_SOURCE_ROOTS)
      .default(['common/national_focus']),
    scriptedGui: z
      .array(relativeRootPathSchema)
      .max(WORKSPACE_MAX_SOURCE_ROOTS)
      .default(['common/scripted_guis']),
    states: z
      .array(relativeRootPathSchema)
      .max(WORKSPACE_MAX_SOURCE_ROOTS)
      .default(['history/states']),
  })
  .strict();

const dependencyRegistrationSchema = z
  .object({
    root: z.string().min(1),
    replacePaths: z.array(relativeRootPathSchema).max(WORKSPACE_MAX_PATHS).default([]),
  })
  .strict();

export const workspaceRegistrationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    name: z.string().min(1).max(200),
    root: z.string().min(1),
    kind: z.enum(['mod', 'game', 'dependency']).default('mod'),
    gameRoot: z.string().min(1).optional(),
    dependencyRoots: z.array(z.string().min(1)).max(WORKSPACE_MAX_SOURCE_ROOTS).default([]),
    dependencies: z.array(dependencyRegistrationSchema).max(WORKSPACE_MAX_SOURCE_ROOTS).default([]),
    replacePaths: z.array(relativeRootPathSchema).max(WORKSPACE_MAX_PATHS).default([]),
    roots: relativeRootsSchema.default({
      localisation: ['localisation', 'localisation_synced'],
      interface: ['interface'],
      gfx: ['gfx'],
      map: ['map'],
      focus: ['common/national_focus'],
      scriptedGui: ['common/scripted_guis'],
      states: ['history/states'],
    }),
    artifactRoot: z.string().min(1).optional(),
    cacheRoot: z.string().min(1).optional(),
    fixtureRoot: z.string().min(1).optional(),
    writeEnabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dependencyRoots.length > 0 && value.dependencies.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'Use dependencyRoots or structured dependencies, not both',
      });
    }
  });

const tokenSchema = z
  .object({
    principal: z.string().regex(/^[A-Za-z0-9._@-]{1,128}$/),
    tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    workspaceIds: z.array(z.string()).min(1).max(WORKSPACE_MAX_REGISTRATIONS),
    allowRegistration: z.boolean().default(false),
  })
  .strict();

const principalSchema = z
  .object({
    principal: z.string().regex(/^[A-Za-z0-9._@:-]{1,256}$/),
    workspaceIds: z.array(z.string()).max(WORKSPACE_MAX_REGISTRATIONS).default([]),
    allowRegistration: z.boolean().default(false),
  })
  .strict();

export const serverConfigurationSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    writePolicy: z.enum(['read-only', 'transactions', 'autonomous']).default('read-only'),
    serverStateRoot: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), {
        message: 'Server state root must be an absolute operator-controlled path',
      })
      .optional(),
    transactionTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
    transactionMaxJournalBytes: z
      .number()
      .int()
      .min(1_048_576)
      .max(Number.MAX_SAFE_INTEGER)
      .default(536_870_912),
    transactionMaxJournals: z.number().int().min(1).max(10_000).default(128),
    scanMaxFiles: z.number().int().min(1).max(1_000_000).default(20_000),
    scanMaxBytes: z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(134_217_728),
    scanMaxFileBytes: z.number().int().min(65_536).max(Number.MAX_SAFE_INTEGER).default(67_108_864),
    artifactMaxBytes: z
      .number()
      .int()
      .min(1_048_576)
      .max(Number.MAX_SAFE_INTEGER)
      .default(536_870_912),
    artifactMaxEntries: z.number().int().min(1).max(100_000).default(5_000),
    artifactMaxSingleBytes: z
      .number()
      .int()
      .min(1_048_576)
      .max(Number.MAX_SAFE_INTEGER)
      .default(134_217_728),
    registrationRoots: z.array(z.string().min(1)).max(WORKSPACE_MAX_SOURCE_ROOTS).default([]),
    writableRegistrationRoots: z
      .array(z.string().min(1))
      .max(WORKSPACE_MAX_SOURCE_ROOTS)
      .default([]),
    storageRoots: z.array(z.string().min(1)).max(WORKSPACE_MAX_SOURCE_ROOTS).default([]),
    workspaces: z.array(workspaceRegistrationSchema).max(WORKSPACE_MAX_REGISTRATIONS).default([]),
    http: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(0).max(65_535).default(3210),
        publicUrl: z.url().optional(),
        allowedOrigins: z.array(allowedOriginSchema).default([]),
        trustedProxyAddresses: z.array(z.union([z.ipv4(), z.ipv6()])).default([]),
        tokens: z.array(tokenSchema).max(WORKSPACE_MAX_REGISTRATIONS).default([]),
        principals: z.array(principalSchema).max(WORKSPACE_MAX_REGISTRATIONS).default([]),
        oauth: z
          .object({
            issuer: z.url(),
            jwksUri: z.url(),
            audience: z.string().min(1),
            authorizationServers: z.array(z.url()).min(1),
            requiredScopes: z.array(z.string().min(1)).default(['hoi4:read']),
            algorithms: z
              .array(z.enum(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'EdDSA']))
              .default(['RS256']),
          })
          .strict()
          .optional(),
        maxBodyBytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
        headersTimeoutMs: z.number().int().min(1_000).max(120_000).default(10_000),
        requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
        keepAliveTimeoutMs: z.number().int().min(1_000).max(120_000).default(5_000),
        maxConnections: z.number().int().min(1).max(100_000).default(64),
        maxRequestsPerSocket: z.number().int().min(1).max(100_000).default(100),
        maxConcurrentRequests: z
          .number()
          .int()
          .min(1)
          .max(HTTP_MAX_SAFE_CONCURRENT_REQUESTS)
          .default(HTTP_MAX_SAFE_CONCURRENT_REQUESTS),
        maxSessions: z.number().int().min(1).max(10_000).default(128),
        maxSessionsPerPrincipal: z.number().int().min(1).max(10_000).default(32),
        maxEventStreams: z.number().int().min(1).max(10_000).default(32),
        maxEventStreamsPerPrincipal: z.number().int().min(1).max(10_000).default(4),
        maxSessionEventBytes: z.number().int().min(65_536).max(67_108_864).default(1_048_576),
        maxEventStoreBytes: z.number().int().min(65_536).max(268_435_456).default(16_777_216),
        requestsPerMinute: z.number().int().min(1).max(100_000).default(120),
        sessionTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.oauth !== undefined && value.tokens.length > 0) {
          context.addIssue({
            code: 'custom',
            path: ['tokens'],
            message: 'OAuth and static bearer tokens are mutually exclusive deployment modes',
          });
        }
        const tokenPrincipals = new Set<string>();
        const tokenEnvironments = new Set<string>();
        for (const [index, token] of value.tokens.entries()) {
          if (tokenPrincipals.has(token.principal)) {
            context.addIssue({
              code: 'custom',
              path: ['tokens', index, 'principal'],
              message: 'Static-token principals must be unique',
            });
          }
          tokenPrincipals.add(token.principal);
          if (tokenEnvironments.has(token.tokenEnv)) {
            context.addIssue({
              code: 'custom',
              path: ['tokens', index, 'tokenEnv'],
              message: 'Static-token environment names must be unique',
            });
          }
          tokenEnvironments.add(token.tokenEnv);
        }

        const oauthPrincipals = new Set<string>();
        for (const [index, principal] of value.principals.entries()) {
          if (oauthPrincipals.has(principal.principal)) {
            context.addIssue({
              code: 'custom',
              path: ['principals', index, 'principal'],
              message: 'OAuth principals must be unique',
            });
          }
          oauthPrincipals.add(principal.principal);
          if (tokenPrincipals.has(principal.principal)) {
            context.addIssue({
              code: 'custom',
              path: ['principals', index, 'principal'],
              message: 'Static-token and OAuth principal namespaces must be disjoint',
            });
          }
        }
      })
      .default({
        host: '127.0.0.1',
        port: 3210,
        allowedOrigins: [],
        trustedProxyAddresses: [],
        tokens: [],
        principals: [],
        maxBodyBytes: 1_048_576,
        headersTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        keepAliveTimeoutMs: 5_000,
        maxConnections: 64,
        maxRequestsPerSocket: 100,
        maxConcurrentRequests: HTTP_MAX_SAFE_CONCURRENT_REQUESTS,
        maxSessions: 128,
        maxSessionsPerPrincipal: 32,
        maxEventStreams: 32,
        maxEventStreamsPerPrincipal: 4,
        maxSessionEventBytes: 1_048_576,
        maxEventStoreBytes: 16_777_216,
        requestsPerMinute: 120,
        sessionTtlSeconds: 3600,
      }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.writePolicy !== 'read-only' && value.serverStateRoot === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['serverStateRoot'],
        message: 'Write policies require an operator-controlled server state root',
      });
    }
    if (value.scanMaxFileBytes > value.scanMaxBytes) {
      context.addIssue({
        code: 'custom',
        path: ['scanMaxFileBytes'],
        message: 'Per-file scan bytes cannot exceed the aggregate scan-byte ceiling',
      });
    }
    if (value.artifactMaxSingleBytes > value.artifactMaxBytes) {
      context.addIssue({
        code: 'custom',
        path: ['artifactMaxSingleBytes'],
        message: 'Per-artifact bytes cannot exceed the aggregate artifact-byte ceiling',
      });
    }
    if (value.http.maxSessionEventBytes > value.http.maxEventStoreBytes) {
      context.addIssue({
        code: 'custom',
        path: ['http', 'maxSessionEventBytes'],
        message: 'Per-session event bytes cannot exceed the global event-store ceiling',
      });
    }
    if (value.http.headersTimeoutMs > value.http.requestTimeoutMs) {
      context.addIssue({
        code: 'custom',
        path: ['http', 'headersTimeoutMs'],
        message: 'HTTP header timeout cannot exceed the complete-request timeout',
      });
    }
    if (value.http.keepAliveTimeoutMs >= value.http.headersTimeoutMs) {
      context.addIssue({
        code: 'custom',
        path: ['http', 'keepAliveTimeoutMs'],
        message: 'HTTP keep-alive timeout must be shorter than the header timeout',
      });
    }
    const concurrentScanBytes = value.scanMaxBytes * value.http.maxConcurrentRequests;
    if (!Number.isSafeInteger(concurrentScanBytes) || concurrentScanBytes > 536_870_912) {
      context.addIssue({
        code: 'custom',
        path: ['scanMaxBytes'],
        message: 'Scan-byte ceiling multiplied by HTTP concurrency must not exceed 512 MiB',
      });
    }
    const concurrentBodyBytes = value.http.maxBodyBytes * value.http.maxConcurrentRequests;
    if (
      !Number.isSafeInteger(concurrentBodyBytes) ||
      concurrentBodyBytes > HTTP_MAX_AGGREGATE_BODY_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['http', 'maxBodyBytes'],
        message: 'HTTP body-byte ceiling multiplied by concurrency must not exceed 16 MiB',
      });
    }
  });

export type WorkspaceRegistration = z.infer<typeof workspaceRegistrationSchema>;
export type ServerConfiguration = z.infer<typeof serverConfigurationSchema>;

export async function loadConfiguration(filePath: string): Promise<ServerConfiguration> {
  const absolute = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, 'utf8')) as unknown;
  } catch (error) {
    throw new ServiceError('CONFIG_READ_FAILED', `Unable to read configuration: ${absolute}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const result = serverConfigurationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ServiceError('CONFIG_INVALID', 'Configuration failed schema validation', {
      issues: result.error.issues,
    });
  }
  const ids = new Set<string>();
  for (const workspace of result.data.workspaces) {
    if (ids.has(workspace.id)) {
      throw new ServiceError(
        'CONFIG_DUPLICATE_WORKSPACE',
        `Duplicate workspace ID: ${workspace.id}`,
      );
    }
    ids.add(workspace.id);
  }
  for (const token of result.data.http.tokens) {
    const unknown = token.workspaceIds.filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new ServiceError(
        'CONFIG_UNKNOWN_WORKSPACE_GRANT',
        'HTTP token grants unknown workspaces',
        {
          principal: token.principal,
          workspaceIds: unknown,
        },
      );
    }
  }
  for (const principal of result.data.http.principals) {
    const unknown = principal.workspaceIds.filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new ServiceError(
        'CONFIG_UNKNOWN_WORKSPACE_GRANT',
        'HTTP principal grants unknown workspaces',
        {
          principal: principal.principal,
          workspaceIds: unknown,
        },
      );
    }
  }
  return result.data;
}
