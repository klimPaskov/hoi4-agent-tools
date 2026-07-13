import { compareCodeUnits } from '../core/canonical.js';
import type { SourceLocation } from '../core/diagnostics.js';
import {
  eventFlowEdges,
  eventStronglyConnectedComponents,
  reachableEventNodeIds,
  shortestEventPath,
  traceEventGraph,
  type EventStronglyConnectedComponent,
  type EventTraceBoundary,
  type EventTraceResult,
} from './algorithms.js';
import type {
  EventGraphEdge,
  EventGraphNode,
  EventGraphSnapshot,
  EventIssue,
  EventStateAccess,
} from './model.js';

export interface EventFeatureManifest {
  id?: string;
  eventIds?: string[];
  namespaces?: string[];
  sourcePaths?: string[];
  nodeIds?: string[];
}

export type EventSelector =
  | { kind: 'event'; eventId: string }
  | { kind: 'namespace'; namespace: string }
  | { kind: 'file'; sourcePath: string }
  | { kind: 'source'; sourcePath: string; line: number; column?: number }
  | { kind: 'node'; nodeId: string }
  | { kind: 'manifest'; manifest: EventFeatureManifest };

export interface EventRootDiscovery {
  entryPoints: EventGraphNode[];
  automaticEvents: EventGraphNode[];
  knownRootEventIds: string[];
  callerlessTriggeredEvents: EventGraphNode[];
  stronglyConnectedComponents: EventStronglyConnectedComponent[];
}

export type EventPathFailureReason =
  'unreachable' | 'trace_boundary' | 'dynamic_dispatch' | 'unsupported_analysis';

export interface EventPathStep {
  index: number;
  node: EventGraphNode;
  via?: EventGraphEdge;
  requiredState: EventStateAccess[];
  producedState: EventStateAccess[];
}

export interface EventPathExplanation {
  found: boolean;
  fromNodeIds: string[];
  toNodeIds: string[];
  steps: EventPathStep[];
  failureReason?: EventPathFailureReason;
  failureMessage?: string;
  unresolvedAssumptions: Array<{
    nodeId?: string;
    edgeId?: string;
    expression?: string;
    blocker?: string;
  }>;
  boundary: { maxDepth: number; maxNodes: number; expandHelpers: boolean };
}

export interface EventStateFlowLink {
  id: string;
  kind: EventStateAccess['kind'];
  name: string;
  producerId: string;
  consumerId: string;
  producerOwnerId: string;
  consumerOwnerId: string;
  confidence: EventStateAccess['confidence'];
  pathConfirmed: boolean;
}

export interface EventStateFlowResult {
  accesses: EventStateAccess[];
  producers: EventStateAccess[];
  consumers: EventStateAccess[];
  clears: EventStateAccess[];
  links: EventStateFlowLink[];
  unproducedReads: EventStateAccess[];
  globalTargetLeaks: EventStateAccess[];
}

export interface EventImpactSubject {
  kind: 'event' | 'helper' | 'flag' | 'variable' | 'array' | 'event_target' | 'saved_scope';
  name: string;
}

export interface EventImpactResult {
  subject: EventImpactSubject;
  directNodeIds: string[];
  upstreamNodeIds: string[];
  downstreamNodeIds: string[];
  stateAccessIds: string[];
  affectedRootIds: string[];
  affectedTerminalIds: string[];
  removedRootIds: string[];
  wouldDisconnectNodeIds: string[];
  wouldDisconnectTerminalIds: string[];
  unresolvedNodeIds: string[];
}

function reachableFromRootsWithout(
  graph: EventGraphSnapshot,
  rootIds: readonly string[],
  removedNodeIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Set<string> {
  signal?.throwIfAborted();
  const retainedNodeIds = new Set(
    graph.nodes.filter(({ id }) => !removedNodeIds.has(id)).map(({ id }) => id),
  );
  const outgoing = new Map<string, string[]>();
  for (const [index, edge] of eventFlowEdges(graph, true).entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    if (
      removedNodeIds.has(edge.from) ||
      removedNodeIds.has(edge.to) ||
      !retainedNodeIds.has(edge.from) ||
      !retainedNodeIds.has(edge.to)
    ) {
      continue;
    }
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  for (const targets of outgoing.values()) targets.sort(compareCodeUnits);

  const reachable = new Set(
    [...new Set(rootIds)].filter((id) => retainedNodeIds.has(id)).sort(compareCodeUnits),
  );
  const queue = [...reachable];
  let cursor = 0;
  while (cursor < queue.length) {
    if ((cursor & 255) === 0) signal?.throwIfAborted();
    const current = queue[cursor++]!;
    for (const target of outgoing.get(current) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  signal?.throwIfAborted();
  return reachable;
}

function locationContains(
  location: SourceLocation | undefined,
  line: number,
  column?: number,
): boolean {
  if (location === undefined) return false;
  if (line < location.start.line || line > location.end.line) return false;
  if (column === undefined) return true;
  if (line === location.start.line && column < location.start.column) return false;
  if (line === location.end.line && column > location.end.column) return false;
  return true;
}

function pathMatches(actual: string | undefined, requested: string): boolean {
  if (actual === undefined) return false;
  const normalizedActual = actual.replaceAll('\\', '/').toLowerCase();
  const normalizedRequested = requested.replaceAll('\\', '/').toLowerCase();
  return (
    normalizedActual === normalizedRequested ||
    normalizedActual.endsWith(`:${normalizedRequested}`) ||
    normalizedActual.endsWith(`/${normalizedRequested}`)
  );
}

function manifestMatches(node: EventGraphNode, manifest: EventFeatureManifest): boolean {
  if (manifest.nodeIds?.includes(node.id) === true) return true;
  if (node.eventId !== undefined && manifest.eventIds?.includes(node.eventId) === true) return true;
  if (node.namespace !== undefined && manifest.namespaces?.includes(node.namespace) === true)
    return true;
  return (
    manifest.sourcePaths?.some((sourcePath) => pathMatches(node.sourcePath, sourcePath)) === true
  );
}

export function selectEventNodes(
  graph: EventGraphSnapshot,
  selector: EventSelector,
  signal?: AbortSignal,
): EventGraphNode[] {
  signal?.throwIfAborted();
  const matched: EventGraphNode[] = [];
  for (const [index, node] of graph.nodes.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    let selected: boolean;
    switch (selector.kind) {
      case 'event':
        selected = node.eventId === selector.eventId;
        break;
      case 'namespace':
        selected = node.namespace === selector.namespace;
        break;
      case 'file':
        selected = pathMatches(node.sourcePath ?? node.location?.path, selector.sourcePath);
        break;
      case 'source':
        selected =
          pathMatches(node.sourcePath ?? node.location?.path, selector.sourcePath) &&
          locationContains(node.location, selector.line, selector.column);
        break;
      case 'node':
        selected = node.id === selector.nodeId;
        break;
      case 'manifest':
        selected = manifestMatches(node, selector.manifest);
        break;
    }
    if (selected) matched.push(node);
  }
  signal?.throwIfAborted();
  return matched.sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function discoverEventRoots(
  graph: EventGraphSnapshot,
  signal?: AbortSignal,
): EventRootDiscovery {
  signal?.throwIfAborted();
  const edges = eventFlowEdges(graph, false);
  const incoming = new Map<string, number>();
  for (const [index, edge] of edges.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const eventFlowSources = new Set(edges.map(({ from }) => from));
  const entryPoints = graph.nodes
    .filter(({ id, kind }, index) => {
      if ((index & 255) === 0) signal?.throwIfAborted();
      return kind === 'entry' && eventFlowSources.has(id);
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const automaticEvents = graph.nodes
    .filter((node, index) => {
      if ((index & 255) === 0) signal?.throwIfAborted();
      return (
        node.kind === 'event' &&
        (node.metadata.isTriggeredOnly === false || node.metadata.automatic === true)
      );
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const entryIds = new Set(entryPoints.map(({ id }) => id));
  const rootEventNodeIds = new Set([
    ...automaticEvents.map(({ id }) => id),
    ...edges.filter(({ from }) => entryIds.has(from)).map(({ to }) => to),
  ]);
  const callerlessTriggeredEvents = graph.nodes
    .filter((node, index) => {
      if ((index & 255) === 0) signal?.throwIfAborted();
      return (
        node.kind === 'event' &&
        node.metadata.isTriggeredOnly === true &&
        (incoming.get(node.id) ?? 0) === 0
      );
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return {
    entryPoints,
    automaticEvents,
    knownRootEventIds: graph.nodes
      .filter(({ kind, id }) => kind === 'event' && rootEventNodeIds.has(id))
      .flatMap(({ eventId }) => (eventId === undefined ? [] : [eventId]))
      .sort(compareCodeUnits),
    callerlessTriggeredEvents,
    stronglyConnectedComponents: eventStronglyConnectedComponents(
      graph,
      false,
      undefined,
      signal,
    ).filter(({ cyclic }) => cyclic),
  };
}

export function traceSelectedEvents(
  graph: EventGraphSnapshot,
  selector: EventSelector,
  boundary: EventTraceBoundary,
  signal?: AbortSignal,
): EventTraceResult {
  return traceEventGraph(
    graph,
    selectEventNodes(graph, selector, signal).map(({ id }) => id),
    boundary,
    signal,
  );
}

function stateForNode(
  graph: EventGraphSnapshot,
  nodeId: string,
  accesses: readonly EventStateAccess['access'][],
): EventStateAccess[] {
  return graph.stateAccesses
    .filter(
      ({ ownerId, access }) =>
        ownerId === nodeId &&
        (accesses.includes(access) ||
          (access === 'read_write' && (accesses.includes('read') || accesses.includes('write')))),
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function relevantUnresolvedFrom(
  graph: EventGraphSnapshot,
  startIds: readonly string[],
  signal?: AbortSignal,
): EventGraphSnapshot['unresolved'] {
  const reachable = new Set(reachableEventNodeIds(graph, startIds, 'downstream', false, signal));
  const sourcePaths = new Set(
    graph.nodes
      .filter(({ id }) => reachable.has(id))
      .flatMap(({ sourcePath, location }) => [sourcePath, location?.path])
      .filter((value): value is string => value !== undefined),
  );
  return graph.unresolved.filter((item, index) => {
    if ((index & 255) === 0) signal?.throwIfAborted();
    if (reachable.has(item.id) || (item.ownerId !== undefined && reachable.has(item.ownerId))) {
      return true;
    }
    if (item.kind !== 'partial_source') return false;
    const path =
      item.location?.path ??
      item.blockers.find(({ location }) => location !== undefined)?.location?.path;
    if (path !== undefined && sourcePaths.has(path)) return true;
    return sourcePaths.has(item.expression);
  });
}

function pathUnresolvedAssumptions(
  graph: EventGraphSnapshot,
  nodeIds: readonly string[],
  edges: readonly EventGraphEdge[],
): EventPathExplanation['unresolvedAssumptions'] {
  const assumptions: EventPathExplanation['unresolvedAssumptions'] = [];
  for (const edge of edges) {
    if (edge.confidence !== 'confirmed') {
      assumptions.push({
        edgeId: edge.id,
        blocker:
          typeof edge.metadata.blocker === 'string'
            ? edge.metadata.blocker
            : `Edge confidence is ${edge.confidence}.`,
      });
    }
    if (
      edge.scope !== undefined &&
      (edge.scope.confidence !== 'confirmed' ||
        edge.scope.source === 'unknown' ||
        edge.scope.destination === 'unknown')
    ) {
      assumptions.push({
        edgeId: edge.id,
        ...(edge.scope.expression === undefined ? {} : { expression: edge.scope.expression }),
        blocker: `Scope transition ${edge.scope.source} to ${edge.scope.destination} is ${edge.scope.confidence}.`,
      });
    }
    if (edge.timing?.mode === 'unknown') {
      assumptions.push({
        edgeId: edge.id,
        ...(edge.timing.expression === undefined ? {} : { expression: edge.timing.expression }),
        blocker: 'Event timing could not be resolved statically.',
      });
    }
    if (edge.weight?.valid === false) {
      assumptions.push({
        edgeId: edge.id,
        expression: edge.weight.value,
        blocker: 'The event weight is missing or invalid.',
      });
    } else if (edge.weight?.valid === 'unknown') {
      assumptions.push({
        edgeId: edge.id,
        expression: edge.weight.value,
        blocker: 'The symbolic event weight is evaluated at runtime.',
      });
    }
    for (const condition of [...edge.conditions, ...(edge.weight?.modifiers ?? [])]) {
      if (condition.confidence === 'confirmed') continue;
      assumptions.push({
        edgeId: edge.id,
        expression: condition.expression,
        blocker: `${condition.kind.replaceAll('_', ' ')} confidence is ${condition.confidence}.`,
      });
    }
  }
  const pathNodes = new Set(nodeIds);
  for (const access of graph.stateAccesses) {
    if (!pathNodes.has(access.ownerId) || (!access.dynamic && access.confidence === 'confirmed'))
      continue;
    assumptions.push({
      nodeId: access.ownerId,
      expression: `${access.kind}:${access.name}`,
      blocker: access.dynamic
        ? 'A dynamic state name cannot be resolved statically.'
        : `State access confidence is ${access.confidence}.`,
    });
  }
  const retained = new Map<string, EventPathExplanation['unresolvedAssumptions'][number]>();
  for (const assumption of assumptions) {
    const key = JSON.stringify(assumption);
    if (!retained.has(key)) retained.set(key, assumption);
  }
  return [...retained.values()];
}

export function explainEventPath(
  graph: EventGraphSnapshot,
  from: EventSelector,
  to: EventSelector,
  boundary: { maxDepth: number; maxNodes: number; expandHelpers: boolean },
  signal?: AbortSignal,
): EventPathExplanation {
  const fromNodes = selectEventNodes(graph, from, signal);
  const toNodes = selectEventNodes(graph, to, signal);
  const fromNodeIds = fromNodes.map(({ id }) => id);
  const toNodeIds = toNodes.map(({ id }) => id);
  if (fromNodeIds.length === 0 || toNodeIds.length === 0) {
    return {
      found: false,
      fromNodeIds,
      toNodeIds,
      steps: [],
      failureReason: 'unsupported_analysis',
      failureMessage:
        fromNodeIds.length === 0
          ? 'The source selector did not resolve to an indexed event-chain node.'
          : 'The destination selector did not resolve to an indexed event-chain node.',
      unresolvedAssumptions: [],
      boundary,
    };
  }
  const path = shortestEventPath(graph, fromNodeIds, toNodeIds, boundary, signal);
  if (path !== undefined) {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const steps = path.nodeIds.flatMap((nodeId, index) => {
      const node = byId.get(nodeId);
      if (node === undefined) return [];
      const via = index === 0 ? undefined : path.edges[index - 1];
      return [
        {
          index,
          node,
          ...(via === undefined ? {} : { via }),
          requiredState: stateForNode(graph, nodeId, ['read']),
          producedState: stateForNode(graph, nodeId, ['write', 'replace', 'clear']),
        },
      ];
    });
    return {
      found: true,
      fromNodeIds,
      toNodeIds,
      steps,
      unresolvedAssumptions: pathUnresolvedAssumptions(graph, path.nodeIds, path.edges),
      boundary,
    };
  }
  const unrestricted = shortestEventPath(
    graph,
    fromNodeIds,
    toNodeIds,
    {
      expandHelpers: boundary.expandHelpers,
      maxDepth: Math.max(graph.nodes.length, boundary.maxDepth),
      maxNodes: Math.max(graph.nodes.length, boundary.maxNodes),
    },
    signal,
  );
  let failureReason: EventPathFailureReason;
  let failureMessage: string;
  const relevantUnresolved = relevantUnresolvedFrom(graph, fromNodeIds, signal);
  const hasDynamicDispatch = relevantUnresolved.some(
    ({ kind }) => kind === 'dynamic_event' || kind === 'dynamic_helper',
  );
  const hasUnsupportedAnalysis = relevantUnresolved.some(
    ({ kind }) => kind !== 'dynamic_event' && kind !== 'dynamic_helper',
  );
  const inventoryPartial =
    graph.skippedSourceCount > 0 ||
    graph.diagnostics.some(({ code }) => code === 'EVENT_INVENTORY_PARTIAL');
  if (unrestricted !== undefined) {
    failureReason = 'trace_boundary';
    failureMessage = 'A path exists outside the requested trace boundary.';
  } else if (hasUnsupportedAnalysis) {
    failureReason = 'unsupported_analysis';
    failureMessage = 'Reachable missing or unsupported source prevents a conclusive path result.';
  } else if (hasDynamicDispatch) {
    failureReason = 'dynamic_dispatch';
    failureMessage = 'A statically unresolved dispatch may connect the selected route.';
  } else if (inventoryPartial) {
    failureReason = 'unsupported_analysis';
    failureMessage = 'Skipped or unsupported source prevents a conclusive reachability result.';
  } else {
    failureReason = 'unreachable';
    failureMessage = 'No statically proven path connects the selected nodes.';
  }
  return {
    found: false,
    fromNodeIds,
    toNodeIds,
    steps: [],
    failureReason,
    failureMessage,
    unresolvedAssumptions: relevantUnresolved.map((item) => ({
      ...(item.ownerId === undefined ? {} : { nodeId: item.ownerId }),
      expression: item.expression,
      ...(item.blockers[0] === undefined ? {} : { blocker: item.blockers[0].message }),
    })),
    boundary,
  };
}

function stateKey(access: Pick<EventStateAccess, 'kind' | 'name' | 'scope' | 'metadata'>): string {
  const scope = access.kind === 'variable' || access.kind === 'array' ? `:${access.scope}` : '';
  const storage =
    access.kind === 'saved_scope'
      ? `:${
          access.metadata.storage === 'global' || access.metadata.storage === 'local'
            ? access.metadata.storage
            : 'unknown'
        }`
      : '';
  return `${access.kind}:${access.name}${scope}${storage}`;
}

function compatibleProducerKeys(
  access: Pick<EventStateAccess, 'kind' | 'name' | 'scope' | 'metadata'>,
): string[] {
  if (
    access.kind !== 'saved_scope' ||
    access.metadata.storage === 'global' ||
    access.metadata.storage === 'local'
  ) {
    return [stateKey(access)];
  }
  return [
    `saved_scope:${access.name}:global`,
    `saved_scope:${access.name}:local`,
    `saved_scope:${access.name}:unknown`,
  ];
}

function hasUnknownSavedScopeStorage(access: Pick<EventStateAccess, 'kind' | 'metadata'>): boolean {
  return (
    access.kind === 'saved_scope' &&
    access.metadata.storage !== 'global' &&
    access.metadata.storage !== 'local'
  );
}

function compatibleProducers(
  producers: ReadonlyMap<string, EventStateAccess[]>,
  consumer: Pick<EventStateAccess, 'kind' | 'name' | 'scope' | 'metadata'>,
): EventStateAccess[] {
  const compatible = new Map<string, EventStateAccess>();
  for (const key of compatibleProducerKeys(consumer)) {
    for (const producer of producers.get(key) ?? []) compatible.set(producer.id, producer);
  }
  return [...compatible.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function logicalStateKey(access: Pick<EventStateAccess, 'kind' | 'name'>): string {
  return `${access.kind}:${access.name}`;
}

function selectedOwnershipIds(
  graph: EventGraphSnapshot,
  selector: EventSelector,
  signal?: AbortSignal,
): Set<string> {
  const selected = new Set(selectEventNodes(graph, selector, signal).map(({ id }) => id));
  const ownershipEdges = graph.edges
    .filter(
      ({ derived, reason }) =>
        !derived && (reason === 'option_branch' || reason === 'scripted_effect_call'),
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  let changed = true;
  let visits = 0;
  while (changed) {
    changed = false;
    for (const edge of ownershipEdges) {
      if ((visits++ & 255) === 0) signal?.throwIfAborted();
      if (selected.has(edge.from) && !selected.has(edge.to)) {
        selected.add(edge.to);
        changed = true;
      }
      if (edge.reason === 'option_branch' && selected.has(edge.to) && !selected.has(edge.from)) {
        selected.add(edge.from);
        changed = true;
      }
    }
  }
  return selected;
}

export function inspectEventStateFlow(
  graph: EventGraphSnapshot,
  selector?: EventSelector,
  subject?: { kind: EventStateAccess['kind']; name: string },
  signal?: AbortSignal,
): EventStateFlowResult {
  signal?.throwIfAborted();
  const selectedOwners =
    selector === undefined ? undefined : selectedOwnershipIds(graph, selector, signal);
  const selectedAccesses = graph.stateAccesses
    .filter((access, index) => {
      if ((index & 255) === 0) signal?.throwIfAborted();
      return (
        (selectedOwners === undefined || selectedOwners.has(access.ownerId)) &&
        (subject === undefined ||
          (access.kind === subject.kind &&
            (access.name === subject.name ||
              (access.kind === 'global_event_target' &&
                access.access === 'clear' &&
                access.name === '*'))))
      );
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const allProducers = new Map<string, EventStateAccess[]>();
  const logicalProducers = new Map<string, EventStateAccess[]>();
  for (const [index, access] of graph.stateAccesses.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    if (access.access !== 'write' && access.access !== 'read_write' && access.access !== 'replace')
      continue;
    const values = allProducers.get(stateKey(access)) ?? [];
    values.push(access);
    allProducers.set(stateKey(access), values);
    const logical = logicalProducers.get(logicalStateKey(access)) ?? [];
    logical.push(access);
    logicalProducers.set(logicalStateKey(access), logical);
  }
  const accessById = new Map(graph.stateAccesses.map((access) => [access.id, access]));
  const selectedAccessIds = new Set(selectedAccesses.map(({ id }) => id));
  const links: EventStateFlowLink[] = graph.stateLinks.flatMap((link, index) => {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const producer = accessById.get(link.producerId);
    const consumer = accessById.get(link.consumerId);
    if (
      producer === undefined ||
      consumer === undefined ||
      !selectedAccessIds.has(consumer.id) ||
      (subject !== undefined && (link.stateKind !== subject.kind || link.name !== subject.name))
    )
      return [];
    return [
      {
        id: link.id,
        kind: link.stateKind,
        name: link.name,
        producerId: producer.id,
        consumerId: consumer.id,
        producerOwnerId: producer.ownerId,
        consumerOwnerId: consumer.ownerId,
        confidence: link.confidence,
        pathConfirmed: link.pathConfirmed,
      },
    ];
  });
  const linkedConsumers = new Set(links.map(({ consumerId }) => consumerId));
  let visits = 0;
  for (const consumer of selectedAccesses.filter(
    ({ access }) => access === 'read' || access === 'read_write',
  )) {
    if ((visits++ & 255) === 0) signal?.throwIfAborted();
    if (linkedConsumers.has(consumer.id)) continue;
    const compatible = compatibleProducers(allProducers, consumer);
    for (const producer of compatible) {
      links.push({
        id: `${
          hasUnknownSavedScopeStorage(consumer) ? 'state-link:storage-ambiguous' : 'state-link'
        }:${producer.id}:${consumer.id}`,
        kind: consumer.kind,
        name: consumer.name,
        producerId: producer.id,
        consumerId: consumer.id,
        producerOwnerId: producer.ownerId,
        consumerOwnerId: consumer.ownerId,
        confidence: hasUnknownSavedScopeStorage(consumer)
          ? 'unresolved'
          : producer.confidence === 'confirmed' && consumer.confidence === 'confirmed'
            ? 'confirmed'
            : consumer.confidence,
        pathConfirmed: false,
      });
    }
    if (compatible.length === 0 && (consumer.kind === 'variable' || consumer.kind === 'array')) {
      for (const producer of logicalProducers.get(logicalStateKey(consumer)) ?? []) {
        links.push({
          id: `state-link:scope-ambiguous:${producer.id}:${consumer.id}`,
          kind: consumer.kind,
          name: consumer.name,
          producerId: producer.id,
          consumerId: consumer.id,
          producerOwnerId: producer.ownerId,
          consumerOwnerId: consumer.ownerId,
          confidence: 'unresolved',
          pathConfirmed: false,
        });
      }
    }
  }
  const evidenceIds = new Set([
    ...selectedAccesses.map(({ id }) => id),
    ...links.map(({ producerId }) => producerId),
  ]);
  const accesses = graph.stateAccesses
    .filter(({ id }, index) => {
      if ((index & 255) === 0) signal?.throwIfAborted();
      return evidenceIds.has(id);
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const clearKeys = new Set(
    graph.stateAccesses
      .filter(({ access }, index) => {
        if ((index & 255) === 0) signal?.throwIfAborted();
        return access === 'clear';
      })
      .map(stateKey),
  );
  const clearsAllGlobalTargets = clearKeys.has('global_event_target:*');
  return {
    accesses,
    producers: accesses.filter(
      ({ access }) => access === 'write' || access === 'read_write' || access === 'replace',
    ),
    consumers: accesses.filter(({ access }) => access === 'read' || access === 'read_write'),
    clears: accesses.filter(({ access }) => access === 'clear'),
    links: links.sort((left, right) => compareCodeUnits(left.id, right.id)),
    unproducedReads: accesses.filter(
      (access) =>
        (access.access === 'read' || access.access === 'read_write') &&
        compatibleProducers(allProducers, access).length === 0,
    ),
    globalTargetLeaks: accesses.filter(
      (access) =>
        access.kind === 'global_event_target' &&
        (access.access === 'write' || access.access === 'replace') &&
        !clearsAllGlobalTargets &&
        !clearKeys.has(stateKey(access)),
    ),
  };
}

export function lintEventGraph(
  graph: EventGraphSnapshot,
  selector?: EventSelector,
  signal?: AbortSignal,
): EventIssue[] {
  signal?.throwIfAborted();
  if (selector === undefined) return [...graph.issues];
  const selected = selectedOwnershipIds(graph, selector, signal);
  const selectedNodes = graph.nodes.filter(({ id }, index) => {
    if ((index & 255) === 0) signal?.throwIfAborted();
    return selected.has(id);
  });
  return graph.issues.filter((issue, index) => {
    if ((index & 255) === 0) signal?.throwIfAborted();
    return (
      issueSubjectIds(issue).some((id) => selected.has(id)) ||
      (issue.location !== undefined &&
        selectedNodes.some(
          ({ location }) =>
            location !== undefined &&
            location.path === issue.location?.path &&
            issue.location.start.offset >= location.start.offset &&
            issue.location.end.offset <= location.end.offset,
        ))
    );
  });
}

export function issueSubjectIds(issue: EventIssue): string[] {
  const candidate = issue.details.subjectIds ?? issue.details.subjects;
  return Array.isArray(candidate)
    ? candidate.filter((value): value is string => typeof value === 'string')
    : [];
}

export function analyzeEventImpact(
  graph: EventGraphSnapshot,
  subject: EventImpactSubject,
  signal?: AbortSignal,
): EventImpactResult {
  signal?.throwIfAborted();
  const directNodeIds = new Set<string>();
  const stateAccessIds: string[] = [];
  if (subject.kind === 'event') {
    for (const [index, node] of graph.nodes.entries()) {
      if ((index & 255) === 0) signal?.throwIfAborted();
      if (node.eventId === subject.name) directNodeIds.add(node.id);
    }
  } else if (subject.kind === 'helper') {
    for (const [index, node] of graph.nodes.entries()) {
      if ((index & 255) === 0) signal?.throwIfAborted();
      if (
        node.kind === 'helper' &&
        (node.label === subject.name || node.metadata.name === subject.name)
      )
        directNodeIds.add(node.id);
    }
  } else {
    for (const [index, access] of graph.stateAccesses.entries()) {
      if ((index & 255) === 0) signal?.throwIfAborted();
      const kindMatches =
        access.kind === subject.kind ||
        (subject.kind === 'flag' && access.kind.endsWith('_flag')) ||
        (subject.kind === 'variable' && access.kind.endsWith('variable')) ||
        (subject.kind === 'event_target' && access.kind.endsWith('event_target'));
      if (kindMatches && access.name === subject.name) {
        directNodeIds.add(access.ownerId);
        stateAccessIds.push(access.id);
      }
    }
  }
  const direct = [...directNodeIds].sort(compareCodeUnits);
  const expandHelpers = subject.kind === 'helper';
  const upstreamNodeIds = reachableEventNodeIds(graph, direct, 'upstream', expandHelpers, signal);
  const downstreamNodeIds = reachableEventNodeIds(
    graph,
    direct,
    'downstream',
    expandHelpers,
    signal,
  );
  const affected = new Set([...upstreamNodeIds, ...downstreamNodeIds]);
  const roots = discoverEventRoots(graph, signal);
  const rootIds = [
    ...roots.entryPoints.map(({ id }) => id),
    ...roots.automaticEvents.map(({ id }) => id),
  ].sort(compareCodeUnits);
  const structuralRemoval = subject.kind === 'event' || subject.kind === 'helper';
  const removedNodeIds = structuralRemoval ? new Set(direct) : new Set<string>();
  const baselineReachable = reachableFromRootsWithout(graph, rootIds, new Set(), signal);
  const afterRemovalReachable = reachableFromRootsWithout(graph, rootIds, removedNodeIds, signal);
  const wouldDisconnectNodeIds = structuralRemoval
    ? [...baselineReachable]
        .filter((id) => !removedNodeIds.has(id) && !afterRemovalReachable.has(id))
        .sort(compareCodeUnits)
    : [];
  const terminalIds = new Set(
    graph.nodes.filter(({ kind }) => kind === 'terminal').map(({ id }) => id),
  );
  return {
    subject,
    directNodeIds: direct,
    upstreamNodeIds,
    downstreamNodeIds,
    stateAccessIds: stateAccessIds.sort(compareCodeUnits),
    affectedRootIds: rootIds.filter((id) => affected.has(id)).sort(compareCodeUnits),
    affectedTerminalIds: graph.nodes
      .filter(({ id, kind }) => kind === 'terminal' && affected.has(id))
      .map(({ id }) => id)
      .sort(compareCodeUnits),
    removedRootIds: rootIds.filter((id) => removedNodeIds.has(id)),
    wouldDisconnectNodeIds,
    wouldDisconnectTerminalIds: wouldDisconnectNodeIds.filter((id) => terminalIds.has(id)),
    unresolvedNodeIds: graph.nodes
      .filter(({ id, kind }) => kind === 'unresolved' && affected.has(id))
      .map(({ id }) => id)
      .sort(compareCodeUnits),
  };
}
