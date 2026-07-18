import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { sortDiagnostics, type Diagnostic, type SourceLocation } from '../core/diagnostics.js';
import type { ScanSnapshot } from '../core/engine.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  EVENT_GRAPH_MAX_EDGES,
  EVENT_GRAPH_MAX_HELPER_DEPTH,
  EVENT_GRAPH_MAX_HELPER_PROJECTIONS,
  EVENT_GRAPH_MAX_HELPER_STATE_PROJECTIONS,
  EVENT_GRAPH_MAX_ISSUES,
  EVENT_GRAPH_MAX_NODES,
  EVENT_GRAPH_MAX_STATE_ACCESSES,
  EVENT_GRAPH_MAX_STATE_LINK_CANDIDATES,
  EVENT_GRAPH_MAX_STATE_LINKS,
  EVENT_GRAPH_MAX_UNRESOLVED,
  EventAnalysisBudget,
} from './limits.js';
import {
  EVENT_GRAPH_PARSER_VERSION,
  EVENT_GRAPH_SCHEMA_VERSION,
  type EventConfidence,
  type EventGraphBuildOptions,
  type EventGraphEdge,
  type EventGraphNode,
  type EventGraphSnapshot,
  type EventIssue,
  type EventLocalisationRecord,
  type EventSourceFragment,
  type EventStateAccess,
  type EventStateLink,
  type EventType,
  type EventUnresolvedAnalysis,
} from './model.js';
import { iterativeStronglyConnectedComponents } from './scc.js';
import { analyzeEventSource, eventSemanticFragmentCacheKey } from './source-analysis.js';

interface EventCatalog {
  eventIds: Set<string>;
  eventTypes: Map<string, EventType>;
  helperIds: Set<string>;
  decisionIds: Set<string>;
  activeEventPaths: Map<string, string>;
  retainedEventPaths: Map<string, Set<string>>;
  activeHelperPaths: Map<string, string>;
  activeDecisionPaths: Map<string, string>;
  fingerprint: string;
}

interface MutableGraph {
  nodes: EventGraphNode[];
  edges: EventGraphEdge[];
  stateAccesses: EventStateAccess[];
  issues: EventIssue[];
  unresolved: EventUnresolvedAnalysis[];
  localisation: EventLocalisationRecord[];
}

const confidenceRank: Record<EventConfidence, number> = {
  confirmed: 0,
  high: 1,
  medium: 2,
  low: 3,
  unresolved: 4,
};

function stableUnique<T extends { id: string }>(values: readonly T[]): T[] {
  const retained = new Map<string, T>();
  for (const value of values) if (!retained.has(value.id)) retained.set(value.id, value);
  return [...retained.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function worstConfidence(...values: EventConfidence[]): EventConfidence {
  return values.reduce((worst, value) =>
    confidenceRank[value] > confidenceRank[worst] ? value : worst,
  );
}

function activeFiles(snapshot: ScanSnapshot): ScannedFile[] {
  return snapshot.files
    .filter(
      ({ relativePath, shadowedBy }) =>
        shadowedBy === undefined &&
        /\.(?:txt|ya?ml)$/iu.test(relativePath) &&
        !/(?:^|\/)(?:supply_nodes|railways|buildings|unitstacks|weatherpositions)\.txt$/iu.test(
          relativePath.replaceAll('\\', '/'),
        ),
    )
    .sort((left, right) => compareCodeUnits(left.displayPath, right.displayPath));
}

function catalogFor(snapshot: ScanSnapshot): EventCatalog {
  const unshadowedEventSymbols = snapshot.index
    .findAll('event')
    .filter(({ sourceShadowed }) => !sourceShadowed);
  const activeEventLoadOrder = new Map<string, number>();
  for (const symbol of unshadowedEventSymbols) {
    const current = activeEventLoadOrder.get(symbol.id);
    if (current === undefined || symbol.loadOrder > current) {
      activeEventLoadOrder.set(symbol.id, symbol.loadOrder);
    }
  }
  // Event IDs are global, but two definitions in different files at the same
  // active load level are an invalid duplicate rather than an overlay. Retain
  // every such definition so the semantic graph can report EVENT_DUPLICATE_ID.
  const eventSymbols = unshadowedEventSymbols
    .filter(({ id, loadOrder }) => activeEventLoadOrder.get(id) === loadOrder)
    .sort(
      (left, right) =>
        compareCodeUnits(left.id, right.id) || compareCodeUnits(left.path, right.path),
    );
  const helperSymbols = snapshot.index
    .findAll('scripted_effect')
    .filter(({ overridden, sourceShadowed }) => !overridden && !sourceShadowed);
  const decisionSymbols = snapshot.index
    .findAll('decision')
    .filter(({ overridden, sourceShadowed }) => !overridden && !sourceShadowed);
  const helperIds = new Set(helperSymbols.map(({ id }) => id));
  const decisionIds = new Set(decisionSymbols.map(({ id }) => id));
  const eventTypes = new Map<string, EventType>();
  for (const symbol of eventSymbols) {
    const eventType = symbol.metadata.eventType;
    if (
      (eventType === 'country_event' ||
        eventType === 'news_event' ||
        eventType === 'state_event' ||
        eventType === 'unit_leader_event' ||
        eventType === 'operative_leader_event') &&
      !eventTypes.has(symbol.id)
    ) {
      eventTypes.set(symbol.id, eventType);
    }
  }
  const eventIds = new Set(eventSymbols.map(({ id }) => id));
  const activeEventPaths = new Map<string, string>();
  const retainedEventPaths = new Map<string, Set<string>>();
  for (const { id, path } of eventSymbols) {
    if (!activeEventPaths.has(id)) activeEventPaths.set(id, path);
    const paths = retainedEventPaths.get(id) ?? new Set<string>();
    paths.add(path);
    retainedEventPaths.set(id, paths);
  }
  const activeHelperPaths = new Map(helperSymbols.map(({ id, path }) => [id, path]));
  const activeDecisionPaths = new Map(decisionSymbols.map(({ id, path }) => [id, path]));
  const fingerprint = hashCanonical({
    eventIds: [...eventIds].sort(compareCodeUnits),
    eventTypes: [...eventTypes].sort(([left], [right]) => compareCodeUnits(left, right)),
    helperIds: [...helperIds].sort(compareCodeUnits),
    decisionIds: [...decisionIds].sort(compareCodeUnits),
    activeEventPaths: [...activeEventPaths].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    ),
    retainedEventPaths: [...retainedEventPaths]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([id, paths]) => [id, [...paths].sort(compareCodeUnits)]),
    activeHelperPaths: [...activeHelperPaths].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    ),
    activeDecisionPaths: [...activeDecisionPaths].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    ),
    complete: snapshot.complete,
  });
  return {
    eventIds,
    eventTypes,
    helperIds,
    decisionIds,
    activeEventPaths,
    retainedEventPaths,
    activeHelperPaths,
    activeDecisionPaths,
    fingerprint,
  };
}

function locationKey(location: SourceLocation | undefined): string {
  return `${location?.path ?? ''}:${location?.start.offset ?? -1}:${location?.end.offset ?? -1}`;
}

function issueKey(issue: EventIssue): string {
  const subjectIds = issue.details.subjectIds;
  return hashCanonical({
    code: issue.code,
    classification: issue.classification,
    subjectIds: Array.isArray(subjectIds) ? subjectIds : [],
  });
}

function stableIssues(values: readonly EventIssue[]): EventIssue[] {
  const retained = new Map<string, EventIssue>();
  for (const value of values) {
    const key = issueKey(value);
    if (!retained.has(key)) retained.set(key, value);
  }
  return [...retained.values()].sort(
    (left, right) =>
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(locationKey(left.location), locationKey(right.location)) ||
      compareCodeUnits(issueKey(left), issueKey(right)),
  );
}

function normalizeIssueSubjects(graph: MutableGraph): void {
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  graph.issues = graph.issues.map((issue) => {
    const subjectIds = issue.details.subjectIds;
    if (!Array.isArray(subjectIds)) return issue;
    const mapped = subjectIds
      .flatMap((value) =>
        typeof value === 'string' ? [semanticOwnerId(value, nodes, parent)] : [],
      )
      .filter((id, _index, all) => {
        if (nodes.get(id)?.kind !== 'unresolved') return true;
        return !all.some((candidate) => nodes.get(candidate)?.kind !== 'unresolved');
      });
    return {
      ...issue,
      details: { ...issue.details, subjectIds: [...new Set(mapped)].sort(compareCodeUnits) },
    };
  });
}

function assertGraphLimit(current: number, maximum: number, code: string, label: string): void {
  if (current <= maximum) return;
  throw new ServiceError(code, `Event-chain ${label} exceeds the fixed result ceiling`, {
    count: current,
    maximum,
  });
}

function sourceHashes(files: readonly ScannedFile[]): Record<string, string> {
  return Object.fromEntries(
    files
      .map(({ displayPath, sha256 }) => [displayPath, sha256] as const)
      .sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

function addIssue(
  issues: EventIssue[],
  issue: Omit<EventIssue, 'blockers' | 'details' | 'location' | 'related'> & {
    blockers?: EventIssue['blockers'];
    details?: EventIssue['details'];
    subjectIds?: readonly string[];
    location?: SourceLocation | undefined;
    related?: SourceLocation[] | undefined;
  },
): void {
  const subjectIds = [...new Set(issue.subjectIds ?? [])].sort(compareCodeUnits);
  issues.push({
    code: issue.code,
    classification: issue.classification,
    severity: issue.severity,
    message: issue.message,
    confidence: issue.confidence,
    ...(issue.location === undefined ? {} : { location: issue.location }),
    ...(issue.related === undefined ? {} : { related: issue.related }),
    blockers: issue.blockers ?? [],
    details: {
      ...(issue.details ?? {}),
      ...(subjectIds.length === 0 ? {} : { subjectIds }),
    },
  });
}

function nodeById(nodes: readonly EventGraphNode[]): Map<string, EventGraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function optionParents(edges: readonly EventGraphEdge[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const edge of edges) {
    if (edge.reason === 'option_branch' && !result.has(edge.to)) result.set(edge.to, edge.from);
  }
  return result;
}

function semanticOwnerId(
  ownerId: string,
  nodes: ReadonlyMap<string, EventGraphNode>,
  optionParent: ReadonlyMap<string, string>,
): string {
  const node = nodes.get(ownerId);
  if (node?.kind === 'option') return optionParent.get(ownerId) ?? ownerId;
  const parent = node?.metadata.eventNodeId;
  if (typeof parent === 'string') return parent;
  const eventId = node?.metadata.eventId;
  if (typeof eventId === 'string') return `event:${eventId}`;
  return ownerId;
}

function mergeFragments(fragments: readonly EventSourceFragment[]): MutableGraph {
  return {
    nodes: fragments.flatMap(({ nodes }) => nodes),
    edges: fragments.flatMap(({ edges }) => edges),
    stateAccesses: fragments.flatMap(({ stateAccesses }) => stateAccesses),
    issues: fragments.flatMap(({ issues }) => issues),
    unresolved: fragments.flatMap(({ unresolved }) => unresolved),
    localisation: fragments.flatMap(({ localisation }) => localisation),
  };
}

function normalizedEntryReason(node: EventGraphNode): EventGraphEdge['reason'] | undefined {
  switch (node.metadata.entryKind) {
    case 'on_action':
      return 'on_action_entry';
    case 'focus':
      return 'focus_entry';
    case 'decision':
      return 'decision_entry';
    case 'mission':
      return 'mission_entry';
    case 'country_setup':
      return 'country_setup_entry';
    case 'state_setup':
      return 'state_setup_entry';
    case 'implicit_event_trigger':
      return 'implicit_event_entry';
    case 'other':
      return 'other_entry';
    default:
      return undefined;
  }
}

function normalizePublicEventNodeIds(graph: MutableGraph): void {
  const definitions = new Map<string, EventGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== 'event' || node.eventId === undefined) continue;
    const values = definitions.get(node.eventId) ?? [];
    values.push(node);
    definitions.set(node.eventId, values);
  }
  const replacements = new Map<string, string>();
  for (const [eventId, values] of [...definitions].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    values.sort(
      (left, right) =>
        compareCodeUnits(locationKey(left.location), locationKey(right.location)) ||
        compareCodeUnits(left.id, right.id),
    );
    values.forEach((node, index) => {
      replacements.set(
        node.id,
        index === 0
          ? `event:${eventId}`
          : `event:${eventId}:duplicate:${hashCanonical({
              location: locationKey(node.location),
              ordinal: index,
            }).slice(0, 16)}`,
      );
    });
  }
  if (replacements.size === 0) return;
  graph.nodes = graph.nodes.map((node) => ({ ...node, id: replacements.get(node.id) ?? node.id }));
  graph.edges = graph.edges.map((edge) => ({
    ...edge,
    from: replacements.get(edge.from) ?? edge.from,
    to: replacements.get(edge.to) ?? edge.to,
  }));
  graph.stateAccesses = graph.stateAccesses.map((access) => ({
    ...access,
    ownerId: replacements.get(access.ownerId) ?? access.ownerId,
  }));
  graph.unresolved = graph.unresolved.map((unresolved) => ({
    ...unresolved,
    ...(unresolved.ownerId === undefined
      ? {}
      : { ownerId: replacements.get(unresolved.ownerId) ?? unresolved.ownerId }),
  }));
  graph.issues = graph.issues.map((issue) => {
    const subjectIds = issue.details.subjectIds;
    if (!Array.isArray(subjectIds)) return issue;
    return {
      ...issue,
      details: {
        ...issue.details,
        subjectIds: subjectIds.map((value) =>
          typeof value === 'string' ? (replacements.get(value) ?? value) : value,
        ),
      },
    };
  });
}

/** Resolve file-local call placeholders against the active cross-file definition catalog. */
function normalizeCrossFileEdges(graph: MutableGraph): void {
  const definitions = new Map<string, EventGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== 'event' || node.eventId === undefined) continue;
    const values = definitions.get(node.eventId) ?? [];
    values.push(node);
    definitions.set(node.eventId, values);
  }
  for (const values of definitions.values()) {
    values.sort(
      (left, right) =>
        compareCodeUnits(locationKey(left.location), locationKey(right.location)) ||
        compareCodeUnits(left.id, right.id),
    );
  }
  const nodes = nodeById(graph.nodes);
  graph.edges = graph.edges.map((edge) => {
    const targetEventId = edge.metadata.targetEventId;
    const target =
      typeof targetEventId === 'string' ? definitions.get(targetEventId)?.[0]?.id : undefined;
    const fromNode = nodes.get(edge.from);
    const entryReason = fromNode?.kind === 'entry' ? normalizedEntryReason(fromNode) : undefined;
    const helperExpansion =
      fromNode?.kind === 'helper' &&
      typeof targetEventId === 'string' &&
      edge.reason !== 'unresolved_dynamic_reference';
    const reason = helperExpansion
      ? 'scripted_effect_expansion'
      : entryReason !== undefined && edge.reason !== 'scripted_effect_call'
        ? entryReason
        : edge.reason;
    if (target === undefined && reason === edge.reason) return edge;
    return {
      ...edge,
      ...(target === undefined ? {} : { to: target }),
      reason,
      provenance: edge.provenance.map((item) => ({
        ...item,
        role: helperExpansion ? 'dispatch' : entryReason === undefined ? item.role : 'entry',
      })),
    };
  });
}

function helperName(node: EventGraphNode): string {
  const name = node.metadata.name;
  if (typeof name === 'string') return name;
  return node.label || node.id.replace(/^helper:/u, '');
}

function helperProjections(graph: MutableGraph, budget: EventAnalysisBudget): EventGraphEdge[] {
  const nodes = nodeById(graph.nodes);
  const optionParent = optionParents(graph.edges);
  const outgoing = new Map<string, EventGraphEdge[]>();
  for (const edge of graph.edges) {
    const values = outgoing.get(edge.from) ?? [];
    values.push(edge);
    outgoing.set(edge.from, values);
  }
  for (const values of outgoing.values()) {
    values.sort((left, right) => compareCodeUnits(left.id, right.id));
  }
  const starts = graph.edges
    .filter(
      (edge) =>
        !edge.derived &&
        nodes.get(edge.to)?.kind === 'helper' &&
        nodes.get(edge.from)?.kind !== 'helper',
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const projected: EventGraphEdge[] = [];
  const projectedKeys = new Set<string>();
  const reportedCycles = new Set<string>();
  const reportedDepth = new Set<string>();

  interface Frame {
    currentId: string;
    helperStack: string[];
    edgeStack: EventGraphEdge[];
    visited: Set<string>;
  }

  for (const start of starts) {
    const first = nodes.get(start.to);
    if (first === undefined) continue;
    const caller = nodes.get(optionParent.get(start.from) ?? start.from);
    const callerScopeCandidate =
      start.scope?.source ?? caller?.metadata.expectedScope ?? caller?.metadata.scope;
    const callerScope =
      callerScopeCandidate === 'country' ||
      callerScopeCandidate === 'state' ||
      callerScopeCandidate === 'unit_leader' ||
      callerScopeCandidate === 'operative' ||
      callerScopeCandidate === 'character' ||
      callerScopeCandidate === 'global'
        ? callerScopeCandidate
        : 'unknown';
    const reachedHelpers = new Set([start.to]);
    const stack: Frame[] = [
      {
        currentId: start.to,
        helperStack: [helperName(first)],
        edgeStack: [start],
        visited: new Set([start.to]),
      },
    ];
    while (stack.length > 0) {
      budget.spend('helper_projection');
      const frame = stack.pop()!;
      const candidates = outgoing.get(frame.currentId) ?? [];
      for (const edge of [...candidates].reverse()) {
        if (edge.derived) continue;
        const target = nodes.get(edge.to);
        if (target?.kind === 'helper') {
          if (frame.visited.has(target.id)) {
            const cycleKey = `${start.id}:${target.id}`;
            if (!reportedCycles.has(cycleKey)) {
              reportedCycles.add(cycleKey);
              addIssue(graph.issues, {
                code: 'EVENT_HELPER_CYCLE',
                classification: 'unresolved_analysis',
                severity: 'warning',
                message: 'A scripted-effect cycle prevents complete helper expansion.',
                confidence: 'unresolved',
                location: edge.location,
                blockers: [
                  {
                    code: 'HELPER_CYCLE',
                    message: 'Static expansion stopped at the repeated scripted effect.',
                    location: edge.location,
                  },
                ],
                subjectIds: [start.from, ...frame.visited, target.id],
              });
            }
            continue;
          }
          if (frame.helperStack.length >= EVENT_GRAPH_MAX_HELPER_DEPTH) {
            const depthKey = `${start.id}:${target.id}`;
            if (!reportedDepth.has(depthKey)) {
              reportedDepth.add(depthKey);
              addIssue(graph.issues, {
                code: 'EVENT_HELPER_DEPTH_LIMIT',
                classification: 'unresolved_analysis',
                severity: 'blocker',
                message: 'Scripted-effect expansion reached the fixed nesting ceiling.',
                confidence: 'unresolved',
                location: edge.location,
                blockers: [
                  {
                    code: 'HELPER_DEPTH_LIMIT',
                    message: 'The helper chain is deeper than the supported static boundary.',
                    location: edge.location,
                    details: { maximumDepth: EVENT_GRAPH_MAX_HELPER_DEPTH },
                  },
                ],
                subjectIds: [start.from, target.id],
              });
            }
            continue;
          }
          // The expanded structural graph retains every alternate helper
          // route. The collapsed projection needs one deterministic proof per
          // call site and reachable helper, otherwise diamond-shaped helper
          // graphs grow exponentially on real vanilla workspaces.
          if (reachedHelpers.has(target.id)) continue;
          reachedHelpers.add(target.id);
          stack.push({
            currentId: target.id,
            helperStack: [...frame.helperStack, helperName(target)],
            edgeStack: [...frame.edgeStack, edge],
            visited: new Set([...frame.visited, target.id]),
          });
          continue;
        }
        const structural = [...frame.edgeStack, edge];
        const final = structural.at(-1)!;
        const projectionKey = `${start.id}\0${edge.to}`;
        if (projectedKeys.has(projectionKey)) continue;
        projectedKeys.add(projectionKey);
        if (projected.length >= EVENT_GRAPH_MAX_HELPER_PROJECTIONS) {
          addIssue(graph.issues, {
            code: 'EVENT_HELPER_PROJECTION_LIMIT',
            classification: 'unresolved_analysis',
            severity: 'blocker',
            message:
              'Collapsed helper projection reached its materialization ceiling; structural helper calls remain available.',
            confidence: 'unresolved',
            location: start.location,
            blockers: [
              {
                code: 'HELPER_PROJECTION_LIMIT',
                message:
                  'Use a bounded helper-expanded trace for paths omitted from the collapsed workspace graph.',
                location: start.location,
                details: { maximum: EVENT_GRAPH_MAX_HELPER_PROJECTIONS },
              },
            ],
            subjectIds: [start.from, start.to],
          });
          return stableUnique(projected);
        }
        projected.push({
          id: `edge:helper-projection:${hashCanonical({
            from: start.from,
            to: edge.to,
            edges: structural.map(({ id }) => id),
          }).slice(0, 32)}`,
          from: start.from,
          to: edge.to,
          reason: 'scripted_effect_expansion',
          conditions: structural.flatMap(({ conditions }) => conditions),
          helperStack: frame.helperStack,
          location: start.location,
          provenance: structural.flatMap(({ provenance }) => provenance),
          confidence: worstConfidence(...structural.map(({ confidence }) => confidence)),
          derived: true,
          ...(final.timing === undefined ? {} : { timing: final.timing }),
          ...(final.weight === undefined ? {} : { weight: final.weight }),
          ...(final.scope === undefined
            ? {}
            : {
                scope:
                  final.scope.source === 'unknown' && callerScope !== 'unknown'
                    ? { ...final.scope, source: callerScope, confidence: 'high' as const }
                    : final.scope,
              }),
          metadata: {
            structuralEdgeIds: structural.map(({ id }) => id),
            terminalDispatchLocation: locationKey(final.location),
          },
        });
      }
    }
  }
  return stableUnique(projected);
}

function projectHelperStateAccesses(
  graph: MutableGraph,
  budget: EventAnalysisBudget,
): EventStateAccess[] {
  const nodes = nodeById(graph.nodes);
  const optionParent = optionParents(graph.edges);
  const accesses = new Map<string, EventStateAccess[]>();
  for (const access of graph.stateAccesses) {
    const values = accesses.get(access.ownerId) ?? [];
    values.push(access);
    accesses.set(access.ownerId, values);
  }
  const outgoing = new Map<string, EventGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.derived) continue;
    const values = outgoing.get(edge.from) ?? [];
    values.push(edge);
    outgoing.set(edge.from, values);
  }
  for (const values of outgoing.values()) values.sort((a, b) => compareCodeUnits(a.id, b.id));
  const starts = graph.edges
    .filter(
      (edge) =>
        !edge.derived &&
        nodes.get(edge.to)?.kind === 'helper' &&
        nodes.get(edge.from)?.kind !== 'helper',
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const projected: EventStateAccess[] = [];
  for (const start of starts) {
    const first = nodes.get(start.to);
    if (first === undefined) continue;
    const caller = nodes.get(optionParent.get(start.from) ?? start.from);
    const callerScopeCandidate =
      start.scope?.source ?? caller?.metadata.expectedScope ?? caller?.metadata.scope;
    const callerScope =
      callerScopeCandidate === 'country' ||
      callerScopeCandidate === 'state' ||
      callerScopeCandidate === 'unit_leader' ||
      callerScopeCandidate === 'operative' ||
      callerScopeCandidate === 'character' ||
      callerScopeCandidate === 'global'
        ? callerScopeCandidate
        : 'unknown';
    const reachedHelpers = new Set([first.id]);
    const projectedAccesses = new Set<string>();
    const stack: Array<{
      helperId: string;
      helperStack: string[];
      callEdges: EventGraphEdge[];
      visited: Set<string>;
    }> = [
      {
        helperId: first.id,
        helperStack: [helperName(first)],
        callEdges: [start],
        visited: new Set([first.id]),
      },
    ];
    while (stack.length > 0) {
      budget.spend('helper_state_projection');
      const frame = stack.pop()!;
      for (const access of accesses.get(frame.helperId) ?? []) {
        const projectionKey = `${start.id}\0${access.id}`;
        if (projectedAccesses.has(projectionKey)) continue;
        projectedAccesses.add(projectionKey);
        if (
          projected.length >= EVENT_GRAPH_MAX_HELPER_STATE_PROJECTIONS ||
          graph.stateAccesses.length + projected.length >= EVENT_GRAPH_MAX_STATE_ACCESSES
        ) {
          addIssue(graph.issues, {
            code: 'EVENT_HELPER_STATE_PROJECTION_LIMIT',
            classification: 'unresolved_analysis',
            severity: 'blocker',
            message:
              'Helper state-flow projection reached its fixed materialization ceiling; structural helper evidence remains available.',
            confidence: 'unresolved',
            location: start.location,
            blockers: [
              {
                code: 'HELPER_STATE_PROJECTION_LIMIT',
                message:
                  'Use an expanded bounded helper trace for state evidence omitted from the collapsed workspace graph.',
                location: start.location,
                details: { maximum: EVENT_GRAPH_MAX_HELPER_STATE_PROJECTIONS },
              },
            ],
            subjectIds: [start.from, start.to],
          });
          return projected;
        }
        projected.push({
          ...access,
          id: `state:helper-projection:${hashCanonical({
            caller: start.from,
            access: access.id,
            edges: frame.callEdges.map(({ id }) => id),
          }).slice(0, 32)}`,
          ownerId: start.from,
          scope: access.scope === 'unknown' ? callerScope : access.scope,
          confidence: worstConfidence(
            access.confidence,
            ...frame.callEdges.map(({ confidence }) => confidence),
          ),
          helperStack: frame.helperStack,
          conditions: [
            ...frame.callEdges.flatMap(({ conditions }) => conditions),
            ...access.conditions,
          ],
          metadata: {
            ...access.metadata,
            projectedFromAccessId: access.id,
            structuralEdgeIds: frame.callEdges.map(({ id }) => id),
          },
        });
      }
      if (frame.helperStack.length >= EVENT_GRAPH_MAX_HELPER_DEPTH) continue;
      for (const edge of [...(outgoing.get(frame.helperId) ?? [])].reverse()) {
        const target = nodes.get(edge.to);
        if (
          target?.kind !== 'helper' ||
          frame.visited.has(target.id) ||
          reachedHelpers.has(target.id)
        )
          continue;
        reachedHelpers.add(target.id);
        stack.push({
          helperId: target.id,
          helperStack: [...frame.helperStack, helperName(target)],
          callEdges: [...frame.callEdges, edge],
          visited: new Set([...frame.visited, target.id]),
        });
      }
    }
  }
  return stableUnique(projected);
}

function fallbackLocation(node: EventGraphNode): SourceLocation {
  return (
    node.location ?? {
      path: node.sourcePath ?? '<event-graph>',
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
      symbol: node.eventId ?? node.label,
    }
  );
}

function addTerminalNodes(graph: MutableGraph): void {
  const nodes = nodeById(graph.nodes);
  const structuralOutgoing = new Set(
    graph.edges
      .filter(
        ({ derived, reason }) => !derived && reason !== 'option_branch' && reason !== 'terminal',
      )
      .map(({ from }) => from),
  );
  const optionParent = optionParents(graph.edges);
  const eventsWithOptions = new Set(optionParent.values());
  const stateOwners = new Set(graph.stateAccesses.map(({ ownerId }) => ownerId));
  const candidates = graph.nodes
    .filter(
      (node) =>
        (node.kind === 'option' && !structuralOutgoing.has(node.id)) ||
        (node.kind === 'event' &&
          !eventsWithOptions.has(node.id) &&
          !structuralOutgoing.has(node.id)),
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const owner of candidates) {
    const terminalId = `terminal:${owner.id}`;
    if (!nodes.has(terminalId)) {
      const terminal: EventGraphNode = {
        id: terminalId,
        kind: 'terminal',
        label: `${owner.label} exit`,
        ...(owner.eventId === undefined ? {} : { eventId: owner.eventId }),
        ...(owner.namespace === undefined ? {} : { namespace: owner.namespace }),
        ...(owner.sourcePath === undefined ? {} : { sourcePath: owner.sourcePath }),
        ...(owner.location === undefined ? {} : { location: owner.location }),
        metadata: { ownerId: owner.id },
      };
      graph.nodes.push(terminal);
      nodes.set(terminalId, terminal);
    }
    const location = fallbackLocation(owner);
    graph.edges.push({
      id: `edge:terminal:${hashCanonical({ from: owner.id, to: terminalId }).slice(0, 32)}`,
      from: owner.id,
      to: terminalId,
      reason: 'terminal',
      conditions: [],
      helperStack: [],
      location,
      provenance: [{ role: 'invocation', location }],
      confidence: 'confirmed',
      derived: false,
      metadata: {},
    });

    if (owner.kind !== 'option') continue;
    const explicitEffectState =
      owner.metadata.hasEffect ?? owner.metadata.hasEffects ?? owner.metadata.effectCount;
    if (explicitEffectState !== false && explicitEffectState !== 0 && stateOwners.has(owner.id))
      continue;
    if (explicitEffectState !== false && explicitEffectState !== 0) continue;
    addIssue(graph.issues, {
      code: 'EVENT_OPTION_DANGLING',
      classification: 'design_warning',
      severity: 'warning',
      message: 'An event option has no visible effect or dispatch.',
      confidence: 'confirmed',
      location: owner.location,
      subjectIds: [optionParent.get(owner.id) ?? owner.id],
    });
  }
}

function stateKey(value: Pick<EventStateAccess, 'kind' | 'name' | 'scope' | 'metadata'>): string {
  const scope = value.kind === 'variable' || value.kind === 'array' ? `:${value.scope}` : '';
  const storage =
    value.kind === 'saved_scope'
      ? `:${
          value.metadata.storage === 'global' || value.metadata.storage === 'local'
            ? value.metadata.storage
            : 'unknown'
        }`
      : '';
  return `${value.kind}:${value.name}${scope}${storage}`;
}

function compatibleProducerKeys(
  value: Pick<EventStateAccess, 'kind' | 'name' | 'scope' | 'metadata'>,
): string[] {
  if (
    value.kind !== 'saved_scope' ||
    value.metadata.storage === 'global' ||
    value.metadata.storage === 'local'
  ) {
    return [stateKey(value)];
  }
  return [
    `saved_scope:${value.name}:global`,
    `saved_scope:${value.name}:local`,
    `saved_scope:${value.name}:unknown`,
  ];
}

function hasUnknownSavedScopeStorage(value: Pick<EventStateAccess, 'kind' | 'metadata'>): boolean {
  return (
    value.kind === 'saved_scope' &&
    value.metadata.storage !== 'global' &&
    value.metadata.storage !== 'local'
  );
}

function collapsedFlowEdges(
  nodes: ReadonlyMap<string, EventGraphNode>,
  edges: readonly EventGraphEdge[],
): EventGraphEdge[] {
  return edges
    .filter((edge) => {
      if (edge.derived) return true;
      return nodes.get(edge.from)?.kind !== 'helper' && nodes.get(edge.to)?.kind !== 'helper';
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function stateLinksFor(graph: MutableGraph, budget: EventAnalysisBudget): EventStateLink[] {
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  const flow = collapsedFlowEdges(nodes, graph.edges);
  const outgoing = new Map<string, string[]>();
  const ownerIdSet = new Set<string>();
  for (const edge of flow) {
    const from = semanticOwnerId(edge.from, nodes, parent);
    const to = semanticOwnerId(edge.to, nodes, parent);
    ownerIdSet.add(from);
    ownerIdSet.add(to);
    const values = outgoing.get(from) ?? [];
    values.push(to);
    outgoing.set(from, values);
  }
  for (const access of graph.stateAccesses) {
    ownerIdSet.add(semanticOwnerId(access.ownerId, nodes, parent));
  }
  for (const [from, values] of outgoing) {
    const unique = [...new Set(values)].sort(compareCodeUnits);
    outgoing.set(from, unique);
  }
  const ownerIds = [...ownerIdSet].sort(compareCodeUnits);
  const ownerIndex = new Map(ownerIds.map((id, index) => [id, index]));
  const adjacency: number[][] = Array.from({ length: ownerIds.length }, () => []);
  for (const [from, targets] of outgoing) {
    const fromIndex = ownerIndex.get(from);
    if (fromIndex === undefined) continue;
    adjacency[fromIndex] = targets.flatMap((target) => {
      const targetIndex = ownerIndex.get(target);
      return targetIndex === undefined ? [] : [targetIndex];
    });
  }
  const bitsetWords = Math.ceil(ownerIds.length / 32);
  const reachabilityCacheMaximumBytes = 134_217_728;
  const reachabilityCacheMaximumEntries = Math.max(
    1,
    Math.floor(reachabilityCacheMaximumBytes / Math.max(4, bitsetWords * 4)),
  );
  const reachableCache = new Map<number, Uint32Array>();
  const traversalQueue = new Int32Array(ownerIds.length);
  const reachableFrom = (start: string): Uint32Array => {
    const startIndex = ownerIndex.get(start);
    if (startIndex === undefined) return new Uint32Array(bitsetWords);
    const cached = reachableCache.get(startIndex);
    if (cached !== undefined) {
      reachableCache.delete(startIndex);
      reachableCache.set(startIndex, cached);
      return cached;
    }
    const reached = new Uint32Array(bitsetWords);
    const startWord = startIndex >>> 5;
    reached[startWord] = (reached[startWord] ?? 0) | (1 << (startIndex & 31));
    let queueStart = 0;
    let queueEnd = 1;
    traversalQueue[0] = startIndex;
    while (queueStart < queueEnd) {
      budget.spend('state_reachability');
      const current = traversalQueue[queueStart++]!;
      for (const target of adjacency[current] ?? []) {
        const word = target >>> 5;
        const mask = 1 << (target & 31);
        if ((reached[word]! & mask) !== 0) continue;
        reached[word]! |= mask;
        traversalQueue[queueEnd++] = target;
      }
    }
    reachableCache.set(startIndex, reached);
    while (reachableCache.size > reachabilityCacheMaximumEntries) {
      const oldest = reachableCache.keys().next().value;
      if (oldest === undefined) break;
      reachableCache.delete(oldest);
    }
    return reached;
  };
  const isReachable = (from: string, to: string): boolean => {
    const targetIndex = ownerIndex.get(to);
    if (targetIndex === undefined) return false;
    const reached = reachableFrom(from);
    return (reached[targetIndex >>> 5]! & (1 << (targetIndex & 31))) !== 0;
  };

  const producers = new Map<string, Map<string, EventStateAccess>>();
  const consumers = new Map<string, Map<string, EventStateAccess>>();
  const retainOwnerAccess = (
    target: Map<string, Map<string, EventStateAccess>>,
    access: EventStateAccess,
  ): void => {
    const key = stateKey(access);
    const owner = semanticOwnerId(access.ownerId, nodes, parent);
    const values = target.get(key) ?? new Map<string, EventStateAccess>();
    const previous = values.get(owner);
    if (previous === undefined || compareCodeUnits(access.id, previous.id) < 0) {
      values.set(owner, access);
    }
    target.set(key, values);
  };
  for (const access of graph.stateAccesses) {
    if (
      access.access === 'write' ||
      access.access === 'read_write' ||
      access.access === 'replace'
    ) {
      retainOwnerAccess(producers, access);
    }
    if (access.access === 'read' || access.access === 'read_write') {
      retainOwnerAccess(consumers, access);
    }
  }
  const links: EventStateLink[] = [];
  let candidateCount = 0;
  for (const [, readsByOwner] of [...consumers].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const reads = [...readsByOwner.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
    for (const consumer of reads) {
      const writes = stableUnique(
        compatibleProducerKeys(consumer).flatMap((producerKey) => [
          ...(producers.get(producerKey)?.values() ?? []),
        ]),
      );
      const consumerOwner = semanticOwnerId(consumer.ownerId, nodes, parent);
      for (const producer of writes) {
        candidateCount += 1;
        if (candidateCount > EVENT_GRAPH_MAX_STATE_LINK_CANDIDATES) {
          addIssue(graph.issues, {
            code: 'EVENT_STATE_LINK_ANALYSIS_LIMIT',
            classification: 'unresolved_analysis',
            severity: 'blocker',
            message:
              'State-flow candidate analysis reached its fixed work ceiling; accesses remain available for bounded subject queries.',
            confidence: 'unresolved',
            location: consumer.location,
            blockers: [
              {
                code: 'STATE_LINK_ANALYSIS_LIMIT',
                message: 'Use stateSubject to inspect candidate producers for this value.',
                location: consumer.location,
                details: { maximum: EVENT_GRAPH_MAX_STATE_LINK_CANDIDATES },
              },
            ],
            subjectIds: [consumerOwner],
          });
          return stableUnique(links);
        }
        budget.spend('state_link');
        const producerOwner = semanticOwnerId(producer.ownerId, nodes, parent);
        const pathConfirmed = isReachable(producerOwner, consumerOwner);
        // Keep the shared graph as a proof graph, not a Cartesian inventory.
        // Non-reachable producers remain available in stateAccesses and can be
        // reported as unconfirmed candidates by a bounded subject query.
        if (!pathConfirmed) continue;
        if (links.length >= EVENT_GRAPH_MAX_STATE_LINKS) {
          addIssue(graph.issues, {
            code: 'EVENT_STATE_LINK_LIMIT',
            classification: 'unresolved_analysis',
            severity: 'blocker',
            message:
              'Confirmed state-flow links reached the fixed materialization ceiling; state accesses remain available for bounded queries.',
            confidence: 'unresolved',
            location: consumer.location,
            blockers: [
              {
                code: 'STATE_LINK_LIMIT',
                message: 'Use a stateSubject filter to inspect omitted producer candidates.',
                location: consumer.location,
                details: { maximum: EVENT_GRAPH_MAX_STATE_LINKS },
              },
            ],
            subjectIds: [consumerOwner],
          });
          return stableUnique(links);
        }
        const confidence = hasUnknownSavedScopeStorage(consumer)
          ? 'unresolved'
          : worstConfidence(producer.confidence, consumer.confidence);
        links.push({
          id: `state-link:${hashCanonical({ producer: producer.id, consumer: consumer.id }).slice(0, 32)}`,
          stateKind: consumer.kind,
          name: consumer.name,
          producerId: producer.id,
          consumerId: consumer.id,
          confidence,
          pathConfirmed,
        });
      }
    }
  }
  return stableUnique(links);
}

function ensureReferencedNodes(graph: MutableGraph): void {
  const nodes = nodeById(graph.nodes);
  for (const edge of graph.edges) {
    if (nodes.has(edge.to)) continue;
    const isEvent = edge.to.startsWith('event:');
    const isHelper = edge.to.startsWith('helper:');
    if (!isEvent && !isHelper) continue;
    const expression = edge.to.slice(edge.to.indexOf(':') + 1);
    const unresolvedKind = isEvent ? 'missing_event' : 'missing_helper';
    const node: EventGraphNode = {
      id: edge.to,
      kind: 'unresolved',
      label: `Missing ${isEvent ? 'event' : 'helper'}: ${expression}`,
      ...(isEvent ? { eventId: expression, namespace: expression.split('.')[0] } : {}),
      sourcePath: edge.location.path,
      location: edge.location,
      metadata: { expression, unresolvedKind },
    };
    graph.nodes.push(node);
    nodes.set(node.id, node);
    graph.unresolved.push({
      id: `unresolved:${unresolvedKind}:${hashCanonical({
        expression,
        ownerId: edge.from,
        location: locationKey(edge.location),
      }).slice(0, 32)}`,
      kind: unresolvedKind,
      expression,
      ownerId: edge.from,
      location: edge.location,
      confidence: 'confirmed',
      blockers: [
        {
          code: isEvent ? 'MISSING_EVENT' : 'MISSING_HELPER',
          message: `No active ${isEvent ? 'event' : 'scripted-effect'} definition matches the reference.`,
          location: edge.location,
        },
      ],
    });
  }
}

function duplicateAndReferenceIssues(graph: MutableGraph): void {
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  const eventGroups = new Map<string, EventGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== 'event' || node.eventId === undefined) continue;
    const values = eventGroups.get(node.eventId) ?? [];
    values.push(node);
    eventGroups.set(node.eventId, values);
  }
  for (const [eventId, definitions] of [...eventGroups].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    if (definitions.length < 2) continue;
    definitions.sort(
      (left, right) =>
        compareCodeUnits(locationKey(left.location), locationKey(right.location)) ||
        compareCodeUnits(left.id, right.id),
    );
    addIssue(graph.issues, {
      code: 'EVENT_DUPLICATE_ID',
      classification: 'confirmed_error',
      severity: 'error',
      message: `Multiple active event definitions use ${eventId}.`,
      confidence: 'confirmed',
      location: definitions[0]?.location,
      related: definitions
        .slice(1)
        .flatMap(({ location }) => (location === undefined ? [] : [location])),
      subjectIds: [`event:${eventId}`],
      details: { eventId, definitionCount: definitions.length },
    });
  }

  for (const unresolved of graph.unresolved) {
    if (unresolved.kind !== 'missing_event' && unresolved.kind !== 'missing_helper') continue;
    const ownerId =
      unresolved.ownerId === undefined
        ? undefined
        : semanticOwnerId(unresolved.ownerId, nodes, parent);
    addIssue(graph.issues, {
      code:
        unresolved.kind === 'missing_event' ? 'EVENT_REFERENCE_MISSING' : 'EVENT_HELPER_UNRESOLVED',
      classification:
        unresolved.kind === 'missing_event' ? 'confirmed_error' : 'unresolved_analysis',
      severity: unresolved.kind === 'missing_event' ? 'error' : 'warning',
      message:
        unresolved.kind === 'missing_event'
          ? `A call references missing event ${unresolved.expression}.`
          : `A call references unresolved scripted effect ${unresolved.expression}.`,
      confidence: unresolved.confidence,
      location: unresolved.location,
      blockers: unresolved.blockers,
      subjectIds: ownerId === undefined ? [] : [ownerId],
      details: { expression: unresolved.expression },
    });
  }
}

function structuralCallIssues(graph: MutableGraph, budget: EventAnalysisBudget): void {
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  const immediate = graph.edges
    .filter(({ derived, reason }) => !derived && reason === 'immediate_event_call')
    .map((edge) => ({
      edge,
      from: semanticOwnerId(edge.from, nodes, parent),
      to: semanticOwnerId(edge.to, nodes, parent),
    }))
    .filter(({ from, to }) => nodes.get(from)?.kind === 'event' && nodes.get(to)?.kind === 'event')
    .sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id));
  for (const { edge, from, to } of immediate) {
    if (from !== to) continue;
    addIssue(graph.issues, {
      code: 'EVENT_IMMEDIATE_SELF_CALL',
      classification: 'confirmed_error',
      severity: 'error',
      message: 'An event immediately calls itself without a visible delay.',
      confidence: edge.confidence,
      location: edge.location,
      subjectIds: [from],
    });
  }

  const outgoing = new Map<string, string[]>();
  for (const { from, to } of immediate.filter(({ from, to }) => from !== to)) {
    const values = outgoing.get(from) ?? [];
    values.push(to);
    outgoing.set(from, values);
  }
  for (const values of outgoing.values()) values.sort(compareCodeUnits);
  const components = iterativeStronglyConnectedComponents(
    immediate.flatMap(({ from, to }) => [from, to]),
    outgoing,
    () => budget.spend('immediate_cycle'),
  );
  for (const component of components.filter(({ length }) => length > 1)) {
    const componentSet = new Set(component);
    const evidence = immediate.find(
      ({ from, to }) => componentSet.has(from) && componentSet.has(to),
    )?.edge;
    addIssue(graph.issues, {
      code: 'EVENT_IMMEDIATE_CYCLE',
      classification: 'probable_defect',
      severity: 'error',
      message: 'An immediate event cycle can recurse without a visible scheduling boundary.',
      confidence: evidence?.confidence ?? 'high',
      location: evidence?.location,
      subjectIds: component,
    });
  }

  const collapsed = collapsedFlowEdges(nodes, graph.edges)
    .filter(({ reason }) => reason !== 'terminal' && reason !== 'option_branch')
    .map((edge) => ({
      edge,
      from: semanticOwnerId(edge.from, nodes, parent),
      to: semanticOwnerId(edge.to, nodes, parent),
    }))
    .filter(({ from, to }) => nodes.get(from)?.kind === 'event' && nodes.get(to)?.kind === 'event')
    .sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id));
  const cyclicOutgoing = new Map<string, string[]>();
  for (const { from, to } of collapsed) {
    const values = cyclicOutgoing.get(from) ?? [];
    values.push(to);
    cyclicOutgoing.set(from, values);
  }
  for (const values of cyclicOutgoing.values()) values.sort(compareCodeUnits);
  const flowComponents = iterativeStronglyConnectedComponents(
    collapsed.flatMap(({ from, to }) => [from, to]),
    cyclicOutgoing,
    () => budget.spend('event_cycle'),
  );
  for (const component of flowComponents) {
    const members = new Set(component);
    const internal = collapsed.filter(({ from, to }) => members.has(from) && members.has(to));
    const cyclic = component.length > 1 || internal.some(({ from, to }) => from === to);
    if (!cyclic) continue;
    const immediateOnly = internal.every(
      ({ edge }) => edge.reason === 'immediate_event_call' && edge.conditions.length === 0,
    );
    if (immediateOnly) continue;
    const gatedOrScheduled = internal.some(({ edge }) => {
      const scheduled =
        edge.reason === 'delayed_event_call' ||
        (edge.timing !== undefined &&
          edge.timing.mode !== 'immediate' &&
          edge.timing.mode !== 'unknown');
      const probabilistic =
        edge.reason === 'random_event_call' ||
        edge.reason === 'weighted_event_call' ||
        edge.weight !== undefined;
      return scheduled || probabilistic || edge.conditions.length > 0;
    });
    if (gatedOrScheduled) continue;
    const evidence = internal[0]?.edge;
    addIssue(graph.issues, {
      code: 'EVENT_CYCLE_GUARD_UNRESOLVED',
      classification: 'unresolved_analysis',
      severity: 'warning',
      message: 'A cyclic event route has no statically visible gate, delay, or random boundary.',
      confidence: 'low',
      location: evidence?.location,
      blockers: [
        {
          code: 'CYCLE_GUARD_NOT_PROVEN',
          message:
            'Static analysis cannot establish a scheduling or gating boundary for the cycle.',
          ...(evidence === undefined ? {} : { location: evidence.location }),
        },
      ],
      subjectIds: component,
    });
  }

  for (const edge of graph.edges.filter(
    ({ derived, weight }) => !derived && weight?.valid === false,
  )) {
    addIssue(graph.issues, {
      code: 'EVENT_RANDOM_WEIGHT_INVALID',
      classification: 'confirmed_error',
      severity: 'error',
      message: 'A random event branch has a missing or invalid weight.',
      confidence: edge.confidence,
      location: edge.location,
      subjectIds: [semanticOwnerId(edge.from, nodes, parent)],
      details: { edgeId: edge.id, value: edge.weight?.value ?? '' },
    });
  }

  for (const edge of graph.edges.filter(({ derived, scope, to }) => {
    const destination = nodes.get(to);
    const eventType =
      destination?.kind === 'event' && typeof destination.metadata.eventType === 'string'
        ? (destination.metadata.eventType as EventType)
        : undefined;
    return (
      !derived &&
      scope !== undefined &&
      scope.source !== 'unknown' &&
      scope.destination !== 'unknown' &&
      !callableFrom(eventType, scope)
    );
  })) {
    const ownerId = semanticOwnerId(edge.from, nodes, parent);
    if (nodes.get(ownerId)?.kind === 'entry') continue;
    addIssue(graph.issues, {
      code: 'EVENT_SCOPE_MISMATCH',
      classification: 'probable_defect',
      severity: 'warning',
      message: `An event call expects ${edge.scope!.destination} scope from ${edge.scope!.source} scope without a visible transition.`,
      confidence: edge.scope!.confidence,
      location: edge.location,
      subjectIds: [ownerId],
      details: {
        edgeId: edge.id,
        source: edge.scope!.source,
        destination: edge.scope!.destination,
      },
    });
  }
}

function localisationKeys(node: EventGraphNode): string[] {
  const candidates: unknown[] = [
    node.metadata.titleKey,
    node.metadata.descriptionKey,
    node.metadata.descKey,
    node.metadata.nameKey,
    node.metadata.localisationKey,
  ];
  const list = node.metadata.localisationKeys;
  if (Array.isArray(list)) candidates.push(...list);
  return [
    ...new Set(
      candidates.filter(
        (value): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:@-]+$/u.test(value),
      ),
    ),
  ].sort(compareCodeUnits);
}

function callableFrom(eventType: EventType | undefined, scope: EventGraphEdge['scope']): boolean {
  if (scope === undefined || eventType === undefined) return true;
  if (eventType === 'state_event') return scope.source === 'country' || scope.source === 'state';
  if (eventType === 'unit_leader_event') {
    return scope.source === 'character' || scope.source === 'unit_leader';
  }
  if (eventType === 'operative_leader_event') {
    return scope.source === 'character' || scope.source === 'operative';
  }
  return scope.source === 'country';
}

function localisationIssues(graph: MutableGraph): void {
  const available = new Set(graph.localisation.map(({ key }) => key));
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  const missingByOwner = new Map<
    string,
    { keys: Set<string>; fields: Set<string>; locations: SourceLocation[] }
  >();
  for (const node of graph.nodes.filter(({ kind }) => kind === 'event' || kind === 'option')) {
    const owner = semanticOwnerId(node.id, nodes, parent);
    const ownerNode = nodes.get(owner);
    if (ownerNode?.kind === 'event' && ownerNode.metadata.hidden === true) continue;
    const missing = localisationKeys(node).filter((key) => !available.has(key));
    const missingFields: string[] = [];
    if (node.kind === 'event') {
      if (node.metadata.hasTitle !== true) missingFields.push('title');
      if (node.metadata.hasDescription !== true) missingFields.push('description');
    } else if (node.metadata.hasName !== true) {
      missingFields.push('option_name');
    }
    if (missing.length === 0 && missingFields.length === 0) continue;
    const record = missingByOwner.get(owner) ?? {
      keys: new Set<string>(),
      fields: new Set<string>(),
      locations: [],
    };
    for (const key of missing) record.keys.add(key);
    for (const field of missingFields) record.fields.add(field);
    if (node.location !== undefined) record.locations.push(node.location);
    missingByOwner.set(owner, record);
  }
  for (const [owner, record] of [...missingByOwner].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const locations = record.locations.sort((left, right) =>
      compareCodeUnits(locationKey(left), locationKey(right)),
    );
    addIssue(graph.issues, {
      code: 'EVENT_LOCALISATION_MISSING',
      classification: 'probable_defect',
      severity: 'warning',
      message:
        'A visible event or option is missing required localisation fields or referenced keys.',
      confidence: 'high',
      location: locations[0],
      related: locations.slice(1),
      subjectIds: [owner],
      details: {
        missingKeys: [...record.keys].sort(compareCodeUnits),
        missingFields: [...record.fields].sort(compareCodeUnits),
      },
    });
  }
}

function unresolvedIssues(graph: MutableGraph): void {
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  for (const unresolved of graph.unresolved) {
    if (unresolved.kind !== 'dynamic_event' && unresolved.kind !== 'dynamic_helper') continue;
    const owner =
      unresolved.ownerId === undefined
        ? undefined
        : semanticOwnerId(unresolved.ownerId, nodes, parent);
    addIssue(graph.issues, {
      code:
        unresolved.kind === 'dynamic_event'
          ? 'EVENT_DYNAMIC_DISPATCH_UNRESOLVED'
          : 'EVENT_HELPER_UNRESOLVED',
      classification: 'unresolved_analysis',
      severity: 'warning',
      message:
        unresolved.kind === 'dynamic_event'
          ? 'A dynamic event expression cannot be resolved statically.'
          : 'A dynamic scripted-effect call cannot be resolved statically.',
      confidence: 'unresolved',
      location: unresolved.location,
      blockers: unresolved.blockers,
      subjectIds: owner === undefined ? [] : [owner],
      details: { expression: unresolved.expression },
    });
  }
}

function stateLifecycleIssues(
  graph: MutableGraph,
  stateLinks: readonly EventStateLink[],
  budget: EventAnalysisBudget,
): void {
  const nodes = nodeById(graph.nodes);
  const parent = optionParents(graph.edges);
  const producers = new Map<string, EventStateAccess[]>();
  const clearers = new Map<string, EventStateAccess[]>();
  const accessesById = new Map(graph.stateAccesses.map((access) => [access.id, access]));
  for (const access of graph.stateAccesses) {
    const key = stateKey(access);
    if (
      access.access === 'write' ||
      access.access === 'read_write' ||
      access.access === 'replace'
    ) {
      const values = producers.get(key) ?? [];
      values.push(access);
      producers.set(key, values);
    }
    if (access.access === 'clear') {
      const values = clearers.get(key) ?? [];
      values.push(access);
      clearers.set(key, values);
    }
  }

  for (const access of graph.stateAccesses) {
    if (access.access !== 'read' && access.access !== 'read_write') continue;
    if (
      compatibleProducerKeys(access).some(
        (producerKey) => (producers.get(producerKey) ?? []).length > 0,
      )
    )
      continue;
    const owner = semanticOwnerId(access.ownerId, nodes, parent);
    if (
      access.kind === 'event_target' ||
      access.kind === 'global_event_target' ||
      access.kind === 'saved_scope'
    ) {
      addIssue(graph.issues, {
        code: 'EVENT_TARGET_READ_BEFORE_SAVE',
        classification: 'probable_defect',
        severity: 'warning',
        message: `The ${access.kind.replaceAll('_', ' ')} ${access.name} is read without a visible producer.`,
        confidence: access.confidence,
        location: access.location,
        subjectIds: [owner],
        details: { stateKind: access.kind, name: access.name, accessId: access.id },
      });
      continue;
    }
    addIssue(graph.issues, {
      code: 'EVENT_GATE_WITHOUT_WRITER',
      classification: 'design_warning',
      severity: 'warning',
      message: `The branch reads ${access.kind.replaceAll('_', ' ')} ${access.name} without a visible writer.`,
      confidence: access.confidence,
      location: access.location,
      subjectIds: [owner],
      details: { stateKind: access.kind, name: access.name, accessId: access.id },
    });
  }

  for (const [key, writes] of [...producers].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    if (
      !key.startsWith('global_event_target:') ||
      (clearers.get(key) ?? []).length > 0 ||
      (clearers.get('global_event_target:*') ?? []).length > 0
    )
      continue;
    const ordered = [...writes].sort((left, right) => compareCodeUnits(left.id, right.id));
    addIssue(graph.issues, {
      code: 'EVENT_GLOBAL_TARGET_WITHOUT_CLEANUP',
      classification: 'design_warning',
      severity: 'warning',
      message: 'A global event target is saved without a visible cleanup.',
      confidence: worstConfidence(...ordered.map(({ confidence }) => confidence)),
      location: ordered[0]?.location,
      related: ordered.slice(1).map(({ location }) => location),
      subjectIds: ordered.map(({ ownerId }) => semanticOwnerId(ownerId, nodes, parent)),
      details: { name: key.slice('global_event_target:'.length) },
    });
  }

  const flow = collapsedFlowEdges(nodes, graph.edges);
  const outgoing = new Map<string, Array<{ to: string; delayed: boolean }>>();
  for (const edge of flow) {
    const from = semanticOwnerId(edge.from, nodes, parent);
    const to = semanticOwnerId(edge.to, nodes, parent);
    const values = outgoing.get(from) ?? [];
    values.push({
      to,
      delayed:
        edge.reason === 'delayed_event_call' ||
        (edge.timing !== undefined &&
          edge.timing.mode !== 'immediate' &&
          edge.timing.mode !== 'unknown'),
    });
    outgoing.set(from, values);
  }
  for (const values of outgoing.values()) {
    values.sort((left, right) => compareCodeUnits(left.to, right.to));
  }
  const delayedPathCache = new Map<string, boolean>();
  const hasDelayedPath = (from: string, to: string): boolean => {
    const key = `${from}\0${to}`;
    const cached = delayedPathCache.get(key);
    if (cached !== undefined) return cached;
    const queue: Array<{ id: string; delayed: boolean }> = [{ id: from, delayed: false }];
    const visited = new Set([`${from}:false`]);
    for (const current of queue) {
      budget.spend('delayed_state_path');
      for (const edge of outgoing.get(current.id) ?? []) {
        const delayed = current.delayed || edge.delayed;
        if (edge.to === to && delayed) {
          delayedPathCache.set(key, true);
          return true;
        }
        const state = `${edge.to}:${delayed}`;
        if (visited.has(state)) continue;
        visited.add(state);
        queue.push({ id: edge.to, delayed });
      }
    }
    delayedPathCache.set(key, false);
    return false;
  };

  for (const link of stateLinks) {
    if (link.stateKind !== 'event_target' || !link.pathConfirmed) continue;
    const producer = accessesById.get(link.producerId);
    const consumer = accessesById.get(link.consumerId);
    if (producer === undefined || consumer === undefined) continue;
    const producerOwner = semanticOwnerId(producer.ownerId, nodes, parent);
    const consumerOwner = semanticOwnerId(consumer.ownerId, nodes, parent);
    if (!hasDelayedPath(producerOwner, consumerOwner)) continue;
    addIssue(graph.issues, {
      code: 'EVENT_DELAYED_TRANSIENT_CONTEXT',
      classification: 'probable_defect',
      severity: 'warning',
      message: 'A delayed event route reads a regular event target whose context may not persist.',
      confidence: worstConfidence(producer.confidence, consumer.confidence),
      location: consumer.location,
      related: [producer.location],
      subjectIds: [producerOwner, consumerOwner],
      details: { name: link.name, stateLinkId: link.id },
    });
  }
}

function unreachableIssues(graph: MutableGraph, budget: EventAnalysisBudget): void {
  const nodes = nodeById(graph.nodes);
  const flow = collapsedFlowEdges(nodes, graph.edges);
  const roots = graph.nodes
    .filter(
      (node) =>
        node.kind === 'entry' ||
        (node.kind === 'event' &&
          (node.metadata.isTriggeredOnly === false || node.metadata.isTriggeredOnly === 'no')),
    )
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  const outgoing = new Map<string, string[]>();
  for (const edge of flow) {
    const values = outgoing.get(edge.from) ?? [];
    values.push(edge.to);
    outgoing.set(edge.from, values);
  }
  for (const values of outgoing.values()) values.sort(compareCodeUnits);
  const reachable = new Set(roots);
  const queue = [...roots];
  for (const current of queue) {
    budget.spend('unreachable_analysis');
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  for (const node of graph.nodes
    .filter((candidate) => candidate.kind === 'event' && !reachable.has(candidate.id))
    .sort((left, right) => compareCodeUnits(left.id, right.id))) {
    addIssue(graph.issues, {
      code: 'EVENT_UNREACHABLE_IN_SELECTION',
      classification: 'design_warning',
      severity: 'warning',
      message: 'An event has no statically discovered caller or root entry point.',
      confidence: 'high',
      location: node.location,
      subjectIds: [node.id],
    });
  }
}

function analyzeFragments(
  snapshot: ScanSnapshot,
  files: readonly ScannedFile[],
  catalog: EventCatalog,
  options: EventGraphBuildOptions,
  budget: EventAnalysisBudget,
): EventSourceFragment[] {
  const fragments: EventSourceFragment[] = [];
  for (const file of files) {
    budget.spend('source_fragment');
    if (snapshot.index.isSourceSkipped(file.displayPath)) continue;
    const cacheKey = eventSemanticFragmentCacheKey(file, catalog.fingerprint);
    let fragment = options.cache?.get(cacheKey);
    if (fragment === undefined) {
      fragment = analyzeEventSource(file, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        budget,
        knownEventIds: catalog.eventIds,
        knownEventTypes: catalog.eventTypes,
        knownHelperIds: catalog.helperIds,
        knownDecisionIds: catalog.decisionIds,
        activeEventPaths: catalog.activeEventPaths,
        retainedEventPaths: catalog.retainedEventPaths,
        activeHelperPaths: catalog.activeHelperPaths,
        activeDecisionPaths: catalog.activeDecisionPaths,
        inventoryComplete: snapshot.complete,
        catalogFingerprint: catalog.fingerprint,
      });
      options.cache?.set(cacheKey, fragment, file.bytes.length);
    }
    fragments.push(fragment);
  }
  return fragments.sort(
    (left, right) =>
      compareCodeUnits(left.sourcePath, right.sourcePath) ||
      compareCodeUnits(left.sourceHash, right.sourceHash),
  );
}

function partialInventoryEvidence(snapshot: ScanSnapshot): {
  diagnostics: Diagnostic[];
  unresolved: EventUnresolvedAnalysis[];
} {
  if (snapshot.complete) return { diagnostics: [], unresolved: [] };
  const diagnostic: Diagnostic = {
    code: 'EVENT_INVENTORY_PARTIAL',
    severity: 'blocker',
    category: 'reference',
    message: 'Event-chain analysis is partial because the shared source inventory is incomplete.',
    details: {
      skippedSourceCount: snapshot.skippedSourceCount,
      retainedSkippedSources: snapshot.skippedSources.length,
      skippedSources: snapshot.skippedSources.slice(0, 16).map(({ path, reasonCodes }) => ({
        path,
        reasonCodes,
      })),
    },
  };
  return {
    diagnostics: [diagnostic],
    unresolved: [
      {
        id: `unresolved:partial-source:${hashCanonical({
          revision: snapshot.revision,
          skipped: snapshot.skippedSourceCount,
        }).slice(0, 32)}`,
        kind: 'partial_source',
        expression: `${snapshot.skippedSourceCount} skipped source(s)`,
        confidence: 'unresolved',
        blockers: [
          {
            code: 'PARTIAL_SOURCE_INVENTORY',
            message: 'A skipped or over-limit source can contain additional definitions or calls.',
            details: { skippedSourceCount: snapshot.skippedSourceCount },
          },
        ],
      },
    ],
  };
}

function sortNodes(values: readonly EventGraphNode[]): EventGraphNode[] {
  return [...values].sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) ||
      compareCodeUnits(locationKey(left.location), locationKey(right.location)),
  );
}

function graphStatistics(
  nodes: readonly EventGraphNode[],
  edges: readonly EventGraphEdge[],
  stateAccesses: readonly EventStateAccess[],
  issues: readonly EventIssue[],
): EventGraphSnapshot['statistics'] {
  const count = (kind: EventGraphNode['kind']): number =>
    nodes.filter((node) => node.kind === kind).length;
  return {
    eventCount: count('event'),
    optionCount: count('option'),
    entryCount: count('entry'),
    helperCount: count('helper'),
    unresolvedNodeCount: count('unresolved'),
    terminalCount: count('terminal'),
    edgeCount: edges.length,
    derivedEdgeCount: edges.filter(({ derived }) => derived).length,
    stateAccessCount: stateAccesses.length,
    issueCount: issues.length,
  };
}

/**
 * Construct the deterministic event semantic graph from the engine's shared scan snapshot.
 * Parsing remains file-local; this stage owns cross-file resolution and static projections.
 */
export function buildEventGraph(
  snapshot: ScanSnapshot,
  options: EventGraphBuildOptions = {},
): EventGraphSnapshot {
  options.signal?.throwIfAborted();
  const budget = new EventAnalysisBudget(options.signal);
  const files = activeFiles(snapshot);
  const catalog = catalogFor(snapshot);
  const fragments = analyzeFragments(snapshot, files, catalog, options, budget);
  const graph = mergeFragments(fragments);
  const partial = partialInventoryEvidence(snapshot);
  for (const unresolved of partial.unresolved) graph.unresolved.push(unresolved);

  assertGraphLimit(graph.nodes.length, EVENT_GRAPH_MAX_NODES, 'EVENT_NODE_LIMIT', 'node count');
  assertGraphLimit(graph.edges.length, EVENT_GRAPH_MAX_EDGES, 'EVENT_EDGE_LIMIT', 'edge count');
  assertGraphLimit(
    graph.stateAccesses.length,
    EVENT_GRAPH_MAX_STATE_ACCESSES,
    'EVENT_STATE_ACCESS_LIMIT',
    'state-access count',
  );
  assertGraphLimit(
    graph.unresolved.length,
    EVENT_GRAPH_MAX_UNRESOLVED,
    'EVENT_UNRESOLVED_LIMIT',
    'unresolved-analysis count',
  );

  normalizePublicEventNodeIds(graph);
  normalizeCrossFileEdges(graph);
  ensureReferencedNodes(graph);
  if (options.projectHelpers !== false) {
    for (const edge of helperProjections(graph, budget)) graph.edges.push(edge);
    for (const access of projectHelperStateAccesses(graph, budget))
      graph.stateAccesses.push(access);
  }
  addTerminalNodes(graph);

  graph.nodes = sortNodes(graph.nodes);
  graph.edges = stableUnique(graph.edges);
  graph.stateAccesses = stableUnique(graph.stateAccesses);
  graph.unresolved = stableUnique(graph.unresolved);
  const stateLinks = stateLinksFor(graph, budget);

  duplicateAndReferenceIssues(graph);
  unresolvedIssues(graph);
  structuralCallIssues(graph, budget);
  localisationIssues(graph);
  stateLifecycleIssues(graph, stateLinks, budget);
  unreachableIssues(graph, budget);
  normalizeIssueSubjects(graph);
  graph.issues = stableIssues(graph.issues);

  assertGraphLimit(graph.nodes.length, EVENT_GRAPH_MAX_NODES, 'EVENT_NODE_LIMIT', 'node count');
  assertGraphLimit(graph.edges.length, EVENT_GRAPH_MAX_EDGES, 'EVENT_EDGE_LIMIT', 'edge count');
  assertGraphLimit(
    graph.stateAccesses.length,
    EVENT_GRAPH_MAX_STATE_ACCESSES,
    'EVENT_STATE_ACCESS_LIMIT',
    'state-access count',
  );
  assertGraphLimit(
    stateLinks.length,
    EVENT_GRAPH_MAX_STATE_LINKS,
    'EVENT_STATE_LINK_LIMIT',
    'state-link count',
  );
  assertGraphLimit(graph.issues.length, EVENT_GRAPH_MAX_ISSUES, 'EVENT_ISSUE_LIMIT', 'issue count');
  assertGraphLimit(
    graph.unresolved.length,
    EVENT_GRAPH_MAX_UNRESOLVED,
    'EVENT_UNRESOLVED_LIMIT',
    'unresolved-analysis count',
  );
  budget.check();

  const diagnostics = sortDiagnostics([...snapshot.diagnostics, ...partial.diagnostics]);
  const complete =
    snapshot.complete &&
    graph.unresolved.length === 0 &&
    !graph.issues.some(
      ({ classification, severity }) =>
        classification === 'unresolved_analysis' || severity === 'blocker',
    );
  const nodes = sortNodes(graph.nodes);
  const edges = stableUnique(graph.edges);
  const stateAccesses = stableUnique(graph.stateAccesses);
  const issues = stableIssues(graph.issues);
  const unresolved = stableUnique(graph.unresolved);
  return {
    schemaVersion: EVENT_GRAPH_SCHEMA_VERSION,
    parserVersion: EVENT_GRAPH_PARSER_VERSION,
    workspaceId: snapshot.workspaceId,
    workspaceIdentity:
      options.workspaceIdentity ?? hashCanonical({ workspaceId: snapshot.workspaceId }),
    revision: snapshot.revision,
    complete,
    sourceHashes: sourceHashes(files),
    filesScanned: files.map(({ displayPath }) => displayPath).sort(compareCodeUnits),
    skippedSourceCount: snapshot.skippedSourceCount,
    skippedSources: snapshot.skippedSources,
    nodes,
    edges,
    stateAccesses,
    stateLinks,
    issues,
    diagnostics,
    unresolved,
    statistics: graphStatistics(nodes, edges, stateAccesses, issues),
  };
}
