import { compareCodeUnits } from '../../core/canonical.js';
import type { FocusNodePlan, FocusTreePlan } from '../model.js';
import type { QualityEdge, QualityGraph, QualityNode } from './types.js';

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/** A focus whose game position depends on an `offset` block the offline tools do not evaluate. */
function hasOffsetBlock(focus: FocusNodePlan): boolean {
  return focus.rawPassthrough.some((entry) => entry.key === 'offset');
}

function declaredBranches(plan: FocusTreePlan): Map<string, string> | undefined {
  const declared = new Map<string, string>();
  for (const group of plan.branchGroups)
    for (const id of group.focusIds) declared.set(id, group.id);
  for (const focus of plan.focuses) {
    if (focus.branchId !== undefined && !declared.has(focus.id))
      declared.set(focus.id, focus.branchId);
  }
  return declared.size === 0 ? undefined : declared;
}

/**
 * Derives branches when none are declared. The trunk of every root runs down its single-successor
 * chain to the first fork; the fork's children are branch roots, and every focus reached from
 * exactly one branch root belongs to it. Focuses reached from several are shared.
 */
function derivedBranches(
  nodes: readonly QualityNode[],
  parents: ReadonlyMap<string, readonly string[]>,
  children: ReadonlyMap<string, readonly string[]>,
): Map<string, string> {
  const position = new Map(nodes.map((node) => [node.id, node]));
  const roots = nodes
    .filter(({ id }) => (parents.get(id)?.length ?? 0) === 0)
    .sort((left, right) => left.x - right.x || compareCodeUnits(left.id, right.id));
  const branchRoots: string[] = [];
  const trunk = new Set<string>();
  for (const root of roots) {
    let current = root.id;
    const walked = new Set<string>();
    while (!walked.has(current)) {
      walked.add(current);
      const next = children.get(current) ?? [];
      if (next.length !== 1) break;
      const only = next[0]!;
      if ((parents.get(only)?.length ?? 0) !== 1) break;
      trunk.add(current);
      current = only;
    }
    const fork = children.get(current) ?? [];
    if (fork.length >= 2) {
      trunk.add(current);
      branchRoots.push(
        ...[...fork].sort(
          (left, right) =>
            (position.get(left)?.x ?? 0) - (position.get(right)?.x ?? 0) ||
            compareCodeUnits(left, right),
        ),
      );
    } else branchRoots.push(current);
  }
  const reach = new Map<string, Set<string>>();
  for (const rootId of branchRoots) {
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    for (const id of seen) {
      const owners = reach.get(id) ?? new Set<string>();
      owners.add(rootId);
      reach.set(id, owners);
    }
  }
  const assignment = new Map<string, string>();
  for (const node of nodes) {
    const owners = reach.get(node.id);
    const owner = owners?.size === 1 && !trunk.has(node.id) ? [...owners][0]! : '';
    assignment.set(node.id, owner);
  }
  return assignment;
}

/** Builds the graph the quality metrics read from a plan and the resolved focus positions. */
export function buildQualityGraph(
  plan: Pick<FocusTreePlan, 'focuses' | 'branchGroups'>,
  positions: readonly QualityNode[],
): QualityGraph {
  const nodes = [...positions]
    .map(({ id, x, y }) => ({ id, x, y }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const position = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  const edges: QualityEdge[] = [];
  const exclusionKeys = new Set<string>();
  const exclusions: Array<readonly [string, string]> = [];
  const offsetDependent = new Set<string>();
  for (const focus of [...plan.focuses].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  )) {
    if (!position.has(focus.id)) continue;
    if (hasOffsetBlock(focus)) offsetDependent.add(focus.id);
    for (const [groupIndex, group] of focus.prerequisites.groups.entries()) {
      for (const parent of [...group.focusIds].sort(compareCodeUnits)) {
        if (!position.has(parent)) continue;
        edges.push({ parent, child: focus.id, group: groupIndex, or: group.focusIds.length > 1 });
      }
    }
    for (const other of focus.mutuallyExclusive) {
      if (!position.has(other)) continue;
      const pair: readonly [string, string] =
        compareCodeUnits(focus.id, other) < 0 ? [focus.id, other] : [other, focus.id];
      const key = pair.join('\0');
      if (exclusionKeys.has(key)) continue;
      exclusionKeys.add(key);
      exclusions.push(pair);
    }
  }
  exclusions.sort((left, right) => compareCodeUnits(left.join('\0'), right.join('\0')));
  // A focus placed relative to a shifted or unresolved focus moves with it, so the uncertainty is inherited.
  const anchors = new Map<string, string>();
  for (const focus of plan.focuses)
    if (focus.position.mode === 'relative') anchors.set(focus.id, focus.position.relativeTo);
  const uncertain = (id: string, seen = new Set<string>()): boolean => {
    if (offsetDependent.has(id)) return true;
    const anchor = anchors.get(id);
    if (anchor === undefined || seen.has(id)) return false;
    // An anchor outside this tree (a shared focus) leaves the real position unknown.
    if (!position.has(anchor)) return true;
    seen.add(id);
    return uncertain(anchor, seen);
  };
  for (const { id } of nodes) if (uncertain(id)) offsetDependent.add(id);
  const conditional = new Set<string>();
  for (const focus of plan.focuses)
    if (
      position.has(focus.id) &&
      (focus.allowBranch !== undefined || focus.visibility !== 'normal')
    )
      conditional.add(focus.id);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges)
      if (conditional.has(edge.parent) && !conditional.has(edge.child)) {
        conditional.add(edge.child);
        changed = true;
      }
  }
  const parentSets = new Map<string, Set<string>>(nodes.map(({ id }) => [id, new Set<string>()]));
  const childSets = new Map<string, Set<string>>(nodes.map(({ id }) => [id, new Set<string>()]));
  for (const edge of edges) {
    parentSets.get(edge.child)!.add(edge.parent);
    childSets.get(edge.parent)!.add(edge.child);
  }
  const parents = new Map([...parentSets].map(([id, set]) => [id, sortedUnique(set)]));
  const children = new Map([...childSets].map(([id, set]) => [id, sortedUnique(set)]));
  const declared = declaredBranches(plan as FocusTreePlan);
  const branchOf = declared ?? derivedBranches(nodes, parents, children);
  return {
    nodes,
    position,
    edges,
    parents,
    children,
    exclusions,
    offsetDependent,
    conditional,
    branchOf: new Map(nodes.map(({ id }) => [id, branchOf.get(id) ?? ''])),
    branchesDeclared: declared !== undefined,
  };
}
