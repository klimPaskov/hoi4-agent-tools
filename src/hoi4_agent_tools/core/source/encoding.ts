import iconv from 'iconv-lite';
import { ServiceError } from '../result.js';

export type SourceEncoding = 'utf8' | 'utf8-bom' | 'windows-1252';

export interface DecodedSource {
  encoding: SourceEncoding;
  text: string;
  bytes: Buffer;
  newline: '\n' | '\r\n' | '\r';
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

function detectNewline(text: string): '\n' | '\r\n' | '\r' {
  const crlf = text.indexOf('\r\n');
  const lf = text.indexOf('\n');
  const cr = text.indexOf('\r');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return '\r\n';
  if (lf >= 0) return '\n';
  if (cr >= 0) return '\r';
  return '\n';
}

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function decodeSource(input: Uint8Array): DecodedSource {
  const bytes = Buffer.from(input);
  let encoding: SourceEncoding;
  let text: string;
  if (bytes.subarray(0, 3).equals(utf8Bom)) {
    encoding = 'utf8-bom';
    text = bytes.subarray(3).toString('utf8');
  } else if (isUtf8(bytes)) {
    encoding = 'utf8';
    text = bytes.toString('utf8');
  } else {
    encoding = 'windows-1252';
    text = iconv.decode(bytes, 'windows-1252');
  }
  return { encoding, text, bytes, newline: detectNewline(text) };
}

export function encodeSource(text: string, encoding: SourceEncoding): Buffer {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf8-bom') return Buffer.concat([utf8Bom, Buffer.from(text, 'utf8')]);
  const encoded = iconv.encode(text, 'windows-1252');
  if (iconv.decode(encoded, 'windows-1252') !== text) {
    throw new ServiceError(
      'SOURCE_ENCODING_UNREPRESENTABLE',
      'The edit introduces characters that cannot be represented in the source encoding',
      { encoding },
    );
  }
  return encoded;
}
