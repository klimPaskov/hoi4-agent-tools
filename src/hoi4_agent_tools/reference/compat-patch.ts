import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { compareCodeUnits } from '../core/canonical.js';
import { runEngineCheck, type EngineCheckReport } from '../core/engine-check.js';
import { ServiceError } from '../core/result.js';
import { canonicalPath, containedGeneratedPath, isWithin } from '../core/workspace.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import type { CompatCheckRequest, CompatPatchData } from '../schemas/compat.js';
import { fitToBudget, type CompatServices } from './compat.js';

/**
 * `hoi4.compat_check` mode `patch` (decision R-5): what a game patch changed under the mod's
 * overrides. Each call stores a snapshot of the vanilla files the mod overrides for the installed
 * game build, in the workspace's cache folder and never in the mod. Two snapshots of different
 * builds show which overridden files the patch changed, added or removed.
 */

export const SNAPSHOT_SCHEMA = 'hoi4-compat-snapshot/1';
export const SNAPSHOT_FOLDER = 'compat-snapshots';
export const MAX_COPIED_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const MAX_SNAPSHOTS = 3;
const MAX_SNAPSHOT_FILES = 20_000;
const HUNK_CONTEXT = 3;
const HUNK_GAP = 6;
const HUNK_MAX_LINES = 40;
const HUNK_MAX_CHARS = 1_500;
const HUNK_LINE_CHARS = 160;
const DIFF_CELL_LIMIT = 4_000_000;
const TEXT_SNIFF_BYTES = 8_192;

const snapshotFileSchema = z
  .object({
    layer: z.string().max(512),
    path: z.string().max(1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    size: z.number().int().min(0),
    /** The file looks like text (no NUL byte in its start). */
    text: z.boolean(),
    /** A copy of the file is stored for diffing. */
    copied: z.boolean(),
  })
  .strict();

const manifestSchema = z
  .object({
    schema: z.literal(SNAPSHOT_SCHEMA),
    build: z.string().min(1).max(64),
    sequence: z.number().int().min(1),
    /** Files beyond the per-snapshot file limit, not recorded. */
    unrecorded: z.number().int().min(0),
    files: z.array(snapshotFileSchema).max(MAX_SNAPSHOT_FILES),
  })
  .strict();

export type SnapshotManifest = z.infer<typeof manifestSchema>;
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;

export interface StoredSnapshot {
  manifest: SnapshotManifest;
  directory: string;
  bytes: number;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------------------------
// Which vanilla files the mod overrides

export interface VanillaFile {
  layer: string;
  /** Relative to the layer root, forward slashes. */
  path: string;
  absolute: string;
}

function safeRelative(raw: string): string | undefined {
  const relative = raw.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  if (relative.length === 0 || relative.includes('\0') || relative.includes(':')) return undefined;
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return undefined;
  return relative;
}

/**
 * The game and DLC files the mod replaces: the `replaced` side of the check's override entries,
 * and the files the game and DLCs ship directly in the mod's replace_path folders.
 */
export async function overriddenVanillaFiles(
  report: EngineCheckReport,
  signal?: AbortSignal,
): Promise<VanillaFile[]> {
  const vanilla = report.inputs.layers.filter(({ kind }) => kind === 'game' || kind === 'dlc');
  const found = new Map<string, VanillaFile>();
  const add = (layer: { name: string; path: string }, relative: string): void => {
    const key = `${layer.name}\0${relative}`;
    if (!found.has(key))
      found.set(key, {
        layer: layer.name,
        path: relative,
        absolute: path.join(layer.path, ...relative.split('/')),
      });
  };
  for (const entry of report.overrides)
    for (const replaced of entry.replaced) {
      const layer = vanilla.find(({ name }) => replaced.startsWith(`${name}:`));
      const relative =
        layer === undefined ? undefined : safeRelative(replaced.slice(layer.name.length + 1));
      if (layer !== undefined && relative !== undefined) add(layer, relative);
    }
  const mod = report.inputs.layers.findLast(({ kind }) => kind === 'mod');
  for (const raw of new Set(mod?.replace_paths ?? [])) {
    const folder = safeRelative(raw);
    if (folder === undefined) continue;
    for (const layer of vanilla) {
      signal?.throwIfAborted();
      try {
        const directory = await canonicalPath(path.join(layer.path, ...folder.split('/')));
        if (!isWithin(layer.path, directory)) continue;
        for (const dirent of await readdir(directory, { withFileTypes: true }))
          if (dirent.isFile()) add(layer, `${folder}/${dirent.name}`);
      } catch {
        /* a folder the layer lacks has nothing to record */
      }
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      compareCodeUnits(left.layer, right.layer) || compareCodeUnits(left.path, right.path),
  );
}

// ---------------------------------------------------------------------------------------------
// Snapshot storage

function snapshotsRoot(workspace: Pick<ResolvedWorkspace, 'cacheRoot'>): Promise<string> {
  return containedGeneratedPath(workspace.cacheRoot, SNAPSHOT_FOLDER);
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  try {
    for (const dirent of await readdir(path.join(directory, 'files'), { withFileTypes: true }))
      if (dirent.isFile()) total += (await stat(path.join(directory, 'files', dirent.name))).size;
  } catch {
    /* an unreadable snapshot is sized as empty */
  }
  return total;
}

/** Every valid snapshot in the cache folder, newest first. A damaged one is ignored. */
export async function listSnapshots(
  workspace: Pick<ResolvedWorkspace, 'cacheRoot'>,
): Promise<StoredSnapshot[]> {
  const root = await snapshotsRoot(workspace);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const snapshots: StoredSnapshot[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/u.test(name)) continue;
    const directory = path.join(root, name);
    try {
      const manifest = manifestSchema.parse(
        JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
      );
      if (directoryKey(manifest.build) !== name) continue;
      snapshots.push({ manifest, directory, bytes: await directorySize(directory) });
    } catch {
      /* not a snapshot this tool wrote */
    }
  }
  return snapshots.sort((left, right) => right.manifest.sequence - left.manifest.sequence);
}

function directoryKey(build: string): string {
  return sha256Hex(build).slice(0, 16);
}

interface Hashed {
  sha256: string;
  size: number;
  text: boolean;
  content?: Buffer;
}

async function hashFile(file: string, maxCopied: number): Promise<Hashed | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    if (info.size <= maxCopied) {
      const content = await readFile(file);
      return {
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
        text: !content.subarray(0, TEXT_SNIFF_BYTES).includes(0),
        content,
      };
    }
    const hash = createHash('sha256');
    let head = Buffer.alloc(0);
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      if (head.length < TEXT_SNIFF_BYTES)
        head = Buffer.concat([head, chunk.subarray(0, TEXT_SNIFF_BYTES - head.length)]);
    }
    return { sha256: hash.digest('hex'), size: info.size, text: !head.includes(0) };
  } catch {
    return undefined;
  }
}

export interface RecordedSnapshot {
  manifest: SnapshotManifest;
  bytes: number;
  pruned: string[];
}

/**
 * Store the snapshot of `build` and prune the oldest beyond three. A snapshot of the same build
 * is replaced. The new one is written beside the others and renamed into place, so a failed
 * write leaves the old snapshots as they were.
 */
export async function recordSnapshot(
  workspace: Pick<ResolvedWorkspace, 'cacheRoot'>,
  build: string,
  files: readonly VanillaFile[],
  signal?: AbortSignal,
  limits: { maxCopiedFileBytes?: number; maxSnapshotBytes?: number } = {},
): Promise<RecordedSnapshot> {
  const maxCopiedFileBytes = limits.maxCopiedFileBytes ?? MAX_COPIED_FILE_BYTES;
  const maxSnapshotBytes = limits.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
  const root = await snapshotsRoot(workspace);
  await mkdir(root, { recursive: true });
  const existing = await listSnapshots(workspace);
  const sequence = Math.max(0, ...existing.map(({ manifest }) => manifest.sequence)) + 1;
  const key = directoryKey(build);
  const staging = path.join(root, `.writing-${key}-${randomBytes(6).toString('hex')}`);
  await mkdir(path.join(staging, 'files'), { recursive: true });
  try {
    const recorded: SnapshotFile[] = [];
    const stored = new Set<string>();
    let copiedBytes = 0;
    for (const file of files.slice(0, MAX_SNAPSHOT_FILES)) {
      signal?.throwIfAborted();
      const hashed = await hashFile(file.absolute, maxCopiedFileBytes);
      if (hashed === undefined) continue;
      let copied = false;
      if (hashed.text && hashed.content !== undefined) {
        if (stored.has(hashed.sha256)) copied = true;
        else if (copiedBytes + hashed.size <= maxSnapshotBytes) {
          await writeFile(path.join(staging, 'files', hashed.sha256), hashed.content);
          stored.add(hashed.sha256);
          copiedBytes += hashed.size;
          copied = true;
        }
      }
      recorded.push({
        layer: file.layer,
        path: file.path,
        sha256: hashed.sha256,
        size: hashed.size,
        text: hashed.text,
        copied,
      });
    }
    const manifest: SnapshotManifest = {
      schema: SNAPSHOT_SCHEMA,
      build,
      sequence,
      unrecorded: Math.max(0, files.length - MAX_SNAPSHOT_FILES),
      files: recorded,
    };
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const final = path.join(root, key);
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    const pruned: string[] = [];
    const all = await listSnapshots(workspace);
    for (const old of all.slice(MAX_SNAPSHOTS)) {
      await rm(old.directory, { recursive: true, force: true });
      pruned.push(old.manifest.build);
    }
    return { manifest, bytes: copiedBytes, pruned };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Diff

interface Operation {
  kind: ' ' | '-' | '+';
  line: string;
}

function splitLines(text: string): string[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = body.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Line operations from the older text to the newer; a common prefix and suffix are trimmed first. */
export function diffLines(older: readonly string[], newer: readonly string[]): Operation[] {
  let start = 0;
  while (start < older.length && start < newer.length && older[start] === newer[start]) start += 1;
  let endOld = older.length;
  let endNew = newer.length;
  while (endOld > start && endNew > start && older[endOld - 1] === newer[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const operations: Operation[] = older.slice(0, start).map((line) => ({ kind: ' ', line }));
  const a = older.slice(start, endOld);
  const b = newer.slice(start, endNew);
  if (a.length * b.length > DIFF_CELL_LIMIT) {
    // Too large for a line-by-line match: the changed middle is one replacement.
    for (const line of a) operations.push({ kind: '-', line });
    for (const line of b) operations.push({ kind: '+', line });
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1)
      for (let j = b.length - 1; j >= 0; j -= 1)
        table[i * width + j] =
          a[i] === b[j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        operations.push({ kind: ' ', line: a[i] ?? '' });
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        operations.push({ kind: '-', line: a[i] ?? '' });
        i += 1;
      } else {
        operations.push({ kind: '+', line: b[j] ?? '' });
        j += 1;
      }
    }
    for (; i < a.length; i += 1) operations.push({ kind: '-', line: a[i] ?? '' });
    for (; j < b.length; j += 1) operations.push({ kind: '+', line: b[j] ?? '' });
  }
  for (const line of older.slice(endOld)) operations.push({ kind: ' ', line });
  return operations;
}

export interface TextChange {
  oldLines: number;
  newLines: number;
  linesAdded: number;
  linesRemoved: number;
  firstHunk: string | null;
}

/** Line counts and the first hunk of a unified diff between two texts. */
export function describeTextChange(older: string, newer: string): TextChange {
  const oldLines = splitLines(older);
  const newLines = splitLines(newer);
  const operations = diffLines(oldLines, newLines);
  const linesAdded = operations.filter(({ kind }) => kind === '+').length;
  const linesRemoved = operations.filter(({ kind }) => kind === '-').length;
  const first = operations.findIndex(({ kind }) => kind !== ' ');
  if (first < 0)
    return {
      oldLines: oldLines.length,
      newLines: newLines.length,
      linesAdded,
      linesRemoved,
      firstHunk: null,
    };
  const begin = Math.max(0, first - HUNK_CONTEXT);
  let lastChange = first;
  let gap = 0;
  for (let index = first; index < operations.length; index += 1) {
    if (operations[index]?.kind === ' ') {
      gap += 1;
      if (gap > HUNK_GAP) break;
    } else {
      gap = 0;
      lastChange = index;
    }
    if (index - begin >= HUNK_MAX_LINES) {
      lastChange = Math.min(lastChange, index);
      break;
    }
  }
  const end = Math.min(operations.length, lastChange + HUNK_CONTEXT + 1, begin + HUNK_MAX_LINES);
  const window = operations.slice(begin, end);
  const before = operations.slice(0, begin);
  const oldStart = before.filter(({ kind }) => kind !== '+').length + 1;
  const newStart = before.filter(({ kind }) => kind !== '-').length + 1;
  const oldCount = window.filter(({ kind }) => kind !== '+').length;
  const newCount = window.filter(({ kind }) => kind !== '-').length;
  const clipLine = (line: string) =>
    line.length > HUNK_LINE_CHARS ? `${line.slice(0, HUNK_LINE_CHARS - 1)}…` : line;
  let hunk = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${window
    .map(({ kind, line }) => `${kind}${clipLine(line)}`)
    .join('\n')}`;
  if (hunk.length > HUNK_MAX_CHARS) hunk = `${hunk.slice(0, HUNK_MAX_CHARS - 1)}…`;
  return {
    oldLines: oldLines.length,
    newLines: newLines.length,
    linesAdded,
    linesRemoved,
    firstHunk: hunk,
  };
}

// ---------------------------------------------------------------------------------------------
// Comparison

type ChangedFile = NonNullable<CompatPatchData['comparison']>['files'][number];

export interface SnapshotComparison {
  from: string;
  to: string;
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
  noLongerOverridden: number;
  /** Changed, removed and added files, in that order, then by layer and path. */
  files: ChangedFile[];
}

const CHANGE_ORDER = { changed: 0, removed: 1, added: 2 } as const;

async function copyText(snapshot: StoredSnapshot, file: SnapshotFile): Promise<string | undefined> {
  if (!file.copied) return undefined;
  try {
    return await readFile(path.join(snapshot.directory, 'files', file.sha256), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * What changed in the vanilla files between two snapshots. `modShips` tells whether the mod still
 * ships a file at a path the older snapshot recorded: only then did vanilla remove the file,
 * otherwise the mod simply no longer overrides it.
 */
export async function compareSnapshots(
  older: StoredSnapshot,
  newer: StoredSnapshot,
  modShips: (relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<SnapshotComparison> {
  const key = (file: SnapshotFile) => `${file.layer}\0${file.path}`;
  const before = new Map(older.manifest.files.map((file) => [key(file), file]));
  const after = new Map(newer.manifest.files.map((file) => [key(file), file]));
  const result: SnapshotComparison = {
    from: older.manifest.build,
    to: newer.manifest.build,
    changed: 0,
    added: 0,
    removed: 0,
    unchanged: 0,
    noLongerOverridden: 0,
    files: [],
  };
  const row = (
    file: SnapshotFile,
    change: ChangedFile['change'],
    extra: Partial<ChangedFile> = {},
  ): ChangedFile => ({
    path: file.path,
    layer: file.layer,
    change,
    binary: !file.text,
    oldLines: null,
    newLines: null,
    linesAdded: null,
    linesRemoved: null,
    firstHunk: null,
    ...extra,
  });
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort(compareCodeUnits);
  const limit = 400;
  for (const name of keys) {
    signal?.throwIfAborted();
    const oldFile = before.get(name);
    const newFile = after.get(name);
    if (oldFile !== undefined && newFile !== undefined) {
      if (oldFile.sha256 === newFile.sha256) {
        result.unchanged += 1;
        continue;
      }
      result.changed += 1;
      if (result.files.length >= limit) continue;
      const [oldText, newText] = await Promise.all([
        copyText(older, oldFile),
        copyText(newer, newFile),
      ]);
      result.files.push(
        row(newFile, 'changed', {
          binary: !(oldFile.text && newFile.text),
          ...(oldText !== undefined && newText !== undefined
            ? describeTextChange(oldText, newText)
            : {}),
        }),
      );
    } else if (newFile !== undefined) {
      result.added += 1;
      if (result.files.length < limit) {
        const text = await copyText(newer, newFile);
        result.files.push(
          row(newFile, 'added', text === undefined ? {} : { newLines: splitLines(text).length }),
        );
      }
    } else if (oldFile !== undefined) {
      if (await modShips(oldFile.path)) {
        result.removed += 1;
        if (result.files.length < limit) {
          const text = await copyText(older, oldFile);
          result.files.push(
            row(
              oldFile,
              'removed',
              text === undefined ? {} : { oldLines: splitLines(text).length },
            ),
          );
        }
      } else result.noLongerOverridden += 1;
    }
  }
  result.files.sort(
    (left, right) =>
      CHANGE_ORDER[left.change] - CHANGE_ORDER[right.change] ||
      compareCodeUnits(left.layer, right.layer) ||
      compareCodeUnits(left.path, right.path),
  );
  return result;
}

// ---------------------------------------------------------------------------------------------
// The tool

function snapshotInfo(snapshot: Pick<StoredSnapshot, 'manifest' | 'bytes'>) {
  const copied = snapshot.manifest.files.filter(({ copied: kept }) => kept).length;
  return {
    build: snapshot.manifest.build,
    files: snapshot.manifest.files.length,
    copiedFiles: copied,
    uncopiedFiles: snapshot.manifest.files.length - copied,
    bytes: snapshot.bytes,
  };
}

function missingSnapshot(build: string, stored: readonly StoredSnapshot[]): ServiceError {
  const builds = stored.map(({ manifest }) => manifest.build);
  return new ServiceError(
    'COMPAT_SNAPSHOT_NOT_FOUND',
    `No snapshot is stored for game build ${build}${builds.length === 0 ? '' : `; stored builds: ${builds.join(', ')}`}`,
    { build, stored: builds },
  );
}

export async function checkPatchCompatibility(
  workspace: ResolvedWorkspace,
  input: CompatCheckRequest,
  signal?: AbortSignal,
  services: CompatServices = {},
): Promise<CompatPatchData> {
  const started = Date.now();
  if (workspace.registration.kind !== 'mod')
    throw new ServiceError('COMPAT_NEEDS_MOD', 'compat_check needs a mod workspace');
  const workspaceRef = { id: workspace.id, name: workspace.name };
  const modShips = async (relative: string): Promise<boolean> => {
    const safe = safeRelative(relative);
    if (safe === undefined) return false;
    try {
      const canonical = await canonicalPath(path.join(workspace.modRoot, ...safe.split('/')));
      return isWithin(workspace.modRoot, canonical) && (await stat(canonical)).isFile();
    } catch {
      return false;
    }
  };
  let installedBuild: string | null = null;
  let recorded: RecordedSnapshot | null = null;
  let stored = await listSnapshots(workspace);
  if (input.from === undefined || input.to === undefined) {
    if (workspace.gameRoot === undefined)
      throw new ServiceError('COMPAT_NO_GAME_ROOT', 'The workspace has no game root to compare');
    const report = await (services.runCheck ?? runEngineCheck)(
      {
        mod: workspace.modRoot,
        game: workspace.gameRoot,
        dependencies: workspace.dependencyRoots,
        includeDlc: workspace.dlcLayers.length > 0,
      },
      signal === undefined ? {} : { signal },
    );
    const build = report.inputs.game_version;
    if (build === null || build === undefined || build.length === 0)
      throw new ServiceError(
        'COMPAT_GAME_BUILD_UNKNOWN',
        'The engine could not read the installed game build, so no snapshot can be named',
      );
    installedBuild = build;
    recorded = await recordSnapshot(
      workspace,
      build,
      await overriddenVanillaFiles(report, signal),
      signal,
    );
    stored = await listSnapshots(workspace);
  }
  const target = input.to ?? installedBuild;
  const to = stored.find(({ manifest }) => manifest.build === target);
  if (to === undefined) throw missingSnapshot(target ?? '', stored);
  const fromSnapshot =
    input.from === undefined
      ? stored.find(({ manifest }) => manifest.build !== to.manifest.build)
      : stored.find(({ manifest }) => manifest.build === input.from);
  if (input.from !== undefined && fromSnapshot === undefined)
    throw missingSnapshot(input.from, stored);
  if (fromSnapshot?.manifest.build === to.manifest.build)
    throw new ServiceError('COMPAT_SNAPSHOT_SAME_BUILD', 'from and to name the same game build');
  const comparison =
    fromSnapshot === undefined ? null : await compareSnapshots(fromSnapshot, to, modShips, signal);
  const build = (limit: number): CompatPatchData => {
    const listed = comparison?.files.slice(0, limit) ?? [];
    const total =
      comparison === null ? 0 : comparison.changed + comparison.added + comparison.removed;
    const summary =
      comparison === null
        ? `Recorded the baseline for game build ${to.manifest.build}: ${to.manifest.files.length} vanilla files the mod overrides. Run again after the next game update to see which overrides the patch made stale.`
        : `Between game builds ${comparison.from} and ${comparison.to}: ${comparison.changed} overridden files changed, ${comparison.added} were added and ${comparison.removed} removed in vanilla, ${comparison.unchanged} are unchanged. A changed file may mean the mod's override is stale.`;
    return {
      mode: 'patch',
      workspace: workspaceRef,
      installedBuild,
      recorded:
        recorded === null
          ? null
          : snapshotInfo({ manifest: recorded.manifest, bytes: recorded.bytes }),
      pruned: recorded?.pruned ?? [],
      stored: stored.slice(0, 8).map(snapshotInfo),
      comparison:
        comparison === null
          ? null
          : {
              from: comparison.from,
              to: comparison.to,
              changed: comparison.changed,
              added: comparison.added,
              removed: comparison.removed,
              unchanged: comparison.unchanged,
              noLongerOverridden: comparison.noLongerOverridden,
              omitted: Math.max(0, total - listed.length),
              files: listed,
            },
      summary,
      durationMs: Date.now() - started,
    };
  };
  return fitToBudget(build, input.limit);
}
