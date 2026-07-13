import { createHash } from 'node:crypto';
import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { reachableEventNodeIds } from './algorithms.js';
import { discoverEventRoots, type EventRootDiscovery } from './queries.js';
import type {
  EventCondition,
  EventGraphEdge,
  EventGraphNode,
  EventGraphSnapshot,
  EventIssue,
  EventStateAccess,
  EventUnresolvedAnalysis,
} from './model.js';

export type EventComparisonChangeKind =
  | 'node_added'
  | 'node_removed'
  | 'node_changed'
  | 'edge_added'
  | 'edge_removed'
  | 'edge_changed'
  | 'state_access_added'
  | 'state_access_removed'
  | 'state_access_changed'
  | 'state_link_added'
  | 'state_link_removed'
  | 'state_link_changed'
  | 'diagnostic_added'
  | 'diagnostic_resolved'
  | 'unresolved_added'
  | 'unresolved_resolved'
  | 'caller_removed'
  | 'root_disconnected'
  | 'branch_disconnected'
  | 'terminal_disconnected';

export interface EventComparisonChange {
  id: string;
  kind: EventComparisonChangeKind;
  subjectId: string;
  beforeHash?: string;
  afterHash?: string;
  relatedIds: string[];
}

export interface EventGraphComparison {
  schemaVersion: 'event-comparison.v1';
  beforeRevision: string;
  afterRevision: string;
  beforeGraphHash: string;
  afterGraphHash: string;
  changes: EventComparisonChange[];
  addedNodeIds: string[];
  removedNodeIds: string[];
  changedNodeIds: string[];
  addedEdgeIds: string[];
  removedEdgeIds: string[];
  changedEdgeIds: string[];
  addedStateAccessIds: string[];
  removedStateAccessIds: string[];
  changedStateAccessIds: string[];
  addedStateLinkIds: string[];
  removedStateLinkIds: string[];
  changedStateLinkIds: string[];
  addedIssueIds: string[];
  resolvedIssueIds: string[];
  addedUnresolvedIds: string[];
  resolvedUnresolvedIds: string[];
  newlyDisconnectedRootIds: string[];
  newlyDisconnectedBranchIds: string[];
  newlyDisconnectedTerminalIds: string[];
}

function semanticNode(node: EventGraphNode): unknown {
  return {
    ...node,
    location: undefined,
    sourcePath: node.sourcePath,
  };
}

function semanticCondition(condition: EventCondition): unknown {
  return { ...condition, location: { path: condition.location.path } };
}

function semanticEdge(edge: EventGraphEdge): unknown {
  return {
    ...edge,
    location: { path: edge.location.path },
    conditions: edge.conditions.map(semanticCondition),
    provenance: edge.provenance.map(({ role, location }) => ({
      role,
      location: { path: location.path },
    })),
    weight:
      edge.weight === undefined
        ? undefined
        : { ...edge.weight, modifiers: edge.weight.modifiers.map(semanticCondition) },
  };
}

function semanticStateAccess(access: EventStateAccess): unknown {
  return {
    ...access,
    location: { path: access.location.path },
    conditions: access.conditions.map(semanticCondition),
  };
}

function semanticIssue(issue: EventIssue): unknown {
  return {
    ...issue,
    location: issue.location === undefined ? undefined : { path: issue.location.path },
    related: issue.related?.map(({ path }) => ({ path })),
    blockers: issue.blockers.map((blocker) => ({
      ...blocker,
      location: blocker.location === undefined ? undefined : { path: blocker.location.path },
    })),
  };
}

function issueId(issue: EventIssue): string {
  return `issue:${issue.code}:${hashCanonical(semanticIssue(issue)).slice(0, 24)}`;
}

function semanticUnresolved(item: EventUnresolvedAnalysis): unknown {
  return {
    ...item,
    location: item.location === undefined ? undefined : { path: item.location.path },
    blockers: item.blockers.map((blocker) => ({
      ...blocker,
      location: blocker.location === undefined ? undefined : { path: blocker.location.path },
    })),
  };
}

function semanticCollectionHash<T>(
  domain: string,
  values: readonly T[],
  identity: (value: T) => string,
  semantic: (value: T) => unknown,
  signal?: AbortSignal,
): string {
  const records = values.map((value, index) => {
    if ((index & 255) === 0) signal?.throwIfAborted();
    return { id: identity(value), hash: hashCanonical(semantic(value)) };
  });
  records.sort(
    (left, right) => compareCodeUnits(left.id, right.id) || compareCodeUnits(left.hash, right.hash),
  );
  const digest = createHash('sha256');
  const append = (value: string): void => {
    digest.update(String(Buffer.byteLength(value, 'utf8')));
    digest.update(':');
    digest.update(value);
  };
  append(domain);
  for (const [index, record] of records.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    append(record.id);
    append(record.hash);
  }
  signal?.throwIfAborted();
  return digest.digest('hex');
}

function graphHash(graph: EventGraphSnapshot, signal?: AbortSignal): string {
  signal?.throwIfAborted();
  return hashCanonical({
    schema: 'event-semantic-graph-hash.v2',
    nodes: semanticCollectionHash('nodes', graph.nodes, ({ id }) => id, semanticNode, signal),
    edges: semanticCollectionHash('edges', graph.edges, ({ id }) => id, semanticEdge, signal),
    stateAccesses: semanticCollectionHash(
      'state-accesses',
      graph.stateAccesses,
      ({ id }) => id,
      semanticStateAccess,
      signal,
    ),
    stateLinks: semanticCollectionHash(
      'state-links',
      graph.stateLinks,
      ({ id }) => id,
      (value) => value,
      signal,
    ),
    issues: semanticCollectionHash('issues', graph.issues, issueId, semanticIssue, signal),
    unresolved: semanticCollectionHash(
      'unresolved',
      graph.unresolved,
      ({ id }) => id,
      semanticUnresolved,
      signal,
    ),
  });
}

function mapById<T extends { id: string }>(
  values: readonly T[],
  signal?: AbortSignal,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const [index, value] of values.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    result.set(value.id, value);
  }
  return result;
}

function incomingCallers(graph: EventGraphSnapshot, signal?: AbortSignal): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const [index, edge] of graph.edges.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    if (edge.derived) continue;
    const values = callers.get(edge.to) ?? [];
    values.push(edge.from);
    callers.set(edge.to, values);
  }
  for (const values of callers.values()) values.sort(compareCodeUnits);
  return callers;
}

function rootEventIds(roots: EventRootDiscovery): Set<string> {
  return new Set(roots.knownRootEventIds);
}

function disconnectedByKind(
  before: EventGraphSnapshot,
  after: EventGraphSnapshot,
  kind: EventGraphNode['kind'],
  signal?: AbortSignal,
): string[] {
  const rootNodeIds = (graph: EventGraphSnapshot): string[] => {
    const roots = discoverEventRoots(graph, signal);
    return [...roots.entryPoints, ...roots.automaticEvents].map(({ id }) => id);
  };
  const beforeReachable = new Set(
    reachableEventNodeIds(before, rootNodeIds(before), 'downstream', false, signal),
  );
  const afterReachable = new Set(
    reachableEventNodeIds(after, rootNodeIds(after), 'downstream', false, signal),
  );
  const afterNodeIds = new Set(after.nodes.map(({ id }) => id));
  return before.nodes
    .filter((node, index) => {
      if ((index & 255) === 0) signal?.throwIfAborted();
      return node.kind === kind && afterNodeIds.has(node.id);
    })
    .filter(({ id }) => beforeReachable.has(id) && !afterReachable.has(id))
    .map(({ id }) => id)
    .sort(compareCodeUnits);
}

export function compareEventGraphs(
  before: EventGraphSnapshot,
  after: EventGraphSnapshot,
  signal?: AbortSignal,
): EventGraphComparison {
  signal?.throwIfAborted();
  let work = 0;
  const check = (): void => {
    if ((work++ & 255) === 0) signal?.throwIfAborted();
  };
  const beforeNodes = mapById(before.nodes, signal);
  const afterNodes = mapById(after.nodes, signal);
  const beforeEdges = mapById(before.edges, signal);
  const afterEdges = mapById(after.edges, signal);
  const beforeStateAccesses = mapById(before.stateAccesses, signal);
  const afterStateAccesses = mapById(after.stateAccesses, signal);
  const beforeStateLinks = mapById(before.stateLinks, signal);
  const afterStateLinks = mapById(after.stateLinks, signal);
  const beforeIssues = new Map(
    before.issues.map((issue) => {
      check();
      return [issueId(issue), issue];
    }),
  );
  const afterIssues = new Map(
    after.issues.map((issue) => {
      check();
      return [issueId(issue), issue];
    }),
  );
  const beforeUnresolved = mapById(before.unresolved, signal);
  const afterUnresolved = mapById(after.unresolved, signal);
  const addedNodeIds = [...afterNodes.keys()]
    .filter((id) => {
      check();
      return !beforeNodes.has(id);
    })
    .sort(compareCodeUnits);
  const removedNodeIds = [...beforeNodes.keys()]
    .filter((id) => {
      check();
      return !afterNodes.has(id);
    })
    .sort(compareCodeUnits);
  const changedNodeIds = [...beforeNodes.keys()]
    .filter((id) => {
      check();
      const current = afterNodes.get(id);
      return (
        current !== undefined &&
        hashCanonical(semanticNode(beforeNodes.get(id)!)) !== hashCanonical(semanticNode(current))
      );
    })
    .sort(compareCodeUnits);
  const addedEdgeIds = [...afterEdges.keys()]
    .filter((id) => {
      check();
      return !beforeEdges.has(id);
    })
    .sort(compareCodeUnits);
  const removedEdgeIds = [...beforeEdges.keys()]
    .filter((id) => {
      check();
      return !afterEdges.has(id);
    })
    .sort(compareCodeUnits);
  const changedEdgeIds = [...beforeEdges.keys()]
    .filter((id) => {
      check();
      const current = afterEdges.get(id);
      return (
        current !== undefined &&
        hashCanonical(semanticEdge(beforeEdges.get(id)!)) !== hashCanonical(semanticEdge(current))
      );
    })
    .sort(compareCodeUnits);
  const addedStateAccessIds = [...afterStateAccesses.keys()]
    .filter((id) => {
      check();
      return !beforeStateAccesses.has(id);
    })
    .sort(compareCodeUnits);
  const removedStateAccessIds = [...beforeStateAccesses.keys()]
    .filter((id) => {
      check();
      return !afterStateAccesses.has(id);
    })
    .sort(compareCodeUnits);
  const changedStateAccessIds = [...beforeStateAccesses.keys()]
    .filter((id) => {
      check();
      const current = afterStateAccesses.get(id);
      return (
        current !== undefined &&
        hashCanonical(semanticStateAccess(beforeStateAccesses.get(id)!)) !==
          hashCanonical(semanticStateAccess(current))
      );
    })
    .sort(compareCodeUnits);
  const addedStateLinkIds = [...afterStateLinks.keys()]
    .filter((id) => {
      check();
      return !beforeStateLinks.has(id);
    })
    .sort(compareCodeUnits);
  const removedStateLinkIds = [...beforeStateLinks.keys()]
    .filter((id) => {
      check();
      return !afterStateLinks.has(id);
    })
    .sort(compareCodeUnits);
  const changedStateLinkIds = [...beforeStateLinks.keys()]
    .filter((id) => {
      check();
      const current = afterStateLinks.get(id);
      return (
        current !== undefined && hashCanonical(beforeStateLinks.get(id)!) !== hashCanonical(current)
      );
    })
    .sort(compareCodeUnits);
  const addedIssueIds = [...afterIssues.keys()]
    .filter((id) => {
      check();
      return !beforeIssues.has(id);
    })
    .sort(compareCodeUnits);
  const resolvedIssueIds = [...beforeIssues.keys()]
    .filter((id) => {
      check();
      return !afterIssues.has(id);
    })
    .sort(compareCodeUnits);
  const addedUnresolvedIds = [...afterUnresolved.keys()]
    .filter((id) => {
      check();
      return !beforeUnresolved.has(id);
    })
    .sort(compareCodeUnits);
  const resolvedUnresolvedIds = [...beforeUnresolved.keys()]
    .filter((id) => {
      check();
      return !afterUnresolved.has(id);
    })
    .sort(compareCodeUnits);
  const beforeCallers = incomingCallers(before, signal);
  const afterCallers = incomingCallers(after, signal);
  const callerRemoved = [...afterNodes.keys()]
    .filter((id) => {
      check();
      return (beforeCallers.get(id)?.length ?? 0) > (afterCallers.get(id)?.length ?? 0);
    })
    .sort(compareCodeUnits);
  const beforeRoots = rootEventIds(discoverEventRoots(before, signal));
  const afterRoots = rootEventIds(discoverEventRoots(after, signal));
  const newlyDisconnectedRootIds = before.nodes
    .filter(
      ({ kind, eventId }) =>
        kind === 'event' &&
        eventId !== undefined &&
        beforeRoots.has(eventId) &&
        !afterRoots.has(eventId),
    )
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  const newlyDisconnectedBranchIds = disconnectedByKind(before, after, 'option', signal);
  const newlyDisconnectedTerminalIds = disconnectedByKind(before, after, 'terminal', signal);
  const changes: EventComparisonChange[] = [];
  const add = (
    kind: EventComparisonChangeKind,
    subjectId: string,
    beforeValue?: unknown,
    afterValue?: unknown,
    relatedIds: string[] = [],
  ): void => {
    changes.push({
      id: `${kind}:${subjectId}`,
      kind,
      subjectId,
      ...(beforeValue === undefined ? {} : { beforeHash: hashCanonical(beforeValue) }),
      ...(afterValue === undefined ? {} : { afterHash: hashCanonical(afterValue) }),
      relatedIds: [...relatedIds].sort(compareCodeUnits),
    });
  };
  for (const id of addedNodeIds) {
    check();
    add('node_added', id, undefined, semanticNode(afterNodes.get(id)!));
  }
  for (const id of removedNodeIds) {
    check();
    add('node_removed', id, semanticNode(beforeNodes.get(id)!));
  }
  for (const id of changedNodeIds) {
    check();
    add('node_changed', id, semanticNode(beforeNodes.get(id)!), semanticNode(afterNodes.get(id)!));
  }
  for (const id of addedEdgeIds) {
    check();
    add('edge_added', id, undefined, semanticEdge(afterEdges.get(id)!));
  }
  for (const id of removedEdgeIds) {
    check();
    add('edge_removed', id, semanticEdge(beforeEdges.get(id)!));
  }
  for (const id of changedEdgeIds) {
    check();
    add('edge_changed', id, semanticEdge(beforeEdges.get(id)!), semanticEdge(afterEdges.get(id)!));
  }
  for (const id of addedStateAccessIds) {
    check();
    add('state_access_added', id, undefined, semanticStateAccess(afterStateAccesses.get(id)!));
  }
  for (const id of removedStateAccessIds) {
    check();
    add('state_access_removed', id, semanticStateAccess(beforeStateAccesses.get(id)!));
  }
  for (const id of changedStateAccessIds) {
    check();
    add(
      'state_access_changed',
      id,
      semanticStateAccess(beforeStateAccesses.get(id)!),
      semanticStateAccess(afterStateAccesses.get(id)!),
    );
  }
  for (const id of addedStateLinkIds) {
    check();
    add('state_link_added', id, undefined, afterStateLinks.get(id)!);
  }
  for (const id of removedStateLinkIds) {
    check();
    add('state_link_removed', id, beforeStateLinks.get(id)!);
  }
  for (const id of changedStateLinkIds) {
    check();
    add('state_link_changed', id, beforeStateLinks.get(id)!, afterStateLinks.get(id)!);
  }
  for (const id of addedIssueIds) {
    check();
    add('diagnostic_added', id, undefined, semanticIssue(afterIssues.get(id)!));
  }
  for (const id of resolvedIssueIds) {
    check();
    add('diagnostic_resolved', id, semanticIssue(beforeIssues.get(id)!));
  }
  for (const id of addedUnresolvedIds) {
    check();
    add('unresolved_added', id, undefined, semanticUnresolved(afterUnresolved.get(id)!));
  }
  for (const id of resolvedUnresolvedIds) {
    check();
    add('unresolved_resolved', id, semanticUnresolved(beforeUnresolved.get(id)!));
  }
  for (const id of callerRemoved) {
    check();
    add('caller_removed', id, beforeCallers.get(id), afterCallers.get(id), [
      ...(beforeCallers.get(id) ?? []),
      ...(afterCallers.get(id) ?? []),
    ]);
  }
  for (const id of newlyDisconnectedRootIds) {
    check();
    add('root_disconnected', id);
  }
  for (const id of newlyDisconnectedBranchIds) {
    check();
    add('branch_disconnected', id);
  }
  for (const id of newlyDisconnectedTerminalIds) {
    check();
    add('terminal_disconnected', id);
  }
  changes.sort(
    (left, right) =>
      compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.subjectId, right.subjectId),
  );
  return {
    schemaVersion: 'event-comparison.v1',
    beforeRevision: before.revision,
    afterRevision: after.revision,
    beforeGraphHash: graphHash(before, signal),
    afterGraphHash: graphHash(after, signal),
    changes,
    addedNodeIds,
    removedNodeIds,
    changedNodeIds,
    addedEdgeIds,
    removedEdgeIds,
    changedEdgeIds,
    addedStateAccessIds,
    removedStateAccessIds,
    changedStateAccessIds,
    addedStateLinkIds,
    removedStateLinkIds,
    changedStateLinkIds,
    addedIssueIds,
    resolvedIssueIds,
    addedUnresolvedIds,
    resolvedUnresolvedIds,
    newlyDisconnectedRootIds,
    newlyDisconnectedBranchIds,
    newlyDisconnectedTerminalIds,
  };
}

export function eventGraphHash(graph: EventGraphSnapshot, signal?: AbortSignal): string {
  return graphHash(graph, signal);
}
