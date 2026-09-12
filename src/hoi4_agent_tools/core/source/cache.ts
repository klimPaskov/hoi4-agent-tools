import { deserialize, serialize } from 'node:v8';
import { sha256Bytes } from '../canonical.js';
import type { SourceDocument } from './parser.js';

export function sourceDocumentCacheKey(bytes: Uint8Array, sourcePath: string): string {
  return `${sha256Bytes(bytes)}:${sourcePath}`;
}

function decodedDocument(
  encoded: Uint8Array,
  expected?: { bytes: Uint8Array; sourcePath: string },
): SourceDocument {
  const value = deserialize(encoded) as unknown;
  if (
    value === null ||
    typeof value !== 'object' ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    !('sourceRevision' in value) ||
    typeof value.sourceRevision !== 'string' ||
    !('tokens' in value) ||
    !Array.isArray(value.tokens) ||
    !('diagnostics' in value) ||
    !Array.isArray(value.diagnostics) ||
    !('root' in value) ||
    value.root === undefined ||
    !('bytes' in value) ||
    !(value.bytes instanceof Uint8Array)
  )
    throw new Error('Persistent source document is structurally invalid');
  if (
    expected !== undefined &&
    (value.path !== expected.sourcePath ||
      value.sourceRevision !== sha256Bytes(expected.bytes) ||
      !Buffer.from(value.bytes).equals(Buffer.from(expected.bytes)))
  )
    throw new Error('Persistent source document does not match its source identity');
  return value as SourceDocument;
}

/** Process-local parsed facts; serialized entries cannot be mutated by their consumers. */
export class SourceDocumentCache {
  readonly #entries = new Map<string, Buffer>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('Source cache size must be a non-negative integer');
  }

  get(key: string): SourceDocument | undefined {
    const encoded = this.#entries.get(key);
    if (encoded === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    this.#entries.delete(key);
    this.#entries.set(key, encoded);
    return decodedDocument(encoded);
  }

  put(key: string, document: SourceDocument): void {
    // Avoid allocating a large serialized copy just to discover that it cannot
    // be retained. This conservative estimate affects caching, never parsing.
    const estimatedBytes =
      document.bytes.length * 12 + document.tokens.length * 512 + key.length * 2 + 128;
    if (this.maxBytes === 0 || estimatedBytes > this.maxBytes) return;
    const encoded = serialize(document);
    this.retain(key, encoded);
  }

  /** Import one authenticated same-runtime entry without counting it as a process-local hit. */
  importEncoded(
    key: string,
    encoded: Uint8Array,
    expected: { bytes: Uint8Array; sourcePath: string },
  ): void {
    decodedDocument(encoded, expected);
    this.retain(key, Buffer.from(encoded));
  }

  exportEncoded(key: string): Buffer | undefined {
    const encoded = this.#entries.get(key);
    return encoded === undefined ? undefined : Buffer.from(encoded);
  }

  private retain(key: string, encoded: Buffer): void {
    const size = encoded.length + key.length * 2 + 128;
    if (size > this.maxBytes) return;
    const previous = this.#entries.get(key);
    if (previous !== undefined) this.#bytes -= previous.length + key.length * 2 + 128;
    this.#entries.delete(key);
    while (this.#bytes + size > this.maxBytes) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].length + oldest[0].length * 2 + 128;
      this.#evictions += 1;
    }
    this.#entries.set(key, encoded);
    this.#bytes += size;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  statistics(): {
    hits: number;
    misses: number;
    evictions: number;
    retainedBytes: number;
    retainedDocuments: number;
  } {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      retainedBytes: this.#bytes,
      retainedDocuments: this.#entries.size,
    };
  }
}

// All domains call the same parser; cache keys include both bytes and source location.
// Authorization remains in workspace reads, before any document reaches this cache.
export const sourceDocuments = new SourceDocumentCache();
