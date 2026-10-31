import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import {
  describeLayoutDelta,
  evaluateFocusLayoutQuality,
  layoutQualityOutput,
  layoutValidationCheck,
  layoutVerdictDiagnostic,
  STORED_QUALITY_CALIBRATION,
  withoutCurvedConnectorDiagnostics,
  worstVerdict,
} from '../../src/hoi4_agent_tools/focus/quality/index.js';
import type {
  QualityCalibration,
  QualityMetricId,
} from '../../src/hoi4_agent_tools/focus/quality/types.js';
import {
  ALL_TO_ALL_BUNDLE,
  JOGGED_CHAIN,
  qualityPlan,
  staircaseTree,
  symmetricLanes,
  TWIN_LANES,
  type FixtureFocus,
} from '../helpers/focus-quality-fixture.js';

function evaluate(specs: readonly FixtureFocus[], calibration?: QualityCalibration) {
  return evaluateFocusLayoutQuality(
    qualityPlan(specs),
    specs.map(({ id, x, y }) => ({ id, x, y })),
    calibration,
  );
}

function row(report: ReturnType<typeof evaluate>['report'], id: QualityMetricId) {
  const found = report.scorecard.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No scorecard row ${id}`);
  return found;
}

/** A calibration whose medium bucket limits are replaced, to test the verdict rules in isolation. */
function withMediumLimits(
  limits: Partial<Record<QualityMetricId, { review: number; revise: number }>>,
): QualityCalibration {
  const copy = structuredClone(STORED_QUALITY_CALIBRATION);
  const medium = copy.buckets.find(({ id }) => id === 'medium')!;
  for (const [id, replacement] of Object.entries(limits)) {
    const key = id as QualityMetricId;
    medium.limits[key] = {
      direction: medium.limits[key]?.direction ?? 'high',
      ...replacement,
    };
  }
  return copy;
}

describe('layout verdict', () => {
  it('passes two tidy lanes and says what it did not evaluate', () => {
    const { report } = evaluate(TWIN_LANES);
    expect(report.verdict).toBe('pass');
    expect(report.score).toBe(100);
    expect(report.summary).toMatch(/^layout verdict: pass/u);
    expect(report.softMetricsEvaluated).toBe(true);
    expect(report.notEvaluated.join(' ')).toMatch(/visual review/u);
    expect(report.notEvaluated.join(' ')).toMatch(/gameplay/u);
    expect(report.nextActions.join(' ')).toMatch(/hoi4\.focus_render/u);
  });

  it('judges only the hard defects of a tree too small for the vanilla calibration', () => {
    const { report } = evaluate(JOGGED_CHAIN);
    expect(report.softMetricsEvaluated).toBe(false);
    expect(report.verdict).toBe('pass');
    expect(row(report, 'S6').status).toBe('not_evaluated');
    expect(row(report, 'S1').status).toBe('not_evaluated');
    expect(report.summary).toMatch(/too few focuses/u);
  });

  it('blocks on a hard defect and explains how to fix it', () => {
    const { report } = evaluate([
      { id: 'root', x: 0, y: 0 },
      { id: 'first', x: 0, y: 1, needs: ['root'] },
      { id: 'second', x: 0, y: 1, needs: ['root'] },
    ]);
    expect(report.verdict).toBe('blocked');
    expect(report.scorecard[0]).toMatchObject({ id: 'H1', status: 'blocked' });
    expect(report.scorecard[0]!.fix).toMatchObject({
      action: 'separate_focuses',
      preservesGameplay: true,
    });
    expect(report.scorecard[0]!.message).toMatch(/first, second share \(0, 1\)/u);
    expect(report.nextActions[0]).toMatch(/Fix the hard defects \(H1\)/u);
    expect(report.score).toBeLessThanOrEqual(75);
  });

  it('asks for revision when a staircase leaves the mass hanging to one side', () => {
    // 45 generations that each step two columns left: nothing like a vanilla tree.
    const { report } = evaluate(staircaseTree(45));
    expect(report.bucket).toBe('medium');
    expect(report.verdict).toBe('revise');
    const revised = report.scorecard
      .filter(({ status }) => status === 'revise')
      .map(({ id }) => id);
    expect(revised).toEqual(expect.arrayContaining(['S4', 'S5', 'S6']));
    expect(row(report, 'S6').fix).toMatchObject({
      action: 'align_under_parent',
      targetFocusIds: expect.arrayContaining(['step_1']),
    });
    expect(report.summary).toMatch(
      /^layout verdict: revise \(\d+ metrics? beyond the vanilla range/u,
    );
    expect(report.nextActions.join(' ')).toMatch(/not finished while the verdict is revise/u);
    expect(report.nextActions.join(' ')).toMatch(/layoutMode":"compact"/u);
    expect(report.score).toBeLessThan(60);
  });

  it('never asks for revision below 40 focuses, where vanilla has too few trees to set a limit', () => {
    const { report } = evaluate(staircaseTree(20));
    expect(report.bucket).toBe('small');
    expect(report.verdict).toBe('review');
    expect(report.scorecard.some(({ status }) => status === 'revise')).toBe(false);
  });

  it('passes a balanced tree and gives the same verdict to its mirror image', () => {
    const lanes = symmetricLanes(11, 4);
    expect(evaluate(lanes).report.verdict).toBe('pass');
    const mirrored = lanes.map((spec) => ({ ...spec, x: -spec.x }));
    expect(evaluate(mirrored).report.verdict).toBe('pass');
    expect(evaluate(mirrored).report.score).toBe(evaluate(lanes).report.score);
  });

  it('routes a design flag to review without failing the layout', () => {
    // Ten focuses in a row with no choice: D1 flags a chain beyond the vanilla maximum of 4.
    const { report } = evaluate([
      { id: 'root', x: 0, y: 0 },
      ...Array.from({ length: 10 }, (_unused, index) => ({
        id: `step_${String(index)}`,
        x: 0,
        y: index + 1,
        needs: [index === 0 ? 'root' : `step_${String(index - 1)}`],
      })),
    ]);
    expect(row(report, 'D1')).toMatchObject({ status: 'flag', value: 9 }); // step_9 is a leaf
    expect(row(report, 'D1').fix).toMatchObject({
      action: 'review_design',
      preservesGameplay: false,
    });
    expect(report.verdict).toBe('review');
  });

  it('lets connector metrics raise a tree to review at most while the model is unverified', () => {
    const limits = { H5: { review: 0, revise: 0 } };
    const crossing: FixtureFocus[] = [
      ...symmetricLanes(11, 4),
      // A stem of x1 drops past the bar of x2 on row 6.
      { id: 'x1', x: 2, y: 5 },
      { id: 'x2', x: -2, y: 5 },
      { id: 'y1', x: 6, y: 7, needs: ['x1'] },
      { id: 'y2', x: 4, y: 6, needs: ['x2'] },
    ];
    const { report } = evaluate(crossing, withMediumLimits(limits));
    expect(row(report, 'H5')).toMatchObject({ status: 'review' });
    expect(report.verdict).toBe('review');
  });

  it('asks for revision when enough metrics leave the vanilla range, and not before', () => {
    const beyond = (ids: QualityMetricId[]) =>
      Object.fromEntries(ids.map((id) => [id, { review: -1e9, revise: 1e9 }]));
    const tree = symmetricLanes(11, 4);
    // The limits below put the named metrics beyond review (-1e9) but not beyond revise (1e9).
    const four = evaluate(tree, withMediumLimits(beyond(['S1', 'S5', 'S6', 'S10']))).report;
    expect(four.verdict).toBe('review');
    const five = evaluate(tree, withMediumLimits(beyond(['S1', 'S5', 'S6', 'S10', 'S11']))).report;
    expect(five.verdict).toBe('revise');
    expect(five.summary).toMatch(/5 metrics beyond the vanilla range/u);
  });

  it('keeps the calibration rules in the data file', () => {
    expect(STORED_QUALITY_CALIBRATION.verdictRules).toEqual({
      reviseMargin: 1,
      reviseCount: 5,
      advisoryMetrics: ['H4', 'H5', 'S9'],
      convergenceMinimumRows: 6,
    });
  });
});

describe('tool output', () => {
  it('shapes a report for the response and keeps passing rows short', () => {
    const { report } = evaluate(staircaseTree(45));
    const output = layoutQualityOutput(report, 'full');
    expect(output.scorecard.length).toBeLessThanOrEqual(12);
    expect(output.scorecard[0]!.status).not.toBe('ok');
    expect(output.failingRowCount).toBeGreaterThan(3);
    const ok = output.scorecard.find(({ status }) => status === 'ok');
    expect(ok === undefined || ok.message === '').toBe(true);
    const minimal = layoutQualityOutput(report, 'minimal');
    expect(minimal.scorecard).toEqual([]);
    expect(minimal.nextActions).toHaveLength(1);
    expect(JSON.stringify(output).length).toBeLessThan(9_000);
  });

  it('makes the verdict visible in the validation check and as a diagnostic', () => {
    const revise = evaluate(staircaseTree(45)).report;
    const pass = evaluate(TWIN_LANES).report;
    const check = layoutValidationCheck([{ treeId: 'quality_tree', report: revise }]);
    expect(check).toMatchObject({ id: 'focus-layout-verdict', passed: false });
    expect(check.message).toMatch(/layout verdict: revise/u);
    expect(check.message).toMatch(/Not evaluated: gameplay and balance, visual review/u);
    expect(layoutValidationCheck([{ treeId: 'quality_tree', report: pass }]).passed).toBe(true);
    const diagnostic = layoutVerdictDiagnostic('quality_tree', revise);
    expect(diagnostic).toMatchObject({
      code: 'FOCUS_LAYOUT_VERDICT_REVISE',
      severity: 'warning',
      category: 'layout',
    });
    expect(diagnostic!.message).toMatch(/Structure ok never means the layout is good/u);
    expect(layoutVerdictDiagnostic('quality_tree', pass)).toBeUndefined();
    expect(worstVerdict(['pass', 'review', 'blocked', 'revise'])).toBe('blocked');
    expect(worstVerdict([])).toBe('pass');
  });

  it('drops the curved-connector diagnostics and keeps the rest', () => {
    const diagnostics: Diagnostic[] = [
      'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED',
      'FOCUS_AVOIDABLE_CONNECTOR_CROSSING',
      'FOCUS_LAYOUT_CONNECTOR_THROUGH_NODE',
      'FOCUS_LAYOUT_LINEAR_DETOUR',
    ].map((code) => ({ code, severity: 'warning', category: 'layout', message: code }));
    expect(withoutCurvedConnectorDiagnostics(diagnostics).map(({ code }) => code)).toEqual([
      'FOCUS_LAYOUT_LINEAR_DETOUR',
    ]);
  });
});

describe('layout delta', () => {
  it('reports what moved, what improved and that gameplay relations are untouched', () => {
    const before = staircaseTree(45);
    const planBefore = qualityPlan(before);
    const reportBefore = evaluate(before).report;
    // Re-lay the same graph as a straight column: only coordinates change.
    const straight = before.map((spec, index) => ({ ...spec, x: 0, y: index }));
    const after = evaluate(straight);
    const delta = describeLayoutDelta(
      {
        plan: planBefore,
        nodes: before.map(({ id, x, y }) => ({ id, x, y })),
        report: reportBefore,
      },
      {
        plan: qualityPlan(straight),
        nodes: straight.map(({ id, x, y }) => ({ id, x, y })),
        report: after.report,
      },
    );
    expect(delta.verdictBefore).toBe('revise');
    expect(delta.verdictAfter).not.toBe('revise');
    expect(delta.scoreAfter).toBeGreaterThan(delta.scoreBefore!);
    expect(delta.improved).toEqual(expect.arrayContaining(['S1', 'S5', 'S6']));
    expect(delta.movedFocusCount).toBe(44); // step_0 stays where it was
    expect(delta.unmovedFocusCount).toBe(1);
    expect(delta.prerequisitesUnchanged).toBe(true);
    expect(delta.mutualExclusionsUnchanged).toBe(true);
    expect(delta.prerequisiteHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('detects a changed prerequisite and names no baseline for a new tree', () => {
    const base = symmetricLanes(3, 2);
    const changed = base.map((spec) =>
      spec.id === 'lane_0_2' ? { ...spec, needs: ['root'] } : spec,
    );
    const side = (specs: readonly FixtureFocus[]) => ({
      plan: qualityPlan(specs),
      nodes: specs.map(({ id, x, y }) => ({ id, x, y })),
      report: evaluate(specs).report,
    });
    const delta = describeLayoutDelta(side(base), side(changed));
    expect(delta.prerequisitesUnchanged).toBe(false);
    expect(delta.movedFocusCount).toBe(0);
    const created = describeLayoutDelta(undefined, side(base));
    expect(created).toMatchObject({
      verdictBefore: null,
      scoreBefore: null,
      prerequisitesUnchanged: null,
      movedFocusCount: 0,
      unmovedHash: '',
    });
  });

  it('keeps the unmoved hash stable when the same change is applied twice', () => {
    const before = ALL_TO_ALL_BUNDLE.map((spec) => ({ ...spec }));
    const after = before.map((spec) => (spec.id === 'c3' ? { ...spec, x: 6 } : spec));
    const side = (specs: readonly FixtureFocus[]) => ({
      plan: qualityPlan(specs),
      nodes: specs.map(({ id, x, y }) => ({ id, x, y })),
      report: evaluate(specs).report,
    });
    const first = describeLayoutDelta(side(before), side(after));
    const second = describeLayoutDelta(side(before), side(after));
    expect(first.movedFocusIds).toEqual(['c3']);
    expect(second.unmovedHash).toBe(first.unmovedHash);
    expect(first.unmovedFocusCount).toBe(5);
    // Applying it to its own result moves nothing.
    expect(describeLayoutDelta(side(after), side(after)).movedFocusCount).toBe(0);
  });
});
