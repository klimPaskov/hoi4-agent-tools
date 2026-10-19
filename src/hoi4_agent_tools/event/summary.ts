import type { JsonValue } from '../core/canonical.js';
import { compareCodeUnits } from '../core/canonical.js';
import type { EventTraceResult } from './algorithms.js';
import type { EventConfidence, EventDefectClass, EventIssue } from './model.js';
import type { EventImpactResult, EventPathExplanation, EventRootDiscovery } from './queries.js';

/** Findings returned inline, before an agent opens the linked report. */
export const EVENT_INLINE_FINDINGS = 10;
const EVENT_INLINE_CODES = 10;
const EVENT_INLINE_EVENT_IDS = 20;
const EVENT_INLINE_MESSAGE_LENGTH = 300;

const CLASSIFICATION_ORDER: Readonly<Record<EventDefectClass, number>> = {
  confirmed_error: 0,
  probable_defect: 1,
  design_warning: 2,
  unresolved_analysis: 3,
};

const CONFIDENCE_ORDER: Readonly<Record<EventConfidence, number>> = {
  confirmed: 0,
  high: 1,
  medium: 2,
  low: 3,
  unresolved: 4,
};

function countBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => compareCodeUnits(left, right)));
}

function layer(issue: EventIssue): string {
  const path = issue.location?.path;
  return path === undefined ? 'unknown' : (/^([a-z]+):/u.exec(path)?.[1] ?? 'unknown');
}

/** The mod's own files first, then most severe: classification, confidence, source order. */
function issueOrder(left: EventIssue, right: EventIssue): number {
  const leftMod = layer(left) === 'mod' ? 0 : 1;
  const rightMod = layer(right) === 'mod' ? 0 : 1;
  return (
    leftMod - rightMod ||
    CLASSIFICATION_ORDER[left.classification] - CLASSIFICATION_ORDER[right.classification] ||
    CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence] ||
    compareCodeUnits(left.location?.path ?? '', right.location?.path ?? '') ||
    (left.location?.start.line ?? 0) - (right.location?.start.line ?? 0) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.message, right.message)
  );
}

/** Counts and the most severe findings of a selection, small enough to return inline. */
export function summarizeEventIssues(issues: readonly EventIssue[]): Record<string, JsonValue> {
  const byCode = Object.entries(countBy(issues, ({ code }) => code))
    .sort(
      ([leftCode, left], [rightCode, right]) =>
        right - left || compareCodeUnits(leftCode, rightCode),
    )
    .slice(0, EVENT_INLINE_CODES);
  return {
    issues: issues.length,
    byClassification: countBy(issues, ({ classification }) => classification),
    // `mod` findings are the workspace's own; `game` and `dependency` ones are context.
    byLayer: countBy(issues, layer),
    topCodes: Object.fromEntries(byCode),
    findings: [...issues]
      .sort(issueOrder)
      .slice(0, EVENT_INLINE_FINDINGS)
      .map((issue) => ({
        code: issue.code,
        classification: issue.classification,
        confidence: issue.confidence,
        message:
          issue.message.length > EVENT_INLINE_MESSAGE_LENGTH
            ? `${issue.message.slice(0, EVENT_INLINE_MESSAGE_LENGTH - 1)}…`
            : issue.message,
        ...(issue.location === undefined
          ? {}
          : { path: issue.location.path, line: issue.location.start.line }),
        ...(typeof issue.details.name === 'string' ? { subject: issue.details.name } : {}),
      })),
  };
}

/** Size of a traced chain and the events it reaches. */
export function summarizeEventTrace(trace: EventTraceResult): Record<string, JsonValue> {
  const events = trace.nodes
    .flatMap(({ kind, eventId }) => (kind === 'event' && eventId !== undefined ? [eventId] : []))
    .sort(compareCodeUnits);
  return {
    nodes: trace.nodes.length,
    edges: trace.edges.length,
    events: events.length,
    eventIds: events.slice(0, EVENT_INLINE_EVENT_IDS),
    boundaryNodes: trace.boundaryNodeIds.length,
    truncated: trace.truncated,
  };
}

/** How many chains start where, in a form an agent can read without the report. */
export function summarizeEventRoots(roots: EventRootDiscovery): Record<string, JsonValue> {
  const nodeLayer = ({ sourcePath }: EventRootDiscovery['automaticEvents'][number]): string =>
    sourcePath === undefined ? 'unknown' : (/^([a-z]+):/u.exec(sourcePath)?.[1] ?? 'unknown');
  // The mod's own events first: vanilla callerless events are context, not the mod's defects.
  const ids = (nodes: EventRootDiscovery['automaticEvents']): string[] =>
    [...nodes]
      .sort(
        (left, right) =>
          (nodeLayer(left) === 'mod' ? 0 : 1) - (nodeLayer(right) === 'mod' ? 0 : 1) ||
          compareCodeUnits(left.eventId ?? '', right.eventId ?? ''),
      )
      .flatMap(({ eventId }) => (eventId === undefined ? [] : [eventId]))
      .slice(0, EVENT_INLINE_EVENT_IDS);
  return {
    entryPoints: roots.entryPoints.length,
    entryKinds: countBy(roots.entryPoints, ({ metadata }) =>
      typeof metadata.entryKind === 'string' ? metadata.entryKind : 'unknown',
    ),
    automaticEvents: roots.automaticEvents.length,
    callerlessTriggeredEvents: roots.callerlessTriggeredEvents.length,
    callerlessTriggeredByLayer: countBy(roots.callerlessTriggeredEvents, nodeLayer),
    callerlessTriggeredEventIds: ids(roots.callerlessTriggeredEvents),
    cycles: roots.stronglyConnectedComponents.filter(({ cyclic }) => cyclic).length,
  };
}

/** Whether a route exists and, if so, the events it passes through in order. */
export function summarizeEventPath(path: EventPathExplanation): Record<string, JsonValue> {
  return {
    found: path.found,
    steps: path.steps.length,
    eventIds: path.steps
      .flatMap(({ node }) =>
        node.kind === 'event' && node.eventId !== undefined ? [node.eventId] : [],
      )
      .slice(0, EVENT_INLINE_EVENT_IDS),
    ...(path.failureReason === undefined ? {} : { failureReason: path.failureReason }),
    ...(path.failureMessage === undefined ? {} : { failureMessage: path.failureMessage }),
    unresolvedAssumptions: path.unresolvedAssumptions.length,
  };
}

/** How far a change to the subject reaches, by count. */
export function summarizeEventImpact(impact: EventImpactResult): Record<string, JsonValue> {
  return {
    direct: impact.directNodeIds.length,
    upstream: impact.upstreamNodeIds.length,
    downstream: impact.downstreamNodeIds.length,
    stateAccesses: impact.stateAccessIds.length,
    affectedRoots: impact.affectedRootIds.length,
    affectedTerminals: impact.affectedTerminalIds.length,
    wouldDisconnect: impact.wouldDisconnectNodeIds.length,
    wouldDisconnectTerminals: impact.wouldDisconnectTerminalIds.length,
    unresolved: impact.unresolvedNodeIds.length,
    sampleDownstream: impact.downstreamNodeIds.slice(0, EVENT_INLINE_EVENT_IDS),
  };
}
