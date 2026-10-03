import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { ServiceError } from '../core/result.js';
import { decodeSource } from '../core/source/encoding.js';
import type { z } from 'zod/v4';
import type { sourceLookupRequestSchema, sourceLookupDataSchema } from '../schemas/reference.js';
import { readBoundedJsonLines } from './lines.js';
import { scanImpactSemanticReferences } from '../core/impact-semantic.js';
import { parseClausewitz } from '../core/source/parser.js';
import { navigateSource } from './source-navigation.js';

const semanticCache = new WeakMap<ScanSnapshot, ReturnType<typeof scanImpactSemanticReferences>>();

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
  const narrowPatterns: Readonly<Record<string, string[]>> = {
    event: ['events/**/*.txt'],
    scripted_effect: ['common/scripted_effects/**/*.txt'],
    scripted_trigger: ['common/scripted_triggers/**/*.txt'],
  };
  const patterns =
    input.kind === 'event' && input.includeReferences
      ? [
          'events/**/*.txt',
          'common/national_focus/**/*.txt',
          'common/continuous_focus/**/*.txt',
          'common/decisions/**/*.txt',
          'common/ideas/**/*.txt',
          'common/technologies/**/*.txt',
          'common/scripted_effects/**/*.txt',
          'common/scripted_triggers/**/*.txt',
          'common/scripted_guis/**/*.txt',
          'common/on_actions/**/*.txt',
        ]
      : input.includeReferences || input.kind === undefined
        ? undefined
        : narrowPatterns[input.kind];
  const snapshot = await engine.scan(
    workspaceId,
    patterns === undefined ? {} : { patterns },
    principal,
    signal,
  );
  if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision) {
    throw new ServiceError(
      'SOURCE_REVISION_STALE',
      'Indexed source changed; look up the symbol again',
      { currentRevision: snapshot.revision },
    );
  }
  const navigating = input.keyPath !== undefined || input.view === 'structure';
  const matchedDefinitions = snapshot.index.symbols
    .filter(
      (entry) =>
        entry.id === input.symbol && (input.kind === undefined || entry.kind === input.kind),
    )
    .sort(
      (left, right) =>
        Number(left.overridden) - Number(right.overridden) || right.loadOrder - left.loadOrder,
    );
  if (navigating && new Set(matchedDefinitions.map(({ kind }) => kind)).size > 1)
    throw new ServiceError(
      'SOURCE_KIND_AMBIGUOUS',
      'Nested navigation requires kind when the identifier has multiple symbol kinds',
    );
  const definitions = matchedDefinitions
    .slice(0, navigating ? 1 : input.maxDefinitions)
    .map((entry, index) => {
      const source = snapshot.index.files.get(entry.path);
      const start = entry.location?.start.line;
      const end = entry.location?.end.line;
      const navigation = navigating
        ? (() => {
            if (
              source === undefined ||
              entry.location === undefined ||
              /\.ya?ml$/iu.test(entry.path)
            )
              throw new ServiceError(
                'SOURCE_STRUCTURE_UNAVAILABLE',
                'Nested navigation requires an indexed Clausewitz definition',
              );
            return navigateSource(
              parseClausewitz(source.bytes, source.displayPath),
              {
                start: entry.location.start.offset,
                end: entry.location.end.offset,
              },
              input.keyPath ?? [],
              {
                structure: input.view === 'structure',
                maxChildren: input.maxChildren,
                childOffset: input.childOffset,
                maxLines: input.maxLines,
                ...(index === 0 && input.fromLine !== undefined
                  ? { fromLine: input.fromLine }
                  : {}),
                ...(index === 0 && input.fromColumn !== undefined
                  ? { fromColumn: input.fromColumn }
                  : {}),
              },
            );
          })()
        : undefined;
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
          : readBoundedJsonLines(
              lines,
              start ?? fromLine,
              fromLine,
              index === 0 ? (input.fromColumn ?? 1) : 1,
              input.maxLines,
              2_000,
              4_096,
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
        fromLine: navigation?.fromLine ?? fromLine ?? null,
        toLine: navigation?.endLine ?? selected?.endLine ?? null,
        nextLine: navigation === undefined ? (selected?.nextLine ?? null) : navigation.nextLine,
        nextColumn:
          navigation === undefined ? (selected?.nextColumn ?? null) : navigation.nextColumn,
        text: navigation?.text ?? selected?.text ?? '',
        ...(navigation === undefined ? {} : { navigation: navigation.navigation }),
      };
    });
  let semantic = input.includeReferences ? semanticCache.get(snapshot) : undefined;
  if (input.includeReferences && semantic === undefined) {
    semantic = scanImpactSemanticReferences(snapshot, 200_000, { includeOnActions: true });
    semanticCache.set(snapshot, semantic);
  }
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
  const result: SourceLookupResult = {
    sourceScope:
      input.kind === 'event'
        ? input.includeReferences
          ? 'event_consumers'
          : 'event_definitions'
        : patterns === undefined
          ? 'workspace_index'
          : 'helper_definitions',
    revision: snapshot.revision,
    complete: snapshot.complete,
    skippedSourceCount: snapshot.skippedSourceCount,
    definitionCount: snapshot.index.symbols.filter(
      (entry) =>
        entry.id === input.symbol && (input.kind === undefined || entry.kind === input.kind),
    ).length,
    definitionsTruncated: matchedDefinitions.length > definitions.length,
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
  while (
    Buffer.byteLength(JSON.stringify(result), 'utf8') > 24_000 &&
    result.references.length > 0
  ) {
    result.references.pop();
    result.referencesTruncated = true;
    result.referencesComplete = false;
  }
  while (
    Buffer.byteLength(JSON.stringify(result), 'utf8') > 24_000 &&
    result.definitions.length > 1
  ) {
    result.definitions.pop();
    result.definitionsTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 24_000)
    throw new ServiceError(
      'REFERENCE_RESPONSE_TOO_LARGE',
      'Selected source metadata exceeds the bounded reply; use entry-index selectors for long nested keys',
    );
  return result;
}
