import { ServiceError } from './result.js';
import { prepareSource, verifySource, type ScannedFile } from './scanner.js';
import { isWithin, type WorkspaceResolver } from './workspace.js';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { TemporaryDirectoryLifetime, sweepTemporaryDirectories } from './temporary-directories.js';

export const REFERENCE_SOURCE_MAX_BYTES = 1_073_741_824;
export const REFERENCE_WORKING_MAX_SIDE = 3_072;
export const REFERENCE_WORKING_MAX_BYTES = 33_554_432;

export type ReferenceSourceEvidence = Omit<ScannedFile, 'bytes'>;

export interface ReferenceImageSource {
  /** Identity and hash always describe the original file; it is never buffered in full. */
  source: ReferenceSourceEvidence;
  /** Bounded working PNG used for analysis and previews. */
  bytes: Buffer;
  originalWidth: number;
  originalHeight: number;
  workingWidth: number;
  workingHeight: number;
}

interface PrivateSnapshot {
  directory: string;
  filePath: string;
  handle: FileHandle;
  closed: boolean;
  lifetime: TemporaryDirectoryLifetime;
}

function supportedRasterHeader(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) ||
    (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (bytes.length >= 12 &&
      [82, 73, 70, 70].every((value, index) => bytes[index] === value) &&
      [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value))
  );
}

function assertSnapshotIsolation(
  resolver: WorkspaceResolver,
  candidate: string,
  checkDescendants: boolean,
): void {
  for (const workspace of resolver.list())
    for (const root of [
      ...workspace.roots,
      { path: workspace.artifactRoot },
      { path: workspace.cacheRoot },
    ])
      if (isWithin(root.path, candidate) || (checkDescendants && isWithin(candidate, root.path)))
        throw new ServiceError(
          'REFERENCE_SNAPSHOT_UNSAFE',
          'Reference snapshots must be outside workspace capability roots',
        );
}

async function assertSnapshotDirectory(
  resolver: WorkspaceResolver,
  directory: string,
  parent: string,
): Promise<void> {
  const canonical = path.normalize(await realpath(directory));
  const metadata = await lstat(directory);
  if (
    canonical !== path.normalize(directory) ||
    !isWithin(parent, canonical) ||
    canonical === parent ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  )
    throw new ServiceError(
      'REFERENCE_SNAPSHOT_UNSAFE',
      'Reference snapshot directory is not a private canonical directory',
    );
  if (
    process.platform !== 'win32' &&
    ((metadata.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()))
  )
    throw new ServiceError(
      'REFERENCE_SNAPSHOT_UNSAFE',
      'Reference snapshot directory permissions are not private',
    );
  assertSnapshotIsolation(resolver, canonical, true);
}

async function createPrivateSnapshot(resolver: WorkspaceResolver): Promise<PrivateSnapshot> {
  const parent = path.normalize(await realpath(resolver.serverState()?.root ?? tmpdir()));
  assertSnapshotIsolation(resolver, parent, false);
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (parentMetadata.mode & 0o022) !== 0 &&
      (parentMetadata.mode & 0o1000) === 0)
  )
    throw new ServiceError(
      'REFERENCE_SNAPSHOT_UNSAFE',
      'Reference snapshot parent is not protected against directory replacement',
    );
  // Hidden directories are excluded by mod-root discovery even with a temporary-root fallback.
  await sweepTemporaryDirectories(parent, {
    referenceSnapshotsOnly: true,
    staleMs: 0,
    maxBytes: REFERENCE_SOURCE_MAX_BYTES,
    protectedRoots: resolver
      .list()
      .flatMap((workspace) => [
        ...workspace.roots.map(({ path }) => path),
        workspace.artifactRoot,
        workspace.cacheRoot,
      ]),
  });
  const directory = await mkdtemp(path.join(parent, '.reference-snapshot-'));
  const lifetime = new TemporaryDirectoryLifetime(REFERENCE_SOURCE_MAX_BYTES);
  try {
    await assertSnapshotDirectory(resolver, directory, parent);
    await lifetime.own(directory);
    const filePath = path.join(directory, 'source.raster');
    const handle = await open(filePath, 'wx', 0o600);
    try {
      await assertSnapshotDirectory(resolver, directory, parent);
      return { directory, filePath, handle, closed: false, lifetime };
    } catch (error) {
      await handle.close();
      await unlink(filePath);
      throw error;
    }
  } catch (error) {
    await lifetime.dispose();
    if (await lstat(directory).catch(() => undefined)) await rmdir(directory);
    throw error;
  }
}

async function removePrivateSnapshot(snapshot: PrivateSnapshot): Promise<void> {
  try {
    let closeFailed = false;
    try {
      if (!snapshot.closed) await snapshot.handle.close();
    } catch {
      closeFailed = true;
    }
    await snapshot.lifetime.dispose();
    if (closeFailed || (await lstat(snapshot.directory).catch(() => undefined)))
      throw new Error('Private snapshot ownership changed before cleanup');
  } catch {
    throw new ServiceError(
      'REFERENCE_SNAPSHOT_CLEANUP_FAILED',
      'Private reference snapshot cleanup failed',
    );
  }
}

/** Decode a private snapshot copied and hashed from the same verified FD, using fixed memory. */
export async function readReferenceImageSource(
  resolver: WorkspaceResolver,
  workspaceId: string,
  relativePath: string,
  principal?: string,
  signal?: AbortSignal,
): Promise<ReferenceImageSource> {
  if (!/\.(?:png|jpe?g|webp)$/iu.test(relativePath) || relativePath.includes(':'))
    throw new ServiceError(
      'REFERENCE_IMAGE_PATH_INVALID',
      'Reference must name a local raster image',
    );
  const resolved = await resolver.resolvePath(
    workspaceId,
    relativePath,
    'read',
    ['mod'],
    principal,
  );
  const source = await prepareSource(resolved.root, relativePath, signal);
  let snapshot: PrivateSnapshot | undefined;
  try {
    if (!source.metadata.isFile())
      throw new ServiceError('SOURCE_NOT_REGULAR_FILE', 'Reference source must be a regular file');
    if (source.metadata.size < 1 || source.metadata.size > REFERENCE_SOURCE_MAX_BYTES)
      throw new ServiceError('SOURCE_BYTE_LIMIT', 'Reference source exceeds its byte limit', {
        limit: REFERENCE_SOURCE_MAX_BYTES,
      });
    signal?.throwIfAborted();
    snapshot = await createPrivateSnapshot(resolver);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(1_048_576, source.metadata.size));
    let offset = 0;
    while (offset < source.metadata.size) {
      signal?.throwIfAborted();
      const read = await source.handle.read(
        chunk,
        0,
        Math.min(chunk.length, source.metadata.size - offset),
        offset,
      );
      if (read.bytesRead === 0)
        throw new ServiceError(
          'SCAN_SOURCE_CHANGED',
          'Reference source changed while copying its snapshot',
        );
      if (offset === 0 && !supportedRasterHeader(chunk.subarray(0, read.bytesRead)))
        throw new ServiceError(
          'REFERENCE_IMAGE_DECODE_FAILED',
          'Reference source is not a supported raster image',
        );
      hash.update(chunk.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        const result = await snapshot.handle.write(
          chunk,
          written,
          read.bytesRead - written,
          offset + written,
        );
        if (result.bytesWritten === 0)
          throw new ServiceError(
            'REFERENCE_SNAPSHOT_WRITE_FAILED',
            'Reference snapshot could not be completed',
          );
        written += result.bytesWritten;
      }
      offset += read.bytesRead;
    }
    const originalHash = hash.digest('hex');
    await snapshot.handle.close();
    snapshot.closed = true;
    await verifySource(resolved.root, source);
    signal?.throwIfAborted();
    sharp.cache({ memory: 32, files: 0, items: 32 });
    const input = sharp(snapshot.filePath, {
      sequentialRead: true,
      limitInputPixels: 300_000_000,
      failOn: 'warning',
    });
    const metadata = await input.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1 ||
      !['png', 'jpeg', 'webp'].includes(metadata.format)
    )
      throw new ServiceError(
        'REFERENCE_IMAGE_UNSUPPORTED',
        'Reference must be a single-frame supported raster image',
      );
    signal?.throwIfAborted();
    const decoded = await input
      .resize({
        width: REFERENCE_WORKING_MAX_SIDE,
        height: REFERENCE_WORKING_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    await verifySource(resolved.root, source);
    signal?.throwIfAborted();
    if (decoded.data.length > REFERENCE_WORKING_MAX_BYTES)
      throw new ServiceError(
        'REFERENCE_WORKING_BYTE_LIMIT',
        'Reference working image exceeds its byte limit',
      );
    return {
      source: {
        absolutePath: source.canonicalPath,
        displayPath: `mod:${relativePath.replaceAll('\\', '/')}`,
        relativePath: relativePath.replaceAll('\\', '/'),
        rootKind: resolved.root.kind,
        loadOrder: resolved.root.loadOrder,
        size: source.metadata.size,
        modifiedMs: source.metadata.mtimeMs,
        sha256: originalHash,
      },
      bytes: decoded.data,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      workingWidth: decoded.info.width,
      workingHeight: decoded.info.height,
    };
  } catch (error) {
    if (error instanceof ServiceError || signal?.aborted) throw error;
    throw new ServiceError(
      'REFERENCE_IMAGE_DECODE_FAILED',
      'Reference image could not be safely decoded',
    );
  } finally {
    try {
      if (snapshot !== undefined) await removePrivateSnapshot(snapshot);
    } finally {
      await source.handle.close();
    }
  }
}
