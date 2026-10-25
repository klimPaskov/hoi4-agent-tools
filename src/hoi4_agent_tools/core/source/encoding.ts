import iconv from 'iconv-lite';
import { ServiceError } from '../result.js';

export type SourceEncoding = 'utf8' | 'utf8-bom' | 'windows-1252';

/**
 * Bytes of a Windows-1252 fallback file that cannot be told apart or reproduced after decoding.
 * Windows-1252 leaves 0x81, 0x8D, 0x8F, 0x90 and 0x9D undefined. iconv-lite decodes all five to
 * U+FFFD and encodes U+FFFD back as 0x9D, so rewriting such a file would silently turn 0x81, 0x8D,
 * 0x8F and 0x90 into 0x9D.
 */
export interface SourceEncodingLoss {
  /** Number of such bytes in the file. */
  count: number;
  /** Offset in the file (equal to the offset in the decoded text) of the first such byte. */
  firstOffset: number;
  /** Distinct offending byte values in ascending order. */
  byteValues: number[];
}

export interface DecodedSource {
  encoding: SourceEncoding;
  text: string;
  bytes: Buffer;
  newline: '\n' | '\r\n' | '\r';
  /** Present only when decoding is lossy, so re-encoding cannot reproduce the original bytes. */
  encodingLoss?: SourceEncodingLoss;
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

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

let windows1252RoundTrip: boolean[] | undefined;

function windows1252Table(): boolean[] {
  windows1252RoundTrip ??= Array.from({ length: 256 }, (_, value) => {
    const original = Buffer.from([value]);
    const decoded = iconv.decode(original, 'windows-1252');
    return (
      decoded !== REPLACEMENT_CHARACTER && iconv.encode(decoded, 'windows-1252').equals(original)
    );
  });
  return windows1252RoundTrip;
}

function findWindows1252Loss(bytes: Buffer): SourceEncodingLoss | undefined {
  const table = windows1252Table();
  let count = 0;
  let firstOffset = -1;
  const seen = new Set<number>();
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const value = bytes[offset]!;
    if (table[value]) continue;
    if (firstOffset < 0) firstOffset = offset;
    count += 1;
    seen.add(value);
  }
  if (count === 0) return undefined;
  return { count, firstOffset, byteValues: [...seen].sort((left, right) => left - right) };
}

/**
 * Refuses a mutation of a decoded source that cannot be re-encoded to its original bytes.
 * Reads of such a source continue to work; only writes are blocked.
 */
export function assertSourceEncodingPreserved(decoded: DecodedSource, sourcePath: string): void {
  const loss = decoded.encodingLoss;
  if (loss === undefined) return;
  const values = loss.byteValues.map((value) => `0x${value.toString(16).toUpperCase()}`);
  throw new ServiceError(
    'SOURCE_ENCODING_NOT_ROUND_TRIPPABLE',
    `Source is not valid UTF-8 and contains ${loss.count} byte(s) (${values.join(', ')}) that Windows-1252 cannot represent; editing it would silently rewrite them. Convert the file to UTF-8 or replace those bytes, then retry`,
    {
      path: sourcePath,
      encoding: decoded.encoding,
      byteCount: loss.count,
      byteValues: values,
      firstByteOffset: loss.firstOffset,
    },
  );
}

export function decodeSource(input: Uint8Array): DecodedSource {
  const bytes = Buffer.from(input);
  let encoding: SourceEncoding;
  let text: string;
  let encodingLoss: SourceEncodingLoss | undefined;
  if (bytes.subarray(0, 3).equals(utf8Bom)) {
    encoding = 'utf8-bom';
    text = bytes.subarray(3).toString('utf8');
  } else if (isUtf8(bytes)) {
    encoding = 'utf8';
    text = bytes.toString('utf8');
  } else {
    encoding = 'windows-1252';
    text = iconv.decode(bytes, 'windows-1252');
    encodingLoss = findWindows1252Loss(bytes);
  }
  return {
    encoding,
    text,
    bytes,
    newline: detectNewline(text),
    ...(encodingLoss === undefined ? {} : { encodingLoss }),
  };
}

export function encodeSource(text: string, encoding: SourceEncoding): Buffer {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf8-bom') return Buffer.concat([utf8Bom, Buffer.from(text, 'utf8')]);
  // U+FFFD is what undefined Windows-1252 bytes decode to; iconv-lite would write it back as 0x9D.
  const encoded = iconv.encode(text, 'windows-1252');
  if (text.includes(REPLACEMENT_CHARACTER) || iconv.decode(encoded, 'windows-1252') !== text) {
    throw new ServiceError(
      'SOURCE_ENCODING_UNREPRESENTABLE',
      'The edit introduces characters that cannot be represented in the source encoding',
      { encoding },
    );
  }
  return encoded;
}
