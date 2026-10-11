import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
      sourceComparison: z
        .object({ changedPixels: nonNegativeIntegerSchema, changedRatio: z.number().min(0).max(1) })
        .strict()
        .optional(),
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

export const guiTaskTools = [
  {
    name: 'hoi4.gui_inspect',
    title: 'Inspect a window',
    description:
      'Find the elements, assets and script behind a window, including layout problems, localisation and fonts. Example: {"windowName":"my_window"}. Returns element counts and fidelity inline; the full scene is a linked resource.',
    inputSchema: guiInspectRequestSchema,
    outputSchema: guiScanOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.gui_render',
    title: 'Preview a window',
    description:
      'Preview a window at different resolutions and states. Shows control regions, element hierarchy and layout problems; unknown visibility stays unresolved. Example: {"windowName":"my_window","scenario":{"id":"normal","flags":{"my_flag":true}}}. Images and reports are linked resources.',
    inputSchema: guiRenderRequestSchema,
    outputSchema: guiRenderOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.gui_rewrite',
    title: 'Create or edit a window',
    description:
      'Create or edit a window using complete source, structured helpers or exact patches. Include related text files with additionalFiles; binary art must already be in the mod. Example: {"mode":"helpers","relativePath":"interface/my_window.gui","windowName":"my_window","scenario":{"id":"normal"},"helper":{...}}. Returns the changed files.',
    inputSchema: guiRewriteRequestSchema,
    outputSchema: guiPlanOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerGuiTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, guiTaskTools);
}
