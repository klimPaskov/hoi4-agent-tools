import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { defaultPatterns, type CoreEngine, type ScanSnapshot } from '../core/engine.js';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { isWithin } from '../core/workspace.js';
import { decodeSource } from '../core/source/encoding.js';
import type { z } from 'zod/v4';
import type { sourceLookupRequestSchema, sourceLookupDataSchema } from '../schemas/reference.js';
import { sourceLookupEngineResponseSchema } from '../schemas/mod-tools.js';
import { modIndexEngineRequest, SOURCE_ROOT_KINDS } from './mod-index.js';
import { readBoundedJsonLines } from './lines.js';
import {
  IMPACT_SEMANTIC_MAX_REFERENCES,
  scanImpactSemanticReferences,
} from '../core/impact-semantic.js';
import { parseClausewitz, type BlockNode, type SourceDocument } from '../core/source/parser.js';
import { positionAt } from '../core/source/lexer.js';
import { navigateSource } from './source-navigation.js';
import { locatePatterns, locateSource } from './source-locate.js';
import { nearestNames } from './suggestions.js';

const semanticCache = new WeakMap<ScanSnapshot, ReturnType<typeof scanImpactSemanticReferences>>();

type Input = z.infer<typeof sourceLookupRequestSchema>;
export type SourceLookupResult = z.infer<typeof sourceLookupDataSchema>;

/** What `describeDefinition` needs to know about one matched definition. */
interface DefinitionEntry {
  kind: string;
  id: string;
  path: string;
  rootKind: string;
  loadOrder: number;
  overridden: boolean;
  sourceShadowed: boolean;
  startLine: number | undefined;
  endLine: number | undefined;
  /** The definition's offsets in a parsed document of its file, when they are known. */
  rangeIn: (document: SourceDocument) => { start: number; end: number } | undefined;
}

interface DefinitionFile {
  bytes: Uint8Array;
  displayPath: string;
}

/** The lines, or the nested navigation, of one matched definition. */
function describeDefinition(
  entry: DefinitionEntry,
  source: DefinitionFile | undefined,
  index: number,
  input: Input,
  navigating: boolean,
): SourceLookupResult['definitions'][number] {
  const start = entry.startLine;
  const end = entry.endLine;
  const navigation = navigating
    ? (() => {
        if (source === undefined || /\.ya?ml$/iu.test(entry.path))
          throw new ServiceError(
            'SOURCE_STRUCTURE_UNAVAILABLE',
            'Nested navigation requires an indexed Clausewitz definition',
          );
        const document = parseClausewitz(source.bytes, source.displayPath);
        const range = entry.rangeIn(document);
        if (range === undefined)
          throw new ServiceError(
            'SOURCE_STRUCTURE_UNAVAILABLE',
            'Nested navigation requires an indexed Clausewitz definition',
          );
        return navigateSource(document, range, input.keyPath ?? [], {
          structure: input.view === 'structure',
          maxChildren: input.maxChildren,
          childOffset: input.childOffset,
          maxLines: input.maxLines,
          ...(index === 0 && input.fromLine !== undefined ? { fromLine: input.fromLine } : {}),
          ...(index === 0 && input.fromColumn !== undefined
            ? { fromColumn: input.fromColumn }
            : {}),
        });
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
    nextColumn: navigation === undefined ? (selected?.nextColumn ?? null) : navigation.nextColumn,
    text: navigation?.text ?? selected?.text ?? '',
    ...(navigation === undefined ? {} : { navigation: navigation.navigation }),
  };
}

/** The reply stays within 24,000 bytes: references go first, then definitions after the first. */
function boundResult(result: SourceLookupResult): SourceLookupResult {
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

/** `nearestNames` over the engine's candidates: nearest first, ties in the English locale order. */
function nearestOf(candidates: ReadonlyArray<{ id: string; distance: number }>): string[] {
  return [...candidates]
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id, 'en'))
    .slice(0, 5)
    .map(({ id }) => id);
}

function notFound(symbol: string, kind: string | undefined, suggestions: string[]): ServiceError {
  return new ServiceError(
    'SYMBOL_NOT_FOUND',
    `No indexed file defines ${symbol.slice(0, 256)}${kind === undefined ? '' : ` as a ${kind}`}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
    { symbol: symbol.slice(0, 256), suggestions },
  );
}

/**
 * The first line of a definition's assignment in a parsed file. The engine names a definition by
 * its first and last line; the nested navigation needs its offsets.
 */
function rangeByLines(
  document: SourceDocument,
  startLine: number | undefined,
  endLine: number | undefined,
): { start: number; end: number } | undefined {
  if (startLine === undefined) return undefined;
  let fallback: { start: number; end: number } | undefined;
  const visit = (block: BlockNode): { start: number; end: number } | undefined => {
    for (const entry of block.entries) {
      if (entry.type !== 'assignment') continue;
      if (positionAt(document.lineIndex, entry.start).line === startLine) {
        const last = positionAt(document.lineIndex, Math.max(entry.start, entry.end - 1)).line;
        if (endLine === undefined || last === endLine)
          return { start: entry.start, end: entry.end };
        fallback ??= { start: entry.start, end: entry.end };
      }
      if (entry.value.type === 'block') {
        const found = visit(entry.value);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(document.root) ?? fallback;
}

/** Read one file the engine named, only from a configured root and only as it was scanned. */
async function readScannedFile(
  engine: CoreEngine,
  workspaceId: string,
  absolutePath: string,
  sha256: string,
  principal?: string,
): Promise<Buffer> {
  const maxBytes = engine.resolver.config().scanMaxFileBytes;
  const workspace = engine.resolver.get(workspaceId, principal);
  const real = await realpath(absolutePath);
  const roots = await Promise.all(workspace.roots.map(({ path: root }) => realpath(root)));
  if (!roots.some((root) => isWithin(root, real)))
    throw new ServiceError('SOURCE_FILE_NOT_INDEXED', 'The source file is outside the workspace');
  if ((await stat(real)).size > maxBytes)
    throw new ServiceError('SCAN_BYTE_LIMIT', 'Scan exceeds the configured byte limit');
  const bytes = await readFile(real);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new ServiceError(
      'SOURCE_REVISION_STALE',
      'Indexed source changed; look up the symbol again',
    );
  return bytes;
}

/** `sourceScope` of the reply. */
function scopeOf(input: Input, patterns: string[] | undefined): SourceLookupResult['sourceScope'] {
  return input.kind === 'event'
    ? input.includeReferences
      ? 'event_consumers'
      : 'event_definitions'
    : patterns === undefined
      ? 'workspace_index'
      : 'helper_definitions';
}

/**
 * A lookup that asks for no references: the shared Rust engine (ADR 0082) finds the definitions,
 * the scan revision and the near-miss names, and this side reads only the chosen files for their
 * lines and nested navigation. A missing engine is `ENGINE_UNAVAILABLE`.
 */
async function lookupFromEngine(
  engine: CoreEngine,
  workspaceId: string,
  input: Input,
  symbol: string,
  patterns: string[] | undefined,
  principal?: string,
  signal?: AbortSignal,
): Promise<SourceLookupResult> {
  signal?.throwIfAborted();
  await engine.resolver.refreshDescriptors(workspaceId, principal);
  const workspace = engine.resolver.get(workspaceId, principal);
  const navigating = input.keyPath !== undefined || input.view === 'structure';
  const answered = await runEngineCommand(
    'source-lookup',
    {
      ...modIndexEngineRequest(workspace, engine.resolver.config(), SOURCE_ROOT_KINDS),
      schema: SOURCE_LOOKUP_REQUEST_SCHEMA,
      patterns: patterns ?? defaultPatterns(workspace),
      symbol,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      maxDefinitions: navigating ? 1 : input.maxDefinitions,
    },
    sourceLookupEngineResponseSchema,
    { timeoutMs: SOURCE_LOOKUP_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  if (!answered.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', answered.message, { reason: answered.reason });
  if (answered.outcome === 'invalid_request')
    throw new ServiceError(answered.error.code, answered.error.message);
  const response = answered.response;
  if (input.expectedRevision !== undefined && input.expectedRevision !== response.revision) {
    throw new ServiceError(
      'SOURCE_REVISION_STALE',
      'Indexed source changed; look up the symbol again',
      { currentRevision: response.revision },
    );
  }
  if (navigating && response.kindCount > 1)
    throw new ServiceError(
      'SOURCE_KIND_AMBIGUOUS',
      'Nested navigation requires kind when the identifier has multiple symbol kinds',
    );
  const suggestions = nearestOf(response.suggestionCandidates);
  // A complete index that does not define the symbol answers not-found, never an empty success.
  if (response.definitionCount === 0 && response.complete)
    throw notFound(symbol, input.kind, suggestions);
  const definitions = await Promise.all(
    response.definitions.map(async (entry, index) => {
      const bytes = await readScannedFile(
        engine,
        workspaceId,
        entry.absolutePath,
        entry.sha256,
        principal,
      );
      return describeDefinition(
        {
          kind: entry.kind,
          id: entry.id,
          path: entry.path,
          rootKind: entry.rootKind,
          loadOrder: entry.loadOrder,
          overridden: entry.overridden,
          sourceShadowed: entry.sourceShadowed,
          startLine: entry.startLine === 0 ? undefined : entry.startLine,
          endLine: entry.endLine === 0 ? undefined : entry.endLine,
          rangeIn: (document) => rangeByLines(document, entry.startLine, entry.endLine),
        },
        { bytes, displayPath: entry.path },
        index,
        input,
        navigating,
      );
    }),
  );
  return boundResult({
    sourceScope: scopeOf(input, patterns),
    revision: response.revision,
    complete: response.complete,
    skippedSourceCount: response.skippedSourceCount,
    definitionCount: response.definitionCount,
    definitionsTruncated: response.definitionCount > definitions.length,
    ...(response.definitionCount === 0 ? { suggestions } : {}),
    definitions,
    references: [],
    referencesIncluded: false,
    referenceCount: 0,
    referencesTruncated: false,
    referencesComplete: false,
    unresolvedReferenceCount: 0,
  });
}

/** A cold index of the game, its DLC and a large mod. */
const SOURCE_LOOKUP_TIMEOUT_MS = 180_000;
const SOURCE_LOOKUP_REQUEST_SCHEMA = 'hoi4-source-lookup-request/1';

/** Exact source definitions and usage over the shared Clausewitz index. */
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
      : input.path !== undefined
        ? locatePatterns(engine, workspaceId, input.path, principal)
        : input.includeReferences || input.kind === undefined
          ? undefined
          : narrowPatterns[input.kind];
  const locating = input.path !== undefined && input.line !== undefined;
  if (!locating && input.symbol !== undefined && !input.includeReferences)
    return lookupFromEngine(engine, workspaceId, input, input.symbol, patterns, principal, signal);
  const snapshot = await engine.scan(
    workspaceId,
    patterns === undefined ? {} : { patterns },
    principal,
    signal,
  );
  if (input.path !== undefined && input.line !== undefined)
    return {
      sourceScope: 'source_location',
      revision: snapshot.revision,
      complete: snapshot.complete,
      skippedSourceCount: snapshot.skippedSourceCount,
      definitionCount: 0,
      definitionsTruncated: false,
      referencesIncluded: false,
      referenceCount: 0,
      referencesTruncated: false,
      referencesComplete: false,
      unresolvedReferenceCount: 0,
      location: locateSource(snapshot, input.path, input.line, input.column),
      definitions: [],
      references: [],
    };
  const symbol = input.symbol;
  if (symbol === undefined)
    throw new ServiceError('SOURCE_LOOKUP_TARGET_REQUIRED', 'Provide a symbol, or path and line');
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
      (entry) => entry.id === symbol && (input.kind === undefined || entry.kind === input.kind),
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
      return describeDefinition(
        {
          kind: entry.kind,
          id: entry.id,
          path: entry.path,
          rootKind: entry.rootKind,
          loadOrder: entry.loadOrder,
          overridden: entry.overridden,
          sourceShadowed: entry.sourceShadowed,
          startLine: entry.location?.start.line,
          endLine: entry.location?.end.line,
          rangeIn: () =>
            entry.location === undefined
              ? undefined
              : { start: entry.location.start.offset, end: entry.location.end.offset },
        },
        source === undefined ? undefined : { bytes: source.bytes, displayPath: source.displayPath },
        index,
        input,
        navigating,
      );
    });
  let semantic = input.includeReferences ? semanticCache.get(snapshot) : undefined;
  if (input.includeReferences && semantic === undefined) {
    semantic = scanImpactSemanticReferences(snapshot, IMPACT_SEMANTIC_MAX_REFERENCES, {
      includeOnActions: true,
    });
    semanticCache.set(snapshot, semantic);
  }
  const referenceIdentities = new Set<string>();
  const matchedReferences = input.includeReferences
    ? [...snapshot.index.references, ...(semantic?.references ?? [])]
        .filter(
          (entry) =>
            entry.to === symbol && (input.kind === undefined || entry.toKind === input.kind),
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
  // A complete index that neither defines nor uses the symbol answers not-found, never an
  // empty success.
  if (matchedDefinitions.length === 0 && matchedReferences.length === 0 && snapshot.complete) {
    const suggestions = nearestNames(
      symbol,
      new Set(
        snapshot.index.symbols
          .filter((entry) => input.kind === undefined || entry.kind === input.kind)
          .map(({ id }) => id),
      ),
    );
    throw new ServiceError(
      'SYMBOL_NOT_FOUND',
      `No indexed file defines${input.includeReferences ? ' or uses' : ''} ${symbol.slice(0, 256)}${input.kind === undefined ? '' : ` as a ${input.kind}`}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
      { symbol: symbol.slice(0, 256), suggestions },
    );
  }
  return boundResult({
    sourceScope: scopeOf(input, patterns),
    revision: snapshot.revision,
    complete: snapshot.complete,
    skippedSourceCount: snapshot.skippedSourceCount,
    definitionCount: snapshot.index.symbols.filter(
      (entry) => entry.id === symbol && (input.kind === undefined || entry.kind === input.kind),
    ).length,
    definitionsTruncated: matchedDefinitions.length > definitions.length,
    ...(matchedDefinitions.length === 0
      ? {
          suggestions: nearestNames(
            symbol,
            new Set(
              snapshot.index.symbols
                .filter((entry) => input.kind === undefined || entry.kind === input.kind)
                .map(({ id }) => id),
            ),
          ),
        }
      : {}),
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
  });
}
