import type { Diagnostic } from '../diagnostics.js';
import { createSourceLineIndex, locationFor, type SourceLineIndex } from './lexer.js';
import { decodeSource, type DecodedSource } from './encoding.js';
import { SourceDiagnosticCollector } from './limits.js';
import { SOURCE_ENTRY_LIMIT, SOURCE_LINE_LIMIT, SOURCE_MAX_BYTES } from './limits.js';

export interface LocalisationEntry {
  key: string;
  version?: number;
  value: string;
  language: string;
  start: number;
  end: number;
  line: number;
}

export interface LocalisationDocument extends DecodedSource {
  path: string;
  lineIndex: SourceLineIndex;
  entries: LocalisationEntry[];
  diagnostics: Diagnostic[];
}

const languagePattern = /^\s*(l_[a-z_]+):\s*(?:#.*)?$/u;
const entryPattern = /^\s*([A-Za-z0-9_.-]+):(?:(\d+)\s+|\s*)"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/u;

function decodeLocalisationValue(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== '\\' || index + 1 >= value.length) {
      result += character;
      continue;
    }
    const escaped = value[index + 1]!;
    if (escaped === 'n') result += '\n';
    else if (escaped === '"' || escaped === '\\') result += escaped;
    else {
      result += `\\${escaped}`;
    }
    index += 1;
  }
  return result;
}

export function parseLocalisation(bytes: Uint8Array, sourcePath: string): LocalisationDocument {
  const decoded = decodeSource(bytes);
  if (bytes.byteLength > SOURCE_MAX_BYTES) {
    return {
      ...decoded,
      path: sourcePath,
      lineIndex: Object.freeze({ text: decoded.text, lineStarts: Object.freeze([0]) }),
      entries: [],
      diagnostics: [
        {
          code: 'SOURCE_FILE_SIZE_LIMIT',
          severity: 'blocker',
          category: 'syntax',
          message: `Localisation source exceeds the supported ${SOURCE_MAX_BYTES}-byte parsing limit`,
          location: {
            path: sourcePath,
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
          },
          details: { limit: SOURCE_MAX_BYTES },
        },
      ],
    };
  }
  const lineIndex = createSourceLineIndex(decoded.text);
  const entries: LocalisationEntry[] = [];
  const diagnosticCollector = new SourceDiagnosticCollector();
  const diagnostics = diagnosticCollector.diagnostics;
  if (lineIndex.lineLimitExceededAt !== undefined) {
    diagnosticCollector.add(() => ({
      code: 'SOURCE_LINE_LIMIT',
      severity: 'blocker',
      category: 'syntax',
      message: `Localisation source line count exceeds the supported limit of ${SOURCE_LINE_LIMIT}`,
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
    return { ...decoded, path: sourcePath, lineIndex, entries, diagnostics };
  }
  if (decoded.encoding !== 'utf8-bom') {
    diagnosticCollector.add(() => ({
      code: 'LOCALISATION_BOM_MISSING',
      severity: 'error',
      category: 'syntax',
      message: 'HOI4 localisation files require UTF-8 with BOM encoding',
      location: locationFor(sourcePath, lineIndex, 0, Math.min(1, decoded.text.length)),
    }));
  }
  let language = '';
  let offset = 0;
  let lineNumber = 1;
  while (offset < decoded.text.length) {
    let lineEnd = offset;
    while (
      lineEnd < decoded.text.length &&
      decoded.text[lineEnd] !== '\r' &&
      decoded.text[lineEnd] !== '\n'
    ) {
      lineEnd += 1;
    }
    let nextOffset = lineEnd;
    if (decoded.text[nextOffset] === '\r') nextOffset += 1;
    if (decoded.text[nextOffset] === '\n') nextOffset += 1;
    else if (decoded.text[lineEnd] === '\n') nextOffset = lineEnd + 1;
    const line = decoded.text.slice(offset, lineEnd);
    const languageMatch = languagePattern.exec(line);
    if (languageMatch !== null) {
      language = languageMatch[1]!;
      offset = nextOffset;
      lineNumber += 1;
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) {
      offset = nextOffset;
      lineNumber += 1;
      continue;
    }
    const match = entryPattern.exec(line);
    if (match === null) {
      diagnosticCollector.add(() => ({
        code: 'LOCALISATION_MALFORMED_LINE',
        severity: 'error',
        category: 'syntax',
        message: 'Malformed localisation line',
        location: locationFor(sourcePath, lineIndex, offset, offset + line.length),
      }));
    } else if (language === '') {
      diagnosticCollector.add(() => ({
        code: 'LOCALISATION_LANGUAGE_MISSING',
        severity: 'error',
        category: 'syntax',
        message: 'Localisation entry appears before a language declaration',
        location: locationFor(sourcePath, lineIndex, offset, offset + line.length),
      }));
    } else {
      if (entries.length >= SOURCE_ENTRY_LIMIT) {
        diagnosticCollector.add(() => ({
          code: 'SOURCE_ENTRY_LIMIT',
          severity: 'blocker',
          category: 'syntax',
          message: `Localisation entries exceed the supported limit of ${SOURCE_ENTRY_LIMIT}`,
          location: locationFor(sourcePath, lineIndex, offset, offset + line.length),
          details: { limit: SOURCE_ENTRY_LIMIT },
        }));
        break;
      }
      entries.push({
        key: match[1]!,
        ...(match[2] === undefined ? {} : { version: Number(match[2]) }),
        value: decodeLocalisationValue(match[3]!),
        language,
        start: offset,
        end: offset + line.length,
        line: lineNumber,
      });
    }
    offset = nextOffset;
    lineNumber += 1;
  }
  return { ...decoded, path: sourcePath, lineIndex, entries, diagnostics };
}
