import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { compareCodeUnits, hashCanonical, sha256Bytes } from './canonical.js';
import {
  DEFAULT_SCAN_MAX_BYTES,
  DEFAULT_SCAN_MAX_FILE_BYTES,
  DEFAULT_SCAN_MAX_FILES,
} from './configuration.js';
import { ServiceError } from './result.js';
import type { ResolvedRoot, ResolvedWorkspace, RootKind } from './workspace.js';

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
  size: number;
  modifiedMs: number;
  changedMs: number;
  inode: number;
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
  readonly #gameScanCache = new Map<string, ScannedFile[]>();
  #sourceCacheBytes = 0;
  readonly #sourceCacheMaxBytes: number;

  public constructor(
    private readonly serverMaxFiles = DEFAULT_SCAN_MAX_FILES,
    private readonly serverMaxBytes = DEFAULT_SCAN_MAX_BYTES,
    private readonly serverMaxFileBytes = DEFAULT_SCAN_MAX_FILE_BYTES,
  ) {
    this.#sourceCacheMaxBytes = Math.max(serverMaxFileBytes, Math.min(134_217_728, serverMaxBytes));
  }

  private cacheKey(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  }

  private retainSource(key: string, source: CachedSourceBytes): void {
    const previous = this.#sourceCache.get(key);
    if (previous !== undefined) this.#sourceCacheBytes -= previous.bytes.length;
    this.#sourceCache.delete(key);
    this.#sourceCache.set(key, source);
    this.#sourceCacheBytes += source.bytes.length;
    while (this.#sourceCacheBytes > this.#sourceCacheMaxBytes && this.#sourceCache.size > 1) {
      const oldest = this.#sourceCache.entries().next().value;
      if (oldest === undefined) break;
      this.#sourceCache.delete(oldest[0]);
      this.#sourceCacheBytes -= oldest[1].bytes.length;
    }
  }

  private gameScanKey(
    workspace: ResolvedWorkspace,
    root: ResolvedRoot,
    options: ScanOptions,
  ): string {
    return hashCanonical({
      workspaceId: workspace.id,
      root: root.path,
      patterns: [...options.patterns].sort(compareCodeUnits),
      ignore: [...(options.ignore ?? ['**/.hoi4-agent/**'])].sort(compareCodeUnits),
    });
  }

  private retainGameScan(key: string, files: readonly ScannedFile[]): void {
    this.#gameScanCache.delete(key);
    this.#gameScanCache.set(
      key,
      files.map((file) => ({ ...file })),
    );
    while (this.#gameScanCache.size > 8) {
      const oldest = this.#gameScanCache.keys().next().value;
      if (oldest === undefined) break;
      this.#gameScanCache.delete(oldest);
    }
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
      const gameScanKey =
        root.kind === 'game' ? this.gameScanKey(workspace, root, options) : undefined;
      const cachedGameFiles =
        gameScanKey === undefined ? undefined : this.#gameScanCache.get(gameScanKey);
      if (cachedGameFiles !== undefined && gameScanKey !== undefined) {
        this.#gameScanCache.delete(gameScanKey);
        this.#gameScanCache.set(gameScanKey, cachedGameFiles);
        enumeratedFiles += cachedGameFiles.length;
        if (enumeratedFiles > maxFiles)
          throw new ServiceError('SCAN_FILE_LIMIT', 'Scan exceeds the configured file limit', {
            files: enumeratedFiles,
            limit: maxFiles,
          });
        for (const file of cachedGameFiles) {
          totalBytes += file.size;
          if (totalBytes > maxBytes)
            throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit', {
              bytes: totalBytes,
              limit: maxBytes,
            });
          result.push({ ...file });
        }
        continue;
      }
      const rootFiles: ScannedFile[] = [];
      const matches = fg.stream(options.patterns, {
        cwd: root.path,
        onlyFiles: true,
        unique: true,
        dot: false,
        followSymbolicLinks: false,
        ignore: options.ignore ?? ['**/.hoi4-agent/**'],
      });
      for await (const match of matches) {
        options.signal?.throwIfAborted();
        enumeratedFiles += 1;
        if (enumeratedFiles > maxFiles) {
          throw new ServiceError('SCAN_FILE_LIMIT', 'Scan exceeds the configured file limit', {
            files: enumeratedFiles,
            limit: maxFiles,
          });
        }
        const relativePath = normalizeRelative(String(match));
        if (hiddenByReplacePath(workspace, root, relativePath)) continue;
        const absolutePath = path.join(root.path, relativePath);
        const cacheKey = this.cacheKey(absolutePath);
        const handle = await open(absolutePath, 'r');
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) continue;
          const remaining = maxBytes - totalBytes;
          if (metadata.size > remaining || metadata.size > this.serverMaxFileBytes) {
            throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit', {
              file: relativePath,
              fileBytes: metadata.size,
              bytes: totalBytes,
              limit: maxBytes,
              perFileLimit: this.serverMaxFileBytes,
            });
          }
          const cached = this.#sourceCache.get(cacheKey);
          const retained =
            cached?.size === metadata.size &&
            cached.modifiedMs === metadata.mtimeMs &&
            cached.changedMs === metadata.ctimeMs &&
            cached.inode === metadata.ino
              ? cached
              : undefined;
          const bytes =
            retained?.bytes ??
            (await readBoundedFile(
              handle,
              Math.min(remaining, this.serverMaxFileBytes),
              options.signal,
            ));
          const sha256 = retained?.sha256 ?? sha256Bytes(bytes);
          this.retainSource(cacheKey, {
            size: metadata.size,
            modifiedMs: metadata.mtimeMs,
            changedMs: metadata.ctimeMs,
            inode: metadata.ino,
            sha256,
            bytes,
          });
          totalBytes += bytes.length;
          const scanned = {
            absolutePath,
            displayPath: `${rootLabel(root)}:${relativePath}`,
            relativePath,
            rootKind: root.kind,
            loadOrder: root.loadOrder,
            size: bytes.length,
            modifiedMs: metadata.mtimeMs,
            sha256,
            bytes,
          } satisfies ScannedFile;
          result.push(scanned);
          rootFiles.push(scanned);
        } finally {
          await handle.close();
        }
      }
      if (gameScanKey !== undefined) this.retainGameScan(gameScanKey, rootFiles);
    }
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

async function readBoundedFile(
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
