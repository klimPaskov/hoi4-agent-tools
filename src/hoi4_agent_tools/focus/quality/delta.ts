import { compareCodeUnits, hashCanonical } from '../../core/canonical.js';
import type { FocusTreePlan } from '../model.js';
import { qualityMetricInfo } from './calibration.js';
import type { QualityReport } from './scorecard.js';
import type { QualityMetricId, QualityNode, QualityVerdict } from './types.js';

const LISTED_FOCUS_LIMIT = 100;

export interface FocusLayoutSide {
  plan: Pick<FocusTreePlan, 'focuses'>;
  nodes: readonly QualityNode[];
  report: QualityReport;
}

/** What a layout change did, in the terms an agent needs to decide whether to keep going. */
export interface FocusLayoutDelta {
  verdictBefore: QualityVerdict | null;
  verdictAfter: QualityVerdict;
  scoreBefore: number | null;
  scoreAfter: number;
  /** Metrics that moved toward the vanilla range, by a margin that is not rounding noise. */
  improved: QualityMetricId[];
  regressed: QualityMetricId[];
  movedFocusCount: number;
  movedFocusIds: string[];
  unmovedFocusCount: number;
  /** Hash of the id, coordinate and anchor of every focus that did not move. */
  unmovedHash: string;
  /** Hash of the prerequisite blocks; equal before and after proves gameplay relations are unchanged. */
  prerequisiteHash: string;
  prerequisitesUnchanged: boolean | null;
  mutualExclusionHash: string;
  mutualExclusionsUnchanged: boolean | null;
}

function anchorOf(plan: Pick<FocusTreePlan, 'focuses'>): Map<string, string | null> {
  return new Map(
    plan.focuses.map((focus) => [
      focus.id,
      focus.position.mode === 'relative' ? focus.position.relativeTo : null,
    ]),
  );
}

function prerequisiteHashOf(plan: Pick<FocusTreePlan, 'focuses'>): string {
  return hashCanonical(
    [...plan.focuses]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((focus) => [
        focus.id,
        focus.prerequisites.groups
          .map(({ focusIds }) => [...focusIds].sort(compareCodeUnits).join('\0'))
          .sort(compareCodeUnits),
      ]),
  );
}

function exclusionHashOf(plan: Pick<FocusTreePlan, 'focuses'>): string {
  return hashCanonical(
    [...plan.focuses]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((focus) => [focus.id, [...focus.mutuallyExclusive].sort(compareCodeUnits)]),
  );
}

function improvement(id: QualityMetricId, before: number, after: number): number {
  const direction = qualityMetricInfo(id).direction === 'high' ? 1 : -1;
  return direction * (before - after);
}

/**
 * Compares two layouts of one tree. `before` is absent for a new tree. The hashes let a caller
 * prove that a layout repair moved only coordinates: the prerequisite and exclusion hashes must be
 * equal, and the unmoved hash must not change when the same repair is applied again.
 */
export function describeLayoutDelta(
  before: FocusLayoutSide | undefined,
  after: FocusLayoutSide,
): FocusLayoutDelta {
  const afterAnchors = anchorOf(after.plan);
  const beforePositions = new Map(before?.nodes.map(({ id, x, y }) => [id, { x, y }]));
  const beforeAnchors = before === undefined ? undefined : anchorOf(before.plan);
  const moved: string[] = [];
  const unmoved: Array<[string, number, number, string | null]> = [];
  for (const node of [...after.nodes].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const original = beforePositions.get(node.id);
    const anchor = afterAnchors.get(node.id) ?? null;
    const sameAnchor =
      beforeAnchors === undefined || (beforeAnchors.get(node.id) ?? null) === anchor;
    if (before !== undefined && (original?.x !== node.x || original.y !== node.y || !sameAnchor))
      moved.push(node.id);
    else if (before !== undefined) unmoved.push([node.id, node.x, node.y, anchor]);
  }
  const prerequisiteHash = prerequisiteHashOf(after.plan);
  const mutualExclusionHash = exclusionHashOf(after.plan);
  const improved: QualityMetricId[] = [];
  const regressed: QualityMetricId[] = [];
  if (before !== undefined) {
    const beforeRows = new Map(before.report.scorecard.map((row) => [row.id, row]));
    for (const row of after.report.scorecard) {
      const previous = beforeRows.get(row.id);
      if (
        previous === undefined ||
        row.status === 'not_evaluated' ||
        previous.status === 'not_evaluated'
      )
        continue;
      const gain = improvement(row.id, previous.value, row.value);
      const noise = Math.max(1e-6, 0.02 * Math.max(Math.abs(previous.value), Math.abs(row.value)));
      if (gain > noise) improved.push(row.id);
      else if (gain < -noise) regressed.push(row.id);
    }
  }
  return {
    verdictBefore: before?.report.verdict ?? null,
    verdictAfter: after.report.verdict,
    scoreBefore: before?.report.score ?? null,
    scoreAfter: after.report.score,
    improved,
    regressed,
    movedFocusCount: moved.length,
    movedFocusIds: moved.slice(0, LISTED_FOCUS_LIMIT),
    unmovedFocusCount: unmoved.length,
    unmovedHash: before === undefined ? '' : hashCanonical(unmoved),
    prerequisiteHash,
    prerequisitesUnchanged:
      before === undefined ? null : prerequisiteHashOf(before.plan) === prerequisiteHash,
    mutualExclusionHash,
    mutualExclusionsUnchanged:
      before === undefined ? null : exclusionHashOf(before.plan) === mutualExclusionHash,
  };
}
