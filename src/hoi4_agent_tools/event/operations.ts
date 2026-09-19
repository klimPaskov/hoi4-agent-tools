import { compareCodeUnits } from '../core/canonical.js';
import { helperExpansionValidation } from '../core/helper-expansion.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult } from '../core/result.js';
import {
  eventInspectRequestSchema,
  eventRenderRequestSchema,
  eventCompareRequestSchema,
} from '../schemas/event.js';
import type { EventGraphSnapshot } from './model.js';
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

export function eventGraphValidation(graph: EventGraphSnapshot) {
  const counts = eventGraphCounts(graph, 0);
  return {
    passed: graph.complete && counts.blockingDiagnostics === 0,
    checks: [
      {
        id: 'event-analysis',
        passed: graph.complete && counts.blockingDiagnostics === 0,
        message:
          graph.analysisMode === 'focused'
            ? 'Large workspace analysis deferred workspace-wide helper projections and lifecycle passes; direct evidence is linked'
            : graph.complete
              ? `${counts.blockingDiagnostics} blocking event-chain diagnostics; full evidence is linked`
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
  result.code =
    (inspected.helperExpansion?.complete ?? inspected.graph.complete)
      ? 'EVENT_INSPECTED'
      : 'EVENT_INSPECTED_PARTIAL';
  setInlineFilesScanned(result, inspected.graph.filesScanned);
  result.artifacts = inspected.artifacts.map(publicArtifactLink);
  result.validation = eventGraphValidation(inspected.graph);
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
