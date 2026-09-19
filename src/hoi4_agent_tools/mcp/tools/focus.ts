import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod/v4';
import type { CoreEngine, ScanSnapshot } from '../../core/engine.js';
import {
  computeFocusVisualRevisions as computeCoreFocusVisualRevisions,
  type FocusVisualRevision,
  type FocusVisualRevisionSelector,
} from '../../focus/tool-operations.js';
import { focusLayoutMetricsSchema } from '../../schemas/focus.js';
import {
  focusInspectRequestSchema,
  focusRenderRequestSchema,
  focusRewriteRequestSchema,
} from '../../schemas/focus-requests.js';
import type { ServerContext } from '../server/base-tools.js';
import {
  nonNegativeIntegerSchema,
  renderHashesSchema,
  sha256Schema,
} from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

const focusInspectOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: z.enum(['national', 'continuous']),
      revision: sha256Schema,
      treeCount: nonNegativeIntegerSchema,
      paletteCount: nonNegativeIntegerSchema,
      trees: z
        .array(
          z
            .object({
              id: z.string().max(256),
              sourcePath: z.string().max(4096),
              focusCount: nonNegativeIntegerSchema,
              branchCount: nonNegativeIntegerSchema,
              continuousPaletteCount: nonNegativeIntegerSchema,
              continuousFocusCount: nonNegativeIntegerSchema,
              continuousFocusPosition: z
                .object({ x: z.number().int(), y: z.number().int() })
                .strict()
                .nullable(),
              continuousFocusPaletteIds: z.array(z.string().max(256)).max(100),
              resolvedTitleCount: nonNegativeIntegerSchema,
              layoutHash: sha256Schema,
              layoutDecisionCount: nonNegativeIntegerSchema,
              layoutMetrics: focusLayoutMetricsSchema,
              diagnosticCount: nonNegativeIntegerSchema,
            })
            .strict(),
        )
        .max(100),
      palettes: z
        .array(
          z
            .object({
              id: z.string().max(256),
              sourcePath: z.string().max(4096),
              focusCount: nonNegativeIntegerSchema,
              diagnosticCount: nonNegativeIntegerSchema,
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
);

const focusRenderOutputSchema = strictOperationResultSchema(
  z.discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('national'),
        treeId: z.string().max(256),
        layoutHash: sha256Schema,
        hashes: renderHashesSchema,
        width: nonNegativeIntegerSchema,
        height: nonNegativeIntegerSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal('continuous'),
        paletteId: z.string().max(256),
        focusCount: nonNegativeIntegerSchema,
        hashes: renderHashesSchema,
        width: nonNegativeIntegerSchema,
        height: nonNegativeIntegerSchema,
      })
      .strict(),
  ]),
);

const focusDriftOutputSchema = z
  .object({
    status: z.enum([
      'clean',
      'plan_changed',
      'source_changed_formatting',
      'source_changed_semantically',
      'converged',
      'conflict',
      'target_missing',
      'tree_removed',
    ]),
    sourceChanged: z.boolean(),
    planChanged: z.boolean(),
  })
  .strict();

const focusPlanOutputSchema = strictOperationResultSchema(
  z.discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('national'),
        treeId: z.string().max(256),
        drift: focusDriftOutputSchema,
        created: z.boolean(),
        execution: z.enum(['applied', 'blocked', 'unchanged']),
        layoutHash: sha256Schema,
        fileCount: nonNegativeIntegerSchema,
        artifactCount: nonNegativeIntegerSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal('continuous'),
        paletteId: z.string().max(256),
        drift: focusDriftOutputSchema,
        created: z.boolean(),
        execution: z.enum(['applied', 'blocked', 'unchanged']),
        fileCount: nonNegativeIntegerSchema,
        artifactCount: nonNegativeIntegerSchema,
      })
      .strict(),
  ]),
);

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type { FocusVisualRevision, FocusVisualRevisionSelector };

/** Compatibility wrapper retained for callers that supplied the signal separately. */
export function computeFocusVisualRevisions(
  engine: CoreEngine,
  context: ServerContext,
  workspaceId: string,
  snapshot: ScanSnapshot,
  selectors: readonly FocusVisualRevisionSelector[],
  signal?: AbortSignal,
): Promise<FocusVisualRevision[]> {
  return computeCoreFocusVisualRevisions(
    engine,
    {
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      ...(signal === undefined ? {} : { signal }),
    },
    workspaceId,
    snapshot,
    selectors,
  );
}

export const focusTaskTools = [
  {
    name: 'hoi4.focus_inspect',
    title: 'Inspect focus trees',
    description:
      'Inspect national trees or continuous palettes for creation and cleanup, including continuous-focus placement, complete plans, references, diagnostics, and stable layout decisions.',
    inputSchema: focusInspectRequestSchema,
    outputSchema: focusInspectOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.focus_render',
    title: 'Render focus review artifacts',
    description:
      'Render a national tree or continuous palette as fast deterministic HTML, SVG, JSON, and source-map artifacts. Use hoi4.focus_raster when decoded icons and PNG output are needed.',
    inputSchema: focusRenderRequestSchema,
    outputSchema: focusRenderOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.focus_raster',
    title: 'Rasterize focus review artifacts',
    description:
      'Produce the high-fidelity focus review with decoded source icons and deterministic PNG output. Use focus_render for the faster structural HTML, SVG, and JSON view.',
    inputSchema: focusRenderRequestSchema,
    outputSchema: focusRenderOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.focus_rewrite',
    title: 'Create or clean up focus content',
    description:
      'Create or clean up a national tree or continuous palette, validate it, and apply it in one call. Supply a complete plan; set layoutMode compact for automatic arrangement. Existing national trees can omit the plan and use treeId plus layoutMode compact. Set createIfMissing for a new file.',
    inputSchema: focusRewriteRequestSchema,
    outputSchema: focusPlanOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerFocusTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, focusTaskTools);
}
