import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { DiagnosticCollector } from '../core/diagnostic-collector.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import {
  flattenFocusConnectorCurve,
  focusConnectorCurve,
  focusConnectorPolylinesIntersect,
  focusConnectorPolylineIntersectsRectangle,
  focusNodeRectangle,
  focusNodesVisiblyOverlap,
} from './geometry.js';
import {
  FOCUS_GRAPH_MAX_DEPTH,
  FOCUS_DIAGNOSTIC_MAX,
  FOCUS_GRAPH_MAX_EDGES,
  FOCUS_GRAPH_MAX_NODES,
  FOCUS_LAYOUT_WORK_MAX,
} from './limits.js';
import {
  type FocusLayoutDecision,
  type FocusLayoutBudget,
  type FocusLayoutMetrics,
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
  occupiedRows: Map<number, Map<number, string>>;
  connectorDefinitionsByFocus: Map<string, LayoutConnectorDefinition[]>;
  placedConnectors: Map<number, LayoutConnector>;
  mutualExclusions: Map<string, Set<string>>;
  laneBases: Map<string, number>;
  laneBounds: Map<string, LayoutLaneBounds>;
  laneIds: Map<string, string>;
  siblingOffsets: Map<string, number>;
  siblingCohorts: string[][];
  nodeSpacing: number;
  minimumMutualExclusionSpacing: number;
  decisions: FocusLayoutDecision[];
  diagnostics: DiagnosticCollector;
  work: FocusLayoutBudget;
  signal?: AbortSignal;
}

export class FocusLayoutWorkBudget implements FocusLayoutBudget {
  private used = 0;

  public constructor(private readonly maximumWork = FOCUS_LAYOUT_WORK_MAX) {
    if (!Number.isSafeInteger(maximumWork) || maximumWork <= 0) {
      throw new ServiceError(
        'FOCUS_LAYOUT_WORK_BUDGET_INVALID',
        'Focus layout work budget must be a positive safe integer',
        { maximumWork },
      );
    }
  }

  public get consumed(): number {
    return this.used;
  }

  public spend(phase: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.maximumWork - this.used) {
      throw new ServiceError(
        'FOCUS_LAYOUT_WORK_BUDGET_BLOCKED',
        'Focus layout exceeds the fixed placement and comparison work ceiling',
        { phase, used: this.used, requested: amount, maximumWork: this.maximumWork },
      );
    }
    this.used += amount;
  }
}

class FocusLayoutSubBudgetExhausted extends Error {}

class FocusLayoutSubBudget implements FocusLayoutBudget {
  private readonly startedAt: number;

  public constructor(
    private readonly delegate: FocusLayoutBudget,
    private readonly maximumWork: number,
  ) {
    this.startedAt = delegate.consumed;
  }

  public get consumed(): number {
    return this.delegate.consumed;
  }

  public spend(phase: string, amount = 1): void {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      this.delegate.consumed - this.startedAt + amount > this.maximumWork
    )
      throw new FocusLayoutSubBudgetExhausted();
    this.delegate.spend(`connector refinement: ${phase}`, amount);
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

interface LayoutConnectorDefinition {
  key: number;
  parentId: string;
  childId: string;
}

interface LayoutLaneBounds {
  minimumX: number;
  maximumX: number;
}

interface CandidateConflicts {
  visibleOverlaps: string[];
  focusSpacing: string[];
  mutualExclusions: string[];
}

interface CandidateCoordinate {
  x: number;
  moved: boolean;
  conflictsAtPreferred: CandidateConflicts;
  crossingsAtPreferred: number;
  crossings: number;
}

const DEFAULT_LANE_SPACING = 8;
const DEFAULT_NODE_SPACING = 2;
const LONG_CONNECTOR_HORIZONTAL_SPAN = 8;
const LONG_CONNECTOR_VERTICAL_SPAN = 4;
const LONG_CONNECTOR_MANHATTAN_SPAN = 10;

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
  const unique = [...new Set(all)];
  return new Map(
    unique.map((id, index) => {
      const lane = configured.find((candidate) => candidate.id === id);
      const defaultX = Math.round((index - (unique.length - 1) / 2) * spacing);
      const bounded = Math.max(
        lane?.minimumX ?? -Infinity,
        Math.min(lane?.maximumX ?? Infinity, defaultX),
      );
      return [id, bounded];
    }),
  );
}

function laneBounds(plan: FocusTreePlan): Map<string, LayoutLaneBounds> {
  return new Map(
    plan.laneGroups.map((lane) => {
      const minimumX = lane.minimumX ?? -Infinity;
      const maximumX = lane.maximumX ?? Infinity;
      if (minimumX > maximumX) {
        throw new ServiceError(
          'FOCUS_LAYOUT_LANE_BOUNDS_INVALID',
          'Focus lane minimumX must be less than or equal to maximumX',
          { laneId: lane.id, minimumX, maximumX },
        );
      }
      return [lane.id, { minimumX, maximumX }];
    }),
  );
}

function boundsForFocus(context: LayoutContext, focusId: string): LayoutLaneBounds {
  return (
    context.laneBounds.get(context.laneIds.get(focusId) ?? 'default') ?? {
      minimumX: -Infinity,
      maximumX: Infinity,
    }
  );
}

function coordinateWithinLane(context: LayoutContext, focusId: string, x: number): boolean {
  const bounds = boundsForFocus(context, focusId);
  return x >= bounds.minimumX && x <= bounds.maximumX;
}

function finiteLaneBoundDetails(bounds: LayoutLaneBounds): Partial<LayoutLaneBounds> {
  return {
    ...(Number.isFinite(bounds.minimumX) ? { minimumX: bounds.minimumX } : {}),
    ...(Number.isFinite(bounds.maximumX) ? { maximumX: bounds.maximumX } : {}),
  };
}

function prerequisiteIds(focus: FocusNodePlan): string[] {
  return focus.prerequisites.groups.flatMap(({ focusIds }) => focusIds);
}

function automaticSiblingLayout(
  plan: FocusTreePlan,
  focuses: Map<string, FocusNodePlan>,
  laneIds: Map<string, string>,
  spacing: number,
): { offsets: Map<string, number>; cohorts: string[][] } {
  const placementCohorts = new Map<string, string[]>();
  const metricCohorts = new Map<string, string[]>();
  const configuredLaneOrder = new Map(
    [...plan.laneGroups]
      .sort((left, right) => left.order - right.order || compareCodeUnits(left.id, right.id))
      .map((lane, index) => [lane.id, index]),
  );
  for (const focus of focuses.values()) {
    if (focus.position.mode !== 'auto') continue;
    const parents = [...prerequisiteIds(focus)].sort((left, right) =>
      compareCodeUnits(left, right),
    );
    const placementKey = JSON.stringify([
      parents.length === 0 ? (laneIds.get(focus.id) ?? 'default') : null,
      parents,
      focus.position.preferredX ?? null,
      focus.position.preferredY ?? null,
    ]);
    const metricKey = JSON.stringify([
      parents.length === 0 ? (laneIds.get(focus.id) ?? 'default') : null,
      parents,
      focus.position.preferredY ?? null,
    ]);
    const placementCohort = placementCohorts.get(placementKey) ?? [];
    placementCohort.push(focus.id);
    placementCohorts.set(placementKey, placementCohort);
    const metricCohort = metricCohorts.get(metricKey) ?? [];
    metricCohort.push(focus.id);
    metricCohorts.set(metricKey, metricCohort);
  }
  const result = new Map<string, number>();
  for (const cohort of placementCohorts.values()) {
    cohort.sort((left, right) => {
      const leftLane = laneIds.get(left) ?? 'default';
      const rightLane = laneIds.get(right) ?? 'default';
      return (
        (configuredLaneOrder.get(leftLane) ?? Number.MAX_SAFE_INTEGER) -
          (configuredLaneOrder.get(rightLane) ?? Number.MAX_SAFE_INTEGER) ||
        compareCodeUnits(leftLane, rightLane) ||
        compareCodeUnits(left, right)
      );
    });
    for (const [index, focusId] of cohort.entries()) {
      // Integer HOI4 coordinates cannot center an even cohort on an integer
      // column. Floor keeps exact mirror spacing around the adjacent half-grid.
      result.set(focusId, Math.floor(((2 * index - (cohort.length - 1)) * spacing) / 2));
    }
  }
  for (const cohort of metricCohorts.values()) {
    cohort.sort((left, right) => compareCodeUnits(left, right));
  }
  return {
    offsets: result,
    cohorts: [...metricCohorts.values()].filter((cohort) => cohort.length > 1),
  };
}

function structuralAnchorX(
  context: LayoutContext,
  focus: FocusNodePlan,
  parents: readonly FocusLayoutNode[],
  laneId: string,
): number {
  if (parents.length > 1 && focus.convergence) {
    return Math.floor(parents.reduce((total, parent) => total + parent.x, 0) / parents.length);
  }
  if (parents.length > 0) {
    const ordered = parents.map(({ x }) => x).sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
    return Math.floor(((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2);
  }
  return context.laneBases.get(laneId) ?? 0;
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

function connectorDefinitionsByFocus(
  focuses: Map<string, FocusNodePlan>,
): Map<string, LayoutConnectorDefinition[]> {
  const definitions = new Map<string, LayoutConnectorDefinition[]>();
  let key = 0;
  for (const focus of focuses.values()) {
    for (const parentId of prerequisiteIds(focus)) {
      if (!focuses.has(parentId)) continue;
      const definition = { key, parentId, childId: focus.id };
      key += 1;
      for (const focusId of new Set([parentId, focus.id])) {
        const adjacent = definitions.get(focusId) ?? [];
        adjacent.push(definition);
        definitions.set(focusId, adjacent);
      }
    }
  }
  return definitions;
}

function* connectorEdges(context: LayoutContext): LayoutSteps<LayoutConnector[]> {
  const edges: LayoutConnector[] = [];
  let edgeIndex = 0;
  for (const edge of context.placedConnectors.values()) {
    context.work.spend('connector edge snapshot');
    yield* cancellationCheckpoint(context.signal, edgeIndex, 32);
    edgeIndex += 1;
    edges.push(edge);
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

function connectorVerticalInteriorsOverlap(left: LayoutConnector, right: LayoutConnector): boolean {
  const leftMinimum = Math.min(left.parent.y, left.child.y);
  const leftMaximum = Math.max(left.parent.y, left.child.y);
  const rightMinimum = Math.min(right.parent.y, right.child.y);
  const rightMaximum = Math.max(right.parent.y, right.child.y);
  return Math.max(leftMinimum, rightMinimum) < Math.min(leftMaximum, rightMaximum);
}

function* connectorCrossings(
  edges: readonly LayoutConnector[],
  context: LayoutContext,
): LayoutSteps<{
  count: number;
  samples: [LayoutConnector, LayoutConnector][];
}> {
  const crossings: [LayoutConnector, LayoutConnector][] = [];
  const flattened = edges.map((edge) => ({
    edge,
    points: flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child)),
  }));
  let crossingCount = 0;
  for (let leftIndex = 0; leftIndex < flattened.length; leftIndex += 1) {
    yield* cancellationCheckpoint(context.signal, leftIndex, 16);
    const left = flattened[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < flattened.length; rightIndex += 1) {
      yield* cancellationCheckpoint(context.signal, rightIndex - leftIndex, 64);
      const right = edges[rightIndex];
      const rightFlattened = flattened[rightIndex];
      if (right === undefined || rightFlattened === undefined) continue;
      context.work.spend('connector pair examination');
      if (connectorsShareEndpoint(left.edge, right)) continue;
      if (!connectorVerticalInteriorsOverlap(left.edge, right)) continue;
      if (focusConnectorPolylinesIntersect(left.points, rightFlattened.points)) {
        crossingCount += 1;
        if (crossings.length < FOCUS_DIAGNOSTIC_MAX - 1) crossings.push([left.edge, right]);
      }
    }
  }
  return { count: crossingCount, samples: crossings };
}

function* crossingCountForCandidate(
  context: LayoutContext,
  focusId: string,
  x: number,
  y: number,
  stopAt = Infinity,
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
  const candidateEdges: LayoutConnector[] = [];
  for (const definition of context.connectorDefinitionsByFocus.get(focusId) ?? []) {
    context.work.spend('candidate connector edge construction');
    const parent =
      definition.parentId === focusId ? candidate : context.placed.get(definition.parentId);
    const child =
      definition.childId === focusId ? candidate : context.placed.get(definition.childId);
    if (parent !== undefined && child !== undefined) {
      candidateEdges.push({
        parentId: definition.parentId,
        childId: definition.childId,
        parent,
        child,
      });
    }
  }
  // Snapshot once so every incident candidate edge is compared. Reusing a
  // Map iterator here silently exhausted it after the first incident edge.
  const existingEdges = [...context.placedConnectors.values()];
  const flattenedCandidates = candidateEdges.map((edge) => ({
    edge,
    points: flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child)),
  }));
  const flattenedExisting = existingEdges.map((edge) => ({
    edge,
    points: flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child)),
  }));
  let crossings = 0;
  for (const [candidateIndex, candidate] of flattenedCandidates.entries()) {
    yield* cancellationCheckpoint(context.signal, candidateIndex, 16);
    let existingIndex = 0;
    for (const existing of flattenedExisting) {
      yield* cancellationCheckpoint(context.signal, existingIndex, 64);
      existingIndex += 1;
      const candidateEdge = candidate.edge;
      const existingEdge = existing.edge;
      context.work.spend('candidate connector pair examination');
      if (connectorsShareEndpoint(candidateEdge, existingEdge)) continue;
      if (!connectorVerticalInteriorsOverlap(candidateEdge, existingEdge)) continue;
      if (focusConnectorPolylinesIntersect(candidate.points, existing.points)) {
        crossings += 1;
        if (crossings >= stopAt) return crossings;
      }
    }
  }
  return crossings;
}

function horizontalSpanForCandidate(context: LayoutContext, focusId: string, x: number): number {
  let span = 0;
  for (const definition of context.connectorDefinitionsByFocus.get(focusId) ?? []) {
    const otherId = definition.parentId === focusId ? definition.childId : definition.parentId;
    const other = context.placed.get(otherId);
    if (other !== undefined) span += Math.abs(x - other.x);
  }
  return span;
}

function candidateConflicts(
  context: LayoutContext,
  focusId: string,
  x: number,
  y: number,
): CandidateConflicts {
  context.work.spend('candidate overlap lookup');
  // Focus coordinates are integers and the rendered node is smaller than one
  // grid step on both axes, so visible overlap is exactly a coordinate-key
  // collision. Use the maintained spatial index instead of rescanning every
  // placed node for every automatic candidate.
  const occupiedBy = context.occupied.get(coordinateKey(x, y));
  const visibleOverlaps = occupiedBy === undefined || occupiedBy === focusId ? [] : [occupiedBy];
  const focusSpacing: string[] = [];
  const occupiedRow = context.occupiedRows.get(y);
  if (occupiedRow !== undefined) {
    for (let offset = 1; offset < context.nodeSpacing; offset += 1) {
      context.work.spend('candidate same-row spacing lookup', 2);
      for (const candidateX of [x - offset, x + offset]) {
        const neighbor = occupiedRow.get(candidateX);
        if (neighbor !== undefined && neighbor !== focusId) focusSpacing.push(neighbor);
      }
    }
  }
  focusSpacing.sort((left, right) => compareCodeUnits(left, right));
  const mutualExclusions: string[] = [];
  for (const otherId of context.mutualExclusions.get(focusId) ?? []) {
    context.work.spend('candidate mutual-exclusion comparison');
    const other = context.placed.get(otherId);
    if (other !== undefined && Math.abs(x - other.x) < context.minimumMutualExclusionSpacing)
      mutualExclusions.push(otherId);
  }
  mutualExclusions.sort((left, right) => compareCodeUnits(left, right));
  return { visibleOverlaps, focusSpacing, mutualExclusions };
}

function conflictsCandidate({
  visibleOverlaps,
  focusSpacing,
  mutualExclusions,
}: CandidateConflicts): boolean {
  return visibleOverlaps.length > 0 || focusSpacing.length > 0 || mutualExclusions.length > 0;
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
    const occupiedRow = context.occupiedRows.get(node.y) ?? new Map<number, string>();
    occupiedRow.set(node.x, node.id);
    context.occupiedRows.set(node.y, occupiedRow);
  }
}

function recordPlaced(context: LayoutContext, node: FocusLayoutNode): void {
  context.placed.set(node.id, node);
  recordOccupied(context, node);
  for (const definition of context.connectorDefinitionsByFocus.get(node.id) ?? []) {
    context.work.spend('connector adjacency update');
    const parent = context.placed.get(definition.parentId);
    const child = context.placed.get(definition.childId);
    if (parent === undefined || child === undefined) continue;
    context.placedConnectors.set(definition.key, {
      parentId: definition.parentId,
      childId: definition.childId,
      parent,
      child,
    });
  }
}

function movePlacedFocusX(context: LayoutContext, node: FocusLayoutNode, x: number): void {
  context.occupied.delete(coordinateKey(node.x, node.y));
  const oldRow = context.occupiedRows.get(node.y);
  oldRow?.delete(node.x);
  if (oldRow?.size === 0) context.occupiedRows.delete(node.y);
  node.x = x;
  context.occupied.set(coordinateKey(node.x, node.y), node.id);
  const newRow = context.occupiedRows.get(node.y) ?? new Map<number, string>();
  newRow.set(node.x, node.id);
  context.occupiedRows.set(node.y, newRow);
}

function rebuildOccupancy(context: LayoutContext): void {
  context.occupied.clear();
  context.occupiedRows.clear();
  for (const node of context.placed.values()) {
    context.occupied.set(coordinateKey(node.x, node.y), node.id);
    const row = context.occupiedRows.get(node.y) ?? new Map<number, string>();
    row.set(node.x, node.id);
    context.occupiedRows.set(node.y, row);
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
  if (!conflictsCandidate(conflictsAtPreferred) && crossingsAtPreferred === 0) {
    return {
      x: preferred,
      moved: false,
      conflictsAtPreferred,
      crossingsAtPreferred,
      crossings: 0,
    };
  }
  let best: { x: number; crossings: number; distance: number; horizontalSpan: number } | undefined =
    conflictsCandidate(conflictsAtPreferred)
      ? undefined
      : {
          x: preferred,
          crossings: crossingsAtPreferred,
          distance: 0,
          horizontalSpan: horizontalSpanForCandidate(context, focusId, preferred),
        };
  // Crossing optimization is deliberately local to the declared lane or
  // preferred coordinate. Scaling the radius with total tree size made one
  // unavoidable crossing consume the entire global work budget on large
  // authored trees. Thirty-two spacing steps still cover a 129-column search
  // window with the default spacing while keeping every node's soft search
  // predictably bounded.
  const optimizationSteps = 32;

  for (let distance = 1; distance <= optimizationSteps; distance += 1) {
    yield* cancellationCheckpoint(context.signal, distance, 8);
    const offsets = [-distance, distance];
    for (const offset of offsets) {
      context.work.spend('automatic placement candidate');
      const x = preferred + offset * context.nodeSpacing;
      if (!coordinateWithinLane(context, focusId, x)) continue;
      const conflicts = candidateConflicts(context, focusId, x, y);
      if (conflictsCandidate(conflicts)) continue;
      const crossings = yield* crossingCountForCandidate(context, focusId, x, y, best?.crossings);
      const horizontalSpan = horizontalSpanForCandidate(context, focusId, x);
      if (
        best === undefined ||
        crossings < best.crossings ||
        (crossings === best.crossings && distance < best.distance) ||
        (crossings === best.crossings &&
          distance === best.distance &&
          horizontalSpan < best.horizontalSpan) ||
        (crossings === best.crossings &&
          distance === best.distance &&
          horizontalSpan === best.horizontalSpan &&
          Math.abs(x) < Math.abs(best.x)) ||
        (crossings === best.crossings &&
          distance === best.distance &&
          horizontalSpan === best.horizontalSpan &&
          Math.abs(x) === Math.abs(best.x) &&
          x < best.x)
      ) {
        best = { x, crossings, distance, horizontalSpan };
      }
    }
    if (best?.crossings === 0 && best.distance === distance) {
      return {
        x: best.x,
        moved: best.x !== preferred,
        conflictsAtPreferred,
        crossingsAtPreferred,
        crossings: best.crossings,
      };
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
    for (const offset of [-distance, distance]) {
      context.work.spend('automatic placement fallback candidate');
      const x = preferred + offset * context.nodeSpacing;
      if (!coordinateWithinLane(context, focusId, x)) continue;
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
  const laneId = context.laneIds.get(focusId) ?? 'default';
  const bounds = boundsForFocus(context, focusId);
  throw new ServiceError(
    'FOCUS_LAYOUT_LANE_CAPACITY_BLOCKED',
    'No collision-free coordinate is available inside the focus lane bounds',
    { focusId, laneId, ...finiteLaneBoundDetails(bounds) },
  );
}

interface GlobalLayoutQualityScore {
  crossingCount: number;
  maximumHorizontalSpan: number;
  columnCount: number;
  totalHorizontalSpan: number;
  boundingCenterOffsetTwice: number;
}

function betterGlobalLayoutQualityScore(
  candidate: GlobalLayoutQualityScore,
  current: GlobalLayoutQualityScore,
): boolean {
  return (
    candidate.crossingCount < current.crossingCount ||
    (candidate.crossingCount === current.crossingCount &&
      candidate.maximumHorizontalSpan < current.maximumHorizontalSpan) ||
    (candidate.crossingCount === current.crossingCount &&
      candidate.maximumHorizontalSpan === current.maximumHorizontalSpan &&
      candidate.columnCount < current.columnCount) ||
    (candidate.crossingCount === current.crossingCount &&
      candidate.maximumHorizontalSpan === current.maximumHorizontalSpan &&
      candidate.columnCount === current.columnCount &&
      candidate.totalHorizontalSpan < current.totalHorizontalSpan) ||
    (candidate.crossingCount === current.crossingCount &&
      candidate.maximumHorizontalSpan === current.maximumHorizontalSpan &&
      candidate.columnCount === current.columnCount &&
      candidate.totalHorizontalSpan === current.totalHorizontalSpan &&
      candidate.boundingCenterOffsetTwice < current.boundingCenterOffsetTwice)
  );
}

function candidateConnector(
  context: LayoutContext,
  definition: LayoutConnectorDefinition,
  candidates: ReadonlyMap<string, number>,
): LayoutConnector | undefined {
  const placedParent = context.placed.get(definition.parentId);
  const placedChild = context.placed.get(definition.childId);
  if (placedParent === undefined || placedChild === undefined) return undefined;
  const parentX = candidates.get(definition.parentId);
  const childX = candidates.get(definition.childId);
  return {
    parentId: definition.parentId,
    childId: definition.childId,
    parent: parentX === undefined ? placedParent : { ...placedParent, x: parentX },
    child: childX === undefined ? placedChild : { ...placedChild, x: childX },
  };
}

function* crossingCountForCandidateSet(
  context: LayoutContext,
  candidates: ReadonlyMap<string, number>,
  stopAt = Infinity,
): LayoutSteps<number> {
  const definitions = new Map<number, LayoutConnectorDefinition>();
  for (const focusId of candidates.keys()) {
    for (const definition of context.connectorDefinitionsByFocus.get(focusId) ?? []) {
      definitions.set(definition.key, definition);
    }
  }
  const candidateEdges = [...definitions]
    .sort((left, right) => left[0] - right[0])
    .flatMap(([_key, definition]) => {
      const edge = candidateConnector(context, definition, candidates);
      return edge === undefined ? [] : [edge];
    });
  const candidateIds = new Set(candidates.keys());
  const unaffectedEdges = [...context.placedConnectors.values()].filter(
    (edge) => !candidateIds.has(edge.parentId) && !candidateIds.has(edge.childId),
  );
  const flattenedCandidates = candidateEdges.map((edge) => ({
    edge,
    points: flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child)),
  }));
  const flattenedUnaffected = unaffectedEdges.map((edge) => ({
    edge,
    points: flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child)),
  }));
  let crossings = 0;
  for (const [candidateIndex, candidate] of flattenedCandidates.entries()) {
    yield* cancellationCheckpoint(context.signal, candidateIndex, 8);
    for (const unaffected of flattenedUnaffected) {
      const edge = candidate.edge;
      const unaffectedEdge = unaffected.edge;
      context.work.spend('paired candidate connector pair examination');
      if (connectorsShareEndpoint(edge, unaffectedEdge)) continue;
      if (!connectorVerticalInteriorsOverlap(edge, unaffectedEdge)) continue;
      if (!focusConnectorPolylinesIntersect(candidate.points, unaffected.points)) continue;
      crossings += 1;
      if (crossings >= stopAt) return crossings;
    }
    for (
      let otherIndex = candidateIndex + 1;
      otherIndex < flattenedCandidates.length;
      otherIndex += 1
    ) {
      const other = flattenedCandidates[otherIndex];
      context.work.spend('paired candidate internal pair examination');
      if (
        other === undefined ||
        connectorsShareEndpoint(candidate.edge, other.edge) ||
        !connectorVerticalInteriorsOverlap(candidate.edge, other.edge)
      )
        continue;
      if (!focusConnectorPolylinesIntersect(candidate.points, other.points)) continue;
      crossings += 1;
      if (crossings >= stopAt) return crossings;
    }
  }
  return crossings;
}

function candidateSetConflicts(
  context: LayoutContext,
  candidates: ReadonlyMap<string, number>,
): boolean {
  const candidateIds = new Set(candidates.keys());
  for (const [focusId, x] of candidates) {
    if (!coordinateWithinLane(context, focusId, x)) return true;
    const node = context.placed.get(focusId);
    if (node === undefined) return true;
    const row = context.occupiedRows.get(node.y);
    if (row !== undefined) {
      for (let offset = 0; offset < context.nodeSpacing; offset += 1) {
        for (const otherX of offset === 0 ? [x] : [x - offset, x + offset]) {
          const otherId = row.get(otherX);
          if (otherId !== undefined && !candidateIds.has(otherId)) return true;
        }
      }
    }
    for (const excludedId of context.mutualExclusions.get(focusId) ?? []) {
      const excludedX = candidates.get(excludedId) ?? context.placed.get(excludedId)?.x;
      if (
        excludedX !== undefined &&
        Math.abs(x - excludedX) < context.minimumMutualExclusionSpacing
      )
        return true;
    }
  }
  const entries = [...candidates];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const [leftId, leftX] = entries[leftIndex] ?? [];
    const left = leftId === undefined ? undefined : context.placed.get(leftId);
    if (leftId === undefined || leftX === undefined || left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [rightId, rightX] = entries[rightIndex] ?? [];
      const right = rightId === undefined ? undefined : context.placed.get(rightId);
      if (rightId === undefined || rightX === undefined || right === undefined) continue;
      if (left.y === right.y && Math.abs(leftX - rightX) < context.nodeSpacing) return true;
    }
  }
  return false;
}

function* repairConnectorCrossings(context: LayoutContext): LayoutSteps<void> {
  const maximumAcceptedMoves = 10;
  const maximumDistance = 24;
  const maximumPairDistance = 8;
  const maximumPairCandidates = 1_000;
  const maximumRepairWork = 500_000;
  const repairStartedAt = context.work.consumed;
  let pairCandidates = 0;
  for (let acceptedMoves = 0; acceptedMoves < maximumAcceptedMoves; acceptedMoves += 1) {
    if (context.work.consumed - repairStartedAt >= maximumRepairWork) return;
    yield* cancellationCheckpoint(context.signal, acceptedMoves);
    const edges = yield* connectorEdges(context);
    const crossingSummary = yield* connectorCrossings(edges, context);
    if (crossingSummary.count === 0) return;
    const horizontalSpans = edges.map((edge) => ({ edge, span: connectorSpans(edge).horizontal }));
    const totalHorizontalSpan = horizontalSpans.reduce((total, entry) => total + entry.span, 0);
    const maximumHorizontalSpan = horizontalSpans.reduce(
      (maximum, entry) => Math.max(maximum, entry.span),
      0,
    );
    const nodes = [...context.placed.values()];
    const minimumX = Math.min(...nodes.map(({ x }) => x));
    const maximumX = Math.max(...nodes.map(({ x }) => x));
    const currentScore: GlobalLayoutQualityScore = {
      crossingCount: crossingSummary.count,
      maximumHorizontalSpan,
      columnCount: maximumX - minimumX + 1,
      totalHorizontalSpan,
      boundingCenterOffsetTwice: Math.abs(minimumX + maximumX),
    };
    const endpointIds = [
      ...new Set(
        crossingSummary.samples.flatMap(([left, right]) => [
          left.parentId,
          left.childId,
          right.parentId,
          right.childId,
        ]),
      ),
    ].sort((left, right) => compareCodeUnits(left, right));
    let accepted = false;
    for (const [focusIndex, focusId] of endpointIds.entries()) {
      yield* cancellationCheckpoint(context.signal, focusIndex, 8);
      if (!canMoveForSoftConstraint(context, focusId)) continue;
      const node = context.placed.get(focusId);
      if (node === undefined) continue;
      const incident = horizontalSpans.filter(
        ({ edge }) => edge.parentId === focusId || edge.childId === focusId,
      );
      const nonIncident = horizontalSpans.filter(
        ({ edge }) => edge.parentId !== focusId && edge.childId !== focusId,
      );
      const currentIncidentCrossings = yield* crossingCountForCandidate(
        context,
        focusId,
        node.x,
        node.y,
      );
      const currentIncidentHorizontalSpan = incident.reduce(
        (total, entry) => total + entry.span,
        0,
      );
      const maximumNonIncidentHorizontalSpan = nonIncident.reduce(
        (maximum, entry) => Math.max(maximum, entry.span),
        0,
      );
      const otherXCoordinates = nodes.filter(({ id }) => id !== focusId).map(({ x }) => x);
      const minimumOtherX = Math.min(...otherXCoordinates);
      const maximumOtherX = Math.max(...otherXCoordinates);
      context.work.spend(
        'global crossing repair focus snapshot',
        horizontalSpans.length + nodes.length,
      );
      for (let distance = 1; distance <= maximumDistance && !accepted; distance += 1) {
        if (context.work.consumed - repairStartedAt >= maximumRepairWork) return;
        for (const x of [node.x - distance, node.x + distance]) {
          context.work.spend('global crossing repair candidate');
          if (!coordinateWithinLane(context, focusId, x)) continue;
          if (conflictsCandidate(candidateConflicts(context, focusId, x, node.y))) continue;
          const candidateIncidentCrossings = yield* crossingCountForCandidate(
            context,
            focusId,
            x,
            node.y,
            currentIncidentCrossings + 1,
          );
          if (candidateIncidentCrossings > currentIncidentCrossings) continue;
          const candidateIncidentSpans = incident.map(({ edge }) => {
            const other = edge.parentId === focusId ? edge.child : edge.parent;
            return Math.abs(x - other.x);
          });
          const candidateMinimumX = Math.min(minimumOtherX, x);
          const candidateMaximumX = Math.max(maximumOtherX, x);
          const candidateScore: GlobalLayoutQualityScore = {
            crossingCount:
              crossingSummary.count - currentIncidentCrossings + candidateIncidentCrossings,
            maximumHorizontalSpan: Math.max(
              maximumNonIncidentHorizontalSpan,
              ...candidateIncidentSpans,
            ),
            columnCount: candidateMaximumX - candidateMinimumX + 1,
            totalHorizontalSpan:
              totalHorizontalSpan -
              currentIncidentHorizontalSpan +
              candidateIncidentSpans.reduce((total, span) => total + span, 0),
            boundingCenterOffsetTwice: Math.abs(candidateMinimumX + candidateMaximumX),
          };
          if (!betterGlobalLayoutQualityScore(candidateScore, currentScore)) continue;
          context.decisions.push({
            focusId,
            kind: 'moved_to_reduce_crossings',
            message: `Global crossing repair moved (${node.x}, ${node.y}) to (${x}, ${node.y}); crossings ${currentScore.crossingCount} -> ${candidateScore.crossingCount}`,
          });
          movePlacedFocusX(context, node, x);
          accepted = true;
          break;
        }
      }
      if (accepted) break;
    }
    for (let leftIndex = 0; leftIndex < endpointIds.length && !accepted; leftIndex += 1) {
      const leftId = endpointIds[leftIndex];
      if (leftId === undefined || !canMoveForSoftConstraint(context, leftId)) continue;
      const leftNode = context.placed.get(leftId);
      if (leftNode === undefined) continue;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < endpointIds.length && !accepted;
        rightIndex += 1
      ) {
        const rightId = endpointIds[rightIndex];
        if (rightId === undefined || !canMoveForSoftConstraint(context, rightId)) continue;
        const rightNode = context.placed.get(rightId);
        if (rightNode === undefined) continue;
        const focusIds = new Set([leftId, rightId]);
        const incidentEdges = edges.filter(
          (edge) => focusIds.has(edge.parentId) || focusIds.has(edge.childId),
        );
        const nonIncidentEdges = edges.filter(
          (edge) => !focusIds.has(edge.parentId) && !focusIds.has(edge.childId),
        );
        const currentCandidates = new Map([
          [leftId, leftNode.x],
          [rightId, rightNode.x],
        ]);
        const currentAffectedCrossings = yield* crossingCountForCandidateSet(
          context,
          currentCandidates,
        );
        const currentIncidentHorizontalSpan = incidentEdges.reduce(
          (total, edge) => total + connectorSpans(edge).horizontal,
          0,
        );
        const maximumNonIncidentHorizontalSpan = nonIncidentEdges.reduce(
          (maximum, edge) => Math.max(maximum, connectorSpans(edge).horizontal),
          0,
        );
        const otherXCoordinates = nodes.filter(({ id }) => !focusIds.has(id)).map(({ x }) => x);
        const minimumOtherX = Math.min(...otherXCoordinates);
        const maximumOtherX = Math.max(...otherXCoordinates);
        for (
          let leftDistance = 1;
          leftDistance <= maximumPairDistance && !accepted;
          leftDistance += 1
        ) {
          for (const leftX of [leftNode.x - leftDistance, leftNode.x + leftDistance]) {
            for (
              let rightDistance = 1;
              rightDistance <= maximumPairDistance && !accepted;
              rightDistance += 1
            ) {
              for (const rightX of [rightNode.x - rightDistance, rightNode.x + rightDistance]) {
                if (context.work.consumed - repairStartedAt >= maximumRepairWork) return;
                pairCandidates += 1;
                yield* cancellationCheckpoint(context.signal, pairCandidates, 128);
                context.work.spend('paired global crossing repair candidate');
                if (pairCandidates > maximumPairCandidates) return;
                const candidates = new Map([
                  [leftId, leftX],
                  [rightId, rightX],
                ]);
                if (candidateSetConflicts(context, candidates)) continue;
                const candidateAffectedCrossings = yield* crossingCountForCandidateSet(
                  context,
                  candidates,
                  currentAffectedCrossings + 1,
                );
                if (candidateAffectedCrossings > currentAffectedCrossings) continue;
                const candidateIncidentSpans = incidentEdges.map((edge) =>
                  Math.abs(
                    (candidates.get(edge.parentId) ?? edge.parent.x) -
                      (candidates.get(edge.childId) ?? edge.child.x),
                  ),
                );
                const candidateMinimumX = Math.min(minimumOtherX, leftX, rightX);
                const candidateMaximumX = Math.max(maximumOtherX, leftX, rightX);
                const candidateScore: GlobalLayoutQualityScore = {
                  crossingCount:
                    crossingSummary.count - currentAffectedCrossings + candidateAffectedCrossings,
                  maximumHorizontalSpan: Math.max(
                    maximumNonIncidentHorizontalSpan,
                    ...candidateIncidentSpans,
                  ),
                  columnCount: candidateMaximumX - candidateMinimumX + 1,
                  totalHorizontalSpan:
                    totalHorizontalSpan -
                    currentIncidentHorizontalSpan +
                    candidateIncidentSpans.reduce((total, span) => total + span, 0),
                  boundingCenterOffsetTwice: Math.abs(candidateMinimumX + candidateMaximumX),
                };
                if (!betterGlobalLayoutQualityScore(candidateScore, currentScore)) continue;
                context.decisions.push(
                  {
                    focusId: leftId,
                    kind: 'moved_to_reduce_crossings',
                    message: `Paired crossing repair moved (${leftNode.x}, ${leftNode.y}) to (${leftX}, ${leftNode.y}); crossings ${currentScore.crossingCount} -> ${candidateScore.crossingCount}`,
                  },
                  {
                    focusId: rightId,
                    kind: 'moved_to_reduce_crossings',
                    message: `Paired crossing repair moved (${rightNode.x}, ${rightNode.y}) to (${rightX}, ${rightNode.y}); crossings ${currentScore.crossingCount} -> ${candidateScore.crossingCount}`,
                  },
                );
                leftNode.x = leftX;
                rightNode.x = rightX;
                rebuildOccupancy(context);
                accepted = true;
                break;
              }
            }
          }
        }
      }
    }
    if (!accepted) return;
  }
}

function centerFullyAutomaticLayout(context: LayoutContext): void {
  if (
    context.previous.size > 0 ||
    [...context.focuses.values()].some(({ position }) => position.mode !== 'auto') ||
    [...context.laneBounds.values()].some(
      ({ minimumX, maximumX }) => Number.isFinite(minimumX) || Number.isFinite(maximumX),
    )
  )
    return;
  const nodes = [...context.placed.values()];
  if (nodes.length === 0) return;
  const minimumX = Math.min(...nodes.map(({ x }) => x));
  const maximumX = Math.max(...nodes.map(({ x }) => x));
  const shift = Math.round(-(minimumX + maximumX) / 2);
  if (shift === 0) return;
  for (const node of nodes) node.x += shift;
  for (const [laneId, base] of context.laneBases) context.laneBases.set(laneId, base + shift);
  rebuildOccupancy(context);
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
    recordPlaced(context, fallback);
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
        message: `Preserved prior automatic coordinate (${node.x}, ${node.y})`,
      });
      recordPlaced(context, node);
      return node;
    }
    const structuralX =
      structuralAnchorX(context, focus, parents, laneId) +
      (focus.position.preferredX === undefined ? (context.siblingOffsets.get(focusId) ?? 0) : 0);
    const requestedPreferredX = focus.position.preferredX ?? structuralX;
    const requestedPreferredY = focus.position.preferredY ?? requiredY;
    const bounds = boundsForFocus(context, focusId);
    const preferredX = Math.max(bounds.minimumX, Math.min(bounds.maximumX, requestedPreferredX));
    const preferredY = Math.max(requiredY, requestedPreferredY);
    const coordinate = yield* availableX(context, focusId, preferredX, preferredY);
    const moved = coordinate.x !== requestedPreferredX || preferredY !== requestedPreferredY;
    node = {
      id: focusId,
      x: coordinate.x,
      y: preferredY,
      laneId,
      preserved: false,
      sourceMode: 'auto',
    };
    const explanations: string[] = [];
    if (preferredX !== requestedPreferredX) {
      explanations.push(`lane ${laneId} bounds clamped x ${requestedPreferredX} -> ${preferredX}`);
    }
    if (preferredY !== requestedPreferredY) {
      explanations.push(`parent ordering raised y ${requestedPreferredY} -> ${preferredY}`);
    }
    if (coordinate.conflictsAtPreferred.visibleOverlaps.length > 0) {
      explanations.push(
        `visible overlap with ${coordinate.conflictsAtPreferred.visibleOverlaps.join(', ')}`,
      );
    }
    if (coordinate.conflictsAtPreferred.focusSpacing.length > 0) {
      explanations.push(
        `same-row spacing from ${coordinate.conflictsAtPreferred.focusSpacing.join(', ')}`,
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
        : coordinate.conflictsAtPreferred.focusSpacing.length > 0
          ? 'moved_for_spacing'
          : coordinate.conflictsAtPreferred.mutualExclusions.length > 0
            ? 'moved_for_mutual_exclusion'
            : preferredY !== requestedPreferredY
              ? 'moved_for_parent_order'
              : preferredX !== requestedPreferredX
                ? 'moved_for_lane_bounds'
                : 'moved_to_reduce_crossings';
    context.decisions.push({
      focusId,
      kind: moved ? movedKind : 'placed',
      message: moved
        ? `Moved from preferred (${requestedPreferredX}, ${requestedPreferredY}) to (${node.x}, ${node.y}) to resolve ${explanations.join(' and ')}`
        : `Placed in lane ${laneId} at (${node.x}, ${node.y}); connector crossings ${coordinate.crossings}`,
    });
  }

  const cycleFallback = context.placed.get(focusId);
  if (cycleFallback !== undefined) return cycleFallback;
  recordPlaced(context, node);
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

function* sameRowSpacingDiagnostics(context: LayoutContext): LayoutSteps<{
  sameRowPairCount: number;
  tooCloseSameRowPairCount: number;
  minimumSameRowSpacing: number;
}> {
  const rows = new Map<number, FocusLayoutNode[]>();
  for (const node of context.placed.values()) {
    const row = rows.get(node.y) ?? [];
    row.push(node);
    rows.set(node.y, row);
  }
  let sameRowPairCount = 0;
  let tooCloseSameRowPairCount = 0;
  let minimumSameRowSpacing = Infinity;
  let rowIndex = 0;
  for (const [y, row] of [...rows].sort((left, right) => left[0] - right[0])) {
    yield* cancellationCheckpoint(context.signal, rowIndex, 16);
    rowIndex += 1;
    row.sort((left, right) => left.x - right.x || compareCodeUnits(left.id, right.id));
    for (let index = 1; index < row.length; index += 1) {
      context.work.spend('same-row spacing diagnostic');
      const left = row[index - 1];
      const right = row[index];
      if (left === undefined || right === undefined) continue;
      const spacing = right.x - left.x;
      sameRowPairCount += 1;
      minimumSameRowSpacing = Math.min(minimumSameRowSpacing, spacing);
      if (spacing >= context.nodeSpacing) continue;
      tooCloseSameRowPairCount += 1;
      const focus = context.focuses.get(right.id);
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_SAME_ROW_SPACING_UNSATISFIED',
        severity: 'warning',
        category: 'layout',
        message: `Focuses ${left.id} and ${right.id} are ${spacing} columns apart on row ${y}; ${context.nodeSpacing} are required`,
        ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: {
          focusIds: [left.id, right.id],
          y,
          actualSpacing: spacing,
          requiredSpacing: context.nodeSpacing,
          movableFocusIds: [left.id, right.id].filter((id) =>
            canMoveForSoftConstraint(context, id),
          ),
        },
      });
    }
  }
  return {
    sameRowPairCount,
    tooCloseSameRowPairCount,
    minimumSameRowSpacing: Number.isFinite(minimumSameRowSpacing) ? minimumSameRowSpacing : 0,
  };
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
        ? 'both endpoints are fixed or relative'
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

function* connectorNodeIntersectionDiagnostics(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
): LayoutSteps<number> {
  const nodes = [...context.placed.values()].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  let comparisonIndex = 0;
  let intersectionCount = 0;
  for (const edge of edges) {
    const flattened = flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child));
    for (const node of nodes) {
      yield* cancellationCheckpoint(context.signal, comparisonIndex, 32);
      comparisonIndex += 1;
      if (node.id === edge.parentId || node.id === edge.childId) continue;
      context.work.spend('connector-node intersection comparison');
      if (!focusConnectorPolylineIntersectsRectangle(flattened, focusNodeRectangle(node))) continue;
      intersectionCount += 1;
      const focus = context.focuses.get(node.id);
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_CONNECTOR_THROUGH_NODE',
        severity: 'warning',
        category: 'layout',
        message: `Connector ${edge.parentId} -> ${edge.childId} intersects unrelated focus ${node.id}`,
        ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: {
          parentId: edge.parentId,
          childId: edge.childId,
          focusId: node.id,
        },
      });
    }
  }
  return intersectionCount;
}

function* connectorCrossingDiagnostics(
  context: LayoutContext,
  crossings: readonly [LayoutConnector, LayoutConnector][],
): LayoutSteps<void> {
  yield* cancellationCheckpoint(context.signal);
  for (const [first, second] of crossings) {
    const endpointIds = [first.parentId, first.childId, second.parentId, second.childId].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    const movableFocusIds = endpointIds.filter((id) => canMoveForSoftConstraint(context, id));
    const preservedFocusIds = endpointIds.filter((id) => !canMoveForSoftConstraint(context, id));
    const focus = context.focuses.get(second.childId);
    const reason =
      movableFocusIds.length === 0
        ? 'all connector endpoints are fixed or relative'
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

function connectorSpans(edge: LayoutConnector): {
  horizontal: number;
  vertical: number;
  manhattan: number;
} {
  const horizontal = Math.abs(edge.parent.x - edge.child.x);
  const vertical = Math.abs(edge.parent.y - edge.child.y);
  return { horizontal, vertical, manhattan: horizontal + vertical };
}

function longConnectorSpans(spans: {
  horizontal: number;
  vertical: number;
  manhattan: number;
}): boolean {
  return (
    spans.horizontal > LONG_CONNECTOR_HORIZONTAL_SPAN ||
    spans.vertical > LONG_CONNECTOR_VERTICAL_SPAN ||
    spans.manhattan > LONG_CONNECTOR_MANHATTAN_SPAN
  );
}

function longConnector(edge: LayoutConnector): boolean {
  return longConnectorSpans(connectorSpans(edge));
}

interface ConnectorQualityScore {
  crossingCount: number;
  nodeIntersectionCount: number;
  asymmetricSiblingCohortCount: number;
  maximumSiblingDeviation: number;
  totalSiblingDeviation: number;
  offAnchorSiblingCohortCount: number;
  maximumSiblingAnchorDeviation: number;
  totalSiblingAnchorDeviation: number;
  longConnectorCount: number;
  maximumManhattanSpan: number;
  maximumHorizontalSpan: number;
  totalManhattanSpan: number;
  totalHorizontalSpan: number;
  columnCount: number;
  boundingCenterOffsetTwice: number;
}

function betterConnectorQualityScore(
  candidate: ConnectorQualityScore,
  current: ConnectorQualityScore,
): boolean {
  if (candidate.longConnectorCount > current.longConnectorCount) return false;
  const fields: readonly (keyof ConnectorQualityScore)[] = [
    'crossingCount',
    'nodeIntersectionCount',
    'maximumManhattanSpan',
    'maximumHorizontalSpan',
    'longConnectorCount',
    'totalManhattanSpan',
    'totalHorizontalSpan',
    'asymmetricSiblingCohortCount',
    'maximumSiblingDeviation',
    'totalSiblingDeviation',
    'offAnchorSiblingCohortCount',
    'maximumSiblingAnchorDeviation',
    'totalSiblingAnchorDeviation',
    'columnCount',
    'boundingCenterOffsetTwice',
  ];
  for (const field of fields) {
    if (candidate[field] === current[field]) continue;
    return candidate[field] < current[field];
  }
  return false;
}

function candidateNode(
  context: LayoutContext,
  focusId: string,
  x: number,
): FocusLayoutNode | undefined {
  const current = context.placed.get(focusId);
  return current === undefined ? undefined : { ...current, x };
}

function* affectedNodeIntersectionCount(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
  focusId: string,
  x: number,
): LayoutSteps<number> {
  const moved = candidateNode(context, focusId, x);
  if (moved === undefined) return 0;
  const nodes = [...context.placed.values()];
  let count = 0;
  let comparisonIndex = 0;
  for (const definition of context.connectorDefinitionsByFocus.get(focusId) ?? []) {
    const edge = candidateConnector(context, definition, new Map([[focusId, x]]));
    if (edge === undefined) continue;
    const flattened = flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child));
    for (const node of nodes) {
      yield* cancellationCheckpoint(context.signal, comparisonIndex, 64);
      comparisonIndex += 1;
      if (node.id === edge.parentId || node.id === edge.childId) continue;
      context.work.spend('quality candidate connector-node comparison');
      if (focusConnectorPolylineIntersectsRectangle(flattened, focusNodeRectangle(node)))
        count += 1;
    }
  }
  const rectangle = focusNodeRectangle(moved);
  for (const edge of edges) {
    if (edge.parentId === focusId || edge.childId === focusId) continue;
    yield* cancellationCheckpoint(context.signal, comparisonIndex, 64);
    comparisonIndex += 1;
    context.work.spend('quality candidate node-connector comparison');
    const flattened = flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child));
    if (focusConnectorPolylineIntersectsRectangle(flattened, rectangle)) count += 1;
  }
  return count;
}

function* connectorNodeIntersectionSummary(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
): LayoutSteps<{ count: number; involvedFocusIds: Set<string> }> {
  const nodes = [...context.placed.values()].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const involvedFocusIds = new Set<string>();
  let count = 0;
  let comparisonIndex = 0;
  for (const edge of edges) {
    const flattened = flattenFocusConnectorCurve(focusConnectorCurve(edge.parent, edge.child));
    for (const node of nodes) {
      yield* cancellationCheckpoint(context.signal, comparisonIndex, 64);
      comparisonIndex += 1;
      if (node.id === edge.parentId || node.id === edge.childId) continue;
      context.work.spend('quality connector-node comparison');
      if (!focusConnectorPolylineIntersectsRectangle(flattened, focusNodeRectangle(node))) continue;
      count += 1;
      involvedFocusIds.add(edge.parentId);
      involvedFocusIds.add(edge.childId);
      involvedFocusIds.add(node.id);
    }
  }
  return { count, involvedFocusIds };
}

function siblingQuality(
  context: LayoutContext,
  override?: ReadonlyMap<string, number>,
): {
  asymmetricSiblingCohortCount: number;
  maximumSiblingDeviation: number;
  totalSiblingDeviation: number;
  offAnchorSiblingCohortCount: number;
  maximumSiblingAnchorDeviation: number;
  totalSiblingAnchorDeviation: number;
  parentFocusIds: Set<string>;
} {
  let asymmetricSiblingCohortCount = 0;
  let maximumSiblingDeviation = 0;
  let totalSiblingDeviation = 0;
  let offAnchorSiblingCohortCount = 0;
  let maximumSiblingAnchorDeviation = 0;
  let totalSiblingAnchorDeviation = 0;
  const parentFocusIds = new Set<string>();
  for (const cohort of context.siblingCohorts) {
    const focus = context.focuses.get(cohort[0] ?? '');
    if (focus === undefined) continue;
    const coordinates = cohort
      .flatMap((focusId) => {
        const node = context.placed.get(focusId);
        return node === undefined ? [] : [override?.get(focusId) ?? node.x];
      })
      .sort((left, right) => left - right);
    const parentIds = prerequisiteIds(focus);
    for (const parentId of parentIds) parentFocusIds.add(parentId);
    const parentCoordinates = parentIds
      .flatMap((parentId) => {
        const node = context.placed.get(parentId);
        if (node === undefined) return [];
        return [override?.get(parentId) ?? node.x];
      })
      .sort((left, right) => left - right);
    let anchorX: number;
    if (
      coordinates.length >= 4 &&
      (coordinates.at(-1) ?? 0) - (coordinates[0] ?? 0) > 2 * LONG_CONNECTOR_HORIZONTAL_SPAN
    ) {
      anchorX = ((coordinates[0] ?? 0) + (coordinates.at(-1) ?? 0)) / 2;
    } else if (parentCoordinates.length > 1 && focus.convergence) {
      anchorX = Math.floor(
        parentCoordinates.reduce((total, coordinate) => total + coordinate, 0) /
          parentCoordinates.length,
      );
    } else if (parentCoordinates.length > 0) {
      const middle = Math.floor(parentCoordinates.length / 2);
      anchorX =
        parentCoordinates.length % 2 === 1
          ? (parentCoordinates[middle] ?? 0)
          : Math.floor(
              ((parentCoordinates[middle - 1] ?? 0) + (parentCoordinates[middle] ?? 0)) / 2,
            );
    } else {
      anchorX = context.laneBases.get(context.laneIds.get(focus.id) ?? 'default') ?? 0;
    }
    const internalCenterTwice = (coordinates[0] ?? 0) + (coordinates.at(-1) ?? 0);
    let internalDeviation = 0;
    let anchorDeviation = 0;
    for (let index = 0; index <= Math.floor((coordinates.length - 1) / 2); index += 1) {
      const pairSum =
        (coordinates[index] ?? 0) + (coordinates[coordinates.length - 1 - index] ?? 0);
      internalDeviation += Math.abs(pairSum - internalCenterTwice);
      anchorDeviation += Math.abs(pairSum - 2 * anchorX);
    }
    totalSiblingDeviation += internalDeviation;
    maximumSiblingDeviation = Math.max(maximumSiblingDeviation, internalDeviation);
    if (internalDeviation > 0) asymmetricSiblingCohortCount += 1;
    totalSiblingAnchorDeviation += anchorDeviation;
    maximumSiblingAnchorDeviation = Math.max(maximumSiblingAnchorDeviation, anchorDeviation);
    if (anchorDeviation > 0) offAnchorSiblingCohortCount += 1;
  }
  return {
    asymmetricSiblingCohortCount,
    maximumSiblingDeviation,
    totalSiblingDeviation,
    offAnchorSiblingCohortCount,
    maximumSiblingAnchorDeviation,
    totalSiblingAnchorDeviation,
    parentFocusIds,
  };
}

function connectorQualityScore(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
  crossingCount: number,
  nodeIntersectionCount: number,
  symmetry: ReturnType<typeof siblingQuality>,
): ConnectorQualityScore {
  const spans = edges.map(connectorSpans);
  const nodes = [...context.placed.values()];
  const minimumX = Math.min(...nodes.map(({ x }) => x));
  const maximumX = Math.max(...nodes.map(({ x }) => x));
  return {
    crossingCount,
    nodeIntersectionCount,
    asymmetricSiblingCohortCount: symmetry.asymmetricSiblingCohortCount,
    maximumSiblingDeviation: symmetry.maximumSiblingDeviation,
    totalSiblingDeviation: symmetry.totalSiblingDeviation,
    offAnchorSiblingCohortCount: symmetry.offAnchorSiblingCohortCount,
    maximumSiblingAnchorDeviation: symmetry.maximumSiblingAnchorDeviation,
    totalSiblingAnchorDeviation: symmetry.totalSiblingAnchorDeviation,
    longConnectorCount: edges.filter(longConnector).length,
    maximumManhattanSpan: spans.reduce((maximum, { manhattan }) => Math.max(maximum, manhattan), 0),
    maximumHorizontalSpan: spans.reduce(
      (maximum, { horizontal }) => Math.max(maximum, horizontal),
      0,
    ),
    totalManhattanSpan: spans.reduce((total, { manhattan }) => total + manhattan, 0),
    totalHorizontalSpan: spans.reduce((total, { horizontal }) => total + horizontal, 0),
    columnCount: maximumX - minimumX + 1,
    boundingCenterOffsetTwice: Math.abs(minimumX + maximumX),
  };
}

function candidateQualityScore(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
  current: ConnectorQualityScore,
  focusId: string,
  x: number,
  currentAffectedCrossings: number,
  candidateAffectedCrossings: number,
  currentAffectedNodeIntersections: number,
  candidateAffectedNodeIntersections: number,
): ConnectorQualityScore {
  const incidentEdges = edges.filter(
    (edge) => edge.parentId === focusId || edge.childId === focusId,
  );
  const nonIncidentEdges = edges.filter(
    (edge) => edge.parentId !== focusId && edge.childId !== focusId,
  );
  const candidateIncidentEdges = incidentEdges.map((edge) => ({
    ...edge,
    parent: edge.parentId === focusId ? { ...edge.parent, x } : edge.parent,
    child: edge.childId === focusId ? { ...edge.child, x } : edge.child,
  }));
  const currentIncidentSpans = incidentEdges.map(connectorSpans);
  const candidateIncidentSpans = candidateIncidentEdges.map(connectorSpans);
  const nonIncidentSpans = nonIncidentEdges.map(connectorSpans);
  const otherXCoordinates = [...context.placed.values()]
    .filter(({ id }) => id !== focusId)
    .map(({ x: coordinate }) => coordinate);
  const minimumX = Math.min(x, ...otherXCoordinates);
  const maximumX = Math.max(x, ...otherXCoordinates);
  const symmetry = siblingQuality(context, new Map([[focusId, x]]));
  const currentLong = currentIncidentSpans.filter(longConnectorSpans).length;
  const candidateLong = candidateIncidentEdges.filter(longConnector).length;
  const totalHorizontal = (values: readonly { horizontal: number }[]): number =>
    values.reduce((total, { horizontal }) => total + horizontal, 0);
  const totalManhattan = (values: readonly { manhattan: number }[]): number =>
    values.reduce((total, { manhattan }) => total + manhattan, 0);
  return {
    crossingCount: current.crossingCount - currentAffectedCrossings + candidateAffectedCrossings,
    nodeIntersectionCount:
      current.nodeIntersectionCount -
      currentAffectedNodeIntersections +
      candidateAffectedNodeIntersections,
    asymmetricSiblingCohortCount: symmetry.asymmetricSiblingCohortCount,
    maximumSiblingDeviation: symmetry.maximumSiblingDeviation,
    totalSiblingDeviation: symmetry.totalSiblingDeviation,
    offAnchorSiblingCohortCount: symmetry.offAnchorSiblingCohortCount,
    maximumSiblingAnchorDeviation: symmetry.maximumSiblingAnchorDeviation,
    totalSiblingAnchorDeviation: symmetry.totalSiblingAnchorDeviation,
    longConnectorCount: current.longConnectorCount - currentLong + candidateLong,
    maximumManhattanSpan: Math.max(
      0,
      ...nonIncidentSpans.map(({ manhattan }) => manhattan),
      ...candidateIncidentSpans.map(({ manhattan }) => manhattan),
    ),
    maximumHorizontalSpan: Math.max(
      0,
      ...nonIncidentSpans.map(({ horizontal }) => horizontal),
      ...candidateIncidentSpans.map(({ horizontal }) => horizontal),
    ),
    totalManhattanSpan:
      current.totalManhattanSpan -
      totalManhattan(currentIncidentSpans) +
      totalManhattan(candidateIncidentSpans),
    totalHorizontalSpan:
      current.totalHorizontalSpan -
      totalHorizontal(currentIncidentSpans) +
      totalHorizontal(candidateIncidentSpans),
    columnCount: maximumX - minimumX + 1,
    boundingCenterOffsetTwice: Math.abs(minimumX + maximumX),
  };
}

const CONNECTOR_REFINEMENT_WORK_MAX = 7_000_000;

function* refineConnectorQualityWithinBudget(context: LayoutContext): LayoutSteps<void> {
  const maximumAcceptedMoves = 24;
  const maximumCandidateNodes = 32;
  const edges = yield* connectorEdges(context);
  const crossingSummary = yield* connectorCrossings(edges, context);
  const intersectionSummary = yield* connectorNodeIntersectionSummary(context, edges);
  const symmetry = siblingQuality(context);
  let current = connectorQualityScore(
    context,
    edges,
    crossingSummary.count,
    intersectionSummary.count,
    symmetry,
  );
  const siblingMembers = new Set(context.siblingCohorts.flat());
  const candidateIds = new Set<string>(intersectionSummary.involvedFocusIds);
  for (const edge of edges.filter(longConnector)) {
    candidateIds.add(edge.parentId);
    candidateIds.add(edge.childId);
  }
  for (const parentId of symmetry.parentFocusIds) candidateIds.add(parentId);
  const orderedCandidateIds = [...candidateIds]
    .filter((focusId) => {
      const degree = context.connectorDefinitionsByFocus.get(focusId)?.length ?? 0;
      return (
        canMoveForSoftConstraint(context, focusId) && !siblingMembers.has(focusId) && degree !== 1
      );
    })
    .sort((left, right) => {
      const degree = (focusId: string): number =>
        context.connectorDefinitionsByFocus.get(focusId)?.length ?? 0;
      return degree(right) - degree(left) || compareCodeUnits(left, right);
    })
    .slice(0, maximumCandidateNodes);

  for (let acceptedMoves = 0; acceptedMoves < maximumAcceptedMoves; acceptedMoves += 1) {
    let best:
      { focusId: string; x: number; score: ConnectorQualityScore; message: string } | undefined;
    for (const [focusIndex, focusId] of orderedCandidateIds.entries()) {
      yield* cancellationCheckpoint(context.signal, focusIndex, 8);
      const node = context.placed.get(focusId);
      if (node === undefined) continue;
      const adjacent = (context.connectorDefinitionsByFocus.get(focusId) ?? []).flatMap(
        (definition) => {
          const otherId =
            definition.parentId === focusId ? definition.childId : definition.parentId;
          const other = context.placed.get(otherId);
          return other === undefined ? [] : [other.x];
        },
      );
      const targets = new Set<number>();
      for (let distance = 1; distance <= 4; distance += 1) {
        targets.add(node.x - distance);
        targets.add(node.x + distance);
      }
      if (adjacent.length > 0) {
        const midpoint = Math.round((Math.min(...adjacent) + Math.max(...adjacent)) / 2);
        for (let offset = -2; offset <= 2; offset += 1) targets.add(midpoint + offset);
      }
      const currentAffectedCrossings = yield* crossingCountForCandidate(
        context,
        focusId,
        node.x,
        node.y,
      );
      const currentAffectedNodeIntersections = yield* affectedNodeIntersectionCount(
        context,
        edges,
        focusId,
        node.x,
      );
      for (const x of [...targets].sort((left, right) => left - right)) {
        if (x === node.x || !coordinateWithinLane(context, focusId, x)) continue;
        if (conflictsCandidate(candidateConflicts(context, focusId, x, node.y))) continue;
        const candidateAffectedCrossings = yield* crossingCountForCandidate(
          context,
          focusId,
          x,
          node.y,
          currentAffectedCrossings + 1,
        );
        if (candidateAffectedCrossings > currentAffectedCrossings) continue;
        const candidateAffectedNodeIntersections = yield* affectedNodeIntersectionCount(
          context,
          edges,
          focusId,
          x,
        );
        const score = candidateQualityScore(
          context,
          edges,
          current,
          focusId,
          x,
          currentAffectedCrossings,
          candidateAffectedCrossings,
          currentAffectedNodeIntersections,
          candidateAffectedNodeIntersections,
        );
        if (!betterConnectorQualityScore(score, current)) continue;
        if (best !== undefined && !betterConnectorQualityScore(score, best.score)) continue;
        best = {
          focusId,
          x,
          score,
          message: `Connector-quality refinement moved (${node.x}, ${node.y}) to (${x}, ${node.y})`,
        };
      }
    }
    if (best === undefined) return;
    const node = context.placed.get(best.focusId);
    if (node === undefined) return;
    context.decisions.push({
      focusId: best.focusId,
      kind: 'moved_to_improve_connector_quality',
      message: best.message,
    });
    movePlacedFocusX(context, node, best.x);
    current = best.score;
  }
}

function* refineConnectorQuality(context: LayoutContext): LayoutSteps<void> {
  const operationBudget = context.work;
  context.work = new FocusLayoutSubBudget(operationBudget, CONNECTOR_REFINEMENT_WORK_MAX);
  try {
    yield* refineConnectorQualityWithinBudget(context);
  } catch (error) {
    if (!(error instanceof FocusLayoutSubBudgetExhausted)) throw error;
  } finally {
    context.work = operationBudget;
  }
}

function* connectorLengthDiagnostics(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
): LayoutSteps<void> {
  for (const [edgeIndex, edge] of edges.entries()) {
    yield* cancellationCheckpoint(context.signal, edgeIndex, 32);
    context.work.spend('connector length diagnostic');
    if (!longConnector(edge)) continue;
    const spans = connectorSpans(edge);
    const focus = context.focuses.get(edge.childId);
    context.diagnostics.push({
      code: 'FOCUS_LAYOUT_LONG_CONNECTOR',
      severity: 'warning',
      category: 'layout',
      message: `Connector ${edge.parentId} -> ${edge.childId} spans ${spans.horizontal} columns and ${spans.vertical} rows`,
      ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      details: {
        parentId: edge.parentId,
        childId: edge.childId,
        horizontalSpan: spans.horizontal,
        verticalSpan: spans.vertical,
        manhattanSpan: spans.manhattan,
        thresholds: {
          horizontalSpan: LONG_CONNECTOR_HORIZONTAL_SPAN,
          verticalSpan: LONG_CONNECTOR_VERTICAL_SPAN,
          manhattanSpan: LONG_CONNECTOR_MANHATTAN_SPAN,
        },
      },
    });
  }
}

function siblingCohortAnchor(
  context: LayoutContext,
  cohort: readonly string[],
): {
  anchorX: number;
  anchorKind: 'parent_average' | 'parent_median' | 'lane_base' | 'subtree_envelope';
} {
  const focus = context.focuses.get(cohort[0] ?? '');
  const coordinates = cohort
    .flatMap((focusId) => {
      const node = context.placed.get(focusId);
      return node === undefined ? [] : [node.x];
    })
    .sort((left, right) => left - right);
  if (
    coordinates.length >= 4 &&
    (coordinates.at(-1) ?? 0) - (coordinates[0] ?? 0) > 2 * LONG_CONNECTOR_HORIZONTAL_SPAN
  ) {
    return {
      anchorX: ((coordinates[0] ?? 0) + (coordinates.at(-1) ?? 0)) / 2,
      anchorKind: 'subtree_envelope',
    };
  }
  if (focus !== undefined) {
    const parents = prerequisiteIds(focus).flatMap((focusId) => {
      const parent = context.placed.get(focusId);
      return parent === undefined ? [] : [parent];
    });
    if (parents.length > 0) {
      return {
        anchorX: structuralAnchorX(
          context,
          focus,
          parents,
          context.laneIds.get(focus.id) ?? 'default',
        ),
        anchorKind: parents.length > 1 && focus.convergence ? 'parent_average' : 'parent_median',
      };
    }
  }
  const laneId = focus === undefined ? 'default' : (context.laneIds.get(focus.id) ?? 'default');
  return { anchorX: context.laneBases.get(laneId) ?? 0, anchorKind: 'lane_base' };
}

function* siblingSymmetryDiagnostics(context: LayoutContext): LayoutSteps<{
  asymmetricSiblingCohortCount: number;
  totalSiblingDeviation: number;
  maximumSiblingDeviation: number;
  offAnchorSiblingCohortCount: number;
  totalSiblingAnchorDeviation: number;
  maximumSiblingAnchorDeviation: number;
}> {
  let asymmetricSiblingCohortCount = 0;
  let totalSiblingDeviation = 0;
  let maximumSiblingDeviation = 0;
  let offAnchorSiblingCohortCount = 0;
  let totalSiblingAnchorDeviation = 0;
  let maximumSiblingAnchorDeviation = 0;
  for (const [cohortIndex, cohort] of context.siblingCohorts.entries()) {
    yield* cancellationCheckpoint(context.signal, cohortIndex, 16);
    const nodes = cohort
      .flatMap((focusId) => {
        const node = context.placed.get(focusId);
        return node === undefined ? [] : [node];
      })
      .sort((left, right) => left.x - right.x || compareCodeUnits(left.id, right.id));
    if (nodes.length < 2) continue;
    const { anchorX, anchorKind } = siblingCohortAnchor(context, cohort);
    const anchorCenterTwice = 2 * anchorX;
    const mirrorCenterTwice = (nodes[0]?.x ?? 0) + (nodes.at(-1)?.x ?? 0);
    let mirrorDeviation = 0;
    let anchorDeviation = 0;
    for (let index = 0; index <= Math.floor((nodes.length - 1) / 2); index += 1) {
      const left = nodes[index];
      const right = nodes[nodes.length - 1 - index];
      if (left === undefined || right === undefined) continue;
      const pairSum = left.x + right.x;
      mirrorDeviation += Math.abs(pairSum - mirrorCenterTwice);
      anchorDeviation += Math.abs(pairSum - anchorCenterTwice);
    }
    totalSiblingDeviation += mirrorDeviation;
    maximumSiblingDeviation = Math.max(maximumSiblingDeviation, mirrorDeviation);
    totalSiblingAnchorDeviation += anchorDeviation;
    maximumSiblingAnchorDeviation = Math.max(maximumSiblingAnchorDeviation, anchorDeviation);
    const focus = context.focuses.get(nodes.at(-1)?.id ?? '');
    if (mirrorDeviation > 0) {
      asymmetricSiblingCohortCount += 1;
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_SIBLING_ASYMMETRY',
        severity: 'warning',
        category: 'layout',
        message: `Sibling cohort ${cohort.join(', ')} is not mirror-symmetric`,
        ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: {
          focusIds: cohort,
          xCoordinates: nodes.map(({ x }) => x),
          centerTwice: mirrorCenterTwice,
          deviation: mirrorDeviation,
        },
      });
    }
    if (anchorDeviation > 0) {
      offAnchorSiblingCohortCount += 1;
      context.diagnostics.push({
        code: 'FOCUS_LAYOUT_SIBLING_ANCHOR_DEVIATION',
        severity: 'warning',
        category: 'layout',
        message: `Sibling cohort ${cohort.join(', ')} is offset from its structural anchor`,
        ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
        details: {
          focusIds: cohort,
          xCoordinates: nodes.map(({ x }) => x),
          centerTwice: anchorCenterTwice,
          anchorX,
          anchorKind,
          deviation: anchorDeviation,
        },
      });
    }
  }
  return {
    asymmetricSiblingCohortCount,
    totalSiblingDeviation,
    maximumSiblingDeviation,
    offAnchorSiblingCohortCount,
    totalSiblingAnchorDeviation,
    maximumSiblingAnchorDeviation,
  };
}

function layoutMetrics(
  context: LayoutContext,
  edges: readonly LayoutConnector[],
  crossingCount: number,
  nodeIntersectionCount: number,
  symmetry: {
    asymmetricSiblingCohortCount: number;
    totalSiblingDeviation: number;
    maximumSiblingDeviation: number;
    offAnchorSiblingCohortCount: number;
    totalSiblingAnchorDeviation: number;
    maximumSiblingAnchorDeviation: number;
  },
  spacing: {
    sameRowPairCount: number;
    tooCloseSameRowPairCount: number;
    minimumSameRowSpacing: number;
  },
): FocusLayoutMetrics {
  const nodes = [...context.placed.values()];
  const xCoordinates = nodes.map(({ x }) => x);
  const yCoordinates = nodes.map(({ y }) => y);
  const minimumX = xCoordinates.length === 0 ? 0 : Math.min(...xCoordinates);
  const maximumX = xCoordinates.length === 0 ? 0 : Math.max(...xCoordinates);
  const minimumY = yCoordinates.length === 0 ? 0 : Math.min(...yCoordinates);
  const maximumY = yCoordinates.length === 0 ? 0 : Math.max(...yCoordinates);
  const spans = edges.map(connectorSpans);
  const sum = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0);
  const maximum = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Math.max(...values);
  return {
    bounds: {
      minimumX,
      maximumX,
      minimumY,
      maximumY,
      columnSpan: maximumX - minimumX,
      rowSpan: maximumY - minimumY,
      columnCount: nodes.length === 0 ? 0 : maximumX - minimumX + 1,
      rowCount: nodes.length === 0 ? 0 : maximumY - minimumY + 1,
    },
    connectors: {
      count: edges.length,
      crossingCount,
      nodeIntersectionCount,
      longConnectorCount: edges.filter(longConnector).length,
      totalHorizontalSpan: sum(spans.map(({ horizontal }) => horizontal)),
      maximumHorizontalSpan: maximum(spans.map(({ horizontal }) => horizontal)),
      totalVerticalSpan: sum(spans.map(({ vertical }) => vertical)),
      maximumVerticalSpan: maximum(spans.map(({ vertical }) => vertical)),
      totalManhattanSpan: sum(spans.map(({ manhattan }) => manhattan)),
      maximumManhattanSpan: maximum(spans.map(({ manhattan }) => manhattan)),
    },
    symmetry: {
      siblingCohortCount: context.siblingCohorts.length,
      ...symmetry,
      boundingCenterOffsetTwice: Math.abs(minimumX + maximumX),
    },
    spacing: {
      requiredSameRowSpacing: context.nodeSpacing,
      ...spacing,
    },
  };
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

function* laneBoundsDiagnostics(context: LayoutContext): LayoutSteps<void> {
  let nodeIndex = 0;
  for (const node of context.placed.values()) {
    context.work.spend('lane-bounds diagnostic');
    yield* cancellationCheckpoint(context.signal, nodeIndex, 32);
    nodeIndex += 1;
    const bounds = boundsForFocus(context, node.id);
    if (node.x >= bounds.minimumX && node.x <= bounds.maximumX) continue;
    const focus = context.focuses.get(node.id);
    context.diagnostics.push({
      code: 'FOCUS_LAYOUT_LANE_BOUNDS_VIOLATION',
      severity: 'error',
      category: 'layout',
      message: `Focus ${node.id} is at x ${node.x}, outside lane ${node.laneId} bounds ${bounds.minimumX} through ${bounds.maximumX}`,
      ...(focus?.sourceLocation === undefined ? {} : { location: focus.sourceLocation }),
      details: {
        focusId: node.id,
        laneId: node.laneId,
        x: node.x,
        ...finiteLaneBoundDetails(bounds),
        preserved: node.preserved,
      },
    });
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
  const nodeSpacing = options.nodeSpacing ?? DEFAULT_NODE_SPACING;
  const siblingLayout = automaticSiblingLayout(plan, focuses, laneIds, nodeSpacing);
  const context: LayoutContext = {
    plan,
    focuses,
    previous: new Map(options.previous?.nodes.map((node) => [node.id, node]) ?? []),
    placed: new Map(),
    occupied: new Map(),
    occupiedRows: new Map(),
    connectorDefinitionsByFocus: connectorDefinitionsByFocus(focuses),
    placedConnectors: new Map(),
    mutualExclusions: mutualExclusionMap(focuses),
    laneBases: laneBases(plan, discoveredLanes, options.laneSpacing ?? DEFAULT_LANE_SPACING),
    laneBounds: laneBounds(plan),
    laneIds,
    siblingOffsets: siblingLayout.offsets,
    siblingCohorts: siblingLayout.cohorts,
    nodeSpacing,
    minimumMutualExclusionSpacing: nodeSpacing,
    decisions: [],
    diagnostics,
    work: options.workBudget ?? new FocusLayoutWorkBudget(),
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
  yield* repairConnectorCrossings(context);
  yield* refineConnectorQuality(context);
  centerFullyAutomaticLayout(context);
  yield* parentOrderDiagnostics(context);
  yield* laneBoundsDiagnostics(context);
  yield* visibleOverlapDiagnostics(context);
  const spacing = yield* sameRowSpacingDiagnostics(context);
  yield* mutualExclusionSpacingDiagnostics(context);
  const edges = yield* connectorEdges(context);
  const crossingSummary = yield* connectorCrossings(edges, context);
  const nodeIntersectionCount = yield* connectorNodeIntersectionDiagnostics(context, edges);
  yield* connectorCrossingDiagnostics(context, crossingSummary.samples);
  yield* connectorLengthDiagnostics(context, edges);
  const symmetry = yield* siblingSymmetryDiagnostics(context);
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
    metrics: layoutMetrics(
      context,
      edges,
      crossingSummary.count,
      nodeIntersectionCount,
      symmetry,
      spacing,
    ),
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
