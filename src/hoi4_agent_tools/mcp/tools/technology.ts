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
  technologyAnalysisModeSchema,
  technologyCompareRequestSchema,
  technologyGraphReferenceSchema,
  technologyImpactSchema,
  technologyInspectRequestSchema,
  technologyProposedSourceSchema,
  technologyRenderRequestSchema,
  technologyRenderViewSchema,
  validateTechnologyCompareRequest,
  validateTechnologyInspectRequest,
} from '../../schemas/technology.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

const inspectInputSchema = z
  .object({
    ...technologyInspectRequestSchema.shape,
    impact: compactValidatedInputSchema(
      technologyImpactSchema,
      'Rename or removal subject.',
    ).optional(),
  })
  .strict()
  .superRefine(validateTechnologyInspectRequest);

const renderInputSchema = z.object({ ...technologyRenderRequestSchema.shape }).strict();

const compareInputSchema = z
  .object({
    ...technologyCompareRequestSchema.shape,
    before: compactValidatedInputSchema(
      technologyGraphReferenceSchema,
      'Revision or graph resource.',
    ).optional(),
    after: compactValidatedInputSchema(
      technologyGraphReferenceSchema,
      'Revision or graph resource.',
    ).optional(),
    proposedSources: z
      .array(
        compactValidatedInputSchema(technologyProposedSourceSchema, 'In-memory source overlay.'),
      )
      .min(1)
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine(validateTechnologyCompareRequest);

const countsSchema = z
  .object({
    technologies: nonNegativeIntegerSchema,
    legacyDoctrines: nonNegativeIntegerSchema,
    folders: nonNegativeIntegerSchema,
    placements: nonNegativeIntegerSchema,
    edges: nonNegativeIntegerSchema,
    unlocks: nonNegativeIntegerSchema,
    references: nonNegativeIntegerSchema,
    issues: nonNegativeIntegerSchema,
    unresolved: nonNegativeIntegerSchema,
    artifacts: nonNegativeIntegerSchema,
  })
  .strict();

const analysisOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: technologyAnalysisModeSchema,
      revision: sha256Schema,
      graphHash: sha256Schema,
      counts: countsSchema,
    })
    .strict(),
);

const renderOutputSchema = strictOperationResultSchema(
  z
    .object({
      view: technologyRenderViewSchema,
      revision: sha256Schema,
      graphHash: sha256Schema,
      hashes: z
        .object({
          json: sha256Schema,
          svg: sha256Schema,
          png: sha256Schema,
          html: sha256Schema.optional(),
        })
        .strict(),
      selectedNodes: nonNegativeIntegerSchema,
      omittedNodes: nonNegativeIntegerSchema,
      focusedRenders: nonNegativeIntegerSchema,
      sourceAccurate: z.boolean(),
    })
    .strict(),
);

const compareOutputSchema = strictOperationResultSchema(
  z
    .object({
      beforeRevision: sha256Schema,
      afterRevision: sha256Schema,
      added: nonNegativeIntegerSchema,
      removed: nonNegativeIntegerSchema,
      renamed: nonNegativeIntegerSchema,
      moved: nonNegativeIntegerSchema,
      regressions: nonNegativeIntegerSchema,
      artifacts: nonNegativeIntegerSchema,
      renderHashes: z
        .object({ json: sha256Schema, svg: sha256Schema, png: sha256Schema })
        .strict()
        .optional(),
    })
    .strict(),
);

const readOnlyTechnologyTool = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function technologyTaskHandler(schema: z.ZodType) {
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

export function registerTechnologyTools(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'hoi4.tech_inspect',
    {
      title: 'Inspect technology trees',
      description:
        'Scan, discover folders, trace, explain, inspect unlocks or bonuses, lint, and assess impact.',
      inputSchema: inspectInputSchema,
      outputSchema: analysisOutputSchema,
      annotations: readOnlyTechnologyTool,
      execution: { taskSupport: 'optional' },
    },
    technologyTaskHandler(inspectInputSchema) as unknown as ToolTaskHandler<
      typeof inspectInputSchema
    >,
  );

  server.experimental.tasks.registerToolTask(
    'hoi4.tech_render',
    {
      title: 'Render technology trees',
      description: 'Render source-linked JSON, SVG, PNG, and optional HTML technology views.',
      inputSchema: renderInputSchema,
      outputSchema: renderOutputSchema,
      annotations: readOnlyTechnologyTool,
      execution: { taskSupport: 'optional' },
    },
    technologyTaskHandler(renderInputSchema) as unknown as ToolTaskHandler<
      typeof renderInputSchema
    >,
  );

  server.experimental.tasks.registerToolTask(
    'hoi4.tech_compare',
    {
      title: 'Compare technology trees',
      description:
        'Compare cached, resource-backed, current, or proposed source graphs without writes.',
      inputSchema: compareInputSchema,
      outputSchema: compareOutputSchema,
      annotations: readOnlyTechnologyTool,
      execution: { taskSupport: 'optional' },
    },
    technologyTaskHandler(compareInputSchema) as unknown as ToolTaskHandler<
      typeof compareInputSchema
    >,
  );
}
