import type { LocDocument } from './write-format.js';

const CONTEXT = 2;
const NO_NEWLINE = '\\ No newline at end of file';

interface Row {
  type: ' ' | '-' | '+';
  text: string;
  noEol: boolean;
}

/** A byte order mark has no glyph, so a diff shows it as a marker on the first line. */
const BOM_MARK = '[BOM]';

/**
 * The unified diff of a document against the file as it was read. Edits only replace a line in
 * place or insert lines, so each line carries what it was and the diff needs no search. Context is
 * two lines. `budgetBytes` cuts the diff at a line boundary and says how many lines it omitted.
 */
export function documentDiff(
  document: LocDocument,
  relativePath: string,
  budgetBytes: number,
): { diff: string; truncated: boolean } {
  const created = document.encoding === 'new';
  const bomChanged = created || document.target !== document.encoding;
  const rows: Row[] = [];
  const oldNumbers: number[] = [];
  const newNumbers: number[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const [index, line] of document.lines.entries()) {
    const mark = index === 0 && bomChanged ? BOM_MARK : '';
    newNumber += 1;
    if (line.orig === null) {
      rows.push({ type: '+', text: mark + line.content, noEol: line.eol === '' });
      oldNumbers.push(oldNumber);
      newNumbers.push(newNumber);
      continue;
    }
    oldNumber += 1;
    const changed = line.content !== line.origContent || line.eol !== line.origEol || mark !== '';
    if (!changed) {
      rows.push({ type: ' ', text: line.content, noEol: line.eol === '' });
      oldNumbers.push(oldNumber);
      newNumbers.push(newNumber);
      continue;
    }
    rows.push({ type: '-', text: line.origContent, noEol: line.origEol === '' });
    oldNumbers.push(oldNumber);
    newNumbers.push(newNumber);
    rows.push({ type: '+', text: mark + line.content, noEol: line.eol === '' });
    oldNumbers.push(oldNumber);
    newNumbers.push(newNumber);
  }

  const header = created
    ? ['--- /dev/null', `+++ b/${relativePath}`]
    : [
        `--- a/${relativePath}${document.encoding.startsWith('utf16') ? ` (${document.encoding})` : ''}`,
        `+++ b/${relativePath}${document.target !== document.encoding ? ' (utf-8 with BOM)' : ''}`,
      ];
  const changedAt = rows.flatMap((row, index) => (row.type === ' ' ? [] : [index]));
  const output: string[] = [...header];
  let bytes = header.join('\n').length;
  let truncated = false;
  let omitted = 0;
  let cursor = 0;
  for (let at = 0; at < changedAt.length;) {
    let last = changedAt[at]!;
    let next = at + 1;
    while (next < changedAt.length && changedAt[next]! - last <= CONTEXT * 2 + 1) {
      last = changedAt[next]!;
      next += 1;
    }
    const start = Math.max(cursor, changedAt[at]! - CONTEXT);
    const end = Math.min(rows.length - 1, last + CONTEXT);
    const slice = rows.slice(start, end + 1);
    const oldCount = slice.filter(({ type }) => type !== '+').length;
    const newCount = slice.filter(({ type }) => type !== '-').length;
    const firstOld = slice.findIndex(({ type }) => type !== '+');
    const firstNew = slice.findIndex(({ type }) => type !== '-');
    const oldStart = oldCount === 0 ? oldNumbers[start]! : oldNumbers[start + firstOld]!;
    const newStart = newCount === 0 ? newNumbers[start]! : newNumbers[start + firstNew]!;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const row of slice) {
      lines.push(`${row.type}${row.text}`);
      if (row.noEol) lines.push(NO_NEWLINE);
    }
    for (const [offset, line] of lines.entries()) {
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > budgetBytes) {
        omitted += lines.length - offset;
        truncated = true;
        break;
      }
      output.push(line);
    }
    if (truncated) {
      for (let rest = next; rest < changedAt.length; rest += 1) omitted += 1;
      break;
    }
    cursor = end + 1;
    at = next;
  }
  if (truncated) output.push(`... diff truncated, about ${omitted} more lines`);
  return { diff: output.join('\n'), truncated };
}
