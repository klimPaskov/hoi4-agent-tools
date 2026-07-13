import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { canonicalJson } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import { ServiceError } from '../../core/result.js';
import type { ServerContext } from '../server/base-tools.js';

const artifactResourceLimit = 1_048_576;
const artifactChunkMetadataKey = 'io.github.klimpaskov/hoi4-agent-tools.artifact-byte-range';
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const artifactResourceMetadata = {
  title: 'HOI4 review artifact',
  description:
    'Complete plans, diagnostics, layouts, previews, event graphs, routes, state and scope reports, comparisons, and diffs. Reads accept zero-based byte offset and positive byte length query selectors; each response reports its exact byte range and continuation URI in _meta.',
  _meta: {
    [artifactChunkMetadataKey]: {
      version: 1,
      unit: 'byte',
      maxChunkSize: artifactResourceLimit,
      selectors: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        length: {
          type: 'integer',
          minimum: 1,
          maximum: artifactResourceLimit,
          default: artifactResourceLimit,
        },
        metadata: { type: 'string', enum: ['manifest'], optional: true },
      },
    },
  },
} as const;

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
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = uri.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new ServiceError('ARTIFACT_RANGE_INVALID', 'Artifact byte range is invalid');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ServiceError('ARTIFACT_RANGE_INVALID', 'Artifact byte range is invalid');
  }
  return value;
}

function artifactChunkMetadata(
  uri: URL,
  metadata: 'manifest' | null,
  totalSize: number,
  offset: number,
  returnedLength: number,
  requestedLength: number,
): Record<string, unknown> {
  const endExclusive = offset + returnedLength;
  let continuationUri: string | null = null;
  if (endExclusive < totalSize) {
    const continuation = new URL(contentArtifactUri(uri));
    continuation.searchParams.set('offset', String(endExclusive));
    continuation.searchParams.set('length', String(requestedLength));
    if (metadata !== null) continuation.searchParams.set('metadata', metadata);
    continuationUri = continuation.href;
  }
  return {
    [artifactChunkMetadataKey]: {
      version: 1,
      unit: 'byte',
      totalSize,
      returnedRange: { offset, length: returnedLength, endExclusive },
      complete: offset === 0 && returnedLength === totalSize,
      continuationUri,
    },
  };
}

export function registerMcpResources(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  server.registerResource(
    'artifact',
    new ResourceTemplate(
      'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}',
      { list: undefined },
    ),
    artifactResourceMetadata,
    async (uri, { workspaceId }, extra) => {
      extra.signal.throwIfAborted();
      assertResourceSelectors(uri, ['offset', 'length', 'metadata']);
      const workspace = engine.resolver.get(String(workspaceId), context.principal);
      const offset = artifactRangeParameter(uri, 'offset', 0, 0);
      const length = artifactRangeParameter(
        uri,
        'length',
        artifactResourceLimit,
        1,
        artifactResourceLimit,
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
        const complete = start === 0 && selected.length === manifestBytes.length;
        const _meta = artifactChunkMetadata(
          uri,
          metadata,
          manifestBytes.length,
          start,
          selected.length,
          length,
        );
        return {
          contents: [
            complete
              ? {
                  uri: uri.href,
                  mimeType: 'application/json',
                  text: selected.toString('utf8'),
                  _meta,
                }
              : {
                  uri: uri.href,
                  mimeType: 'application/json',
                  blob: selected.toString('base64'),
                  _meta,
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
      const textual =
        artifact.mimeType.startsWith('text/') ||
        artifact.mimeType === 'application/json' ||
        artifact.mimeType === 'image/svg+xml';
      const start = Math.min(offset, artifact.totalSize);
      const complete = start === 0 && artifact.bytes.length === artifact.totalSize;
      const text = textual && complete ? exactUtf8Text(artifact.bytes) : undefined;
      const _meta = artifactChunkMetadata(
        uri,
        metadata,
        artifact.totalSize,
        start,
        artifact.bytes.length,
        length,
      );
      return {
        contents: [
          text !== undefined
            ? { uri: uri.href, mimeType: artifact.mimeType, text, _meta }
            : {
                uri: uri.href,
                mimeType: artifact.mimeType,
                blob: artifact.bytes.toString('base64'),
                _meta,
              },
        ],
      };
    },
  );
}
