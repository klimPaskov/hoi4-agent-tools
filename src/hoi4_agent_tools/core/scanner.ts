import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { compareCodeUnits, sha256Bytes } from './canonical.js';
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
  public constructor(
    private readonly serverMaxFiles = 20_000,
    private readonly serverMaxBytes = 134_217_728,
    private readonly serverMaxFileBytes = 67_108_864,
  ) {}

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
          throw new ServiceError('SCAN_FILE_LIMIT', 'Scan exceeds the configured file limit');
        }
        const relativePath = normalizeRelative(String(match));
        if (hiddenByReplacePath(workspace, root, relativePath)) continue;
        const absolutePath = path.join(root.path, relativePath);
        const handle = await open(absolutePath, 'r');
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) continue;
          const remaining = maxBytes - totalBytes;
          if (metadata.size > remaining || metadata.size > this.serverMaxFileBytes) {
            throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit');
          }
          const bytes = await readBoundedFile(
            handle,
            Math.min(remaining, this.serverMaxFileBytes),
            options.signal,
          );
          totalBytes += bytes.length;
          result.push({
            absolutePath,
            displayPath: `${rootLabel(root)}:${relativePath}`,
            relativePath,
            rootKind: root.kind,
            loadOrder: root.loadOrder,
            size: bytes.length,
            modifiedMs: metadata.mtimeMs,
            sha256: sha256Bytes(bytes),
            bytes,
          });
        } finally {
          await handle.close();
        }
      }
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
