import { compareCodeUnits } from './canonical.js';
import type { SourceLocation } from './diagnostics.js';
import type { ScanSnapshot } from './engine.js';
import { scanImpactSemanticReferences } from './impact-semantic.js';
import type { ReferenceRecord, SymbolKind, SymbolRecord } from './index.js';

export interface ImpactSymbolSelector {
  kind: SymbolKind;
  id: string;
}

export interface ImpactQuery {
  symbols?: readonly ImpactSymbolSelector[];
  changedFiles?: readonly string[];
  maxNodes?: number;
  maxEdges?: number;
  maxDepth?: number;
}

export interface ImpactEdge {
  source: ImpactSymbolSelector & {
    path: string;
    rootKind: SymbolRecord['rootKind'];
    loadOrder: number;
  };
  target: ImpactSymbolSelector;
  targetDefinition?: Pick<SymbolRecord, 'path' | 'rootKind' | 'loadOrder' | 'location'>;
  referenceKind: string;
  accessRole: 'read' | 'write' | 'reference';
  path: string;
  location?: SourceLocation;
  targetStatus: 'active' | 'missing' | 'partial' | 'state_key';
}

export interface ImpactGraphResult {
  sourceRevision: string;
  complete: boolean;
  definitions: SymbolRecord[];
  missingSymbols: ImpactSymbolSelector[];
  directConsumers: ImpactEdge[];
  transitiveConsumers: ImpactEdge[];
  affectedFiles: string[];
  unresolved: Array<{ reference: ReferenceRecord; reason: string }>;
  dynamicReferences: ReturnType<typeof scanImpactSemanticReferences>['unresolved'];
  cycles: Array<{ from: ImpactSymbolSelector; to: ImpactSymbolSelector; path: string }>;
  coverage: {
    scannedSymbols: number;
    scannedReferences: number;
    reachedNodes: number;
    reachedEdges: number;
    omittedNodes: number;
    omittedEdges: number;
    omittedCycles: number;
    stoppedAtDepth: boolean;
    sourceComplete: boolean;
    skippedSourceCount: number;
  };
}

function symbolKey(kind: SymbolKind, id: string): string {
  return `${kind}\0${id}`;
}

function sourceKey(path: string, id: string): string {
  return `${path}\0${id}`;
}

function edgeOrder(left: ImpactEdge, right: ImpactEdge): number {
  return (
    compareCodeUnits(left.target.kind, right.target.kind) ||
    compareCodeUnits(left.target.id, right.target.id) ||
    compareCodeUnits(left.source.kind, right.source.kind) ||
    compareCodeUnits(left.source.id, right.source.id) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.referenceKind, right.referenceKind)
  );
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`Impact limit must be an integer between 1 and ${maximum}`);
  return value;
}

/** Finds every reached edge inside a strongly connected component without recursive call stacks. */
function reachedCycleEdges(
  reached: ReadonlySet<string>,
  edges: readonly ImpactEdge[],
): { cycles: ImpactGraphResult['cycles']; omittedCycles: number } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const from = symbolKey(edge.target.kind, edge.target.id);
    const to = symbolKey(edge.source.kind, edge.source.id);
    if (!reached.has(from) || !reached.has(to)) continue;
    const targets = outgoing.get(from) ?? [];
    targets.push(to);
    outgoing.set(from, targets);
    const sources = incoming.get(to) ?? [];
    sources.push(from);
    incoming.set(to, sources);
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const root of [...reached].sort(compareCodeUnits)) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack: Array<{ key: string; cursor: number }> = [{ key: root, cursor: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const next = outgoing.get(frame.key)?.[frame.cursor];
      if (next === undefined) {
        order.push(frame.key);
        stack.pop();
        continue;
      }
      frame.cursor += 1;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push({ key: next, cursor: 0 });
      }
    }
  }
  const componentByKey = new Map<string, number>();
  const componentSizes: number[] = [];
  for (const root of order.reverse()) {
    if (componentByKey.has(root)) continue;
    const component = componentSizes.length;
    let size = 0;
    const stack = [root];
    componentByKey.set(root, component);
    while (stack.length > 0) {
      const key = stack.pop()!;
      size += 1;
      for (const previous of incoming.get(key) ?? []) {
        if (componentByKey.has(previous)) continue;
        componentByKey.set(previous, component);
        stack.push(previous);
      }
    }
    componentSizes.push(size);
  }
  const cycles: ImpactGraphResult['cycles'] = [];
  const recorded = new Set<string>();
  let omittedCycles = 0;
  for (const edge of [...edges].sort(edgeOrder)) {
    const from = symbolKey(edge.target.kind, edge.target.id);
    const to = symbolKey(edge.source.kind, edge.source.id);
    const component = componentByKey.get(from);
    if (
      component === undefined ||
      component !== componentByKey.get(to) ||
      (componentSizes[component] === 1 && from !== to)
    )
      continue;
    const identity = `${from}\0${to}\0${edge.source.path}`;
    if (recorded.has(identity)) continue;
    recorded.add(identity);
    if (cycles.length < 1_000)
      cycles.push({
        from: edge.target,
        to: { kind: edge.source.kind, id: edge.source.id },
        path: edge.source.path,
      });
    else omittedCycles += 1;
  }
  return { cycles, omittedCycles };
}

/** Revision-pinned reverse consumer walk over the shared typed symbol index. */
export function inspectImpactGraph(snapshot: ScanSnapshot, query: ImpactQuery): ImpactGraphResult {
  const maxNodes = bounded(query.maxNodes, 5_000, 50_000);
  const maxEdges = bounded(query.maxEdges, 10_000, 100_000);
  const maxDepth = bounded(query.maxDepth, 12, 64);
  const semantic = scanImpactSemanticReferences(snapshot);
  const activeBySource = new Map<string, SymbolRecord[]>();
  const activeByKey = new Map<string, SymbolRecord>();
  const activeByPath = new Map<string, SymbolRecord[]>();
  for (const symbol of snapshot.index.symbols) {
    if (symbol.overridden) continue;
    const source = sourceKey(symbol.path, symbol.id);
    const sourceGroup = activeBySource.get(source) ?? [];
    sourceGroup.push(symbol);
    activeBySource.set(source, sourceGroup);
    activeByKey.set(symbolKey(symbol.kind, symbol.id), symbol);
    const pathGroup = activeByPath.get(symbol.path) ?? [];
    pathGroup.push(symbol);
    activeByPath.set(symbol.path, pathGroup);
  }
  const reverse = new Map<string, ImpactEdge[]>();
  const unresolvedByTarget = new Map<string, ImpactGraphResult['unresolved']>();
  const assetReferences: ReferenceRecord[] = snapshot.index.symbols.flatMap((symbol) =>
    symbol.kind === 'sprite' && !symbol.overridden && typeof symbol.metadata.texture === 'string'
      ? [
          {
            kind: 'sprite_texture',
            from: symbol.id,
            toKind: 'texture' as const,
            to: symbol.metadata.texture,
            path: symbol.path,
            ...(symbol.location === undefined ? {} : { location: symbol.location }),
          },
        ]
      : [],
  );
  for (const reference of [
    ...snapshot.index.references,
    ...semantic.references,
    ...assetReferences,
  ]) {
    const sources = activeBySource.get(sourceKey(reference.path, reference.from)) ?? [];
    const targetKey = symbolKey(reference.toKind, reference.to);
    if (sources.length !== 1) {
      const list = unresolvedByTarget.get(targetKey) ?? [];
      list.push({
        reference,
        reason:
          sources.length === 0
            ? 'Reference has no active enclosing symbol in the shared index'
            : 'Reference has more than one active enclosing symbol kind',
      });
      unresolvedByTarget.set(targetKey, list);
      continue;
    }
    const target = activeByKey.get(symbolKey(reference.toKind, reference.to));
    const edge: ImpactEdge = {
      source: {
        kind: sources[0]!.kind,
        id: sources[0]!.id,
        path: sources[0]!.path,
        rootKind: sources[0]!.rootKind,
        loadOrder: sources[0]!.loadOrder,
      },
      target: { kind: reference.toKind, id: reference.to },
      ...(target === undefined
        ? {}
        : {
            targetDefinition: {
              path: target.path,
              rootKind: target.rootKind,
              loadOrder: target.loadOrder,
              ...(target.location === undefined ? {} : { location: target.location }),
            },
          }),
      referenceKind: reference.kind,
      accessRole: reference.kind.endsWith('_read')
        ? 'read'
        : reference.kind.endsWith('_write')
          ? 'write'
          : 'reference',
      path: reference.path,
      ...(reference.location === undefined ? {} : { location: reference.location }),
      targetStatus: ['variable', 'flag', 'event_target'].includes(reference.toKind)
        ? 'state_key'
        : target === undefined
          ? snapshot.index.hasSkippedSourceForKind(reference.toKind)
            ? 'partial'
            : 'missing'
          : 'active',
    };
    const list = reverse.get(targetKey) ?? [];
    list.push(edge);
    reverse.set(targetKey, list);
  }
  for (const edges of reverse.values()) edges.sort(edgeOrder);
  const selectors = query.symbols ?? [];
  const selectorKeys = new Set(selectors.map(({ kind, id }) => symbolKey(kind, id)));
  const changedFiles = [...new Set(query.changedFiles ?? [])].sort(compareCodeUnits);
  const seeds = new Set(selectorKeys);
  for (const changedFile of changedFiles)
    for (const symbol of activeByPath.get(changedFile) ?? [])
      seeds.add(symbolKey(symbol.kind, symbol.id));
  const definitions = snapshot.index.symbols
    .filter((symbol) => selectorKeys.has(symbolKey(symbol.kind, symbol.id)))
    .sort(
      (left, right) =>
        compareCodeUnits(left.kind, right.kind) ||
        compareCodeUnits(left.id, right.id) ||
        right.loadOrder - left.loadOrder ||
        compareCodeUnits(left.path, right.path),
    );
  const missingSymbols = selectors.filter(
    ({ kind, id }) =>
      !activeByKey.has(symbolKey(kind, id)) &&
      !(['variable', 'flag', 'event_target'].includes(kind) && reverse.has(symbolKey(kind, id))),
  );
  const seedKeys = [...seeds].sort(compareCodeUnits);
  const visited = new Set(seedKeys.slice(0, maxNodes));
  const queue = [...visited].map((key) => ({ key, depth: 0 }));
  const directConsumers: ImpactEdge[] = [];
  const transitiveConsumers: ImpactEdge[] = [];
  const affectedFiles = new Set(changedFiles);
  for (const key of seeds) {
    const source = activeByKey.get(key);
    if (source !== undefined) affectedFiles.add(source.path);
  }
  const unresolved: ImpactGraphResult['unresolved'] = [];
  let reachedEdges = 0;
  let omittedEdges = 0;
  let omittedNodes = seedKeys.length - visited.size;
  let stoppedAtDepth = false;
  for (const { key, depth } of queue) {
    unresolved.push(...(unresolvedByTarget.get(key) ?? []));
    const consumers = reverse.get(key) ?? [];
    if (depth >= maxDepth) {
      if (consumers.length > 0) stoppedAtDepth = true;
      omittedEdges += consumers.length;
      continue;
    }
    for (const edge of consumers) {
      if (reachedEdges >= maxEdges) {
        omittedEdges += 1;
        continue;
      }
      reachedEdges += 1;
      affectedFiles.add(edge.source.path);
      if (depth === 0) directConsumers.push(edge);
      else transitiveConsumers.push(edge);
      const consumerKey = symbolKey(edge.source.kind, edge.source.id);
      if (visited.has(consumerKey)) continue;
      if (visited.size >= maxNodes) {
        omittedNodes += 1;
        continue;
      }
      visited.add(consumerKey);
      queue.push({ key: consumerKey, depth: depth + 1 });
    }
  }
  const { cycles, omittedCycles } = reachedCycleEdges(visited, [
    ...directConsumers,
    ...transitiveConsumers,
  ]);
  return {
    sourceRevision: snapshot.revision,
    complete:
      snapshot.complete &&
      semantic.complete &&
      omittedNodes === 0 &&
      omittedEdges === 0 &&
      omittedCycles === 0 &&
      !stoppedAtDepth &&
      unresolved.length === 0 &&
      semantic.unresolved.length === 0,
    definitions,
    missingSymbols,
    directConsumers: directConsumers.sort(edgeOrder),
    transitiveConsumers: transitiveConsumers.sort(edgeOrder),
    affectedFiles: [...affectedFiles].sort(compareCodeUnits),
    unresolved,
    dynamicReferences: semantic.unresolved,
    cycles,
    coverage: {
      scannedSymbols: snapshot.index.symbols.length,
      scannedReferences:
        snapshot.index.references.length + semantic.references.length + assetReferences.length,
      reachedNodes: visited.size,
      reachedEdges,
      omittedNodes,
      omittedEdges,
      omittedCycles,
      stoppedAtDepth,
      sourceComplete: snapshot.complete,
      skippedSourceCount: snapshot.skippedSourceCount,
    },
  };
}
