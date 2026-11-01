import { compareCodeUnits } from '../../core/canonical.js';
import { FOCUS_PAIR_COMPARISON_MAX } from '../limits.js';
import type { QualityBundle, QualityGraph } from './types.js';

/**
 * Orthogonal connector model "O1". The game draws right-angle connectors: a stem leaves the bottom
 * of the parent, a horizontal bar runs in the gap just above the child's row, and a short stem
 * enters the child. A plaque is about 1.6 grid columns wide and half a row high. This model was
 * read from one in-game screenshot for adjacent rows; multi-row bar placement is unverified, so
 * every number derived from it is advisory until it is confirmed in the game.
 */
export const ORTHOGONAL_PLAQUE_WIDTH = 1.6;
export const ORTHOGONAL_PLAQUE_HEIGHT = 0.5;
/** A stem closer than this many columns to another plaque's centre runs through that plaque. */
export const ORTHOGONAL_STEM_CLEARANCE = ORTHOGONAL_PLAQUE_WIDTH / 2;
/** Distance of the horizontal bar above the child's row. */
export const ORTHOGONAL_BAR_OFFSET = 0.25;
export const ORTHOGONAL_MINIMUM_SHARED_BAR = 0.5;
export const ORTHOGONAL_MINIMUM_SHARED_STEM = 0.3;

const BUNDLE_CANDIDATE_PARENT_MAX = 800;

export interface OrthogonalConnector {
  parent: string;
  child: string;
  /** Column of the parent stem. */
  parentX: number;
  /** Column of the child stem. */
  childX: number;
  parentY: number;
  childY: number;
  barY: number;
  barFrom: number;
  barTo: number;
}

export function orthogonalConnector(
  parent: { id: string; x: number; y: number },
  child: { id: string; x: number; y: number },
): OrthogonalConnector {
  return {
    parent: parent.id,
    child: child.id,
    parentX: parent.x,
    childX: child.x,
    parentY: parent.y,
    childY: child.y,
    barY: child.y - ORTHOGONAL_BAR_OFFSET,
    barFrom: Math.min(parent.x, child.x),
    barTo: Math.max(parent.x, child.x),
  };
}

function intersection(left: readonly string[], right: ReadonlySet<string>): string[] {
  return left.filter((value) => right.has(value));
}

/**
 * Bundles are sets of at least two parents and two children with every parent a prerequisite of
 * every child. The game draws such a set as one bar, so the connectors inside one bundle are never
 * counted against each other.
 */
export function detectBundles(graph: QualityGraph): QualityBundle[] {
  const candidates = graph.nodes
    .map(({ id }) => id)
    .filter((id) => (graph.children.get(id)?.length ?? 0) >= 2)
    .slice(0, BUNDLE_CANDIDATE_PARENT_MAX);
  const childSets = new Map(candidates.map((id) => [id, new Set(graph.children.get(id) ?? [])]));
  const found = new Map<string, QualityBundle>();
  for (const [index, first] of candidates.entries()) {
    const firstChildren = graph.children.get(first) ?? [];
    for (const second of candidates.slice(index + 1)) {
      const common = intersection(firstChildren, childSets.get(second)!);
      if (common.length < 2) continue;
      const bundleParents = candidates.filter((candidate) => {
        const set = childSets.get(candidate)!;
        return common.every((child) => set.has(child));
      });
      let bundleChildren = common;
      for (const parent of bundleParents)
        bundleChildren = intersection(bundleChildren, childSets.get(parent)!);
      if (bundleParents.length < 2 || bundleChildren.length < 2) continue;
      const key = `${bundleParents.join('\0')}|${bundleChildren.join('\0')}`;
      if (!found.has(key))
        found.set(key, {
          parents: [...bundleParents].sort(compareCodeUnits),
          children: [...bundleChildren].sort(compareCodeUnits),
        });
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      compareCodeUnits(left.parents.join('\0'), right.parents.join('\0')) ||
      compareCodeUnits(left.children.join('\0'), right.children.join('\0')),
  );
}

export interface OrthogonalMeasurement {
  bundles: QualityBundle[];
  /** Number of prerequisite links that belong to at least one bundle. */
  bundleEdgeCount: number;
  crossings: Array<{ firstIndex: number; secondIndex: number }>;
  stemsThroughPlaques: Array<{ edgeIndex: number; focusId: string }>;
  mergedBars: Array<{ firstIndex: number; secondIndex: number }>;
  connectors: OrthogonalConnector[];
  notEvaluated: string | undefined;
}

function pairKey(first: number, second: number): string {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

/** Counts the defects of the orthogonal model; connectors inside one bundle are exempt. */
export function measureOrthogonalConnectors(graph: QualityGraph): OrthogonalMeasurement {
  const bundles = detectBundles(graph);
  const connectors = graph.edges.map((edge) =>
    orthogonalConnector(
      { id: edge.parent, ...graph.position.get(edge.parent)! },
      { id: edge.child, ...graph.position.get(edge.child)! },
    ),
  );
  const bundleIdsOfEdge = connectors.map((connector) => {
    const ids: number[] = [];
    for (const [bundleIndex, bundle] of bundles.entries())
      if (bundle.parents.includes(connector.parent) && bundle.children.includes(connector.child))
        ids.push(bundleIndex);
    return ids;
  });
  const bundleMembers = bundles.map((bundle) => new Set([...bundle.parents, ...bundle.children]));
  const exempt = (first: number, second: number): boolean => {
    const a = connectors[first]!;
    const b = connectors[second]!;
    if (a.parent === b.parent || a.child === b.child) return true;
    const firstBundles = bundleIdsOfEdge[first]!;
    const secondBundles = bundleIdsOfEdge[second]!;
    return firstBundles.some((id) => secondBundles.includes(id));
  };
  let work = 0;
  let notEvaluated: string | undefined;
  const spend = (amount = 1): boolean => {
    work += amount;
    if (work <= FOCUS_PAIR_COMPARISON_MAX) return true;
    notEvaluated ??=
      'The tree is too large for an exact connector comparison; crossing and merged-bar counts are partial';
    return false;
  };

  const barsByRow = new Map<number, number[]>();
  for (const [index, connector] of connectors.entries()) {
    const row = barsByRow.get(connector.childY) ?? [];
    row.push(index);
    barsByRow.set(connector.childY, row);
  }
  const nodesByRow = new Map<number, Array<{ id: string; x: number }>>();
  for (const node of graph.nodes) {
    const row = nodesByRow.get(node.y) ?? [];
    row.push({ id: node.id, x: node.x });
    nodesByRow.set(node.y, row);
  }

  const crossings: OrthogonalMeasurement['crossings'] = [];
  const stems: OrthogonalMeasurement['stemsThroughPlaques'] = [];
  for (const [index, connector] of connectors.entries()) {
    // The parent stem passes every row strictly between the parent and the child.
    for (let row = connector.parentY + 1; row <= connector.childY - 1; row += 1) {
      for (const otherIndex of barsByRow.get(row) ?? []) {
        if (!spend()) break;
        if (otherIndex === index) continue;
        const other = connectors[otherIndex]!;
        if (
          other.barFrom < connector.parentX &&
          connector.parentX < other.barTo &&
          !exempt(index, otherIndex)
        )
          crossings.push({ firstIndex: index, secondIndex: otherIndex });
      }
      for (const node of nodesByRow.get(row) ?? []) {
        if (!spend()) break;
        if (node.id === connector.parent || node.id === connector.child) continue;
        if (Math.abs(node.x - connector.parentX) >= ORTHOGONAL_STEM_CLEARANCE) continue;
        const inOwnBundle = (bundleIdsOfEdge[index] ?? []).some((bundleIndex) =>
          bundleMembers[bundleIndex]!.has(node.id),
        );
        if (!inOwnBundle) stems.push({ edgeIndex: index, focusId: node.id });
      }
    }
  }

  const merged = new Map<string, { firstIndex: number; secondIndex: number }>();
  for (const indexes of barsByRow.values()) {
    for (const [position, first] of indexes.entries()) {
      for (const second of indexes.slice(position + 1)) {
        if (!spend()) break;
        const a = connectors[first]!;
        const b = connectors[second]!;
        if (exempt(first, second)) continue;
        const overlap = Math.min(a.barTo, b.barTo) - Math.max(a.barFrom, b.barFrom);
        if (overlap >= ORTHOGONAL_MINIMUM_SHARED_BAR)
          merged.set(pairKey(first, second), { firstIndex: first, secondIndex: second });
      }
    }
  }
  const verticals = new Map<number, Array<{ index: number; from: number; to: number }>>();
  const addVertical = (x: number, index: number, from: number, to: number): void => {
    if (to <= from) return;
    const group = verticals.get(x) ?? [];
    group.push({ index, from, to });
    verticals.set(x, group);
  };
  for (const [index, connector] of connectors.entries()) {
    addVertical(
      connector.parentX,
      index,
      connector.parentY + ORTHOGONAL_PLAQUE_HEIGHT,
      connector.barY,
    );
    addVertical(connector.childX, index, connector.barY, connector.childY);
  }
  for (const group of verticals.values()) {
    for (const [position, first] of group.entries()) {
      for (const second of group.slice(position + 1)) {
        if (!spend()) break;
        if (first.index === second.index || exempt(first.index, second.index)) continue;
        const overlap = Math.min(first.to, second.to) - Math.max(first.from, second.from);
        if (overlap > ORTHOGONAL_MINIMUM_SHARED_STEM)
          merged.set(pairKey(first.index, second.index), {
            firstIndex: Math.min(first.index, second.index),
            secondIndex: Math.max(first.index, second.index),
          });
      }
    }
  }
  const bundleEdgeCount = bundleIdsOfEdge.filter((ids) => ids.length > 0).length;
  return {
    bundles,
    bundleEdgeCount,
    crossings,
    stemsThroughPlaques: stems,
    mergedBars: [...merged.values()],
    connectors,
    notEvaluated,
  };
}
