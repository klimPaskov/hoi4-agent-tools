import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import { canonicalJson, compareCodeUnits, hashCanonical } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import {
  renderDimensionViolation,
  RenderBudget,
  RENDER_MAX_DIMENSION,
} from '../../core/render-budget.js';
import { emptyServiceResult, ServiceError } from '../../core/result.js';
import { SOURCE_MAX_BYTES } from '../../core/source/index.js';
import {
  GuiHelperDocumentSchema,
  GuiPreviewScenarioSchema,
  GUI_TEXT_PACKAGE_MAX_FILES,
  ScriptedGuiStudio,
  compileGuiHelpers,
  type GuiPreviewState,
  type GuiValidationResult,
} from '../../gui/index.js';
import {
  encodeGuiInspectionArtifact,
  projectGuiGraphForArtifact,
} from '../../gui/inspection-artifact.js';
import { workspaceIdSchema, workspaceRelativePathSchema } from '../../schemas/common.js';
import { PACKAGE_VERSION } from '../../version.js';
import { requireServerScope, type ServerContext } from '../server/base-tools.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import {
  autonomousFailureContext,
  autonomousResultArtifacts,
  executePlannedTransaction,
} from '../server/transaction-execution.js';
import {
  indexSkippedSourceSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
} from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';

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

const previewStateSchema = z.enum([
  'normal',
  'hover',
  'selected',
  'locked',
  'disabled',
  'warning',
  'active',
  'completed',
  'empty-list',
  'full-list',
  'minimum-value',
  'maximum-value',
  'long-text',
  'missing-localisation',
]);

const compactGuiScenarioSchema = compactValidatedInputSchema(
  GuiPreviewScenarioSchema,
  `Complete GUI preview scenario: https://github.com/klimPaskov/hoi4-agent-tools/blob/v${PACKAGE_VERSION}/docs/gui.md`,
);
const compactGuiHelperSchema = compactValidatedInputSchema(
  GuiHelperDocumentSchema,
  `Complete GUI helper document: https://github.com/klimPaskov/hoi4-agent-tools/blob/v${PACKAGE_VERSION}/docs/gui.md`,
);

const guiBaseInput = z
  .object({
    workspaceId: workspaceIdSchema,
    windowName: z.string().min(1).max(256),
    scenario: compactGuiScenarioSchema,
  })
  .strict();

const guiInspectInput = z
  .object({
    workspaceId: workspaceIdSchema,
    windowName: z.string().min(1).max(256).optional(),
    scenario: compactGuiScenarioSchema.optional(),
    relatedScenarios: z.array(compactGuiScenarioSchema).max(32).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.windowName === undefined) !== (value.scenario === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'windowName and scenario must be provided together',
      });
    }
    if (value.relatedScenarios !== undefined && value.scenario === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['relatedScenarios'],
        message: 'relatedScenarios requires a window scenario',
      });
    }
  });

const resolutionSchema = z
  .object({
    width: z.number().int().min(320).max(RENDER_MAX_DIMENSION),
    height: z.number().int().min(200).max(RENDER_MAX_DIMENSION),
    uiScale: z.number().min(0.25).max(4).optional(),
  })
  .strict()
  .superRefine(({ width, height }, context) => {
    const violation = renderDimensionViolation(width, height, 'GUI matrix resolution');
    if (violation !== undefined) {
      context.addIssue({ code: 'custom', message: `${violation.code}: ${violation.message}` });
    }
  });

function validationSummary(validation: GuiValidationResult): {
  passed: boolean;
  checks: GuiValidationResult['checks'];
} {
  return {
    passed:
      validation.checks.every(({ passed }) => passed) &&
      !validation.diagnostics.some(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    checks: validation.checks,
  };
}

export function registerGuiTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const studio = new ScriptedGuiStudio(engine);

  server.registerTool(
    'hoi4.gui_inspect',
    {
      title: 'Inspect scripted GUI',
      description:
        'Inspect GUI, GFX, script, localisation, and animation sources. Window/scenario selectors add offline visual and interaction diagnostics.',
      inputSchema: guiInspectInput,
      outputSchema: guiScanOutputSchema,
      annotations: artifactProducing,
    },
    async (
      { workspaceId: requestedWorkspaceId, windowName, scenario, relatedScenarios },
      extra,
    ) => {
      const workspaceId = engine.resolver.resolveWorkspaceId(
        requestedWorkspaceId,
        context.principal,
      );
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Building GUI source graph');
        const inspection =
          windowName === undefined || scenario === undefined
            ? studio
                .scan(workspaceId, context.principal, progress.signal)
                .then(({ graph }) => ({ graph, linted: undefined }))
            : studio
                .lint({
                  workspaceId,
                  windowName,
                  scenario,
                  ...(relatedScenarios === undefined ? {} : { relatedScenarios }),
                  ...(context.principal === undefined ? {} : { principal: context.principal }),
                  signal: progress.signal,
                })
                .then((linted) => ({ graph: linted.graph, linted }));
        const inspected = await inspection;
        const { graph, linted } = inspected;
        const sharedRevision = hashCanonical(graph.sourceHashes);
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const sourceEvidence = boundedSourceHashEvidence(graph.sourceHashes);
        const artifactGraph = projectGuiGraphForArtifact(
          graph,
          linted?.scene.elements.map(({ sourceId }) => sourceId),
        );
        const inspectionName = `gui-inspect.${sharedRevision.slice(0, 16)}.json`;
        const inspectionJson = `${canonicalJson({
          schemaVersion: 1,
          sharedRevision,
          offline: true,
          graph: artifactGraph.graph,
          ...(artifactGraph.projection === undefined
            ? {}
            : { graphProjection: artifactGraph.projection }),
          ...(linted === undefined
            ? {}
            : {
                scenario: linted.scene.scenario,
                fidelity: linted.scene.fidelity,
                validation: linted.validation,
              }),
        })}\n`;
        const encodedInspection = await encodeGuiInspectionArtifact(inspectionName, inspectionJson);
        const artifact = await engine.artifacts.putChunked(
          workspace,
          encodedInspection.name,
          encodedInspection.mimeType,
          encodedInspection.content,
          {
            kind: 'gui-inspect',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'gui-inspect.v1',
            sourceHashes: sourceEvidence.sourceHashes,
            metadata: {
              sharedRevision,
              offline: true,
              complete: graph.complete,
              skippedSourceCount: graph.skippedSourceCount,
              sourceHashInventory: sourceEvidence.inventory,
              compressed: encodedInspection.compressed,
              uncompressedBytes: encodedInspection.uncompressedBytes,
              graphProjection: artifactGraph.projection?.mode ?? 'full',
            },
          },
          encodedInspection.compressed
            ? 'Gzip-compressed scripted GUI graph, diagnostics, and optional scenario fidelity inspection'
            : 'Scripted GUI graph, diagnostics, and optional scenario fidelity inspection',
          progress.signal,
        );
        const diagnostics =
          linted === undefined ? graph.diagnostics : linted.validation.diagnostics;
        const result = emptyServiceResult(workspaceId, {
          sharedRevision,
          complete: graph.complete,
          skippedSourceCount: graph.skippedSourceCount,
          skippedSources: graph.skippedSources,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          elements: graph.elements.length,
          sprites: graph.sprites.length,
          fonts: graph.fonts.length,
          scriptedGuis: graph.scriptedGuis.length,
          ...(linted === undefined
            ? {}
            : {
                windowName,
                scenarioId: linted.scene.scenario.id,
                inspectedElementCount: linted.scene.elements.length,
                fidelityCounts: Object.fromEntries(
                  Object.entries(linted.scene.fidelity).map(([key, values]) => [
                    key,
                    values.length,
                  ]),
                ),
              }),
        });
        result.code = graph.complete ? 'GUI_INSPECTED' : 'GUI_INSPECTED_PARTIAL';
        setInlineFilesScanned(result, graph.filesScanned);
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(artifact)];
        result.validation =
          linted === undefined
            ? {
                passed: !diagnostics.some(
                  ({ severity }) => severity === 'error' || severity === 'blocker',
                ),
                checks: [
                  {
                    id: 'gui-inspection',
                    passed: true,
                    message: graph.complete
                      ? `${graph.nodes.length} GUI graph nodes connected from a complete inventory`
                      : `${graph.nodes.length} GUI graph nodes connected; ${graph.skippedSourceCount} over-limit source(s) were skipped`,
                  },
                ],
              }
            : validationSummary({ diagnostics, checks: linted.validation.checks });
        await progress.report(3, 3, 'GUI inspection complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  const render = async (
    input: {
      workspaceId: string;
      windowName: string;
      scenario: unknown;
      states?: GuiPreviewState[] | undefined;
      resolutions?:
        Array<{ width: number; height: number; uiScale?: number | undefined }> | undefined;
      comparisonScenario?: unknown;
    },
    extra: Parameters<typeof progressReporter>[0],
    code: 'GUI_RENDERED' | 'GUI_STATES_RENDERED',
  ): Promise<ReturnType<typeof toolResult>> => {
    const workspaceId = engine.resolver.resolveWorkspaceId(input.workspaceId, context.principal);
    const { windowName } = input;
    try {
      const progress = progressReporter(extra);
      await progress.report(0, 4, 'Building GUI source graph');
      const rendered = await studio.renderAndStore({
        workspaceId,
        windowName,
        scenario: input.scenario,
        ...(input.states === undefined ? {} : { states: input.states }),
        ...(input.resolutions === undefined
          ? {}
          : {
              resolutions: input.resolutions.map(({ width, height, uiScale }) => ({
                width,
                height,
                ...(uiScale === undefined ? {} : { uiScale }),
              })),
            }),
        ...(input.comparisonScenario === undefined
          ? {}
          : { comparisonScenario: input.comparisonScenario }),
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        signal: progress.signal,
      });
      await progress.report(3, 4, 'Preparing GUI result');
      const diagnostics = rendered.validation.diagnostics;
      const result = emptyServiceResult(workspaceId, {
        windowName,
        scenarioId: rendered.render.scene.scenario.id,
        sourceRevision: rendered.render.scene.sourceRevision,
        variantCount: rendered.render.images.length,
        variants: rendered.render.images.slice(0, 64).map(({ variant, width, height }) => ({
          variant,
          width,
          height,
        })),
        stateCount: rendered.stateScenes.length,
        resolutionCount: rendered.resolutionScenes.length,
        comparison: {
          changedPixels: rendered.comparison.changedPixels,
          changedRatio: rendered.comparison.changedRatio,
        },
        fidelityCounts: Object.fromEntries(
          Object.entries(rendered.render.fidelity).map(([key, values]) => [key, values.length]),
        ),
        offlineRepresentation: true,
      });
      result.code = code;
      setInlineFilesScanned(result, rendered.filesScanned);
      result.diagnostics = diagnostics.slice(0, 100);
      result.artifacts = rendered.artifacts.map(publicArtifactLink);
      result.validation = validationSummary({
        diagnostics,
        checks: rendered.validation.checks,
      });
      await progress.report(4, 4, 'GUI render complete');
      return toolResult(result);
    } catch (error) {
      return errorResult(error, workspaceId);
    }
  };

  const renderInput = guiBaseInput
    .extend({
      states: z.array(previewStateSchema).max(14).optional(),
      resolutions: z.array(resolutionSchema).min(1).max(16).optional(),
      comparisonScenario: compactGuiScenarioSchema.optional(),
    })
    .strict()
    .superRefine(({ scenario, states, resolutions }, context) => {
      const budget = new RenderBudget();
      try {
        const stateCount = states?.length ?? 14;
        for (let index = 0; index < 9 + stateCount; index += 1) {
          budget.reserve(
            scenario.resolution.width,
            scenario.resolution.height,
            'GUI request variant',
          );
        }
        for (const resolution of resolutions ?? [
          { width: 1280, height: 720 },
          { width: 1920, height: 1080 },
          { width: 2560, height: 1440 },
          { width: 1920, height: 1080 },
        ]) {
          budget.reserve(resolution.width, resolution.height, 'GUI resolution variant');
        }
        const stateColumns = Math.min(3, Math.max(1, stateCount));
        const stateRows = Math.max(1, Math.ceil(stateCount / stateColumns));
        budget.reserve(stateColumns * 420, 46 + stateRows * 280, 'GUI state gallery');
        const resolutionCount = resolutions?.length ?? 4;
        const resolutionColumns = Math.min(3, Math.max(1, resolutionCount));
        const resolutionRows = Math.max(1, Math.ceil(resolutionCount / resolutionColumns));
        budget.reserve(
          resolutionColumns * 420,
          46 + resolutionRows * 280,
          'GUI resolution gallery',
        );
      } catch (error) {
        if (error instanceof ServiceError) {
          context.addIssue({ code: 'custom', message: `${error.code}: ${error.message}` });
          return;
        }
        throw error;
      }
    });

  server.registerTool(
    'hoi4.gui_render',
    {
      title: 'Render scripted GUI artifacts',
      description: 'Render deterministic offline review artifacts for one GUI window and scenario.',
      inputSchema: renderInput,
      outputSchema: guiRenderOutputSchema,
      annotations: artifactProducing,
    },
    (input, extra) => render(input, extra, 'GUI_RENDERED'),
  );

  server.registerTool(
    'hoi4.gui_rewrite',
    {
      title: 'Create or clean up scripted GUI',
      description:
        'Apply one validated source, helper, or exact-patch GUI package. Text dependencies use additionalFiles; binary art stays workspace-referenced.',
      inputSchema: z
        .object({
          mode: z.enum(['source', 'helpers', 'patches']),
          workspaceId: workspaceIdSchema,
          relativePath: workspaceRelativePathSchema,
          windowName: z.string().min(1).max(256),
          scenario: compactGuiScenarioSchema,
          source: z.string().max(SOURCE_MAX_BYTES).optional(),
          helper: compactGuiHelperSchema.optional(),
          additionalFiles: z
            .array(
              z
                .object({
                  relativePath: workspaceRelativePathSchema,
                  source: z.string().max(SOURCE_MAX_BYTES),
                })
                .strict(),
            )
            .max(GUI_TEXT_PACKAGE_MAX_FILES - 1)
            .optional(),
          expectedSourceHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
          patches: z
            .array(
              z
                .object({
                  start: z.number().int().min(0),
                  end: z.number().int().min(0),
                  expectedText: z.string().max(5_000_000),
                  text: z.string().max(5_000_000),
                  description: z.string().min(1).max(1000),
                })
                .strict(),
            )
            .min(1)
            .max(1000)
            .optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.mode === 'source' && value.source === undefined) {
            context.addIssue({ code: 'custom', message: 'source is required in source mode' });
          }
          if (value.mode === 'helpers' && value.helper === undefined) {
            context.addIssue({ code: 'custom', message: 'helper is required in helpers mode' });
          }
          if (
            value.mode === 'patches' &&
            (value.patches === undefined || value.expectedSourceHash === undefined)
          ) {
            context.addIssue({
              code: 'custom',
              message: 'patches and expectedSourceHash are required in patches mode',
            });
          }
          if (value.mode === 'source' && value.helper !== undefined) {
            context.addIssue({ code: 'custom', message: 'helper is forbidden in source mode' });
          }
          if (value.mode === 'helpers' && value.source !== undefined) {
            context.addIssue({ code: 'custom', message: 'source is forbidden in helpers mode' });
          }
          if (
            value.mode !== 'patches' &&
            (value.patches !== undefined || value.expectedSourceHash !== undefined)
          ) {
            context.addIssue({
              code: 'custom',
              message: 'patch fields are accepted only in patches mode',
            });
          }
          if (
            value.mode === 'patches' &&
            (value.source !== undefined ||
              value.helper !== undefined ||
              value.additionalFiles !== undefined)
          ) {
            context.addIssue({
              code: 'custom',
              message: 'source, helper, and additionalFiles are forbidden in patches mode',
            });
          }
        }),
      outputSchema: guiPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const workspaceId = engine.resolver.resolveWorkspaceId(input.workspaceId, context.principal);
      const { relativePath, windowName, scenario } = input;
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Validating the requested GUI result');
        const compilation = input.mode === 'helpers' ? compileGuiHelpers(input.helper!) : undefined;
        const plannedTransaction = await studio.planSource({
          workspaceId,
          relativePath,
          ...(input.mode === 'patches'
            ? {
                expectedSourceHash: input.expectedSourceHash!,
                patches: input.patches!,
              }
            : {
                source: input.mode === 'source' ? input.source! : compilation!.source,
                ...(input.additionalFiles === undefined
                  ? {}
                  : { additionalFiles: input.additionalFiles }),
              }),
          windowName,
          scenario,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        });
        await progress.report(2, 3, 'Applying and validating the GUI rewrite');
        const execution = await executePlannedTransaction(
          engine,
          plannedTransaction,
          context.principal,
          progress.signal,
        );
        const transaction = execution.transaction;
        const planned = {
          transaction,
          compilation,
        };
        const result = emptyServiceResult(workspaceId, {
          mode: input.mode,
          execution: execution.outcome,
          fileCount: transaction.files.length,
          artifactCount: transaction.artifacts.length,
          ...(planned.compilation === undefined
            ? {}
            : {
                nodeCount: planned.compilation.nodeCount,
                templateInstanceCount: planned.compilation.templateInstanceCount,
                rawEscapeCount: planned.compilation.rawEscapeCount,
              }),
        });
        result.status = transaction.validation.passed ? 'ok' : 'blocked';
        result.code =
          execution.outcome === 'applied'
            ? 'GUI_CHANGES_APPLIED'
            : execution.outcome === 'unchanged'
              ? 'GUI_CHANGES_UNCHANGED'
              : 'GUI_CHANGES_BLOCKED';
        setInlineFilesScanned(
          result,
          [
            relativePath,
            ...(input.additionalFiles ?? []).map(({ relativePath: file }) => file),
          ].sort((left, right) => compareCodeUnits(left, right)),
        );
        result.proposedFiles = transaction.files
          .slice(0, 100)
          .map(({ relativePath: file }) => file);
        result.changedFiles = transaction.appliedFiles.slice(0, 100);
        result.diagnostics = transaction.diagnostics.slice(0, 100);
        result.artifacts = autonomousResultArtifacts(execution);
        result.validation = transaction.validation;
        result.blockers = transaction.diagnostics
          .filter(({ severity }) => severity === 'error' || severity === 'blocker')
          .map(({ code, message, details }) => ({
            code,
            message,
            ...(details === undefined ? {} : { details }),
          }));
        await progress.report(
          3,
          3,
          execution.outcome === 'applied'
            ? 'GUI rewrite complete'
            : execution.outcome === 'unchanged'
              ? 'GUI content already satisfied the rewrite'
              : 'GUI rewrite blocked',
        );
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId, autonomousFailureContext(error));
      }
    },
  );
}
