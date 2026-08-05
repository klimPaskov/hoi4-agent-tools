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
  'FOCUS_LAYOUT_CONNECTOR_THROUGH_NODE',
  'FOCUS_LAYOUT_COORDINATE_CONFLICT',
  'FOCUS_LAYOUT_LANE_BOUNDS_UNSATISFIED',
  'FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED',
  'FOCUS_LAYOUT_PARENT_NOT_ABOVE',
  'FOCUS_LAYOUT_PARENT_ORDER_UNSATISFIED',
  'FOCUS_LAYOUT_SAME_ROW_SPACING_UNSATISFIED',
  'FOCUS_LAYOUT_VISIBLE_OVERLAP',
]);

const COMPACT_AESTHETIC_DIAGNOSTICS = new Set([
  'FOCUS_LAYOUT_LINEAR_DETOUR',
  'FOCUS_LAYOUT_LONG_CONNECTOR',
  'FOCUS_LAYOUT_SIBLING_ANCHOR_DEVIATION',
  'FOCUS_LAYOUT_SIBLING_ASYMMETRY',
  'FOCUS_LAYOUT_STAIRCASE_CHAIN',
  'FOCUS_LAYOUT_ZIGZAG_CHAIN',
]);

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
  return [
    ...(layout.diagnostics.some(({ code }) => COMPACT_HARD_DIAGNOSTICS.has(code))
      ? ['hardLayoutDiagnostics']
      : []),
    ...(metrics.connectors.crossingCount > 0 ? ['connectorCrossingCount'] : []),
    ...(metrics.connectors.nodeIntersectionCount > 0 ? ['connectorNodeIntersections'] : []),
    ...(metrics.spacing.tooCloseSameRowPairCount > 0 ? ['sameRowSpacing'] : []),
    ...(metrics.symmetry.boundingCenterOffsetTwice > 1 ? ['boundingCenter'] : []),
  ];
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
  for (const focus of plan.focuses) {
    const parents = prerequisiteIds(plan, focus.id);
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
    const anchorCenterTwice =
      2 *
      compactStructuralAnchorX(plan, focus, prerequisiteIds(plan, focus.id), preferredX, laneBases);
    const mirrored = mirroredAt(anchorCenterTwice);
    for (const [index, focusId] of cohort.entries()) preferredX.set(focusId, mirrored[index] ?? 0);
  }
}

function straightenLinearChains(
  plan: FocusTreePlan,
  preferredX: Map<string, number>,
  preferredY: Map<string, number>,
): void {
  const parentIds = new Map(
    plan.focuses.map((focus) => [focus.id, prerequisiteIds(plan, focus.id)]),
  );
  const childIds = new Map<string, string[]>();
  for (const [focusId, parents] of parentIds) {
    for (const parentId of parents) {
      const children = childIds.get(parentId) ?? [];
      children.push(focusId);
      childIds.set(parentId, children);
    }
  }
  const ordered = [...plan.focuses].sort(
    (left, right) =>
      (preferredY.get(left.id) ?? 0) - (preferredY.get(right.id) ?? 0) ||
      compareCodeUnits(left.id, right.id),
  );
  for (const focus of ordered) {
    const parents = parentIds.get(focus.id) ?? [];
    if (parents.length !== 1) continue;
    const parentId = parents[0];
    if (parentId === undefined || (childIds.get(parentId)?.length ?? 0) !== 1) continue;
    const parentX = preferredX.get(parentId);
    const parentY = preferredY.get(parentId);
    if (parentX === undefined || parentY === undefined) continue;
    preferredX.set(focus.id, parentX);
    preferredY.set(focus.id, parentY + 1);
  }
}

interface CompactCandidateStrategy {
  scale: number;
  compressRows: boolean;
  mirrorSiblings: boolean;
  straightenChains: boolean;
}

function compactCandidate(
  plan: FocusTreePlan,
  layout: FocusLayoutResult,
  strategy: CompactCandidateStrategy,
): FocusTreePlan {
  const { scale, compressRows, mirrorSiblings, straightenChains } = strategy;
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
  if (mirrorSiblings) mirrorSiblingCohorts(plan, preferredX, preferredY);
  if (straightenChains) straightenLinearChains(plan, preferredX, preferredY);
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
  const hardDiagnosticCount = layout.diagnostics.filter(({ code }) =>
    COMPACT_HARD_DIAGNOSTICS.has(code),
  ).length;
  const aestheticDiagnosticCount = layout.diagnostics.filter(({ code }) =>
    COMPACT_AESTHETIC_DIAGNOSTICS.has(code),
  ).length;
  return [
    hardDiagnosticCount,
    metrics.connectors.crossingCount,
    metrics.connectors.nodeIntersectionCount,
    metrics.spacing.tooCloseSameRowPairCount,
    aestheticDiagnosticCount,
    metrics.connectors.longConnectorCount,
    metrics.symmetry.asymmetricSiblingCohortCount,
    metrics.symmetry.offAnchorSiblingCohortCount,
    metrics.symmetry.totalSiblingDeviation,
    metrics.symmetry.totalSiblingAnchorDeviation,
    metrics.bounds.rowCount,
    metrics.bounds.columnCount,
    metrics.connectors.maximumHorizontalSpan,
    metrics.connectors.totalHorizontalSpan,
    metrics.connectors.maximumManhattanSpan,
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

function compactStrategies(focusCount: number): readonly CompactCandidateStrategy[] {
  const preservationStrategies = [
    { scale: 1, compressRows: false, mirrorSiblings: false, straightenChains: false },
    { scale: 1, compressRows: true, mirrorSiblings: false, straightenChains: false },
    { scale: 1, compressRows: false, mirrorSiblings: false, straightenChains: true },
    { scale: 1, compressRows: false, mirrorSiblings: true, straightenChains: false },
  ] as const;
  const compactStrategies = compactScales(focusCount).flatMap((scale) => [
    { scale, compressRows: false, mirrorSiblings: true, straightenChains: true },
    { scale, compressRows: true, mirrorSiblings: true, straightenChains: true },
  ]);
  return [...preservationStrategies, ...compactStrategies];
}

function needsPresentationNormalization(plan: FocusTreePlan): boolean {
  return (
    plan.focuses.some(({ position }) => position.mode !== 'auto') ||
    plan.laneGroups.some(
      ({ minimumX, maximumX }) => minimumX !== undefined || maximumX !== undefined,
    )
  );
}

/**
 * Produces a gameplay-neutral compact-reflow plan. Several deterministic
 * repair and compression candidates are measured with the same layout engine.
 * Invalid geometry cannot win; aesthetic tradeoffs are resolved by the score.
 */
export function compactFocusTreePlan(plan: FocusTreePlan): FocusTreePlan {
  const currentLayout = layoutFocusTree(plan, { aggressiveAestheticRepair: true });
  const normalizedPlan = needsPresentationNormalization(plan)
    ? compactCandidate(plan, currentLayout, {
        scale: 1,
        compressRows: false,
        mirrorSiblings: false,
        straightenChains: false,
      })
    : plan;
  const normalizedLayout =
    normalizedPlan === plan
      ? currentLayout
      : layoutFocusTree(normalizedPlan, { aggressiveAestheticRepair: true });
  let selected: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  let fallback: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  for (const strategy of compactStrategies(plan.focuses.length)) {
    const candidate = compactCandidate(normalizedPlan, normalizedLayout, strategy);
    let layout: FocusLayoutResult;
    try {
      layout = layoutFocusTree(candidate, { aggressiveAestheticRepair: true });
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED')
        continue;
      throw error;
    }
    if (fallback === undefined || betterScore(compactScore(layout), compactScore(fallback.layout)))
      fallback = { plan: candidate, layout };
    if (absoluteCompactRegressions(layout).length > 0) continue;
    if (selected === undefined || betterScore(compactScore(layout), compactScore(selected.layout)))
      selected = { plan: candidate, layout };
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
    aggressiveAestheticRepair: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const currentLayout = await layoutFocusTreeAsync(plan, layoutOptions);
  const normalizedPlan = needsPresentationNormalization(plan)
    ? compactCandidate(plan, currentLayout, {
        scale: 1,
        compressRows: false,
        mirrorSiblings: false,
        straightenChains: false,
      })
    : plan;
  const normalizedLayout =
    normalizedPlan === plan
      ? currentLayout
      : await layoutFocusTreeAsync(normalizedPlan, layoutOptions);
  let selected: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  let fallback: { plan: FocusTreePlan; layout: FocusLayoutResult } | undefined;
  let exhausted: ServiceError | undefined;
  candidateSearch: for (const strategy of compactStrategies(plan.focuses.length)) {
    options.signal?.throwIfAborted();
    const candidate = compactCandidate(normalizedPlan, normalizedLayout, strategy);
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
    if (fallback === undefined || betterScore(compactScore(layout), compactScore(fallback.layout)))
      fallback = { plan: candidate, layout };
    if (absoluteCompactRegressions(layout).length > 0) continue;
    if (selected === undefined || betterScore(compactScore(layout), compactScore(selected.layout)))
      selected = { plan: candidate, layout };
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

/** Refuses compact rewrites that still contain invalid or unreadable geometry. */
export function assertCompactLayoutQuality(
  _current: FocusLayoutResult | undefined,
  proposed: FocusLayoutResult,
): void {
  const regressions = [...absoluteCompactRegressions(proposed)].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
  if (regressions.length === 0) return;
  throw new ServiceError(
    'FOCUS_COMPACT_QUALITY_BLOCKED',
    'Compact focus reflow failed the layout-correctness gate',
    {
      treeId: proposed.treeId,
      regressions,
      ...(_current === undefined ? {} : { before: requiredMetrics(_current) }),
      proposed: requiredMetrics(proposed),
    },
  );
}
