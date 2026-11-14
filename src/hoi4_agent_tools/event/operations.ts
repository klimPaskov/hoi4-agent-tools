import { compareCodeUnits, type JsonValue } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { helperExpansionValidation } from '../core/helper-expansion.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult } from '../core/result.js';
import {
  eventInspectRequestSchema,
  splitEventInspectRequest,
  eventRenderRequestSchema,
  eventCompareRequestSchema,
} from '../schemas/event.js';
import type { EventGraphSnapshot } from './model.js';
import { EVENT_GRAPH_SNAPSHOT_MAX_BYTES } from './limits.js';
import {
  eventDiagnostics,
  type EventChainViewer,
  type EventRenderServiceInput,
  type EventCompareInput,
  type EventInspectInput,
} from './service.js';

export function normalizeEventInspectionRequest(input: unknown): EventInspectInput {
  // Validated request fields are JSON-only. Match wire semantics by removing optional
  // undefined fields, including nested source-selector columns, before service dispatch.
  return JSON.parse(JSON.stringify(eventInspectRequestSchema.parse(input))) as EventInspectInput;
}

/** Route mode compare to the graph comparison and every other mode to inspection. */
export function inspectOrCompareEvents(viewer: EventChainViewer, input: EventInspectInput) {
  const split = splitEventInspectRequest(input);
  if (!split.compare) return inspectEvents(viewer, input);
  const { signal, principal } = input as EventInspectInput & {
    signal?: AbortSignal;
    principal?: string;
  };
  return compareEvents(viewer, {
    ...(JSON.parse(JSON.stringify(split.request)) as EventCompareInput),
    workspaceId: input.workspaceId,
    ...(principal === undefined ? {} : { principal }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function normalizeEventRenderRequest(input: unknown): EventRenderServiceInput {
  return JSON.parse(
    JSON.stringify(eventRenderRequestSchema.parse(input)),
  ) as EventRenderServiceInput;
}

export function normalizeEventCompareRequest(input: unknown): EventCompareInput {
  return JSON.parse(JSON.stringify(eventCompareRequestSchema.parse(input))) as EventCompareInput;
}

export function eventGraphCounts(graph: EventGraphSnapshot, artifacts: number) {
  const diagnostics = eventDiagnostics(graph);
  return {
    events: graph.statistics.eventCount,
    options: graph.statistics.optionCount,
    entries: graph.statistics.entryCount,
    helpers: graph.statistics.helperCount,
    unresolvedNodes: graph.statistics.unresolvedNodeCount,
    terminals: graph.statistics.terminalCount,
    edges: graph.statistics.edgeCount,
    derivedEdges: graph.statistics.derivedEdgeCount,
    stateAccesses: graph.statistics.stateAccessCount,
    issues: graph.statistics.issueCount,
    diagnostics: diagnostics.length,
    blockingDiagnostics: diagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    ).length,
    skippedSources: graph.skippedSourceCount,
    artifacts,
  };
}

/**
 * `answerPaths` names the source files the answer stands on, for a focused trace or path. Blocking
 * diagnostics in other files of the workspace do not make that answer fail; they are counted apart
 * and stay in the linked evidence. Without it, every blocking diagnostic of the workspace counts.
 */
export function eventGraphValidation(graph: EventGraphSnapshot, answerPaths?: ReadonlySet<string>) {
  const counts = eventGraphCounts(graph, 0);
  const blockingHere =
    answerPaths === undefined
      ? counts.blockingDiagnostics
      : eventDiagnostics(graph).filter(
          ({ severity, location }) =>
            (severity === 'error' || severity === 'blocker') &&
            location !== undefined &&
            answerPaths.has(location.path),
        ).length;
  const blockingElsewhere = counts.blockingDiagnostics - blockingHere;
  const analysisBoundaryPassed =
    graph.complete || (graph.analysisMode === 'focused' && graph.skippedSourceCount === 0);
  const passed = analysisBoundaryPassed && blockingHere === 0;
  return {
    passed,
    checks: [
      {
        id: 'event-analysis',
        passed,
        message:
          blockingHere > 0
            ? `${blockingHere} blocking event-chain diagnostics${answerPaths === undefined ? '' : ' in the files of this answer'}; full evidence is linked`
            : answerPaths !== undefined && blockingElsewhere > 0
              ? `No blocking diagnostics in the files of this answer; ${blockingElsewhere} elsewhere in the workspace are in the linked evidence`
              : graph.complete
                ? 'The event-chain analysis is complete and has no blocking diagnostics'
                : graph.analysisMode === 'focused' && graph.skippedSourceCount === 0
                  ? 'Whole-workspace helper projections and lifecycle passes were deferred; the requested event analysis retains direct source evidence'
                  : graph.analysisMode === 'focused'
                    ? `${graph.skippedSourceCount} event-analysis source(s) were skipped; linked evidence records the partial boundary`
                    : graph.issues.some(
                          ({ code }) =>
                            code === 'EVENT_HELPER_DEPTH_LIMIT' ||
                            code === 'EVENT_HELPER_PROJECTION_LIMIT' ||
                            code === 'EVENT_HELPER_STATE_PROJECTION_LIMIT',
                        )
                      ? 'Helper expansion reached a depth or materialization boundary; helper_expansion mode provides bounded source-linked continuation'
                      : `${graph.skippedSourceCount} event-analysis source(s) were skipped; full evidence is linked`,
      },
    ],
  };
}

/**
 * Whether the answer to the question that was asked is complete. A result is partial only when
 * something the answer needs is missing, and the narrower scope of a focused analysis (the
 * whole-workspace passes it defers, named by \`analysisMode\`) is not a gap in an answer that
 * stands on its own. A focused trace is complete when no source was skipped, no limit cut it
 * short and no node sits on its boundary. A focused path is complete when it was found without an
 * assumption.
 */
function eventAnswerComplete(inspected: {
  graph: EventGraphSnapshot;
  helperExpansion?: { complete: boolean } | undefined;
  summary?: Record<string, JsonValue> | undefined;
}): boolean {
  if (inspected.helperExpansion !== undefined) return inspected.helperExpansion.complete;
  const { graph, summary } = inspected;
  if (graph.complete) return true;
  if (graph.analysisMode !== 'focused' || graph.skippedSourceCount !== 0 || summary === undefined)
    return false;
  const trace = summary.trace;
  if (typeof trace === 'object' && trace !== null && !Array.isArray(trace))
    return trace.truncated === false && trace.boundaryNodes === 0;
  return summary.found === true && summary.unresolvedAssumptions === 0;
}

/** The source files of a focused trace or path, or undefined for any other answer. */
function answerPaths(inspected: {
  graph: EventGraphSnapshot;
  report: unknown;
}): ReadonlySet<string> | undefined {
  if (inspected.graph.analysisMode !== 'focused') return undefined;
  interface Located {
    location?: { path: string };
    sourcePath?: string;
  }
  const report = inspected.report as {
    trace?: { nodes?: Located[] };
    explanation?: { steps?: Array<{ node: Located }> };
  } | null;
  const nodes = report?.trace?.nodes ?? report?.explanation?.steps?.map(({ node }) => node);
  if (nodes === undefined) return undefined;
  return new Set(
    nodes.flatMap((node) => {
      const path = node.location?.path ?? node.sourcePath;
      return path === undefined ? [] : [path];
    }),
  );
}

/**
 * What a partial event answer is missing, as inline information, so an agent knows whether to
 * raise a limit, trace from the boundary, or accept that callers reached only through scripted
 * effects may be absent (ADR 0086: a partial result says what is missing).
 */
export function eventPartialReasons(inspected: {
  graph: EventGraphSnapshot;
  helperExpansion?: { complete: boolean } | undefined;
  summary?: Record<string, JsonValue> | undefined;
}): Diagnostic[] {
  const { graph, summary } = inspected;
  const reasons: Array<{ code: string; message: string; details?: Record<string, JsonValue> }> = [];
  if (inspected.helperExpansion?.complete === false)
    reasons.push({
      code: 'EVENT_HELPER_EXPANSION_INCOMPLETE',
      message:
        'Helper expansion stopped at its depth or size limit; continue it with mode helper_expansion from a helper on its boundary',
    });
  if (graph.skippedSourceCount > 0)
    reasons.push({
      code: 'EVENT_SOURCES_SKIPPED',
      message: `${graph.skippedSourceCount} event source file(s) were skipped as over a size limit, so events they define are missing from this answer`,
      details: { skippedSources: graph.skippedSourceCount },
    });
  const trace = summary?.trace;
  const cut =
    typeof trace === 'object' &&
    trace !== null &&
    !Array.isArray(trace) &&
    (trace.truncated === true ||
      (typeof trace.boundaryNodes === 'number' && trace.boundaryNodes > 0));
  if (cut)
    reasons.push({
      code: 'EVENT_TRACE_TRUNCATED',
      message:
        'The trace stopped at its limits and continues beyond its boundary nodes; raise maxDepth or maxNodes, or trace again from a node on the boundary',
    });
  else if (
    graph.analysisMode === 'focused' &&
    graph.skippedSourceCount === 0 &&
    inspected.helperExpansion === undefined
  )
    reasons.push({
      code: 'EVENT_FOCUSED_ANALYSIS_DEFERRED',
      message:
        'This large workspace defers the workspace-wide helper projections and state links, so callers and state links that exist only inside scripted effects may be missing from this answer',
    });
  return reasons.map(({ code, message, details }) => ({
    category: 'configuration',
    code,
    severity: 'info',
    message,
    ...(details === undefined ? {} : { details }),
  }));
}

/** Transport-independent event inspection and its complete bounded result contract. */
export async function inspectEvents(viewer: EventChainViewer, input: EventInspectInput) {
  const inspected = await viewer.inspect(input);
  const result = emptyServiceResult(input.workspaceId, {
    mode: inspected.mode,
    analysisMode: inspected.graph.analysisMode ?? 'full',
    revision: inspected.graph.revision,
    graphHash: inspected.graphHash,
    counts: eventGraphCounts(inspected.graph, inspected.artifacts.length),
    ...(inspected.helperExpansion === undefined
      ? {}
      : { helperExpansion: inspected.helperExpansion }),
    ...(inspected.summary === undefined ? {} : { summary: inspected.summary }),
    boundary: {
      direction: input.direction ?? 'both',
      maxDepth: inspected.helperExpansion?.maxDepth ?? input.maxDepth ?? 8,
      maxNodes: inspected.helperExpansion === undefined ? (input.maxNodes ?? 500) : 0,
      maxEdges: inspected.helperExpansion === undefined ? (input.maxEdges ?? 2_000) : 0,
      expandHelpers:
        inspected.helperExpansion !== undefined ||
        (input.expandHelpers ?? input.mode === 'explain_path'),
      refresh: input.refresh ?? input.mode === 'scan',
    },
  });
  result.code = eventAnswerComplete(inspected) ? 'EVENT_INSPECTED' : 'EVENT_INSPECTED_PARTIAL';
  if (result.code === 'EVENT_INSPECTED_PARTIAL')
    result.diagnostics.push(...eventPartialReasons(inspected));
  setInlineFilesScanned(result, inspected.graph.filesScanned);
  result.artifacts = inspected.artifacts.map(publicArtifactLink);
  if (inspected.graphSnapshotOmitted === true)
    result.diagnostics.push({
      category: 'configuration',
      code: 'EVENT_GRAPH_SNAPSHOT_OMITTED',
      severity: 'info',
      message:
        'The workspace graph is too large to retain as a snapshot artifact; the scan report is linked, and comparisons use revisions held by this server',
      details: { maximumBytes: EVENT_GRAPH_SNAPSHOT_MAX_BYTES },
    });
  result.validation = eventGraphValidation(inspected.graph, answerPaths(inspected));
  if (inspected.helperExpansion !== undefined)
    result.validation = helperExpansionValidation(inspected.helperExpansion);
  return result;
}

export async function renderEvents(viewer: EventChainViewer, input: EventRenderServiceInput) {
  const rendered = await viewer.renderAndStore(input);
  const result = emptyServiceResult(input.workspaceId, {
    view: rendered.render.view,
    analysisMode: rendered.graph.analysisMode ?? 'full',
    revision: rendered.graph.revision,
    graphHash: rendered.graphHash,
    layoutHash: rendered.render.layout.layoutHash,
    hashes: rendered.render.hashes,
    counts: {
      ...eventGraphCounts(rendered.graph, rendered.artifacts.length),
      selectedNodes: rendered.render.selectedNodeIds.length,
      omittedNodes: rendered.render.omittedNodeCount,
      branchRenders: rendered.branches.length,
      omittedBranchRenders: rendered.budgetOmittedBranches,
    },
    boundary: {
      direction: input.direction ?? 'both',
      maxDepth: input.maxDepth ?? 4,
      maxNodes: input.maxNodes ?? 120,
      expandHelpers: input.expandHelpers ?? false,
      includeHtml: input.includeHtml ?? false,
      refresh: input.refresh ?? false,
    },
  });
  result.code = rendered.graph.complete ? 'EVENT_RENDERED' : 'EVENT_RENDERED_PARTIAL';
  setInlineFilesScanned(result, rendered.graph.filesScanned);
  result.artifacts = rendered.artifacts.map(publicArtifactLink);
  result.validation = eventGraphValidation(rendered.graph);
  return result;
}

export async function compareEvents(viewer: EventChainViewer, input: EventCompareInput) {
  const compared = await viewer.compareAndStore(input);
  const { comparison } = compared;
  const result = emptyServiceResult(input.workspaceId, {
    beforeRevision: comparison.beforeRevision,
    afterRevision: comparison.afterRevision,
    beforeGraphHash: comparison.beforeGraphHash,
    afterGraphHash: comparison.afterGraphHash,
    ...(compared.render === undefined ? {} : { renderHashes: compared.render.hashes }),
    counts: {
      changes: comparison.changes.length,
      ...(compared.selection === undefined
        ? {}
        : {
            selectedChanges: compared.selection.selectedChangeCount,
            omittedChanges: compared.selection.omittedChangeCount,
            unattributedChanges: compared.selection.unattributedChangeIds.length,
            selectedBeforeNodes: compared.selection.beforeNodeIds.length,
            selectedAfterNodes: compared.selection.afterNodeIds.length,
          }),
      addedNodes: comparison.addedNodeIds.length,
      removedNodes: comparison.removedNodeIds.length,
      changedNodes: comparison.changedNodeIds.length,
      addedEdges: comparison.addedEdgeIds.length,
      removedEdges: comparison.removedEdgeIds.length,
      changedEdges: comparison.changedEdgeIds.length,
      addedStateAccesses: comparison.addedStateAccessIds.length,
      removedStateAccesses: comparison.removedStateAccessIds.length,
      changedStateAccesses: comparison.changedStateAccessIds.length,
      addedStateLinks: comparison.addedStateLinkIds.length,
      removedStateLinks: comparison.removedStateLinkIds.length,
      changedStateLinks: comparison.changedStateLinkIds.length,
      addedDiagnostics: comparison.addedIssueIds.length,
      resolvedDiagnostics: comparison.resolvedIssueIds.length,
      addedUnresolved: comparison.addedUnresolvedIds.length,
      resolvedUnresolved: comparison.resolvedUnresolvedIds.length,
      disconnectedRoots: comparison.newlyDisconnectedRootIds.length,
      disconnectedBranches: comparison.newlyDisconnectedBranchIds.length,
      disconnectedTerminals: comparison.newlyDisconnectedTerminalIds.length,
      beforeSkippedSources: compared.before.skippedSourceCount,
      afterSkippedSources: compared.after.skippedSourceCount,
      artifacts: compared.artifacts.length,
    },
    boundary: {
      proposedSources: input.proposedSources?.length ?? 0,
      ...(compared.selection === undefined
        ? {}
        : {
            selector: compared.selection.selector,
            maxChainNodes: compared.selection.maxChainNodes,
            selectionTruncated: compared.selection.truncated,
          }),
      render: input.render ?? true,
      maxRenderNodes: input.maxRenderNodes ?? 120,
      refresh: compared.refresh,
    },
  });
  result.code =
    compared.before.complete && compared.after.complete
      ? 'EVENT_COMPARED'
      : 'EVENT_COMPARED_PARTIAL';
  setInlineFilesScanned(
    result,
    [...new Set([...compared.before.filesScanned, ...compared.after.filesScanned])].sort(
      compareCodeUnits,
    ),
  );
  result.artifacts = compared.artifacts.map(publicArtifactLink);
  const beforeValidation = eventGraphValidation(compared.before);
  const afterValidation = eventGraphValidation(compared.after);
  result.validation = {
    passed: beforeValidation.passed && afterValidation.passed,
    checks: [...beforeValidation.checks, ...afterValidation.checks].map((check, index) => ({
      ...check,
      id: `${index === 0 ? 'before' : 'after'}-${check.id}`,
    })),
  };
  return result;
}
