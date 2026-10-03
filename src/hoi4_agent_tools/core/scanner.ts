import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { iterateFiles } from './file-glob.js';
import { compareCodeUnits, sha256Bytes } from './canonical.js';
import {
  DEFAULT_SCAN_MAX_BYTES,
  DEFAULT_SCAN_MAX_FILE_BYTES,
  DEFAULT_SCAN_MAX_FILES,
} from './configuration.js';
import { ServiceError } from './result.js';
import { isWithin, type ResolvedRoot, type ResolvedWorkspace, type RootKind } from './workspace.js';

const SCAN_IO_CONCURRENCY = 8;
const SCAN_READ_BATCH_BYTES = 16_777_216;

export interface PreparedSource {
  relativePath: string;
  absolutePath: string;
  canonicalPath: string;
  handle: FileHandle;
  metadata: Stats;
}

export async function verifySource(
  root: Pick<ResolvedRoot, 'path'>,
  source: PreparedSource,
): Promise<void> {
  const resolved = await realpath(source.absolutePath);
  if (!isWithin(root.path, resolved))
    throw new ServiceError('SCAN_ROOT_ESCAPE', 'Source path resolves outside its authorized root', {
      file: source.relativePath,
    });
  const current = await stat(resolved);
  const expected = source.metadata;
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs
  )
    throw new ServiceError(
      'SCAN_SOURCE_CHANGED',
      'Source changed while it was being scanned; retry a focused query',
      { file: source.relativePath },
    );
}

export async function prepareSource(
  root: Pick<ResolvedRoot, 'path'>,
  relativePath: string,
  signal?: AbortSignal,
): Promise<PreparedSource> {
  signal?.throwIfAborted();
  const absolutePath = path.join(root.path, relativePath);
  const canonicalPath = await realpath(absolutePath);
  if (!isWithin(root.path, canonicalPath))
    throw new ServiceError('SCAN_ROOT_ESCAPE', 'Source path resolves outside its authorized root', {
      file: relativePath,
    });
  const handle = await open(canonicalPath, 'r');
  try {
    const source = {
      relativePath,
      absolutePath,
      canonicalPath,
      handle,
      metadata: await handle.stat(),
    };
    await verifySource(root, source);
    signal?.throwIfAborted();
    return source;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export interface ScannedFile {
  absolutePath: string;
  displayPath: string;
  relativePath: string;
  rootKind: RootKind;
  loadOrder: number;
  size: number;
  modifiedMs: number;
  sha256: string;
  bytes: Buffer;
  shadowedBy?: string;
}

export interface ScanOptions {
  patterns: string[];
  ignore?: string[];
  rootKinds?: readonly RootKind[];
  maxFiles?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

interface CachedSourceBytes {
  sha256: string;
  bytes: Buffer;
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function rootLabel(root: ResolvedRoot): string {
  return root.kind === 'dependency' ? `dependency-${root.loadOrder}` : root.kind;
}

function hiddenByReplacePath(
  workspace: ResolvedWorkspace,
  root: ResolvedRoot,
  relativePath: string,
): boolean {
  if (root.kind === 'mod' || root.kind === 'artifact' || root.kind === 'cache') {
    return false;
  }
  const candidate = normalizeRelative(relativePath);
  return workspace.roots
    .filter(
      (owner) =>
        (owner.kind === 'mod' || owner.kind === 'dependency') && owner.loadOrder > root.loadOrder,
    )
    .some((owner) =>
      owner.replacePaths.some((replacePath) => {
        const normalized = normalizeRelative(replacePath).replace(/\/$/u, '');
        return candidate === normalized || candidate.startsWith(`${normalized}/`);
      }),
    );
}

export class WorkspaceScanner {
  readonly #sourceCache = new Map<string, CachedSourceBytes>();
  #sourceCacheBytes = 0;
  readonly #sourceCacheMaxBytes: number;

  public constructor(
    private readonly serverMaxFiles = DEFAULT_SCAN_MAX_FILES,
    private readonly serverMaxBytes = DEFAULT_SCAN_MAX_BYTES,
    private readonly serverMaxFileBytes = DEFAULT_SCAN_MAX_FILE_BYTES,
  ) {
    this.#sourceCacheMaxBytes = Math.max(1, Math.min(134_217_728, serverMaxBytes));
  }

  private cacheKey(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  }

  private retainSource(key: string, source: CachedSourceBytes): void {
    const previous = this.#sourceCache.get(key);
    if (previous !== undefined) this.#sourceCacheBytes -= previous.bytes.length;
    this.#sourceCache.delete(key);
    if (source.bytes.length > this.#sourceCacheMaxBytes) return;
    this.#sourceCache.set(key, source);
    this.#sourceCacheBytes += source.bytes.length;
    while (this.#sourceCacheBytes > this.#sourceCacheMaxBytes || this.#sourceCache.size > 16_384) {
      const oldest = this.#sourceCache.entries().next().value;
      if (oldest === undefined) break;
      this.#sourceCache.delete(oldest[0]);
      this.#sourceCacheBytes -= oldest[1].bytes.length;
    }
  }

  /** Release retained source buffers after an idle MCP analysis batch. */
  public clearCaches(): void {
    this.#sourceCache.clear();
    this.#sourceCacheBytes = 0;
  }

  /** Cache accounting used by lifecycle and regression tests. */
  public cacheUsage(): {
    sourceBytes: number;
    sourceEntries: number;
    gameScanBytes: number;
    gameScanEntries: number;
  } {
    return {
      sourceBytes: this.#sourceCacheBytes,
      sourceEntries: this.#sourceCache.size,
      // Retained for callers of the existing accounting interface. Inventories
      // are no longer cached independently of verified source bytes.
      gameScanBytes: 0,
      gameScanEntries: 0,
    };
  }

  async scan(workspace: ResolvedWorkspace, options: ScanOptions): Promise<ScannedFile[]> {
    options.signal?.throwIfAborted();
    const maxFiles = options.maxFiles ?? this.serverMaxFiles;
    const maxBytes = options.maxBytes ?? this.serverMaxBytes;
    if (
      !Number.isSafeInteger(maxFiles) ||
      maxFiles < 1 ||
      maxFiles > this.serverMaxFiles ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > this.serverMaxBytes
    ) {
      throw new ServiceError(
        'SCAN_LIMIT_EXCEEDS_POLICY',
        'Requested scan limits exceed the configured server ceiling',
      );
    }
    const roots = workspace.roots
      .filter(
        (root) =>
          (root.kind === 'game' ||
            root.kind === 'dependency' ||
            root.kind === 'mod' ||
            root.kind === 'fixture') &&
          (options.rootKinds === undefined || options.rootKinds.includes(root.kind)),
      )
      .sort((a, b) => a.loadOrder - b.loadOrder || compareCodeUnits(a.path, b.path));
    const result: ScannedFile[] = [];
    let totalBytes = 0;
    let enumeratedFiles = 0;
    for (const root of roots) {
      options.signal?.throwIfAborted();
      // Re-enumerate every root: installing content or changing load order can
      // invalidate a vanilla inventory just as it can a mod inventory.
      const matches = iterateFiles(options.patterns, {
        cwd: root.path,
        ignore: options.ignore ?? ['**/.hoi4-agent/**'],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const relativePaths: string[] = [];
      for await (const match of matches) {
        options.signal?.throwIfAborted();
        enumeratedFiles += 1;
        if (enumeratedFiles > maxFiles) {
          throw new ServiceError('SCAN_FILE_LIMIT', 'Scan exceeds the configured file limit', {
            files: enumeratedFiles,
            limit: maxFiles,
          });
        }
        const relativePath = normalizeRelative(match);
        if (hiddenByReplacePath(workspace, root, relativePath)) continue;
        relativePaths.push(relativePath);
      }
      for (let offset = 0; offset < relativePaths.length; offset += SCAN_IO_CONCURRENCY) {
        options.signal?.throwIfAborted();
        const prepared = await Promise.allSettled(
          relativePaths
            .slice(offset, offset + SCAN_IO_CONCURRENCY)
            .map((relativePath) => prepareSource(root, relativePath, options.signal)),
        );
        const opened = prepared.flatMap((entry) =>
          entry.status === 'fulfilled' ? [entry.value] : [],
        );
        try {
          const failed = prepared.find((entry) => entry.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          const readable = opened.filter(({ metadata }) => metadata.isFile());
          let reserved = 0;
          for (const source of readable) {
            if (
              source.metadata.size > maxBytes - totalBytes - reserved ||
              source.metadata.size > this.serverMaxFileBytes
            )
              throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit', {
                file: source.relativePath,
                fileBytes: source.metadata.size,
                bytes: totalBytes + reserved,
                limit: maxBytes,
                perFileLimit: this.serverMaxFileBytes,
              });
            reserved += source.metadata.size;
          }
          let readOffset = 0;
          while (readOffset < readable.length) {
            const group: PreparedSource[] = [];
            let groupBytes = 0;
            while (readOffset < readable.length) {
              const source = readable[readOffset]!;
              if (group.length > 0 && groupBytes + source.metadata.size > SCAN_READ_BATCH_BYTES)
                break;
              group.push(source);
              groupBytes += source.metadata.size;
              readOffset++;
            }
            const reads = await Promise.allSettled(
              group.map(async (source) => {
                let bytes: Buffer;
                try {
                  bytes = await readBoundedFile(
                    source.handle,
                    source.metadata.size,
                    options.signal,
                  );
                } catch (error) {
                  if (error instanceof ServiceError && error.code === 'SCAN_BYTE_LIMIT')
                    throw new ServiceError(
                      'SCAN_SOURCE_CHANGED',
                      'Source grew while it was being scanned; retry a focused query',
                      { file: source.relativePath },
                    );
                  throw error;
                }
                if (bytes.length !== source.metadata.size)
                  throw new ServiceError(
                    'SCAN_SOURCE_CHANGED',
                    'Source changed while it was being scanned; retry a focused query',
                    { file: source.relativePath },
                  );
                await verifySource(root, source);
                options.signal?.throwIfAborted();
                return bytes;
              }),
            );
            const readFailure = reads.find((entry) => entry.status === 'rejected');
            if (readFailure?.status === 'rejected') throw readFailure.reason;
            for (const [index, read] of reads.entries()) {
              if (read.status !== 'fulfilled') continue;
              const source = group[index]!;
              const cacheKey = this.cacheKey(source.absolutePath);
              const observed = read.value;
              const sha256 = sha256Bytes(observed);
              const cached = this.#sourceCache.get(cacheKey);
              const bytes =
                cached?.sha256 === sha256 && cached.bytes.equals(observed)
                  ? cached.bytes
                  : observed;
              this.retainSource(cacheKey, { sha256, bytes });
              totalBytes += bytes.length;
              result.push({
                absolutePath: source.absolutePath,
                displayPath: `${rootLabel(root)}:${source.relativePath}`,
                relativePath: source.relativePath,
                rootKind: root.kind,
                loadOrder: root.loadOrder,
                size: bytes.length,
                modifiedMs: source.metadata.mtimeMs,
                sha256,
                bytes,
              });
            }
          }
        } finally {
          await Promise.all(opened.map(({ handle }) => handle.close()));
        }
      }
    }
    options.signal?.throwIfAborted();
    result.sort(
      (left, right) =>
        left.loadOrder - right.loadOrder || compareCodeUnits(left.relativePath, right.relativePath),
    );
    const groups = new Map<string, ScannedFile[]>();
    for (const file of result) {
      const group = groups.get(file.relativePath.toLowerCase()) ?? [];
      group.push(file);
      groups.set(file.relativePath.toLowerCase(), group);
    }
    for (const group of groups.values()) {
      group.sort(
        (a, b) => b.loadOrder - a.loadOrder || compareCodeUnits(a.displayPath, b.displayPath),
      );
      const active = group[0]!;
      for (const shadowed of group.slice(1)) shadowed.shadowedBy = active.displayPath;
    }
    return result;
  }
}

export async function readBoundedFile(
  handle: FileHandle,
  remainingBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    const allowance = remainingBytes - total;
    const chunk = Buffer.allocUnsafe(Math.min(65_536, Math.max(1, allowance + 1)));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > remainingBytes) {
      throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit');
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
