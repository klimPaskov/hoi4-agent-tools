import { compareCodeUnits } from '../core/canonical.js';
import { EventAnalysisBudget } from './limits.js';
import type { EventGraphEdge, EventGraphNode, EventGraphSnapshot } from './model.js';
import { iterativeStronglyConnectedComponents } from './scc.js';

export type EventTraceDirection = 'upstream' | 'downstream' | 'both';

export interface EventTraceBoundary {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  direction: EventTraceDirection;
  expandHelpers: boolean;
}

export interface EventTraceLayer {
  depth: number;
  nodeIds: string[];
}

export interface EventTraceResult {
  startNodeIds: string[];
  nodes: EventGraphNode[];
  edges: EventGraphEdge[];
  layers: EventTraceLayer[];
  boundary: EventTraceBoundary;
  boundaryNodeIds: string[];
  truncated: boolean;
}

export interface EventStronglyConnectedComponent {
  id: string;
  nodeIds: string[];
  cyclic: boolean;
}

export interface EventPathSearchResult {
  nodeIds: string[];
  edges: EventGraphEdge[];
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function nodeMap(graph: EventGraphSnapshot): Map<string, EventGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

/**
 * Select either the structural helper graph or its event-to-event projection.
 * Direct, option, entry, unresolved, and terminal edges remain visible in both.
 */
export function eventFlowEdges(
  graph: EventGraphSnapshot,
  expandHelpers: boolean,
): EventGraphEdge[] {
  const nodes = nodeMap(graph);
  return graph.edges
    .filter((edge) => {
      if (expandHelpers) return !edge.derived;
      if (edge.derived) return true;
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      return from?.kind !== 'helper' && to?.kind !== 'helper';
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function edgeMaps(edges: readonly EventGraphEdge[]): {
  outgoing: Map<string, EventGraphEdge[]>;
  incoming: Map<string, EventGraphEdge[]>;
} {
  const outgoing = new Map<string, EventGraphEdge[]>();
  const incoming = new Map<string, EventGraphEdge[]>();
  for (const edge of edges) {
    const from = outgoing.get(edge.from) ?? [];
    from.push(edge);
    outgoing.set(edge.from, from);
    const to = incoming.get(edge.to) ?? [];
    to.push(edge);
    incoming.set(edge.to, to);
  }
  for (const values of [...outgoing.values(), ...incoming.values()]) {
    values.sort((left, right) => compareCodeUnits(left.id, right.id));
  }
  return { outgoing, incoming };
}

function edgesForDirection(
  nodeId: string,
  direction: EventTraceDirection,
  maps: ReturnType<typeof edgeMaps>,
): Array<{ edge: EventGraphEdge; next: string }> {
  const results: Array<{ edge: EventGraphEdge; next: string }> = [];
  if (direction !== 'upstream') {
    for (const edge of maps.outgoing.get(nodeId) ?? []) results.push({ edge, next: edge.to });
  }
  if (direction !== 'downstream') {
    for (const edge of maps.incoming.get(nodeId) ?? []) results.push({ edge, next: edge.from });
  }
  return results.sort(
    (left, right) =>
      compareCodeUnits(left.next, right.next) || compareCodeUnits(left.edge.id, right.edge.id),
  );
}

export function traceEventGraph(
  graph: EventGraphSnapshot,
  startNodeIds: readonly string[],
  boundary: EventTraceBoundary,
  signal?: AbortSignal,
): EventTraceResult {
  signal?.throwIfAborted();
  const byId = nodeMap(graph);
  const resolvedStarts = sortedUnique(startNodeIds).filter((id) => byId.has(id));
  const starts = resolvedStarts.slice(0, Math.max(0, boundary.maxNodes));
  const edges = eventFlowEdges(graph, boundary.expandHelpers);
  const maps = edgeMaps(edges);
  const depthByNode = new Map<string, number>(starts.map((id) => [id, 0]));
  const queue = [...starts];
  const retainedEdges = new Map<string, EventGraphEdge>();
  const boundaryNodes = new Set<string>(resolvedStarts.length > starts.length ? starts : []);
  let truncated = resolvedStarts.length > starts.length;
  let cursor = 0;
  while (cursor < queue.length) {
    if ((cursor & 255) === 0) signal?.throwIfAborted();
    const current = queue[cursor++]!;
    const depth = depthByNode.get(current) ?? 0;
    const nextEdges = edgesForDirection(current, boundary.direction, maps);
    if (depth >= boundary.maxDepth) {
      if (nextEdges.length > 0) {
        boundaryNodes.add(current);
        truncated = true;
      }
      continue;
    }
    for (const candidate of nextEdges) {
      if (retainedEdges.size >= boundary.maxEdges) {
        boundaryNodes.add(current);
        truncated = true;
        break;
      }
      const known = depthByNode.has(candidate.next);
      if (!known && depthByNode.size >= boundary.maxNodes) {
        boundaryNodes.add(current);
        truncated = true;
        continue;
      }
      retainedEdges.set(candidate.edge.id, candidate.edge);
      if (!known) {
        depthByNode.set(candidate.next, depth + 1);
        queue.push(candidate.next);
      }
    }
  }
  const retainedNodes = [...depthByNode.keys()]
    .flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [node];
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const layers = [...new Set(depthByNode.values())]
    .sort((left, right) => left - right)
    .map((depth) => ({
      depth,
      nodeIds: [...depthByNode.entries()]
        .filter(([, value]) => value === depth)
        .map(([id]) => id)
        .sort(compareCodeUnits),
    }));
  return {
    startNodeIds: starts,
    nodes: retainedNodes,
    edges: [...retainedEdges.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
    layers,
    boundary,
    boundaryNodeIds: [...boundaryNodes].sort(compareCodeUnits),
    truncated,
  };
}

export function shortestEventPath(
  graph: EventGraphSnapshot,
  fromNodeIds: readonly string[],
  toNodeIds: readonly string[],
  options: { expandHelpers: boolean; maxDepth: number; maxNodes: number },
  signal?: AbortSignal,
): EventPathSearchResult | undefined {
  signal?.throwIfAborted();
  const nodes = nodeMap(graph);
  const starts = sortedUnique(fromNodeIds).filter((id) => nodes.has(id));
  const targets = new Set(toNodeIds.filter((id) => nodes.has(id)));
  const maps = edgeMaps(eventFlowEdges(graph, options.expandHelpers));
  const queue = starts.map((nodeId) => ({ nodeId, depth: 0 }));
  const visited = new Set(starts);
  const predecessor = new Map<string, { nodeId: string; edge: EventGraphEdge }>();
  let cursor = 0;
  let found = starts.find((id) => targets.has(id));
  while (found === undefined && cursor < queue.length) {
    if ((cursor & 255) === 0) signal?.throwIfAborted();
    const current = queue[cursor++]!;
    if (current.depth >= options.maxDepth) continue;
    for (const edge of maps.outgoing.get(current.nodeId) ?? []) {
      if (visited.has(edge.to)) continue;
      if (visited.size >= options.maxNodes) return undefined;
      visited.add(edge.to);
      predecessor.set(edge.to, { nodeId: current.nodeId, edge });
      if (targets.has(edge.to)) {
        found = edge.to;
        break;
      }
      queue.push({ nodeId: edge.to, depth: current.depth + 1 });
    }
  }
  if (found === undefined) return undefined;
  const nodeIds = [found];
  const pathEdges: EventGraphEdge[] = [];
  let cursorNode = found;
  while (!starts.includes(cursorNode)) {
    const previous = predecessor.get(cursorNode);
    if (previous === undefined) return undefined;
    pathEdges.push(previous.edge);
    cursorNode = previous.nodeId;
    nodeIds.push(cursorNode);
  }
  nodeIds.reverse();
  pathEdges.reverse();
  return { nodeIds, edges: pathEdges };
}

/** Stable, bounded iterative Tarjan SCCs over the selected flow projection. */
export function eventStronglyConnectedComponents(
  graph: EventGraphSnapshot,
  expandHelpers = false,
  selectedNodeIds?: ReadonlySet<string>,
  signal?: AbortSignal,
): EventStronglyConnectedComponent[] {
  signal?.throwIfAborted();
  const retainedNodes = graph.nodes
    .filter((node) => selectedNodeIds === undefined || selectedNodeIds.has(node.id))
    .map(({ id }) => id)
    .sort(compareCodeUnits);
  const retained = new Set(retainedNodes);
  const edges = eventFlowEdges(graph, expandHelpers).filter(
    ({ from, to }) => retained.has(from) && retained.has(to),
  );
  const outgoing = edgeMaps(edges).outgoing;
  const adjacency = new Map(
    [...outgoing].map(([nodeId, values]) => [nodeId, values.map(({ to }) => to)]),
  );
  const budget = new EventAnalysisBudget(signal);
  const components = iterativeStronglyConnectedComponents(retainedNodes, adjacency, () =>
    budget.spend('strongly_connected_components'),
  );
  budget.check();
  return components
    .map((nodeIds) => {
      const members = new Set(nodeIds);
      const selfLoop = edges.some(({ from, to }) => from === to && members.has(from));
      return {
        id: `scc:${nodeIds.join('|')}`,
        nodeIds,
        cyclic: nodeIds.length > 1 || selfLoop,
      };
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function reachableEventNodeIds(
  graph: EventGraphSnapshot,
  startNodeIds: readonly string[],
  direction: Exclude<EventTraceDirection, 'both'>,
  expandHelpers = false,
  signal?: AbortSignal,
): string[] {
  return traceEventGraph(
    graph,
    startNodeIds,
    {
      maxDepth: Number.MAX_SAFE_INTEGER,
      maxNodes: Math.max(1, graph.nodes.length),
      maxEdges: Math.max(1, graph.edges.length),
      direction,
      expandHelpers,
    },
    signal,
  ).nodes.map(({ id }) => id);
}
