import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { publicArtifactLink } from '../../core/artifacts.js';
import { compareCodeUnits } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import { emptyServiceResult } from '../../core/result.js';
import {
  EventChainViewer,
  eventDiagnostics,
  type EventCompareInput,
  type EventInspectInput,
  type EventRenderServiceInput,
} from '../../event/service.js';
import type { EventGraphSnapshot } from '../../event/model.js';
import {
  eventDirectionSchema,
  eventGraphReferenceSchema,
  eventImpactSubjectSchema,
  eventInspectModeSchema,
  eventProposedSourceSchema,
  eventRenderViewSchema,
  eventSelectorSchema,
  eventStateSubjectSchema,
} from '../../schemas/event.js';
import { workspaceIdSchema } from '../../schemas/common.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';
import type { ServerContext } from '../server/base-tools.js';

const nestedSelectorSchema = compactValidatedInputSchema(
  eventSelectorSchema,
  'Event selector; see docs/events.md.',
);
const nestedStateSubjectSchema = compactValidatedInputSchema(
  eventStateSubjectSchema,
  'State kind and name.',
);
const nestedImpactSubjectSchema = compactValidatedInputSchema(
  eventImpactSubjectSchema,
  'Impact kind and name.',
);
const nestedGraphReferenceSchema = compactValidatedInputSchema(
  eventGraphReferenceSchema,
  'Cached revision or graph artifact URI.',
);
const nestedProposedSourceSchema = compactValidatedInputSchema(
  eventProposedSourceSchema,
  'In-memory source overlay; never written.',
);

const eventInspectInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: eventInspectModeSchema,
    selector: nestedSelectorSchema.optional(),
    from: nestedSelectorSchema.optional(),
    to: nestedSelectorSchema.optional(),
    direction: eventDirectionSchema.optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    maxNodes: z.number().int().min(1).max(5_000).optional(),
    maxEdges: z.number().int().min(1).max(20_000).optional(),
    expandHelpers: z.boolean().optional(),
    stateSubject: nestedStateSubjectSchema.optional(),
    impactSubject: nestedImpactSubjectSchema.optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'trace' && value.selector === undefined) {
      context.addIssue({ code: 'custom', path: ['selector'], message: 'Trace requires selector' });
    }
    if (value.mode === 'explain_path' && (value.from === undefined || value.to === undefined)) {
      context.addIssue({
        code: 'custom',
        path: value.from === undefined ? ['from'] : ['to'],
        message: 'Path explanation requires from and to',
      });
    }
    if (value.mode === 'impact' && value.impactSubject === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['impactSubject'],
        message: 'Impact analysis requires impactSubject',
      });
    }
  });

const eventRenderInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    view: eventRenderViewSchema,
    selector: nestedSelectorSchema.optional(),
    direction: eventDirectionSchema.optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    maxNodes: z.number().int().min(1).max(240).optional(),
    expandHelpers: z.boolean().optional(),
    includeHtml: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

const eventCompareInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    before: nestedGraphReferenceSchema.optional(),
    after: nestedGraphReferenceSchema.optional(),
    proposedSources: z.array(nestedProposedSourceSchema).min(1).max(64).optional(),
    render: z.boolean().optional(),
    maxRenderNodes: z.number().int().min(1).max(240).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.after !== undefined && value.proposedSources !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['after'],
        message: 'after and proposedSources are mutually exclusive',
      });
    }
  });

const eventGraphCountsSchema = z
  .object({
    events: nonNegativeIntegerSchema,
    options: nonNegativeIntegerSchema,
    entries: nonNegativeIntegerSchema,
    helpers: nonNegativeIntegerSchema,
    unresolvedNodes: nonNegativeIntegerSchema,
    terminals: nonNegativeIntegerSchema,
    edges: nonNegativeIntegerSchema,
    derivedEdges: nonNegativeIntegerSchema,
    stateAccesses: nonNegativeIntegerSchema,
    issues: nonNegativeIntegerSchema,
    diagnostics: nonNegativeIntegerSchema,
    blockingDiagnostics: nonNegativeIntegerSchema,
    skippedSources: nonNegativeIntegerSchema,
    artifacts: nonNegativeIntegerSchema,
  })
  .strict();

const inspectBoundarySchema = z
  .object({
    direction: eventDirectionSchema,
    maxDepth: nonNegativeIntegerSchema,
    maxNodes: nonNegativeIntegerSchema,
    maxEdges: nonNegativeIntegerSchema,
    expandHelpers: z.boolean(),
    refresh: z.boolean(),
  })
  .strict();

const renderHashSchema = z
  .object({
    json: sha256Schema,
    svg: sha256Schema,
    png: sha256Schema,
    html: sha256Schema.optional(),
  })
  .strict();

const eventInspectOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: eventInspectModeSchema,
      revision: sha256Schema,
      graphHash: sha256Schema,
      counts: eventGraphCountsSchema,
      boundary: inspectBoundarySchema,
    })
    .strict(),
);

const eventRenderOutputSchema = strictOperationResultSchema(
  z
    .object({
      view: eventRenderViewSchema,
      revision: sha256Schema,
      graphHash: sha256Schema,
      layoutHash: sha256Schema,
      hashes: renderHashSchema,
      counts: eventGraphCountsSchema.extend({
        selectedNodes: nonNegativeIntegerSchema,
        omittedNodes: nonNegativeIntegerSchema,
        branchRenders: nonNegativeIntegerSchema,
      }),
      boundary: z
        .object({
          direction: eventDirectionSchema,
          maxDepth: nonNegativeIntegerSchema,
          maxNodes: nonNegativeIntegerSchema,
          expandHelpers: z.boolean(),
          includeHtml: z.boolean(),
          refresh: z.boolean(),
        })
        .strict(),
    })
    .strict(),
);

const eventCompareOutputSchema = strictOperationResultSchema(
  z
    .object({
      beforeRevision: sha256Schema,
      afterRevision: sha256Schema,
      beforeGraphHash: sha256Schema,
      afterGraphHash: sha256Schema,
      renderHashes: renderHashSchema.optional(),
      counts: z
        .object({
          changes: nonNegativeIntegerSchema,
          addedNodes: nonNegativeIntegerSchema,
          removedNodes: nonNegativeIntegerSchema,
          changedNodes: nonNegativeIntegerSchema,
          addedEdges: nonNegativeIntegerSchema,
          removedEdges: nonNegativeIntegerSchema,
          changedEdges: nonNegativeIntegerSchema,
          addedStateAccesses: nonNegativeIntegerSchema,
          removedStateAccesses: nonNegativeIntegerSchema,
          changedStateAccesses: nonNegativeIntegerSchema,
          addedStateLinks: nonNegativeIntegerSchema,
          removedStateLinks: nonNegativeIntegerSchema,
          changedStateLinks: nonNegativeIntegerSchema,
          addedDiagnostics: nonNegativeIntegerSchema,
          resolvedDiagnostics: nonNegativeIntegerSchema,
          addedUnresolved: nonNegativeIntegerSchema,
          resolvedUnresolved: nonNegativeIntegerSchema,
          disconnectedRoots: nonNegativeIntegerSchema,
          disconnectedBranches: nonNegativeIntegerSchema,
          disconnectedTerminals: nonNegativeIntegerSchema,
          beforeSkippedSources: nonNegativeIntegerSchema,
          afterSkippedSources: nonNegativeIntegerSchema,
          artifacts: nonNegativeIntegerSchema,
        })
        .strict(),
      boundary: z
        .object({
          proposedSources: nonNegativeIntegerSchema,
          render: z.boolean(),
          maxRenderNodes: nonNegativeIntegerSchema,
          refresh: z.boolean(),
        })
        .strict(),
    })
    .strict(),
);

const readOnlyEventTool = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function graphCounts(graph: EventGraphSnapshot, artifacts: number) {
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

function graphValidation(graph: EventGraphSnapshot) {
  const counts = graphCounts(graph, 0);
  return {
    passed: graph.complete && counts.blockingDiagnostics === 0,
    checks: [
      {
        id: 'event-analysis',
        passed: graph.complete && counts.blockingDiagnostics === 0,
        message: graph.complete
          ? `${counts.blockingDiagnostics} blocking event-chain diagnostics; full evidence is linked`
          : `${graph.skippedSourceCount} event-analysis source(s) were skipped; full evidence is linked`,
      },
    ],
  };
}

function inspectRequest(
  input: z.infer<typeof eventInspectInputSchema>,
  context: ServerContext,
  signal: AbortSignal,
): EventInspectInput {
  return {
    workspaceId: input.workspaceId,
    mode: input.mode,
    ...(input.selector === undefined
      ? {}
      : { selector: input.selector as NonNullable<EventInspectInput['selector']> }),
    ...(input.from === undefined
      ? {}
      : { from: input.from as NonNullable<EventInspectInput['from']> }),
    ...(input.to === undefined ? {} : { to: input.to as NonNullable<EventInspectInput['to']> }),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
    ...(input.maxEdges === undefined ? {} : { maxEdges: input.maxEdges }),
    ...(input.expandHelpers === undefined ? {} : { expandHelpers: input.expandHelpers }),
    ...(input.stateSubject === undefined ? {} : { stateSubject: input.stateSubject }),
    ...(input.impactSubject === undefined ? {} : { impactSubject: input.impactSubject }),
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    signal,
  };
}

function renderRequest(
  input: z.infer<typeof eventRenderInputSchema>,
  context: ServerContext,
  signal: AbortSignal,
): EventRenderServiceInput {
  return {
    workspaceId: input.workspaceId,
    view: input.view,
    ...(input.selector === undefined
      ? {}
      : { selector: input.selector as NonNullable<EventRenderServiceInput['selector']> }),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
    ...(input.expandHelpers === undefined ? {} : { expandHelpers: input.expandHelpers }),
    ...(input.includeHtml === undefined ? {} : { includeHtml: input.includeHtml }),
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    signal,
  };
}

function compareRequest(
  input: z.infer<typeof eventCompareInputSchema>,
  context: ServerContext,
  signal: AbortSignal,
): EventCompareInput {
  return {
    workspaceId: input.workspaceId,
    ...(input.before === undefined
      ? {}
      : { before: input.before as NonNullable<EventCompareInput['before']> }),
    ...(input.after === undefined
      ? {}
      : { after: input.after as NonNullable<EventCompareInput['after']> }),
    ...(input.proposedSources === undefined
      ? {}
      : {
          proposedSources: input.proposedSources as NonNullable<
            EventCompareInput['proposedSources']
          >,
        }),
    ...(input.render === undefined ? {} : { render: input.render }),
    ...(input.maxRenderNodes === undefined ? {} : { maxRenderNodes: input.maxRenderNodes }),
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    signal,
  };
}

export function registerEventTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const viewer = new EventChainViewer(engine);

  server.registerTool(
    'hoi4.event_inspect',
    {
      title: 'Inspect event chains',
      description:
        'Scan, find roots, trace, explain paths, inspect state flow, lint, or assess impact. Full source-linked reports are resources.',
      inputSchema: eventInspectInputSchema,
      outputSchema: eventInspectOutputSchema,
      annotations: readOnlyEventTool,
    },
    async (input, extra) => {
      const { workspaceId } = input;
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Analyzing event chain');
        const inspected = await viewer.inspect(inspectRequest(input, context, progress.signal));
        await progress.report(2, 3, 'Linking complete event analysis');
        const result = emptyServiceResult(workspaceId, {
          mode: inspected.mode,
          revision: inspected.graph.revision,
          graphHash: inspected.graphHash,
          counts: graphCounts(inspected.graph, inspected.artifacts.length),
          boundary: {
            direction: input.direction ?? 'both',
            maxDepth: input.maxDepth ?? 8,
            maxNodes: input.maxNodes ?? 500,
            maxEdges: input.maxEdges ?? 2_000,
            expandHelpers: input.expandHelpers ?? (input.mode === 'explain_path' ? true : false),
            refresh: input.refresh ?? input.mode === 'scan',
          },
        });
        result.code = inspected.graph.complete ? 'EVENT_INSPECTED' : 'EVENT_INSPECTED_PARTIAL';
        setInlineFilesScanned(result, inspected.graph.filesScanned);
        result.artifacts = inspected.artifacts.map(publicArtifactLink);
        result.validation = graphValidation(inspected.graph);
        await progress.report(3, 3, 'Event inspection complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.event_render',
    {
      title: 'Render event chains',
      description:
        'Render deterministic JSON, SVG, PNG, and optional HTML for an event-chain view. Complete artifacts retain source links.',
      inputSchema: eventRenderInputSchema,
      outputSchema: eventRenderOutputSchema,
      annotations: readOnlyEventTool,
    },
    async (input, extra) => {
      const { workspaceId } = input;
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Rendering event-chain view');
        const rendered = await viewer.renderAndStore(
          renderRequest(input, context, progress.signal),
        );
        await progress.report(2, 3, 'Linking complete event renders');
        const result = emptyServiceResult(workspaceId, {
          view: rendered.render.view,
          revision: rendered.graph.revision,
          graphHash: rendered.graphHash,
          layoutHash: rendered.render.layout.layoutHash,
          hashes: rendered.render.hashes,
          counts: {
            ...graphCounts(rendered.graph, rendered.artifacts.length),
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
        result.validation = graphValidation(rendered.graph);
        await progress.report(3, 3, 'Event render complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.event_compare',
    {
      title: 'Compare event chains',
      description:
        'Compare cached, artifact-backed, current, or in-memory proposed event graphs without writing source. Full changes are resources.',
      inputSchema: eventCompareInputSchema,
      outputSchema: eventCompareOutputSchema,
      annotations: readOnlyEventTool,
    },
    async (input, extra) => {
      const { workspaceId } = input;
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Comparing event-chain graphs');
        const compared = await viewer.compareAndStore(
          compareRequest(input, context, progress.signal),
        );
        await progress.report(2, 3, 'Linking complete event comparison');
        const { comparison } = compared;
        const result = emptyServiceResult(workspaceId, {
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
        const beforeValidation = graphValidation(compared.before);
        const afterValidation = graphValidation(compared.after);
        result.validation = {
          passed: beforeValidation.passed && afterValidation.passed,
          checks: [...beforeValidation.checks, ...afterValidation.checks].map((check, index) => ({
            ...check,
            id: `${index === 0 ? 'before' : 'after'}-${check.id}`,
          })),
        };
        await progress.report(3, 3, 'Event comparison complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}
