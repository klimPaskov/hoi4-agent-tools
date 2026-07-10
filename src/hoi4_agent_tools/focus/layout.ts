import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { DiagnosticCollector } from '../core/diagnostic-collector.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import { focusConnectorSegmentsProperlyCross, focusNodesVisiblyOverlap } from './geometry.js';
import {
  FOCUS_GRAPH_MAX_DEPTH,
  FOCUS_DIAGNOSTIC_MAX,
  FOCUS_GRAPH_MAX_EDGES,
  FOCUS_GRAPH_MAX_NODES,
  FOCUS_LAYOUT_WORK_MAX,
} from './limits.js';
import {
  type FocusLayoutDecision,
  type FocusLayoutNode,
  type FocusLayoutOptions,
  type FocusLayoutResult,
  type FocusNodePlan,
  type FocusTreePlan,
} from './model.js';

interface LayoutContext {
  plan: FocusTreePlan;
  focuses: Map<string, FocusNodePlan>;
  previous: Map<string, FocusLayoutNode>;
  placed: Map<string, FocusLayoutNode>;
  occupied: Map<string, string>;
  mutualExclusions: Map<string, Set<string>>;
  laneBases: Map<string, number>;
  laneIds: Map<string, string>;
  nodeSpacing: number;
  minimumMutualExclusionSpacing: number;
  decisions: FocusLayoutDecision[];
  diagnostics: DiagnosticCollector;
  work: LayoutWorkBudget;
  signal?: AbortSignal;
}

class LayoutWorkBudget {
  private used = 0;

  public spend(phase: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > FOCUS_LAYOUT_WORK_MAX - this.used) {
      throw new ServiceError(
        'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED',
        'Focus layout exceeds the fixed placement and comparison work ceiling',
        { phase, used: this.used, requested: amount, maximumWork: FOCUS_LAYOUT_WORK_MAX },
      );
    }
    this.used += amount;
  }
}

type LayoutSteps<T> = Generator<void, T, void>;

function* cancellationCheckpoint(
  signal: AbortSignal | undefined,
  iteration = 0,
  stride = 1,
): LayoutSteps<void> {
  if (iteration % stride !== 0) return;
  signal?.throwIfAborted();
  yield;
}

function completeSynchronously<T>(steps: LayoutSteps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function completeCooperatively<T>(steps: LayoutSteps<T>, signal?: AbortSignal): Promise<T> {
  let yieldDeadline = performance.now() + 8;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    signal?.throwIfAborted();
    if (performance.now() < yieldDeadline) continue;
    await yieldToEventLoop();
    signal?.throwIfAborted();
    yieldDeadline = performance.now() + 8;
  }
}

interface LayoutConnector {
  parentId: string;
  childId: string;
  parent: FocusLayoutNode;
  child: FocusLayoutNode;
}

interface CandidateConflicts {
  visibleOverlaps: string[];
  mutualExclusions: string[];
}

interface CandidateCoordinate {
  x: number;
  moved: boolean;
  conflictsAtPreferred: CandidateConflicts;
  crossingsAtPreferred: number;
  crossings: number;
}

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

function laneFor(plan: FocusTreePlan, focus: FocusNodePlan): string {
  if (focus.laneId !== undefined) return focus.laneId;
  if (focus.branchId !== undefined) {
    const branch = plan.branchGroups.find(({ id }) => id === focus.branchId);
    if (branch?.laneId !== undefined) return branch.laneId;
    return focus.branchId;
  }
  return 'default';
}

function laneBases(
  plan: FocusTreePlan,
  discovered: readonly string[],
  spacing: number,
): Map<string, number> {
  const configured = [...plan.laneGroups].sort(
    (left, right) => left.order - right.order || compareCodeUnits(left.id, right.id),
  );
  const all = [
    ...configured.map(({ id }) => id),
    ...discovered.filter((id) => !configured.some((lane) => lane.id === id)),
  ];
  return new Map(
    [...new Set(all)].map((id, index) => {
      const lane = configured.find((candidate) => candidate.id === id);
      const defaultX = index * spacing;
      const bounded = Math.max(
        lane?.minimumX ?? -Infinity,
        Math.min(lane?.maximumX ?? Infinity, defaultX),
      );
      return [id, bounded];
    }),
  );
}

function prerequisiteIds(focus: FocusNodePlan): string[] {
  return focus.prerequisites.groups.flatMap(({ focusIds }) => focusIds);
}

function mutualExclusionMap(focuses: Map<string, FocusNodePlan>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const focus of focuses.values()) {
    for (const otherId of focus.mutuallyExclusive) {
      const own = result.get(focus.id) ?? new Set<string>();
      own.add(otherId);
      result.set(focus.id, own);
      const reciprocal = result.get(otherId) ?? new Set<string>();
      reciprocal.add(focus.id);
      result.set(otherId, reciprocal);
    }
  }
  return result;
}

function* connectorEdges(
  context: LayoutContext,
  candidate?: FocusLayoutNode,
): LayoutSteps<LayoutConnector[]> {
  const nodeFor = (focusId: string): FocusLayoutNode | undefined =>
    candidate?.id === focusId ? candidate : context.placed.get(focusId);
  const edges: LayoutConnector[] = [];
  let focusIndex = 0;
  for (const focus of context.focuses.values()) {
    context.work.spend('connector edge construction');
    yield* cancellationCheckpoint(context.signal, focusIndex, 32);
    focusIndex += 1;
    const child = nodeFor(focus.id);
    if (child === undefined) continue;
    for (const parentId of prerequisiteIds(focus)) {
      context.work.spend('connector edge construction');
      const parent = nodeFor(parentId);
      if (parent === undefined) continue;
      edges.push({ parentId, childId: focus.id, parent, child });
    }
  }
  return edges.sort(
    (left, right) =>
      compareCodeUnits(left.parentId, right.parentId) ||
      compareCodeUnits(left.childId, right.childId),
  );
}

function connectorsShareEndpoint(left: LayoutConnector, right: LayoutConnector): boolean {
  return (
    left.parentId === right.parentId ||
    left.parentId === right.childId ||
    left.childId === right.parentId ||
    left.childId === right.childId
  );
}

function* connectorCrossings(
  edges: readonly LayoutConnector[],
  context: LayoutContext,
): LayoutSteps<[LayoutConnector, LayoutConnector][]> {
  const crossings: [LayoutConnector, LayoutConnector][] = [];
  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    yield* cancellationCheckpoint(context.signal, leftIndex, 16);
    const left = edges[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex += 1) {
      yield* cancellationCheckpoint(context.signal, rightIndex - leftIndex, 64);
      context.work.spend('connector crossing comparison');
      const right = edges[rightIndex];
      if (right === undefined || connectorsShareEndpoint(left, right)) continue;
      if (focusConnectorSegmentsProperlyCross(left.parent, left.child, right.parent, right.child))
        if (crossings.length < FOCUS_DIAGNOSTIC_MAX - 1) crossings.push([left, right]);
    }
  }
  return crossings;
}

function* crossingCountForCandidate(
  context: LayoutContext,
  focusId: string,
  x: number,
  y: number,
): LayoutSteps<number> {
  yield* cancellationCheckpoint(context.signal);
  const focus = context.focuses.get(focusId);
  const candidate: FocusLayoutNode = {
    id: focusId,
    x,
    y,
    laneId: context.laneIds.get(focusId) ?? 'default',
    preserved: false,
    sourceMode: focus?.position.mode ?? 'auto',
  };
  const edges = yield* connectorEdges(context, candidate);
  const candidateEdges = edges.filter(
    (edge) => edge.parentId === focusId || edge.childId === focusId,
  );
  const existingEdges = edges.filter(
    (edge) => edge.parentId !== focusId && edge.childId !== focusId,
  );
  let crossings = 0;
  for (const [candidateIndex, candidateEdge] of candidateEdges.entries()) {
    yield* cancellationCheckpoint(context.signal, candidateIndex, 16);
    for (const [existingIndex, existingEdge] of existingEdges.entries()) {
      yield* cancellationCheckpoint(context.signal, existingIndex, 64);
      context.work.spend('candidate connector crossing comparison');
      if (connectorsShareEndpoint(candidateEdge, existingEdge)) continue;
      if (
        focusConnectorSegmentsProperlyCross(
          candidateEdge.parent,
          candidateEdge.child,
          existingEdge.parent,
          existingEdge.child,
        )
      )
        crossings += 1;
    }
  }
  return crossings;
}

function candidateConflicts(
  context: LayoutContext,
  focusId: string,
  x: number,
  y: number,
): CandidateConflicts {
  const candidate = { x, y };
  const visibleOverlaps: string[] = [];
  for (const placed of context.placed.values()) {
    context.work.spend('candidate overlap comparison');
    if (focusNodesVisiblyOverlap(candidate, placed)) visibleOverlaps.push(placed.id);
  }
  visibleOverlaps.sort((left, right) => compareCodeUnits(left, right));
  const mutualExclusions: string[] = [];
  for (const otherId of context.mutualExclusions.get(focusId) ?? []) {
    context.work.spend('candidate mutual-exclusion comparison');
    const other = context.placed.get(otherId);
    if (other !== undefined && Math.abs(x - other.x) < context.minimumMutualExclusionSpacing)
      mutualExclusions.push(otherId);
  }
  mutualExclusions.sort((left, right) => compareCodeUnits(left, right));
  return { visibleOverlaps, mutualExclusions };
}

function conflictsCandidate({ visibleOverlaps, mutualExclusions }: CandidateConflicts): boolean {
  return visibleOverlaps.length > 0 || mutualExclusions.length > 0;
}

function* placedPrerequisites(
  context: LayoutContext,
  focus: FocusNodePlan,
  stack: Set<string>,
): LayoutSteps<FocusLayoutNode[]> {
  const result: FocusLayoutNode[] = [];
  for (const id of prerequisiteIds(focus)) {
    if (!context.focuses.has(id)) continue;
    result.push(yield* placeFocus(context, id, stack));
  }
  return result;
}

function recordOccupied(context: LayoutContext, node: FocusLayoutNode): void {
  const key = coordinateKey(node.x, node.y);
  const existing = context.occupied.get(key);
  const focus = context.focuses.get(node.id);
  if (existing !== undefined && existing !== node.id) {
    context.diagnostics.push({
      code: 'FOCUS_LAYOUT_COORDINATE_CONFLICT',
      severity: 'error',
      category: 'layout',
      message: `Focuses ${existing} and ${node.id} occupy (${node.x}, ${node.y})`,
      ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      details: { focusIds: [existing, node.id], x: node.x, y: node.y },
    });
  } else {
    context.occupied.set(key, node.id);
  }
}

function* availableX(
  context: LayoutContext,
  focusId: string,
  preferred: number,
  y: number,
): LayoutSteps<CandidateCoordinate> {
  const conflictsAtPreferred = candidateConflicts(context, focusId, preferred, y);
  const crossingsAtPreferred = yield* crossingCountForCandidate(context, focusId, preferred, y);
  let best: { x: number; crossings: number; distance: number; directionOrder: number } | undefined;
  const optimizationSteps = Math.max(32, context.focuses.size * 2);

  for (let distance = 0; distance <= optimizationSteps; distance += 1) {
    yield* cancellationCheckpoint(context.signal, distance, 8);
    const offsets = distance === 0 ? [0] : [distance, -distance];
    for (let directionOrder = 0; directionOrder < offsets.length; directionOrder += 1) {
      const offset = offsets[directionOrder];
      if (offset === undefined) continue;
      context.work.spend('automatic placement candidate');
      const x = preferred + offset * context.nodeSpacing;
      const conflicts = candidateConflicts(context, focusId, x, y);
      if (conflictsCandidate(conflicts)) continue;
      const crossings = yield* crossingCountForCandidate(context, focusId, x, y);
      if (
        best === undefined ||
        crossings < best.crossings ||
        (crossings === best.crossings && distance < best.distance) ||
        (crossings === best.crossings &&
          distance === best.distance &&
          directionOrder < best.directionOrder)
      ) {
        best = { x, crossings, distance, directionOrder };
      }
      if (crossings === 0) {
        return {
          x,
          moved: x !== preferred,
          conflictsAtPreferred,
          crossingsAtPreferred,
          crossings,
        };
      }
    }
  }

  if (best !== undefined) {
    return {
      x: best.x,
      moved: best.x !== preferred,
      conflictsAtPreferred,
      crossingsAtPreferred,
      crossings: best.crossings,
    };
  }

  for (let distance = optimizationSteps + 1; distance < 10_000; distance += 1) {
    yield* cancellationCheckpoint(context.signal, distance, 16);
    for (const offset of [distance, -distance]) {
      context.work.spend('automatic placement fallback candidate');
      const x = preferred + offset * context.nodeSpacing;
      if (conflictsCandidate(candidateConflicts(context, focusId, x, y))) continue;
      return {
        x,
        moved: true,
        conflictsAtPreferred,
        crossingsAtPreferred,
        crossings: yield* crossingCountForCandidate(context, focusId, x, y),
      };
    }
  }
  throw new Error('Unable to find a free focus coordinate');
}

function* placeFocus(
  context: LayoutContext,
  focusId: string,
  inheritedStack = new Set<string>(),
): LayoutSteps<FocusLayoutNode> {
  yield* cancellationCheckpoint(context.signal);
  context.work.spend('focus placement');
  const existing = context.placed.get(focusId);
  if (existing !== undefined) return existing;
  const focus = context.focuses.get(focusId);
  if (focus === undefined) {
    return { id: focusId, x: 0, y: 0, laneId: 'missing', preserved: false, sourceMode: 'auto' };
  }
  if (inheritedStack.has(focusId)) {
    context.diagnostics.push({
      code: 'FOCUS_LAYOUT_DEPENDENCY_CYCLE',
      severity: 'error',
      category: 'layout',
      message: `Layout dependency cycle contains ${focusId}`,
      ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
    });
    const fallback: FocusLayoutNode = {
      id: focusId,
      x: context.laneBases.get(context.laneIds.get(focusId) ?? 'default') ?? 0,
      y: 0,
      laneId: context.laneIds.get(focusId) ?? 'default',
      preserved: false,
      sourceMode: focus.position.mode,
    };
    context.placed.set(focusId, fallback);
    recordOccupied(context, fallback);
    return fallback;
  }
  if (inheritedStack.size >= FOCUS_GRAPH_MAX_DEPTH) {
    throw new ServiceError(
      'FOCUS_LAYOUT_DEPTH_BUDGET_BLOCKED',
      'Focus layout dependency depth exceeds the fixed recursion ceiling',
      { focusId, depth: inheritedStack.size + 1, maximumDepth: FOCUS_GRAPH_MAX_DEPTH },
    );
  }
  const stack = new Set(inheritedStack).add(focusId);
  const laneId = context.laneIds.get(focusId) ?? 'default';
  let node: FocusLayoutNode;

  if (focus.position.mode === 'fixed') {
    node = {
      id: focusId,
      x: focus.position.x,
      y: focus.position.y,
      laneId,
      preserved: true,
      sourceMode: 'fixed',
    };
    context.decisions.push({
      focusId,
      kind: 'preserved',
      message: `Preserved fixed coordinate (${node.x}, ${node.y})`,
    });
  } else if (focus.position.mode === 'relative') {
    const target = context.focuses.get(focus.position.relativeTo);
    if (target === undefined) {
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_RELATIVE_TARGET_MISSING',
        severity: 'error',
        category: 'layout',
        message: `Relative position target ${focus.position.relativeTo} does not exist`,
        ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: { focusId, target: focus.position.relativeTo },
      });
      node = {
        id: focusId,
        x: focus.position.x,
        y: focus.position.y,
        laneId,
        preserved: true,
        sourceMode: 'relative',
      };
    } else {
      const anchor = yield* placeFocus(context, target.id, stack);
      node = {
        id: focusId,
        x: anchor.x + focus.position.x,
        y: anchor.y + focus.position.y,
        laneId,
        preserved: true,
        sourceMode: 'relative',
      };
    }
    context.decisions.push({
      focusId,
      kind: 'relative',
      message: `Preserved relative offset from ${focus.position.relativeTo}`,
    });
  } else {
    const parents = yield* placedPrerequisites(context, focus, stack);
    const requiredY = parents.length === 0 ? 0 : Math.max(...parents.map(({ y }) => y + 1));
    const previous = context.previous.get(focusId);
    if (previous !== undefined) {
      node = {
        id: focusId,
        x: previous.x,
        y: previous.y,
        laneId,
        preserved: true,
        sourceMode: 'auto',
      };
      context.decisions.push({
        focusId,
        kind: 'preserved',
        message: `Preserved prior automatic coordinate (${node.x}, ${node.y}); spacing and crossing optimization did not move this stable node`,
      });
    } else {
      const convergenceX =
        focus.convergence && parents.length > 1
          ? Math.floor(parents.reduce((total, parent) => total + parent.x, 0) / parents.length)
          : undefined;
      const preferredX =
        focus.position.preferredX ?? convergenceX ?? context.laneBases.get(laneId) ?? 0;
      const preferredY = Math.max(requiredY, focus.position.preferredY ?? requiredY);
      const coordinate = yield* availableX(context, focusId, preferredX, preferredY);
      node = {
        id: focusId,
        x: coordinate.x,
        y: preferredY,
        laneId,
        preserved: false,
        sourceMode: 'auto',
      };
      const explanations: string[] = [];
      if (coordinate.conflictsAtPreferred.visibleOverlaps.length > 0) {
        explanations.push(
          `visible overlap with ${coordinate.conflictsAtPreferred.visibleOverlaps.join(', ')}`,
        );
      }
      if (coordinate.conflictsAtPreferred.mutualExclusions.length > 0) {
        explanations.push(
          `mutual-exclusion spacing from ${coordinate.conflictsAtPreferred.mutualExclusions.join(', ')}`,
        );
      }
      if (coordinate.crossings < coordinate.crossingsAtPreferred) {
        explanations.push(
          `connector crossings ${coordinate.crossingsAtPreferred} -> ${coordinate.crossings}`,
        );
      }
      const movedKind: FocusLayoutDecision['kind'] =
        coordinate.conflictsAtPreferred.visibleOverlaps.length > 0
          ? 'moved_for_collision'
          : coordinate.conflictsAtPreferred.mutualExclusions.length > 0
            ? 'moved_for_mutual_exclusion'
            : 'moved_to_reduce_crossings';
      context.decisions.push({
        focusId,
        kind: coordinate.moved ? movedKind : 'placed',
        message: coordinate.moved
          ? `Moved from preferred (${preferredX}, ${preferredY}) to (${node.x}, ${node.y}) to resolve ${explanations.join(' and ')}`
          : `Placed in lane ${laneId} at (${node.x}, ${node.y}); connector crossings ${coordinate.crossings}`,
      });
    }
  }

  const cycleFallback = context.placed.get(focusId);
  if (cycleFallback !== undefined) return cycleFallback;
  context.placed.set(focusId, node);
  recordOccupied(context, node);
  return node;
}

function* visibleOverlapDiagnostics(context: LayoutContext): LayoutSteps<void> {
  const nodes = [...context.placed.values()].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    yield* cancellationCheckpoint(context.signal, leftIndex, 16);
    const left = nodes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      context.work.spend('final visible-overlap comparison');
      const right = nodes[rightIndex];
      if (right === undefined || !focusNodesVisiblyOverlap(left, right)) continue;
      const focus = context.focuses.get(right.id);
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_VISIBLE_OVERLAP',
        severity: 'error',
        category: 'layout',
        message: `Focuses ${left.id} and ${right.id} visibly overlap`,
        ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: {
          focusIds: [left.id, right.id],
          left: { x: left.x, y: left.y },
          right: { x: right.x, y: right.y },
        },
      });
    }
  }
}

function canMoveForSoftConstraint(context: LayoutContext, focusId: string): boolean {
  const focus = context.focuses.get(focusId);
  return focus?.position.mode === 'auto' && !context.previous.has(focusId);
}

function* mutualExclusionSpacingDiagnostics(context: LayoutContext): LayoutSteps<void> {
  const pairs = new Set<string>();
  let focusIndex = 0;
  for (const [focusId, excludedIds] of context.mutualExclusions) {
    context.work.spend('mutual-exclusion diagnostic construction');
    yield* cancellationCheckpoint(context.signal, focusIndex, 16);
    focusIndex += 1;
    for (const excludedId of excludedIds) {
      context.work.spend('mutual-exclusion diagnostic construction');
      if (!context.focuses.has(excludedId)) continue;
      pairs.add(
        [focusId, excludedId].sort((left, right) => compareCodeUnits(left, right)).join('\0'),
      );
    }
  }
  for (const pair of [...pairs].sort((left, right) => compareCodeUnits(left, right))) {
    const [leftId, rightId] = pair.split('\0');
    if (leftId === undefined || rightId === undefined) continue;
    const left = context.placed.get(leftId);
    const right = context.placed.get(rightId);
    if (
      left === undefined ||
      right === undefined ||
      Math.abs(left.x - right.x) >= context.minimumMutualExclusionSpacing
    )
      continue;
    const movableFocusIds = [leftId, rightId].filter((id) => canMoveForSoftConstraint(context, id));
    const preservedFocusIds = [leftId, rightId].filter(
      (id) => !canMoveForSoftConstraint(context, id),
    );
    const focus = context.focuses.get(rightId);
    const reason =
      movableFocusIds.length === 0
        ? 'both endpoints are fixed, relative, pinned, or prior-stable'
        : 'the remaining movable endpoint cannot change the authored relative relationship safely';
    context.diagnostics.push({
      code: 'FOCUS_LAYOUT_MUTUAL_EXCLUSION_SPACING_UNSATISFIED',
      severity: 'warning',
      category: 'layout',
      message: `Mutually exclusive focuses ${leftId} and ${rightId} are ${Math.abs(left.x - right.x)} columns apart; ${context.minimumMutualExclusionSpacing} are required, but ${reason}`,
      ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      details: {
        focusIds: [leftId, rightId],
        actualSpacing: Math.abs(left.x - right.x),
        requiredSpacing: context.minimumMutualExclusionSpacing,
        movableFocusIds,
        preservedFocusIds,
      },
    });
  }
}

function* connectorCrossingDiagnostics(context: LayoutContext): LayoutSteps<void> {
  yield* cancellationCheckpoint(context.signal);
  const edges = yield* connectorEdges(context);
  const crossings = yield* connectorCrossings(edges, context);
  for (const [first, second] of crossings) {
    const endpointIds = [first.parentId, first.childId, second.parentId, second.childId].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    const movableFocusIds = endpointIds.filter((id) => canMoveForSoftConstraint(context, id));
    const preservedFocusIds = endpointIds.filter((id) => !canMoveForSoftConstraint(context, id));
    const focus = context.focuses.get(second.childId);
    const reason =
      movableFocusIds.length === 0
        ? 'all connector endpoints are fixed, relative, pinned, or prior-stable'
        : 'no collision-free deterministic candidate reduced the crossing without moving preserved endpoints';
    context.diagnostics.push({
      code: 'FOCUS_LAYOUT_CONNECTOR_CROSSING_UNSATISFIED',
      severity: 'warning',
      category: 'layout',
      message: `Connectors ${first.parentId} -> ${first.childId} and ${second.parentId} -> ${second.childId} still cross because ${reason}`,
      ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      details: {
        first: [first.parentId, first.childId],
        second: [second.parentId, second.childId],
        movableFocusIds,
        preservedFocusIds,
      },
    });
  }
}

function* parentOrderDiagnostics(context: LayoutContext): LayoutSteps<void> {
  let focusIndex = 0;
  for (const focus of context.focuses.values()) {
    yield* cancellationCheckpoint(context.signal, focusIndex, 32);
    focusIndex += 1;
    const child = context.placed.get(focus.id);
    if (child === undefined) continue;
    for (const parentId of prerequisiteIds(focus)) {
      context.work.spend('parent-order comparison');
      const parent = context.placed.get(parentId);
      if (parent === undefined || parent.y < child.y) continue;
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_PARENT_NOT_ABOVE',
        severity: 'error',
        category: 'layout',
        message: `Prerequisite ${parentId} is not above ${focus.id}`,
        ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: { parentId, childId: focus.id, parentY: parent.y, childY: child.y },
      });
    }
  }
}

function* layoutFocusTreeSteps(
  plan: FocusTreePlan,
  options: FocusLayoutOptions = {},
): LayoutSteps<FocusLayoutResult> {
  yield* cancellationCheckpoint(options.signal);
  if (plan.focuses.length > FOCUS_GRAPH_MAX_NODES) {
    throw new ServiceError(
      'FOCUS_LAYOUT_NODE_BUDGET_BLOCKED',
      'Focus layout exceeds the fixed node ceiling',
      { nodes: plan.focuses.length, maximumNodes: FOCUS_GRAPH_MAX_NODES },
    );
  }
  let edgeCount = 0;
  for (const focus of plan.focuses) {
    for (const group of focus.prerequisites.groups) {
      if (group.focusIds.length > FOCUS_GRAPH_MAX_EDGES - edgeCount) {
        throw new ServiceError(
          'FOCUS_LAYOUT_EDGE_BUDGET_BLOCKED',
          'Focus layout exceeds the fixed graph edge ceiling',
          { edges: edgeCount + group.focusIds.length, maximumEdges: FOCUS_GRAPH_MAX_EDGES },
        );
      }
      edgeCount += group.focusIds.length;
    }
    const additionalEdges =
      focus.mutuallyExclusive.length + (focus.position.mode === 'relative' ? 1 : 0);
    if (additionalEdges > FOCUS_GRAPH_MAX_EDGES - edgeCount) {
      throw new ServiceError(
        'FOCUS_LAYOUT_EDGE_BUDGET_BLOCKED',
        'Focus layout exceeds the fixed graph edge ceiling',
        { edges: edgeCount + additionalEdges, maximumEdges: FOCUS_GRAPH_MAX_EDGES },
      );
    }
    edgeCount += additionalEdges;
  }
  const diagnostics = new DiagnosticCollector(FOCUS_DIAGNOSTIC_MAX, {
    code: 'FOCUS_LAYOUT_DIAGNOSTICS_TRUNCATED',
    category: 'layout',
    message: 'Focus layout diagnostics exceeded the fixed global result ceiling',
  });
  const focuses = new Map<string, FocusNodePlan>();
  for (const [focusIndex, focus] of plan.focuses.entries()) {
    yield* cancellationCheckpoint(options.signal, focusIndex, 32);
    if (focuses.has(focus.id)) {
      diagnostics.push({
        code: 'FOCUS_LAYOUT_DUPLICATE_ID',
        severity: 'error',
        category: 'layout',
        message: `Cannot lay out duplicate focus ID ${focus.id}`,
        ...(focus.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      });
      continue;
    }
    focuses.set(focus.id, focus);
  }
  const laneIds = new Map([...focuses.values()].map((focus) => [focus.id, laneFor(plan, focus)]));
  const discoveredLanes = [...new Set(laneIds.values())].sort((left, right) =>
    compareCodeUnits(left, right),
  );
  const context: LayoutContext = {
    plan,
    focuses,
    previous: new Map(options.previous?.nodes.map((node) => [node.id, node]) ?? []),
    placed: new Map(),
    occupied: new Map(),
    mutualExclusions: mutualExclusionMap(focuses),
    laneBases: laneBases(plan, discoveredLanes, options.laneSpacing ?? 8),
    laneIds,
    nodeSpacing: options.nodeSpacing ?? 2,
    minimumMutualExclusionSpacing: options.nodeSpacing ?? 2,
    decisions: [],
    diagnostics,
    work: new LayoutWorkBudget(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const ordered = [...focuses.values()].sort((left, right) => {
    const priority = (focus: FocusNodePlan): number => {
      if (focus.position.mode === 'fixed') return 0;
      if (focus.position.mode === 'relative') return 1;
      return context.previous.has(focus.id) ? 2 : 3;
    };
    return priority(left) - priority(right) || compareCodeUnits(left.id, right.id);
  });
  for (const [focusIndex, focus] of ordered.entries()) {
    yield* cancellationCheckpoint(options.signal, focusIndex, 8);
    yield* placeFocus(context, focus.id);
  }
  yield* parentOrderDiagnostics(context);
  yield* visibleOverlapDiagnostics(context);
  yield* mutualExclusionSpacingDiagnostics(context);
  yield* connectorCrossingDiagnostics(context);
  const nodes = [...context.placed.values()].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const decisions = [...context.decisions].sort((left, right) =>
    compareCodeUnits(left.focusId, right.focusId),
  );
  yield* cancellationCheckpoint(options.signal);
  return {
    treeId: plan.id,
    nodes,
    decisions,
    diagnostics: sortDiagnostics(context.diagnostics.values()),
    layoutHash: hashCanonical(nodes.map(({ id, x, y, laneId }) => ({ id, laneId, x, y }))),
  };
}

export function layoutFocusTree(
  plan: FocusTreePlan,
  options: FocusLayoutOptions = {},
): FocusLayoutResult {
  return completeSynchronously(layoutFocusTreeSteps(plan, options));
}

/** Runs the same deterministic layout while yielding so protocol cancellation can be observed. */
export async function layoutFocusTreeAsync(
  plan: FocusTreePlan,
  options: FocusLayoutOptions = {},
): Promise<FocusLayoutResult> {
  return completeCooperatively(layoutFocusTreeSteps(plan, options), options.signal);
}
