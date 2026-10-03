import { ServiceError } from '../core/result.js';
import { locationFor } from '../core/source/lexer.js';
import type { BlockNode, SourceDocument, SourceEntry, SourceRange } from '../core/source/parser.js';
import { readBoundedJsonLines } from './lines.js';

export type SourceKeyStep =
  | {
      key: string;
      occurrence?: number | undefined;
    }
  | { index: number };

function preview(text: string, limit: number): { text: string; truncated: boolean } {
  let end = Math.min(text.length, limit);
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(text[end - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? '')
  )
    end--;
  return { text: text.slice(0, end), truncated: end < text.length };
}

function findEntry(block: BlockNode, range: SourceRange): SourceEntry | undefined {
  for (const entry of block.entries) {
    if (entry.start === range.start && entry.end === range.end) return entry;
    const value = entry.type === 'assignment' ? entry.value : entry;
    if (value.type !== 'block' || value.start > range.start || value.end < range.end) continue;
    if (value.start === range.start && value.end === range.end) return value;
    const found = findEntry(value, range);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Navigate actual parser nodes, preserving duplicate keys and exact source boundaries. */
export function navigateSource(
  document: SourceDocument,
  range: SourceRange,
  keyPath: readonly SourceKeyStep[],
  options: {
    structure: boolean;
    maxChildren: number;
    childOffset: number;
    maxLines: number;
    fromLine?: number;
    fromColumn?: number;
  },
) {
  if (document.diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker'))
    throw new ServiceError(
      'SOURCE_STRUCTURE_UNAVAILABLE',
      'Cannot navigate a source document with parse errors',
    );
  const definition = findEntry(document.root, range);
  if (definition === undefined)
    throw new ServiceError(
      'SOURCE_STRUCTURE_UNAVAILABLE',
      'Indexed definition does not identify an exact parser node',
    );
  let selected: SourceEntry = definition;
  const resolvedPath: Array<{ key: string; occurrence: number } | { index: number }> = [];
  for (const step of keyPath) {
    const value = selected.type === 'assignment' ? selected.value : selected;
    if (value.type !== 'block')
      throw new ServiceError(
        'SOURCE_PATH_NOT_BLOCK',
        'Cannot navigate inside a scalar source value',
        { keyPath: resolvedPath },
      );
    if ('index' in step) {
      const child = value.entries[step.index];
      if (child === undefined)
        throw new ServiceError(
          'SOURCE_INDEX_UNKNOWN',
          'No source child exists at the requested entry index',
          { index: step.index },
        );
      selected = child;
      resolvedPath.push({ index: step.index });
      continue;
    }
    const matches = value.entries.filter(
      (entry) => entry.type === 'assignment' && entry.key.value === step.key,
    );
    if (step.occurrence === undefined && matches.length > 1)
      throw new ServiceError(
        'SOURCE_PATH_AMBIGUOUS',
        'Repeated key requires an explicit zero-based occurrence',
        { key: step.key, occurrences: matches.length },
      );
    const occurrence = step.occurrence ?? 0;
    const child = matches[occurrence];
    if (child === undefined)
      throw new ServiceError(
        'SOURCE_PATH_UNKNOWN',
        'No source child matches the requested key and occurrence',
        { key: step.key, occurrence },
      );
    selected = child;
    resolvedPath.push(
      Buffer.byteLength(step.key, 'utf8') > 128
        ? { index: value.entries.indexOf(child) }
        : { key: step.key, occurrence },
    );
  }
  const location = locationFor(document.path, document.lineIndex, selected.start, selected.end);
  const fromLine = options.fromLine ?? location.start.line;
  const fromColumn =
    options.fromColumn ?? (fromLine === location.start.line ? location.start.column : 1);
  if (
    fromLine < location.start.line ||
    fromLine > location.end.line ||
    (fromLine === location.start.line && fromColumn < location.start.column) ||
    (fromLine === location.end.line && fromColumn > location.end.column)
  )
    throw new ServiceError(
      'SOURCE_POSITION_OUTSIDE_SELECTION',
      'Requested position is outside the selected parser node',
    );
  const lines = document.text.split(/\r?\n/u).slice(location.start.line - 1, location.end.line);
  lines[lines.length - 1] = lines.at(-1)!.slice(0, location.end.column - 1);
  const read = options.structure
    ? { text: '', endLine: location.end.line, nextLine: null, nextColumn: null }
    : readBoundedJsonLines(
        lines,
        location.start.line,
        fromLine,
        fromColumn,
        options.maxLines,
        2000,
        4096,
      );
  const value = selected.type === 'assignment' ? selected.value : selected;
  const entries = options.structure && value.type === 'block' ? value.entries : [];
  const occurrences = new Map<string | null, number>();
  if (options.structure && options.childOffset > entries.length)
    throw new ServiceError(
      'SOURCE_CHILD_OFFSET_OUTSIDE_SELECTION',
      'Child offset exceeds the selected block',
    );
  for (const entry of entries.slice(0, options.childOffset)) {
    const key = entry.type === 'assignment' ? entry.key.value : null;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  const candidates = entries
    .slice(options.childOffset, options.childOffset + options.maxChildren)
    .map((entry, index) => {
      const key = entry.type === 'assignment' ? entry.key.value : null;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const childValue = entry.type === 'assignment' ? entry.value : entry;
      const childLocation = locationFor(document.path, document.lineIndex, entry.start, entry.end);
      const keyPreview = key === null ? null : preview(key, 1024);
      const valuePreview = childValue.type === 'scalar' ? preview(childValue.value, 120) : null;
      return {
        key: keyPreview?.text ?? null,
        index: options.childOffset + index,
        keyTruncated: keyPreview?.truncated ?? false,
        occurrence,
        kind: childValue.type,
        value: valuePreview?.text ?? null,
        valueTruncated: valuePreview?.truncated ?? false,
        startLine: childLocation.start.line,
        endLine: childLocation.end.line,
        childCount: childValue.type === 'block' ? childValue.entries.length : 0,
      };
    });
  const children: typeof candidates = [];
  let childBytes = 2;
  for (const child of candidates) {
    const bytes = Buffer.byteLength(JSON.stringify(child), 'utf8') + 1;
    if (childBytes + bytes > 6000) break;
    children.push(child);
    childBytes += bytes;
  }
  return {
    ...read,
    fromLine,
    navigation: {
      keyPath: resolvedPath,
      startLine: location.start.line,
      startColumn: location.start.column,
      endLine: location.end.line,
      endColumn: location.end.column,
      children,
      omittedChildren: Math.max(0, entries.length - options.childOffset - children.length),
      nextChildOffset:
        options.childOffset + children.length < entries.length
          ? options.childOffset + children.length
          : null,
    },
  };
}
