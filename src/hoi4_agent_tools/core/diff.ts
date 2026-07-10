export interface TextDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface BinaryDiff {
  oldSize: number;
  newSize: number;
  changedBytes: number;
  firstChangedOffset?: number;
  lastChangedOffset?: number;
}

export interface TextDiffOptions {
  /** Maximum LCS matrix cells. Four bytes are allocated per cell. */
  maxMatrixCells?: number;
  signal?: AbortSignal;
}

const defaultMaxMatrixCells = 16_000_000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
}

function lineContent(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/u, '');
}

export function unifiedTextDiff(
  oldText: string,
  newText: string,
  oldName: string,
  newName: string,
  options: TextDiffOptions = {},
): string {
  options.signal?.throwIfAborted();
  if (oldText === newText) return '';
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const rows = lcsDiff(oldLines, newLines, options);
  return [
    `--- ${oldName}`,
    `+++ ${newName}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...rows,
  ].join('\n');
}

function lcsDiff(oldLines: string[], newLines: string[], options: TextDiffOptions): string[] {
  const columns = newLines.length + 1;
  const cells = (oldLines.length + 1) * columns;
  const maxMatrixCells = options.maxMatrixCells ?? defaultMaxMatrixCells;
  if (!Number.isSafeInteger(cells) || cells > maxMatrixCells) {
    throw new ServiceError(
      'DIFF_COMPLEXITY_LIMIT',
      'Exact source diff exceeds the configured deterministic memory bound',
      { oldLines: oldLines.length, newLines: newLines.length, cells, maxMatrixCells },
    );
  }
  const table = new Uint32Array(cells);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    if ((oldIndex & 0x3f) === 0) options.signal?.throwIfAborted();
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if ((newIndex & 0xfff) === 0) options.signal?.throwIfAborted();
      const current = oldIndex * columns + newIndex;
      table[current] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[(oldIndex + 1) * columns + newIndex + 1]! + 1
          : Math.max(
              table[(oldIndex + 1) * columns + newIndex]!,
              table[oldIndex * columns + newIndex + 1]!,
            );
    }
  }
  const result: string[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (((oldIndex + newIndex) & 0xff) === 0) options.signal?.throwIfAborted();
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      result.push(` ${lineContent(oldLines[oldIndex]!)}`);
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex === oldLines.length ||
        table[oldIndex * columns + newIndex + 1]! >= table[(oldIndex + 1) * columns + newIndex]!)
    ) {
      result.push(`+${lineContent(newLines[newIndex]!)}`);
      newIndex += 1;
    } else {
      result.push(`-${lineContent(oldLines[oldIndex]!)}`);
      oldIndex += 1;
    }
  }
  return result;
}

export function binaryDiff(oldBytes: Uint8Array, newBytes: Uint8Array): BinaryDiff {
  const length = Math.max(oldBytes.length, newBytes.length);
  let changedBytes = 0;
  let firstChangedOffset: number | undefined;
  let lastChangedOffset: number | undefined;
  for (let index = 0; index < length; index += 1) {
    if (oldBytes[index] !== newBytes[index]) {
      changedBytes += 1;
      firstChangedOffset ??= index;
      lastChangedOffset = index;
    }
  }
  return {
    oldSize: oldBytes.length,
    newSize: newBytes.length,
    changedBytes,
    ...(firstChangedOffset === undefined
      ? {}
      : { firstChangedOffset, lastChangedOffset: lastChangedOffset! }),
  };
}
import { ServiceError } from './result.js';
