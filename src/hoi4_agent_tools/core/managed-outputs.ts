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

/** Pure planning only: the shared transaction engine performs every replacement and deletion. */
export function reconcileManagedOutputs(input: {
  manifestPath: string;
  sources: readonly ScannedFile[];
  proposed: readonly ProposedFileChange[];
  operationId: string;
  permitsPath: (relativePath: string) => boolean;
}): ProposedFileChange[] {
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
    if (current !== undefined && sha256Bytes(current.bytes) !== file.sha256)
      throw new ServiceError(
        'MANAGED_OUTPUT_EDITED',
        'A generated file has been edited; regeneration would discard those changes',
        { relativePath: file.relativePath },
      );
  }
  const outputs = input.proposed.filter(
    (f) => f.content !== null && input.permitsPath(f.relativePath),
  );
  const next = new Set(outputs.map((f) => f.relativePath.toLowerCase()));
  const deletions: ProposedFileChange[] = previous
    .filter(
      (f) => !next.has(f.relativePath.toLowerCase()) && sources.has(f.relativePath.toLowerCase()),
    )
    .map((f) => ({
      relativePath: f.relativePath,
      content: null,
      operationIds: [input.operationId],
    }));
  return [
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
}
