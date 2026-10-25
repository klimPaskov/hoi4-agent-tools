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
  const previous =
    manifest === undefined
      ? []
      : (() => {
          if (manifest.bytes.length > 2_000_000)
            throw new ServiceError(
              'MANAGED_OUTPUT_MANIFEST_INVALID',
              'Generated-output inventory exceeds its byte limit',
            );
          try {
            return manifestSchema.parse(JSON.parse(manifest.bytes.toString('utf8'))).files;
          } catch {
            throw new ServiceError(
              'MANAGED_OUTPUT_MANIFEST_INVALID',
              'Generated-output inventory is invalid',
            );
          }
        })();
  const outputs = input.proposed.filter(
    (f) => f.content !== null && input.permitsPath(f.relativePath),
  );
  const next = new Set(outputs.map((f) => f.relativePath.toLowerCase()));
  const released = new Set<string>();
  const seen = new Set<string>();
  for (const file of previous) {
    const key = file.relativePath.toLowerCase();
    if (
      file.relativePath.includes('\\') ||
      file.relativePath.split('/').some((s) => !s || s === '.' || s === '..') ||
      /^[a-z]:/iu.test(file.relativePath) ||
      !input.permitsPath(file.relativePath) ||
      seen.has(key)
    )
      throw new ServiceError(
        'MANAGED_OUTPUT_MANIFEST_INVALID',
        'Generated-output inventory contains an unsupported or duplicate path',
      );
    seen.add(key);
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
  const deletions: ProposedFileChange[] = previous
    .filter((f) => {
      const key = f.relativePath.toLowerCase();
      return !next.has(key) && !released.has(key) && sources.has(key);
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
      content: Buffer.from(
        canonicalJson({
          version: 1,
          files: outputs
            .map((f) => ({ relativePath: f.relativePath, sha256: sha256Bytes(f.content!) }))
            .sort((a, b) => compareCodeUnits(a.relativePath, b.relativePath)),
        }) + '\n',
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
  };
}
