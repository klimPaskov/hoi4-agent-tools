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
import type { CoreEngine } from '../../core/engine.js';
import {
  guiInspectRequestSchema,
  guiRenderRequestSchema,
  guiRewriteRequestSchema,
} from '../../schemas/gui-requests.js';
import type { ServerContext } from '../server/base-tools.js';
import {
  indexSkippedSourceSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
} from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

const countRecordSchema = z.record(z.string().max(256), nonNegativeIntegerSchema);
const guiScanOutputSchema = strictOperationResultSchema(
  z
    .object({
      sharedRevision: sha256Schema,
      complete: z.boolean(),
      skippedSourceCount: nonNegativeIntegerSchema,
      skippedSources: z.array(indexSkippedSourceSchema).max(100),
      nodes: nonNegativeIntegerSchema,
      edges: nonNegativeIntegerSchema,
      elements: nonNegativeIntegerSchema,
      sprites: nonNegativeIntegerSchema,
      fonts: nonNegativeIntegerSchema,
      scriptedGuis: nonNegativeIntegerSchema,
      windowName: z.string().max(256).optional(),
      scenarioId: z.string().max(256).optional(),
      inspectedElementCount: nonNegativeIntegerSchema.optional(),
      fidelityCounts: countRecordSchema.optional(),
    })
    .strict(),
);
const guiRenderOutputSchema = strictOperationResultSchema(
  z
    .object({
      windowName: z.string().max(256),
      scenarioId: z.string().max(256),
      sourceRevision: sha256Schema,
      variantCount: nonNegativeIntegerSchema,
      variants: z
        .array(
          z
            .object({
              variant: z.string().max(256),
              width: nonNegativeIntegerSchema,
              height: nonNegativeIntegerSchema,
            })
            .strict(),
        )
        .max(64),
      stateCount: nonNegativeIntegerSchema,
      scenarioCount: nonNegativeIntegerSchema,
      resolutionCount: nonNegativeIntegerSchema,
      comparison: z
        .object({ changedPixels: nonNegativeIntegerSchema, changedRatio: z.number().min(0).max(1) })
        .strict(),
      fidelityCounts: countRecordSchema,
      offlineRepresentation: z.literal(true),
    })
    .strict(),
);
export const guiPlanOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: z.enum(['source', 'helpers', 'patches']),
      execution: z.enum(['applied', 'blocked', 'unchanged']),
      nodeCount: nonNegativeIntegerSchema.optional(),
      templateInstanceCount: nonNegativeIntegerSchema.optional(),
      rawEscapeCount: nonNegativeIntegerSchema.optional(),
      fileCount: nonNegativeIntegerSchema,
      artifactCount: nonNegativeIntegerSchema,
    })
    .strict(),
);

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function guiTaskHandler(schema: z.ZodType) {
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

export function registerGuiTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  server.experimental.tasks.registerToolTask(
    'hoi4.gui_inspect',
    {
      title: 'Inspect scripted GUI',
      description: 'Inspect GUI sources and scenarios.',
      inputSchema: guiInspectRequestSchema,
      outputSchema: guiScanOutputSchema,
      annotations: artifactProducing,
      execution: { taskSupport: 'optional' },
    },
    guiTaskHandler(guiInspectRequestSchema) as unknown as ToolTaskHandler<
      typeof guiInspectRequestSchema
    >,
  );

  server.experimental.tasks.registerToolTask(
    'hoi4.gui_render',
    {
      title: 'Render scripted GUI artifacts',
      description:
        'Render GUI states, resolutions, generated or explicit scenarios, dynamic flags and text icons, hierarchy, comparisons, and diagnostics.',
      inputSchema: guiRenderRequestSchema,
      outputSchema: guiRenderOutputSchema,
      annotations: artifactProducing,
      execution: { taskSupport: 'optional' },
    },
    guiTaskHandler(guiRenderRequestSchema) as unknown as ToolTaskHandler<
      typeof guiRenderRequestSchema
    >,
  );

  server.experimental.tasks.registerToolTask(
    'hoi4.gui_rewrite',
    {
      title: 'Create or clean up scripted GUI',
      description:
        'Apply one validated source, helper, or exact-patch GUI package. Text dependencies use additionalFiles; binary art stays workspace-referenced.',
      inputSchema: guiRewriteRequestSchema,
      outputSchema: guiPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: 'optional' },
    },
    guiTaskHandler(guiRewriteRequestSchema) as unknown as ToolTaskHandler<
      typeof guiRewriteRequestSchema
    >,
  );
}
