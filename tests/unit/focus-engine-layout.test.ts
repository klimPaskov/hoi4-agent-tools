import { describe, expect, it } from 'vitest';
import type { FocusLayoutEngineResponse } from '../../src/hoi4_agent_tools/core/engine-client.js';
import {
  applyFocusEngineSource,
  assertFocusEngineLayoutWritten,
  focusEngineDiagnostics,
  focusEngineLayoutRequest,
} from '../../src/hoi4_agent_tools/focus/engine-layout.js';
import type {
  FocusNodePlan,
  FocusPosition,
  FocusTreePlan,
} from '../../src/hoi4_agent_tools/focus/model.js';

const hash = 'b'.repeat(64);

function node(
  id: string,
  position: FocusPosition,
  extra: Partial<FocusNodePlan> = {},
): FocusNodePlan {
  return {
    id,
    label: id,
    prerequisites: { operator: 'and', groups: [] },
    mutuallyExclusive: [],
    routeLocks: [],
    position,
    visibility: 'normal',
    convergence: false,
    sharedSupport: false,
    icons: [],
    localisation: { titleKey: id, descriptionKey: `${id}_desc` },
    ai: { majorRoute: false, strategyIds: [] },
    filters: [],
    links: [],
    rawPassthrough: [],
    ...extra,
  };
}

function needs(...groups: string[][]): FocusNodePlan['prerequisites'] {
  return {
    operator: 'and',
    groups: groups.map((focusIds) => ({ operator: 'or', focusIds, rawPassthrough: [] })),
  };
}

function plan(focuses: FocusNodePlan[]): FocusTreePlan {
  return {
    schemaVersion: 1,
    id: 'unit_tree',
    default: false,
    branchGroups: [
      {
        id: 'army',
        label: 'Army',
        family: 'military',
        focusIds: [],
        laneId: 'military',
        major: false,
        hidden: false,
        crisis: false,
        conditional: false,
        aiStrategyIds: [],
      },
    ],
    laneGroups: [{ id: 'military', label: 'Military', order: 3, minimumX: -4 }],
    entryFocusIds: [],
    focuses,
    sharedFocusIds: [],
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    rawPassthrough: [],
    provenance: { sourcePath: 'plan:unit_tree', sourceHash: hash, importedPlanHash: hash },
  };
}

const auto: FocusPosition = { mode: 'auto', pinned: false };

describe('focus engine request', () => {
  it('maps prerequisites, exclusions, lanes and positions', () => {
    const request = focusEngineLayoutRequest({
      layoutMode: 'engine',
      plan: plan([
        node('root', { mode: 'fixed', x: 3, y: 0, pinned: true }),
        node(
          'child',
          { mode: 'auto', pinned: false, preferredX: 5 },
          {
            branchId: 'army',
            prerequisites: needs(['root'], ['a', 'b']),
            mutuallyExclusive: ['other'],
          },
        ),
        node(
          'other',
          { mode: 'relative', x: 2, y: 1, relativeTo: 'root', pinned: false },
          {
            laneId: 'own',
          },
        ),
      ]),
    });
    expect(request).toMatchObject({
      schema: 'hoi4-focus-layout-request/1',
      operation: 'layout',
      treeId: 'unit_tree',
      lanes: [{ id: 'military', order: 3, minimumX: -4 }],
    });
    expect(request.insert).toBeUndefined();
    expect(request.focuses).toEqual([
      {
        id: 'root',
        prerequisites: [],
        mutuallyExclusive: [],
        laneId: 'default',
        position: { mode: 'fixed', x: 3, y: 0 },
        pinned: true,
      },
      {
        id: 'child',
        prerequisites: [['root'], ['a', 'b']],
        mutuallyExclusive: ['other'],
        laneId: 'military',
        position: { mode: 'auto', preferredX: 5 },
        pinned: false,
      },
      {
        id: 'other',
        prerequisites: [],
        mutuallyExclusive: [],
        laneId: 'own',
        position: { mode: 'relative', x: 2, y: 1, relativeTo: 'root' },
        pinned: false,
      },
    ]);
  });

  it('builds an insert that keeps existing automatic focuses at their source coordinates', () => {
    const request = focusEngineLayoutRequest({
      layoutMode: 'authored',
      plan: plan([node('root', auto), node('added', auto, { prerequisites: needs(['root']) })]),
      placement: { focusIds: ['added'], anchorId: 'added', preferSide: 'left', allowShift: true },
      currentSourcePositions: new Map([['root', { mode: 'fixed', x: 7, y: 0, pinned: false }]]),
      currentFocusIds: new Set(['root']),
    });
    expect(request.operation).toBe('insert');
    expect(request.insert).toEqual({
      focusIds: ['added'],
      anchorId: 'added',
      preferSide: 'left',
      allowShift: true,
    });
    expect(request.focuses.map(({ id, position }) => [id, position])).toEqual([
      ['root', { mode: 'fixed', x: 7, y: 0 }],
      ['added', { mode: 'auto' }],
    ]);
  });

  it('refuses placements it cannot honour', () => {
    const base = plan([
      node('root', { mode: 'fixed', x: 0, y: 0, pinned: true }),
      node('new', auto),
    ]);
    const code = (run: () => unknown): string | undefined => {
      try {
        run();
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(
      code(() =>
        focusEngineLayoutRequest({
          layoutMode: 'engine',
          plan: base,
          placement: { focusIds: ['x'] },
        }),
      ),
    ).toBe('FOCUS_PLACEMENT_INVALID');
    expect(
      code(() =>
        focusEngineLayoutRequest({
          layoutMode: 'authored',
          plan: base,
          placement: { focusIds: ['new'] },
          currentFocusIds: new Set(['root', 'new']),
        }),
      ),
    ).toBe('FOCUS_PLACEMENT_INVALID');
    expect(
      code(() =>
        focusEngineLayoutRequest({
          layoutMode: 'engine',
          plan: base,
          placement: { focusIds: ['root'] },
        }),
      ),
    ).toBe('FOCUS_PLACEMENT_INVALID');
    expect(
      code(() =>
        focusEngineLayoutRequest({
          layoutMode: 'engine',
          plan: plan([node('a', auto), node('b', auto)]),
          placement: { focusIds: ['b'] },
        }),
      ),
    ).toBe('FOCUS_PLACEMENT_INVALID');
  });
});

describe('focus engine response', () => {
  const response: FocusLayoutEngineResponse = {
    schema: 'hoi4-focus-layout/1',
    status: 'ok',
    operation: 'layout',
    nodes: [
      { id: 'a', x: 0, y: 0, laneId: 'default', moved: true },
      { id: 'b', x: 2, y: 1, laneId: 'default', moved: true },
    ],
    source: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', relativeTo: 'a', x: 2, y: 1 },
    ],
    diagnostics: [
      {
        code: 'FOCUS_ENGINE_LANE_BOUNDS_UNSATISFIED',
        severity: 'warning',
        focusIds: ['a'],
        message: 'lane does not fit',
        details: { laneId: 'default' },
      },
    ],
    metrics: {
      columns: 3,
      rows: 2,
      orthogonalCrossings: 0,
      stemsThroughPlaques: 0,
      mergedBars: 0,
      durationMicros: 10,
    },
    hashes: { layout: hash, untouched: hash, prerequisites: hash, exclusions: hash },
  };

  it('turns source entries into fixed and relative positions', () => {
    const applied = applyFocusEngineSource(
      plan([node('a', auto), node('b', { mode: 'fixed', x: 9, y: 9, pinned: true })]),
      response,
    );
    expect(applied.focuses.map(({ position }) => position)).toEqual([
      { mode: 'fixed', x: 0, y: 0, pinned: false },
      { mode: 'relative', x: 2, y: 1, relativeTo: 'a', pinned: true },
    ]);
  });

  it('maps engine diagnostics and checks the written layout', () => {
    expect(focusEngineDiagnostics(response)).toEqual([
      {
        code: 'FOCUS_ENGINE_LANE_BOUNDS_UNSATISFIED',
        severity: 'warning',
        category: 'layout',
        message: 'lane does not fit',
        details: { laneId: 'default', focusIds: ['a'] },
      },
    ]);
    const written = [
      { id: 'a', x: 0, y: 0, laneId: 'default', preserved: true, sourceMode: 'fixed' as const },
      { id: 'b', x: 2, y: 1, laneId: 'default', preserved: true, sourceMode: 'relative' as const },
    ];
    expect(() => assertFocusEngineLayoutWritten(response, written)).not.toThrow();
    expect(() =>
      assertFocusEngineLayoutWritten(response, [written[0]!, { ...written[1]!, x: 4 }]),
    ).toThrowError(expect.objectContaining({ code: 'FOCUS_ENGINE_LAYOUT_MISMATCH' }));
  });
});
