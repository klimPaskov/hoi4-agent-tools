import type { Diagnostic, SourceLocation } from '../diagnostics.js';
import { hasBlockingDiagnostics } from '../diagnostics.js';
import { ServiceError } from '../result.js';
import { sha256Bytes } from '../canonical.js';
import { decodeSource, encodeSource, type DecodedSource } from './encoding.js';
import {
  createSourceLineIndex,
  isTrivia,
  lexClausewitz,
  locationFor,
  type SourceLineIndex,
  type SourceToken,
} from './lexer.js';
import {
  SOURCE_LINE_LIMIT,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_NESTING,
  SourceDiagnosticCollector,
} from './limits.js';

export interface SourceRange {
  start: number;
  end: number;
}

export interface ScalarNode extends SourceRange {
  type: 'scalar';
  token: SourceToken;
  value: string;
  quoted: boolean;
}

export interface AssignmentNode extends SourceRange {
  type: 'assignment';
  key: ScalarNode;
  operator: SourceToken;
  value: SourceValue;
}

export interface BlockNode extends SourceRange {
  type: 'block';
  open?: SourceToken;
  close?: SourceToken;
  entries: SourceEntry[];
}

export type SourceValue = ScalarNode | BlockNode;
export type SourceEntry = ScalarNode | AssignmentNode | BlockNode;

export interface SourceDocument extends DecodedSource {
  path: string;
  tokens: SourceToken[];
  lineIndex: SourceLineIndex;
  root: BlockNode;
  diagnostics: Diagnostic[];
  sourceRevision: string;
}

function scalarValue(token: SourceToken): string {
  if (token.kind !== 'string') return token.text;
  return token.text.slice(1, -1).replace(/\\(["\\])/gu, '$1');
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: SourceToken[],
    private readonly text: string,
    private readonly sourcePath: string,
    private readonly lineIndex: SourceLineIndex,
    private readonly diagnostics: SourceDiagnosticCollector,
  ) {}

  parseRoot(): BlockNode {
    const root = this.parseBlock(undefined, 0);
    root.start = 0;
    root.end = this.text.length;
    return root;
  }

  private nextSignificant(): SourceToken | undefined {
    while (this.index < this.tokens.length && isTrivia(this.tokens[this.index]!)) this.index += 1;
    return this.tokens[this.index];
  }

  private peekSignificant(after = 0): SourceToken | undefined {
    let cursor = this.index;
    let found = 0;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (!isTrivia(token)) {
        if (found === after) return token;
        found += 1;
      }
      cursor += 1;
    }
    return undefined;
  }

  private consumeSignificant(): SourceToken | undefined {
    const token = this.nextSignificant();
    if (token !== undefined) this.index += 1;
    return token;
  }

  private parseBlock(open: SourceToken | undefined, depth: number): BlockNode {
    if (open !== undefined && depth > SOURCE_MAX_NESTING) {
      return this.parseOverLimitBlock(open);
    }
    const entries: SourceEntry[] = [];
    let close: SourceToken | undefined;
    while (this.nextSignificant() !== undefined) {
      const token = this.peekSignificant();
      if (token?.kind === 'right_brace') {
        close = this.consumeSignificant();
        if (open === undefined) {
          this.diagnostics.add(() => ({
            code: 'SOURCE_UNEXPECTED_RIGHT_BRACE',
            severity: 'error',
            category: 'syntax',
            message: 'Unexpected closing brace',
            location: this.location(token),
          }));
          continue;
        }
        break;
      }
      const entry = this.parseEntry(depth);
      if (entry !== undefined) entries.push(entry);
    }
    if (open !== undefined && close === undefined) {
      this.diagnostics.add(() => ({
        code: 'SOURCE_UNCLOSED_BLOCK',
        severity: 'error',
        category: 'syntax',
        message: 'Block is missing a closing brace',
        location: this.location(open),
      }));
    }
    return {
      type: 'block',
      ...(open === undefined ? {} : { open }),
      ...(close === undefined ? {} : { close }),
      entries,
      start: open?.start ?? 0,
      end: close?.end ?? this.text.length,
    };
  }

  private parseOverLimitBlock(open: SourceToken): BlockNode {
    this.diagnostics.add(() => ({
      code: 'SOURCE_NESTING_LIMIT',
      severity: 'blocker',
      category: 'syntax',
      message: `Clausewitz block nesting exceeds the supported limit of ${SOURCE_MAX_NESTING}`,
      location: this.location(open),
      details: { limit: SOURCE_MAX_NESTING },
    }));
    let nesting = 1;
    let close: SourceToken | undefined;
    while (this.nextSignificant() !== undefined) {
      const token = this.consumeSignificant()!;
      if (token.kind === 'left_brace') nesting += 1;
      else if (token.kind === 'right_brace') {
        nesting -= 1;
        if (nesting === 0) {
          close = token;
          break;
        }
      }
    }
    if (close === undefined) {
      this.diagnostics.add(() => ({
        code: 'SOURCE_UNCLOSED_BLOCK',
        severity: 'error',
        category: 'syntax',
        message: 'Block is missing a closing brace',
        location: this.location(open),
      }));
    }
    return {
      type: 'block',
      open,
      ...(close === undefined ? {} : { close }),
      entries: [],
      start: open.start,
      end: close?.end ?? this.text.length,
    };
  }

  private parseEntry(depth: number): SourceEntry | undefined {
    const token = this.consumeSignificant();
    if (token === undefined) return undefined;
    if (token.kind === 'left_brace') return this.parseBlock(token, depth + 1);
    if (token.kind !== 'atom' && token.kind !== 'string' && token.kind !== 'invalid') {
      this.diagnostics.add(() => ({
        code: 'SOURCE_UNEXPECTED_TOKEN',
        severity: 'error',
        category: 'syntax',
        message: `Unexpected token ${JSON.stringify(token.text)}`,
        location: this.location(token),
      }));
      return undefined;
    }
    const scalar: ScalarNode = {
      type: 'scalar',
      token,
      value: scalarValue(token),
      quoted: token.kind === 'string',
      start: token.start,
      end: token.end,
    };
    const operator = this.peekSignificant();
    if (operator?.kind !== 'operator') return scalar;
    this.consumeSignificant();
    const valueToken = this.consumeSignificant();
    if (valueToken === undefined) {
      this.diagnostics.add(() => ({
        code: 'SOURCE_MISSING_VALUE',
        severity: 'error',
        category: 'syntax',
        message: `Assignment ${scalar.value} is missing a value`,
        location: this.location(operator),
      }));
      return scalar;
    }
    let value: SourceValue;
    if (valueToken.kind === 'left_brace') {
      value = this.parseBlock(valueToken, depth + 1);
    } else if (
      valueToken.kind === 'atom' ||
      valueToken.kind === 'string' ||
      valueToken.kind === 'invalid'
    ) {
      value = {
        type: 'scalar',
        token: valueToken,
        value: scalarValue(valueToken),
        quoted: valueToken.kind === 'string',
        start: valueToken.start,
        end: valueToken.end,
      };
    } else {
      this.diagnostics.add(() => ({
        code: 'SOURCE_INVALID_VALUE',
        severity: 'error',
        category: 'syntax',
        message: `Invalid assignment value ${JSON.stringify(valueToken.text)}`,
        location: this.location(valueToken),
      }));
      value = {
        type: 'scalar',
        token: valueToken,
        value: valueToken.text,
        quoted: false,
        start: valueToken.start,
        end: valueToken.end,
      };
    }
    return {
      type: 'assignment',
      key: scalar,
      operator,
      value,
      start: scalar.start,
      end: value.end,
    };
  }

  private location(token: SourceToken): SourceLocation {
    return locationFor(this.sourcePath, this.lineIndex, token.start, token.end);
  }
}

export function parseClausewitz(bytes: Uint8Array, sourcePath: string): SourceDocument {
  const decoded = decodeSource(bytes);
  const diagnostics = new SourceDiagnosticCollector();
  if (bytes.byteLength > SOURCE_MAX_BYTES) {
    const lineIndex = Object.freeze({
      text: decoded.text,
      lineStarts: Object.freeze([0]),
    });
    diagnostics.add(() => ({
      code: 'SOURCE_FILE_SIZE_LIMIT',
      severity: 'blocker',
      category: 'syntax',
      message: `Clausewitz source exceeds the supported ${SOURCE_MAX_BYTES}-byte parsing limit`,
      location: {
        path: sourcePath,
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 1, offset: 0 },
      },
      details: { limit: SOURCE_MAX_BYTES },
    }));
    const parser = new Parser([], decoded.text, sourcePath, lineIndex, diagnostics);
    return {
      ...decoded,
      path: sourcePath,
      tokens: [],
      lineIndex,
      root: parser.parseRoot(),
      diagnostics: [...diagnostics.diagnostics],
      sourceRevision: sha256Bytes(decoded.bytes),
    };
  }
  const lineIndex = createSourceLineIndex(decoded.text);
  if (lineIndex.lineLimitExceededAt !== undefined) {
    diagnostics.add(() => ({
      code: 'SOURCE_LINE_LIMIT',
      severity: 'blocker',
      category: 'syntax',
      message: `Clausewitz source line count exceeds the supported limit of ${SOURCE_LINE_LIMIT}`,
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
    const parser = new Parser([], decoded.text, sourcePath, lineIndex, diagnostics);
    return {
      ...decoded,
      path: sourcePath,
      tokens: [],
      lineIndex,
      root: parser.parseRoot(),
      diagnostics: [...diagnostics.diagnostics],
      sourceRevision: sha256Bytes(decoded.bytes),
    };
  }
  const lexed = lexClausewitz(decoded.text, sourcePath, { lineIndex, diagnostics });
  const parser = new Parser(lexed.tokens, decoded.text, sourcePath, lineIndex, diagnostics);
  const root = parser.parseRoot();
  return {
    ...decoded,
    path: sourcePath,
    tokens: lexed.tokens,
    lineIndex,
    root,
    diagnostics: [...diagnostics.diagnostics],
    sourceRevision: sha256Bytes(decoded.bytes),
  };
}

export function serializeUnchanged(document: SourceDocument): Buffer {
  return Buffer.from(document.bytes);
}

export function assertRewriteSafe(document: SourceDocument): void {
  if (hasBlockingDiagnostics(document.diagnostics)) {
    throw new ServiceError(
      'SOURCE_UNSAFE_REWRITE',
      'Source contains syntax errors and cannot be rewritten safely',
      {
        path: document.path,
        diagnosticCodes: document.diagnostics.map(({ code }) => code),
      },
    );
  }
}

export function encodeDocumentText(document: SourceDocument, text: string): Buffer {
  return encodeSource(text, document.encoding);
}

export function assignments(block: BlockNode, key?: string): AssignmentNode[] {
  return block.entries.filter(
    (entry): entry is AssignmentNode =>
      entry.type === 'assignment' && (key === undefined || entry.key.value === key),
  );
}

export function childBlocks(block: BlockNode, key: string): BlockNode[] {
  return assignments(block, key)
    .map(({ value }) => value)
    .filter((value): value is BlockNode => value.type === 'block');
}

export function firstScalar(block: BlockNode, key: string): ScalarNode | undefined {
  const value = assignments(block, key)[0]?.value;
  return value?.type === 'scalar' ? value : undefined;
}

export function nodeLocation(
  document: SourceDocument,
  node: SourceRange,
  symbol?: string,
): SourceLocation {
  const location = locationFor(document.path, document.lineIndex, node.start, node.end);
  return symbol === undefined ? location : { ...location, symbol };
}
