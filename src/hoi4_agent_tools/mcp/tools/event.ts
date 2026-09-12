import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  ToolTaskHandler,
} from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
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

function eventTaskHandler(schema: z.ZodType) {
  return {
    createTask: async (input: unknown, extra: CreateTaskRequestHandlerExtra) => {
      schema.parse(input);
      return CreateTaskResultSchema.parse({
        task: await extra.taskStore.createTask({
          ttl: extra.taskRequestedTtl ?? null,
          pollInterval: 250,
        }),
      });
    },
    getTask: async (_input: unknown, extra: TaskRequestHandlerExtra) =>
      GetTaskResultSchema.parse(await extra.taskStore.getTask(extra.taskId)),
    getTaskResult: async (_input: unknown, extra: TaskRequestHandlerExtra) =>
      CallToolResultSchema.parse(await extra.taskStore.getTaskResult(extra.taskId)),
  };
}

export function registerEventTools(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'hoi4.event_inspect',
    {
      title: 'Inspect event chains',
      description:
        'Scan, find roots, trace, explain paths, inspect state flow, lint, or assess impact. Full source-linked reports are resources.',
      inputSchema: eventInspectInputSchema,
      outputSchema: eventInspectOutputSchema,
      annotations: readOnlyEventTool,
      execution: { taskSupport: 'optional' },
    },
    eventTaskHandler(eventInspectInputSchema) as unknown as ToolTaskHandler<
      typeof eventInspectInputSchema
    >,
  );

  server.experimental.tasks.registerToolTask(
    'hoi4.event_render',
    {
      title: 'Render event chains',
      description:
        'Render deterministic JSON, SVG, PNG, and optional HTML for an event-chain view. Complete artifacts retain source links.',
      inputSchema: eventRenderInputSchema,
      outputSchema: eventRenderOutputSchema,
      annotations: readOnlyEventTool,
      execution: { taskSupport: 'optional' },
    },
    eventTaskHandler(eventRenderInputSchema) as unknown as ToolTaskHandler<
      typeof eventRenderInputSchema
    >,
  );

  server.experimental.tasks.registerToolTask(
    'hoi4.event_compare',
    {
      title: 'Compare event chains',
      description:
        'Compare cached, artifact-backed, current, or in-memory proposed event graphs without writing source. Full changes are resources.',
      inputSchema: eventCompareInputSchema,
      outputSchema: eventCompareOutputSchema,
      annotations: readOnlyEventTool,
      execution: { taskSupport: 'optional' },
    },
    eventTaskHandler(eventCompareInputSchema) as unknown as ToolTaskHandler<
      typeof eventCompareInputSchema
    >,
  );
}
