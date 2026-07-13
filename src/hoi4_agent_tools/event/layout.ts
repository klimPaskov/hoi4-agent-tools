import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import {
  RENDER_MAX_DIMENSION,
  RENDER_MAX_PIXELS,
  renderDimensionViolation,
} from '../core/render-budget.js';
import { eventFlowEdges, eventStronglyConnectedComponents } from './algorithms.js';
import type { EventGraphEdge, EventGraphNode, EventGraphSnapshot } from './model.js';

export interface EventLayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  componentId: string;
}

export interface EventLayoutEdge {
  id: string;
  from: string;
  to: string;
  points: Array<{ x: number; y: number }>;
}

export interface EventGraphLayout {
  schemaVersion: 'event-layout.v1';
  width: number;
  height: number;
  nodes: EventLayoutNode[];
  edges: EventLayoutEdge[];
  componentCount: number;
  cyclicComponentCount: number;
  layoutHash: string;
}

export interface EventLayoutOptions {
  expandHelpers?: boolean;
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalGap?: number;
  verticalGap?: number;
  padding?: number;
  compact?: boolean;
  signal?: AbortSignal;
}

const STABLE_LAYER_ROWS = 64;

function stableAnchor(id: string): number {
  return Number.parseInt(hashCanonical(id).slice(0, 8), 16) >>> 0;
}

function dimensionsFor(
  nodes: readonly EventLayoutNode[],
  padding: number,
): { width: number; height: number } {
  return {
    width: Math.max(320, ...nodes.map(({ x, width }) => Math.ceil(x + width + padding))),
    height: Math.max(200, ...nodes.map(({ y, height }) => Math.ceil(y + height + padding))),
  };
}

function assignStableSlots(ids: readonly string[], capacity: number): Map<string, number> {
  const assigned = new Map<string, number>();
  const occupied = new Set<number>();
  const ordered = [...ids].sort(
    (left, right) => stableAnchor(left) - stableAnchor(right) || compareCodeUnits(left, right),
  );
  for (const id of ordered) {
    let slot = stableAnchor(id) % capacity;
    while (occupied.has(slot)) slot = (slot + 1) % capacity;
    occupied.add(slot);
    assigned.set(id, slot);
  }
  return assigned;
}

function shardLayout(
  nodes: readonly EventLayoutNode[],
  nodeWidth: number,
  nodeHeight: number,
  horizontalGap: number,
  verticalGap: number,
  padding: number,
): EventLayoutNode[] {
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((nodes.length * (nodeHeight + verticalGap)) / (nodeWidth + horizontalGap))),
  );
  const slots = new Map(
    [...nodes]
      .sort(
        (left, right) =>
          stableAnchor(left.id) - stableAnchor(right.id) || compareCodeUnits(left.id, right.id),
      )
      .map(({ id }, index) => [id, index]),
  );
  return nodes.map((node) => {
    const slot = slots.get(node.id) ?? 0;
    return {
      ...node,
      x: padding + (slot % columns) * (nodeWidth + horizontalGap),
      y: padding + Math.floor(slot / columns) * (nodeHeight + verticalGap),
    };
  });
}

function retainedGraph(
  graph: EventGraphSnapshot,
  selectedNodeIds?: ReadonlySet<string>,
  expandHelpers = false,
): { nodes: EventGraphNode[]; edges: EventGraphEdge[] } {
  const nodes = graph.nodes.filter(
    ({ id }) => selectedNodeIds === undefined || selectedNodeIds.has(id),
  );
  const ids = new Set(nodes.map(({ id }) => id));
  return {
    nodes: nodes.sort((left, right) => compareCodeUnits(left.id, right.id)),
    edges: eventFlowEdges(graph, expandHelpers).filter(
      ({ from, to }) => ids.has(from) && ids.has(to),
    ),
  };
}

export function layoutEventGraph(
  graph: EventGraphSnapshot,
  selectedNodeIds?: ReadonlySet<string>,
  options: EventLayoutOptions = {},
): EventGraphLayout {
  options.signal?.throwIfAborted();
  const nodeWidth = options.nodeWidth ?? 220;
  const nodeHeight = options.nodeHeight ?? 72;
  const horizontalGap = options.horizontalGap ?? 96;
  const verticalGap = options.verticalGap ?? 36;
  const padding = options.padding ?? 48;
  const retained = retainedGraph(graph, selectedNodeIds, options.expandHelpers ?? false);
  const retainedIds = new Set(retained.nodes.map(({ id }) => id));
  const components = eventStronglyConnectedComponents(
    graph,
    options.expandHelpers ?? false,
    retainedIds,
    options.signal,
  );
  const componentByNode = new Map<string, string>();
  const componentMembers = new Map<string, string[]>();
  for (const component of components) {
    componentMembers.set(component.id, component.nodeIds);
    for (const nodeId of component.nodeIds) componentByNode.set(nodeId, component.id);
  }
  const componentEdges = new Map<string, Set<string>>();
  const incomingCount = new Map<string, number>();
  for (const edge of retained.edges) {
    const from = componentByNode.get(edge.from);
    const to = componentByNode.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const targets = componentEdges.get(from) ?? new Set<string>();
    if (!targets.has(to)) incomingCount.set(to, (incomingCount.get(to) ?? 0) + 1);
    targets.add(to);
    componentEdges.set(from, targets);
  }
  const roots = components
    .map(({ id }) => id)
    .filter((id) => (incomingCount.get(id) ?? 0) === 0)
    .sort(compareCodeUnits);
  const layers = new Map<string, number>(components.map(({ id }) => [id, 0]));
  const queue =
    roots.length > 0 ? [...roots] : components.map(({ id }) => id).sort(compareCodeUnits);
  let cursor = 0;
  while (cursor < queue.length) {
    if ((cursor & 255) === 0) options.signal?.throwIfAborted();
    const component = queue[cursor++]!;
    const layer = layers.get(component) ?? 0;
    for (const target of [...(componentEdges.get(component) ?? [])].sort(compareCodeUnits)) {
      const next = Math.max(layers.get(target) ?? 0, layer + 1);
      if (next !== layers.get(target)) layers.set(target, next);
      incomingCount.set(target, (incomingCount.get(target) ?? 1) - 1);
      if (incomingCount.get(target) === 0) queue.push(target);
    }
  }
  const byLayer = new Map<number, string[]>();
  for (const component of components) {
    const layer = layers.get(component.id) ?? 0;
    const values = byLayer.get(layer) ?? [];
    values.push(component.id);
    byLayer.set(layer, values);
  }
  for (const values of byLayer.values()) values.sort(compareCodeUnits);
  let layoutNodes: EventLayoutNode[] = [];
  for (const [layer, componentIds] of [...byLayer.entries()].sort(([a], [b]) => a - b)) {
    const layerMembers = componentIds.flatMap((componentId) =>
      (componentMembers.get(componentId) ?? []).map((nodeId) => ({ nodeId, componentId })),
    );
    if (layerMembers.length > STABLE_LAYER_ROWS) {
      for (const { nodeId, componentId } of layerMembers) {
        layoutNodes.push({
          id: nodeId,
          x: padding + layer * (nodeWidth + horizontalGap),
          y: padding,
          width: nodeWidth,
          height: nodeHeight,
          layer,
          componentId,
        });
      }
      continue;
    }
    const slots = assignStableSlots(
      layerMembers.map(({ nodeId }) => nodeId),
      STABLE_LAYER_ROWS,
    );
    for (const { nodeId, componentId } of layerMembers) {
      layoutNodes.push({
        id: nodeId,
        x: padding + layer * (nodeWidth + horizontalGap),
        y: padding + (slots.get(nodeId) ?? 0) * (nodeHeight + verticalGap),
        width: nodeWidth,
        height: nodeHeight,
        layer,
        componentId,
      });
    }
  }
  let dimensions = dimensionsFor(layoutNodes, padding);
  if (
    options.compact === true ||
    layoutNodes.some(
      (node, index, values) =>
        values.findIndex(({ x, y }) => x === node.x && y === node.y) !== index,
    ) ||
    renderDimensionViolation(dimensions.width, dimensions.height, 'event graph layout', {
      maximumDimension: RENDER_MAX_DIMENSION,
      maximumPixels: RENDER_MAX_PIXELS,
    }) !== undefined
  ) {
    layoutNodes = shardLayout(
      layoutNodes,
      nodeWidth,
      nodeHeight,
      horizontalGap,
      verticalGap,
      padding,
    );
    dimensions = dimensionsFor(layoutNodes, padding);
  }
  layoutNodes.sort((left, right) => compareCodeUnits(left.id, right.id));
  const placed = new Map(layoutNodes.map((node) => [node.id, node]));
  const layoutEdges = retained.edges.flatMap((edge): EventLayoutEdge[] => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (from === undefined || to === undefined) return [];
    if (from.id === to.id) {
      const loopRight = from.x + from.width + horizontalGap / 2;
      const loopTop = Math.max(4, from.y - verticalGap / 2);
      return [
        {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          points: [
            { x: from.x + from.width, y: from.y + from.height / 2 },
            { x: loopRight, y: from.y + from.height / 2 },
            { x: loopRight, y: loopTop },
            { x: from.x + from.width / 2, y: loopTop },
            { x: from.x + from.width / 2, y: from.y },
          ],
        },
      ];
    }
    if (to.x <= from.x) {
      const sameColumn = to.x === from.x;
      const outerX = sameColumn
        ? Math.max(from.x + from.width, to.x + to.width) + horizontalGap / 2
        : Math.max(4, Math.min(from.x, to.x) - horizontalGap / 2);
      const fromPoint = sameColumn
        ? { x: from.x + from.width, y: from.y + from.height / 2 }
        : { x: from.x, y: from.y + from.height / 2 };
      const toPoint = sameColumn
        ? { x: to.x + to.width, y: to.y + to.height / 2 }
        : { x: to.x + to.width, y: to.y + to.height / 2 };
      return [
        {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          points: [fromPoint, { x: outerX, y: fromPoint.y }, { x: outerX, y: toPoint.y }, toPoint],
        },
      ];
    }
    const fromPoint = { x: from.x + from.width, y: from.y + from.height / 2 };
    const toPoint = { x: to.x, y: to.y + to.height / 2 };
    const middle = (fromPoint.x + toPoint.x) / 2;
    return [
      {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        points: [fromPoint, { x: middle, y: fromPoint.y }, { x: middle, y: toPoint.y }, toPoint],
      },
    ];
  });
  layoutEdges.sort((left, right) => compareCodeUnits(left.id, right.id));
  const { width, height } = dimensions;
  const withoutHash = {
    schemaVersion: 'event-layout.v1' as const,
    width,
    height,
    nodes: layoutNodes,
    edges: layoutEdges,
    componentCount: components.length,
    cyclicComponentCount: components.filter(({ cyclic }) => cyclic).length,
  };
  return { ...withoutHash, layoutHash: hashCanonical(withoutHash) };
}
