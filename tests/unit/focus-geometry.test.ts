import { describe, expect, it } from 'vitest';
import {
  FOCUS_HORIZONTAL_GRID_PIXELS,
  FOCUS_NODE_HEIGHT_PIXELS,
  FOCUS_NODE_WIDTH_PIXELS,
  FOCUS_PLAN_SCHEMA_VERSION,
  FOCUS_VERTICAL_GRID_PIXELS,
  focusConnectorCurve,
  focusConnectorIntersectsNode,
  focusConnectorSvgPath,
  focusConnectorsVisiblyIntersect,
  focusPlanHash,
  layoutFocusTree,
  renderFocusTree,
  type FocusNodePlan,
  type FocusTreePlan,
  type RawClausewitzBlock,
} from '../../src/hoi4_agent_tools/focus/index.js';

const reward: RawClausewitzBlock = {
  text: '{ add_political_power = 1 }',
  referencedFocusIds: [],
};

function focusNode(id: string, x: number, y: number, parentId?: string): FocusNodePlan {
  return {
    id,
    label: id,
    prerequisites: {
      operator: 'and',
      groups:
        parentId === undefined
          ? []
          : [{ operator: 'or', focusIds: [parentId], rawPassthrough: [] }],
    },
    mutuallyExclusive: [],
    routeLocks: [],
    position: { mode: 'fixed', x, y, pinned: true },
    visibility: 'normal',
    convergence: false,
    sharedSupport: false,
    icons: [{ kind: 'static', sprite: 'GFX_fixture' }],
    localisation: { titleKey: id, descriptionKey: `${id}_desc` },
    ai: { majorRoute: false, strategyIds: [] },
    filters: [],
    links: [],
    completionReward: reward,
    rawPassthrough: [],
  };
}

function focusPlan(focuses: FocusNodePlan[]): FocusTreePlan {
  const plan: FocusTreePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id: 'rendered_geometry',
    default: false,
    branchGroups: [],
    laneGroups: [{ id: 'default', label: 'Default', order: 0 }],
    entryFocusIds: focuses
      .filter(({ prerequisites }) => prerequisites.groups.length === 0)
      .map(({ id }) => id),
    focuses,
    sharedFocusIds: [],
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    rawPassthrough: [],
    provenance: {
      sourcePath: 'mod:common/national_focus/rendered_geometry.txt',
      sourceHash: 'source-hash',
      importedPlanHash: '',
    },
  };
  plan.provenance.importedPlanHash = focusPlanHash(plan);
  return plan;
}

function straightSegmentsProperlyCross(
  firstStart: { x: number; y: number },
  firstEnd: { x: number; y: number },
  secondStart: { x: number; y: number },
  secondEnd: { x: number; y: number },
): boolean {
  const orientation = (
    start: { x: number; y: number },
    end: { x: number; y: number },
    point: { x: number; y: number },
  ): number =>
    Math.sign((end.y - start.y) * (point.x - end.x) - (end.x - start.x) * (point.y - end.y));
  const values = [
    orientation(firstStart, firstEnd, secondStart),
    orientation(firstStart, firstEnd, secondEnd),
    orientation(secondStart, secondEnd, firstStart),
    orientation(secondStart, secondEnd, firstEnd),
  ];
  return values.every((value) => value !== 0) && values[0] !== values[1] && values[2] !== values[3];
}

describe('focus rendered connector geometry', () => {
  it('wraps long focus titles instead of truncating their final words', async () => {
    const focus = {
      ...focusNode('country_island', 0, 0),
      label: 'A Country on the Island',
    };
    const plan = focusPlan([focus]);
    const rendered = await renderFocusTree(plan, layoutFocusTree(plan), []);
    const labels = [...rendered.svg.matchAll(/<g aria-label="([^"]+)"/gu)].map((match) => match[1]);

    expect(labels.some((label) => label?.includes('Country'))).toBe(true);
    expect(labels.some((label) => label?.includes('Island'))).toBe(true);
    expect(labels).not.toContain('A Country on the I');
  });

  it('uses the rendered cubic when straight grid segments disagree', () => {
    const firstParent = { x: -3, y: 0 };
    const firstChild = { x: -2, y: 1 };
    const secondParent = { x: -2, y: 0 };
    const secondChild = { x: -2, y: 3 };

    expect(straightSegmentsProperlyCross(firstParent, firstChild, secondParent, secondChild)).toBe(
      false,
    );
    expect(
      focusConnectorsVisiblyIntersect(firstParent, firstChild, secondParent, secondChild),
    ).toBe(true);
  });

  it('detects a rendered connector through an unrelated focus rectangle', () => {
    const parent = { x: 0, y: 0 };
    const child = { x: 0, y: 4 };

    expect(focusConnectorIntersectsNode(parent, child, { x: 0, y: 2 })).toBe(true);
    expect(focusConnectorIntersectsNode(parent, child, { x: 2, y: 2 })).toBe(false);
  });

  it('reports cubic crossings and connector-node intersections in a layout', () => {
    const focuses = [
      focusNode('first_parent', -3, 0),
      focusNode('first_child', -2, 1, 'first_parent'),
      focusNode('second_parent', -2, 0),
      focusNode('second_child', -2, 3, 'second_parent'),
    ];
    const layout = layoutFocusTree(focusPlan(focuses));

    expect(layout.metrics?.connectors.crossingCount).toBe(1);
    expect(layout.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED' }),
        expect.objectContaining({
          code: 'FOCUS_LAYOUT_CONNECTOR_THROUGH_NODE',
          details: expect.objectContaining({ focusId: 'first_child' }),
        }),
      ]),
    );
  });

  it('crops unused positive authored coordinates from the review canvas', async () => {
    const first = focusNode('first', 6, 4);
    const second = focusNode('second', 8, 6, first.id);
    const plan = focusPlan([first, second]);
    const rendered = await renderFocusTree(plan, layoutFocusTree(plan), []);

    expect(rendered.svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="656" height="468"',
    );
  });

  it('serializes the same cubic path into the SVG render', async () => {
    const parent = focusNode('parent', 0, 0);
    const child = focusNode('child', 2, 2, parent.id);
    const plan = focusPlan([parent, child]);
    const layout = layoutFocusTree(plan);
    const rendered = await renderFocusTree(plan, layout, []);
    const curve = focusConnectorCurve(
      layout.nodes.find(({ id }) => id === parent.id)!,
      layout.nodes.find(({ id }) => id === child.id)!,
      {
        horizontalSpacing: FOCUS_HORIZONTAL_GRID_PIXELS,
        verticalSpacing: FOCUS_VERTICAL_GRID_PIXELS,
        nodeWidth: FOCUS_NODE_WIDTH_PIXELS,
        nodeHeight: FOCUS_NODE_HEIGHT_PIXELS,
        originX: 80,
        originY: 80,
      },
    );

    expect(rendered.svg).toContain(`d="${focusConnectorSvgPath(curve)}"`);
  });
});
