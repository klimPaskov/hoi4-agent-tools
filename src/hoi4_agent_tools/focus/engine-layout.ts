import type { Diagnostic } from '../core/diagnostics.js';
import {
  FOCUS_LAYOUT_REQUEST_SCHEMA,
  runFocusLayoutEngine,
  type EngineRunOptions,
  type FocusLayoutEnginePosition,
  type FocusLayoutEngineRequest,
  type FocusLayoutEngineResponse,
} from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { focusLaneId } from './layout.js';
import type { FocusLayoutNode, FocusPosition, FocusTreePlan } from './model.js';

/**
 * `hoi4.focus_rewrite` with `layoutMode: "engine"` or `placement`: the Rust focus layout engine
 * (`hoi4-engine focus-layout`) chooses coordinates, and its `source` entries become the plan's
 * fixed and relative positions, so the ordinary source update writes x, y and
 * relative_position_id. There is no fallback to the TypeScript solver.
 */

export interface FocusPlacementRequest {
  focusIds: string[];
  anchorId?: string | undefined;
  preferSide?: 'left' | 'right' | 'either' | undefined;
  allowShift?: boolean | undefined;
}

export interface FocusEngineLayoutInput {
  plan: FocusTreePlan;
  placement?: FocusPlacementRequest;
  /**
   * Coordinates the current source gives each existing focus. An `insert` keeps every focus
   * outside `placement.focusIds` where it is; an automatic focus there takes these coordinates.
   */
  currentSourcePositions?: ReadonlyMap<string, FocusPosition>;
  /** Focus ids of the current tree, when one exists; placement without engine mode adds only new focuses. */
  currentFocusIds?: ReadonlySet<string>;
  layoutMode: 'authored' | 'engine';
}

export interface FocusEngineLayoutSummary {
  operation: 'layout' | 'insert';
  status: 'ok';
  hashes: FocusLayoutEngineResponse['hashes'];
  /** The engine's connector metrics, without its timing so the result stays deterministic. */
  metrics: Omit<NonNullable<FocusLayoutEngineResponse['metrics']>, 'durationMicros'>;
  movedFocusIds: string[];
  movedFocusCount: number;
  shifted?: FocusLayoutEngineResponse['shifted'];
  binarySource: 'environment' | 'package';
}

export interface FocusEngineLayoutResult {
  plan: FocusTreePlan;
  response: FocusLayoutEngineResponse;
  diagnostics: Diagnostic[];
  summary: FocusEngineLayoutSummary;
}

export const FOCUS_ENGINE_REMEDY =
  'Set HOI4_ENGINE to the absolute path of a hoi4-engine binary (cargo build --release -p hoi4-engine-cli in engine/), or install a hoi4-agent-tools release that ships the engine for this platform. layoutMode authored and compact do not need it.';

const MOVED_FOCUS_ID_LIMIT = 100;

function enginePosition(position: FocusPosition): FocusLayoutEnginePosition {
  if (position.mode === 'fixed') return { mode: 'fixed', x: position.x, y: position.y };
  if (position.mode === 'relative')
    return { mode: 'relative', x: position.x, y: position.y, relativeTo: position.relativeTo };
  return {
    mode: 'auto',
    ...(position.preferredX === undefined ? {} : { preferredX: position.preferredX }),
    ...(position.preferredY === undefined ? {} : { preferredY: position.preferredY }),
  };
}

function placementError(message: string, details: Record<string, unknown>): ServiceError {
  return new ServiceError('FOCUS_PLACEMENT_INVALID', message, details);
}

/** The engine request for one tree; exported for tests. */
export function focusEngineLayoutRequest(input: FocusEngineLayoutInput): FocusLayoutEngineRequest {
  const { plan, placement } = input;
  const focusIds = new Set(plan.focuses.map(({ id }) => id));
  const placed = new Set(placement?.focusIds ?? []);
  if (placement !== undefined) {
    const missing = placement.focusIds.filter((id) => !focusIds.has(id));
    if (missing.length > 0)
      throw placementError('placement.focusIds names focuses that are not in the plan', {
        focusIds: missing.slice(0, 100),
      });
    if (input.layoutMode === 'authored' && input.currentFocusIds !== undefined) {
      const existing = placement.focusIds.filter((id) => input.currentFocusIds?.has(id));
      if (existing.length > 0)
        throw placementError(
          'placement in authored layout mode places only focuses the plan adds; use layoutMode engine to move existing focuses',
          { focusIds: existing.slice(0, 100) },
        );
    }
    const pinned = plan.focuses
      .filter(({ id, position }) => placed.has(id) && position.pinned)
      .map(({ id }) => id);
    if (pinned.length > 0)
      throw placementError(
        'placement.focusIds names pinned focuses, which keep their coordinates',
        {
          focusIds: pinned.slice(0, 100),
        },
      );
  }
  const unplaced: string[] = [];
  const focuses = plan.focuses.map((focus) => {
    let position: FocusLayoutEnginePosition;
    if (placed.has(focus.id))
      position = focus.position.mode === 'auto' ? enginePosition(focus.position) : { mode: 'auto' };
    else if (placement !== undefined && focus.position.mode === 'auto') {
      const current = input.currentSourcePositions?.get(focus.id);
      if (current === undefined || current.mode === 'auto') {
        unplaced.push(focus.id);
        position = { mode: 'auto' };
      } else position = enginePosition(current);
    } else position = enginePosition(focus.position);
    return {
      id: focus.id,
      prerequisites: focus.prerequisites.groups.map(({ focusIds: members }) => [...members]),
      mutuallyExclusive: [...focus.mutuallyExclusive],
      laneId: focusLaneId(plan, focus),
      position,
      pinned: focus.position.mode !== 'auto' && focus.position.pinned,
    };
  });
  if (unplaced.length > 0)
    throw placementError(
      'placement keeps every other focus where it is, but these automatic focuses have no coordinates yet; add them to placement.focusIds or give them x and y',
      { focusIds: unplaced.slice(0, 100) },
    );
  return {
    schema: FOCUS_LAYOUT_REQUEST_SCHEMA,
    operation: placement === undefined ? 'layout' : 'insert',
    treeId: plan.id,
    lanes: plan.laneGroups.map((lane) => ({
      id: lane.id,
      order: lane.order,
      ...(lane.minimumX === undefined ? {} : { minimumX: lane.minimumX }),
      ...(lane.maximumX === undefined ? {} : { maximumX: lane.maximumX }),
    })),
    focuses,
    ...(placement === undefined
      ? {}
      : {
          insert: {
            focusIds: [...placement.focusIds],
            ...(placement.anchorId === undefined ? {} : { anchorId: placement.anchorId }),
            ...(placement.preferSide === undefined ? {} : { preferSide: placement.preferSide }),
            ...(placement.allowShift === undefined ? {} : { allowShift: placement.allowShift }),
          },
        }),
  };
}

/** Engine diagnostics as tool diagnostics; their codes already carry the FOCUS_ENGINE_ prefix. */
export function focusEngineDiagnostics(response: FocusLayoutEngineResponse): Diagnostic[] {
  return response.diagnostics.map((entry) => ({
    code: entry.code,
    severity: entry.severity,
    category: 'layout' as const,
    message: entry.message,
    details: { ...entry.details, focusIds: entry.focusIds.slice(0, 100) },
  }));
}

/** The plan with the engine's coordinates: `source` entries become fixed or relative positions. */
export function applyFocusEngineSource(
  plan: FocusTreePlan,
  response: FocusLayoutEngineResponse,
): FocusTreePlan {
  const source = new Map(response.source.map((entry) => [entry.id, entry]));
  return {
    ...plan,
    focuses: plan.focuses.map((focus) => {
      const entry = source.get(focus.id);
      if (entry === undefined)
        throw new ServiceError(
          'FOCUS_ENGINE_LAYOUT_MISMATCH',
          `The focus layout engine returned no position for ${focus.id}`,
          { focusId: focus.id },
        );
      const pinned = focus.position.mode !== 'auto' && focus.position.pinned;
      const position: FocusPosition =
        entry.relativeTo === undefined
          ? { mode: 'fixed', x: entry.x, y: entry.y, pinned }
          : { mode: 'relative', x: entry.x, y: entry.y, relativeTo: entry.relativeTo, pinned };
      return { ...focus, position };
    }),
  };
}

/** Refuse when the layout that will be written differs from the engine's nodes. */
export function assertFocusEngineLayoutWritten(
  response: FocusLayoutEngineResponse,
  nodes: readonly FocusLayoutNode[],
): void {
  const written = new Map(nodes.map((node) => [node.id, node]));
  const differing = response.nodes
    .filter((node) => {
      const actual = written.get(node.id);
      return actual?.x !== node.x || actual.y !== node.y;
    })
    .map(({ id }) => id);
  if (differing.length > 0 || written.size !== response.nodes.length)
    throw new ServiceError(
      'FOCUS_ENGINE_LAYOUT_MISMATCH',
      'The coordinates prepared for the source differ from the focus layout engine result; nothing was written',
      { focusIds: differing.slice(0, 100) },
    );
}

const BLOCKED_TEXT_LIMIT = 1_200;

/**
 * The refusal text carries the engine's reasons and needsRoom, because a failed rewrite reports
 * only its code and message to the agent.
 */
function blockedMessage(
  response: FocusLayoutEngineResponse,
  diagnostics: readonly Diagnostic[],
): string {
  const reasons = diagnostics
    .filter(({ severity }) => severity === 'error')
    .slice(0, 3)
    .map(({ code, message, details }) => {
      const ids = (details?.focusIds as string[] | undefined) ?? [];
      return `${code}: ${message}${ids.length === 0 ? '' : ` (${ids.slice(0, 8).join(', ')})`}`;
    });
  const text = [
    response.needsRoom === undefined
      ? 'The focus layout engine cannot place the tree without breaking a layout rule. Nothing was written.'
      : 'There is no free place for the new focuses. Nothing was written. Set placement.allowShift to apply the shift in needsRoom, or move the listed focuses yourself.',
    ...reasons,
    ...(response.needsRoom === undefined
      ? []
      : [`needsRoom: ${JSON.stringify(response.needsRoom)}`]),
  ].join(' ');
  return text.length <= BLOCKED_TEXT_LIMIT ? text : `${text.slice(0, BLOCKED_TEXT_LIMIT)}…`;
}

/** Run the engine for one tree. Refuses (never falls back) when the engine is unavailable. */
export async function layoutFocusTreeWithEngine(
  input: FocusEngineLayoutInput,
  options: EngineRunOptions = {},
): Promise<FocusEngineLayoutResult> {
  const request = focusEngineLayoutRequest(input);
  const result = await runFocusLayoutEngine(request, options);
  if (result.outcome === 'unavailable')
    throw new ServiceError(
      'FOCUS_ENGINE_UNAVAILABLE',
      `The focus layout engine is unavailable (${result.reason}): ${result.message}. Nothing was written. ${FOCUS_ENGINE_REMEDY}`,
      {
        reason: result.reason,
        message: result.message,
        remedy: FOCUS_ENGINE_REMEDY,
        ...(result.binary === undefined ? {} : { binarySource: result.binary.source }),
      },
    );
  if (result.outcome === 'invalid_request')
    throw new ServiceError(
      'FOCUS_ENGINE_REQUEST_INVALID',
      `The focus layout engine refused the tree: ${result.error.message}`,
      { engineCode: result.error.code, message: result.error.message },
    );
  const { response } = result;
  const diagnostics = focusEngineDiagnostics(response);
  if (response.status === 'blocked' || response.metrics === null)
    throw new ServiceError('FOCUS_ENGINE_BLOCKED', blockedMessage(response, diagnostics), {
      operation: response.operation,
      ...(response.needsRoom === undefined ? {} : { needsRoom: response.needsRoom }),
      diagnostics: diagnostics.slice(0, 20).map(({ code, severity, message, details }) => ({
        code,
        severity,
        message,
        details,
      })),
      hashes: response.hashes,
    });
  const { durationMicros: _durationMicros, ...metrics } = response.metrics;
  const moved = response.nodes.filter(({ moved: changed }) => changed).map(({ id }) => id);
  return {
    plan: applyFocusEngineSource(input.plan, response),
    response,
    diagnostics,
    summary: {
      operation: response.operation,
      status: 'ok',
      hashes: response.hashes,
      metrics,
      movedFocusIds: moved.slice(0, MOVED_FOCUS_ID_LIMIT),
      movedFocusCount: moved.length,
      ...(response.shifted === undefined ? {} : { shifted: response.shifted }),
      binarySource: result.binary.source,
    },
  };
}
