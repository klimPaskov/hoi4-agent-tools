import { compareCodeUnits } from '../core/canonical.js';
import { traceEventGraph } from './algorithms.js';
import type { EventGraphComparison, EventComparisonChange } from './compare.js';
import type { EventGraphSnapshot } from './model.js';
import { selectEventNodes, type EventSelector } from './queries.js';

export interface EventComparisonSelection {
  selector: EventSelector;
  maxChainNodes: number;
  beforeNodeIds: string[];
  afterNodeIds: string[];
  selectedChangeIds: string[];
  selectedChangeCount: number;
  omittedChangeCount: number;
  unattributedChangeIds: string[];
  truncated: boolean;
}

/** Project a whole-graph comparison onto the downstream chain in each revision. */
export function selectEventComparison(
  before: EventGraphSnapshot,
  after: EventGraphSnapshot,
  comparison: EventGraphComparison,
  selector: EventSelector,
  maxChainNodes: number,
  signal?: AbortSignal,
): EventComparisonSelection {
  const trace = (graph: EventGraphSnapshot) => {
    const starts = selectEventNodes(graph, selector, signal).map(({ id }) => id);
    return traceEventGraph(
      graph,
      starts,
      {
        maxDepth: 64,
        maxNodes: maxChainNodes,
        maxEdges: Math.max(1, Math.min(20_000, graph.edges.length)),
        direction: 'downstream',
        expandHelpers: true,
      },
      signal,
    );
  };
  const beforeTrace = trace(before);
  const afterTrace = trace(after);
  const beforeNodeIds = beforeTrace.nodes.map(({ id }) => id).sort(compareCodeUnits);
  const afterNodeIds = afterTrace.nodes.map(({ id }) => id).sort(compareCodeUnits);
  const selectedNodes = new Set([...beforeNodeIds, ...afterNodeIds]);
  const edges = new Map([...before.edges, ...after.edges].map((edge) => [edge.id, edge]));
  const accesses = new Map(
    [...before.stateAccesses, ...after.stateAccesses].map((access) => [access.id, access]),
  );
  const links = new Map([...before.stateLinks, ...after.stateLinks].map((link) => [link.id, link]));
  const unresolved = new Map(
    [...before.unresolved, ...after.unresolved].map((item) => [item.id, item]),
  );
  const association = (change: EventComparisonChange): boolean | undefined => {
    const { kind, subjectId } = change;
    if (kind.startsWith('node_') || kind === 'caller_removed' || kind.endsWith('_disconnected'))
      return selectedNodes.has(subjectId);
    if (kind.startsWith('edge_')) {
      const edge = edges.get(subjectId);
      return edge === undefined
        ? undefined
        : selectedNodes.has(edge.from) || selectedNodes.has(edge.to);
    }
    if (kind.startsWith('state_access_')) {
      const access = accesses.get(subjectId);
      return access === undefined ? undefined : selectedNodes.has(access.ownerId);
    }
    if (kind.startsWith('state_link_')) {
      const link = links.get(subjectId);
      if (link === undefined) return undefined;
      const producer = accesses.get(link.producerId);
      const consumer = accesses.get(link.consumerId);
      return producer === undefined && consumer === undefined
        ? undefined
        : (producer !== undefined && selectedNodes.has(producer.ownerId)) ||
            (consumer !== undefined && selectedNodes.has(consumer.ownerId));
    }
    if (kind.startsWith('unresolved_')) {
      const item = unresolved.get(subjectId);
      return item?.ownerId === undefined ? undefined : selectedNodes.has(item.ownerId);
    }
    return undefined;
  };
  const selectedChangeIds: string[] = [];
  const unattributedChangeIds: string[] = [];
  for (const [index, change] of comparison.changes.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const relevant = association(change);
    if (relevant === true) selectedChangeIds.push(change.id);
    else if (relevant === undefined) unattributedChangeIds.push(change.id);
  }
  return {
    selector,
    maxChainNodes,
    beforeNodeIds,
    afterNodeIds,
    selectedChangeIds,
    selectedChangeCount: selectedChangeIds.length,
    omittedChangeCount: comparison.changes.length - selectedChangeIds.length,
    unattributedChangeIds,
    truncated: beforeTrace.truncated || afterTrace.truncated,
  };
}
