import { compareCodeUnits } from '../../core/canonical.js';
import {
  calibrationBucketFor,
  limitsFor,
  softMetricStatus,
  softVerdict,
  QUALITY_METRICS,
  qualityMetricInfo,
  supportsSoftMetrics,
  bucketIdForFocusCount,
  type QualityMetricInfo,
} from './calibration.js';
import { summarizeBranches, type BranchSummary } from './branches.js';
import { CONVERGENCE_ROW_WINDOW } from './metrics.js';
import type {
  MetricLimits,
  QualityBucketId,
  QualityCalibration,
  QualityGraph,
  QualityMeasurement,
  QualityMetricId,
  QualityVerdict,
} from './types.js';

export type ScorecardStatus = 'ok' | 'review' | 'revise' | 'blocked' | 'flag' | 'not_evaluated';

export interface ScorecardFix {
  action:
    | 'separate_focuses'
    | 'move_prerequisite_up'
    | 'reroute_connector'
    | 'align_under_parent'
    | 'recentre_cohort'
    | 'rebalance_branches'
    | 'fill_empty_area'
    | 'tighten_layout'
    | 'straighten_trunk'
    | 'untangle_siblings'
    | 'close_row_gap'
    | 'review_design';
  targetFocusIds: string[];
  suggested: string;
  expectedMetricChange: string;
  /** False for design flags: changing them changes what the player does. */
  preservesGameplay: boolean;
}

export interface ScorecardRow {
  id: QualityMetricId;
  name: string;
  group: 'H' | 'S' | 'D';
  value: number;
  unit: string;
  reviewLimit: number | null;
  reviseLimit: number | null;
  vanillaMedian: number | null;
  status: ScorecardStatus;
  /** False for rows that are shown but never move the verdict (S8). */
  inVerdict: boolean;
  where: string[];
  message: string;
  fix?: ScorecardFix;
}

export interface QualityReport {
  verdict: QualityVerdict;
  /** Convenience score from 0 to 100 for before and after comparisons; the verdict is authoritative. */
  score: number;
  summary: string;
  focusCount: number;
  bucket: QualityBucketId;
  /** False when the tree is below the size the vanilla calibration covers. */
  softMetricsEvaluated: boolean;
  scorecard: ScorecardRow[];
  nextActions: string[];
  notEvaluated: string[];
  branches: BranchSummary[];
}

const WHERE_LIMIT = 8;

const STATUS_ORDER: Record<ScorecardStatus, number> = {
  blocked: 0,
  revise: 1,
  review: 2,
  flag: 3,
  ok: 4,
  not_evaluated: 5,
};

/** What the tool never judges; echoed in every response so "ok" cannot read as "done". */
export const QUALITY_NOT_EVALUATED = [
  'gameplay and balance',
  'visual review: call hoi4.focus_render and look at the image',
  'in-game connector geometry at other UI scales and zoom levels: the orthogonal model is confirmed in game 1.19.4.1 at the default scale and zoom only',
] as const;

function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cap(ids: readonly string[]): string[] {
  return ids.slice(0, WHERE_LIMIT);
}

function listIds(ids: readonly string[], limit = 4): string {
  const shown = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${shown} and ${ids.length - limit} more` : shown;
}

function exceeds(info: QualityMetricInfo, value: number, limit: number): boolean {
  return info.direction === 'high' ? value > limit : value < limit;
}

interface RowDraft {
  where: string[];
  message: string;
  fix?: ScorecardFix;
}

function nearestBranches(
  branches: readonly BranchSummary[],
  centreX: number,
  centreY: number,
  count = 2,
): BranchSummary[] {
  return branches
    .filter(({ id }) => id !== '')
    .map((branch) => ({
      branch,
      distance: Math.hypot(branch.centroidX - centreX, (branch.centroidY - centreY) * 2),
    }))
    .sort((a, b) => a.distance - b.distance || compareCodeUnits(a.branch.id, b.branch.id))
    .slice(0, count)
    .map(({ branch }) => branch);
}

function draftFor(
  id: QualityMetricId,
  measurement: QualityMeasurement,
  graph: QualityGraph,
  branches: readonly BranchSummary[],
): RowDraft {
  const { locators, counts, values, width, rows, nodeCount } = measurement;
  const value = values[id] ?? 0;
  const position = (focusId: string) => graph.position.get(focusId)!;
  switch (id) {
    case 'H1': {
      const first = locators.duplicateCoordinates[0];
      return {
        where: cap(locators.duplicateCoordinates.flatMap(({ focusIds }) => focusIds)),
        message:
          first === undefined
            ? 'No two focuses share a coordinate'
            : `${listIds(first.focusIds)} share (${first.x}, ${first.y}); give each its own grid cell`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'separate_focuses' as const,
                targetFocusIds: cap(first.focusIds.slice(1)),
                suggested: `Move ${first.focusIds[1]} to a free cell on row ${first.y}, at least 2 columns from its neighbours`,
                expectedMetricChange: 'H1 reaches 0',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'H2': {
      const first = locators.parentNotAbove[0];
      return {
        where: cap(locators.parentNotAbove.flatMap(({ parentId, childId }) => [parentId, childId])),
        message:
          first === undefined
            ? 'Every prerequisite sits above its dependants'
            : `${first.parentId} is not above ${first.childId}; a prerequisite must sit on an earlier row`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'move_prerequisite_up' as const,
                targetFocusIds: [first.childId],
                suggested: `Move ${first.childId} to row ${position(first.parentId).y + 1} or lower`,
                expectedMetricChange: 'H2 reaches 0',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'H3': {
      const first = locators.overlaps[0];
      return {
        where: cap(locators.overlaps.flatMap(({ leftId, rightId }) => [leftId, rightId])),
        message:
          first === undefined
            ? 'No two plaques overlap on a row'
            : `${first.leftId} and ${first.rightId} are ${format(first.distance)} column apart on row ${first.y}, but a plaque is about 1.6 columns wide; spread them to 2`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'separate_focuses' as const,
                targetFocusIds: [first.rightId],
                suggested: `Move ${first.rightId} to x=${position(first.leftId).x + 2} (or ${first.leftId} to x=${position(first.rightId).x - 2})`,
                expectedMetricChange: `H3 falls from ${counts.overlaps} to ${Math.max(0, counts.overlaps - 1)} or less`,
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'H4': {
      const first = locators.stemsThroughPlaques[0];
      return {
        where: cap(
          locators.stemsThroughPlaques.flatMap(({ parentId, childId, focusId }) => [
            parentId,
            childId,
            focusId,
          ]),
        ),
        message:
          first === undefined
            ? 'No connector runs through an unrelated plaque'
            : `${counts.stemsThroughPlaques} connector stems run through plaques; ${first.parentId} to ${first.childId} passes ${first.focusId}`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'reroute_connector' as const,
                targetFocusIds: [first.focusId],
                suggested: `Move ${first.focusId} out of the column of ${first.parentId}, or move ${first.childId} closer to ${first.parentId}`,
                expectedMetricChange: 'H4 falls toward 0 per 100 links',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'H5': {
      const first = locators.crossings[0];
      return {
        where: cap(
          locators.crossings.flatMap(
            ({ firstParentId, firstChildId, secondParentId, secondChildId }) => [
              firstParentId,
              firstChildId,
              secondParentId,
              secondChildId,
            ],
          ),
        ),
        message:
          first === undefined
            ? 'No unrelated connectors cross'
            : `${counts.crossings} unrelated connectors cross; ${first.firstParentId} to ${first.firstChildId} crosses ${first.secondParentId} to ${first.secondChildId}`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'reroute_connector' as const,
                targetFocusIds: [first.firstChildId, first.secondChildId],
                suggested: `Swap the columns of ${first.firstChildId} and ${first.secondChildId}, or move one of them to the other side of ${first.firstParentId}`,
                expectedMetricChange: 'H5 falls toward 0 per 100 links',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'S1': {
      const region = locators.emptyRectangle;
      if (region === null) return { where: [], message: 'No empty area' };
      const near = nearestBranches(
        branches,
        (region.minimumX + region.maximumX) / 2,
        (region.minimumY + region.maximumY) / 2,
      );
      return {
        where: cap(near.map(({ id }) => id)),
        message: `A ${region.maximumX - region.minimumX + 1} by ${region.maximumY - region.minimumY + 1} cell area (${percent(value)} of the canvas) is empty at columns ${region.minimumX} to ${region.maximumX}, rows ${region.minimumY} to ${region.maximumY}${near.length > 0 ? `; nearest branches: ${near.map(({ id }) => id).join(', ')}` : ''}`,
        fix: {
          action: 'fill_empty_area',
          targetFocusIds: cap(near.map(({ id }) => id)),
          suggested:
            'Lengthen the short branch, move it under the heavier branch, or recentre the trunk on the heavier subtree; this is a design call',
          expectedMetricChange: `S1 falls from ${format(value)} toward the vanilla median`,
          preservesGameplay: true,
        },
      };
    }
    case 'S2':
    case 'S3': {
      const heavySide = locators.sides.left >= locators.sides.right ? 'left' : 'right';
      const heavy = branches
        .filter(
          ({ id, centroidX }) =>
            id !== '' &&
            (heavySide === 'left'
              ? centroidX < locators.sides.centre
              : centroidX > locators.sides.centre),
        )
        .sort((a, b) => b.focusCount - a.focusCount || compareCodeUnits(a.id, b.id))[0];
      return {
        where: heavy === undefined ? [] : [heavy.id],
        message:
          id === 'S2'
            ? `${locators.sides.left} focuses sit left of column ${format(locators.sides.centre)} and ${locators.sides.right} right of it`
            : `The focus mass sits ${format(value * 100)}% of the half width off the canvas centre`,
        fix: {
          action: 'rebalance_branches',
          targetFocusIds: heavy === undefined ? [] : [heavy.id],
          suggested: `Recentre the trunk on the ${heavySide} side${heavy === undefined ? '' : ` (largest branch: ${heavy.id}, ${heavy.focusCount} focuses)`}, or move a branch to the lighter side`,
          expectedMetricChange: `${id} falls from ${format(value)} toward the vanilla median`,
          preservesGameplay: true,
        },
      };
    }
    case 'S4':
      return {
        where: [],
        message: `${nodeCount} focuses cover ${width + 1} columns by ${rows} rows, a fill of ${format(value)}`,
        fix: {
          action: 'tighten_layout',
          targetFocusIds: [],
          suggested:
            'Pull lanes closer together and close empty rows with focus_rewrite layoutMode compact',
          expectedMetricChange: `S4 rises from ${format(value)} toward the vanilla median`,
          preservesGameplay: true,
        },
      };
    case 'S5': {
      const centroids = locators.rowCentroids;
      return {
        where: [],
        message:
          centroids === null
            ? 'Row centres stay aligned'
            : `Row centres wander ${format(centroids.maximumMean - centroids.minimumMean)} columns: row ${centroids.minimumRow} is centred at x=${format(centroids.minimumMean)} and row ${centroids.maximumRow} at x=${format(centroids.maximumMean)}`,
        fix: {
          action: 'straighten_trunk',
          targetFocusIds: [],
          suggested:
            'Straighten the trunk so each generation stays under its parent instead of stepping sideways',
          expectedMetricChange: `S5 falls from ${format(value)} toward the vanilla median`,
          preservesGameplay: true,
        },
      };
    }
    case 'S6': {
      const first = locators.detours[0];
      return {
        where: cap(locators.detours.flatMap(({ parentId, childId }) => [parentId, childId])),
        message:
          first === undefined
            ? 'Single-focus chains run straight down'
            : `${counts.detours} single-focus links jog sideways; ${first.parentId} to ${first.childId} is ${Math.abs(first.dx)} column${Math.abs(first.dx) === 1 ? '' : 's'} off`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'align_under_parent' as const,
                targetFocusIds: cap(locators.detours.map(({ childId }) => childId)),
                suggested: `Place ${first.childId} at x=${position(first.parentId).x}, directly under ${first.parentId}, together with its subtree`,
                expectedMetricChange: `S6 falls by ${format(100 / Math.max(1, measurement.edgeCount))} per 100 links per straightened link`,
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'S7': {
      const first = locators.interleavedPairs[0];
      return {
        where: cap(
          locators.interleavedPairs.flatMap(({ firstChildId, secondChildId }) => [
            firstChildId,
            secondChildId,
          ]),
        ),
        message:
          first === undefined
            ? 'Sibling subtrees stay in their own columns'
            : `The subtrees of ${first.firstChildId} and ${first.secondChildId} (children of ${first.parentId}) share columns on the same rows`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'untangle_siblings' as const,
                targetFocusIds: [first.firstChildId, first.secondChildId],
                suggested: `Give ${first.firstChildId} and ${first.secondChildId} separate column bands`,
                expectedMetricChange: 'S7 falls toward 0',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'S8': {
      const first = locators.offCenterCohorts[0];
      return {
        where: cap(
          locators.offCenterCohorts.flatMap(({ parentId, childIds }) => [parentId, ...childIds]),
        ),
        message:
          first === undefined
            ? 'Fan-outs are centred under their parents'
            : `Children of ${first.parentId} (${listIds(first.childIds)}) are centred at x=${format(first.centre)} but ${first.parentId} is at x=${position(first.parentId).x}`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'recentre_cohort' as const,
                targetFocusIds: cap(first.childIds),
                suggested: `Move the children by ${format(position(first.parentId).x - first.centre)} columns, or move ${first.parentId} to x=${format(first.centre)}`,
                expectedMetricChange: 'S8 for this fan-out falls to 0',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'S9': {
      const first = locators.mergedBars[0];
      return {
        where: cap(
          locators.mergedBars.flatMap(
            ({ firstParentId, firstChildId, secondParentId, secondChildId }) => [
              firstParentId,
              firstChildId,
              secondParentId,
              secondChildId,
            ],
          ),
        ),
        message:
          first === undefined
            ? 'No unrelated connectors share a bar'
            : `${counts.mergedBars} pairs of unrelated connectors share a bar or stem; ${first.firstParentId} to ${first.firstChildId} overlaps ${first.secondParentId} to ${first.secondChildId}`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'reroute_connector' as const,
                targetFocusIds: [first.firstChildId, first.secondChildId],
                suggested:
                  'Offset one child by a column so the two connectors no longer share a bar',
                expectedMetricChange: 'S9 falls toward 0 per 100 links',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'S10': {
      const first = locators.slackChildren[0];
      return {
        where: cap(locators.slackChildren.map(({ childId }) => childId)),
        message:
          first === undefined
            ? 'No focus waits below an empty row'
            : `${first.childId} sits ${first.slack} row${first.slack === 1 ? '' : 's'} below the row after its lowest prerequisite`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'close_row_gap' as const,
                targetFocusIds: [first.childId],
                suggested: `Move ${first.childId} and its subtree up ${first.slack} row${first.slack === 1 ? '' : 's'}`,
                expectedMetricChange: 'S10 falls toward 1',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'S11': {
      const first = locators.mixedRowCohorts[0];
      return {
        where: cap(
          locators.mixedRowCohorts.flatMap(({ parentId, childIds }) => [parentId, ...childIds]),
        ),
        message:
          first === undefined
            ? 'Sibling groups sit on one row'
            : `Children of ${first.parentId} (${listIds(first.childIds)}) sit on different rows`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'tighten_layout' as const,
                targetFocusIds: cap(first.childIds),
                suggested: `Put the children of ${first.parentId} on one row unless the stagger is intended`,
                expectedMetricChange: 'S11 falls toward 0',
                preservesGameplay: true,
              },
            }),
      };
    }
    case 'D1':
      return {
        where: cap(locators.longestChain),
        message: `${locators.longestChain.length} single-successor focuses in a row (${locators.longestChain[0]} to ${locators.longestChain[locators.longestChain.length - 1]}); the player makes no choice along the way`,
        fix: {
          action: 'review_design',
          targetFocusIds: cap(locators.longestChain),
          suggested: 'Merge steps, add a branch or a choice, or confirm the chain is intended',
          expectedMetricChange: 'D1 falls to the vanilla range',
          preservesGameplay: false,
        },
      };
    case 'D2':
      return {
        where: [],
        message: `${counts.leaves} of ${nodeCount} focuses (${percent(value)}) are leaves with no follow-up`,
        fix: {
          action: 'review_design',
          targetFocusIds: [],
          suggested: 'Check that every leaf is a real payoff or give it a follow-up',
          expectedMetricChange: 'D2 falls to the vanilla range',
          preservesGameplay: false,
        },
      };
    case 'D3': {
      const first = locators.convergingChoices[0];
      return {
        where: cap(
          locators.convergingChoices.flatMap(({ choiceIds, convergenceId }) => [
            ...choiceIds,
            convergenceId,
          ]),
        ),
        message:
          first === undefined
            ? 'Exclusive choices keep distinct outcomes'
            : `Choices ${listIds(first.choiceIds)} all reconverge at ${first.convergenceId}, ${first.rows} rows later (within ${CONVERGENCE_ROW_WINDOW} rows), so the exclusivity has no lasting consequence in the drawn tree`,
        ...(first === undefined
          ? {}
          : {
              fix: {
                action: 'review_design' as const,
                targetFocusIds: cap([...first.choiceIds, first.convergenceId]),
                suggested:
                  'Confirm the brief wants the choices to rejoin, or give each route its own continuation',
                expectedMetricChange: 'D3 reaches 0 or is confirmed intended',
                preservesGameplay: false,
              },
            }),
      };
    }
    case 'D4':
      return {
        where: [],
        message: `The canvas is ${rows} rows tall for ${format(width / 2)} plaque columns, which reads as a ribbon`,
        fix: {
          action: 'review_design',
          targetFocusIds: [],
          suggested: 'Add parallel lanes or shorten the tree so it reads as a shape',
          expectedMetricChange: 'D4 falls below 2.5',
          preservesGameplay: false,
        },
      };
  }
}

function excessRatio(info: QualityMetricInfo, value: number, limits: MetricLimits): number {
  const span = Math.abs(limits.revise - limits.review);
  const beyond = info.direction === 'high' ? value - limits.review : limits.review - value;
  if (beyond <= 0) return 0;
  return span > 0 ? beyond / span : 1;
}

export interface QualityEvaluationOptions {
  /** Focus ids to suggest in a `compact` next action when a branch is the culprit. */
  treeId?: string;
}

/** Applies the calibration to a measurement and produces the verdict, scorecard and fix hints. */
export function reportLayoutQuality(
  graph: QualityGraph,
  measurement: QualityMeasurement,
  calibration: QualityCalibration,
  options: QualityEvaluationOptions = {},
): QualityReport {
  const focusCount = measurement.nodeCount;
  const bucketId = bucketIdForFocusCount(focusCount);
  const bucket = calibrationBucketFor(calibration, focusCount);
  const softEvaluated = supportsSoftMetrics(focusCount);
  const rules = calibration.verdictRules;
  const branches = summarizeBranches(graph);
  const vanillaMedian = (id: QualityMetricId): number | null => bucket.statistics[id]?.p50 ?? null;
  const rows: ScorecardRow[] = [];
  let scorePenalty = 0;
  for (const info of QUALITY_METRICS) {
    const value = measurement.values[info.id];
    if (value === undefined) continue;
    const limits = limitsFor(bucket, info.id);
    const draft = draftFor(info.id, measurement, graph, branches);
    const isSoft = info.group !== 'H' || info.calibrated;
    const inVerdict = info.id !== 'S8';
    // Limits are stored with four decimals, so compare the value at the same precision.
    const comparable = Number(value.toFixed(4));
    let status: ScorecardStatus = 'ok';
    if (!softEvaluated && (isSoft || info.group === 'D')) status = 'not_evaluated';
    else if (info.group === 'H' && !info.calibrated) status = value > 0 ? 'blocked' : 'ok';
    else if (info.group === 'D') {
      const flagLimit = limits?.revise ?? Number.POSITIVE_INFINITY;
      status = exceeds(info, comparable, flagLimit) ? 'flag' : 'ok';
    } else if (limits !== undefined) {
      status = softMetricStatus(info.id, value, limits, bucketId, rules);
    }
    const row: ScorecardRow = {
      id: info.id,
      name: info.name,
      group: info.group,
      value: Number(value.toFixed(4)),
      unit: info.unit,
      reviewLimit: limits?.review ?? null,
      reviseLimit: limits?.revise ?? null,
      vanillaMedian: vanillaMedian(info.id),
      status,
      inVerdict,
      where: status === 'ok' || status === 'not_evaluated' ? [] : draft.where,
      message: draft.message,
      ...(draft.fix === undefined || status === 'ok' || status === 'not_evaluated'
        ? {}
        : { fix: draft.fix }),
    };
    rows.push(row);
    if (status === 'blocked') scorePenalty += 25;
    else if (status === 'flag') scorePenalty += 5;
    else if (limits !== undefined && inVerdict && info.calibrated) {
      const weight = calibration.scoreWeights[info.id] ?? 1;
      scorePenalty += weight * Math.min(2, excessRatio(info, value, limits)) * 20;
    }
  }
  const scoredRows = rows.filter(
    ({ inVerdict, group, id: rowId }) =>
      inVerdict && (group === 'S' || rowId === 'H4' || rowId === 'H5'),
  );
  const beyondReview = scoredRows.filter(
    ({ status }) => status === 'review' || status === 'revise',
  );
  const flags = rows.filter(({ status }) => status === 'flag');
  const soft = softVerdict(
    scoredRows.flatMap(({ id: rowId, status }) =>
      status === 'ok' || status === 'review' || status === 'revise' ? [{ id: rowId, status }] : [],
    ),
    bucketId,
    rules,
  );
  let verdict: QualityVerdict = 'pass';
  if (rows.some(({ status }) => status === 'blocked')) verdict = 'blocked';
  else if (soft === 'revise') verdict = 'revise';
  else if (soft === 'review' || flags.length > 0) verdict = 'review';
  rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.group.localeCompare(b.group) ||
      compareCodeUnits(a.id, b.id),
  );
  const parts: string[] = [];
  const beyond = beyondReview.length;
  if (rows.some(({ status }) => status === 'blocked'))
    parts.push(`${rows.filter(({ status }) => status === 'blocked').length} hard defect group(s)`);
  if (beyond > 0) parts.push(`${beyond} metric${beyond === 1 ? '' : 's'} beyond the vanilla range`);
  if (flags.length > 0) parts.push(`${flags.length} design flag${flags.length === 1 ? '' : 's'}`);
  const summary = `layout verdict: ${verdict}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}${softEvaluated ? '' : '; too few focuses for the vanilla-calibrated metrics'}`;
  const nextActions = nextActionsFor(verdict, rows, branches, options.treeId);
  return {
    verdict,
    score: Math.max(0, Math.round(100 - scorePenalty)),
    summary,
    focusCount,
    bucket: bucketId,
    softMetricsEvaluated: softEvaluated,
    scorecard: rows,
    nextActions,
    notEvaluated: [...QUALITY_NOT_EVALUATED, ...measurement.notEvaluated],
    branches,
  };
}

function nextActionsFor(
  verdict: QualityVerdict,
  rows: readonly ScorecardRow[],
  branches: readonly BranchSummary[],
  treeId: string | undefined,
): string[] {
  const failing = rows.filter(
    ({ status, inVerdict }) =>
      inVerdict && (status === 'blocked' || status === 'revise' || status === 'review'),
  );
  const names = failing.map(({ id: rowId }) => rowId).join(', ');
  const target = treeId === undefined ? '' : `"treeId":"${treeId}",`;
  const actions: string[] = [];
  if (verdict === 'blocked')
    actions.push(
      `Fix the hard defects (${rows
        .filter(({ status }) => status === 'blocked')
        .map(({ id: rowId }) => rowId)
        .join(', ')}) before anything else; then call hoi4.focus_inspect again`,
    );
  if (verdict === 'blocked' || verdict === 'revise') {
    const culprit = branches.find(({ id: branchId }) =>
      failing.some(({ where }) => where.includes(branchId)),
    );
    actions.push(
      culprit === undefined
        ? `Repair the layout: hoi4.focus_rewrite {${target}"layoutMode":"compact"}; failing metrics: ${names}`
        : `Repair one branch: hoi4.focus_rewrite {${target}"layoutMode":"compact","compactFocusIds":[...focuses of ${culprit.id}],"pinnedFocusIds":[trunk]}; failing metrics: ${names}`,
    );
    actions.push(
      'A tree is not finished while the verdict is revise or blocked, however clean the structure is',
    );
  } else if (verdict === 'review') {
    actions.push(
      `Look at the picture before you decide: call hoi4.focus_render and judge ${names === '' ? 'the design flags' : names}; review is advisory`,
    );
  } else {
    actions.push(
      'Call hoi4.focus_render and look at the picture; metrics cannot judge composition',
    );
  }
  return actions;
}

export { QUALITY_METRICS, qualityMetricInfo };
