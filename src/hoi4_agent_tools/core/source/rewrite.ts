import { ServiceError } from '../result.js';
import {
  assertRewriteSafe,
  encodeDocumentText,
  type SourceDocument,
  type SourceRange,
} from './parser.js';

export interface SourceReplacement {
  start: number;
  end: number;
  text: string;
  description: string;
}

export function replacementFor(
  node: SourceRange,
  text: string,
  description: string,
): SourceReplacement {
  return { start: node.start, end: node.end, text, description };
}

export function applyReplacements(
  document: SourceDocument,
  replacements: readonly SourceReplacement[],
): Buffer {
  if (replacements.length === 0) return Buffer.from(document.bytes);
  assertRewriteSafe(document);
  const ordered = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  const pieces: string[] = [];
  for (const replacement of ordered) {
    if (
      replacement.start < cursor ||
      replacement.start < 0 ||
      replacement.end < replacement.start ||
      replacement.end > document.text.length
    ) {
      throw new ServiceError(
        'SOURCE_REPLACEMENT_OVERLAP',
        'Replacement ranges overlap or are invalid',
        {
          replacement,
        },
      );
    }
    pieces.push(document.text.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  pieces.push(document.text.slice(cursor));
  return encodeDocumentText(document, pieces.join(''));
}
