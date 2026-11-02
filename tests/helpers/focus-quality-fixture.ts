import {
  FOCUS_PLAN_SCHEMA_VERSION,
  focusPlanHash,
} from '../../src/hoi4_agent_tools/focus/model.js';
import type {
  FocusNodePlan,
  FocusPosition,
  FocusTreePlan,
} from '../../src/hoi4_agent_tools/focus/model.js';
import { buildQualityGraph } from '../../src/hoi4_agent_tools/focus/quality/graph.js';
import { measureLayoutQuality } from '../../src/hoi4_agent_tools/focus/quality/metrics.js';
import type {
  QualityGraph,
  QualityMeasurement,
} from '../../src/hoi4_agent_tools/focus/quality/types.js';

/** One focus of a synthetic tree: a fixed grid position and its prerequisites. */
export interface FixtureFocus {
  id: string;
  x: number;
  y: number;
  /** Each entry is one prerequisite block (AND of blocks); several ids in an entry are an OR group. */
  needs?: Array<string | string[]>;
  exclusive?: string[];
  allowBranch?: boolean;
  offset?: boolean;
  relativeTo?: string;
}

export function qualityFocus(spec: FixtureFocus): FocusNodePlan {
  const position: FocusPosition =
    spec.relativeTo === undefined
      ? { mode: 'fixed', x: spec.x, y: spec.y, pinned: true }
      : { mode: 'relative', x: spec.x, y: spec.y, relativeTo: spec.relativeTo, pinned: true };
  return {
    id: spec.id,
    label: spec.id,
    prerequisites: {
      operator: 'and',
      groups: (spec.needs ?? []).map((entry) => ({
        operator: 'or' as const,
        focusIds: Array.isArray(entry) ? entry : [entry],
        rawPassthrough: [],
      })),
    },
    mutuallyExclusive: spec.exclusive ?? [],
    routeLocks: [],
    position,
    visibility: 'normal',
    convergence: false,
    sharedSupport: false,
    icons: [{ kind: 'static', sprite: 'GFX_fixture' }],
    localisation: { titleKey: spec.id, descriptionKey: `${spec.id}_desc` },
    ai: { majorRoute: false, strategyIds: [] },
    filters: ['FOCUS_FILTER_POLITICAL'],
    links: [],
    rawPassthrough:
      spec.offset === true
        ? [{ kind: 'block', key: 'offset', order: 0, text: 'offset = { x = 1 }' }]
        : [],
    ...(spec.allowBranch === true
      ? { allowBranch: { text: 'allow_branch = { always = yes }', referencedFocusIds: [] } }
      : {}),
  };
}

export function qualityPlan(
  specs: readonly FixtureFocus[],
  overrides: Partial<FocusTreePlan> = {},
): FocusTreePlan {
  const focuses = specs.map(qualityFocus);
  const plan: FocusTreePlan = {
    schemaVersion: FOCUS_PLAN_SCHEMA_VERSION,
    id: 'quality_tree',
    default: false,
    branchGroups: [],
    laneGroups: [{ id: 'default', label: 'Default lane', order: 0 }],
    entryFocusIds: focuses
      .filter(({ prerequisites }) => prerequisites.groups.length === 0)
      .map(({ id }) => id),
    focuses,
    sharedFocusIds: [],
    continuousFocusPaletteIds: [],
    continuousFocusIds: [],
    rawPassthrough: [],
    provenance: {
      sourcePath: 'mod:common/national_focus/quality.txt',
      sourceHash: 'source-hash',
      importedPlanHash: '',
    },
    ...overrides,
  };
  plan.provenance.importedPlanHash = focusPlanHash(plan);
  return plan;
}

export function qualityGraphOf(specs: readonly FixtureFocus[]): QualityGraph {
  return buildQualityGraph(
    qualityPlan(specs),
    specs.map(({ id, x, y }) => ({ id, x, y })),
  );
}

export function measureSpecs(specs: readonly FixtureFocus[]): QualityMeasurement {
  return measureLayoutQuality(qualityGraphOf(specs));
}

/**
 * Two lanes that fan out from a root, run straight down and converge on a capstone:
 *
 *     x:   -2    0    2
 *   y 0:        root
 *   y 1:  a           b
 *   y 2:  a1          b1
 *   y 3:  a2          b2
 *   y 4:        cap
 *
 * Eight focuses, eight links. Every value in the metric tests is computed by hand from this grid.
 */
export const TWIN_LANES: readonly FixtureFocus[] = [
  { id: 'root', x: 0, y: 0 },
  { id: 'a', x: -2, y: 1, needs: ['root'] },
  { id: 'b', x: 2, y: 1, needs: ['root'] },
  { id: 'a1', x: -2, y: 2, needs: ['a'] },
  { id: 'b1', x: 2, y: 2, needs: ['b'] },
  { id: 'a2', x: -2, y: 3, needs: ['a1'] },
  { id: 'b2', x: 2, y: 3, needs: ['b1'] },
  { id: 'cap', x: 0, y: 4, needs: ['a2', 'b2'] },
];

/** A three-focus chain whose first link jogs three columns and whose last link leaves a gap row. */
export const JOGGED_CHAIN: readonly FixtureFocus[] = [
  { id: 'p', x: 0, y: 0 },
  { id: 'q', x: 3, y: 1, needs: ['p'] },
  { id: 'w', x: 3, y: 3, needs: ['q'] },
];

/** Three parents that are all prerequisites of three children: the game draws one shared bar. */
export const ALL_TO_ALL_BUNDLE: readonly FixtureFocus[] = [
  { id: 'p1', x: -4, y: 0 },
  { id: 'p2', x: 0, y: 0 },
  { id: 'p3', x: 4, y: 0 },
  { id: 'c1', x: -4, y: 2, needs: ['p1', 'p2', 'p3'] },
  { id: 'c2', x: 0, y: 2, needs: ['p1', 'p2', 'p3'] },
  { id: 'c3', x: 4, y: 2, needs: ['p1', 'p2', 'p3'] },
];

/**
 * A mod-sized tree that a hand-typed layout produces: one lane whose generations step two columns
 * left on every row, so the whole mass hangs off to the left of the first focus.
 */
export function staircaseTree(length: number): FixtureFocus[] {
  const focuses: FixtureFocus[] = [{ id: 'step_0', x: 0, y: 0 }];
  for (let index = 1; index < length; index += 1)
    focuses.push({
      id: `step_${String(index)}`,
      x: -2 * index,
      y: index,
      needs: [`step_${String(index - 1)}`],
    });
  return focuses;
}

/** A balanced tree of `lanes` lanes with `depth` focuses each under a root: vanilla-like and tidy. */
export function symmetricLanes(lanes: number, depth: number): FixtureFocus[] {
  const focuses: FixtureFocus[] = [{ id: 'root', x: 0, y: 0 }];
  for (let lane = 0; lane < lanes; lane += 1) {
    const x = (2 * lane - (lanes - 1)) * 2;
    for (let level = 1; level <= depth; level += 1)
      focuses.push({
        id: `lane_${String(lane)}_${String(level)}`,
        x,
        y: level,
        needs: [level === 1 ? 'root' : `lane_${String(lane)}_${String(level - 1)}`],
      });
  }
  return focuses;
}
