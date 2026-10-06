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

/** Puts between halvings of every entry's hit count, so entries no longer read become evictable. */
const HIT_AGING_INTERVAL = 4096;
/** Keys of documents turned away from a full cache, remembered so a repeat can be admitted. */
const DOORKEEPER_KEYS = 16_384;

interface Entry {
  encoded: Buffer;
  hits: number;
}

/**
 * Process-local parsed facts; serialized entries cannot be mutated by their consumers.
 *
 * A workspace scan often parses more source than the cache holds. Plain LRU then evicts
 * every document before its next use and pays serialization for nothing. A full cache
 * therefore turns a document away the first time, remembering only its key, and admits it
 * on a later miss by displacing entries that were never read; a rejected document is not
 * serialized. Repeated scans keep what fits and hit it. Hit counts age, so documents that
 * stop being read become evictable again.
 */
export class SourceDocumentCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  /** Bytes held by entries without hits, which a new document may displace. */
  #coldBytes = 0;
  #puts = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #rejections = 0;
  readonly #doorkeeper = new Set<string>();

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('Source cache size must be a non-negative integer');
  }

  get(key: string): SourceDocument | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    if (entry.hits === 0) this.#coldBytes -= entrySize(key, entry.encoded);
    entry.hits += 1;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return decodedDocument(entry.encoded);
  }

  /** Availability check without deserialization or cache-hit accounting. */
  has(key: string): boolean {
    return this.#entries.has(key);
  }

  put(key: string, document: SourceDocument): void {
    // Avoid allocating a large serialized copy just to discover that it cannot
    // be retained. This conservative estimate affects caching, never parsing.
    const estimatedBytes =
      document.bytes.length * 12 + document.tokens.length * 512 + key.length * 2 + 128;
    if (this.maxBytes === 0 || estimatedBytes > this.maxBytes) return;
    this.#age();
    const previous = this.#entries.get(key);
    const reusable = previous === undefined ? 0 : entrySize(key, previous.encoded);
    const free = this.maxBytes - this.#bytes + reusable;
    if (estimatedBytes > free) {
      // Only a document missed before may displace entries, and only entries never read.
      if (!this.#doorkeeper.delete(key) || estimatedBytes > free + this.#coldBytes) {
        this.#remember(key);
        this.#rejections += 1;
        return;
      }
    }
    this.retain(key, serialize(document));
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
    const entry = this.#entries.get(key);
    return entry === undefined ? undefined : Buffer.from(entry.encoded);
  }

  private retain(key: string, encoded: Buffer): void {
    const size = entrySize(key, encoded);
    if (size > this.maxBytes) return;
    this.#remove(key);
    // Displace the oldest entries that were never read again; read entries stay.
    for (const [oldKey, entry] of this.#entries) {
      if (this.#bytes + size <= this.maxBytes) break;
      if (entry.hits > 0) continue;
      this.#remove(oldKey);
      this.#evictions += 1;
    }
    if (this.#bytes + size > this.maxBytes) {
      this.#rejections += 1;
      return;
    }
    this.#entries.set(key, { encoded, hits: 0 });
    this.#bytes += size;
    this.#coldBytes += size;
  }

  #remember(key: string): void {
    this.#doorkeeper.delete(key);
    this.#doorkeeper.add(key);
    if (this.#doorkeeper.size > DOORKEEPER_KEYS)
      this.#doorkeeper.delete(this.#doorkeeper.values().next().value!);
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    const size = entrySize(key, entry.encoded);
    this.#entries.delete(key);
    this.#bytes -= size;
    if (entry.hits === 0) this.#coldBytes -= size;
  }

  #age(): void {
    this.#puts += 1;
    if (this.#puts % HIT_AGING_INTERVAL !== 0) return;
    for (const [key, entry] of this.#entries) {
      if (entry.hits === 0) continue;
      entry.hits = Math.floor(entry.hits / 2);
      if (entry.hits === 0) this.#coldBytes += entrySize(key, entry.encoded);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#doorkeeper.clear();
    this.#bytes = 0;
    this.#coldBytes = 0;
  }

  statistics(): {
    hits: number;
    misses: number;
    evictions: number;
    rejections: number;
    retainedBytes: number;
    retainedDocuments: number;
  } {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      rejections: this.#rejections,
      retainedBytes: this.#bytes,
      retainedDocuments: this.#entries.size,
    };
  }
}

function entrySize(key: string, encoded: Buffer): number {
  return encoded.length + key.length * 2 + 128;
}

// All domains call the same parser; cache keys include both bytes and source location.
// Authorization remains in workspace reads, before any document reaches this cache.
export const sourceDocuments = new SourceDocumentCache();
