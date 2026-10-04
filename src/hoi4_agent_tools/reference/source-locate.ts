/**
 * Source position lookup: map a file and line to the indexed definitions that contain it and
 * to the exact chain of Clausewitz assignments enclosing it.
 *
 * The returned `keyPath` is relative to the innermost containing definition, so an agent can
 * pass that definition's `id`, `kind`, and `keyPath` to `hoi4.source_lookup` navigation. The
 * chain is derived from parser nodes, preserving repeated keys through zero-based occurrences.
 */
import path from 'node:path';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { ServiceError } from '../core/result.js';
import { isWithin } from '../core/workspace.js';
import type { ScannedFile } from '../core/scanner.js';
import { positionAt } from '../core/source/lexer.js';
import { parseClausewitz, type BlockNode, type SourceEntry } from '../core/source/parser.js';

const MAX_OWNERS = 8;
const MAX_CHAIN = 24;
const MAX_KEY_BYTES = 128;
const MAX_LINE_TEXT = 300;

export interface SourceLocation {
  path: string;
  rootKind: string;
  loadOrder: number;
  shadowed: boolean;
  line: number;
  column: number;
  text: string;
  owners: Array<{
    kind: string;
    id: string;
    startLine: number;
    endLine: number;
    overridden: boolean;
  }>;
  chain: Array<{
    key: string | null;
    occurrence: number;
    index: number;
    startLine: number;
    endLine: number;
  }>;
  chainTruncated: boolean;
  keyPath: Array<{ key: string; occurrence?: number } | { index: number }> | null;
  structureAvailable: boolean;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Resolve a display, relative, or absolute path to one scanned file, preferring the active layer. */
function selectFile(snapshot: ScanSnapshot, requested: string): ScannedFile {
  const normalized = requested.replaceAll('\\', '/').replace(/^\.\//u, '');
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : undefined;
  const candidates = [...snapshot.index.files.values()].filter(
    (file) =>
      file.displayPath === normalized ||
      file.relativePath.replaceAll('\\', '/') === normalized ||
      (absolute !== undefined && samePath(path.resolve(file.absolutePath), absolute)),
  );
  if (candidates.length === 0)
    throw new ServiceError(
      'SOURCE_FILE_NOT_INDEXED',
      'No indexed source file matches the path; use a mod-relative path such as events/example.txt',
    );
  return candidates.find(({ shadowedBy }) => shadowedBy === undefined) ?? candidates[0]!;
}

/**
 * Scan only the requested file's folder family in every layer. Definitions and same-path
 * overrides of a source position live beside it, so the whole workspace index is unnecessary.
 */
export function locatePatterns(
  engine: CoreEngine,
  workspaceId: string,
  requested: string,
  principal?: string,
): string[] | undefined {
  let relative = requested.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (path.isAbsolute(requested)) {
    const absolute = path.resolve(requested);
    const root = engine.resolver
      .get(workspaceId, principal)
      .roots.find((candidate) => isWithin(candidate.path, absolute));
    if (root === undefined) return undefined;
    relative = path.relative(root.path, absolute).replaceAll('\\', '/');
  } else {
    const label = /^[A-Za-z0-9_.-]+:(?!\/)(.+)$/u.exec(relative);
    if (label !== null) relative = label[1]!;
  }
  const extension = path.posix.extname(relative);
  const directory = path.posix.dirname(relative);
  if (
    relative.length === 0 ||
    extension.length === 0 ||
    /[*?[\]{}!]/u.test(relative) ||
    relative.split('/').includes('..')
  )
    return undefined;
  return [directory === '.' ? `*${extension}` : `${directory}/**/*${extension}`];
}

function entryValue(entry: SourceEntry): SourceEntry {
  return entry.type === 'assignment' ? entry.value : entry;
}

export function locateSource(
  snapshot: ScanSnapshot,
  requestedPath: string,
  line: number,
  requestedColumn: number | undefined,
): SourceLocation {
  const file = selectFile(snapshot, requestedPath);
  const document = parseClausewitz(file.bytes, file.displayPath);
  const starts = document.lineIndex.lineStarts;
  if (line > starts.length)
    throw new ServiceError(
      'SOURCE_LINE_OUTSIDE_FILE',
      'Requested line is beyond the end of the file',
      {
        lines: starts.length,
      },
    );
  const lineStart = starts[line - 1]!;
  const lineEnd = line < starts.length ? starts[line]! : document.text.length;
  const lineText = document.text.slice(lineStart, lineEnd).replace(/\r?\n$/u, '');
  // Without a column, land on the first non-blank character so an indented line selects its
  // own assignment rather than the enclosing block.
  const column = requestedColumn ?? Math.max(1, lineText.search(/\S/u) + 1);
  if (column > lineText.length + 1)
    throw new ServiceError(
      'SOURCE_COLUMN_OUTSIDE_LINE',
      'Requested column is beyond the end of the line',
    );
  const offset = lineStart + column - 1;

  const owners = snapshot.index.symbols
    .filter(
      (symbol) =>
        symbol.path === file.displayPath &&
        symbol.location !== undefined &&
        symbol.location.start.offset <= offset &&
        offset < Math.max(symbol.location.end.offset, symbol.location.start.offset + 1),
    )
    .sort(
      (left, right) =>
        left.location!.end.offset -
          left.location!.start.offset -
          (right.location!.end.offset - right.location!.start.offset) ||
        right.location!.start.offset - left.location!.start.offset,
    );

  const structureAvailable = !document.diagnostics.some(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  const steps: Array<{
    entry: SourceEntry;
    key: string | null;
    occurrence: number;
    index: number;
  }> = [];
  if (structureAvailable) {
    let block: BlockNode | undefined = document.root;
    while (block !== undefined) {
      const index: number = block.entries.findIndex(
        (entry) => entry.start <= offset && offset < Math.max(entry.end, entry.start + 1),
      );
      if (index < 0) break;
      const entry: SourceEntry = block.entries[index]!;
      const key = entry.type === 'assignment' ? entry.key.value : null;
      const occurrence =
        key === null
          ? 0
          : block.entries
              .slice(0, index)
              .filter((candidate) => candidate.type === 'assignment' && candidate.key.value === key)
              .length;
      steps.push({ entry, key, occurrence, index });
      const value = entryValue(entry);
      block = value.type === 'block' && value !== block ? value : undefined;
    }
  }
  const lineOf = (position: number) => positionAt(document.lineIndex, position).line;
  const chain = steps.slice(0, MAX_CHAIN).map(({ entry, key, occurrence, index }) => ({
    key: key !== null && Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES ? key : null,
    occurrence,
    index,
    startLine: lineOf(entry.start),
    endLine: lineOf(Math.max(entry.start, entry.end - 1)),
  }));

  // The key path continues from the innermost definition that is itself a chain node.
  let keyPath: SourceLocation['keyPath'] = null;
  if (structureAvailable)
    for (const owner of owners) {
      const anchor = steps.findIndex(
        ({ entry }) =>
          entry.start === owner.location!.start.offset && entry.end === owner.location!.end.offset,
      );
      if (anchor < 0) continue;
      keyPath = steps
        .slice(anchor + 1)
        .map(({ key, occurrence, index }) =>
          key !== null && Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES
            ? { key, occurrence }
            : { index },
        );
      break;
    }

  let text = lineText.slice(0, MAX_LINE_TEXT);
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  return {
    path: file.displayPath,
    rootKind: file.rootKind,
    loadOrder: file.loadOrder,
    shadowed: file.shadowedBy !== undefined,
    line,
    column,
    text,
    owners: owners.slice(0, MAX_OWNERS).map((owner) => ({
      kind: owner.kind,
      id: owner.id.slice(0, 1024),
      startLine: owner.location!.start.line,
      endLine: owner.location!.end.line,
      overridden: owner.overridden,
    })),
    chain,
    chainTruncated: steps.length > chain.length,
    keyPath: keyPath === null || keyPath.length > MAX_CHAIN ? null : keyPath,
    structureAvailable,
  };
}
