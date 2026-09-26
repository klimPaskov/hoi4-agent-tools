import { ServiceError } from '../core/result.js';

export interface BoundedLineRead {
  text: string;
  endLine: number;
  nextLine: number | null;
  nextColumn: number | null;
}

/** Preserve source text while bounding one reply by lines and UTF-8 bytes. */
export function readBoundedLines(
  lines: readonly string[],
  firstLine: number,
  startLine: number,
  startColumn: number,
  maxLines: number,
  maxBytes: number,
): BoundedLineRead {
  let lineIndex = startLine - firstLine;
  let columnIndex = startColumn - 1;
  if (lineIndex < 0 || lineIndex >= lines.length || columnIndex > (lines[lineIndex]?.length ?? 0)) {
    throw new ServiceError(
      'REFERENCE_POSITION_OUTSIDE_SECTION',
      'Requested position is outside the selected section',
    );
  }
  const first = lines[lineIndex]!;
  if (
    columnIndex > 0 &&
    /[\uD800-\uDBFF]/u.test(first[columnIndex - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(first[columnIndex] ?? '')
  ) {
    throw new ServiceError(
      'REFERENCE_POSITION_OUTSIDE_SECTION',
      'Requested column splits a Unicode character',
    );
  }
  const selected: string[] = [];
  let bytes = 0;
  let endLine = startLine;
  while (lineIndex < lines.length && selected.length < maxLines) {
    const line = lines[lineIndex]!;
    const remainder = line.slice(columnIndex);
    const separator = selected.length === 0 ? 0 : 1;
    const allowance = maxBytes - bytes - separator;
    if (allowance <= 0) break;
    let consumed = 0;
    let used = 0;
    for (const character of remainder) {
      const characterBytes = Buffer.byteLength(character, 'utf8');
      if (used + characterBytes > allowance) break;
      consumed += character.length;
      used += characterBytes;
    }
    if (consumed === 0 && remainder.length > 0) break;
    selected.push(remainder.slice(0, consumed));
    bytes += separator + used;
    endLine = firstLine + lineIndex;
    if (consumed < remainder.length) {
      columnIndex += consumed;
      break;
    }
    lineIndex++;
    columnIndex = 0;
  }
  return {
    text: selected.join('\n'),
    endLine,
    nextLine: lineIndex < lines.length ? firstLine + lineIndex : null,
    nextColumn: lineIndex < lines.length ? columnIndex + 1 : null,
  };
}
