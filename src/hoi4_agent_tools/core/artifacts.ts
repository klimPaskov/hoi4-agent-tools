import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { canonicalJson, compareCodeUnits, sha256Bytes } from './canonical.js';
import type { ArtifactLink } from './result.js';
import { ServiceError } from './result.js';
import type { ResolvedWorkspace } from './workspace.js';
import { containedGeneratedPath, isPortablePathSegment } from './workspace.js';

export interface ArtifactProvenance {
  kind: string;
  toolVersion: string;
  schemaVersion: string;
  sourceHashes: Record<string, string>;
  renderProfile?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface StoredArtifact extends ArtifactLink {
  sha256: string;
  provenanceHash: string;
  path: string;
  provenance: ArtifactProvenance;
}

export interface ArtifactWrite {
  name: string;
  mimeType: string;
  content: Uint8Array | string;
  provenance: ArtifactProvenance;
  description?: string;
}

export interface ChunkedArtifactIndex {
  schemaVersion: 1;
  type: 'hoi4-agent.chunked-artifact';
  original: {
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    description?: string;
  };
  chunks: Array<{
    index: number;
    offset: number;
    length: number;
    uri: string;
    name: string;
    mimeType: 'application/octet-stream';
    size: number;
    sha256: string;
  }>;
}

export interface BoundedSourceHashEvidence {
  sourceHashes: Record<string, string>;
  inventory: {
    schemaVersion: 1;
    algorithm: 'sha256-length-prefixed-path-digest-v1';
    count: number;
    digest: string;
    retainedCount: number;
    truncated: boolean;
  };
}

export interface ArtifactPage {
  artifacts: ArtifactLink[];
  total: number;
  revision: string;
  afterFound: boolean;
  hasMore: boolean;
}

interface ArtifactManifest {
  version: 2;
  workspaceIdentity: string;
  ownerIdentity: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  provenanceHash: string;
  provenance: ArtifactProvenance;
  description?: string;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactProvenanceSchema = z
  .object({
    kind: z.string(),
    toolVersion: z.string(),
    schemaVersion: z.string(),
    sourceHashes: z.record(z.string(), sha256Schema),
    renderProfile: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const artifactManifestSchema = z
  .object({
    version: z.literal(2),
    workspaceIdentity: sha256Schema,
    ownerIdentity: sha256Schema,
    name: z.string(),
    mimeType: z.string(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
    provenanceHash: sha256Schema,
    provenance: artifactProvenanceSchema,
    description: z.string().optional(),
  })
  .strict();

interface ArtifactFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function artifactFileIdentity(value: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): ArtifactFileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameArtifactIdentity(
  left: ArtifactFileIdentity | undefined,
  right: ArtifactFileIdentity,
): boolean {
  return (
    left?.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function provenanceHashFor(manifest: Omit<ArtifactManifest, 'provenanceHash'>): string {
  return sha256Bytes(
    canonicalJson({
      version: manifest.version,
      workspaceIdentity: manifest.workspaceIdentity,
      ownerIdentity: manifest.ownerIdentity,
      name: manifest.name,
      mimeType: manifest.mimeType,
      size: manifest.size,
      sha256: manifest.sha256,
      provenance: manifest.provenance,
      description: manifest.description ?? null,
    }),
  );
}

function artifactContentBytes(content: Uint8Array | string): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

function chunkArtifactName(originalSha256: string, index: number): string {
  return `chunk-${originalSha256}-${String(index).padStart(6, '0')}.part`;
}

function chunkIndexArtifactName(originalName: string, originalSha256: string): string {
  const suffix = `.${originalSha256.slice(0, 16)}.chunks.json`;
  const prefix = originalName.slice(0, Math.max(1, 128 - suffix.length));
  return `${prefix}${suffix}`;
}

function chunkedProvenance(
  provenance: ArtifactProvenance,
  role: 'chunk' | 'index',
  original: { name: string; mimeType: string; size: number; sha256: string },
  details: Record<string, unknown>,
): ArtifactProvenance {
  return {
    ...provenance,
    kind: `${provenance.kind}-${role}`,
    metadata: {
      ...(provenance.metadata ?? {}),
      chunkedArtifact: {
        role,
        originalName: original.name,
        originalMimeType: original.mimeType,
        originalSize: original.size,
        originalSha256: original.sha256,
        ...details,
      },
    },
  };
}

/**
 * Keep provenance manifests bounded while retaining a deterministic commitment
 * to every source path/hash pair. Complete inventories remain in domain evidence.
 */
export function boundedSourceHashEvidence(
  sourceHashes: Readonly<Record<string, string>>,
): BoundedSourceHashEvidence {
  const entries = Object.entries(sourceHashes).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  const digest = createHash('sha256');
  digest.update('source-hash-inventory.v1\0', 'utf8');
  const retained: Array<[string, string]> = [];
  let retainedBytes = 2;
  let retainedCount = 0;
  const maximumRetainedBytes = 131_072;
  const maximumRetainedEntries = 256;
  for (const [sourcePath, sourceHash] of entries) {
    const pathBytes = Buffer.from(sourcePath, 'utf8');
    digest.update(String(pathBytes.length), 'ascii');
    digest.update(':', 'ascii');
    digest.update(pathBytes);
    digest.update(':', 'ascii');
    digest.update(sourceHash, 'ascii');
    digest.update('\n', 'ascii');

    const entryBytes =
      Buffer.byteLength(JSON.stringify(sourcePath), 'utf8') +
      Buffer.byteLength(JSON.stringify(sourceHash), 'utf8') +
      2;
    if (
      retainedCount < maximumRetainedEntries &&
      retainedBytes + entryBytes <= maximumRetainedBytes
    ) {
      retained.push([sourcePath, sourceHash]);
      retainedBytes += entryBytes;
      retainedCount += 1;
    }
  }
  return {
    sourceHashes: Object.fromEntries(retained),
    inventory: {
      schemaVersion: 1,
      algorithm: 'sha256-length-prefixed-path-digest-v1',
      count: entries.length,
      digest: digest.digest('hex'),
      retainedCount,
      truncated: retainedCount !== entries.length,
    },
  };
}

function assertManifestIntegrity(
  manifest: ArtifactManifest,
  expected: { sha256: string; provenanceHash: string; name: string },
  workspace: ResolvedWorkspace,
): void {
  if (
    manifest.workspaceIdentity !== workspace.workspaceIdentity ||
    manifest.ownerIdentity !== workspace.ownerIdentity ||
    manifest.sha256 !== expected.sha256 ||
    manifest.provenanceHash !== expected.provenanceHash ||
    manifest.name !== expected.name ||
    provenanceHashFor(manifest) !== expected.provenanceHash
  ) {
    throw new ServiceError(
      'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
      'Artifact provenance manifest does not match its immutable address',
    );
  }
}

/** Return the only artifact fields that may cross the MCP trust boundary. */
export function publicArtifactLink(artifact: ArtifactLink): ArtifactLink {
  return {
    uri: artifact.uri,
    name: artifact.name,
    mimeType: artifact.mimeType,
    ...(artifact.size === undefined ? {} : { size: artifact.size }),
    ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
    ...(artifact.description === undefined ? {} : { description: artifact.description }),
  };
}

const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const reservedManifestSuffix = '.manifest.json';
const artifactReadBufferBytes = 1_048_576;
const artifactPageMaxEntries = 100;
const artifactManifestMaxBytes = 1_048_576;
const artifactLogicalBatchMaxBytes = 536_870_912;
const artifactHashYieldBytes = 16_777_216;
const artifactPreflightYieldEntries = 256;
const ownedArtifactContent = Symbol('ownedArtifactContent');
const precomputedArtifactSha256 = Symbol('precomputedArtifactSha256');
export const chunkedArtifactIndexMimeType = 'application/json';

type InternalArtifactWrite = ArtifactWrite & {
  [ownedArtifactContent]?: true;
  [precomputedArtifactSha256]?: string;
};

interface ArtifactBatchAdmission {
  contentLengths: number[];
  totalBytes: number;
  projectedEntries: number;
}

interface PreparedArtifactWrite {
  artifact: StoredArtifact;
  bytes: Buffer;
  directory: string;
  target: string;
  manifestPath: string;
  manifestBytes: string;
}

interface RetainedArtifactManifest {
  manifest: ArtifactManifest;
  manifestPath: string;
  manifestBytes: number;
  modifiedAt: number;
  targetPath: string;
  targetBytes: number;
}

function isValidArtifactName(name: string): boolean {
  return (
    safeNamePattern.test(name) &&
    isPortablePathSegment(name) &&
    !name.toLowerCase().endsWith(reservedManifestSuffix)
  );
}

function artifactContentByteLength(content: Uint8Array | string): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
}

async function preflightArtifactBatch(
  writes: readonly ArtifactWrite[],
  limits: { maxBytes: number; maxEntries: number; maxSingleBytes: number; chunked: boolean },
  signal?: AbortSignal,
): Promise<ArtifactBatchAdmission> {
  const { maxBytes, maxEntries, maxSingleBytes, chunked } = limits;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isSafeInteger(maxSingleBytes) ||
    maxSingleBytes < 1 ||
    maxSingleBytes > maxBytes
  ) {
    throw new ServiceError('ARTIFACT_STORAGE_LIMIT', 'Configured artifact limits are invalid');
  }
  const contentLengths: number[] = [];
  let totalBytes = 0;
  let projectedEntries = 0;
  for (const [writeIndex, write] of writes.entries()) {
    signal?.throwIfAborted();
    if (!isValidArtifactName(write.name)) {
      throw new ServiceError('ARTIFACT_NAME_INVALID', `Invalid artifact name: ${write.name}`);
    }
    if (!artifactProvenanceSchema.safeParse(write.provenance).success) {
      throw new ServiceError(
        'ARTIFACT_PROVENANCE_INVALID',
        'Artifact provenance must contain only valid SHA-256 source hashes',
      );
    }
    const contentLength = artifactContentByteLength(write.content);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new ServiceError('ARTIFACT_STORAGE_LIMIT', 'Artifact content byte length is unsafe', {
        name: write.name,
      });
    }
    if (!chunked && contentLength > maxSingleBytes) {
      throw new ServiceError(
        'ARTIFACT_SINGLE_LIMIT',
        'Artifact exceeds the configured per-artifact byte limit',
        {
          name: write.name,
          mimeType: write.mimeType,
          size: contentLength,
          maximumBytes: maxSingleBytes,
        },
      );
    }
    contentLengths.push(contentLength);
    totalBytes += contentLength;
    const entriesForWrite =
      chunked && contentLength > maxSingleBytes ? Math.ceil(contentLength / maxSingleBytes) + 1 : 1;
    projectedEntries += entriesForWrite;
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(projectedEntries)) {
      throw new ServiceError('ARTIFACT_STORAGE_LIMIT', 'Artifact batch size is unsafe');
    }
    if ((writeIndex + 1) % artifactPreflightYieldEntries === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
  }
  const preparationCeiling = Math.min(maxBytes, artifactLogicalBatchMaxBytes);
  if (totalBytes > preparationCeiling) {
    const fixedCeilingApplies = artifactLogicalBatchMaxBytes <= maxBytes;
    throw new ServiceError(
      fixedCeilingApplies ? 'ARTIFACT_LOGICAL_BATCH_LIMIT' : 'ARTIFACT_STORAGE_LIMIT',
      fixedCeilingApplies
        ? 'Logical artifact batch exceeds the fixed in-memory preparation ceiling'
        : 'Logical artifact batch exceeds the configured aggregate artifact-byte limit',
      { size: totalBytes, maximumBytes: preparationCeiling },
    );
  }
  if (projectedEntries > maxEntries) {
    throw new ServiceError(
      'ARTIFACT_STORAGE_LIMIT',
      'Artifact batch exceeds the configured artifact-entry limit',
      { projectedEntries, maximumEntries: maxEntries },
    );
  }
  signal?.throwIfAborted();
  return { contentLengths, totalBytes, projectedEntries };
}

async function sha256BytesWithSignal(bytes: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.length; offset += artifactHashYieldBytes) {
    hash.update(bytes.subarray(offset, Math.min(bytes.length, offset + artifactHashYieldBytes)));
    if (offset + artifactHashYieldBytes < bytes.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
}

function manifestAddressSortKey(fileName: string): string {
  const matched = /^(.*)\.([a-f0-9]{64})\.manifest\.json$/u.exec(fileName);
  return matched === null ? fileName : `${matched[2]}/${encodeURIComponent(matched[1]!)}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const artifactQueues = new Map<string, Promise<void>>();

async function waitForArtifactTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) {
    await previous;
    return;
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  signal.throwIfAborted();
}

async function withArtifactQueue<T>(
  root: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = artifactQueues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  artifactQueues.set(root, tail);
  try {
    await waitForArtifactTurn(previous, signal);
    return await action();
  } finally {
    release();
    void tail.then(() => {
      if (artifactQueues.get(root) === tail) artifactQueues.delete(root);
    });
  }
}

async function artifactUsage(
  root: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const walk = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const child of children) {
      signal?.throwIfAborted();
      if (child.isSymbolicLink()) {
        throw new ServiceError(
          'ARTIFACT_STORAGE_UNSAFE',
          'Artifact storage contains a symbolic link or junction',
        );
      }
      const candidate = await containedGeneratedPath(
        root,
        path.relative(root, path.join(directory, child.name)),
      );
      if (child.isDirectory()) await walk(candidate);
      else if (child.isFile()) {
        bytes += (await stat(candidate)).size;
        if (child.name.endsWith('.manifest.json')) entries += 1;
        if (!Number.isSafeInteger(bytes)) {
          throw new ServiceError('ARTIFACT_STORAGE_LIMIT', 'Artifact storage size is unsafe');
        }
      }
    }
  };
  await walk(await containedGeneratedPath(root));
  return { bytes, entries };
}

async function readArtifactManifest(
  filePath: string,
  signal?: AbortSignal,
): Promise<ArtifactManifest> {
  signal?.throwIfAborted();
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new ServiceError('ARTIFACT_NOT_FOUND', 'Artifact provenance manifest is unavailable');
  }
  signal?.throwIfAborted();
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ServiceError('ARTIFACT_MANIFEST_INVALID', 'Artifact provenance manifest is invalid');
  }
  if (metadata.size > artifactManifestMaxBytes) {
    throw new ServiceError(
      'ARTIFACT_MANIFEST_LIMIT',
      'Artifact provenance manifest exceeds its fixed byte limit',
    );
  }
  let text: string;
  try {
    text =
      signal === undefined
        ? await readFile(filePath, 'utf8')
        : await readFile(filePath, { encoding: 'utf8', signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ServiceError('ARTIFACT_NOT_FOUND', 'Artifact provenance manifest is unavailable');
  }
  signal?.throwIfAborted();
  try {
    const validated = artifactManifestSchema.safeParse(JSON.parse(text) as unknown);
    if (!validated.success) throw new Error('invalid artifact manifest');
    return validated.data as ArtifactManifest;
  } catch {
    throw new ServiceError('ARTIFACT_MANIFEST_INVALID', 'Artifact provenance manifest is invalid');
  }
}

async function readVerifiedArtifactRange(
  filePath: string,
  expectedSha256: string,
  range?: { offset: number; length: number },
  verifiedIdentity?: ArtifactFileIdentity,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; totalSize: number; identity: ArtifactFileIdentity }> {
  signal?.throwIfAborted();
  if (
    range !== undefined &&
    (!Number.isSafeInteger(range.offset) ||
      range.offset < 0 ||
      !Number.isSafeInteger(range.length) ||
      range.length < 1)
  ) {
    throw new ServiceError('ARTIFACT_RANGE_INVALID', 'Artifact byte range is invalid');
  }
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    throw new ServiceError('ARTIFACT_NOT_FOUND', 'Artifact content is unavailable');
  }
  try {
    signal?.throwIfAborted();
    const beforeIdentity = artifactFileIdentity(await handle.stat());
    const totalSize = beforeIdentity.size;
    const offset = range === undefined ? 0 : Math.min(totalSize, range.offset);
    const requestedLength =
      range === undefined ? totalSize - offset : Math.min(range.length, artifactReadBufferBytes);
    const selectedLength = Math.min(requestedLength, totalSize - offset);
    const selected = Buffer.allocUnsafe(selectedLength);
    if (sameArtifactIdentity(verifiedIdentity, beforeIdentity)) {
      let selectedPosition = 0;
      while (selectedPosition < selectedLength) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          selected,
          selectedPosition,
          selectedLength - selectedPosition,
          offset + selectedPosition,
        );
        if (bytesRead === 0) {
          throw new ServiceError(
            'ARTIFACT_READ_INCOMPLETE',
            'Artifact content changed while reading',
          );
        }
        selectedPosition += bytesRead;
      }
    } else {
      const scratch = Buffer.allocUnsafe(Math.min(artifactReadBufferBytes, Math.max(1, totalSize)));
      const hash = createHash('sha256');
      let position = 0;
      while (position < totalSize) {
        signal?.throwIfAborted();
        const requested = Math.min(scratch.length, totalSize - position);
        const { bytesRead } = await handle.read(scratch, 0, requested, position);
        if (bytesRead === 0) {
          throw new ServiceError(
            'ARTIFACT_READ_INCOMPLETE',
            'Artifact content changed while reading',
          );
        }
        const chunk = scratch.subarray(0, bytesRead);
        hash.update(chunk);
        const chunkEnd = position + bytesRead;
        const selectionEnd = offset + selectedLength;
        const overlapStart = Math.max(position, offset);
        const overlapEnd = Math.min(chunkEnd, selectionEnd);
        if (overlapStart < overlapEnd) {
          chunk.copy(
            selected,
            overlapStart - offset,
            overlapStart - position,
            overlapEnd - position,
          );
        }
        position = chunkEnd;
      }
      if (hash.digest('hex') !== expectedSha256) {
        throw new ServiceError('ARTIFACT_INTEGRITY_FAILED', 'Artifact hash does not match its URI');
      }
    }
    signal?.throwIfAborted();
    const afterIdentity = artifactFileIdentity(await handle.stat());
    if (!sameArtifactIdentity(beforeIdentity, afterIdentity)) {
      throw new ServiceError('ARTIFACT_READ_INCOMPLETE', 'Artifact content changed while reading');
    }
    return { bytes: selected, totalSize, identity: afterIdentity };
  } catch (error) {
    if (error instanceof ServiceError || (error as Error).name === 'AbortError') throw error;
    throw new ServiceError('ARTIFACT_READ_FAILED', 'Artifact content could not be read');
  } finally {
    await handle.close();
  }
}

export class ArtifactStore {
  readonly #verifiedContent = new Map<string, ArtifactFileIdentity>();

  public constructor(
    private readonly maxBytes = 536_870_912,
    private readonly maxEntries = 5_000,
    private readonly maxSingleBytes = 134_217_728,
  ) {}

  private async pruneForAdmission(
    workspace: ResolvedWorkspace,
    usage: { bytes: number; entries: number },
    additionalBytes: number,
    additionalEntries: number,
    protectedManifests: ReadonlySet<string>,
    protectedTargets: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; entries: number }> {
    if (
      usage.entries + additionalEntries <= this.maxEntries &&
      usage.bytes <= this.maxBytes - additionalBytes
    ) {
      return usage;
    }

    // Reclaim to a low-water mark so a busy agent workflow does not rescan and evict one artifact
    // for every subsequent tool call. The incoming batch itself remains protected and atomic.
    const targetBytes = Math.max(
      0,
      Math.min(this.maxBytes - additionalBytes, Math.floor(this.maxBytes * 0.75)),
    );
    const targetEntries = Math.max(
      0,
      Math.min(this.maxEntries - additionalEntries, Math.floor(this.maxEntries * 0.75)),
    );
    const retained: RetainedArtifactManifest[] = [];
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const child of children) {
        signal?.throwIfAborted();
        if (child.isSymbolicLink()) {
          throw new ServiceError(
            'ARTIFACT_STORAGE_UNSAFE',
            'Artifact storage contains a symbolic link or junction',
          );
        }
        const candidate = await containedGeneratedPath(
          workspace.artifactRoot,
          path.relative(workspace.artifactRoot, path.join(directory, child.name)),
        );
        if (child.isDirectory()) {
          await walk(candidate);
          continue;
        }
        if (!child.isFile() || !child.name.endsWith('.manifest.json')) continue;
        const metadata = await lstat(candidate);
        const manifest = await readArtifactManifest(candidate, signal);
        if (child.name !== `${manifest.name}.${manifest.provenanceHash}.manifest.json`) {
          throw new ServiceError(
            'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
            'Artifact provenance manifest filename does not match its contents',
          );
        }
        assertManifestIntegrity(
          manifest,
          {
            sha256: path.basename(directory),
            provenanceHash: manifest.provenanceHash,
            name: manifest.name,
          },
          workspace,
        );
        const targetPath = await containedGeneratedPath(
          workspace.artifactRoot,
          path.relative(workspace.artifactRoot, path.join(directory, manifest.name)),
        );
        let targetBytes = 0;
        try {
          targetBytes = (await stat(targetPath)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        retained.push({
          manifest,
          manifestPath: candidate,
          manifestBytes: metadata.size,
          modifiedAt: metadata.mtimeMs,
          targetPath,
          targetBytes,
        });
      }
    };
    await walk(await containedGeneratedPath(workspace.artifactRoot));
    retained.sort(
      (left, right) =>
        left.modifiedAt - right.modifiedAt ||
        compareCodeUnits(left.manifestPath, right.manifestPath),
    );

    const current = { ...usage };
    for (const candidate of retained) {
      signal?.throwIfAborted();
      if (current.bytes <= targetBytes && current.entries <= targetEntries) break;
      if (protectedManifests.has(candidate.manifestPath)) continue;
      try {
        await unlink(candidate.manifestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      current.entries = Math.max(0, current.entries - 1);
      current.bytes = Math.max(0, current.bytes - candidate.manifestBytes);

      if (protectedTargets.has(candidate.targetPath)) continue;
      const prefix = `${candidate.manifest.name}.`;
      const hasManifest = (
        await readdir(path.dirname(candidate.targetPath), { withFileTypes: true })
      ).some(
        (entry) =>
          entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.manifest.json'),
      );
      if (hasManifest) continue;
      try {
        await unlink(candidate.targetPath);
        current.bytes = Math.max(0, current.bytes - candidate.targetBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const verificationPrefix = `${workspace.workspaceIdentity}\0${workspace.ownerIdentity}\0${candidate.targetPath}\0`;
      for (const key of this.#verifiedContent.keys()) {
        if (key.startsWith(verificationPrefix)) this.#verifiedContent.delete(key);
      }
    }

    if (
      current.entries + additionalEntries > this.maxEntries ||
      current.bytes > this.maxBytes - additionalBytes
    ) {
      throw new ServiceError(
        'ARTIFACT_STORAGE_LIMIT',
        'Artifact batch cannot fit after reclaiming expired artifacts',
      );
    }
    return current;
  }

  async list(workspace: ResolvedWorkspace, signal?: AbortSignal): Promise<ArtifactLink[]> {
    signal?.throwIfAborted();
    const usage = await artifactUsage(workspace.artifactRoot, signal);
    if (usage.bytes > this.maxBytes || usage.entries > this.maxEntries) {
      throw new ServiceError(
        'ARTIFACT_STORAGE_LIMIT',
        'Artifact storage exceeds the configured retention budget',
      );
    }
    const results: ArtifactLink[] = [];
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
        signal?.throwIfAborted();
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(
            await containedGeneratedPath(
              workspace.artifactRoot,
              path.relative(workspace.artifactRoot, candidate),
            ),
          );
        } else if (entry.isFile() && entry.name.endsWith('.manifest.json')) {
          const manifest = await readArtifactManifest(
            await containedGeneratedPath(
              workspace.artifactRoot,
              path.relative(workspace.artifactRoot, candidate),
            ),
            signal,
          );
          if (entry.name !== `${manifest.name}.${manifest.provenanceHash}.manifest.json`) {
            throw new ServiceError(
              'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
              'Artifact provenance manifest filename does not match its contents',
            );
          }
          assertManifestIntegrity(
            manifest,
            {
              sha256: path.basename(directory),
              provenanceHash: manifest.provenanceHash,
              name: manifest.name,
            },
            workspace,
          );
          results.push({
            uri: this.uri(workspace.id, manifest.sha256, manifest.provenanceHash, manifest.name),
            name: manifest.name,
            mimeType: manifest.mimeType,
            size: manifest.size,
            sha256: manifest.sha256,
            ...(manifest.description === undefined ? {} : { description: manifest.description }),
          });
        }
      }
    };
    await walk(await containedGeneratedPath(workspace.artifactRoot));
    return results.sort((a, b) => compareCodeUnits(a.uri, b.uri));
  }

  async listPage(
    workspace: ResolvedWorkspace,
    options: { limit: number; afterUri?: string },
    signal?: AbortSignal,
  ): Promise<ArtifactPage> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > artifactPageMaxEntries
    ) {
      throw new ServiceError(
        'ARTIFACT_PAGE_INVALID',
        `Artifact page limit must be between 1 and ${artifactPageMaxEntries}`,
      );
    }
    const usage = await artifactUsage(workspace.artifactRoot, signal);
    if (usage.bytes > this.maxBytes || usage.entries > this.maxEntries) {
      throw new ServiceError(
        'ARTIFACT_STORAGE_LIMIT',
        'Artifact storage exceeds the configured retention budget',
      );
    }

    const artifacts: ArtifactLink[] = [];
    const revision = createHash('sha256');
    let total = 0;
    let afterFound = options.afterUri === undefined;
    let hasMore = false;
    const visitManifest = async (directory: string, entryName: string): Promise<void> => {
      signal?.throwIfAborted();
      const manifest = await readArtifactManifest(
        await containedGeneratedPath(
          workspace.artifactRoot,
          path.relative(workspace.artifactRoot, path.join(directory, entryName)),
        ),
        signal,
      );
      if (entryName !== `${manifest.name}.${manifest.provenanceHash}.manifest.json`) {
        throw new ServiceError(
          'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
          'Artifact provenance manifest filename does not match its contents',
        );
      }
      assertManifestIntegrity(
        manifest,
        {
          sha256: path.basename(directory),
          provenanceHash: manifest.provenanceHash,
          name: manifest.name,
        },
        workspace,
      );
      const uri = this.uri(workspace.id, manifest.sha256, manifest.provenanceHash, manifest.name);
      revision.update(`${Buffer.byteLength(uri, 'utf8')}:${uri}`);
      total += 1;
      if (!afterFound) {
        if (uri === options.afterUri) afterFound = true;
        return;
      }
      if (artifacts.length < options.limit) {
        artifacts.push({
          uri,
          name: manifest.name,
          mimeType: manifest.mimeType,
          size: manifest.size,
          sha256: manifest.sha256,
          ...(manifest.description === undefined ? {} : { description: manifest.description }),
        });
      } else {
        hasMore = true;
      }
    };
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries
        .filter((candidate) => candidate.isDirectory())
        .sort((left, right) => compareCodeUnits(left.name, right.name))) {
        signal?.throwIfAborted();
        await walk(
          await containedGeneratedPath(
            workspace.artifactRoot,
            path.relative(workspace.artifactRoot, path.join(directory, entry.name)),
          ),
        );
      }
      for (const entry of entries
        .filter((candidate) => candidate.isFile() && candidate.name.endsWith('.manifest.json'))
        .sort((left, right) =>
          compareCodeUnits(manifestAddressSortKey(left.name), manifestAddressSortKey(right.name)),
        )) {
        await visitManifest(directory, entry.name);
      }
    };
    await walk(await containedGeneratedPath(workspace.artifactRoot));
    return {
      artifacts,
      total,
      revision: revision.digest('hex'),
      afterFound,
      hasMore,
    };
  }

  async describe(
    workspace: ResolvedWorkspace,
    uri: string,
    signal?: AbortSignal,
  ): Promise<StoredArtifact> {
    signal?.throwIfAborted();
    const parsed = this.parseUri(workspace, uri);
    const target = await containedGeneratedPath(
      workspace.artifactRoot,
      parsed.sha256.slice(0, 2),
      parsed.sha256,
      `${parsed.name}.${parsed.provenanceHash}.manifest.json`,
    );
    const manifest = await readArtifactManifest(target, signal);
    assertManifestIntegrity(manifest, parsed, workspace);
    return {
      uri,
      name: manifest.name,
      mimeType: manifest.mimeType,
      size: manifest.size,
      sha256: manifest.sha256,
      provenanceHash: manifest.provenanceHash,
      provenance: manifest.provenance,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      path: await containedGeneratedPath(
        workspace.artifactRoot,
        parsed.sha256.slice(0, 2),
        parsed.sha256,
        parsed.name,
      ),
    };
  }

  async put(
    workspace: ResolvedWorkspace,
    name: string,
    mimeType: string,
    content: Uint8Array | string,
    provenance: ArtifactProvenance,
    description?: string,
    signal?: AbortSignal,
  ): Promise<StoredArtifact> {
    return this.withAtomicWrites(
      workspace,
      [
        {
          name,
          mimeType,
          content,
          provenance,
          ...(description === undefined ? {} : { description }),
        },
      ],
      ([artifact]) => {
        if (artifact === undefined) throw new Error('Artifact batch returned no result');
        return Promise.resolve(artifact);
      },
      signal,
    );
  }

  /**
   * Store one logical artifact without weakening the configured per-object limit.
   * Oversized content is represented by a canonical JSON index whose ordered
   * resource links reconstruct the exact original bytes.
   */
  async putChunked(
    workspace: ResolvedWorkspace,
    name: string,
    mimeType: string,
    content: Uint8Array | string,
    provenance: ArtifactProvenance,
    description?: string,
    signal?: AbortSignal,
  ): Promise<StoredArtifact> {
    return this.withAtomicChunkedWrites(
      workspace,
      [
        {
          name,
          mimeType,
          content,
          provenance,
          ...(description === undefined ? {} : { description }),
        },
      ],
      ([artifact]) => {
        if (artifact === undefined) throw new Error('Artifact batch returned no result');
        return Promise.resolve(artifact);
      },
      signal,
    );
  }

  /**
   * Persist logical artifacts as one failure boundary. Every small write maps to
   * one normal artifact. Every oversized write maps to an index plus bounded
   * content chunks, while the callback receives only the logical normal/index
   * artifacts in the caller's original order.
   */
  async withAtomicChunkedWrites<T>(
    workspace: ResolvedWorkspace,
    writes: readonly ArtifactWrite[],
    commit: (artifacts: readonly StoredArtifact[]) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const admission = await preflightArtifactBatch(
      writes,
      {
        maxBytes: this.maxBytes,
        maxEntries: this.maxEntries,
        maxSingleBytes: this.maxSingleBytes,
        chunked: true,
      },
      signal,
    );
    const physicalWrites: InternalArtifactWrite[] = [];
    const logicalIndexes: number[] = [];

    for (const [writeIndex, write] of writes.entries()) {
      signal?.throwIfAborted();
      const expectedLength = admission.contentLengths[writeIndex]!;
      const bytes = artifactContentBytes(write.content);
      if (bytes.length !== expectedLength) {
        throw new ServiceError(
          'ARTIFACT_CONTENT_CHANGED',
          'Artifact content length changed after batch admission',
          { name: write.name, expectedLength, actualLength: bytes.length },
        );
      }
      signal?.throwIfAborted();
      if (bytes.length <= this.maxSingleBytes) {
        const sha256 = await sha256BytesWithSignal(bytes, signal);
        logicalIndexes.push(physicalWrites.length);
        physicalWrites.push({
          ...write,
          content: bytes,
          [ownedArtifactContent]: true,
          [precomputedArtifactSha256]: sha256,
        });
        continue;
      }
      const originalSha256 = await sha256BytesWithSignal(bytes, signal);
      const original = {
        name: write.name,
        mimeType: write.mimeType,
        size: bytes.length,
        sha256: originalSha256,
      };
      const chunkCount = Math.ceil(bytes.length / this.maxSingleBytes);
      const chunks: ChunkedArtifactIndex['chunks'] = [];
      for (let index = 0; index < chunkCount; index += 1) {
        signal?.throwIfAborted();
        const offset = index * this.maxSingleBytes;
        const content = bytes.subarray(
          offset,
          Math.min(bytes.length, offset + this.maxSingleBytes),
        );
        const name = chunkArtifactName(originalSha256, index);
        const provenance = chunkedProvenance(write.provenance, 'chunk', original, {
          chunkIndex: index,
          chunkCount,
          offset,
          length: content.length,
        });
        const chunkSha256 = await sha256BytesWithSignal(content, signal);
        const chunkWrite: InternalArtifactWrite = {
          name,
          mimeType: 'application/octet-stream',
          content,
          provenance,
          description: `Byte-exact chunk ${index + 1} of ${chunkCount} for ${write.name}`,
          [ownedArtifactContent]: true,
          [precomputedArtifactSha256]: chunkSha256,
        };
        const planned = this.plannedArtifactLink(workspace, chunkWrite, content, chunkSha256);
        chunks.push({
          index,
          offset,
          length: content.length,
          uri: planned.uri,
          name: planned.name,
          mimeType: 'application/octet-stream',
          size: content.length,
          sha256: planned.sha256!,
        });
        physicalWrites.push(chunkWrite);
      }

      const indexDocument: ChunkedArtifactIndex = {
        schemaVersion: 1,
        type: 'hoi4-agent.chunked-artifact',
        original: {
          ...original,
          ...(write.description === undefined ? {} : { description: write.description }),
        },
        chunks,
      };
      const indexContent = Buffer.from(`${canonicalJson(indexDocument)}\n`, 'utf8');
      if (
        indexContent.length > this.maxSingleBytes ||
        indexContent.length > artifactManifestMaxBytes
      ) {
        throw new ServiceError(
          'ARTIFACT_CHUNK_INDEX_LIMIT',
          'Chunked artifact index exceeds its fixed single-resource byte limit',
          {
            name: write.name,
            size: indexContent.length,
            maximumBytes: Math.min(this.maxSingleBytes, artifactManifestMaxBytes),
          },
        );
      }
      const indexSha256 = await sha256BytesWithSignal(indexContent, signal);
      const indexWrite: InternalArtifactWrite = {
        name: chunkIndexArtifactName(write.name, originalSha256),
        mimeType: chunkedArtifactIndexMimeType,
        content: indexContent,
        provenance: chunkedProvenance(write.provenance, 'index', original, {
          chunkCount,
          indexSchemaVersion: 1,
        }),
        description:
          write.description === undefined
            ? `Byte-exact chunk index for ${write.name}`
            : `${write.description} (byte-exact chunk index)`,
        [ownedArtifactContent]: true,
        [precomputedArtifactSha256]: indexSha256,
      };
      logicalIndexes.push(physicalWrites.length);
      physicalWrites.push(indexWrite);
    }

    if (physicalWrites.length !== admission.projectedEntries) {
      throw new ServiceError(
        'ARTIFACT_STORAGE_LIMIT',
        'Artifact batch entry projection did not match prepared output',
      );
    }

    return this.withAtomicWrites(
      workspace,
      physicalWrites,
      (stored) => commit(logicalIndexes.map((index) => stored[index]!)),
      signal,
    );
  }

  private plannedArtifactLink(
    workspace: ResolvedWorkspace,
    write: ArtifactWrite,
    bytes: Buffer,
    sha256: string,
  ): ArtifactLink {
    const manifestWithoutHash: Omit<ArtifactManifest, 'provenanceHash'> = {
      version: 2,
      workspaceIdentity: workspace.workspaceIdentity,
      ownerIdentity: workspace.ownerIdentity,
      name: write.name,
      mimeType: write.mimeType,
      size: bytes.length,
      sha256,
      provenance: write.provenance,
      ...(write.description === undefined ? {} : { description: write.description }),
    };
    const provenanceHash = provenanceHashFor(manifestWithoutHash);
    return {
      uri: this.uri(workspace.id, sha256, provenanceHash, write.name),
      name: write.name,
      mimeType: write.mimeType,
      size: bytes.length,
      sha256,
      ...(write.description === undefined ? {} : { description: write.description }),
    };
  }

  /**
   * Persist a set of immutable artifacts as one failure boundary. Files created by
   * this batch are removed if preparation, storage admission, a write, or the
   * caller's commit callback fails. Pre-existing content or provenance manifests
   * are never removed, so rollback remains safe when artifacts are shared.
   */
  async withAtomicWrites<T>(
    workspace: ResolvedWorkspace,
    writes: readonly ArtifactWrite[],
    commit: (artifacts: readonly StoredArtifact[]) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const admission = await preflightArtifactBatch(
      writes,
      {
        maxBytes: this.maxBytes,
        maxEntries: this.maxEntries,
        maxSingleBytes: this.maxSingleBytes,
        chunked: false,
      },
      signal,
    );
    const prepared: PreparedArtifactWrite[] = [];
    for (const [writeIndex, write] of writes.entries()) {
      const { name, mimeType, content, provenance, description } = write;
      const internal = write as InternalArtifactWrite;
      signal?.throwIfAborted();
      const bytes =
        internal[ownedArtifactContent] === true && Buffer.isBuffer(content)
          ? content
          : artifactContentBytes(content);
      const expectedLength = admission.contentLengths[writeIndex]!;
      if (bytes.length !== expectedLength) {
        throw new ServiceError(
          'ARTIFACT_CONTENT_CHANGED',
          'Artifact content length changed after batch admission',
          { name, expectedLength, actualLength: bytes.length },
        );
      }
      signal?.throwIfAborted();
      const sha256 =
        internal[precomputedArtifactSha256] ?? (await sha256BytesWithSignal(bytes, signal));
      if (!/^[a-f0-9]{64}$/u.test(sha256)) {
        throw new ServiceError('ARTIFACT_HASH_INVALID', 'Precomputed artifact hash is invalid');
      }
      signal?.throwIfAborted();
      const manifestWithoutHash = {
        version: 2 as const,
        workspaceIdentity: workspace.workspaceIdentity,
        ownerIdentity: workspace.ownerIdentity,
        name,
        mimeType,
        size: bytes.length,
        sha256,
        provenance,
        ...(description === undefined ? {} : { description }),
      };
      const provenanceHash = provenanceHashFor(manifestWithoutHash);
      const manifest: ArtifactManifest = { ...manifestWithoutHash, provenanceHash };
      const manifestBytes = `${canonicalJson(manifest)}\n`;
      if (
        Buffer.byteLength(manifestBytes, 'utf8') > this.maxSingleBytes ||
        Buffer.byteLength(manifestBytes, 'utf8') > artifactManifestMaxBytes
      ) {
        throw new ServiceError(
          'ARTIFACT_MANIFEST_LIMIT',
          'Artifact provenance exceeds its fixed manifest byte limit',
        );
      }
      const directory = await containedGeneratedPath(
        workspace.artifactRoot,
        sha256.slice(0, 2),
        sha256,
      );
      const target = await containedGeneratedPath(
        workspace.artifactRoot,
        sha256.slice(0, 2),
        sha256,
        name,
      );
      const manifestPath = await containedGeneratedPath(
        workspace.artifactRoot,
        sha256.slice(0, 2),
        sha256,
        `${name}.${provenanceHash}.manifest.json`,
      );
      signal?.throwIfAborted();
      const artifact: StoredArtifact = {
        uri: this.uri(workspace.id, sha256, provenanceHash, name),
        name,
        mimeType,
        size: bytes.length,
        sha256,
        provenanceHash,
        ...(description === undefined ? {} : { description }),
        path: target,
        provenance,
      };
      prepared.push({ artifact, bytes, directory, target, manifestPath, manifestBytes });
    }

    return withArtifactQueue(
      workspace.artifactRoot,
      async () => {
        signal?.throwIfAborted();
        const uniqueTargets = new Map<string, (typeof prepared)[number] & { exists: boolean }>();
        const uniqueManifests = new Map<string, (typeof prepared)[number] & { exists: boolean }>();
        for (const artifact of prepared) {
          signal?.throwIfAborted();
          const duplicateTarget = uniqueTargets.get(artifact.target);
          if (duplicateTarget !== undefined && !duplicateTarget.bytes.equals(artifact.bytes)) {
            throw new ServiceError(
              'ARTIFACT_HASH_COLLISION',
              'Artifact batch maps different bytes to the same content path',
            );
          }
          if (duplicateTarget === undefined) {
            const exists = await fileExists(artifact.target);
            signal?.throwIfAborted();
            if (exists) {
              const verificationKey = `${workspace.workspaceIdentity}\0${workspace.ownerIdentity}\0${artifact.target}\0${artifact.artifact.sha256}`;
              try {
                const verified = await readVerifiedArtifactRange(
                  artifact.target,
                  artifact.artifact.sha256,
                  { offset: 0, length: 1 },
                  this.#verifiedContent.get(verificationKey),
                  signal,
                );
                this.#verifiedContent.set(verificationKey, verified.identity);
              } catch (error) {
                if ((error as Error).name === 'AbortError') throw error;
                throw new ServiceError(
                  'ARTIFACT_HASH_COLLISION',
                  'Artifact path contains different bytes',
                );
              }
            }
            uniqueTargets.set(artifact.target, { ...artifact, exists });
          }

          const duplicateManifest = uniqueManifests.get(artifact.manifestPath);
          if (
            duplicateManifest !== undefined &&
            duplicateManifest.manifestBytes !== artifact.manifestBytes
          ) {
            throw new ServiceError(
              'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
              'Artifact batch maps different provenance to the same immutable manifest',
            );
          }
          if (duplicateManifest === undefined) {
            const exists = await fileExists(artifact.manifestPath);
            signal?.throwIfAborted();
            if (
              exists &&
              `${canonicalJson(await readArtifactManifest(artifact.manifestPath, signal))}\n` !==
                artifact.manifestBytes
            ) {
              throw new ServiceError(
                'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
                'Immutable artifact provenance manifest contains different bytes',
              );
            }
            uniqueManifests.set(artifact.manifestPath, { ...artifact, exists });
          }
        }

        const additionalBytes =
          [...uniqueTargets.values()].reduce(
            (total, artifact) => total + (artifact.exists ? 0 : artifact.bytes.length),
            0,
          ) +
          [...uniqueManifests.values()].reduce(
            (total, artifact) =>
              total + (artifact.exists ? 0 : Buffer.byteLength(artifact.manifestBytes, 'utf8')),
            0,
          );
        if (!Number.isSafeInteger(additionalBytes)) {
          throw new ServiceError('ARTIFACT_STORAGE_LIMIT', 'Artifact batch size is unsafe');
        }
        const usage = await artifactUsage(workspace.artifactRoot, signal);
        const additionalEntries = [...uniqueManifests.values()].filter(
          (artifact) => !artifact.exists,
        ).length;
        await this.pruneForAdmission(
          workspace,
          usage,
          additionalBytes,
          additionalEntries,
          new Set(uniqueManifests.keys()),
          new Set(uniqueTargets.keys()),
          signal,
        );

        const createdTargets: string[] = [];
        const createdManifests: string[] = [];
        try {
          for (const artifact of uniqueTargets.values()) {
            signal?.throwIfAborted();
            if (artifact.exists) continue;
            await mkdir(artifact.directory, { recursive: true });
            signal?.throwIfAborted();
            try {
              await writeFile(artifact.target, artifact.bytes, {
                flag: 'wx',
                ...(signal === undefined ? {} : { signal }),
              });
              createdTargets.push(artifact.target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                createdTargets.push(artifact.target);
              }
              throw error;
            }
          }
          for (const artifact of uniqueManifests.values()) {
            signal?.throwIfAborted();
            if (artifact.exists) continue;
            await mkdir(artifact.directory, { recursive: true });
            signal?.throwIfAborted();
            try {
              await writeFile(artifact.manifestPath, artifact.manifestBytes, {
                flag: 'wx',
                ...(signal === undefined ? {} : { signal }),
              });
              createdManifests.push(artifact.manifestPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                createdManifests.push(artifact.manifestPath);
              }
              throw error;
            }
          }
          signal?.throwIfAborted();
          // The caller's commit callback is the ownership boundary. Once entered,
          // it completes or fails under its own critical-phase rules; a late abort
          // cannot make the store remove evidence already committed elsewhere.
          return await commit(prepared.map(({ artifact }) => artifact));
        } catch (error) {
          let cleanupFailed = false;
          for (const manifestPath of createdManifests.reverse()) {
            try {
              await unlink(manifestPath);
            } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true;
            }
          }
          for (const target of createdTargets.reverse()) {
            try {
              const prefix = `${path.basename(target)}.`;
              const hasManifest = (
                await readdir(path.dirname(target), { withFileTypes: true })
              ).some(
                (entry) =>
                  entry.isFile() &&
                  entry.name.startsWith(prefix) &&
                  entry.name.endsWith('.manifest.json'),
              );
              if (!hasManifest) {
                await unlink(target);
                const verificationPrefix = `${workspace.workspaceIdentity}\0${workspace.ownerIdentity}\0${target}\0`;
                for (const key of this.#verifiedContent.keys()) {
                  if (key.startsWith(verificationPrefix)) this.#verifiedContent.delete(key);
                }
              }
            } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true;
            }
          }
          if (cleanupFailed) {
            throw new ServiceError(
              'ARTIFACT_BATCH_ROLLBACK_FAILED',
              'Artifact batch failed and its newly created files could not all be removed',
            );
          }
          throw error;
        }
      },
      signal,
    );
  }

  async read(
    workspace: ResolvedWorkspace,
    uri: string,
    range?: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mimeType: string; name: string; totalSize: number }> {
    signal?.throwIfAborted();
    const { sha256, provenanceHash, name } = this.parseUri(workspace, uri);
    const target = await containedGeneratedPath(
      workspace.artifactRoot,
      sha256.slice(0, 2),
      sha256,
      name,
    );
    const manifestPath = await containedGeneratedPath(
      workspace.artifactRoot,
      sha256.slice(0, 2),
      sha256,
      `${name}.${provenanceHash}.manifest.json`,
    );
    const manifest = await readArtifactManifest(manifestPath, signal);
    assertManifestIntegrity(manifest, { sha256, provenanceHash, name }, workspace);
    const verificationKey = `${workspace.workspaceIdentity}\0${workspace.ownerIdentity}\0${target}\0${sha256}`;
    const { bytes, totalSize, identity } = await readVerifiedArtifactRange(
      target,
      sha256,
      range,
      this.#verifiedContent.get(verificationKey),
      signal,
    );
    this.#verifiedContent.set(verificationKey, identity);
    return { bytes, mimeType: manifest.mimeType, name, totalSize };
  }

  uri(workspaceId: string, sha256: string, provenanceHash: string, name: string): string {
    return `hoi4-agent://workspace/${encodeURIComponent(workspaceId)}/artifact/${sha256}/${provenanceHash}/${encodeURIComponent(name)}`;
  }

  private parseUri(
    workspace: ResolvedWorkspace,
    uri: string,
  ): { sha256: string; provenanceHash: string; name: string } {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new ServiceError('ARTIFACT_URI_INVALID', 'Invalid artifact URI');
    }
    if (
      parsed.protocol !== 'hoi4-agent:' ||
      parsed.hostname !== 'workspace' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    )
      throw new ServiceError('ARTIFACT_URI_INVALID', 'Invalid artifact URI');
    let segments: string[];
    try {
      segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new ServiceError('ARTIFACT_URI_INVALID', 'Invalid artifact URI encoding');
    }
    if (segments.length !== 5 || segments[0] !== workspace.id || segments[1] !== 'artifact')
      throw new ServiceError(
        'ARTIFACT_WORKSPACE_MISMATCH',
        'Artifact URI does not belong to this workspace',
      );
    const [, , sha256, provenanceHash, name] = segments;
    if (
      !/^[a-f0-9]{64}$/u.test(sha256!) ||
      !/^[a-f0-9]{64}$/u.test(provenanceHash!) ||
      !isValidArtifactName(name!)
    )
      throw new ServiceError('ARTIFACT_URI_INVALID', 'Invalid artifact URI components');
    if (this.uri(workspace.id, sha256!, provenanceHash!, name!) !== parsed.href) {
      throw new ServiceError('ARTIFACT_URI_INVALID', 'Artifact URI is not canonical');
    }
    return { sha256: sha256!, provenanceHash: provenanceHash!, name: name! };
  }
}
