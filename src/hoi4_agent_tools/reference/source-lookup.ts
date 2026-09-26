import type { CoreEngine } from '../core/engine.js';
import { ServiceError } from '../core/result.js';
import { decodeSource } from '../core/source/encoding.js';
import type { z } from 'zod/v4';
import type { sourceLookupRequestSchema, sourceLookupDataSchema } from '../schemas/reference.js';
import { readBoundedLines } from './lines.js';
import { scanImpactSemanticReferences } from '../core/impact-semantic.js';

type Input = z.infer<typeof sourceLookupRequestSchema>;
export type SourceLookupResult = z.infer<typeof sourceLookupDataSchema>;

/** Exact source definitions and usage over the existing shared Clausewitz index. */
export async function sourceLookup(
  engine: CoreEngine,
  workspaceId: string,
  input: Input,
  principal?: string,
  signal?: AbortSignal,
): Promise<SourceLookupResult> {
  const snapshot = await engine.scan(workspaceId, {}, principal, signal);
  if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision) {
    throw new ServiceError(
      'SOURCE_REVISION_STALE',
      'Indexed source changed; look up the symbol again',
      { currentRevision: snapshot.revision },
    );
  }
  const definitions = snapshot.index.symbols
    .filter(
      (entry) =>
        entry.id === input.symbol && (input.kind === undefined || entry.kind === input.kind),
    )
    .sort(
      (left, right) =>
        Number(left.overridden) - Number(right.overridden) || right.loadOrder - left.loadOrder,
    )
    .slice(0, input.maxDefinitions)
    .map((entry, index) => {
      const source = snapshot.index.files.get(entry.path);
      const start = entry.location?.start.line;
      const end = entry.location?.end.line;
      const fromLine = index === 0 ? (input.fromLine ?? start) : start;
      if (
        fromLine !== undefined &&
        start !== undefined &&
        end !== undefined &&
        (fromLine < start || fromLine > end)
      ) {
        throw new ServiceError(
          'SOURCE_LINE_OUTSIDE_DEFINITION',
          'Requested line is outside a matched definition',
        );
      }
      const lines =
        source === undefined || fromLine === undefined
          ? []
          : decodeSource(source.bytes)
              .text.split(/\r?\n/u)
              .slice((start ?? fromLine) - 1, end);
      const selected =
        fromLine === undefined || lines.length === 0
          ? null
          : readBoundedLines(
              lines,
              start ?? fromLine,
              fromLine,
              index === 0 ? (input.fromColumn ?? 1) : 1,
              input.maxLines,
              2_000,
            );
      return {
        kind: entry.kind,
        id: entry.id,
        path: entry.path,
        rootKind: entry.rootKind,
        loadOrder: entry.loadOrder,
        overridden: entry.overridden,
        sourceShadowed: entry.sourceShadowed,
        startLine: start ?? null,
        endLine: end ?? null,
        fromLine: fromLine ?? null,
        toLine: selected?.endLine ?? null,
        nextLine: selected?.nextLine ?? null,
        nextColumn: selected?.nextColumn ?? null,
        text: selected?.text ?? '',
      };
    });
  const semantic = input.includeReferences
    ? scanImpactSemanticReferences(snapshot, 200_000, { includeOnActions: true })
    : undefined;
  const referenceIdentities = new Set<string>();
  const matchedReferences = input.includeReferences
    ? [...snapshot.index.references, ...(semantic?.references ?? [])]
        .filter(
          (entry) =>
            entry.to === input.symbol && (input.kind === undefined || entry.toKind === input.kind),
        )
        .filter((entry) => {
          const key = `${entry.path}:${entry.location?.start.offset ?? 0}:${entry.toKind}:${entry.to}:${entry.kind}`;
          if (referenceIdentities.has(key)) return false;
          referenceIdentities.add(key);
          return true;
        })
    : [];
  const references = matchedReferences.slice(0, input.maxReferences).map((entry) => ({
    kind: entry.kind,
    from: entry.from,
    toKind: entry.toKind,
    path: entry.path,
    line: entry.location?.start.line ?? null,
  }));
  return {
    revision: snapshot.revision,
    complete: snapshot.complete,
    skippedSourceCount: snapshot.skippedSourceCount,
    definitionCount: snapshot.index.symbols.filter(
      (entry) =>
        entry.id === input.symbol && (input.kind === undefined || entry.kind === input.kind),
    ).length,
    definitions,
    references,
    referencesIncluded: input.includeReferences,
    referenceCount: matchedReferences.length,
    referencesTruncated: matchedReferences.length > references.length,
    referencesComplete:
      input.includeReferences &&
      snapshot.complete &&
      semantic?.complete === true &&
      semantic.unresolved.length === 0 &&
      matchedReferences.length <= references.length,
    unresolvedReferenceCount: semantic?.unresolved.length ?? 0,
  };
}
