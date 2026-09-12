import { link, lstat, mkdir, open, opendir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { canonicalJson, hashCanonical, secureId, sha256Bytes } from './canonical.js';
import type { IndexSegmentCache } from './index-segments.js';
import { indexSegmentAddress } from './index-segments.js';
import type { ScannedFile } from './scanner.js';
import type { ServerState } from './server-state.js';
import { SharedRequestCapacity } from './shared-request-capacity.js';
import { sourceDocumentCacheKey, type SourceDocumentCache } from './source/cache.js';
import { containedGeneratedPath } from './workspace.js';
import { PACKAGE_VERSION } from '../version.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const entryKindSchema = z.enum(['source-document', 'index-segment']);
const unsignedEntrySchema = z
  .object({
    version: z.literal(1),
    kind: entryKindSchema,
    scopeHash: digestSchema,
    address: digestSchema,
    toolVersion: z.literal(PACKAGE_VERSION),
    runtime: z.string().min(1),
    payloadHash: digestSchema,
    payload: z.string(),
  })
  .strict();
const entrySchema = unsignedEntrySchema.extend({ authenticationTag: digestSchema }).strict();

type EntryKind = z.infer<typeof entryKindSchema>;
type UnsignedEntry = z.infer<typeof unsignedEntrySchema>;

export interface AnalysisCacheScope {
  workspaceIdentity: string;
  rootFingerprint: string;
  principal: string | null;
}

export interface PersistentAnalysisCacheStatistics {
  hits: number;
  misses: number;
  writes: number;
  retainedEntries: number;
  retainedBytes: number;
  evictions: number;
  invalidEntries: number;
  oversized: number;
}

interface RetainedEntry {
  file: string;
  bytes: number;
  modifiedMs: number;
}

const entryFilePattern = /^(?<address>[a-f0-9]{64})\.json$/u;

function sourceAddress(key: string): string {
  return hashCanonical({
    version: 'persistent-source-document.v1',
    toolVersion: PACKAGE_VERSION,
    runtime: `${process.versions.node}\0${process.versions.v8}`,
    key,
  });
}

function cacheScopeHash(scope: AnalysisCacheScope): string {
  return hashCanonical({ version: 'analysis-cache-scope.v1', ...scope });
}

async function assertUnlinked(candidate: string): Promise<void> {
  try {
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error('Persistent analysis cache cannot use symbolic links or junctions');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Internal same-version cache shared by authorized local processes.
 * Entries are immutable, authenticated, scope-separated, and never public artifacts.
 */
export class PersistentAnalysisCache {
  readonly #lock: SharedRequestCapacity;
  #hits = 0;
  #misses = 0;
  #writes = 0;
  #retainedEntries = 0;
  #retainedBytes = 0;
  #evictions = 0;
  #invalidEntries = 0;
  #oversized = 0;
  readonly #invalidAddresses = new Set<string>();

  private constructor(
    private readonly state: ServerState,
    private readonly root: string,
    private readonly maxBytes: number,
    private readonly maxEntries: number,
    private readonly maxSingleBytes: number,
  ) {
    this.#lock = new SharedRequestCapacity(root, 1);
  }

  static async create(
    state: ServerState,
    options: { maxBytes?: number; maxEntries?: number; maxSingleBytes?: number } = {},
  ): Promise<PersistentAnalysisCache> {
    const maxBytes = options.maxBytes ?? 268_435_456;
    const maxEntries = options.maxEntries ?? 50_000;
    const maxSingleBytes = options.maxSingleBytes ?? 16_777_216;
    for (const [name, value] of [
      ['byte budget', maxBytes],
      ['entry budget', maxEntries],
      ['single-entry budget', maxSingleBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`Persistent analysis cache ${name} must be a non-negative integer`);
    }
    await assertUnlinked(path.join(state.root, 'analysis-cache'));
    const root = await containedGeneratedPath(state.root, 'analysis-cache');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertUnlinked(root);
    return new PersistentAnalysisCache(state, root, maxBytes, maxEntries, maxSingleBytes);
  }

  async hydrate(
    scope: AnalysisCacheScope,
    files: readonly ScannedFile[],
    documents: SourceDocumentCache,
    segments: IndexSegmentCache,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const scopeHash = cacheScopeHash(scope);
    const [sourceEntries, indexEntries] = await Promise.all([
      this.inventory(scopeHash, 'source-document', signal),
      this.inventory(scopeHash, 'index-segment', signal),
    ]);
    for (const file of files) {
      signal?.throwIfAborted();
      const key = sourceDocumentCacheKey(file.bytes, file.displayPath);
      const documentAddress = sourceAddress(key);
      if (sourceEntries.has(documentAddress)) {
        const payload = await this.read(scopeHash, 'source-document', documentAddress, signal);
        if (payload !== undefined) {
          try {
            documents.importEncoded(key, payload, {
              bytes: file.bytes,
              sourcePath: file.displayPath,
            });
          } catch {
            this.#invalidEntries += 1;
            this.#invalidAddresses.add(`${scopeHash}\0source-document\0${documentAddress}`);
          }
        }
      }
      for (const provinceDefinition of [false, true]) {
        const address = indexSegmentAddress(file, provinceDefinition);
        if (!indexEntries.has(address)) continue;
        const payload = await this.read(scopeHash, 'index-segment', address, signal);
        if (payload === undefined) continue;
        try {
          segments.importEncoded(address, payload.toString('utf8'));
        } catch {
          this.#invalidEntries += 1;
          this.#invalidAddresses.add(`${scopeHash}\0index-segment\0${address}`);
        }
      }
    }
  }

  async persist(
    scope: AnalysisCacheScope,
    files: readonly ScannedFile[],
    documents: SourceDocumentCache,
    segments: IndexSegmentCache,
    signal = new AbortController().signal,
  ): Promise<void> {
    const scopeHash = cacheScopeHash(scope);
    await this.#lock.run(signal, async () => {
      const [sourceEntries, indexEntries] = await Promise.all([
        this.inventory(scopeHash, 'source-document', signal),
        this.inventory(scopeHash, 'index-segment', signal),
      ]);
      for (const file of files) {
        signal.throwIfAborted();
        const key = sourceDocumentCacheKey(file.bytes, file.displayPath);
        const documentAddress = sourceAddress(key);
        const document = documents.exportEncoded(key);
        if (
          document !== undefined &&
          (!sourceEntries.has(documentAddress) ||
            this.#invalidAddresses.has(`${scopeHash}\0source-document\0${documentAddress}`))
        ) {
          if (await this.write(scopeHash, 'source-document', documentAddress, document, signal)) {
            sourceEntries.add(documentAddress);
          }
        }
        for (const provinceDefinition of [false, true]) {
          const address = indexSegmentAddress(file, provinceDefinition);
          const segment = segments.exportEncoded(address);
          if (
            segment === undefined ||
            (indexEntries.has(address) &&
              !this.#invalidAddresses.has(`${scopeHash}\0index-segment\0${address}`))
          )
            continue;
          if (await this.write(scopeHash, 'index-segment', address, Buffer.from(segment), signal)) {
            indexEntries.add(address);
          }
        }
      }
      await this.prune(signal);
    });
  }

  statistics(): PersistentAnalysisCacheStatistics {
    return {
      hits: this.#hits,
      misses: this.#misses,
      writes: this.#writes,
      retainedEntries: this.#retainedEntries,
      retainedBytes: this.#retainedBytes,
      evictions: this.#evictions,
      invalidEntries: this.#invalidEntries,
      oversized: this.#oversized,
    };
  }

  private async directory(scopeHash: string, kind: EntryKind): Promise<string> {
    await assertUnlinked(this.root);
    await assertUnlinked(path.join(this.root, scopeHash));
    await assertUnlinked(path.join(this.root, scopeHash, kind));
    return containedGeneratedPath(this.root, scopeHash, kind);
  }

  private async inventory(
    scopeHash: string,
    kind: EntryKind,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const directory = await this.directory(scopeHash, kind);
    const entries = new Set<string>();
    let opened;
    try {
      opened = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries;
      throw error;
    }
    for await (const entry of opened) {
      signal?.throwIfAborted();
      const match = entryFilePattern.exec(entry.name);
      if (entry.isFile() && !entry.isSymbolicLink() && match?.groups?.address !== undefined) {
        entries.add(match.groups.address);
      }
    }
    return entries;
  }

  private async read(
    scopeHash: string,
    kind: EntryKind,
    address: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    signal?.throwIfAborted();
    const directory = await this.directory(scopeHash, kind);
    const file = await containedGeneratedPath(directory, `${digestSchema.parse(address)}.json`);
    const invalidAddress = `${scopeHash}\0${kind}\0${address}`;
    let handle;
    try {
      await assertUnlinked(file);
      handle = await open(file, 'r');
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > Math.ceil((this.maxSingleBytes * 4) / 3) + 4096)
        throw new Error('Persistent analysis cache entry exceeds its storage budget');
      const parsed = entrySchema.parse(JSON.parse(await handle.readFile('utf8')) as unknown);
      const { authenticationTag, ...entry } = parsed;
      if (
        entry.scopeHash !== scopeHash ||
        entry.kind !== kind ||
        entry.address !== address ||
        !this.state.verifyJournal({ kind: 'analysis-cache-entry.v1', entry }, authenticationTag)
      )
        throw new Error('Persistent analysis cache authentication or identity is invalid');
      const payload = Buffer.from(entry.payload, 'base64');
      if (payload.length > this.maxSingleBytes || sha256Bytes(payload) !== entry.payloadHash)
        throw new Error('Persistent analysis cache payload is invalid');
      this.#hits += 1;
      this.#invalidAddresses.delete(invalidAddress);
      return payload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#misses += 1;
        return undefined;
      }
      this.#invalidEntries += 1;
      this.#invalidAddresses.add(invalidAddress);
      return undefined;
    } finally {
      await handle?.close();
    }
  }

  private async write(
    scopeHash: string,
    kind: EntryKind,
    address: string,
    payload: Buffer,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      this.maxBytes === 0 ||
      this.maxEntries === 0 ||
      this.maxSingleBytes === 0 ||
      payload.length > this.maxSingleBytes
    ) {
      this.#oversized += 1;
      return false;
    }
    const directory = await this.directory(scopeHash, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = await containedGeneratedPath(directory, `${digestSchema.parse(address)}.json`);
    const invalidAddress = `${scopeHash}\0${kind}\0${address}`;
    const unsigned: UnsignedEntry = {
      version: 1,
      kind,
      scopeHash,
      address,
      toolVersion: PACKAGE_VERSION,
      runtime: `${process.versions.node}\0${process.versions.v8}`,
      payloadHash: sha256Bytes(payload),
      payload: payload.toString('base64'),
    };
    const bytes = Buffer.from(
      canonicalJson({
        ...unsigned,
        authenticationTag: this.state.authenticateJournal({
          kind: 'analysis-cache-entry.v1',
          entry: unsigned,
        }),
      }),
    );
    if (bytes.length > Math.ceil((this.maxSingleBytes * 4) / 3) + 4096) {
      this.#oversized += 1;
      return false;
    }
    const repair = this.#invalidAddresses.has(invalidAddress);
    const existing = repair ? undefined : await this.read(scopeHash, kind, address, signal);
    if (existing !== undefined) {
      if (!existing.equals(payload)) this.#invalidEntries += 1;
      return false;
    }
    if (repair || this.#invalidAddresses.has(invalidAddress)) {
      await unlink(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    await assertUnlinked(target);
    const temporary = await containedGeneratedPath(directory, `.${secureId('analysis')}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      signal.throwIfAborted();
      try {
        await link(temporary, target);
        this.#writes += 1;
        this.#invalidAddresses.delete(invalidAddress);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const winner = await this.read(scopeHash, kind, address, signal);
        if (winner?.equals(payload) === true) return false;
        this.#invalidEntries += 1;
        return false;
      }
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async prune(signal: AbortSignal): Promise<void> {
    const retained: RetainedEntry[] = [];
    let scopes: string[];
    try {
      scopes = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const scopeHash of scopes) {
      if (!digestSchema.safeParse(scopeHash).success) continue;
      for (const kind of entryKindSchema.options) {
        const directory = await this.directory(scopeHash, kind);
        let opened;
        try {
          opened = await opendir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        for await (const entry of opened) {
          signal.throwIfAborted();
          if (!entry.isFile() || entry.isSymbolicLink() || !entryFilePattern.test(entry.name))
            continue;
          const file = await containedGeneratedPath(directory, entry.name);
          const metadata = await lstat(file);
          retained.push({ file, bytes: metadata.size, modifiedMs: metadata.mtimeMs });
        }
      }
    }
    retained.sort(
      (left, right) =>
        left.modifiedMs - right.modifiedMs || left.file.localeCompare(right.file, 'en-US'),
    );
    let retainedBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
    let retainedEntries = retained.length;
    for (const entry of retained) {
      if (retainedBytes <= this.maxBytes && retainedEntries <= this.maxEntries) break;
      try {
        await unlink(entry.file);
        retainedBytes -= entry.bytes;
        retainedEntries -= 1;
        this.#evictions += 1;
      } catch (error) {
        if (
          !['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
    }
    this.#retainedBytes = retainedBytes;
    this.#retainedEntries = retainedEntries;
  }
}
