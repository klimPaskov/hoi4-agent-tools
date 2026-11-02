import { describe, expect, it } from 'vitest';
import {
  detectBundles,
  measureOrthogonalConnectors,
} from '../../src/hoi4_agent_tools/focus/quality/orthogonal.js';
import { resolveStaticPositions } from '../../src/hoi4_agent_tools/focus/quality/positions.js';
import type { QualityMetricId } from '../../src/hoi4_agent_tools/focus/quality/types.js';
import {
  ALL_TO_ALL_BUNDLE,
  JOGGED_CHAIN,
  measureSpecs,
  qualityGraphOf,
  qualityPlan,
  staircaseTree,
  symmetricLanes,
  TWIN_LANES,
  type FixtureFocus,
} from '../helpers/focus-quality-fixture.js';

function value(specs: readonly FixtureFocus[], id: QualityMetricId): number {
  return measureSpecs(specs).values[id] ?? Number.NaN;
}

describe('layout quality metrics with hand-computed values', () => {
  it('measures two tidy lanes that converge on a capstone', () => {
    // 8 focuses, 8 links, width 4 columns, 5 rows. A plaque fills its own column and the next, so
    // the grid is 6 cells wide; the free middle band is 2 cells by 3 rows = 6 of 30 cells.
    const measurement = measureSpecs(TWIN_LANES);
    expect(measurement).toMatchObject({ nodeCount: 8, edgeCount: 8, width: 4, rows: 5 });
    expect(measurement.values.S1).toBeCloseTo(6 / 30, 10);
    expect(measurement.locators.emptyRectangle).toEqual({
      minimumX: 0,
      maximumX: 1,
      minimumY: 1,
      maximumY: 3,
    });
    expect(measurement.values.S2).toBe(0); // 3 focuses left of column 0, 3 right
    expect(measurement.values.S3).toBe(0); // the mean column is the centre column
    expect(measurement.values.S4).toBeCloseTo(8 / 15, 10); // 8 / ((floor(4 / 2) + 1) * 5)
    expect(measurement.values.S5).toBe(0); // every row is centred on column 0
    expect(measurement.values.S6).toBe(0);
    expect(measurement.values.S7).toBe(0); // exclusive subtrees sit at x=-2 and x=2
    expect(measurement.values.S8).toBe(0);
    expect(measurement.values.S9).toBe(0);
    expect(measurement.values.S10).toBe(0);
    expect(measurement.values.S11).toBe(0);
    expect(measurement.values.D1).toBe(3); // a, a1, a2 are single-successor focuses in a row
    expect(measurement.locators.longestChain).toHaveLength(3);
    expect(measurement.values.D2).toBeCloseTo(1 / 8, 10); // only the capstone is a leaf
    expect(measurement.values.D3).toBe(0);
    expect(measurement.values.D4).toBeCloseTo(5 / 2, 10);
    for (const id of ['H1', 'H2', 'H3', 'H4', 'H5'] as const)
      expect(measurement.values[id]).toBe(0);
  });

  it('measures a jogged chain with a gap row', () => {
    // p(0,0) -> q(3,1) -> w(3,3): p to q jogs 3 columns, w waits one empty row below q.
    const measurement = measureSpecs(JOGGED_CHAIN);
    expect(measurement.values.S6).toBeCloseTo(50, 10); // 1 jog in 2 links
    expect(measurement.locators.detours).toEqual([{ parentId: 'p', childId: 'q', dx: 3 }]);
    expect(measurement.values.S10).toBe(1);
    expect(measurement.locators.slackChildren).toEqual([{ childId: 'w', slack: 1 }]);
    expect(measurement.values.S5).toBeCloseTo(1, 10); // row centres 0, 3, 3 over width 3
    expect(measurement.values.S3).toBeCloseTo(1 / 3, 10); // |mean 2 - centre 1.5| / half width 1.5
    expect(measurement.values.S2).toBeCloseTo(1 / 3, 10); // 1 focus left, 2 right
    expect(measurement.values.S4).toBeCloseTo(3 / 8, 10); // 3 / ((floor(3 / 2) + 1) * 4)
    expect(measurement.values.S1).toBeCloseTo(9 / 20, 10); // 3 cells by 3 rows free on the left
    expect(measurement.locators.emptyRectangle).toEqual({
      minimumX: 0,
      maximumX: 2,
      minimumY: 1,
      maximumY: 3,
    });
    expect(measurement.values.D1).toBe(1);
  });

  it('measures fan-outs that sit off their parent and on mixed rows', () => {
    const measurement = measureSpecs([
      { id: 'root', x: 0, y: 0 },
      { id: 'left', x: 2, y: 1, needs: ['root'] },
      { id: 'right', x: 6, y: 2, needs: ['root'] },
    ]);
    // The children of root are centred at x=4 while root is at x=0.
    expect(measurement.values.S8).toBe(4);
    expect(measurement.locators.offCenterCohorts).toEqual([
      { parentId: 'root', childIds: ['left', 'right'], offset: 4, centre: 4 },
    ]);
    expect(measurement.values.S11).toBe(1); // the only cohort spans rows 1 and 2
  });

  it('counts interleaved sibling subtrees by shared rows', () => {
    // On row 2 the subtree of a spans columns -2 to 4 and the subtree of b stands at column 2.
    const interleaved = measureSpecs([
      { id: 'root', x: 0, y: 0 },
      { id: 'a', x: -2, y: 1, needs: ['root'] },
      { id: 'b', x: 2, y: 1, needs: ['root'] },
      { id: 'a1', x: -2, y: 2, needs: ['a'] },
      { id: 'a2', x: 4, y: 2, needs: ['a'] },
      { id: 'b1', x: 2, y: 2, needs: ['b'] },
    ]);
    // Two sibling pairs: (a, b) share row 2, (a1, a2) do not.
    expect(interleaved.values.S7).toBeCloseTo(1 / 2, 10);
    expect(interleaved.locators.interleavedPairs).toEqual([
      { parentId: 'root', firstChildId: 'a', secondChildId: 'b' },
    ]);
    // Pulling a's children to its own side separates the two subtrees on every row.
    const tidy = measureSpecs([
      { id: 'root', x: 0, y: 0 },
      { id: 'a', x: -2, y: 1, needs: ['root'] },
      { id: 'b', x: 2, y: 1, needs: ['root'] },
      { id: 'a1', x: -3, y: 2, needs: ['a'] },
      { id: 'a2', x: -1, y: 2, needs: ['a'] },
      { id: 'b1', x: 2, y: 2, needs: ['b'] },
    ]);
    expect(tidy.values.S7).toBe(0);
  });

  it('flags an exclusive choice that rejoins six or more rows later', () => {
    const lane = (id: string, x: number, length: number): FixtureFocus[] =>
      Array.from({ length }, (_unused, index) => ({
        id: `${id}${String(index)}`,
        x,
        y: index + 2,
        needs: [index === 0 ? id : `${id}${String(index - 1)}`],
      }));
    const build = (length: number): FixtureFocus[] => [
      { id: 'root', x: 0, y: 0 },
      { id: 'x', x: -2, y: 1, needs: ['root'], exclusive: ['y', 'z'] },
      { id: 'y', x: 0, y: 1, needs: ['root'], exclusive: ['x', 'z'] },
      { id: 'z', x: 2, y: 1, needs: ['root'], exclusive: ['x', 'y'] },
      ...lane('x', -2, length),
      ...lane('y', 0, length),
      ...lane('z', 2, length),
      {
        id: 'cap',
        x: 0,
        y: length + 2,
        needs: [[`x${String(length - 1)}`, `y${String(length - 1)}`, `z${String(length - 1)}`]],
      },
    ];
    // Lanes of 5 focuses: the capstone sits on row 7, six rows below the choices on row 1.
    const long = measureSpecs(build(5));
    expect(long.values.D3).toBe(1);
    expect(long.locators.convergingChoices).toEqual([
      { choiceIds: ['x', 'y', 'z'], convergenceId: 'cap', rows: 6 },
    ]);
    // Lanes of 3 focuses rejoin after four rows: an ordinary fork and merge.
    expect(measureSpecs(build(3)).values.D3).toBe(0);
  });
});

describe('hard defects', () => {
  it('counts focuses that share a coordinate, except conditional ones', () => {
    const shared: FixtureFocus[] = [
      { id: 'root', x: 0, y: 0 },
      { id: 'x', x: 0, y: 1, needs: ['root'] },
      { id: 'y', x: 0, y: 1, needs: ['root'] },
    ];
    const measurement = measureSpecs(shared);
    expect(measurement.values.H1).toBe(1);
    expect(measurement.locators.duplicateCoordinates).toEqual([
      { x: 0, y: 1, focusIds: ['x', 'y'] },
    ]);
    // Two branches that are never visible together may share a coordinate.
    expect(value([shared[0]!, shared[1]!, { ...shared[2]!, allowBranch: true }], 'H1')).toBe(0);
    expect(value([shared[0]!, shared[1]!, { ...shared[2]!, offset: true }], 'H1')).toBe(0);
  });

  it('inherits uncertainty down relative chains and from anchors outside the tree', () => {
    expect(
      value(
        [
          { id: 'shifted', x: 0, y: 1, offset: true },
          { id: 'follower', x: 0, y: 2, relativeTo: 'shifted' },
          { id: 'twin', x: 0, y: 2 },
        ],
        'H1',
      ),
    ).toBe(0); // follower moves with the shifted focus
    expect(
      value(
        [
          { id: 'orphan', x: 0, y: 2, relativeTo: 'a_shared_focus' },
          { id: 'twin', x: 0, y: 2 },
        ],
        'H1',
      ),
    ).toBe(0);
    expect(
      value(
        [
          { id: 'anchor', x: 0, y: 1 },
          { id: 'follower', x: 0, y: 2, relativeTo: 'anchor' },
          { id: 'twin', x: 0, y: 2 },
        ],
        'H1',
      ),
    ).toBe(1);
  });

  it('counts plaques closer than their own width on one row', () => {
    const row = (distance: number): FixtureFocus[] => [
      { id: 'left', x: 0, y: 0 },
      { id: 'right', x: distance, y: 0 },
    ];
    expect(value(row(1), 'H3')).toBe(1);
    expect(measureSpecs(row(1)).locators.overlaps).toEqual([
      { leftId: 'left', rightId: 'right', y: 0, distance: 1 },
    ]);
    expect(value(row(2), 'H3')).toBe(0); // two columns apart is the in-game minimum
  });

  it('counts a prerequisite that is not above its dependant', () => {
    const measurement = measureSpecs([
      { id: 'low', x: 0, y: 2 },
      { id: 'high', x: 2, y: 2, needs: ['low'] },
    ]);
    expect(measurement.values.H2).toBe(1);
    expect(measurement.locators.parentNotAbove).toEqual([{ parentId: 'low', childId: 'high' }]);
  });
});

describe('orthogonal connector model', () => {
  it('counts a stem that crosses the bar of an unrelated connector once', () => {
    // p1 -> c1 drops down column 0 past row 1; p2 -> c2 runs a bar along row 1 from x=-2 to x=2.
    const measurement = measureSpecs([
      { id: 'p1', x: 0, y: 0 },
      { id: 'p2', x: -2, y: 0 },
      { id: 'c1', x: 4, y: 2, needs: ['p1'] },
      { id: 'c2', x: 2, y: 1, needs: ['p2'] },
    ]);
    expect(measurement.counts.crossings).toBe(1);
    expect(measurement.locators.crossings).toEqual([
      { firstParentId: 'p1', firstChildId: 'c1', secondParentId: 'p2', secondChildId: 'c2' },
    ]);
    expect(measurement.values.H5).toBeCloseTo(50, 10); // 1 crossing per 2 links
    expect(measurement.counts.stemsThroughPlaques).toBe(0);
  });

  it('does not count connectors that share a parent or a child', () => {
    // r -> a and r -> b share a parent; a2 -> cap and b2 -> cap share a child.
    const measurement = measureSpecs(TWIN_LANES);
    expect(measurement.counts.crossings).toBe(0);
    expect(measurement.counts.mergedBars).toBe(0);
  });

  it('counts a stem through a plaque only inside the clearance of 0.8 columns', () => {
    const through = measureSpecs([
      { id: 'top', x: 0, y: 0 },
      { id: 'bottom', x: 0, y: 3, needs: ['top'] },
      { id: 'between', x: 0, y: 1 },
      { id: 'beside', x: 1, y: 2 },
    ]);
    expect(through.counts.stemsThroughPlaques).toBe(1);
    expect(through.locators.stemsThroughPlaques).toEqual([
      { parentId: 'top', childId: 'bottom', focusId: 'between' },
    ]);
    expect(through.values.H4).toBeCloseTo(100, 10); // 1 per 1 link
  });

  it('counts unrelated connectors that share a bar, and ignores narrow overlaps', () => {
    const merged = measureSpecs([
      { id: 'p1', x: 0, y: 0 },
      { id: 'p2', x: 2, y: 0 },
      { id: 'c1', x: 4, y: 1, needs: ['p1'] },
      { id: 'c2', x: 6, y: 1, needs: ['p2'] },
    ]);
    expect(merged.counts.mergedBars).toBe(1);
    expect(merged.values.S9).toBeCloseTo(50, 10);
    const separate = measureSpecs([
      { id: 'p1', x: 0, y: 0 },
      { id: 'p2', x: 4, y: 0 },
      { id: 'c1', x: 2, y: 1, needs: ['p1'] },
      { id: 'c2', x: 6, y: 1, needs: ['p2'] },
    ]);
    expect(separate.counts.mergedBars).toBe(0);
  });

  it('treats an all-to-all bundle as one bar', () => {
    const graph = qualityGraphOf(ALL_TO_ALL_BUNDLE);
    expect(detectBundles(graph)).toEqual([
      { parents: ['p1', 'p2', 'p3'], children: ['c1', 'c2', 'c3'] },
    ]);
    const orthogonal = measureOrthogonalConnectors(graph);
    expect(orthogonal.bundleEdgeCount).toBe(9);
    expect(orthogonal.crossings).toHaveLength(0);
    expect(orthogonal.mergedBars).toHaveLength(0);
    expect(orthogonal.stemsThroughPlaques).toHaveLength(0);
  });

  it('does not call a partial grid a bundle', () => {
    const partial: FixtureFocus[] = ALL_TO_ALL_BUNDLE.map((focus) =>
      focus.id === 'c3' ? { ...focus, needs: ['p1', 'p2'] } : focus,
    );
    const graph = qualityGraphOf(partial);
    // Two maximal grids remain: p1 and p2 with all three children, and all three parents with c1 and c2.
    expect(detectBundles(graph)).toEqual([
      { parents: ['p1', 'p2'], children: ['c1', 'c2', 'c3'] },
      { parents: ['p1', 'p2', 'p3'], children: ['c1', 'c2'] },
    ]);
    expect(measureOrthogonalConnectors(graph).bundleEdgeCount).toBe(8);
    const single = qualityGraphOf([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 2, y: 0 },
      { id: 'c', x: 0, y: 1, needs: ['a', 'b'] },
      { id: 'd', x: 2, y: 1, needs: ['b'] },
    ]);
    expect(detectBundles(single)).toEqual([]);
  });

  it('does not count the members of an OR group against each other', () => {
    const measurement = measureSpecs([
      { id: 'a', x: -2, y: 0 },
      { id: 'b', x: 2, y: 0 },
      { id: 'c', x: 0, y: 2, needs: [['a', 'b']] },
    ]);
    expect(measurement.counts.crossings).toBe(0);
    expect(measurement.counts.mergedBars).toBe(0);
  });
});

describe('position resolution', () => {
  it('adds a relative offset to the anchor position as the game does', () => {
    const plan = qualityPlan([
      { id: 'anchor', x: 4, y: 1 },
      { id: 'near', x: 2, y: 1, relativeTo: 'anchor' },
      { id: 'far', x: -1, y: 2, relativeTo: 'near' },
    ]);
    expect(resolveStaticPositions(plan)).toEqual([
      { id: 'anchor', x: 4, y: 1 },
      { id: 'near', x: 6, y: 2 },
      { id: 'far', x: 5, y: 4 },
    ]);
  });

  it('declines a missing anchor and a cycle so the layout engine can answer', () => {
    expect(
      resolveStaticPositions(qualityPlan([{ id: 'orphan', x: 0, y: 0, relativeTo: 'nowhere' }])),
    ).toBeUndefined();
    expect(
      resolveStaticPositions(
        qualityPlan([
          { id: 'one', x: 0, y: 0, relativeTo: 'two' },
          { id: 'two', x: 0, y: 0, relativeTo: 'one' },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe('metric invariance', () => {
  function composite(): FixtureFocus[] {
    const prefixed = (specs: readonly FixtureFocus[], prefix: string, dx: number, dy: number) =>
      specs.map((spec) => ({
        ...spec,
        id: `${prefix}${spec.id}`,
        x: spec.x + dx,
        y: spec.y + dy,
        ...(spec.needs === undefined
          ? {}
          : {
              needs: spec.needs.map((entry) =>
                Array.isArray(entry) ? entry.map((id) => prefix + id) : prefix + entry,
              ),
            }),
        ...(spec.exclusive === undefined
          ? {}
          : { exclusive: spec.exclusive.map((id) => prefix + id) }),
      }));
    return [
      ...prefixed(TWIN_LANES, 't_', 0, 0),
      ...prefixed(staircaseTree(9), 's_', 20, 0),
      ...prefixed(ALL_TO_ALL_BUNDLE, 'b_', -20, 0),
      ...prefixed(symmetricLanes(3, 4), 'l_', 40, 8),
      ...prefixed(
        [
          { id: 'p1', x: 0, y: 0 },
          { id: 'p2', x: -2, y: 0 },
          { id: 'c1', x: 4, y: 2, needs: ['p1'] },
          { id: 'c2', x: 2, y: 1, needs: ['p2'] },
        ],
        'x_',
        -40,
        10,
      ),
    ];
  }

  function expectEquivalent(
    left: ReturnType<typeof measureSpecs>,
    right: ReturnType<typeof measureSpecs>,
  ): void {
    expect(Object.keys(right.values).sort()).toEqual(Object.keys(left.values).sort());
    for (const [id, expected] of Object.entries(left.values))
      expect(right.values[id as QualityMetricId], id).toBeCloseTo(expected, 9);
    expect(right.counts).toEqual(left.counts);
    expect(right.width).toBe(left.width);
    expect(right.rows).toBe(left.rows);
  }

  it('is unchanged by moving the whole tree', () => {
    const base = composite();
    expectEquivalent(
      measureSpecs(base),
      measureSpecs(base.map((spec) => ({ ...spec, x: spec.x + 7, y: spec.y + 5 }))),
    );
  });

  it('is unchanged by mirroring the tree left to right', () => {
    const base = composite();
    expectEquivalent(
      measureSpecs(base),
      measureSpecs(base.map((spec) => ({ ...spec, x: -spec.x }))),
    );
  });

  it('is unchanged by shifting every row down together', () => {
    const base = composite();
    expectEquivalent(
      measureSpecs(base),
      measureSpecs(base.map((spec) => ({ ...spec, y: spec.y + 12 }))),
    );
  });

  it('does not depend on the order of the focuses or of their prerequisites', () => {
    const base = composite();
    const reordered = [...base].reverse().map((spec) => ({
      ...spec,
      ...(spec.needs === undefined
        ? {}
        : {
            needs: [...spec.needs]
              .reverse()
              .map((entry) => (Array.isArray(entry) ? [...entry].reverse() : entry)),
          }),
    }));
    expectEquivalent(measureSpecs(base), measureSpecs(reordered));
  });

  it('gives the same answer every time', () => {
    const base = composite();
    expect(measureSpecs(base)).toEqual(measureSpecs(base));
  });

  it('keeps the balance metrics at zero for mirrored lanes at any width', () => {
    for (const lanes of [2, 4, 6]) {
      const measurement = measureSpecs(symmetricLanes(lanes, 5));
      expect(measurement.values.S2, `lanes ${String(lanes)}`).toBe(0);
      expect(measurement.values.S3, `lanes ${String(lanes)}`).toBeCloseTo(0, 10);
      expect(measurement.values.S5, `lanes ${String(lanes)}`).toBeCloseTo(0, 10);
    }
  });
});
