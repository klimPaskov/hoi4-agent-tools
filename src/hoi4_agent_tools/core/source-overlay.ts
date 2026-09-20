import path from 'node:path';
import { compareCodeUnits, hashCanonical, sha256Bytes } from './canonical.js';
import type { ScanSnapshot } from './engine.js';
import { SymbolIndex } from './index.js';
import type { ScannedFile } from './scanner.js';
import { isWithin, type ResolvedWorkspace } from './workspace.js';

export interface ProposedSourceEdit {
  /** Workspace-relative source path in the authorized mod root. */
  relativePath: string;
  /** Null removes a source from the proposed snapshot; a string adds or replaces it. */
  content: string | null;
}

export interface ProposedOverlayResult {
  baselineRevision: string;
  snapshot: ScanSnapshot;
  changes: Array<{
    path: string;
    change: 'added' | 'replaced' | 'removed';
    beforeHash: string | null;
    afterHash: string | null;
  }>;
}

const MAX_EDITS = 64;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SOURCE_EXTENSION = /\.(?:txt|gui|gfx|yml|yaml)$/iu;

function checkedRelativePath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.length > 4096 ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath)
  )
    throw new RangeError('Proposed source path is not workspace-relative');
  const parts = relativePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..'))
    throw new RangeError('Proposed source path is not normalized');
  if (!SOURCE_EXTENSION.test(relativePath))
    throw new RangeError('Proposed source must be a supported text source');
  return relativePath;
}

function revision(files: readonly ScannedFile[]): string {
  return hashCanonical(
    files.map(
      ({ absolutePath, displayPath, relativePath, rootKind, loadOrder, shadowedBy, sha256 }) => ({
        absolutePath,
        displayPath,
        relativePath,
        rootKind,
        loadOrder,
        shadowedBy: shadowedBy ?? null,
        sha256,
      }),
    ),
  );
}

/** Builds a source-only proposal in memory under the authorized mod root. */
export function buildProposedSourceOverlay(
  baseline: ScanSnapshot,
  workspace: ResolvedWorkspace,
  edits: readonly ProposedSourceEdit[],
): ProposedOverlayResult {
  if (edits.length < 1 || edits.length > MAX_EDITS)
    throw new RangeError(`Proposed overlay requires 1-${MAX_EDITS} edits`);
  if (baseline.workspaceId !== workspace.id)
    throw new Error('Proposed overlay workspace does not match its baseline snapshot');
  const modRoot = workspace.roots.find(({ kind }) => kind === 'mod');
  if (modRoot?.path !== workspace.modRoot) throw new Error('Authorized mod root is unavailable');
  const files: ScannedFile[] = baseline.files.map((file) => {
    const copy = { ...file };
    delete copy.shadowedBy;
    return copy;
  });
  const changes: ProposedOverlayResult['changes'] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const edit of edits) {
    const relativePath = checkedRelativePath(edit.relativePath);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate proposed source path: ${relativePath}`);
    seen.add(key);
    const existingIndex = files.findIndex(
      (file) =>
        file.rootKind === 'mod' && file.relativePath.toLowerCase() === relativePath.toLowerCase(),
    );
    const existing = existingIndex < 0 ? undefined : files[existingIndex];
    const sourcePath = existing?.relativePath ?? relativePath;
    const absolutePath = path.resolve(modRoot.path, ...sourcePath.split('/'));
    if (!isWithin(modRoot.path, absolutePath) || absolutePath === modRoot.path)
      throw new RangeError('Proposed source path escapes the authorized mod root');
    const displayPath = existing?.displayPath ?? `mod:${sourcePath}`;
    if (existing !== undefined) files.splice(existingIndex, 1);
    if (edit.content === null) {
      if (existing === undefined)
        throw new Error(`Proposed removal has no mod source: ${relativePath}`);
      changes.push({
        path: existing.displayPath,
        change: 'removed',
        beforeHash: existing.sha256,
        afterHash: null,
      });
      continue;
    }
    const bytes = Buffer.from(edit.content, 'utf8');
    totalBytes += bytes.length;
    if (bytes.length > MAX_EDIT_BYTES || totalBytes > MAX_TOTAL_BYTES)
      throw new RangeError('Proposed source content exceeds the overlay limit');
    const sha256 = sha256Bytes(bytes);
    files.push({
      absolutePath,
      displayPath,
      relativePath: sourcePath,
      rootKind: 'mod',
      loadOrder: modRoot.loadOrder,
      size: bytes.length,
      modifiedMs: 0,
      sha256,
      bytes,
    });
    changes.push({
      path: displayPath,
      change: existing === undefined ? 'added' : 'replaced',
      beforeHash: existing?.sha256 ?? null,
      afterHash: sha256,
    });
  }
  files.sort(
    (left, right) =>
      left.loadOrder - right.loadOrder || compareCodeUnits(left.relativePath, right.relativePath),
  );
  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const group = groups.get(file.relativePath.toLowerCase()) ?? [];
    group.push(file);
    groups.set(file.relativePath.toLowerCase(), group);
  }
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        right.loadOrder - left.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
    );
    for (const file of group.slice(1)) file.shadowedBy = group[0]!.displayPath;
  }
  const index = SymbolIndex.build(files);
  const snapshot: ScanSnapshot = {
    workspaceId: baseline.workspaceId,
    revision: revision(files),
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
    skippedSources: index.skippedSources,
    diagnostics: index.diagnostics,
  };
  return { baselineRevision: baseline.revision, snapshot, changes };
}
