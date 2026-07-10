import type { Diagnostic, SourceLocation, SourcePosition } from '../diagnostics.js';
import { SOURCE_LINE_LIMIT, SOURCE_TOKEN_LIMIT, SourceDiagnosticCollector } from './limits.js';

export type TokenKind =
  | 'whitespace'
  | 'comment'
  | 'string'
  | 'atom'
  | 'operator'
  | 'left_brace'
  | 'right_brace'
  | 'invalid';

export interface SourceToken {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface LexResult {
  tokens: SourceToken[];
  diagnostics: Diagnostic[];
}

export interface SourceLineIndex {
  readonly text: string;
  readonly lineStarts: readonly number[];
  readonly lineLimitExceededAt?: number;
}

export interface LexOptions {
  lineIndex?: SourceLineIndex;
  diagnostics?: SourceDiagnosticCollector;
}

const operatorStarts = new Set(['=', '<', '>', '!']);

function startsOperator(text: string, index: number): boolean {
  const character = text[index] ?? '';
  return operatorStarts.has(character) || (character === '?' && text[index + 1] === '=');
}
const triviaKinds = new Set<TokenKind>(['whitespace', 'comment']);

export function isTrivia(token: SourceToken): boolean {
  return triviaKinds.has(token.kind);
}

export function createSourceLineIndex(text: string): SourceLineIndex {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      if (lineStarts.length >= SOURCE_LINE_LIMIT) {
        return Object.freeze({
          text,
          lineStarts: Object.freeze(lineStarts),
          lineLimitExceededAt: index + 1,
        });
      }
      lineStarts.push(index + 1);
    } else if (character === '\n') {
      if (lineStarts.length >= SOURCE_LINE_LIMIT) {
        return Object.freeze({
          text,
          lineStarts: Object.freeze(lineStarts),
          lineLimitExceededAt: index + 1,
        });
      }
      lineStarts.push(index + 1);
    }
  }
  return Object.freeze({ text, lineStarts: Object.freeze(lineStarts) });
}

export function positionAt(source: string | SourceLineIndex, offset: number): SourcePosition {
  const lineIndex = typeof source === 'string' ? createSourceLineIndex(source) : source;
  const boundedOffset = Math.max(0, Math.min(offset, lineIndex.text.length));
  let low = 0;
  let high = lineIndex.lineStarts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (lineIndex.lineStarts[middle]! <= boundedOffset) low = middle + 1;
    else high = middle;
  }
  const lineOffset = Math.max(0, low - 1);
  if (
    boundedOffset < lineIndex.text.length &&
    lineIndex.text[boundedOffset] === '\n' &&
    lineIndex.text[boundedOffset - 1] === '\r'
  ) {
    return { line: lineOffset + 2, column: 1, offset };
  }
  return {
    line: lineOffset + 1,
    column:
      boundedOffset -
      lineIndex.lineStarts[lineOffset]! +
      1 +
      Math.max(0, offset - lineIndex.text.length),
    offset,
  };
}

export function locationFor(
  path: string,
  source: string | SourceLineIndex,
  start: number,
  end: number,
): SourceLocation {
  return { path, start: positionAt(source, start), end: positionAt(source, end) };
}

export function lexClausewitz(
  text: string,
  sourcePath: string,
  options: LexOptions = {},
): LexResult {
  const tokens: SourceToken[] = [];
  const lineIndex = options.lineIndex ?? createSourceLineIndex(text);
  const diagnostics = options.diagnostics ?? new SourceDiagnosticCollector();
  if (lineIndex.lineLimitExceededAt !== undefined) {
    diagnostics.add(() => ({
      code: 'SOURCE_LINE_LIMIT',
      severity: 'blocker',
      category: 'syntax',
      message: `Source line count exceeds the supported limit of ${SOURCE_LINE_LIMIT}`,
      location: {
        path: sourcePath,
        start: {
          line: SOURCE_LINE_LIMIT + 1,
          column: 1,
          offset: lineIndex.lineLimitExceededAt!,
        },
        end: {
          line: SOURCE_LINE_LIMIT + 1,
          column: 1,
          offset: lineIndex.lineLimitExceededAt!,
        },
      },
      details: { limit: SOURCE_LINE_LIMIT },
    }));
    return { tokens, diagnostics: diagnostics.diagnostics };
  }
  let index = 0;
  let line = 1;
  let column = 1;

  const add = (kind: TokenKind, start: number, startLine: number, startColumn: number): void => {
    tokens.push({
      kind,
      text: text.slice(start, index),
      start,
      end: index,
      line: startLine,
      column: startColumn,
    });
  };
  const advance = (): string => {
    const current = text[index] ?? '';
    index += 1;
    if (current === '\r') {
      if (text[index] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (current === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return current;
  };

  while (index < text.length) {
    if (tokens.length >= SOURCE_TOKEN_LIMIT) {
      diagnostics.add(() => ({
        code: 'SOURCE_TOKEN_LIMIT',
        severity: 'blocker',
        category: 'syntax',
        message: `Source token count exceeds the supported limit of ${SOURCE_TOKEN_LIMIT}`,
        location: locationFor(sourcePath, lineIndex, index, Math.min(text.length, index + 1)),
        details: { limit: SOURCE_TOKEN_LIMIT },
      }));
      break;
    }
    const start = index;
    const startLine = line;
    const startColumn = column;
    const current = text[index] ?? '';

    if (/\s/u.test(current)) {
      while (index < text.length && /\s/u.test(text[index] ?? '')) advance();
      add('whitespace', start, startLine, startColumn);
      continue;
    }
    if (current === '#') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') advance();
      add('comment', start, startLine, startColumn);
      continue;
    }
    if (current === '{' || current === '}') {
      advance();
      add(current === '{' ? 'left_brace' : 'right_brace', start, startLine, startColumn);
      continue;
    }
    if (current === '"') {
      advance();
      let terminated = false;
      while (index < text.length) {
        if (text[index] === '\\') {
          const escapeStart = index;
          advance();
          if (index < text.length) {
            const escaped = text[index];
            advance();
            if (escaped !== '\\' && escaped !== '"') {
              diagnostics.add(() => ({
                code: 'SOURCE_UNSUPPORTED_ESCAPE',
                severity: 'error',
                category: 'syntax',
                message: `Clausewitz strings support only \\\\ and \\" escapes`,
                location: locationFor(sourcePath, lineIndex, escapeStart, index),
              }));
            }
          }
          continue;
        }
        if (text[index] === '"') {
          advance();
          terminated = true;
          break;
        }
        advance();
      }
      add(terminated ? 'string' : 'invalid', start, startLine, startColumn);
      if (!terminated) {
        diagnostics.add(() => ({
          code: 'SOURCE_UNTERMINATED_STRING',
          severity: 'error',
          category: 'syntax',
          message: 'Unterminated quoted string',
          location: locationFor(sourcePath, lineIndex, start, index),
        }));
      }
      if (terminated && /[\r\n]/u.test(text.slice(start, index))) {
        diagnostics.add(() => ({
          code: 'SOURCE_STRING_NEWLINE',
          severity: 'error',
          category: 'syntax',
          message: 'Clausewitz quoted strings cannot contain a literal newline',
          location: locationFor(sourcePath, lineIndex, start, index),
        }));
      }
      if (terminated && text.slice(start + 1, index - 1).length > 255) {
        diagnostics.add(() => ({
          code: 'SOURCE_STRING_TOO_LONG',
          severity: 'warning',
          category: 'syntax',
          message: 'Clausewitz quoted strings longer than 255 characters are not portable',
          location: locationFor(sourcePath, lineIndex, start, index),
        }));
      }
      continue;
    }
    if (startsOperator(text, index)) {
      advance();
      if (text[index] === '=') advance();
      add('operator', start, startLine, startColumn);
      const operator = text.slice(start, index);
      if (!['=', '<', '>', '?='].includes(operator)) {
        diagnostics.add(() => ({
          code: 'SOURCE_UNSUPPORTED_OPERATOR',
          severity: 'error',
          category: 'syntax',
          message: `Unsupported Clausewitz operator ${operator}`,
          location: locationFor(sourcePath, lineIndex, start, index),
        }));
      }
      continue;
    }

    while (index < text.length) {
      const character = text[index] ?? '';
      if (
        /\s/u.test(character) ||
        character === '#' ||
        character === '{' ||
        character === '}' ||
        character === '"' ||
        startsOperator(text, index)
      ) {
        break;
      }
      advance();
    }
    if (index === start) {
      advance();
      add('invalid', start, startLine, startColumn);
      diagnostics.add(() => ({
        code: 'SOURCE_INVALID_CHARACTER',
        severity: 'error',
        category: 'syntax',
        message: `Invalid character ${JSON.stringify(current)}`,
        location: locationFor(sourcePath, lineIndex, start, index),
      }));
    } else {
      add('atom', start, startLine, startColumn);
    }
  }
  return { tokens, diagnostics: diagnostics.diagnostics };
}
