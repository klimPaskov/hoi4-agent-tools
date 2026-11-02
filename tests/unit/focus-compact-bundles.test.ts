import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import {
  assertCompactLayoutQuality,
  compactFocusTreePlan,
  compactFocusTreePlanAsync,
} from '../../src/hoi4_agent_tools/focus/compact.js';
import { layoutFocusTree } from '../../src/hoi4_agent_tools/focus/layout.js';
import { evaluateFocusLayoutQuality } from '../../src/hoi4_agent_tools/focus/quality/index.js';
import {
  ALL_TO_ALL_BUNDLE,
  qualityPlan,
  TWIN_LANES,
  type FixtureFocus,
} from '../helpers/focus-quality-fixture.js';

/** A hand-typed layout of three parents and three children that every parent unlocks. */
const HAND_TYPED_BUNDLE: readonly FixtureFocus[] = [
  { id: 'root', x: 0, y: 0 },
  { id: 'p1', x: -9, y: 1, needs: ['root'] },
  { id: 'p2', x: 1, y: 1, needs: ['root'] },
  { id: 'p3', x: 12, y: 1, needs: ['root'] },
  { id: 'c1', x: -6, y: 3, needs: ['p1', 'p2', 'p3'] },
  { id: 'c2', x: 3, y: 3, needs: ['p1', 'p2', 'p3'] },
  { id: 'c3', x: 10, y: 3, needs: ['p1', 'p2', 'p3'] },
  { id: 'c1a', x: -6, y: 4, needs: ['c1'] },
  { id: 'c2a', x: 3, y: 4, needs: ['c2'] },
  { id: 'c3a', x: 10, y: 4, needs: ['c3'] },
];

function refusal(action: () => void): ServiceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('The compact gate accepted the layout');
}

describe('bundle-aware compact gate', () => {
  it('no longer refuses a tree for the connectors of an all-to-all bundle', () => {
    const plan = qualityPlan(ALL_TO_ALL_BUNDLE);
    const layout = layoutFocusTree(plan);
    // The curved model counts every pair inside the bundle as a crossing: this is what refused
    // the real trees that contain one.
    expect(layout.metrics!.connectors.crossingCount).toBeGreaterThan(0);
    expect(refusal(() => assertCompactLayoutQuality(layout, layout, false)).code).toBe(
      'FOCUS_COMPACT_QUALITY_BLOCKED',
    );
    // In the in-game model a bundle is one bar, so the same layout passes.
    expect(() =>
      assertCompactLayoutQuality(layout, layout, false, { current: plan, proposed: plan }),
    ).not.toThrow();
  });

  it('compacts a hand-typed bundle tree without changing a prerequisite', async () => {
    const plan = qualityPlan(HAND_TYPED_BUNDLE);
    expect(layoutFocusTree(plan).metrics!.connectors.crossingCount).toBeGreaterThan(0);
    const result = await compactFocusTreePlanAsync(plan);
    expect(result.outcome).toBe('improved');
    const prerequisites = (value: typeof plan) =>
      value.focuses.map(({ id, prerequisites: needs }) => [
        id,
        needs.groups.map(({ focusIds }) => [...focusIds].sort()),
      ]);
    expect(prerequisites(result.plan)).toEqual(prerequisites(plan));
    const after = layoutFocusTree(result.plan);
    expect(after.metrics!.spacing.tooCloseSameRowPairCount).toBe(0);
    const before = evaluateFocusLayoutQuality(plan, layoutFocusTree(plan).nodes).report;
    const compacted = evaluateFocusLayoutQuality(result.plan, after.nodes).report;
    expect(compacted.verdict === before.verdict || before.verdict !== 'pass').toBe(true);
  });

  it('says there is nothing to improve for a layout no candidate beats, and changes nothing', async () => {
    const plan = qualityPlan(TWIN_LANES);
    expect(evaluateFocusLayoutQuality(plan, layoutFocusTree(plan).nodes).report.verdict).toBe(
      'pass',
    );
    const result = await compactFocusTreePlanAsync(plan);
    expect(result.outcome).toBe('nothing_to_improve');
    expect(result.reason).toBe('verdict_pass');
    expect(result.plan).toBe(plan);
    expect(result.proposedLayout).toBe(result.currentLayout);
    // The synchronous planner agrees and returns the plan it was given.
    expect(compactFocusTreePlan(plan)).toBe(plan);
  });

  it('still refuses a real crossing in a new tree and names the remedy', () => {
    // p1 -> c1 drops down column 4 past the bar under row 1 of p2 -> c2.
    const plan = qualityPlan([
      { id: 'p1', x: 0, y: 0 },
      { id: 'p2', x: 2, y: 1 },
      { id: 'c1', x: 4, y: 2, needs: ['p1'] },
      { id: 'c2', x: 6, y: 2, needs: ['p2'] },
    ]);
    const layout = layoutFocusTree(plan);
    const error = refusal(() =>
      assertCompactLayoutQuality(undefined, layout, false, { proposed: plan }),
    );
    expect(error.code).toBe('FOCUS_COMPACT_QUALITY_BLOCKED');
    const details = error.details as {
      regressions: string[];
      blocking: Array<{ name: string; before: number | null; after: number; remedy: string }>;
    };
    expect(details.regressions).toContain('connectorCrossingCount');
    expect(details.blocking.find(({ name }) => name === 'connectorCrossingCount')).toMatchObject({
      before: null,
      after: 1,
      remedy: expect.stringMatching(/another column|bundle/u),
    });
  });

  it('does not refuse a crossing the layout in place already has', () => {
    // p1 -> c1 drops down column 4 past the bar under row 1 of p2 -> c2.
    const plan = qualityPlan([
      { id: 'p1', x: 0, y: 0 },
      { id: 'p2', x: 2, y: 1 },
      { id: 'c1', x: 4, y: 2, needs: ['p1'] },
      { id: 'c2', x: 6, y: 2, needs: ['p2'] },
    ]);
    const layout = layoutFocusTree(plan);
    expect(() =>
      assertCompactLayoutQuality(layout, layout, false, { current: plan, proposed: plan }),
    ).not.toThrow();
  });

  it('refuses a candidate that the layout verdict would judge worse than the layout in place', () => {
    const tidy = qualityPlan(TWIN_LANES);
    const jogged = qualityPlan(
      TWIN_LANES.map((focus) =>
        focus.id === 'a2' || focus.id === 'b2' ? { ...focus, x: focus.x * 15 } : focus,
      ),
    );
    const before = layoutFocusTree(tidy);
    const after = layoutFocusTree(jogged);
    const error = refusal(() =>
      assertCompactLayoutQuality(before, after, false, { current: tidy, proposed: jogged }),
    );
    const details = error.details as {
      blocking: Array<{ name: string; before: number | null; after: number }>;
    };
    expect(details.blocking).toContainEqual(
      expect.objectContaining({ name: 'layoutVerdict', before: 0, after: 1 }),
    );
  });
});
