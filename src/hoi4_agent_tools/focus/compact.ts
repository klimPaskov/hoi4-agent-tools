import { compareCodeUnits } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import {
  focusPlanHash,
  type FocusLayoutMetrics,
  type FocusLayoutResult,
  type FocusTreePlan,
} from './model.js';
import { FOCUS_LAYOUT_WORK_MAX } from './limits.js';
import { FocusLayoutWorkBudget, layoutFocusTree, layoutFocusTreeAsync } from './layout.js';

const COMPACT_SAME_ROW_SPACING = 2;
const COMPACT_LANE_SPACING = 8;
const SMALL_COMPACT_SCALES = [0.2, 0.3, 0.4, 0.55, 0.7, 0.9] as const;
const LARGE_COMPACT_SCALES = [0.55, 0.6, 0.7, 0.8] as const;
const COMPACT_LAYOUT_WORK_MAX = FOCUS_LAYOUT_WORK_MAX * 10;
const COMPACT_HARD_DIAGNOSTICS = new Set([
  'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED',
  'FOCUS_LAYOUT_COORDINATE_CONFLICT',
  'FOCUS_LAYOUT_LANE_BOUNDS_UNSATISFIED',
  'FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED',
  'FOCUS_LAYOUT_PARENT_ORDER_UNSATISFIED',
  'FOCUS_LAYOUT_SAME_ROW_SPACING_UNSATISFIED',
  'FOCUS_LAYOUT_VISIBLE_OVERLAP',
]);

interface CompactLimits {
  maximumColumns: number;
  maximumHorizontalSpan: number;
  maximumVerticalSpan: number;
  maximumManhattanSpan: number;
  maximumLongConnectors: number;
  maximumNodeIntersections: number;
  maximumSiblingDeviation: number;
  maximumTotalSiblingDeviation: number;
}

function compactLimits(focusCount: number, connectorCount: number): CompactLimits {
  const graphScale = Math.sqrt(Math.max(1, focusCount));
  const maximumHorizontalSpan = Math.max(14, Math.ceil(graphScale * 3));
  const maximumVerticalSpan = Math.max(4, Math.ceil(Math.log2(Math.max(2, focusCount))));
  return {
    maximumColumns: Math.max(16, Math.ceil(graphScale * 5)),
    maximumHorizontalSpan,
    maximumVerticalSpan,
    maximumManhattanSpan: maximumHorizontalSpan + maximumVerticalSpan,
    maximumLongConnectors: Math.ceil(connectorCount * 0.05),
    maximumNodeIntersections: Math.ceil(connectorCount * 0.12),
    maximumSiblingDeviation: Math.max(2, Math.ceil(graphScale * 2)),
    maximumTotalSiblingDeviation: Math.max(4, Math.ceil(focusCount * 0.5)),
  };
}

function requiredMetrics(layout: FocusLayoutResult): FocusLayoutMetrics {
  if (layout.metrics !== undefined) return layout.metrics;
  throw new ServiceError(
    'FOCUS_COMPACT_METRICS_REQUIRED',
    'Compact focus reflow requires current layout quality metrics',
    { treeId: layout.treeId },
  );
}

function absoluteCompactRegressions(layout: FocusLayoutResult): string[] {
  const metrics = requiredMetrics(layout);
  const limits = compactLimits(layout.nodes.length, metrics.connectors.count);
  return [
    ...(layout.diagnostics.some(({ code }) => COMPACT_HARD_DIAGNOSTICS.has(code))
      ? ['hardLayoutDiagnostics']
      : []),
    ...(metrics.connectors.crossingCount > 0 ? ['connectorCrossingCount'] : []),
    ...(metrics.connectors.nodeIntersectionCount > limits.maximumNodeIntersections
      ? ['connectorNodeIntersectionBudget']
      : []),
    ...(metrics.spacing.tooCloseSameRowPairCount > 0 ? ['sameRowSpacing'] : []),
    ...(metrics.symmetry.maximumSiblingDeviation > 1 ? ['siblingMirrorDeviation'] : []),
    ...(metrics.symmetry.totalSiblingDeviation > metrics.symmetry.siblingCohortCount
      ? ['totalSiblingMirrorDeviation']
      : []),
    ...(metrics.symmetry.maximumSiblingAnchorDeviation > limits.maximumSiblingDeviation
      ? ['maximumSiblingDeviationBudget']
      : []),
    ...(metrics.symmetry.totalSiblingAnchorDeviation > limits.maximumTotalSiblingDeviation
      ? ['totalSiblingDeviationBudget']
      : []),
    ...(metrics.symmetry.boundingCenterOffsetTwice > 1 ? ['boundingCenter'] : []),
    ...(metrics.bounds.columnCount > limits.maximumColumns ? ['columnBudget'] : []),
    ...(metrics.connectors.maximumHorizontalSpan > limits.maximumHorizontalSpan
      ? ['maximumHorizontalConnectorBudget']
      : []),
    ...(metrics.connectors.maximumVerticalSpan > limits.maximumVerticalSpan
      ? ['maximumVerticalConnectorBudget']
      : []),
    ...(metrics.connectors.maximumManhattanSpan > limits.maximumManhattanSpan
      ? ['maximumManhattanConnectorBudget']
      : []),
    ...(metrics.connectors.longConnectorCount > limits.maximumLongConnectors
      ? ['longConnectorBudget']
      : []),
  ];
}

function relativeCompactRegressions(
  current: FocusLayoutResult,
  proposed: FocusLayoutResult,
): string[] {
  const before = requiredMetrics(current);
  const after = requiredMetrics(proposed);
  return [
    ...(after.connectors.crossingCount > before.connectors.crossingCount
      ? ['connectorCrossingCount']
      : []),
    ...(after.connectors.nodeIntersectionCount > before.connectors.nodeIntersectionCount
      ? ['connectorNodeIntersectionCount']
      : []),
    ...(after.connectors.maximumHorizontalSpan > before.connectors.maximumHorizontalSpan
      ? ['maximumHorizontalConnectorSpan']
      : []),
    ...(after.connectors.maximumVerticalSpan > before.connectors.maximumVerticalSpan
      ? ['maximumVerticalConnectorSpan']
      : []),
    ...(after.connectors.maximumManhattanSpan > before.connectors.maximumManhattanSpan
      ? ['maximumManhattanConnectorSpan']
      : []),
    ...(after.connectors.longConnectorCount > before.connectors.longConnectorCount
      ? ['longConnectorCount']
      : []),
    ...(after.connectors.totalHorizontalSpan > before.connectors.totalHorizontalSpan
      ? ['totalHorizontalConnectorSpan']
      : []),
    ...(after.connectors.totalManhattanSpan > before.connectors.totalManhattanSpan
      ? ['totalManhattanConnectorSpan']
      : []),
    ...(after.bounds.columnCount > before.bounds.columnCount ? ['columnCount'] : []),
    ...(after.bounds.rowCount > before.bounds.rowCount ? ['rowCount'] : []),
  ];
}

function compactShape(plan: FocusTreePlan, layout: FocusLayoutResult): boolean {
  return (
    plan.focuses.every(({ position }) => position.mode === 'auto') &&
    plan.laneGroups.every(
      ({ minimumX, maximumX }) => minimumX === undefined && maximumX === undefined,
    ) &&
    absoluteCompactRegressions(layout).length === 0
  );
}

function prerequisiteIds(plan: FocusTreePlan, focusId: string): string[] {
  const focus = plan.focuses.find(({ id }) => id === focusId);
  return (
    focus?.prerequisites.groups
      .flatMap(({ focusIds }) => focusIds)
      .sort((left, right) => compareCodeUnits(left, right)) ?? []
  );
}

function focusLaneId(plan: FocusTreePlan, focus: FocusTreePlan['focuses'][number]): string {
  if (focus.laneId !== undefined) return focus.laneId;
  if (focus.branchId !== undefined) {
    const branch = plan.branchGroups.find(({ id }) => id === focus.branchId);
    return branch?.laneId ?? focus.branchId;
  }
  return 'default';
}

function compactLaneBases(plan: FocusTreePlan): Map<string, number> {
  const configured = [...plan.laneGroups].sort(
    (left, right) => left.order - right.order || compareCodeUnits(left.id, right.id),
  );
  const configuredIds = new Set(configured.map(({ id }) => id));
  const discovered = [...new Set(plan.focuses.map((focus) => focusLaneId(plan, focus)))]
    .filter((id) => !configuredIds.has(id))
    .sort((left, right) => compareCodeUnits(left, right));
  const laneIds = [...configured.map(({ id }) => id), ...discovered];
  return new Map(
    laneIds.map((id, index) => [
      id,
      Math.round((index - (laneIds.length - 1) / 2) * COMPACT_LANE_SPACING),
    ]),
  );
}

function compactStructuralAnchorX(
  plan: FocusTreePlan,
  focus: FocusTreePlan['focuses'][number],
  parents: readonly string[],
  preferredX: ReadonlyMap<string, number>,
  laneBases: ReadonlyMap<string, number>,
): number {
  const parentCoordinates = parents
    .flatMap((focusId) => {
      const coordinate = preferredX.get(focusId);
      return coordinate === undefined ? [] : [coordinate];
    })
    .sort((left, right) => left - right);
  if (parentCoordinates.length > 1 && focus.convergence) {
    return Math.floor(
      parentCoordinates.reduce((total, coordinate) => total + coordinate, 0) /
        parentCoordinates.length,
    );
  }
  if (parentCoordinates.length > 0) {
    const middle = Math.floor(parentCoordinates.length / 2);
    if (parentCoordinates.length % 2 === 1) return parentCoordinates[middle] ?? 0;
    return Math.floor(
      ((parentCoordinates[middle - 1] ?? 0) + (parentCoordinates[middle] ?? 0)) / 2,
    );
  }
  return laneBases.get(focusLaneId(plan, focus)) ?? 0;
}

function mirrorSiblingCohorts(
  plan: FocusTreePlan,
  preferredX: Map<string, number>,
  preferredY: ReadonlyMap<string, number>,
): void {
  const cohorts = new Map<string, string[]>();
  const laneBases = compactLaneBases(plan);
  const childCounts = new Map<string, number>();
  for (const focus of plan.focuses) {
    const parents = prerequisiteIds(plan, focus.id);
    for (const parentId of parents) childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    const key = JSON.stringify([
      parents.length === 0 ? focusLaneId(plan, focus) : null,
      parents,
      preferredY.get(focus.id) ?? 0,
    ]);
    const cohort = cohorts.get(key) ?? [];
    cohort.push(focus.id);
    cohorts.set(key, cohort);
  }
  for (const cohort of cohorts.values()) {
    if (cohort.length < 2) continue;
    cohort.sort(
      (left, right) =>
        (preferredX.get(left) ?? 0) - (preferredX.get(right) ?? 0) || compareCodeUnits(left, right),
    );
    const coordinates = cohort.map((id) => preferredX.get(id) ?? 0);
    const pairCount = Math.floor(coordinates.length / 2);
    const focus = plan.focuses.find(({ id }) => id === cohort[0]);
    if (focus === undefined) continue;
    // A leaf fan can be mirrored directly around its structural parent. For
    // rooted subtrees, moving only the entry focuses would push the long
    // connectors into their descendants; keep the subtree envelope's center
    // until the bounded gateway refinement can move the common parent.
    const leafFan = cohort.every((focusId) => (childCounts.get(focusId) ?? 0) === 0);
    const mirroredAt = (centerTwice: number): number[] => {
      const mirrored = [...coordinates];
      for (let index = 0; index < pairCount; index += 1) {
        const opposite = coordinates.length - 1 - index;
        const left = Math.round(
          ((coordinates[index] ?? 0) + centerTwice - (coordinates[opposite] ?? 0)) / 2,
        );
        mirrored[index] = left;
        mirrored[opposite] = centerTwice - left;
      }
      if (coordinates.length % 2 === 1) mirrored[pairCount] = Math.round(centerTwice / 2);
      let maximumLeft = centerTwice / 2 - (coordinates.length % 2 === 1 ? 2 : 1);
      for (let index = pairCount - 1; index >= 0; index -= 1) {
        const opposite = coordinates.length - 1 - index;
        const left = Math.min(mirrored[index] ?? maximumLeft, maximumLeft);
        mirrored[index] = left;
        mirrored[opposite] = centerTwice - left;
        maximumLeft = left - COMPACT_SAME_ROW_SPACING;
      }
      return mirrored;
    };
    const selfCenterTwice = (coordinates[0] ?? 0) + (coordinates.at(-1) ?? 0);
    const anchorCenterTwice =
      2 *
      compactStructuralAnchorX(plan, focus, prerequisiteIds(plan, focus.id), preferredX, laneBases);
    let mirrored = mirroredAt(leafFan ? anchorCenterTwice : selfCenterTwice);
    if (leafFan) {
      const cohortIds = new Set(cohort);
      const y = preferredY.get(cohort[0] ?? '');
      const otherCoordinates = plan.focuses.flatMap((candidate) =>
        !cohortIds.has(candidate.id) && preferredY.get(candidate.id) === y
          ? [preferredX.get(candidate.id) ?? 0]
          : [],
      );
      if (
        mirrored.some((coordinate) =>
          otherCoordinates.some(
            (otherCoordinate) => Math.abs(coordinate - otherCoordinate) < COMPACT_SAME_ROW_SPACING,
          ),
        )
      ) {
        mirrored = mirroredAt(selfCenterTwice);
      }
    }
    for (const [index, focusId] of cohort.entries()) preferredX.set(focusId, mirrored[index] ?? 0);
  }
}

function compactCandidate(
  plan: FocusTreePlan,
  layout: FocusLayoutResult,
  scale: number,
  compressRows: boolean,
): FocusTreePlan {
  const minimumX = Math.min(...layout.nodes.map(({ x }) => x));
  const maximumX = Math.max(...layout.nodes.map(({ x }) => x));
  const minimumY = Math.min(...layout.nodes.map(({ y }) => y));
  const centerX = (minimumX + maximumX) / 2;
  const preferredX = new Map(
    layout.nodes.map((node) => [node.id, Math.round((node.x - centerX) * scale)]),
  );
  const sourceRows = [...new Set(layout.nodes.map(({ y }) => y))].sort(
    (left, right) => left - right,
  );
  const compactRows = new Map(sourceRows.map((row, index) => [row, index]));
  const preferredY = new Map(
    layout.nodes.map((node) => [
      node.id,
      compressRows ? (compactRows.get(node.y) ?? node.y - minimumY) : node.y - minimumY,
    ]),
  );
  const rows = new Map<number, typeof layout.nodes>();
  for (const node of layout.nodes) {
    const row = rows.get(node.y) ?? [];
    row.push(node);
    rows.set(node.y, row);
  }
  for (const row of rows.values()) {
    row.sort((left, right) => left.x - right.x || compareCodeUnits(left.id, right.id));
    const placed: number[] = [];
    for (const [index, node] of row.entries()) {
      const requested = preferredX.get(node.id) ?? 0;
      placed.push(
        index === 0
          ? requested
          : Math.max(requested, (placed[index - 1] ?? 0) + COMPACT_SAME_ROW_SPACING),
      );
    }
    const drift = Math.round(
      row.reduce(
        (total, node, index) => total + (preferredX.get(node.id) ?? 0) - (placed[index] ?? 0),
        0,
      ) / row.length,
    );
    for (const [index, node] of row.entries())
      preferredX.set(node.id, (placed[index] ?? 0) + drift);
  }
  mirrorSiblingCohorts(plan, preferredX, preferredY);
  const compacted = structuredClone(plan);
  compacted.laneGroups = compacted.laneGroups.map(({ id, label, order }) => ({
    id,
    label,
    order,
  }));
  for (const focus of compacted.focuses) {
    focus.position = {
      mode: 'auto',
      pinned: false,
      preferredX: preferredX.get(focus.id) ?? 0,
      preferredY: preferredY.get(focus.id) ?? 0,
    };
  }
  compacted.provenance.importedPlanHash = focusPlanHash(compacted);
  return compacted;
}

function compactScore(layout: FocusLayoutResult): readonly (number | string)[] {
  const metrics = requiredMetrics(layout);
  return [
    metrics.connectors.longConnectorCount,
    metrics.connectors.maximumHorizontalSpan,
    metrics.bounds.columnCount,
    metrics.connectors.nodeIntersectionCount,
    metrics.connectors.totalHorizontalSpan,
    metrics.connectors.maximumManhattanSpan,
    metrics.bounds.rowCount,
    metrics.connectors.totalVerticalSpan,
    layout.layoutHash,
  ];
}

function betterScore(
  candidate: readonly (number | string)[],
  current: readonly (number | string)[],
): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const left = candidate[index];
    const right = current[index];
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left < right;
    return String(left) < String(right);
  }
  return false;
}

function compactScales(focusCount: number): readonly number[] {
  return focusCount <= 50
    ? SMALL_COMPACT_SCALES
    : focusCount <= 500
      ? LARGE_COMPACT_SCALES
      : focusCount <= 2_000
        ? ([0.55, 0.65, 0.75] as const)
        : ([0.65] as const);
}

/**
 * Produces a gameplay-neutral compact-reflow plan. Several deterministic
 * compression candidates are measured with the same layout engine; only a
 * centered, crossing-free, evenly spaced, branch-balanced candidate that
 * stays within absolute and source-relative connector budgets can win.
 */
export function compactFocusTreePlan(plan: FocusTreePlan): FocusTreePlan {
  const currentLayout = layoutFocusTree(plan);
  if (compactShape(plan, currentLayout)) {
    const stable = structuredClone(plan);
    stable.provenance.importedPlanHash = focusPlanHash(stable);
    return stable;
  }
  const scales = compactScales(plan.focuses.length);
  let selected: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  let fallback: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  for (const scale of scales) {
    for (const compressRows of plan.focuses.length <= 500 ? [false, true] : [false]) {
      const candidate = compactCandidate(plan, currentLayout, scale, compressRows);
      let layout: FocusLayoutResult;
      try {
        layout = layoutFocusTree(candidate);
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED')
          continue;
        throw error;
      }
      if (
        fallback === undefined ||
        betterScore(compactScore(layout), compactScore(fallback.layout))
      )
        fallback = { plan: candidate, layout };
      if (
        absoluteCompactRegressions(layout).length > 0 ||
        relativeCompactRegressions(currentLayout, layout).length > 0
      )
        continue;
      if (
        selected === undefined ||
        betterScore(compactScore(layout), compactScore(selected.layout))
      )
        selected = { plan: candidate, layout };
    }
  }
  if (selected !== undefined) return selected.plan;
  if (fallback !== undefined) {
    assertCompactLayoutQuality(currentLayout, fallback.layout);
    return fallback.plan;
  }
  throw new ServiceError(
    'FOCUS_COMPACT_LAYOUT_REQUIRED',
    'Compact focus planning did not produce a measurable layout candidate',
    { treeId: plan.id },
  );
}

export interface CompactFocusTreePlanAsyncOptions {
  signal?: AbortSignal;
  /** One ceiling shared by the current layout and every compact candidate. */
  maximumWork?: number;
}

export interface CompactFocusTreePlanAsyncResult {
  plan: FocusTreePlan;
  currentLayout: FocusLayoutResult;
  proposedLayout: FocusLayoutResult;
}

/**
 * Cooperative compact planning for protocol handlers. Candidate layouts share
 * one work budget, and the selected layout is returned for validation/rendering.
 */
export async function compactFocusTreePlanAsync(
  plan: FocusTreePlan,
  options: CompactFocusTreePlanAsyncOptions = {},
): Promise<CompactFocusTreePlanAsyncResult> {
  const workBudget = new FocusLayoutWorkBudget(options.maximumWork ?? COMPACT_LAYOUT_WORK_MAX);
  const layoutOptions = {
    workBudget,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const currentLayout = await layoutFocusTreeAsync(plan, layoutOptions);
  if (compactShape(plan, currentLayout)) {
    const stable = structuredClone(plan);
    stable.provenance.importedPlanHash = focusPlanHash(stable);
    return { plan: stable, currentLayout, proposedLayout: currentLayout };
  }

  let selected: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  let fallback: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  let exhausted: ServiceError | undefined;
  candidateSearch: for (const scale of compactScales(plan.focuses.length)) {
    for (const compressRows of plan.focuses.length <= 500 ? [false, true] : [false]) {
      options.signal?.throwIfAborted();
      const candidate = compactCandidate(plan, currentLayout, scale, compressRows);
      let layout: FocusLayoutResult;
      try {
        layout = await layoutFocusTreeAsync(candidate, layoutOptions);
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED') {
          exhausted = error;
          break candidateSearch;
        }
        throw error;
      }
      if (
        fallback === undefined ||
        betterScore(compactScore(layout), compactScore(fallback.layout))
      )
        fallback = { plan: candidate, layout };
      if (
        absoluteCompactRegressions(layout).length > 0 ||
        relativeCompactRegressions(currentLayout, layout).length > 0
      )
        continue;
      if (
        selected === undefined ||
        betterScore(compactScore(layout), compactScore(selected.layout))
      )
        selected = { plan: candidate, layout };
    }
  }

  if (selected !== undefined) {
    return { plan: selected.plan, currentLayout, proposedLayout: selected.layout };
  }
  if (exhausted !== undefined) throw exhausted;
  if (fallback !== undefined) {
    assertCompactLayoutQuality(currentLayout, fallback.layout);
    return { plan: fallback.plan, currentLayout, proposedLayout: fallback.layout };
  }
  throw new ServiceError(
    'FOCUS_COMPACT_LAYOUT_REQUIRED',
    'Compact focus planning did not produce a measurable layout candidate',
    { treeId: plan.id },
  );
}

/** Refuses compact rewrites that are not clean or trade readability for a smaller canvas. */
export function assertCompactLayoutQuality(
  current: FocusLayoutResult | undefined,
  proposed: FocusLayoutResult,
): void {
  const regressions = [
    ...absoluteCompactRegressions(proposed),
    ...(current === undefined ? [] : relativeCompactRegressions(current, proposed)),
  ].filter((value, index, all) => all.indexOf(value) === index);
  if (regressions.length === 0) return;
  throw new ServiceError(
    'FOCUS_COMPACT_QUALITY_BLOCKED',
    'Compact focus reflow failed the absolute or relative layout-quality gate',
    {
      treeId: proposed.treeId,
      regressions,
      limits: compactLimits(proposed.nodes.length, requiredMetrics(proposed).connectors.count),
      ...(current === undefined ? {} : { before: requiredMetrics(current) }),
      proposed: requiredMetrics(proposed),
    },
  );
}
