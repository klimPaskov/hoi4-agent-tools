import { canonicalJson, compareCodeUnits, hashCanonical } from './canonical.js';
import type { Diagnostic } from './diagnostics.js';
import type { ReferenceRecord, SymbolKind, SymbolRecord } from './index.js';
import type { ScannedFile } from './scanner.js';
import { PACKAGE_VERSION } from '../version.js';

/** File-local facts before active-definition selection or cross-file diagnostics. */
export interface FileIndexSegment {
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
  diagnostics: Diagnostic[];
  complete: boolean;
}

export interface IndexSegmentStatistics {
  hits: number;
  misses: number;
  evictions: number;
  oversized: number;
  retainedBytes: number;
  retainedSegments: number;
}

export function indexSegmentAddress(file: ScannedFile, isProvinceDefinition: boolean): string {
  return hashCanonical({
    version: 'file-index-segment.v1',
    toolVersion: PACKAGE_VERSION,
    sourceHash: file.sha256,
    path: file.displayPath,
    relativePath: file.relativePath,
    rootKind: file.rootKind,
    loadOrder: file.loadOrder,
    shadowedBy: file.shadowedBy ?? null,
    isProvinceDefinition,
  });
}

/** Encoded entries keep the aggregate index's mutable records out of the shared cache. */
export class IndexSegmentCache {
  readonly #entries = new Map<string, { encoded: string; bytes: number }>();
  #retainedBytes = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #oversized = 0;

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('Index segment cache size must be a non-negative integer');
  }

  get(address: string): FileIndexSegment | undefined {
    const entry = this.#entries.get(address);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    this.#entries.delete(address);
    this.#entries.set(address, entry);
    return JSON.parse(entry.encoded) as FileIndexSegment;
  }

  /** Import one authenticated canonical entry without counting it as a process-local hit. */
  importEncoded(address: string, encoded: string): void {
    const segment = JSON.parse(encoded) as unknown;
    if (
      typeof segment !== 'object' ||
      segment === null ||
      !('symbols' in segment) ||
      !Array.isArray(segment.symbols) ||
      !('references' in segment) ||
      !Array.isArray(segment.references) ||
      !('diagnostics' in segment) ||
      !Array.isArray(segment.diagnostics) ||
      !('complete' in segment) ||
      typeof segment.complete !== 'boolean'
    )
      throw new Error('Persistent index segment is structurally invalid');
    this.put(address, segment as FileIndexSegment);
  }

  exportEncoded(address: string): string | undefined {
    return this.#entries.get(address)?.encoded;
  }

  put(address: string, segment: FileIndexSegment): void {
    const encoded = canonicalJson(segment);
    // Account for the UTF-16 string retained by V8, including conservative key overhead.
    const bytes = encoded.length * 2 + address.length * 2 + 128;
    if (bytes > this.maxBytes) {
      this.#oversized += 1;
      return;
    }
    const previous = this.#entries.get(address);
    if (previous !== undefined) {
      if (previous.encoded !== encoded)
        throw new Error('An immutable index segment address produced different file-local facts');
      this.#entries.delete(address);
      this.#entries.set(address, previous);
      return;
    }
    while (this.#retainedBytes + bytes > this.maxBytes) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#retainedBytes -= oldest[1].bytes;
      this.#evictions += 1;
    }
    this.#entries.set(address, { encoded, bytes });
    this.#retainedBytes += bytes;
  }

  clear(): void {
    this.#entries.clear();
    this.#retainedBytes = 0;
  }

  statistics(): IndexSegmentStatistics {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      oversized: this.#oversized,
      retainedBytes: this.#retainedBytes,
      retainedSegments: this.#entries.size,
    };
  }
}

/** Reverse edges are derived from typed source references, never matching arbitrary strings. */
export class ReverseSourceDependencies {
  readonly #consumers = new Map<string, Set<string>>();
  readonly #definitions = new Map<string, Set<string>>();

  constructor(
    symbols: readonly Pick<SymbolRecord, 'kind' | 'id' | 'path'>[],
    references: readonly Pick<ReferenceRecord, 'toKind' | 'to' | 'path'>[],
  ) {
    for (const symbol of symbols) {
      const definitions = this.#definitions.get(symbol.path) ?? new Set<string>();
      definitions.add(`${symbol.kind}:${symbol.id}`);
      this.#definitions.set(symbol.path, definitions);
    }
    for (const reference of references) {
      const key = `${reference.toKind}:${reference.to}`;
      const consumers = this.#consumers.get(key) ?? new Set<string>();
      consumers.add(reference.path);
      this.#consumers.set(key, consumers);
    }
  }

  affectedFiles(changedFiles: readonly string[]): string[] {
    const affected = new Set(changedFiles);
    const queue = [...affected];
    for (const source of queue) {
      for (const definition of this.#definitions.get(source) ?? []) {
        for (const consumer of this.#consumers.get(definition) ?? []) {
          if (affected.has(consumer)) continue;
          affected.add(consumer);
          queue.push(consumer);
        }
      }
    }
    return [...affected].sort(compareCodeUnits);
  }

  consumers(kind: SymbolKind, id: string): string[] {
    return [...(this.#consumers.get(`${kind}:${id}`) ?? [])].sort(compareCodeUnits);
  }
}
