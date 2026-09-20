import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod/v4';
import {
  helperExpansionRequestSchema,
  helperExpansionSummarySchema,
} from '../../schemas/helper-expansion.js';
import {
  eventDirectionSchema,
  eventGraphReferenceSchema,
  eventImpactSubjectSchema,
  eventInspectModeSchema,
  eventProposedSourceSchema,
  eventRenderViewSchema,
  eventSelectorSchema,
  eventInspectRequestSchema,
  eventRenderRequestSchema,
  eventCompareRequestSchema,
  validateEventCompareRequest,
  validateEventInspectRequest,
  eventStateSubjectSchema,
} from '../../schemas/event.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

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
    ...eventInspectRequestSchema.shape,
    selector: nestedSelectorSchema.optional(),
    from: nestedSelectorSchema.optional(),
    to: nestedSelectorSchema.optional(),
    stateSubject: nestedStateSubjectSchema.optional(),
    impactSubject: nestedImpactSubjectSchema.optional(),
    helperExpansion: compactValidatedInputSchema(
      helperExpansionRequestSchema,
      'Bounded helper paths; opaque continuationUri resumes the same source and roots. See docs/events.md.',
    ).optional(),
  })
  .strict()
  .superRefine(validateEventInspectRequest);

const eventRenderInputSchema = z
  .object({
    ...eventRenderRequestSchema.shape,
    selector: nestedSelectorSchema.optional(),
  })
  .strict();

const eventCompareInputSchema = z
  .object({
    ...eventCompareRequestSchema.shape,
    selector: nestedSelectorSchema.optional(),
    before: nestedGraphReferenceSchema.optional(),
    after: nestedGraphReferenceSchema.optional(),
    proposedSources: z.array(nestedProposedSourceSchema).min(1).max(64).optional(),
  })
  .strict()
  .superRefine(validateEventCompareRequest);

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
      analysisMode: z.enum(['full', 'focused']),
      revision: sha256Schema,
      graphHash: sha256Schema,
      counts: eventGraphCountsSchema,
      helperExpansion: helperExpansionSummarySchema.optional(),
      boundary: inspectBoundarySchema,
    })
    .strict(),
);

const eventRenderOutputSchema = strictOperationResultSchema(
  z
    .object({
      view: eventRenderViewSchema,
      analysisMode: z.enum(['full', 'focused']),
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
          selectedChanges: nonNegativeIntegerSchema.optional(),
          omittedChanges: nonNegativeIntegerSchema.optional(),
          unattributedChanges: nonNegativeIntegerSchema.optional(),
          selectedBeforeNodes: nonNegativeIntegerSchema.optional(),
          selectedAfterNodes: nonNegativeIntegerSchema.optional(),
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
          selector: eventSelectorSchema.optional(),
          maxChainNodes: nonNegativeIntegerSchema.optional(),
          selectionTruncated: z.boolean().optional(),
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

export const eventTaskTools = [
  {
    name: 'hoi4.event_inspect',
    title: 'Inspect event chains',
    description:
      'Scan, find roots, trace, explain paths, inspect state flow, lint, or assess impact. Full source-linked reports are resources.',
    inputSchema: eventInspectInputSchema,
    outputSchema: eventInspectOutputSchema,
    annotations: readOnlyEventTool,
  },
  {
    name: 'hoi4.event_render',
    title: 'Render event chains',
    description:
      'Render deterministic JSON, SVG, PNG, and optional HTML for an event-chain view. Complete artifacts retain source links.',
    inputSchema: eventRenderInputSchema,
    outputSchema: eventRenderOutputSchema,
    annotations: readOnlyEventTool,
  },
  {
    name: 'hoi4.event_compare',
    title: 'Compare event chains',
    description:
      'Compare cached, artifact-backed, current, or in-memory proposed event graphs, optionally selecting one downstream chain. Full changes and explicit selection coverage are resources.',
    inputSchema: eventCompareInputSchema,
    outputSchema: eventCompareOutputSchema,
    annotations: readOnlyEventTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerEventTools(server: McpServer): void {
  registerLegacyTaskTools(server, eventTaskTools);
}
