import { describe, expect, it } from 'vitest';
import {
  FOCUS_PLAN_SCHEMA_VERSION,
  FocusLayoutWorkBudget,
  compactFocusTreePlanAsync,
  focusPlanHash,
  layoutFocusTree,
  type FocusLayoutBudget,
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
    id: 'async_compact_tree',
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
      sourcePath: 'mod:common/national_focus/async_compact_tree.txt',
      sourceHash: 'source-hash',
      importedPlanHash: '',
    },
  };
  plan.provenance.importedPlanHash = focusPlanHash(plan);
  return plan;
}

function widePlan(): FocusTreePlan {
  const root = focusNode('root', 0, 0);
  return focusPlan([
    root,
    ...[-20, -10, 10, 20].map((x, index) => focusNode(`child_${String(index)}`, x, 3, root.id)),
  ]);
}

describe('asynchronous compact focus planning', () => {
  it('shares one work ceiling across consecutive layout runs', () => {
    const plan = widePlan();
    const probe = new FocusLayoutWorkBudget(1_000_000);
    layoutFocusTree(plan, { workBudget: probe });
    const oneLayoutWork = probe.consumed;
    expect(oneLayoutWork).toBeGreaterThan(0);

    const aggregate = new FocusLayoutWorkBudget(oneLayoutWork * 2 - 1);
    layoutFocusTree(plan, { workBudget: aggregate });
    expect(() => layoutFocusTree(plan, { workBudget: aggregate })).toThrowError(
      expect.objectContaining({ code: 'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED' }),
    );
  });

  it('enforces the aggregate ceiling across compact candidates', async () => {
    const plan = widePlan();
    const probe = new FocusLayoutWorkBudget(1_000_000);
    layoutFocusTree(plan, { workBudget: probe });

    await expect(
      compactFocusTreePlanAsync(plan, { maximumWork: probe.consumed + 1 }),
    ).rejects.toMatchObject({ code: 'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED' });
  });

  it('caps connector refinement even when the shared caller budget is larger', () => {
    class RecordingBudget implements FocusLayoutBudget {
      public consumed = 0;
      public refinementConsumed = 0;

      public spend(phase: string, amount = 1): void {
        this.consumed += amount;
        if (phase.startsWith('connector refinement:')) this.refinementConsumed += amount;
      }
    }

    const upper = focusNode('refinement_upper', -60, 0);
    const gateway = focusNode('refinement_gateway', -50, 1, upper.id);
    gateway.position = { mode: 'auto', pinned: false, preferredX: -50, preferredY: 1 };
    const children = Array.from({ length: 120 }, (_, index) =>
      focusNode(`refinement_child_${String(index)}`, index * 2, 2, gateway.id),
    );
    const workBudget = new RecordingBudget();

    layoutFocusTree(focusPlan([upper, gateway, ...children]), { workBudget });

    expect(workBudget.refinementConsumed).toBeGreaterThan(500_000);
    expect(workBudget.refinementConsumed).toBeLessThanOrEqual(7_000_000);
  });

  it('observes cancellation between the current layout and candidate search', async () => {
    const controller = new AbortController();
    let matchedCandidateBoundary = false;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property !== 'throwIfAborted') return Reflect.get(target, property, target);
        return () => {
          if (
            !matchedCandidateBoundary &&
            new Error().stack?.includes('compactFocusTreePlanAsync') === true
          ) {
            matchedCandidateBoundary = true;
            controller.abort();
          }
          target.throwIfAborted();
        };
      },
    });

    await expect(compactFocusTreePlanAsync(widePlan(), { signal })).rejects.toThrow(/abort/iu);
    expect(matchedCandidateBoundary).toBe(true);
  });
});
