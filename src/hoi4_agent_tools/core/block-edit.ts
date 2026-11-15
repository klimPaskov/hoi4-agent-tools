/**
 * Text helpers the source writers share (`hoi4.idea_write`, `hoi4.character_write`): the indentation
 * of a line, and a body re-indented to sit inside a block.
 */

/** The whitespace that starts the line `offset` is on. */
export function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/u.test(prefix) ? prefix : (/^[ \t]*/u.exec(prefix)?.[0] ?? '');
}

/** The body re-indented to `inner`, without its common leading indentation and blank edges. */
export function indentedBody(body: string, inner: string, newline: string): string {
  const lines = body.split(/\r\n|\r|\n/u).map((line) => line.replace(/[ \t]+$/u, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const indents = lines
    .filter((line) => line !== '')
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => (line === '' ? '' : `${inner}${line.slice(common)}`)).join(newline);
}
