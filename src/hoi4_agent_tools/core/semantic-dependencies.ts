import { canonicalJson, compareCodeUnits, hashCanonical } from './canonical.js';
import type { ScanSnapshot } from './engine.js';
import type { ReferenceRecord, SymbolKind, SymbolRecord } from './index.js';
import { ReverseSourceDependencies } from './index-segments.js';
import type { ScannedFile } from './scanner.js';
import { PACKAGE_VERSION } from '../version.js';

const MAX_PROOF_BYTES = 32 * 1024 * 1024;
const MAX_FRAGMENT_PROOFS = 10_000;
const MAX_SCOPE_PROOFS = 32;

/** Source identity includes provenance and interpretation, not just identical source bytes. */
export function semanticSourceIdentity(file: ScannedFile): string {
  return hashCanonical({
    version: 'semantic-source.v1',
    toolVersion: PACKAGE_VERSION,
    absolutePath: file.absolutePath,
    path: file.displayPath,
    relativePath: file.relativePath,
    rootKind: file.rootKind,
    loadOrder: file.loadOrder,
    shadowedBy: file.shadowedBy ?? null,
    hash: file.sha256,
  });
}

interface CatalogRead {
  name: string;
  kind: SymbolKind;
  id: string | null;
}
interface CatalogBinding {
  kind: SymbolKind;
  values: ReadonlyMap<string, unknown> | ReadonlySet<string>;
}
function valueIdentity(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(valueIdentity);
  if (value instanceof Map)
    return [...(value as ReadonlyMap<unknown, unknown>)].map(([key, child]) => [
      valueIdentity(key),
      valueIdentity(child),
    ]);
  return value ?? null;
}

/** Observe actual typed catalog lookups, including unsuccessful lookups for later additions. */
export class SemanticCatalog {
  private readonly bindings = new Map<string, CatalogBinding>();
  private reads: Map<string, CatalogRead> | undefined;

  bind<T extends ReadonlyMap<string, unknown> | ReadonlySet<string>>(
    name: string,
    kind: SymbolKind,
    values: T,
  ): T {
    if (this.bindings.has(name)) throw new Error('Semantic catalog binding names must be unique');
    this.bindings.set(name, { kind, values });
    const record = (id: string | null) =>
      this.reads?.set(canonicalJson([name, id]), { name, kind, id });
    return new Proxy(values, {
      get(target, property) {
        if (property === 'get' || property === 'has')
          return (id: string) => {
            record(id);
            return property === 'get'
              ? (target as ReadonlyMap<string, unknown>).get(id)
              : target.has(id);
          };
        if (property === 'size') {
          record(null);
          return target.size;
        }
        if (['set', 'add', 'delete', 'clear'].includes(String(property)))
          return () => {
            throw new Error('Semantic catalogs are read-only');
          };
        if (
          property === Symbol.iterator ||
          ['entries', 'keys', 'values', 'forEach'].includes(String(property))
        ) {
          record(null);
          const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return method.bind(target);
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });
  }

  collect<T>(analyze: () => T): { value: T; reads: CatalogRead[]; signature: string } {
    const previous = this.reads;
    this.reads = new Map();
    try {
      const value = analyze();
      const reads = [...this.reads.entries()]
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([, read]) => read);
      return { value, reads, signature: this.signature(reads) };
    } finally {
      this.reads = previous;
    }
  }

  signature(reads: readonly CatalogRead[]): string {
    return hashCanonical(
      reads.map(({ name, kind, id }) => {
        const binding = this.bindings.get(name);
        if (binding?.kind !== kind) return [name, kind, id, 'missing-binding'];
        const values = binding.values;
        return [
          name,
          kind,
          id,
          id === null
            ? valueIdentity(values)
            : [values.has(id), values instanceof Map ? valueIdentity(values.get(id)) : null],
        ];
      }),
    );
  }
}

interface FragmentProof {
  scope: string;
  path: string;
  reads: CatalogRead[];
  signature: string;
  key: string;
  environment: boolean;
  dependencyRevision: string;
}
interface ScopeProof {
  baselineRevision: string;
  files: Map<string, string>;
  invalidations: Map<string, string>;
  symbols: Array<Pick<SymbolRecord, 'kind' | 'id' | 'path'>>;
  bytes: number;
}
class DependencyProofs {
  readonly entries = new Map<string, { proof: FragmentProof; bytes: number }>();
  readonly scopes = new Map<string, ScopeProof>();
  private entryBytes = 0;
  private scopeBytes = 0;
  put(key: string, proof: FragmentProof): void {
    const bytes = canonicalJson(proof).length * 2 + key.length * 2 + 128;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.entryBytes -= previous.bytes;
    }
    if (bytes > MAX_PROOF_BYTES) return;
    this.entries.set(key, { proof, bytes });
    this.entryBytes += bytes;
    while (this.entries.size > MAX_FRAGMENT_PROOFS || this.entryBytes > MAX_PROOF_BYTES) {
      const [oldest, entry] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.entryBytes -= entry.bytes;
    }
  }
  remember(scope: string, proof: ScopeProof): void {
    const previous = this.scopes.get(scope);
    if (previous !== undefined) {
      this.scopes.delete(scope);
      this.scopeBytes -= previous.bytes;
    }
    if (proof.bytes > MAX_PROOF_BYTES) return;
    this.scopes.set(scope, proof);
    this.scopeBytes += proof.bytes;
    while (this.scopes.size > MAX_SCOPE_PROOFS || this.scopeBytes > MAX_PROOF_BYTES) {
      const [oldest, entry] = this.scopes.entries().next().value!;
      this.scopes.delete(oldest);
      this.scopeBytes -= entry.bytes;
    }
  }
}
const proofsByCache = new WeakMap<object, DependencyProofs>();
export function clearSemanticDependencies(cache: object): void {
  proofsByCache.delete(cache);
}

interface FragmentCache<T> {
  get(key: string): T | undefined;
  set(key: string, fragment: T, sourceBytes: number): void;
}
export interface SemanticAnalysisSession {
  baselineRevision: string;
  scope: string;
  proofs: DependencyProofs;
  affectedFiles: ReadonlySet<string>;
  complete: boolean;
  invalidations: ReadonlyMap<string, string>;
}

/** Reconcile both old and new typed definitions so removal, overlay and rename edges survive. */
export function beginSemanticAnalysis(
  cache: object | undefined,
  snapshot: ScanSnapshot,
  domain: string,
  workspaceIdentity?: string,
): SemanticAnalysisSession {
  const scope = hashCanonical({
    domain,
    workspaceId: snapshot.workspaceId,
    workspaceIdentity: workspaceIdentity ?? null,
    roots: [
      ...new Set(
        snapshot.files.map(({ absolutePath, relativePath }) =>
          absolutePath.slice(0, -relativePath.length),
        ),
      ),
    ].sort(compareCodeUnits),
  });
  let proofs = cache === undefined ? undefined : proofsByCache.get(cache);
  if (proofs === undefined) {
    proofs = new DependencyProofs();
    if (cache !== undefined) proofsByCache.set(cache, proofs);
  }
  const files = new Map(
    snapshot.files.map((file) => [file.displayPath, semanticSourceIdentity(file)]),
  );
  const symbols = snapshot.index.symbols.map(({ kind, id, path }) => ({ kind, id, path }));
  const previous = proofs.scopes.get(scope);
  const baselineRevision = previous?.baselineRevision ?? snapshot.revision;
  const invalidations = new Map(
    [...(previous?.invalidations ?? [])].filter(([path]) => files.has(path)),
  );
  let affectedFiles: ReadonlySet<string> = new Set();
  if (previous !== undefined) {
    const changed = [...new Set([...previous.files.keys(), ...files.keys()])].filter(
      (path) => previous.files.get(path) !== files.get(path),
    );
    if (changed.length > 0) {
      const references: Array<Pick<ReferenceRecord, 'path' | 'toKind' | 'to'>> = [
        ...snapshot.index.references,
      ];
      for (const { proof } of proofs.entries.values())
        if (proof.scope === scope)
          for (const { kind, id } of proof.reads)
            if (id !== null) references.push({ path: proof.path, toKind: kind, to: id });
      affectedFiles = new Set(
        new ReverseSourceDependencies([...previous.symbols, ...symbols], references).affectedFiles(
          changed,
        ),
      );
      for (const path of affectedFiles)
        if (files.has(path)) invalidations.set(path, snapshot.revision);
    }
  }
  const bytes =
    [...files].reduce(
      (total, [path, address]) => total + 128 + (path.length + address.length) * 2,
      0,
    ) +
    symbols.reduce(
      (total, { kind, id, path }) => total + 128 + (kind.length + id.length + path.length) * 2,
      0,
    ) +
    [...invalidations].reduce(
      (total, [path, revision]) => total + 128 + (path.length + revision.length) * 2,
      0,
    );
  proofs.remember(scope, { files, symbols, invalidations, bytes, baselineRevision });
  return {
    scope,
    proofs,
    affectedFiles,
    complete: snapshot.complete,
    invalidations,
    baselineRevision,
  };
}

export function semanticFragment<T>(
  session: SemanticAnalysisSession,
  cache: FragmentCache<T> | undefined,
  file: ScannedFile,
  legacyKey: string,
  catalog: SemanticCatalog,
  analyze: () => T,
): T {
  if (cache === undefined) return analyze();
  const address = `${session.scope}:${semanticSourceIdentity(file)}`;
  const previous = session.proofs.entries.get(address)?.proof;
  const dependencyRevision =
    session.invalidations.get(file.displayPath) ?? session.baselineRevision;
  if (!session.affectedFiles.has(file.displayPath)) {
    if (
      previous?.environment === session.complete &&
      previous.dependencyRevision === dependencyRevision &&
      previous.signature === catalog.signature(previous.reads)
    ) {
      const value = cache.get(previous.key);
      if (value !== undefined) return value;
    } else if (previous === undefined) {
      // Preserve custom graph-builder cache adapters; internally produced entries use exact read proofs.
      const value = cache.get(legacyKey);
      if (value !== undefined) return value;
    }
  }
  const { value, reads, signature } = catalog.collect(analyze);
  const key = hashCanonical({
    version: 'semantic-fragment.v1',
    address,
    signature,
    complete: session.complete,
    dependencyRevision,
  });
  cache.set(key, value, file.bytes.length);
  session.proofs.put(address, {
    scope: session.scope,
    path: file.displayPath,
    reads,
    signature,
    key,
    environment: session.complete,
    dependencyRevision,
  });
  return value;
}
