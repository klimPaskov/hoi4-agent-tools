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
  /** Matrix threshold before the exact linear-memory patience algorithm is used. */
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
  if (!Number.isSafeInteger(cells) || cells > maxMatrixCells)
    return patienceDiff(oldLines, newLines, maxMatrixCells, options.signal);
  return matrixDiff(oldLines, newLines, options);
}

function matrixDiff(oldLines: string[], newLines: string[], options: TextDiffOptions): string[] {
  const columns = newLines.length + 1;
  const cells = (oldLines.length + 1) * columns;
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

interface DiffRange {
  kind: 'range';
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface DiffEmission {
  kind: 'same' | 'delete' | 'add';
  start: number;
  end: number;
}

type DiffTask = DiffRange | DiffEmission;

interface PatienceAnchor {
  oldIndex: number;
  newIndex: number;
}

function uniqueLineIndexes(lines: string[], start: number, end: number): Map<string, number> {
  const indexes = new Map<string, number>();
  const repeated = new Set<string>();
  for (let index = start; index < end; index += 1) {
    const line = lines[index]!;
    if (repeated.has(line)) continue;
    if (indexes.has(line)) {
      indexes.delete(line);
      repeated.add(line);
    } else indexes.set(line, index);
  }
  return indexes;
}

function patienceAnchors(
  oldLines: string[],
  newLines: string[],
  range: DiffRange,
  signal?: AbortSignal,
): PatienceAnchor[] {
  const oldUnique = uniqueLineIndexes(oldLines, range.oldStart, range.oldEnd);
  const newUnique = uniqueLineIndexes(newLines, range.newStart, range.newEnd);
  const candidates: PatienceAnchor[] = [];
  let visited = 0;
  for (const [line, oldIndex] of oldUnique) {
    if ((visited & 0x3ff) === 0) signal?.throwIfAborted();
    visited += 1;
    const newIndex = newUnique.get(line);
    if (newIndex !== undefined) candidates.push({ oldIndex, newIndex });
  }
  candidates.sort((left, right) => left.oldIndex - right.oldIndex);
  if (candidates.length <= 1) return candidates;

  const tails: number[] = [];
  const previous = new Int32Array(candidates.length);
  previous.fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    if ((index & 0x3ff) === 0) signal?.throwIfAborted();
    const newIndex = candidates[index]!.newIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]!]!.newIndex < newIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }

  const anchors = new Array<PatienceAnchor>(tails.length);
  let current = tails.at(-1)!;
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    anchors[index] = candidates[current]!;
    current = previous[current]!;
  }
  return anchors;
}

function patienceDiff(
  oldLines: string[],
  newLines: string[],
  matrixThreshold: number,
  signal?: AbortSignal,
): string[] {
  const result: string[] = [];
  const tasks: DiffTask[] = [
    {
      kind: 'range',
      oldStart: 0,
      oldEnd: oldLines.length,
      newStart: 0,
      newEnd: newLines.length,
    },
  ];
  let iterations = 0;
  while (tasks.length > 0) {
    if ((iterations & 0xff) === 0) signal?.throwIfAborted();
    iterations += 1;
    const task = tasks.pop()!;
    if (task.kind !== 'range') {
      const lines = task.kind === 'add' ? newLines : oldLines;
      const prefix = task.kind === 'same' ? ' ' : task.kind === 'add' ? '+' : '-';
      for (let index = task.start; index < task.end; index += 1)
        result.push(`${prefix}${lineContent(lines[index]!)}`);
      continue;
    }

    let { oldStart, oldEnd, newStart, newEnd } = task;
    while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) {
      result.push(` ${lineContent(oldLines[oldStart]!)}`);
      oldStart += 1;
      newStart += 1;
    }
    let commonSuffix = 0;
    while (
      oldStart < oldEnd - commonSuffix &&
      newStart < newEnd - commonSuffix &&
      oldLines[oldEnd - commonSuffix - 1] === newLines[newEnd - commonSuffix - 1]
    )
      commonSuffix += 1;
    oldEnd -= commonSuffix;
    newEnd -= commonSuffix;
    if (commonSuffix > 0) tasks.push({ kind: 'same', start: oldEnd, end: oldEnd + commonSuffix });

    if (oldStart === oldEnd) {
      if (newStart < newEnd) tasks.push({ kind: 'add', start: newStart, end: newEnd });
      continue;
    }
    if (newStart === newEnd) {
      tasks.push({ kind: 'delete', start: oldStart, end: oldEnd });
      continue;
    }
    const rangeCells = (oldEnd - oldStart + 1) * (newEnd - newStart + 1);
    if (Number.isSafeInteger(rangeCells) && rangeCells <= matrixThreshold) {
      const rows = matrixDiff(oldLines.slice(oldStart, oldEnd), newLines.slice(newStart, newEnd), {
        maxMatrixCells: matrixThreshold,
        ...(signal === undefined ? {} : { signal }),
      });
      result.push(...rows);
      continue;
    }

    const range: DiffRange = { kind: 'range', oldStart, oldEnd, newStart, newEnd };
    const anchors = patienceAnchors(oldLines, newLines, range, signal);
    if (anchors.length === 0) {
      tasks.push({ kind: 'add', start: newStart, end: newEnd });
      tasks.push({ kind: 'delete', start: oldStart, end: oldEnd });
      continue;
    }
    const ordered: DiffTask[] = [];
    let previousOld = oldStart;
    let previousNew = newStart;
    for (const anchor of anchors) {
      if (previousOld < anchor.oldIndex || previousNew < anchor.newIndex) {
        ordered.push({
          kind: 'range',
          oldStart: previousOld,
          oldEnd: anchor.oldIndex,
          newStart: previousNew,
          newEnd: anchor.newIndex,
        });
      }
      ordered.push({ kind: 'same', start: anchor.oldIndex, end: anchor.oldIndex + 1 });
      previousOld = anchor.oldIndex + 1;
      previousNew = anchor.newIndex + 1;
    }
    if (previousOld < oldEnd || previousNew < newEnd) {
      ordered.push({
        kind: 'range',
        oldStart: previousOld,
        oldEnd,
        newStart: previousNew,
        newEnd,
      });
    }
    for (let index = ordered.length - 1; index >= 0; index -= 1) tasks.push(ordered[index]!);
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
