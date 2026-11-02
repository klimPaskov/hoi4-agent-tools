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
import {
  focusLayoutDeltaSchema,
  focusLayoutMetricsSchema,
  focusLayoutQualitySchema,
} from '../../schemas/focus.js';
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
      layoutVerdict: z.enum(['blocked', 'revise', 'review', 'pass']).optional(),
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
              layoutQuality: focusLayoutQualitySchema.optional(),
              layoutDelta: focusLayoutDeltaSchema.optional(),
              diagnosticCount: nonNegativeIntegerSchema,
              scenarioSummary: z
                .object({
                  completed: nonNegativeIntegerSchema,
                  blocked: nonNegativeIntegerSchema,
                  unresolved: nonNegativeIntegerSchema,
                  structuralCandidates: nonNegativeIntegerSchema,
                  choiceConflictCount: nonNegativeIntegerSchema,
                })
                .strict()
                .optional(),
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
        layoutQuality: focusLayoutQualitySchema.optional(),
        inlineImages: z
          .array(
            z
              .object({
                kind: z.enum(['overview', 'branch', 'focus', 'problem']),
                label: z.string().max(300),
                focusIds: z.array(z.string().max(256)).max(50),
                region: z
                  .object({
                    minimumX: z.number().int(),
                    maximumX: z.number().int(),
                    minimumY: z.number().int(),
                    maximumY: z.number().int(),
                  })
                  .strict(),
                width: nonNegativeIntegerSchema,
                height: nonNegativeIntegerSchema,
                bytes: nonNegativeIntegerSchema,
              })
              .strict(),
          )
          .max(6)
          .optional(),
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

const engineShiftOutputSchema = z
  .object({
    fromX: z.number().int(),
    columns: z.number().int().min(1),
    direction: z.enum(['right', 'left']),
    focusIds: z.array(z.string().max(256)),
  })
  .strict();

/** What the focus layout engine did (layoutMode engine or placement). */
const focusEngineLayoutOutputSchema = z
  .object({
    operation: z.enum(['layout', 'insert']),
    status: z.literal('ok'),
    hashes: z
      .object({
        layout: sha256Schema.nullable(),
        untouched: sha256Schema,
        prerequisites: sha256Schema,
        exclusions: sha256Schema,
      })
      .strict(),
    metrics: z
      .object({
        columns: nonNegativeIntegerSchema,
        rows: nonNegativeIntegerSchema,
        orthogonalCrossings: nonNegativeIntegerSchema,
        stemsThroughPlaques: nonNegativeIntegerSchema,
        mergedBars: nonNegativeIntegerSchema,
      })
      .strict(),
    movedFocusIds: z.array(z.string().max(256)).max(100),
    movedFocusCount: nonNegativeIntegerSchema,
    shifted: z.array(engineShiftOutputSchema).optional(),
    binarySource: z.enum(['environment', 'package']),
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
        layoutQuality: focusLayoutQualitySchema.optional(),
        layoutDelta: focusLayoutDeltaSchema.optional(),
        compactOutcome: z
          .object({
            outcome: z.literal('nothing_to_improve'),
            reason: z.enum(['verdict_pass', 'no_better_candidate', 'candidates_regress']),
            blockedBy: z.array(z.string().max(64)).max(10),
          })
          .strict()
          .optional(),
        engine: focusEngineLayoutOutputSchema.optional(),
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
      'Check a focus tree\'s structure and layout. Returns blocking errors, a layout verdict (pass, review, revise, blocked) with the metrics behind it, a fix for each failing metric and next actions. Revise or blocked means the tree is not finished, however clean its structure; review is advisory, so look at hoi4.focus_render. Example: {"treeId":"my_focus_tree"}. The full report is a linked resource.',
    inputSchema: focusInspectRequestSchema,
    outputSchema: focusInspectOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.focus_render',
    title: 'Preview a focus tree or continuous palette',
    description:
      'Render a focus tree in the in-game style (right-angle connectors) and return it inline, with close-ups of the worst places; cropBranchIds and cropFocusIds add more. Look before you judge a layout: metrics cannot see composition. Also exports PNG with icons, HTML, SVG and JSON as linked artifacts. Example: {"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree"}.',
    inputSchema: focusRenderRequestSchema,
    outputSchema: focusRenderOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.focus_rewrite',
    title: 'Build or arrange a focus tree',
    description:
      'Create or repair a focus tree or palette. New trees: lanes and position mode auto; x/y only for exact anchors. layoutMode compact repairs a layout (compactFocusIds picks a branch, pinnedFocusIds keeps neighbours); engine lays out with the Rust engine; placement adds focuses, moving no others; both need hoi4-engine. Keeps prerequisites and rewards. Returns files, layout verdict and delta. Example: {"relativePath":"common/national_focus/my_tree.txt","treeId":"my_focus_tree","layoutMode":"compact"}.',
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
