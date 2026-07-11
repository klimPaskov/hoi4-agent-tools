import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import { ServiceError } from '../../core/result.js';
import { compactWorkspaceStatus, type ServerContext } from '../server/base-tools.js';

const artifactResourceLimit = 1_048_576;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function assertResourceSelectors(uri: URL, allowed: readonly string[]): void {
  if (uri.hash !== '' || uri.username !== '' || uri.password !== '' || uri.port !== '') {
    throw new ServiceError('RESOURCE_URI_INVALID', 'Resource URI is not canonical');
  }
  const allowedNames = new Set(allowed);
  const seen = new Set<string>();
  for (const name of uri.searchParams.keys()) {
    if (!allowedNames.has(name)) {
      throw new ServiceError('RESOURCE_SELECTOR_INVALID', 'Resource selector is not supported');
    }
    if (seen.has(name)) {
      throw new ServiceError('RESOURCE_SELECTOR_INVALID', 'Resource selectors may not be repeated');
    }
    seen.add(name);
  }
}

function contentArtifactUri(uri: URL): string {
  const contentUri = new URL(uri);
  contentUri.search = '';
  contentUri.hash = '';
  return contentUri.href;
}

function transactionResourceIdentity(uri: URL): { workspaceId: string; transactionId: string } {
  let segments: string[];
  try {
    segments = uri.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new ServiceError('TRANSACTION_ID_INVALID', 'Invalid transaction resource URI');
  }
  if (
    uri.protocol !== 'hoi4-agent:' ||
    uri.hostname !== 'workspace' ||
    segments.length !== 3 ||
    segments[1] !== 'transaction' ||
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(segments[0]!) ||
    !/^txn_[0-9a-f-]{36}$/u.test(segments[2]!)
  ) {
    throw new ServiceError('TRANSACTION_ID_INVALID', 'Invalid transaction resource URI');
  }
  const canonical = `hoi4-agent://workspace/${encodeURIComponent(segments[0]!)}/transaction/${encodeURIComponent(segments[2]!)}`;
  const queryless = new URL(uri);
  queryless.search = '';
  queryless.hash = '';
  if (queryless.href !== canonical) {
    throw new ServiceError('TRANSACTION_ID_INVALID', 'Transaction resource URI is not canonical');
  }
  return { workspaceId: segments[0]!, transactionId: segments[2]! };
}

function exactUtf8Text(bytes: Buffer): string | undefined {
  try {
    const text = fatalUtf8Decoder.decode(bytes);
    return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
  } catch {
    return undefined;
  }
}

function artifactRangeParameter(
  uri: URL,
  name: 'offset' | 'length',
  fallback: number,
  minimum: number,
): number {
  const raw = uri.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new ServiceError('ARTIFACT_RANGE_INVALID', 'Artifact byte range is invalid');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ServiceError('ARTIFACT_RANGE_INVALID', 'Artifact byte range is invalid');
  }
  return value;
}

export function registerMcpResources(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  server.registerResource(
    'workspace-summary',
    new ResourceTemplate('hoi4-agent://workspace/{workspaceId}/summary', {
      list: () => ({
        resources: engine.list(context.principal).map((workspace) => ({
          uri: `hoi4-agent://workspace/${workspace.id}/summary`,
          name: `${workspace.name} summary`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Workspace summary',
      description: 'Registered workspace capabilities',
      mimeType: 'application/json',
    },
    (uri, { workspaceId }) => {
      assertResourceSelectors(uri, []);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: `${canonicalJson(compactWorkspaceStatus(engine.status(String(workspaceId), context.principal)))}\n`,
          },
        ],
      };
    },
  );

  server.registerResource(
    'artifact',
    new ResourceTemplate(
      'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}',
      {
        list: undefined,
      },
    ),
    { title: 'Generated artifact', description: 'Content-addressed workspace artifact' },
    async (uri, { workspaceId }, extra) => {
      extra.signal.throwIfAborted();
      assertResourceSelectors(uri, ['offset', 'length', 'metadata']);
      const workspace = engine.resolver.get(String(workspaceId), context.principal);
      const offset = artifactRangeParameter(uri, 'offset', 0, 0);
      const length = Math.min(
        artifactResourceLimit,
        artifactRangeParameter(uri, 'length', artifactResourceLimit, 1),
      );
      const metadata = uri.searchParams.get('metadata');
      if (metadata !== null && metadata !== 'manifest') {
        throw new ServiceError(
          'ARTIFACT_METADATA_INVALID',
          'Artifact metadata selector is invalid',
        );
      }
      if (metadata === 'manifest') {
        const described = await engine.artifacts.describe(
          workspace,
          contentArtifactUri(uri),
          extra.signal,
        );
        const { path: artifactPath, ...publicManifest } = described;
        void artifactPath;
        const manifestBytes = Buffer.from(`${canonicalJson(publicManifest)}\n`, 'utf8');
        const start = Math.min(offset, manifestBytes.length);
        const selected = manifestBytes.subarray(
          start,
          Math.min(manifestBytes.length, start + length),
        );
        extra.signal.throwIfAborted();
        const complete = start === 0 && selected.length === manifestBytes.length;
        return {
          contents: [
            complete
              ? { uri: uri.href, mimeType: 'application/json', text: selected.toString('utf8') }
              : {
                  uri: uri.href,
                  mimeType: 'application/json',
                  blob: selected.toString('base64'),
                },
          ],
        };
      }
      const artifact = await engine.artifacts.read(
        workspace,
        contentArtifactUri(uri),
        { offset, length },
        extra.signal,
      );
      extra.signal.throwIfAborted();
      const textual =
        artifact.mimeType.startsWith('text/') ||
        artifact.mimeType === 'application/json' ||
        artifact.mimeType === 'image/svg+xml';
      const complete = offset === 0 && artifact.bytes.length === artifact.totalSize;
      const text = textual && complete ? exactUtf8Text(artifact.bytes) : undefined;
      return {
        contents: [
          text !== undefined
            ? { uri: uri.href, mimeType: artifact.mimeType, text }
            : {
                uri: uri.href,
                mimeType: artifact.mimeType,
                blob: artifact.bytes.toString('base64'),
              },
        ],
      };
    },
  );

  server.registerResource(
    'transaction-manifest',
    new ResourceTemplate('hoi4-agent://workspace/{workspaceId}/transaction/{transactionId}', {
      list: undefined,
    }),
    {
      title: 'Transaction manifest',
      description: 'Declarative transaction and rollback status',
      mimeType: 'application/json',
    },
    async (uri, { workspaceId }, extra) => {
      extra.signal.throwIfAborted();
      assertResourceSelectors(uri, ['offset', 'length']);
      const identity = transactionResourceIdentity(uri);
      if (identity.workspaceId !== String(workspaceId)) {
        throw new ServiceError(
          'TRANSACTION_WORKSPACE_MISMATCH',
          'Transaction resource does not belong to this workspace',
        );
      }
      const offset = artifactRangeParameter(uri, 'offset', 0, 0);
      const length = Math.min(
        artifactResourceLimit,
        artifactRangeParameter(uri, 'length', artifactResourceLimit, 1),
      );
      const manifestRange = await engine.transactions.readManifestRange(
        identity.workspaceId,
        identity.transactionId,
        { offset, length },
        context.principal,
        extra.signal,
      );
      extra.signal.throwIfAborted();
      const complete = offset === 0 && manifestRange.bytes.length === manifestRange.totalSize;
      return {
        contents: [
          complete
            ? {
                uri: uri.href,
                mimeType: 'application/json',
                text: manifestRange.bytes.toString('utf8'),
              }
            : {
                uri: uri.href,
                mimeType: 'application/json',
                blob: manifestRange.bytes.toString('base64'),
              },
        ],
      };
    },
  );

  const packageRoot = path.resolve(import.meta.dirname, '../../../..');
  const documentation = new Map<string, string>([
    ['agent-integration', 'docs/agent-integration.md'],
    ['architecture', 'docs/architecture.md'],
    ['artifacts', 'docs/artifacts.md'],
    ['compatibility', 'docs/compatibility.md'],
    ['configuration', 'docs/configuration.md'],
    ['focus-workflow', 'docs/focus-workflow.md'],
    ['gui-workflow', 'docs/gui-workflow.md'],
    ['limitations', 'docs/limitations.md'],
    ['map-workflow', 'docs/map-workflow.md'],
    ['security', 'docs/security.md'],
    ['self-hosting', 'docs/self-hosting.md'],
    ['testing', 'docs/testing.md'],
    ['transactions', 'docs/transactions.md'],
    ['troubleshooting', 'docs/troubleshooting.md'],
  ]);
  server.registerResource(
    'documentation',
    new ResourceTemplate('hoi4-agent://docs/{name}', {
      list: () => ({
        resources: [...documentation.keys()].map((name) => ({
          uri: `hoi4-agent://docs/${name}`,
          name: `${name} documentation`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'HOI4 Agent Tools documentation',
      description: 'Versioned package documentation for coding agents',
      mimeType: 'text/markdown',
    },
    async (uri, { name }, extra) => {
      extra.signal.throwIfAborted();
      assertResourceSelectors(uri, []);
      const relative = documentation.get(String(name));
      if (relative === undefined) throw new ServiceError('RESOURCE_NOT_FOUND', 'Unknown document');
      const contents = await readFile(path.join(packageRoot, relative), 'utf8');
      extra.signal.throwIfAborted();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: contents,
          },
        ],
      };
    },
  );

  const schemas = new Map<string, string>([
    ['configuration', 'schemas/configuration.schema.json'],
    ['continuous-focus-palette', 'schemas/continuous-focus-palette.schema.json'],
    ['focus-plan', 'schemas/focus-plan.schema.json'],
    ['focus-planning-sidecar', 'schemas/focus-planning-sidecar.schema.json'],
    ['gui-animation-source', 'schemas/gui-animation-source.schema.json'],
    ['gui-helper', 'schemas/gui-helper.schema.json'],
    ['gui-scenario', 'schemas/gui-scenario.schema.json'],
    ['map-operation', 'schemas/map-operation.schema.json'],
    ['operation-result', 'schemas/operation-result.schema.json'],
    ['transaction-manifest', 'schemas/transaction-manifest.schema.json'],
  ]);
  server.registerResource(
    'schema',
    new ResourceTemplate('hoi4-agent://schema/{name}', {
      list: () => ({
        resources: [...schemas.keys()].map((name) => ({
          uri: `hoi4-agent://schema/${name}`,
          name: `${name} JSON Schema`,
          mimeType: 'application/schema+json',
        })),
      }),
    }),
    {
      title: 'Public JSON Schema',
      description: 'Versioned strict schemas shipped with the package',
      mimeType: 'application/schema+json',
    },
    async (uri, { name }, extra) => {
      extra.signal.throwIfAborted();
      assertResourceSelectors(uri, []);
      const relative = schemas.get(String(name));
      if (relative === undefined) throw new ServiceError('RESOURCE_NOT_FOUND', 'Unknown schema');
      const contents = await readFile(path.join(packageRoot, relative), 'utf8');
      extra.signal.throwIfAborted();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/schema+json',
            text: contents,
          },
        ],
      };
    },
  );
}
