import { compareCodeUnits } from '../../core/canonical.js';
import { measureOrthogonalConnectors, ORTHOGONAL_PLAQUE_WIDTH } from './orthogonal.js';
import type { QualityGraph, QualityLocators, QualityMeasurement, QualityRegion } from './types.js';

/** Below this many focuses a tree is too small for the vanilla-calibrated soft metrics. */
export const MINIMUM_FOCUSES_FOR_SOFT_METRICS = 8;
/** A tree this large skips the quadratic sibling-subtree comparison (S7). */
const INTERLEAVING_NODE_MAX = 3_000;
/** Rows below an exclusive choice within which reconvergence counts as "no lasting consequence". */
export const CONVERGENCE_ROW_WINDOW = 12;
/** Choices that rejoin sooner than this are an ordinary fork-and-merge, not a hollow choice. */
export const CONVERGENCE_MINIMUM_ROWS = 6;
const LOCATOR_LIMIT = 24;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function limited<T>(values: T[]): T[] {
  return values.slice(0, LOCATOR_LIMIT);
}

interface EmptyRectangle {
  fraction: number;
  region: QualityRegion | null;
}

/**
 * Largest empty axis-aligned rectangle inside the bounding box, as a fraction of the box. A plaque
 * occupies its own column and the next, because neighbouring plaques are two columns apart.
 */
function largestEmptyRectangle(
  graph: QualityGraph,
  minimumX: number,
  minimumY: number,
  width: number,
  rows: number,
): EmptyRectangle {
  const columns = width + 2;
  const occupied = Array.from({ length: rows }, () => new Uint8Array(columns));
  for (const node of graph.nodes) {
    const row = occupied[node.y - minimumY]!;
    row[node.x - minimumX] = 1;
    row[node.x - minimumX + 1] = 1;
  }
  let bestArea = 0;
  let best: { row: number; column: number; width: number; height: number } | undefined;
  const heights = new Array<number>(columns).fill(0);
  for (let row = 0; row < rows; row += 1) {
    const cells = occupied[row]!;
    for (let column = 0; column < columns; column += 1)
      heights[column] = cells[column] === 1 ? 0 : heights[column]! + 1;
    const stack: Array<{ start: number; height: number }> = [];
    for (let column = 0; column <= columns; column += 1) {
      const height = column === columns ? 0 : heights[column]!;
      let start = column;
      while (stack.length > 0 && stack[stack.length - 1]!.height >= height) {
        const top = stack.pop()!;
        const area = top.height * (column - top.start);
        if (area > bestArea) {
          bestArea = area;
          best = {
            row,
            column: top.start,
            width: column - top.start,
            height: top.height,
          };
        }
        start = top.start;
      }
      stack.push({ start, height });
    }
  }
  return {
    fraction: bestArea / (columns * rows),
    region:
      best === undefined
        ? null
        : {
            minimumX: minimumX + best.column,
            maximumX: minimumX + best.column + best.width - 1,
            minimumY: minimumY + best.row - best.height + 1,
            maximumY: minimumY + best.row,
          },
  };
}

function descendants(
  graph: QualityGraph,
  start: string,
  blocked: ReadonlySet<string> = new Set(),
  maximumRow = Number.POSITIVE_INFINITY,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...(graph.children.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id) || blocked.has(id)) continue;
    if ((graph.position.get(id)?.y ?? 0) > maximumRow) continue;
    seen.add(id);
    for (const child of graph.children.get(id) ?? []) stack.push(child);
  }
  return seen;
}

/** Children that have this parent as their only prerequisite. */
function ownedChildren(graph: QualityGraph, parentId: string): string[] {
  return (graph.children.get(parentId) ?? []).filter(
    (child) => (graph.parents.get(child)?.length ?? 0) === 1,
  );
}

function longestSingleSuccessorChain(graph: QualityGraph): string[] {
  const linear = (id: string): boolean =>
    (graph.parents.get(id)?.length ?? 0) === 1 && (graph.children.get(id)?.length ?? 0) === 1;
  const seen = new Set<string>();
  let longest: string[] = [];
  for (const { id } of graph.nodes) {
    if (!linear(id)) continue;
    const parent = graph.parents.get(id)![0]!;
    if (linear(parent) && (graph.children.get(parent)?.length ?? 0) === 1) continue;
    const chain: string[] = [];
    let current: string | undefined = id;
    while (current !== undefined && linear(current) && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = graph.children.get(current)![0];
    }
    if (chain.length > longest.length) longest = chain;
  }
  return longest;
}

function exclusiveSets(graph: QualityGraph): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const [left, right] of graph.exclusions) {
    parent.set(find(left), find(right));
  }
  const sets = new Map<string, string[]>();
  for (const [left, right] of graph.exclusions)
    for (const id of [left, right]) {
      const root = find(id);
      const members = sets.get(root) ?? [];
      if (!members.includes(id)) members.push(id);
      sets.set(root, members);
    }
  return [...sets.values()]
    .map((members) => members.sort(compareCodeUnits))
    .sort((left, right) => compareCodeUnits(left.join('\0'), right.join('\0')));
}

/** Focuses whose coordinates cannot be judged: an unevaluated offset or a conditional branch. */
function unjudged(graph: QualityGraph, id: string): boolean {
  return graph.offsetDependent.has(id) || graph.conditional.has(id);
}

/** Measures every metric of the layout rubric on resolved grid coordinates. */
export function measureLayoutQuality(graph: QualityGraph): QualityMeasurement {
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  const values: QualityMeasurement['values'] = {};
  const notEvaluated: string[] = [];
  const locators: QualityLocators = {
    duplicateCoordinates: [],
    parentNotAbove: [],
    overlaps: [],
    stemsThroughPlaques: [],
    crossings: [],
    mergedBars: [],
    detours: [],
    offCenterCohorts: [],
    mixedRowCohorts: [],
    interleavedPairs: [],
    slackChildren: [],
    emptyRectangle: null,
    longestChain: [],
    convergingChoices: [],
    rowCentroids: null,
    sides: { left: 0, right: 0, centre: 0 },
    bundles: [],
  };
  const counts: QualityMeasurement['counts'] = {
    duplicateCoordinates: 0,
    parentNotAbove: 0,
    overlaps: 0,
    stemsThroughPlaques: 0,
    crossings: 0,
    mergedBars: 0,
    detours: 0,
    leaves: 0,
    cohorts: 0,
    bundleEdges: 0,
    exclusiveSets: 0,
  };
  if (nodeCount === 0) {
    return { nodeCount, edgeCount, width: 0, rows: 0, values, counts, locators, notEvaluated };
  }
  const xs = graph.nodes.map(({ x }) => x);
  const ys = graph.nodes.map(({ y }) => y);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const width = maximumX - minimumX;
  const rows = maximumY - minimumY + 1;
  const per100 = (count: number): number => (edgeCount === 0 ? 0 : (100 * count) / edgeCount);

  // H1 duplicate coordinates and H3 overlapping plaques (focuses with an unresolved offset are skipped).
  const byCoordinate = new Map<string, string[]>();
  const byRow = new Map<number, Array<{ id: string; x: number }>>();
  for (const node of graph.nodes) {
    const key = `${node.x},${node.y}`;
    const group = byCoordinate.get(key) ?? [];
    group.push(node.id);
    byCoordinate.set(key, group);
    const row = byRow.get(node.y) ?? [];
    row.push({ id: node.id, x: node.x });
    byRow.set(node.y, row);
  }
  for (const [key, ids] of [...byCoordinate].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const certain = ids.filter((id) => !unjudged(graph, id));
    if (ids.length < 2 || certain.length < 2) continue;
    const [x, y] = key.split(',').map(Number) as [number, number];
    counts.duplicateCoordinates += certain.length - 1;
    locators.duplicateCoordinates.push({ x, y, focusIds: certain });
  }
  for (const [y, row] of [...byRow].sort(([left], [right]) => left - right)) {
    row.sort((left, right) => left.x - right.x || compareCodeUnits(left.id, right.id));
    for (const [index, left] of row.entries()) {
      for (const right of row.slice(index + 1)) {
        const distance = right.x - left.x;
        if (distance >= ORTHOGONAL_PLAQUE_WIDTH) break;
        if (distance <= 0) continue;
        if (unjudged(graph, left.id) || unjudged(graph, right.id)) continue;
        counts.overlaps += 1;
        locators.overlaps.push({ leftId: left.id, rightId: right.id, y, distance });
      }
    }
  }
  // H2 a prerequisite that is not above its dependant.
  for (const edge of graph.edges) {
    const parent = graph.position.get(edge.parent)!;
    const child = graph.position.get(edge.child)!;
    if (parent.y < child.y) continue;
    if (unjudged(graph, edge.parent) || unjudged(graph, edge.child)) continue;
    counts.parentNotAbove += 1;
    locators.parentNotAbove.push({ parentId: edge.parent, childId: edge.child });
  }
  values.H1 = counts.duplicateCoordinates;
  values.H2 = counts.parentNotAbove;
  values.H3 = counts.overlaps;

  // H4, H5 and S9 under the orthogonal connector model.
  const orthogonal = measureOrthogonalConnectors(graph);
  if (orthogonal.notEvaluated !== undefined) notEvaluated.push(orthogonal.notEvaluated);
  counts.crossings = orthogonal.crossings.length;
  counts.stemsThroughPlaques = orthogonal.stemsThroughPlaques.length;
  counts.mergedBars = orthogonal.mergedBars.length;
  counts.bundleEdges = orthogonal.bundleEdgeCount;
  locators.bundles = orthogonal.bundles;
  const connectorIds = (index: number): { parentId: string; childId: string } => ({
    parentId: orthogonal.connectors[index]!.parent,
    childId: orthogonal.connectors[index]!.child,
  });
  locators.stemsThroughPlaques = limited(
    orthogonal.stemsThroughPlaques.map(({ edgeIndex, focusId }) => ({
      ...connectorIds(edgeIndex),
      focusId,
    })),
  );
  const pairLocator = (pair: { firstIndex: number; secondIndex: number }) => ({
    firstParentId: connectorIds(pair.firstIndex).parentId,
    firstChildId: connectorIds(pair.firstIndex).childId,
    secondParentId: connectorIds(pair.secondIndex).parentId,
    secondChildId: connectorIds(pair.secondIndex).childId,
  });
  locators.crossings = limited(orthogonal.crossings.map(pairLocator));
  locators.mergedBars = limited(orthogonal.mergedBars.map(pairLocator));
  values.H4 = per100(counts.stemsThroughPlaques);
  values.H5 = per100(counts.crossings);
  values.S9 = per100(counts.mergedBars);

  // S1 empty space, S2 side balance, S3 mass skew, S4 fill, S5 row-centroid wander.
  const empty = largestEmptyRectangle(graph, minimumX, minimumY, width, rows);
  values.S1 = empty.fraction;
  locators.emptyRectangle = empty.region;
  const centre = (minimumX + maximumX) / 2;
  const left = xs.filter((x) => x < centre - 0.5).length;
  const right = xs.filter((x) => x > centre + 0.5).length;
  locators.sides = { left, right, centre };
  values.S2 = Math.abs(left - right) / Math.max(1, left + right);
  values.S3 = width === 0 ? 0 : Math.abs(sum(xs) / nodeCount - centre) / (width / 2);
  values.S4 = nodeCount / ((Math.floor(width / 2) + 1) * rows);
  const rowMeans = [...byRow].map(([y, row]) => ({
    y,
    mean: sum(row.map(({ x }) => x)) / row.length,
  }));
  const lowestRow = rowMeans.reduce((best, row) => (row.mean < best.mean ? row : best));
  const highestRow = rowMeans.reduce((best, row) => (row.mean > best.mean ? row : best));
  values.S5 = width === 0 ? 0 : (highestRow.mean - lowestRow.mean) / width;
  locators.rowCentroids = {
    minimumRow: lowestRow.y,
    maximumRow: highestRow.y,
    minimumMean: lowestRow.mean,
    maximumMean: highestRow.mean,
  };

  // S6 single-parent single-child links that jog sideways.
  for (const edge of graph.edges) {
    if ((graph.children.get(edge.parent)?.length ?? 0) !== 1) continue;
    if ((graph.parents.get(edge.child)?.length ?? 0) !== 1) continue;
    const dx = graph.position.get(edge.child)!.x - graph.position.get(edge.parent)!.x;
    if (dx === 0) continue;
    counts.detours += 1;
    locators.detours.push({ parentId: edge.parent, childId: edge.child, dx });
  }
  locators.detours = limited(locators.detours);
  values.S6 = per100(counts.detours);

  // S8 fan-out cohorts off the parent's column, S11 cohorts spread over several rows, S7 interleaving.
  const cohorts: Array<{ parentId: string; childIds: string[] }> = [];
  for (const { id } of graph.nodes) {
    const owned = ownedChildren(graph, id);
    if (owned.length >= 2) cohorts.push({ parentId: id, childIds: owned });
  }
  counts.cohorts = cohorts.length;
  let largestOffset = 0;
  let mixedRows = 0;
  const offCentre: QualityLocators['offCenterCohorts'] = [];
  for (const cohort of cohorts) {
    const childX = cohort.childIds.map((id) => graph.position.get(id)!.x);
    const cohortCentre = (Math.min(...childX) + Math.max(...childX)) / 2;
    const offset = Math.abs(cohortCentre - graph.position.get(cohort.parentId)!.x);
    largestOffset = Math.max(largestOffset, offset);
    if (offset >= 2) offCentre.push({ ...cohort, offset, centre: cohortCentre });
    if (new Set(cohort.childIds.map((id) => graph.position.get(id)!.y)).size > 1) {
      mixedRows += 1;
      locators.mixedRowCohorts.push(cohort);
    }
  }
  locators.offCenterCohorts = limited(
    offCentre.sort((a, b) => b.offset - a.offset || compareCodeUnits(a.parentId, b.parentId)),
  );
  locators.mixedRowCohorts = limited(locators.mixedRowCohorts);
  values.S8 = largestOffset;
  values.S11 = cohorts.length === 0 ? 0 : mixedRows / cohorts.length;
  if (nodeCount > INTERLEAVING_NODE_MAX) {
    notEvaluated.push('Sibling-subtree interleaving (S7) is skipped for trees above 3000 focuses');
  } else {
    let pairs = 0;
    let interleaved = 0;
    for (const cohort of cohorts) {
      const reach = cohort.childIds.map((id) => new Set([id, ...descendants(graph, id)]));
      const reachCount = new Map<string, number>();
      for (const set of reach)
        for (const id of set) reachCount.set(id, (reachCount.get(id) ?? 0) + 1);
      const rowRanges = reach.map((set) => {
        const ranges = new Map<number, [number, number]>();
        for (const id of set) {
          if (reachCount.get(id) !== 1) continue;
          const { x, y } = graph.position.get(id)!;
          const range = ranges.get(y) ?? [Infinity, -Infinity];
          range[0] = Math.min(range[0], x);
          range[1] = Math.max(range[1], x);
          ranges.set(y, range);
        }
        return ranges;
      });
      for (let first = 0; first < rowRanges.length; first += 1) {
        for (let second = first + 1; second < rowRanges.length; second += 1) {
          pairs += 1;
          let overlap = false;
          for (const [y, a] of rowRanges[first]!) {
            const b = rowRanges[second]!.get(y);
            if (b !== undefined && Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= 0) {
              overlap = true;
              break;
            }
          }
          if (overlap) {
            interleaved += 1;
            locators.interleavedPairs.push({
              parentId: cohort.parentId,
              firstChildId: cohort.childIds[first]!,
              secondChildId: cohort.childIds[second]!,
            });
          }
        }
      }
    }
    locators.interleavedPairs = limited(locators.interleavedPairs);
    values.S7 = pairs === 0 ? 0 : interleaved / pairs;
  }

  // S10 largest vertical gap between a focus and its lowest prerequisite.
  let slackMaximum = 0;
  const slackChildren: Array<{ childId: string; slack: number }> = [];
  for (const { id, y } of graph.nodes) {
    const parents = graph.parents.get(id) ?? [];
    if (parents.length === 0) continue;
    const slack = y - Math.max(...parents.map((parent) => graph.position.get(parent)!.y)) - 1;
    slackMaximum = Math.max(slackMaximum, slack);
    if (slack > 0) slackChildren.push({ childId: id, slack });
  }
  locators.slackChildren = limited(
    slackChildren.sort((a, b) => b.slack - a.slack || compareCodeUnits(a.childId, b.childId)),
  );
  values.S10 = slackMaximum;

  // D1 to D4 design proxies; they route a tree to review but never fail it.
  locators.longestChain = longestSingleSuccessorChain(graph);
  values.D1 = locators.longestChain.length;
  counts.leaves = graph.nodes.filter(
    ({ id }) => (graph.children.get(id)?.length ?? 0) === 0,
  ).length;
  values.D2 = counts.leaves / nodeCount;
  const sets = exclusiveSets(graph);
  counts.exclusiveSets = sets.length;
  for (const members of sets) {
    const memberSet = new Set(members);
    const lastRow = Math.max(...members.map((id) => graph.position.get(id)!.y));
    const reaches = members.map((id) =>
      descendants(graph, id, memberSet, lastRow + CONVERGENCE_ROW_WINDOW),
    );
    const shared = [...reaches[0]!].filter((id) => reaches.every((set) => set.has(id)));
    if (shared.length === 0) continue;
    const first = shared.sort(
      (a, b) => graph.position.get(a)!.y - graph.position.get(b)!.y || compareCodeUnits(a, b),
    )[0]!;
    if (graph.position.get(first)!.y - lastRow < CONVERGENCE_MINIMUM_ROWS) continue;
    locators.convergingChoices.push({
      choiceIds: members,
      convergenceId: first,
      rows: graph.position.get(first)!.y - lastRow,
    });
  }
  locators.convergingChoices = limited(locators.convergingChoices);
  values.D3 = locators.convergingChoices.length;
  values.D4 = rows / Math.max(1, width / 2);

  return { nodeCount, edgeCount, width, rows, values, counts, locators, notEvaluated };
}
