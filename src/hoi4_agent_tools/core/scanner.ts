import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { iterateFiles } from './file-glob.js';
import { compareCodeUnits, sha256Bytes } from './canonical.js';
import {
  DEFAULT_SCAN_MAX_BYTES,
  DEFAULT_SCAN_MAX_FILE_BYTES,
  DEFAULT_SCAN_MAX_FILES,
} from './configuration.js';
import type { GameManifest, GameManifestStore } from './game-manifest.js';
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

/** Hash an open source using fixed memory; callers verify its canonical identity afterwards. */
export async function hashSourceBytes(
  source: PreparedSource,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.max(1, Math.min(1_048_576, source.metadata.size)));
  let offset = 0;
  while (offset < source.metadata.size) {
    signal?.throwIfAborted();
    const read = await source.handle.read(
      chunk,
      0,
      Math.min(chunk.length, source.metadata.size - offset),
      offset,
    );
    if (!read.bytesRead)
      throw new ServiceError('SCAN_SOURCE_CHANGED', 'Source changed while being hashed');
    hash.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
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
  /**
   * Called for a symbolic link or junction a walked root holds on the requested paths (see
   * `FileGlobOptions.onSkippedLink` for which ones). The scanner never follows them; callers use
   * this only to explain a missing file.
   */
  onSkippedLink?: (link: { rootKind: RootKind; relativePath: string }) => void;
}

interface CachedSourceBytes {
  sha256: string;
  bytes: Buffer;
  /** The file's identity when read, kept only for installed game files. */
  identity?: string;
}

/** Roots that hold the installed game, which only a game update changes. */
function installedRoot(kind: RootKind): boolean {
  return kind === 'game' || kind === 'dlc';
}

/** Device, file number, size and both change times: any write to the file moves one of them. */
function fileIdentity(metadata: Stats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function rootLabel(root: ResolvedRoot): string {
  if (root.kind === 'dlc' && root.label !== undefined) return root.label;
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

/** What one walk of the installed game found, kept while the game's version files stay the same. */
interface GameInventory {
  fingerprint: string;
  /** Every match of the patterns, including those a mod's replace_path hid. */
  enumerated: number;
  files: ScannedFile[];
  bytes: number;
}

const GAME_INVENTORY_MAX_BYTES = 96 * 1024 * 1024;
const GAME_INVENTORY_MAX_ENTRIES = 3;
/** Files the game rewrites with every patch. A game folder without the first is always walked. */
const GAME_VERSION_FILES = [
  'hoi4_rev.txt',
  'hoi4_branch.txt',
  'clausewitz_rev.txt',
  'checksum_manifest.txt',
] as const;

/**
 * The state of the installed game as its version files and top-level folders show it, or
 * undefined when the folder does not name its version and so cannot vouch for itself.
 * HOI4_AGENT_FULL_GAME_SCAN set to any value turns the shortcut off, for a modder who edits the
 * game's files in place without a patch.
 */
async function gameFingerprint(
  rootPath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (process.env.HOI4_AGENT_FULL_GAME_SCAN !== undefined) return undefined;
  const parts: string[] = [];
  try {
    for (const name of GAME_VERSION_FILES) {
      signal?.throwIfAborted();
      const metadata = await stat(path.join(rootPath, name)).catch(() => undefined);
      if (name === GAME_VERSION_FILES[0] && metadata === undefined) return undefined;
      parts.push(
        metadata === undefined
          ? `${name}:-`
          : `${name}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`,
      );
    }
    parts.push(`.:${(await stat(rootPath)).mtimeMs}`);
    const folders = (await readdir(rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodeUnits);
    for (const name of folders) {
      signal?.throwIfAborted();
      const metadata = await stat(path.join(rootPath, name)).catch(() => undefined);
      parts.push(`${name}:${metadata?.mtimeMs ?? '-'}`);
    }
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return undefined;
  }
  return parts.join('|');
}

/** The scan a game inventory answers: the root, the patterns and what mods hide from the game. */
function gameInventoryKey(
  workspace: ResolvedWorkspace,
  root: ResolvedRoot,
  options: ScanOptions,
): string {
  const hidden = workspace.roots
    .filter(
      (owner) =>
        (owner.kind === 'mod' || owner.kind === 'dependency') && owner.loadOrder > root.loadOrder,
    )
    .flatMap((owner) => owner.replacePaths.map((replacePath) => normalizeRelative(replacePath)))
    .sort(compareCodeUnits);
  return JSON.stringify([
    path.resolve(root.path),
    [...options.patterns].sort(compareCodeUnits),
    [...(options.ignore ?? ['**/.hoi4-agent/**'])].sort(compareCodeUnits),
    hidden,
  ]);
}

export class WorkspaceScanner {
  readonly #sourceCache = new Map<string, CachedSourceBytes>();
  readonly #gameInventories = new Map<string, GameInventory>();
  #sourceCacheBytes = 0;
  readonly #sourceCacheMaxBytes: number;

  public constructor(
    private readonly serverMaxFiles = DEFAULT_SCAN_MAX_FILES,
    private readonly serverMaxBytes = DEFAULT_SCAN_MAX_BYTES,
    private readonly serverMaxFileBytes = DEFAULT_SCAN_MAX_FILE_BYTES,
    /** Game-build manifests kept across processes (ADR 0087); none without server state. */
    private readonly manifests?: GameManifestStore,
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

  private rememberGameInventory(key: string, inventory: GameInventory): void {
    this.#gameInventories.delete(key);
    // The buffers are shared with the source cache, so the limit keeps this to a few focused scans.
    if (inventory.bytes > GAME_INVENTORY_MAX_BYTES) return;
    this.#gameInventories.set(key, inventory);
    while (this.#gameInventories.size > GAME_INVENTORY_MAX_ENTRIES) {
      const oldest = this.#gameInventories.keys().next().value;
      if (oldest === undefined) break;
      this.#gameInventories.delete(oldest);
    }
  }

  /** Release retained source buffers after an idle MCP analysis batch. */
  public clearCaches(): void {
    this.#sourceCache.clear();
    this.#sourceCacheBytes = 0;
    this.#gameInventories.clear();
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

  /**
   * The game files a manifest names, opened directly instead of walked. Every file must still be
   * the one the walk verified: its opened handle must have the recorded identity (device, file
   * number, size and both change times) and its bytes the recorded SHA-256. A swapped link or
   * junction opens a file with another identity, so this keeps the walk's containment check.
   * Undefined when anything differs or a scan limit would be passed; the caller walks instead.
   */
  private async filesFromManifest(
    root: ResolvedRoot,
    manifest: GameManifest,
    limits: { maxFiles: number; maxBytes: number; signal?: AbortSignal },
  ): Promise<ScannedFile[] | undefined> {
    if (manifest.enumerated > limits.maxFiles) return undefined;
    const recorded = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
    if (
      recorded > limits.maxBytes ||
      manifest.files.some((entry) => entry.size > this.serverMaxFileBytes)
    )
      return undefined;
    const files: ScannedFile[] = [];
    for (let offset = 0; offset < manifest.files.length; offset += SCAN_IO_CONCURRENCY * 4) {
      limits.signal?.throwIfAborted();
      const batch = manifest.files.slice(offset, offset + SCAN_IO_CONCURRENCY * 4);
      const read = await Promise.all(
        batch.map(async (entry): Promise<ScannedFile | undefined> => {
          const absolutePath = path.join(root.path, ...entry.relativePath.split('/'));
          let handle: FileHandle;
          try {
            handle = await open(absolutePath, 'r');
          } catch {
            return undefined;
          }
          try {
            const metadata = await handle.stat();
            if (!metadata.isFile() || fileIdentity(metadata) !== entry.identity) return undefined;
            const key = this.cacheKey(absolutePath);
            const retained = this.#sourceCache.get(key);
            const bytes =
              retained?.identity === entry.identity && retained.sha256 === entry.sha256
                ? retained.bytes
                : await readBoundedFile(handle, metadata.size, limits.signal);
            if (bytes.length !== entry.size || sha256Bytes(bytes) !== entry.sha256)
              return undefined;
            this.retainSource(key, { sha256: entry.sha256, bytes, identity: entry.identity });
            return {
              absolutePath,
              displayPath: `${rootLabel(root)}:${entry.relativePath}`,
              relativePath: entry.relativePath,
              rootKind: root.kind,
              loadOrder: root.loadOrder,
              size: bytes.length,
              modifiedMs: metadata.mtimeMs,
              sha256: entry.sha256,
              bytes,
            };
          } catch (error) {
            if (limits.signal?.aborted === true) throw error;
            return undefined;
          } finally {
            await handle.close();
          }
        }),
      );
      for (const file of read) {
        if (file === undefined) return undefined;
        files.push(file);
      }
    }
    return files;
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
            root.kind === 'dlc' ||
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
      // The installed game is walked file by file once. While its version files and top-level
      // folders stay as they were, the next scan with the same patterns takes that inventory
      // instead of opening, resolving and checking 1,400 files again. A game folder that does not
      // name its version, or any other kind of root, is always walked.
      const inventoryKey =
        root.kind === 'game' ? gameInventoryKey(workspace, root, options) : undefined;
      const fingerprint =
        inventoryKey === undefined ? undefined : await gameFingerprint(root.path, options.signal);
      const known =
        inventoryKey === undefined || fingerprint === undefined
          ? undefined
          : this.#gameInventories.get(inventoryKey);
      if (known !== undefined && known.fingerprint === fingerprint) {
        enumeratedFiles += known.enumerated;
        if (enumeratedFiles > maxFiles) {
          throw new ServiceError('SCAN_FILE_LIMIT', 'Scan exceeds the configured file limit', {
            files: enumeratedFiles,
            limit: maxFiles,
          });
        }
        if (totalBytes + known.bytes > maxBytes) {
          throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit', {
            bytes: totalBytes + known.bytes,
            limit: maxBytes,
          });
        }
        totalBytes += known.bytes;
        for (const file of known.files) {
          const { shadowedBy: _shadowedBy, ...fresh } = file;
          result.push(fresh);
        }
        continue;
      }
      // A new process, or one that released its caches when idle, has no inventory in memory.
      // The game-build manifest of an earlier walk names the files, so they are opened directly
      // and each must still be the file that was walked; any difference walks the game again.
      if (inventoryKey !== undefined && fingerprint !== undefined && this.manifests !== undefined) {
        const manifest = await this.manifests.load(inventoryKey, fingerprint);
        const files =
          manifest === undefined
            ? undefined
            : await this.filesFromManifest(root, manifest, {
                maxFiles: maxFiles - enumeratedFiles,
                maxBytes: maxBytes - totalBytes,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              });
        if (manifest !== undefined && files !== undefined) {
          enumeratedFiles += manifest.enumerated;
          const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
          totalBytes += bytes;
          result.push(...files);
          this.rememberGameInventory(inventoryKey, {
            fingerprint,
            enumerated: manifest.enumerated,
            files: files.map((file) => ({ ...file })),
            bytes,
          });
          continue;
        }
      }
      const resultBefore = result.length;
      const enumeratedBefore = enumeratedFiles;
      // Re-enumerate every other root: installing content or changing load order can
      // invalidate a mod inventory.
      const matches = iterateFiles(options.patterns, {
        cwd: root.path,
        ignore: options.ignore ?? ['**/.hoi4-agent/**'],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onSkippedLink === undefined
          ? {}
          : {
              onSkippedLink: (relativePath: string) =>
                options.onSkippedLink!({ rootKind: root.kind, relativePath }),
            }),
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
                // The installed game changes only when the game updates, and a file's identity
                // moves with every write, so an unchanged game file keeps its bytes and hash
                // instead of being read from disk again on every call. Mod files are always read.
                // The retained buffer is shared with earlier results, so it must still match its
                // hash: a caller that wrote into one must not change what a later scan returns.
                const retained = installedRoot(root.kind)
                  ? this.#sourceCache.get(this.cacheKey(source.absolutePath))
                  : undefined;
                if (
                  retained?.identity === fileIdentity(source.metadata) &&
                  sha256Bytes(retained.bytes) === retained.sha256
                ) {
                  await verifySource(root, source);
                  options.signal?.throwIfAborted();
                  return { bytes: retained.bytes, sha256: retained.sha256 };
                }
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
                return { bytes, sha256: undefined };
              }),
            );
            const readFailure = reads.find((entry) => entry.status === 'rejected');
            if (readFailure?.status === 'rejected') throw readFailure.reason;
            for (const [index, read] of reads.entries()) {
              if (read.status !== 'fulfilled') continue;
              const source = group[index]!;
              const cacheKey = this.cacheKey(source.absolutePath);
              const observed = read.value.bytes;
              const sha256 = read.value.sha256 ?? sha256Bytes(observed);
              const cached = this.#sourceCache.get(cacheKey);
              const bytes =
                cached?.sha256 === sha256 && cached.bytes.equals(observed)
                  ? cached.bytes
                  : observed;
              this.retainSource(cacheKey, {
                sha256,
                bytes,
                ...(installedRoot(root.kind) ? { identity: fileIdentity(source.metadata) } : {}),
              });
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
      if (inventoryKey !== undefined && fingerprint !== undefined) {
        const walked = result.slice(resultBefore);
        this.rememberGameInventory(inventoryKey, {
          fingerprint,
          enumerated: enumeratedFiles - enumeratedBefore,
          files: walked.map((file) => ({ ...file })),
          bytes: walked.reduce((sum, file) => sum + file.bytes.length, 0),
        });
        if (this.manifests !== undefined) {
          const entries = walked.flatMap((file) => {
            const identity = this.#sourceCache.get(this.cacheKey(file.absolutePath))?.identity;
            return identity === undefined
              ? []
              : [
                  {
                    relativePath: file.relativePath,
                    size: file.size,
                    identity,
                    sha256: file.sha256,
                    modifiedMs: file.modifiedMs,
                  },
                ];
          });
          // A file whose identity was not kept (too large for the source cache) cannot be
          // checked against a manifest, so such a walk records none.
          if (entries.length === walked.length)
            await this.manifests.save({
              key: inventoryKey,
              fingerprint,
              enumerated: enumeratedFiles - enumeratedBefore,
              files: entries,
            });
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
