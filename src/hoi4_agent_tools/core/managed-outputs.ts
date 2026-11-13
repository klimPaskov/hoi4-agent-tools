import { z } from 'zod';
import { canonicalJson, compareCodeUnits, sha256Bytes } from './canonical.js';
import { ServiceError } from './result.js';
import type { ScannedFile } from './scanner.js';
import type { ProposedFileChange } from './transactions.js';

const manifestSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            relativePath: z.string().min(1).max(512),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();

export interface ManagedOutputInput {
  manifestPath: string;
  sources: readonly ScannedFile[];
  proposed: readonly ProposedFileChange[];
  operationId: string;
  permitsPath: (relativePath: string) => boolean;
  /**
   * Recorded outputs that the workspace may take over: when such a file was edited and this write
   * no longer produces it, it is left in place and dropped from the inventory instead of blocking.
   */
  releasable?: (relativePath: string) => boolean;
}

export interface ManagedOutputPlan {
  /** Deletions of retired outputs, then the new inventory. */
  changes: ProposedFileChange[];
  /** Outputs the new inventory records, sorted. */
  written: string[];
  /** Recorded outputs this write no longer produces and deletes, sorted. */
  retired: string[];
  /** Edited recorded outputs left to the workspace and dropped from the inventory, sorted. */
  released: string[];
  /**
   * Recorded paths this kind of output does not manage (safe relative paths outside the allow-list,
   * such as files another tool registered): never read, edited or deleted, and dropped from the
   * inventory. Sorted.
   */
  ignored: string[];
}

/** Pure planning only: the shared transaction engine performs every replacement and deletion. */
export function reconcileManagedOutputs(input: ManagedOutputInput): ProposedFileChange[] {
  return planManagedOutputs(input).changes;
}

/** Plans the managed-output reconciliation and reports what it writes, retires and releases. */
export function planManagedOutputs(input: ManagedOutputInput): ManagedOutputPlan {
  const sources = new Map(
    input.sources
      .filter((f) => f.rootKind === 'mod')
      .map((f) => [f.relativePath.replaceAll('\\', '/').toLowerCase(), f]),
  );
  const manifest = sources.get(input.manifestPath.toLowerCase());
  const previous = manifest === undefined ? [] : parseManifest(manifest.bytes);
  const outputs = input.proposed.filter(
    (f) => f.content !== null && input.permitsPath(f.relativePath),
  );
  const next = new Set(outputs.map((f) => f.relativePath.toLowerCase()));
  const released = new Set<string>();
  const ignored = new Set<string>();
  for (const file of previous) {
    const key = file.relativePath.toLowerCase();
    // A safe path this inventory does not manage is left alone: not compared, not deleted.
    if (!input.permitsPath(file.relativePath)) {
      ignored.add(file.relativePath);
      continue;
    }
    const current = sources.get(key);
    if (current === undefined || sha256Bytes(current.bytes) === file.sha256) continue;
    if (!next.has(key) && input.releasable?.(file.relativePath) === true) {
      released.add(key);
      continue;
    }
    throw new ServiceError(
      'MANAGED_OUTPUT_EDITED',
      'A generated file has been edited; regeneration would discard those changes',
      { relativePath: file.relativePath },
    );
  }
  const ignoredKeys = new Set([...ignored].map((path) => path.toLowerCase()));
  const deletions: ProposedFileChange[] = previous
    .filter((f) => {
      const key = f.relativePath.toLowerCase();
      return !next.has(key) && !released.has(key) && !ignoredKeys.has(key) && sources.has(key);
    })
    .map((f) => ({
      relativePath: f.relativePath,
      content: null,
      operationIds: [input.operationId],
    }));
  const sorted = (paths: Iterable<string>) => [...paths].sort(compareCodeUnits);
  const changes: ProposedFileChange[] = [
    ...deletions,
    {
      relativePath: input.manifestPath,
      content: manifestBytes(
        outputs.map((f) => ({ relativePath: f.relativePath, sha256: sha256Bytes(f.content!) })),
      ),
      operationIds: [input.operationId],
      mediaType: 'application/json',
    },
  ];
  return {
    changes,
    written: sorted(outputs.map((f) => f.relativePath)),
    retired: sorted(deletions.map((f) => f.relativePath)),
    released: sorted(
      previous.filter((f) => released.has(f.relativePath.toLowerCase())).map((f) => f.relativePath),
    ),
    ignored: sorted(ignored),
  };
}

interface ManifestEntry {
  relativePath: string;
  sha256: string;
}

/**
 * Parse a recorded inventory. An oversized or malformed one, a path that could leave the
 * workspace, or a duplicate makes the whole inventory untrustworthy.
 */
function parseManifest(bytes: Uint8Array): ManifestEntry[] {
  if (bytes.length > 2_000_000)
    throw new ServiceError(
      'MANAGED_OUTPUT_MANIFEST_INVALID',
      'Generated-output inventory exceeds its byte limit',
    );
  let files: ManifestEntry[];
  try {
    files = manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))).files;
  } catch {
    throw new ServiceError(
      'MANAGED_OUTPUT_MANIFEST_INVALID',
      'Generated-output inventory is invalid',
    );
  }
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.relativePath.toLowerCase();
    if (
      file.relativePath.includes('\\') ||
      file.relativePath.split('/').some((s) => !s || s === '.' || s === '..') ||
      /^[a-z]:/iu.test(file.relativePath) ||
      seen.has(key)
    )
      throw new ServiceError(
        'MANAGED_OUTPUT_MANIFEST_INVALID',
        'Generated-output inventory contains an unsupported or duplicate path',
      );
    seen.add(key);
  }
  return files;
}

function manifestBytes(files: readonly ManifestEntry[]): Buffer {
  return Buffer.from(
    canonicalJson({
      version: 1,
      files: [...files].sort((a, b) => compareCodeUnits(a.relativePath, b.relativePath)),
    }) + '\n',
  );
}

export interface ManagedOutputRefreshInput {
  manifestPath: string;
  sources: readonly ScannedFile[];
  /** Every change of the request, after its last operation. */
  proposed: readonly ProposedFileChange[];
  /**
   * Adopt the current bytes of every recorded output, edited or not (`record_world_outputs`).
   * Without it only outputs this request writes are refreshed, and only where the file on disk
   * still matches its recorded hash or the inventory itself is written by this request, so an
   * earlier hand edit stays protected.
   */
  adoptAll?: boolean;
}

export interface ManagedOutputRefresh {
  /** The new inventory, or undefined when no recorded hash changes. */
  content: Buffer | undefined;
  /** Recorded outputs whose hash now matches their new bytes, sorted. */
  refreshed: string[];
  /** Recorded outputs removed from the inventory because the file is gone, sorted. */
  dropped: string[];
  /** Recorded outputs this request writes over an earlier edit, left with their old hash, sorted. */
  keptEdited: string[];
  /** Recorded outputs whose hash already matched, sorted. */
  unchanged: string[];
  /** The operations that wrote the refreshed or dropped outputs, sorted. */
  operationIds: string[];
}

/**
 * Bring the recorded hashes of an inventory up to date with the bytes a request leaves behind, so
 * the tool's own later edits (update_states, move_state_provinces and the rest) never read as hand
 * edits. Returns undefined when the workspace has no inventory or this request deletes it.
 */
export function refreshManagedOutputs(
  input: ManagedOutputRefreshInput,
): ManagedOutputRefresh | undefined {
  const key = (relativePath: string) => relativePath.replaceAll('\\', '/').toLowerCase();
  const proposed = new Map(input.proposed.map((change) => [key(change.relativePath), change]));
  const sources = new Map(
    input.sources.filter((f) => f.rootKind === 'mod').map((f) => [key(f.relativePath), f]),
  );
  const manifestKey = key(input.manifestPath);
  const written = proposed.get(manifestKey);
  if (written?.content === null) return undefined;
  const bytes = written?.content ?? sources.get(manifestKey)?.bytes;
  if (bytes === undefined) return undefined;
  const writtenHere = written !== undefined;
  const refreshed: string[] = [];
  const dropped: string[] = [];
  const keptEdited: string[] = [];
  const unchanged: string[] = [];
  const operationIds = new Set<string>();
  const next: ManifestEntry[] = [];
  for (const entry of parseManifest(bytes)) {
    const change = proposed.get(key(entry.relativePath));
    const source = sources.get(key(entry.relativePath));
    let current: Uint8Array | null;
    if (change !== undefined) {
      const trusted =
        writtenHere ||
        input.adoptAll === true ||
        source === undefined ||
        sha256Bytes(source.bytes) === entry.sha256;
      if (!trusted) {
        keptEdited.push(entry.relativePath);
        next.push(entry);
        continue;
      }
      current = change.content;
      for (const id of change.operationIds) operationIds.add(id);
    } else if (input.adoptAll === true) current = source === undefined ? null : source.bytes;
    else {
      next.push(entry);
      continue;
    }
    if (current === null) {
      dropped.push(entry.relativePath);
      continue;
    }
    const sha256 = sha256Bytes(current);
    if (sha256 === entry.sha256) unchanged.push(entry.relativePath);
    else refreshed.push(entry.relativePath);
    next.push({ relativePath: entry.relativePath, sha256 });
  }
  const changed = refreshed.length > 0 || dropped.length > 0;
  return {
    content: changed ? manifestBytes(next) : undefined,
    refreshed: refreshed.sort(compareCodeUnits),
    dropped: dropped.sort(compareCodeUnits),
    keptEdited: keptEdited.sort(compareCodeUnits),
    unchanged: unchanged.sort(compareCodeUnits),
    operationIds: [...operationIds].sort(compareCodeUnits),
  };
}
