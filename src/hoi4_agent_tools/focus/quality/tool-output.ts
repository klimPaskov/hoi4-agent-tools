import type { Diagnostic } from '../../core/diagnostics.js';
import type { SourceLocation } from '../../core/diagnostics.js';
import type { BranchSummary } from './branches.js';
import type { QualityReport, ScorecardRow } from './scorecard.js';
import type { QualityBucketId, QualityVerdict } from './types.js';

/** Inline rows are bounded; the linked artifact holds the whole scorecard. */
export const INLINE_SCORECARD_ROWS = 12;
const INLINE_BRANCHES = 12;

/**
 * Diagnostics of the curved connector model. The game draws right-angle connectors, so a curve
 * crossing or passing a plaque is mostly an artefact (766 reported crossings on 54 vanilla trees
 * against 86 in the in-game model, and every connector of an all-to-all bundle counted against
 * the rest). The scorecard reports the in-game model instead.
 */
export const CURVED_CONNECTOR_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED',
  'FOCUS_AVOIDABLE_CONNECTOR_CROSSING',
  'FOCUS_LAYOUT_CONNECTOR_THROUGH_NODE',
]);

export function withoutCurvedConnectorDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return diagnostics.filter(({ code }) => !CURVED_CONNECTOR_DIAGNOSTIC_CODES.has(code));
}

export interface FocusLayoutQualityOutput {
  verdict: QualityVerdict;
  score: number;
  summary: string;
  focusCount: number;
  bucket: QualityBucketId;
  softMetricsEvaluated: boolean;
  scorecard: ScorecardRow[];
  /** Rows that are beyond their limit; `scorecard` may hold more rows than this for context. */
  failingRowCount: number;
  nextActions: string[];
  notEvaluated: string[];
  branches: Array<
    Pick<BranchSummary, 'id' | 'focusCount' | 'minimumX' | 'maximumX' | 'minimumY' | 'maximumY'>
  >;
}

function trimText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function trimRow(row: ScorecardRow): ScorecardRow {
  return {
    ...row,
    message: trimText(row.message, 500),
    ...(row.fix === undefined
      ? {}
      : {
          fix: {
            ...row.fix,
            targetFocusIds: row.fix.targetFocusIds.slice(0, 16),
            suggested: trimText(row.fix.suggested, 400),
            expectedMetricChange: trimText(row.fix.expectedMetricChange, 200),
          },
        }),
  };
}

const FAILING = new Set(['blocked', 'revise', 'review', 'flag']);

/**
 * How much of a report an operation result carries inline. `full` is for one tree; many trees in
 * one result would exceed the response budget, so they get the verdict and a single next action.
 */
export type LayoutQualityDetail = 'full' | 'compact' | 'minimal';

const DETAIL: Record<
  LayoutQualityDetail,
  { rows: number; actions: number; notes: number; branches: number }
> = {
  full: { rows: INLINE_SCORECARD_ROWS, actions: 6, notes: 6, branches: INLINE_BRANCHES },
  compact: { rows: 6, actions: 3, notes: 0, branches: 0 },
  minimal: { rows: 0, actions: 1, notes: 0, branches: 0 },
};

/** The part of a report an operation result carries inline. */
export function layoutQualityOutput(
  report: QualityReport,
  detail: LayoutQualityDetail = 'full',
): FocusLayoutQualityOutput {
  const limits = DETAIL[detail];
  const failing = report.scorecard.filter(({ status }) => FAILING.has(status));
  return {
    verdict: report.verdict,
    score: report.score,
    summary: trimText(report.summary, 480),
    focusCount: report.focusCount,
    bucket: report.bucket,
    softMetricsEvaluated: report.softMetricsEvaluated,
    scorecard: report.scorecard
      .slice(0, limits.rows)
      .map((row) => (FAILING.has(row.status) ? trimRow(row) : { ...row, message: '', where: [] })),
    failingRowCount: failing.length,
    nextActions: report.nextActions.slice(0, limits.actions).map((action) => trimText(action, 400)),
    notEvaluated: report.notEvaluated.slice(0, limits.notes).map((entry) => trimText(entry, 300)),
    branches: report.branches.slice(0, limits.branches).map((branch) => ({
      id: branch.id,
      focusCount: branch.focusCount,
      minimumX: branch.minimumX,
      maximumX: branch.maximumX,
      minimumY: branch.minimumY,
      maximumY: branch.maximumY,
    })),
  };
}

const VERDICT_RANK: Record<QualityVerdict, number> = { pass: 0, review: 1, revise: 2, blocked: 3 };

export function worstVerdict(verdicts: readonly QualityVerdict[]): QualityVerdict {
  return verdicts.reduce<QualityVerdict>(
    (worst, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[worst] ? verdict : worst),
    'pass',
  );
}

/** One diagnostic per tree whose verdict asks for attention, so the verdict reaches `diagnostics`. */
export function layoutVerdictDiagnostic(
  treeId: string,
  report: Pick<QualityReport, 'verdict' | 'summary' | 'score' | 'nextActions'> & {
    scorecard: ReadonlyArray<Pick<ScorecardRow, 'id' | 'value' | 'status'>>;
  },
  location?: SourceLocation,
): Diagnostic | undefined {
  if (report.verdict === 'pass') return undefined;
  const failing = report.scorecard.filter(({ status }) => FAILING.has(status) && status !== 'flag');
  return {
    code: `FOCUS_LAYOUT_VERDICT_${report.verdict.toUpperCase()}`,
    severity: report.verdict === 'review' ? 'info' : 'warning',
    category: 'layout',
    message:
      report.verdict === 'review'
        ? `Layout of ${treeId} needs a visual review: ${report.summary}`
        : `Layout of ${treeId} is not finished: ${report.summary}. Structure ok never means the layout is good`,
    ...(location === undefined ? {} : { location }),
    details: {
      treeId,
      verdict: report.verdict,
      score: report.score,
      metrics: failing.slice(0, 8).map(({ id, value, status }) => ({ id, value, status })),
      nextActions: report.nextActions.slice(0, 3).map((action) => trimText(action, 300)),
    },
  };
}

/**
 * The check that keeps "structure ok" from reading as "done". It never changes `validation.passed`,
 * which stays the structural answer; callers that gate on layout read `passed` of this check.
 */
export function layoutValidationCheck(
  entries: ReadonlyArray<{ treeId: string; report: Pick<QualityReport, 'verdict' | 'summary'> }>,
): { id: string; passed: boolean; message: string } {
  const worst = worstVerdict(entries.map(({ report }) => report.verdict));
  const detail =
    entries.length === 1
      ? entries[0]!.report.summary
      : `layout verdicts: ${entries
          .slice(0, 8)
          .map(({ treeId, report }) => `${treeId} ${report.verdict}`)
          .join(', ')}${entries.length > 8 ? ` and ${entries.length - 8} more` : ''}`;
  return {
    id: 'focus-layout-verdict',
    passed: worst === 'pass' || worst === 'review',
    message: trimText(
      `${detail}. Not evaluated: gameplay and balance, visual review (call hoi4.focus_render), in-game connector geometry`,
      1000,
    ),
  };
}
