import { compareCodeUnits } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { DiagnosticCollector } from '../core/diagnostic-collector.js';
import type { SymbolIndex, SymbolKind } from '../core/index.js';
import { ServiceError } from '../core/result.js';
import { focusConnectorSegmentsProperlyCross, focusNodesVisiblyOverlap } from './geometry.js';
import { layoutFocusTree } from './layout.js';
import {
  FOCUS_CYCLE_SAMPLE_MAX,
  FOCUS_DIAGNOSTIC_MAX,
  FOCUS_GRAPH_MAX_DEPTH,
  FOCUS_GRAPH_MAX_EDGES,
  FOCUS_GRAPH_MAX_NODES,
  FOCUS_LINT_WORK_MAX,
  FOCUS_PAIR_COMPARISON_MAX,
} from './limits.js';
import {
  layoutNodeMap,
  type FocusLayoutResult,
  type ContinuousFocusPalettePlan,
  type FocusNodePlan,
  type FocusReferenceCatalog,
  type FocusReferenceKind,
  type FocusTreePlan,
} from './model.js';

export function lintContinuousFocusPalette(plan: ContinuousFocusPalettePlan): Diagnostic[] {
  if (plan.focuses.length > FOCUS_GRAPH_MAX_NODES) {
    return [
      {
        code: 'FOCUS_GRAPH_NODE_BUDGET_BLOCKED',
        severity: 'blocker',
        category: 'layout',
        message: 'Continuous focus palette exceeds the fixed traversal node ceiling',
        details: { nodes: plan.focuses.length, maximumNodes: FOCUS_GRAPH_MAX_NODES },
      },
    ];
  }
  const diagnostics = new DiagnosticCollector(FOCUS_DIAGNOSTIC_MAX, {
    code: 'FOCUS_LINT_DIAGNOSTICS_TRUNCATED',
    category: 'layout',
    message: 'Focus lint diagnostics exceeded the fixed global result ceiling',
  });
  const seen = new Set<string>();
  for (const focus of plan.focuses) {
    if (seen.has(focus.id))
      diagnostics.push({
        code: 'CONTINUOUS_FOCUS_DUPLICATE_ID',
        severity: 'error',
        category: 'syntax',
        message: `Continuous focus ${focus.id} is defined more than once in ${plan.id}`,
        ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      });
    seen.add(focus.id);
    if (focus.icons.length === 0)
      diagnostics.push({
        code: 'CONTINUOUS_FOCUS_ICON_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `Continuous focus ${focus.id} has no icon`,
        ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      });
    if (focus.localisation.titleKey.length === 0 || focus.localisation.descriptionKey.length === 0)
      diagnostics.push({
        code: 'CONTINUOUS_FOCUS_LOCALISATION_MISSING',
        severity: 'warning',
        category: 'reference',
        message: `Continuous focus ${focus.id} has incomplete localisation keys`,
        ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      });
  }
  if (!plan.default && plan.countryAssignment === undefined)
    diagnostics.push({
      code: 'CONTINUOUS_FOCUS_PALETTE_UNASSIGNED',
      severity: 'warning',
      category: 'design',
      message: `Continuous focus palette ${plan.id} is neither default nor country-assigned`,
      ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
    });
  return sortDiagnostics(diagnostics.values());
}

export interface FocusLintOptions {
  index?: SymbolIndex;
  layout?: FocusLayoutResult;
  references?: FocusReferenceCatalog;
  localisationLanguage?: string;
  genericRewardThreshold?: number;
}

export {
  FOCUS_GRAPH_MAX_DEPTH,
  FOCUS_GRAPH_MAX_EDGES,
  FOCUS_GRAPH_MAX_NODES,
  FOCUS_PAIR_COMPARISON_MAX,
} from './limits.js';

function withFocusLocation(
  focus: FocusNodePlan,
): Pick<Diagnostic, 'location'> | Record<string, never> {
  return focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation };
}

function prerequisiteIds(focus: FocusNodePlan): string[] {
  return focus.prerequisites.groups.flatMap(({ focusIds }) => focusIds);
}

function referenceSet(
  catalog: FocusReferenceCatalog | undefined,
  kind: FocusReferenceKind,
): ReadonlySet<string> | undefined {
  const values = catalog?.[kind];
  if (values === undefined) return undefined;
  return values instanceof Set ? values : new Set(values);
}

function referenceSymbolKind(kind: FocusReferenceKind): SymbolKind {
  switch (kind) {
    case 'decision':
      return 'decision';
    case 'decision_category':
      return 'decision_category';
    case 'event':
      return 'event';
    case 'idea':
      return 'idea';
    case 'leader':
      return 'leader';
    case 'formable':
      return 'formable';
    case 'helper':
      return 'scripted_effect';
  }
}

function graphCycles(
  focuses: Map<string, FocusNodePlan>,
  edges: (focus: FocusNodePlan) => readonly string[],
  work: FocusLintWorkBudget,
): { cycles: string[][]; depthBlocked: boolean; samplesTruncated: boolean } {
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  let samplesTruncated = false;
  const recordCycle = (id: string): void => {
    if (cycles.length >= FOCUS_CYCLE_SAMPLE_MAX) {
      samplesTruncated = true;
      return;
    }
    work.spend('cycle path selection', path.length);
    const start = path.indexOf(id);
    const body = path.slice(start);
    const length = body.length;
    let left = 0;
    let right = 1;
    let offset = 0;
    while (left < length && right < length && offset < length) {
      work.spend('cycle minimal-rotation comparison');
      const leftValue = body[(left + offset) % length]!;
      const rightValue = body[(right + offset) % length]!;
      const comparison = compareCodeUnits(leftValue, rightValue);
      if (comparison === 0) {
        offset += 1;
        continue;
      }
      if (comparison > 0) {
        left += offset + 1;
        if (left === right) left += 1;
      } else {
        right += offset + 1;
        if (left === right) right += 1;
      }
      offset = 0;
    }
    const rotation = Math.min(left, right);
    const canonical: string[] = [];
    for (let index = 0; index < length; index += 1) {
      work.spend('cycle canonical key construction');
      canonical.push(body[(rotation + index) % length]!);
    }
    const key = canonical.join('\0');
    if (!seenCycles.has(key)) {
      seenCycles.add(key);
      cycles.push([...body, id]);
    }
  };
  for (const start of [...focuses.keys()].sort((left, right) => compareCodeUnits(left, right))) {
    if ((state.get(start) ?? 0) !== 0) continue;
    const focus = focuses.get(start);
    if (focus === undefined) continue;
    const frames: Array<{ id: string; targets: string[]; next: number }> = [
      {
        id: start,
        targets: [...edges(focus)].sort((left, right) => compareCodeUnits(left, right)),
        next: 0,
      },
    ];
    state.set(start, 1);
    path.push(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const target = frame.targets[frame.next];
      if (target === undefined) {
        frames.pop();
        path.pop();
        state.set(frame.id, 2);
        continue;
      }
      frame.next += 1;
      if (!focuses.has(target)) continue;
      const targetState = state.get(target) ?? 0;
      if (targetState === 1) {
        recordCycle(target);
        continue;
      }
      if (targetState === 2) continue;
      if (frames.length >= FOCUS_GRAPH_MAX_DEPTH)
        return { cycles, depthBlocked: true, samplesTruncated };
      const targetFocus = focuses.get(target)!;
      state.set(target, 1);
      path.push(target);
      frames.push({
        id: target,
        targets: [...edges(targetFocus)].sort((left, right) => compareCodeUnits(left, right)),
        next: 0,
      });
    }
  }
  return { cycles, depthBlocked: false, samplesTruncated };
}

function ancestorSet(
  focusId: string,
  focuses: Map<string, FocusNodePlan>,
  memo: Map<string, ReadonlySet<string>>,
  work: FocusLintWorkBudget,
): Set<string> {
  const cached = memo.get(focusId);
  if (cached !== undefined) return new Set(cached);
  const seen = new Set<string>();
  const pending = [focusId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const focus = focuses.get(current);
    if (focus === undefined) continue;
    for (const parent of prerequisiteIds(focus)) {
      work.spend('ancestor traversal');
      if (seen.has(parent)) continue;
      seen.add(parent);
      const parentAncestors = memo.get(parent);
      if (parentAncestors === undefined) pending.push(parent);
      else {
        for (const ancestor of parentAncestors) {
          work.spend('memoized ancestor union');
          seen.add(ancestor);
        }
      }
    }
  }
  memo.set(focusId, new Set(seen));
  return seen;
}

class FocusLintWorkBudget {
  private used = 0;

  public spend(phase: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > FOCUS_LINT_WORK_MAX - this.used) {
      throw new ServiceError(
        'FOCUS_LINT_WORK_BUDGET_BLOCKED',
        'Focus lint exceeds the fixed transitive and route-analysis work ceiling',
        { phase, used: this.used, requested: amount, maximumWork: FOCUS_LINT_WORK_MAX },
      );
    }
    this.used += amount;
  }
}

function normalizedReward(focus: FocusNodePlan): string | undefined {
  const text = focus.completionReward?.text;
  return text === undefined
    ? undefined
    : text
        .replace(/#[^\r\n]*/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function lintFocusTree(plan: FocusTreePlan, options: FocusLintOptions = {}): Diagnostic[] {
  const diagnostics = new DiagnosticCollector(FOCUS_DIAGNOSTIC_MAX, {
    code: 'FOCUS_LINT_DIAGNOSTICS_TRUNCATED',
    category: 'layout',
    message: 'Focus lint diagnostics exceeded the fixed global result ceiling',
  });
  const work = new FocusLintWorkBudget();
  if (plan.focuses.length > FOCUS_GRAPH_MAX_NODES) {
    return [
      {
        code: 'FOCUS_GRAPH_NODE_BUDGET_BLOCKED',
        severity: 'blocker',
        category: 'layout',
        message: 'Focus graph exceeds the fixed traversal node ceiling',
        details: { nodes: plan.focuses.length, maximumNodes: FOCUS_GRAPH_MAX_NODES },
      },
    ];
  }
  let prerequisiteEdgeCount = 0;
  for (const focus of plan.focuses) {
    for (const group of focus.prerequisites.groups) {
      prerequisiteEdgeCount += group.focusIds.length;
      if (prerequisiteEdgeCount > FOCUS_GRAPH_MAX_EDGES) {
        return [
          {
            code: 'FOCUS_GRAPH_EDGE_BUDGET_BLOCKED',
            severity: 'blocker',
            category: 'layout',
            message: 'Focus graph exceeds the fixed traversal edge ceiling',
            details: { edges: prerequisiteEdgeCount, maximumEdges: FOCUS_GRAPH_MAX_EDGES },
          },
        ];
      }
    }
  }
  const focuses = new Map<string, FocusNodePlan>();
  const duplicates = new Map<string, FocusNodePlan[]>();
  for (const focus of plan.focuses) {
    const group = duplicates.get(focus.id) ?? [];
    group.push(focus);
    duplicates.set(focus.id, group);
    if (!focuses.has(focus.id)) focuses.set(focus.id, focus);
  }
  for (const [id, group] of duplicates) {
    if (group.length < 2) continue;
    const first = group[0];
    if (first === undefined) continue;
    diagnostics.push({
      code: 'FOCUS_DUPLICATE_ID',
      severity: 'error',
      category: 'reference',
      message: `Focus ID ${id} is defined ${group.length} times`,
      ...withFocusLocation(first),
      related: group
        .slice(1)
        .flatMap(({ sourceLocation }) => (sourceLocation === undefined ? [] : [sourceLocation])),
    });
  }

  for (const focus of focuses.values()) {
    if ((focus.prerequisites as { operator: string }).operator !== 'and') {
      diagnostics.push({
        code: 'FOCUS_PREREQUISITE_OUTER_MALFORMED',
        severity: 'error',
        category: 'syntax',
        message: `Focus ${focus.id} prerequisite expression must use an outer AND`,
        ...withFocusLocation(focus),
      });
    }
    for (const group of focus.prerequisites.groups) {
      if ((group as { operator: string }).operator !== 'or' || group.focusIds.length === 0) {
        diagnostics.push({
          code: 'FOCUS_PREREQUISITE_GROUP_MALFORMED',
          severity: 'error',
          category: 'syntax',
          message: `Focus ${focus.id} contains an empty or non-OR prerequisite group`,
          ...(group.sourceLocation === undefined
            ? withFocusLocation(focus)
            : { location: group.sourceLocation }),
        });
      }
      if (new Set(group.focusIds).size !== group.focusIds.length) {
        diagnostics.push({
          code: 'FOCUS_PREREQUISITE_GROUP_DUPLICATE',
          severity: 'warning',
          category: 'syntax',
          message: `Focus ${focus.id} repeats a target inside one OR group`,
          ...(group.sourceLocation === undefined
            ? withFocusLocation(focus)
            : { location: group.sourceLocation }),
        });
      }
    }
    for (const parent of prerequisiteIds(focus)) {
      if (focuses.has(parent) || options.index?.find('focus', parent) !== undefined) continue;
      diagnostics.push({
        code: 'FOCUS_PREREQUISITE_MISSING',
        severity: 'error',
        category: 'reference',
        message: `Focus ${focus.id} references missing prerequisite ${parent}`,
        ...withFocusLocation(focus),
        details: { focusId: focus.id, target: parent },
      });
    }
  }

  const prerequisiteCycles = graphCycles(focuses, prerequisiteIds, work);
  if (prerequisiteCycles.depthBlocked) {
    diagnostics.push({
      code: 'FOCUS_GRAPH_DEPTH_BUDGET_BLOCKED',
      severity: 'blocker',
      category: 'layout',
      message: 'Focus prerequisite graph exceeds the fixed traversal depth ceiling',
      details: { graph: 'prerequisite', maximumDepth: FOCUS_GRAPH_MAX_DEPTH },
    });
  }
  if (prerequisiteCycles.samplesTruncated) {
    diagnostics.push({
      code: 'FOCUS_CYCLE_SAMPLES_TRUNCATED',
      severity: 'blocker',
      category: 'layout',
      message: 'Focus prerequisite cycle samples exceed the fixed result ceiling',
      details: { graph: 'prerequisite', maximumSamples: FOCUS_CYCLE_SAMPLE_MAX },
    });
  }
  for (const cycle of prerequisiteCycles.cycles) {
    const firstId = cycle[0];
    const focus = firstId === undefined ? undefined : focuses.get(firstId);
    diagnostics.push({
      code: 'FOCUS_PREREQUISITE_CYCLE',
      severity: 'error',
      category: 'reference',
      message: `Focus prerequisite cycle: ${cycle.join(' -> ')}`,
      ...(focus === undefined ? {} : withFocusLocation(focus)),
      details: { cycle },
    });
  }
  if (prerequisiteCycles.depthBlocked) return sortDiagnostics(diagnostics.values());

  const children = new Map<string, Set<string>>();
  for (const focus of focuses.values()) {
    for (const parent of prerequisiteIds(focus)) {
      const set = children.get(parent) ?? new Set<string>();
      set.add(focus.id);
      children.set(parent, set);
    }
  }
  for (const focus of focuses.values()) {
    const parents = prerequisiteIds(focus).filter((id) => focuses.has(id));
    const childCount = children.get(focus.id)?.size ?? 0;
    if (parents.length === 0 && childCount === 0 && focuses.size > 1) {
      diagnostics.push({
        code: 'FOCUS_ISOLATED',
        severity: 'warning',
        category: 'design',
        message: `Focus ${focus.id} is isolated from the rest of the tree`,
        ...withFocusLocation(focus),
      });
    }
  }

  if (plan.entryFocusIds.length > 0) {
    const reachable = new Set<string>();
    const queue = [...plan.entryFocusIds].filter((id) => focuses.has(id));
    let cursor = 0;
    while (cursor < queue.length) {
      const id = queue[cursor];
      cursor += 1;
      if (id === undefined) break;
      work.spend('entry reachability traversal');
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const child of children.get(id) ?? []) queue.push(child);
    }
    for (const focus of focuses.values()) {
      if (reachable.has(focus.id)) continue;
      diagnostics.push({
        code: 'FOCUS_UNREACHABLE',
        severity: 'warning',
        category: 'design',
        message: `Focus ${focus.id} is unreachable from the declared entry focuses`,
        ...withFocusLocation(focus),
      });
    }
  }

  const ancestorMemo = new Map<string, ReadonlySet<string>>();
  for (const focus of focuses.values()) {
    const ancestors =
      focus.mutuallyExclusive.length === 0
        ? new Set<string>()
        : ancestorSet(focus.id, focuses, ancestorMemo, work);
    for (const excluded of focus.mutuallyExclusive) {
      if (excluded === focus.id || ancestors.has(excluded)) {
        diagnostics.push({
          code: 'FOCUS_MUTUAL_EXCLUSION_CONTRADICTS_PATH',
          severity: 'error',
          category: 'reference',
          message:
            excluded === focus.id
              ? `Focus ${focus.id} excludes itself`
              : `Focus ${focus.id} excludes prerequisite ancestor ${excluded}`,
          ...withFocusLocation(focus),
          details: { focusId: focus.id, excluded },
        });
      }
      if (!focuses.has(excluded) && options.index?.find('focus', excluded) === undefined) {
        diagnostics.push({
          code: 'FOCUS_MUTUAL_EXCLUSION_MISSING',
          severity: 'error',
          category: 'reference',
          message: `Focus ${focus.id} excludes missing focus ${excluded}`,
          ...withFocusLocation(focus),
        });
      }
    }
  }

  const relativeEdges = (focus: FocusNodePlan): string[] =>
    focus.position.mode === 'relative' ? [focus.position.relativeTo] : [];
  for (const focus of focuses.values()) {
    if (
      focus.position.mode === 'relative' &&
      !focuses.has(focus.position.relativeTo) &&
      options.index?.find('focus', focus.position.relativeTo) === undefined
    ) {
      diagnostics.push({
        code: 'FOCUS_RELATIVE_TARGET_MISSING',
        severity: 'error',
        category: 'layout',
        message: `Focus ${focus.id} has missing relative target ${focus.position.relativeTo}`,
        ...withFocusLocation(focus),
      });
    }
  }
  const relativeCycles = graphCycles(focuses, relativeEdges, work);
  if (relativeCycles.depthBlocked) {
    diagnostics.push({
      code: 'FOCUS_GRAPH_DEPTH_BUDGET_BLOCKED',
      severity: 'blocker',
      category: 'layout',
      message: 'Focus relative-position graph exceeds the fixed traversal depth ceiling',
      details: { graph: 'relative-position', maximumDepth: FOCUS_GRAPH_MAX_DEPTH },
    });
  }
  if (relativeCycles.samplesTruncated) {
    diagnostics.push({
      code: 'FOCUS_CYCLE_SAMPLES_TRUNCATED',
      severity: 'blocker',
      category: 'layout',
      message: 'Focus relative-position cycle samples exceed the fixed result ceiling',
      details: { graph: 'relative-position', maximumSamples: FOCUS_CYCLE_SAMPLE_MAX },
    });
  }
  for (const cycle of relativeCycles.cycles) {
    const firstId = cycle[0];
    const focus = firstId === undefined ? undefined : focuses.get(firstId);
    diagnostics.push({
      code: 'FOCUS_RELATIVE_POSITION_CYCLE',
      severity: 'error',
      category: 'layout',
      message: `Relative-position cycle: ${cycle.join(' -> ')}`,
      ...(focus === undefined ? {} : withFocusLocation(focus)),
      details: { cycle },
    });
  }
  if (relativeCycles.depthBlocked) return sortDiagnostics(diagnostics.values());

  const exclusionPairs = new Set<string>();
  for (const focus of focuses.values()) {
    for (const excluded of focus.mutuallyExclusive) {
      work.spend('mutual-exclusion pair indexing');
      exclusionPairs.add(
        [focus.id, excluded].sort((left, right) => compareCodeUnits(left, right)).join('\0'),
      );
    }
  }
  for (const focus of focuses.values()) {
    for (const lock of focus.routeLocks) {
      const excludedSet = new Set(lock.excludedFocusIds);
      const same: string[] = [];
      for (const id of lock.requiredFocusIds) {
        work.spend('route-lock required/excluded comparison');
        if (excludedSet.has(id)) same.push(id);
      }
      let incompatible = false;
      if (lock.mode === 'all') {
        for (
          let leftIndex = 0;
          leftIndex < lock.requiredFocusIds.length && !incompatible;
          leftIndex += 1
        ) {
          const left = lock.requiredFocusIds[leftIndex];
          if (left === undefined) continue;
          for (
            let rightIndex = leftIndex + 1;
            rightIndex < lock.requiredFocusIds.length;
            rightIndex += 1
          ) {
            work.spend('route-lock incompatibility pair comparison');
            const right = lock.requiredFocusIds[rightIndex];
            if (right === undefined) continue;
            const pair =
              compareCodeUnits(left, right) <= 0 ? `${left}\0${right}` : `${right}\0${left}`;
            if (exclusionPairs.has(pair)) {
              incompatible = true;
              break;
            }
          }
        }
      }
      if (lock.alwaysImpossible === true || same.length > 0 || incompatible) {
        diagnostics.push({
          code: 'FOCUS_ROUTE_LOCK_IMPOSSIBLE',
          severity: 'error',
          category: 'design',
          message: `Route lock ${lock.id} on ${focus.id} cannot be satisfied`,
          ...(lock.sourceLocation === undefined
            ? withFocusLocation(focus)
            : { location: lock.sourceLocation }),
          details: { requiredAndExcluded: same, incompatibleRequirements: incompatible },
        });
      }
      for (const targets of [lock.requiredFocusIds, lock.excludedFocusIds]) {
        for (const target of targets) {
          work.spend('route-lock reference membership');
          if (focuses.has(target) || options.index?.find('focus', target) !== undefined) continue;
          diagnostics.push({
            code: 'FOCUS_ROUTE_LOCK_REFERENCE_MISSING',
            severity: 'error',
            category: 'reference',
            message: `Route lock ${lock.id} references missing focus ${target}`,
            ...(lock.sourceLocation === undefined
              ? withFocusLocation(focus)
              : { location: lock.sourceLocation }),
          });
        }
      }
    }
    if (
      focus.visibility !== 'normal' &&
      focus.reveal === undefined &&
      focus.allowBranch === undefined
    ) {
      diagnostics.push({
        code: 'FOCUS_HIDDEN_WITHOUT_REVEAL',
        severity: 'warning',
        category: 'design',
        message: `${focus.visibility} focus ${focus.id} has no reveal path`,
        ...withFocusLocation(focus),
      });
    }
  }

  const layout = options.layout ?? layoutFocusTree(plan);
  diagnostics.pushMany(layout.diagnostics);
  const positions = layoutNodeMap(layout);
  const coordinateOwners = new Map<string, string>();
  for (const node of layout.nodes) {
    const key = `${node.x},${node.y}`;
    const owner = coordinateOwners.get(key);
    if (owner !== undefined && owner !== node.id) {
      const focus = focuses.get(node.id);
      diagnostics.push({
        code: 'FOCUS_DUPLICATE_COORDINATE',
        severity: 'error',
        category: 'layout',
        message: `Focuses ${owner} and ${node.id} share coordinate (${node.x}, ${node.y})`,
        ...(focus === undefined ? {} : withFocusLocation(focus)),
      });
    } else coordinateOwners.set(key, node.id);
  }

  const layoutPairCount = (layout.nodes.length * (layout.nodes.length - 1)) / 2;
  if (layoutPairCount > FOCUS_PAIR_COMPARISON_MAX) {
    diagnostics.push({
      code: 'FOCUS_LAYOUT_COMPARISON_BUDGET_BLOCKED',
      severity: 'blocker',
      category: 'layout',
      message: 'Focus overlap analysis exceeds the fixed pair-comparison ceiling',
      details: { comparisons: layoutPairCount, maximumComparisons: FOCUS_PAIR_COMPARISON_MAX },
    });
  } else {
    for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
      const left = layout.nodes[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
        const right = layout.nodes[rightIndex];
        if (right === undefined || !focusNodesVisiblyOverlap(left, right)) continue;
        const focus = focuses.get(right.id);
        diagnostics.push({
          code: 'FOCUS_VISIBLE_OVERLAP',
          severity: 'error',
          category: 'layout',
          message: `Focuses ${left.id} and ${right.id} visibly overlap`,
          ...(focus === undefined ? {} : withFocusLocation(focus)),
          details: {
            focusIds: [left.id, right.id],
            left: { x: left.x, y: left.y },
            right: { x: right.x, y: right.y },
          },
        });
      }
    }
  }

  const connectors = [...focuses.values()].flatMap((focus) =>
    prerequisiteIds(focus).flatMap((parentId) => {
      const parent = positions.get(parentId);
      const child = positions.get(focus.id);
      return parent === undefined || child === undefined
        ? []
        : [{ parentId, childId: focus.id, parent, child }];
    }),
  );
  const connectorPairCount = (connectors.length * (connectors.length - 1)) / 2;
  if (connectorPairCount > FOCUS_PAIR_COMPARISON_MAX) {
    diagnostics.push({
      code: 'FOCUS_CONNECTOR_COMPARISON_BUDGET_BLOCKED',
      severity: 'blocker',
      category: 'layout',
      message: 'Focus connector analysis exceeds the fixed pair-comparison ceiling',
      details: { comparisons: connectorPairCount, maximumComparisons: FOCUS_PAIR_COMPARISON_MAX },
    });
  } else {
    for (let firstIndex = 0; firstIndex < connectors.length; firstIndex += 1) {
      const first = connectors[firstIndex];
      if (first === undefined) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < connectors.length; secondIndex += 1) {
        const second = connectors[secondIndex];
        if (second === undefined) continue;
        if (
          first.parentId === second.parentId ||
          first.parentId === second.childId ||
          first.childId === second.parentId ||
          first.childId === second.childId
        ) {
          continue;
        }
        if (
          !focusConnectorSegmentsProperlyCross(
            first.parent,
            first.child,
            second.parent,
            second.child,
          )
        )
          continue;
        const focus = focuses.get(second.childId);
        if (focus === undefined) continue;
        diagnostics.push({
          code: 'FOCUS_AVOIDABLE_CONNECTOR_CROSSING',
          severity: 'warning',
          category: 'layout',
          message: `Connectors ${first.parentId} -> ${first.childId} and ${second.parentId} -> ${second.childId} cross`,
          ...withFocusLocation(focus),
          details: {
            first: [first.parentId, first.childId],
            second: [second.parentId, second.childId],
          },
        });
      }
    }
  }

  for (const focus of focuses.values()) {
    const terminal = (children.get(focus.id)?.size ?? 0) === 0;
    const meaningful =
      focus.terminalKind !== undefined ||
      focus.payoff !== undefined ||
      focus.completionReward !== undefined ||
      focus.links.length > 0;
    if (terminal && !meaningful) {
      diagnostics.push({
        code: 'FOCUS_TERMINAL_WITHOUT_PAYOFF',
        severity: 'warning',
        category: 'design',
        message: `Terminal focus ${focus.id} has no payoff metadata, effect, or linked gameplay`,
        ...withFocusLocation(focus),
      });
      if (prerequisiteIds(focus).length === 1) {
        diagnostics.push({
          code: 'FOCUS_WEAK_DANGLING_BRANCH',
          severity: 'warning',
          category: 'design',
          message: `Focus ${focus.id} ends a one-parent branch without a meaningful payoff`,
          ...withFocusLocation(focus),
        });
      }
    }
    if (focus.icons.length === 0) {
      diagnostics.push({
        code: 'FOCUS_ICON_MISSING',
        severity: 'warning',
        category: 'design',
        message: `Focus ${focus.id} has no icon`,
        ...withFocusLocation(focus),
      });
    }
    for (const icon of focus.icons) {
      if (options.index === undefined || options.index.find('sprite', icon.sprite) !== undefined)
        continue;
      const partial = options.index.hasSkippedSourceForKind('sprite');
      diagnostics.push({
        code: partial ? 'FOCUS_ICON_REFERENCE_PARTIAL' : 'FOCUS_ICON_REFERENCE_MISSING',
        severity: partial ? 'warning' : 'error',
        category: 'reference',
        message: partial
          ? `The partial shared inventory cannot verify sprite ${icon.sprite} for focus ${focus.id}`
          : `Focus ${focus.id} references missing sprite ${icon.sprite}`,
        ...(icon.sourceLocation === undefined
          ? withFocusLocation(focus)
          : { location: icon.sourceLocation }),
      });
    }
    if (
      focus.localisation.titleKey.length === 0 ||
      focus.localisation.descriptionKey.length === 0
    ) {
      diagnostics.push({
        code: 'FOCUS_LOCALISATION_KEY_MISSING',
        severity: 'warning',
        category: 'design',
        message: `Focus ${focus.id} lacks title or description localisation metadata`,
        ...withFocusLocation(focus),
      });
    } else if (options.index !== undefined) {
      const language = options.localisationLanguage ?? 'l_english';
      for (const key of [focus.localisation.titleKey, focus.localisation.descriptionKey]) {
        if (options.index.find('localisation', `${language}:${key}`) !== undefined) continue;
        const partial = options.index.hasSkippedSourceForKind('localisation');
        diagnostics.push({
          code: partial
            ? 'FOCUS_LOCALISATION_REFERENCE_PARTIAL'
            : 'FOCUS_LOCALISATION_REFERENCE_MISSING',
          severity: 'warning',
          category: 'reference',
          message: partial
            ? `The partial shared inventory cannot verify ${language} localisation ${key} for focus ${focus.id}`
            : `Focus ${focus.id} has no ${language} localisation for ${key}`,
          ...withFocusLocation(focus),
          details: { language, key },
        });
      }
    }
    if (focus.filters.length === 0) {
      diagnostics.push({
        code: 'FOCUS_FILTER_MISSING',
        severity: 'warning',
        category: 'design',
        message: `Focus ${focus.id} has no search filter metadata`,
        ...withFocusLocation(focus),
      });
    }
    const branch = plan.branchGroups.find(({ id }) => id === focus.branchId);
    if (
      (focus.ai.majorRoute || branch?.major === true) &&
      focus.ai.raw === undefined &&
      focus.ai.strategyIds.length === 0
    ) {
      diagnostics.push({
        code: 'FOCUS_MAJOR_ROUTE_AI_MISSING',
        severity: 'warning',
        category: 'design',
        message: `Major-route focus ${focus.id} has no AI weight or strategy metadata`,
        ...withFocusLocation(focus),
      });
    }
    for (const link of focus.links) {
      const available = referenceSet(options.references, link.kind);
      if (available === undefined || available.has(link.target)) continue;
      const partial =
        options.index?.hasSkippedSourceForKind(referenceSymbolKind(link.kind)) ?? false;
      diagnostics.push({
        code: partial ? 'FOCUS_GAMEPLAY_REFERENCE_PARTIAL' : 'FOCUS_GAMEPLAY_REFERENCE_MISSING',
        severity: partial ? 'warning' : 'error',
        category: 'reference',
        message: partial
          ? `The partial shared inventory cannot verify ${link.kind} ${link.target} for focus ${focus.id}`
          : `Focus ${focus.id} references missing ${link.kind} ${link.target}`,
        ...(link.sourceLocation === undefined
          ? withFocusLocation(focus)
          : { location: link.sourceLocation }),
        details: { kind: link.kind, target: link.target },
      });
    }
  }

  for (const branch of plan.branchGroups) {
    for (const focusId of branch.focusIds) {
      if (focuses.has(focusId)) continue;
      diagnostics.push({
        code: 'FOCUS_BRANCH_MEMBER_MISSING',
        severity: 'error',
        category: 'reference',
        message: `Branch ${branch.id} references missing focus ${focusId}`,
        ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
      });
    }
    if (
      branch.major &&
      branch.aiStrategyIds.length === 0 &&
      !branch.focusIds.some((id) => focuses.get(id)?.ai.raw !== undefined)
    ) {
      diagnostics.push({
        code: 'FOCUS_MAJOR_ROUTE_AI_MISSING',
        severity: 'warning',
        category: 'design',
        message: `Major branch ${branch.id} has no route-specific AI metadata`,
        ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
      });
    }
  }

  if (
    plan.runtimeAssignment?.replacesExistingCountryTree === true &&
    plan.runtimeAssignment.eventCreatedGuard === undefined
  ) {
    diagnostics.push({
      code: 'FOCUS_RUNTIME_REPLACEMENT_UNSAFE',
      severity: 'error',
      category: 'design',
      message: `Tree ${plan.id} replaces an existing country's runtime tree without an event-created guard`,
      ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
    });
  }

  const rewards = new Map<string, FocusNodePlan[]>();
  for (const focus of focuses.values()) {
    const reward = normalizedReward(focus);
    if (reward === undefined || reward === '{}') continue;
    const group = rewards.get(reward) ?? [];
    group.push(focus);
    rewards.set(reward, group);
  }
  for (const group of rewards.values()) {
    if (group.length < (options.genericRewardThreshold ?? 3)) continue;
    for (const focus of group) {
      diagnostics.push({
        code: 'FOCUS_REPEATED_GENERIC_REWARD',
        severity: 'warning',
        category: 'design',
        message: `Focus ${focus.id} repeats the same reward pattern across ${group.length} focuses`,
        ...withFocusLocation(focus),
        details: { focusIds: group.map(({ id }) => id) },
      });
    }
  }

  return sortDiagnostics(diagnostics.values());
}
