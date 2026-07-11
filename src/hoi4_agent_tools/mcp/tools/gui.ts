import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import { canonicalJson } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import {
  renderDimensionViolation,
  RenderBudget,
  RENDER_MAX_DIMENSION,
} from '../../core/render-budget.js';
import { emptyServiceResult, ServiceError } from '../../core/result.js';
import {
  GuiHelperDocumentSchema,
  GuiPreviewScenarioSchema,
  ScriptedGuiStudio,
  compileGuiHelpers,
  guiArtifactProvenance,
  type GuiPreviewState,
  type GuiValidationResult,
} from '../../gui/index.js';
import { workspaceIdSchema, workspaceRelativePathSchema } from '../../schemas/common.js';
import { PACKAGE_VERSION } from '../../version.js';
import {
  requireServerScope,
  transactionResourceLink,
  type ServerContext,
} from '../server/base-tools.js';
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
    })
    .strict(),
);
const guiLintOutputSchema = strictOperationResultSchema(
  z
    .object({
      windowName: z.string().max(256),
      scenarioId: z.string().max(256),
      sourceRevision: sha256Schema,
      elementCount: nonNegativeIntegerSchema,
      fidelityCounts: countRecordSchema,
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
const guiCompareOutputSchema = strictOperationResultSchema(
  z
    .object({
      windowName: z.string().max(256),
      beforeScenario: z.string().max(256),
      afterScenario: z.string().max(256),
      changedPixels: nonNegativeIntegerSchema,
      changedRatio: z.number().min(0).max(1),
      offlineRepresentation: z.literal(true),
    })
    .strict(),
);
export const guiPlanOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: z.enum(['source', 'helpers', 'patches']),
      expiresAt: z.iso.datetime(),
      nodeCount: nonNegativeIntegerSchema.optional(),
      templateInstanceCount: nonNegativeIntegerSchema.optional(),
      rawEscapeCount: nonNegativeIntegerSchema.optional(),
      transactionFileCount: nonNegativeIntegerSchema,
      transactionArtifactCount: nonNegativeIntegerSchema,
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

const guiBaseInput = z
  .object({
    workspaceId: workspaceIdSchema,
    windowName: z.string().min(1).max(256),
    scenario: GuiPreviewScenarioSchema,
  })
  .strict();

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

function safeSlug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48) || 'gui'
  );
}

export function registerGuiTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const studio = new ScriptedGuiStudio(engine);

  server.registerTool(
    'hoi4.gui_scan',
    {
      title: 'Scan scripted GUI graph',
      description:
        'Connect active GUI, GFX, scripted GUI, localisation, sprites, fonts, contexts, triggers, effects, decisions, and animation sources.',
      inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
      outputSchema: guiScanOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Building shared index and GUI source graph');
        const [shared, scanned] = await Promise.all([
          engine.scan(workspaceId, {}, context.principal, progress.signal),
          studio.scan(workspaceId, context.principal, progress.signal),
        ]);
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const sourceEvidence = boundedSourceHashEvidence(scanned.graph.sourceHashes);
        const artifact = await engine.artifacts.putChunked(
          workspace,
          `gui-source-graph.${shared.revision.slice(0, 16)}.json`,
          'application/json',
          `${canonicalJson({
            schemaVersion: 1,
            sharedRevision: shared.revision,
            offline: true,
            graph: scanned.graph,
          })}\n`,
          {
            kind: 'gui-source-graph',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'gui-source-graph.v1',
            sourceHashes: sourceEvidence.sourceHashes,
            metadata: {
              sharedRevision: shared.revision,
              offline: true,
              complete: scanned.graph.complete,
              skippedSourceCount: scanned.graph.skippedSourceCount,
              sourceHashInventory: sourceEvidence.inventory,
            },
          },
          'Offline scripted-GUI source graph with bounded inventory completeness metadata',
          progress.signal,
        );
        const diagnostics = [...shared.diagnostics, ...scanned.graph.diagnostics];
        const result = emptyServiceResult(workspaceId, {
          sharedRevision: shared.revision,
          complete: scanned.graph.complete,
          skippedSourceCount: scanned.graph.skippedSourceCount,
          skippedSources: scanned.graph.skippedSources,
          nodes: scanned.graph.nodes.length,
          edges: scanned.graph.edges.length,
          elements: scanned.graph.elements.length,
          sprites: scanned.graph.sprites.length,
          fonts: scanned.graph.fonts.length,
          scriptedGuis: scanned.graph.scriptedGuis.length,
        });
        result.code = scanned.graph.complete ? 'GUI_SCANNED' : 'GUI_SCANNED_PARTIAL';
        setInlineFilesScanned(result, scanned.graph.filesScanned);
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(artifact)];
        result.validation = {
          passed: !diagnostics.some(
            ({ severity }) => severity === 'error' || severity === 'blocker',
          ),
          checks: [
            {
              id: 'gui-source-graph',
              passed: true,
              message: scanned.graph.complete
                ? `${scanned.graph.nodes.length} GUI graph nodes connected from a complete inventory`
                : `${scanned.graph.nodes.length} GUI graph nodes connected; ${scanned.graph.skippedSourceCount} over-limit source(s) were skipped`,
            },
          ],
        };
        await progress.report(3, 3, 'GUI scan complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.gui_lint',
    {
      title: 'Lint scripted GUI scene',
      description:
        'Validate source references, visual bounds, text, clicks, animation, states, resolutions, AI, and costs for an offline preview scenario.',
      inputSchema: guiBaseInput
        .extend({ relatedScenarios: z.array(GuiPreviewScenarioSchema).max(32).optional() })
        .strict(),
      outputSchema: guiLintOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, windowName, scenario, relatedScenarios }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Building shared index and GUI scene');
        const [shared, linted] = await Promise.all([
          engine.scan(workspaceId, {}, context.principal, progress.signal),
          studio.lint({
            workspaceId,
            windowName,
            scenario,
            ...(relatedScenarios === undefined ? {} : { relatedScenarios }),
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            signal: progress.signal,
          }),
        ]);
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const sourceEvidence = boundedSourceHashEvidence(linted.graph.sourceHashes);
        const artifact = await engine.artifacts.put(
          workspace,
          `${safeSlug(windowName)}-gui-lint.json`,
          'application/json',
          `${canonicalJson({
            schemaVersion: 1,
            offline: true,
            scenario: linted.scene.scenario,
            fidelity: linted.scene.fidelity,
            validation: linted.validation,
          })}\n`,
          {
            kind: 'gui-lint',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'gui-lint.v1',
            sourceHashes: sourceEvidence.sourceHashes,
            renderProfile: {
              offline: true,
              resolution: linted.scene.resolution,
              state: linted.scene.scenario.state,
            },
            metadata: {
              sharedRevision: shared.revision,
              sourceHashInventory: sourceEvidence.inventory,
            },
          },
          'Complete scripted-GUI lint and fidelity report',
          progress.signal,
        );
        const diagnostics = [...shared.diagnostics, ...linted.validation.diagnostics];
        const result = emptyServiceResult(workspaceId, {
          windowName,
          scenarioId: linted.scene.scenario.id,
          sourceRevision: linted.scene.sourceRevision,
          elementCount: linted.scene.elements.length,
          fidelityCounts: Object.fromEntries(
            Object.entries(linted.scene.fidelity).map(([key, values]) => [key, values.length]),
          ),
        });
        result.code = 'GUI_LINTED';
        setInlineFilesScanned(result, linted.graph.filesScanned);
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(artifact)];
        result.validation = validationSummary({
          diagnostics,
          checks: linted.validation.checks,
        });
        await progress.report(3, 3, 'GUI lint complete');
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
    const { workspaceId, windowName } = input;
    try {
      const progress = progressReporter(extra);
      await progress.report(0, 4, 'Building shared index and GUI source graph');
      const shared = await engine.scan(workspaceId, {}, context.principal, progress.signal);
      await progress.report(1, 4, 'Rendering offline GUI artifacts');
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
      const diagnostics = [...shared.diagnostics, ...rendered.validation.diagnostics];
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
      setInlineFilesScanned(
        result,
        shared.files.map(({ displayPath }) => displayPath),
      );
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
      comparisonScenario: GuiPreviewScenarioSchema.optional(),
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
      description:
        'Render deterministic full, cropped, annotated, click, source-map, hierarchy, state, resolution, comparison, and fidelity artifacts offline.',
      inputSchema: renderInput,
      outputSchema: guiRenderOutputSchema,
      annotations: artifactProducing,
    },
    (input, extra) => render(input, extra, 'GUI_RENDERED'),
  );

  server.registerTool(
    'hoi4.gui_render_states',
    {
      title: 'Render scripted GUI state matrix',
      description:
        'Render a bounded deterministic matrix of GUI states and resolution/UI-scale scenarios with fidelity reports.',
      inputSchema: renderInput,
      outputSchema: guiRenderOutputSchema,
      annotations: artifactProducing,
    },
    (input, extra) => render(input, extra, 'GUI_STATES_RENDERED'),
  );

  server.registerTool(
    'hoi4.gui_compare',
    {
      title: 'Compare GUI scenarios',
      description:
        'Render two offline scenarios and return a deterministic bitmap diff as content-addressed resources.',
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          windowName: z.string().min(1).max(256),
          before: GuiPreviewScenarioSchema,
          after: GuiPreviewScenarioSchema,
        })
        .strict(),
      outputSchema: guiCompareOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, windowName, before, after }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 4, 'Scanning and rendering both GUI scenarios');
        const compared = await studio.compare({
          workspaceId,
          windowName,
          before,
          after,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        });
        await progress.report(2, 4, 'Bitmap comparison and fidelity evidence complete');
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const slug = safeSlug(windowName);
        const provenance = guiArtifactProvenance(
          compared.graph,
          'gui-scenario-comparison',
          compared.before,
          [compared.before, compared.after],
          {
            comparison: {
              changedPixels: compared.comparison.changedPixels,
              changedRatio: compared.comparison.changedRatio,
            },
          },
        );
        await progress.report(3, 4, 'Storing comparison resources');
        const comparisonArtifacts = await engine.artifacts.withAtomicChunkedWrites(
          workspace,
          [
            {
              name: `${slug}-comparison.png`,
              mimeType: 'image/png',
              content: compared.comparison.png,
              provenance: { ...provenance, kind: 'gui-comparison-png' },
            },
            {
              name: `${slug}-comparison.json`,
              mimeType: 'application/json',
              content: compared.evidenceJson,
              provenance: { ...provenance, kind: 'gui-comparison-json' },
            },
          ],
          (stored) => Promise.resolve([...stored]),
          progress.signal,
        );
        const result = emptyServiceResult(workspaceId, {
          windowName,
          beforeScenario: compared.before.scenario.id,
          afterScenario: compared.after.scenario.id,
          changedPixels: compared.comparison.changedPixels,
          changedRatio: compared.comparison.changedRatio,
          offlineRepresentation: true,
        });
        result.code = 'GUI_COMPARED';
        setInlineFilesScanned(result, compared.graph.filesScanned);
        result.diagnostics = [...compared.before.diagnostics, ...compared.after.diagnostics].slice(
          0,
          100,
        );
        result.artifacts = comparisonArtifacts.map(publicArtifactLink);
        await progress.report(4, 4, 'GUI comparison complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.gui_plan_changes',
    {
      title: 'Dry-run scripted GUI source changes',
      description:
        'Create a source-preserving hash-bound transaction from explicit GUI source or declarative build-time helpers; never applies it.',
      inputSchema: z
        .object({
          mode: z.enum(['source', 'helpers', 'patches']),
          workspaceId: workspaceIdSchema,
          relativePath: workspaceRelativePathSchema,
          windowName: z.string().min(1).max(256),
          scenario: GuiPreviewScenarioSchema,
          source: z.string().max(20_000_000).optional(),
          helper: GuiHelperDocumentSchema.optional(),
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
            (value.source !== undefined || value.helper !== undefined)
          ) {
            context.addIssue({
              code: 'custom',
              message: 'source and helper are forbidden in patches mode',
            });
          }
        }),
      outputSchema: guiPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const { workspaceId, relativePath, windowName, scenario } = input;
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Validating GUI dry run');
        const compilation = input.mode === 'helpers' ? compileGuiHelpers(input.helper!) : undefined;
        const transaction = await studio.planSource({
          workspaceId,
          relativePath,
          ...(input.mode === 'patches'
            ? {
                expectedSourceHash: input.expectedSourceHash!,
                patches: input.patches!,
              }
            : { source: input.mode === 'source' ? input.source! : compilation!.source }),
          windowName,
          scenario,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        });
        const planned = {
          transaction,
          compilation,
        };
        const result = emptyServiceResult(workspaceId, {
          mode: input.mode,
          expiresAt: transaction.expiresAt,
          transactionFileCount: transaction.files.length,
          transactionArtifactCount: transaction.artifacts.length,
          ...(planned.compilation === undefined
            ? {}
            : {
                nodeCount: planned.compilation.nodeCount,
                templateInstanceCount: planned.compilation.templateInstanceCount,
                rawEscapeCount: planned.compilation.rawEscapeCount,
              }),
        });
        result.status = transaction.validation.passed ? 'ok' : 'blocked';
        result.code = transaction.validation.passed ? 'GUI_CHANGES_PLANNED' : 'GUI_CHANGES_BLOCKED';
        setInlineFilesScanned(result, [relativePath]);
        result.proposedFiles = transaction.files
          .slice(0, 100)
          .map(({ relativePath: file }) => file);
        result.diagnostics = transaction.diagnostics.slice(0, 100);
        result.transactionId = transaction.transactionId;
        result.planHash = transaction.planHash;
        result.artifacts = [transactionResourceLink(transaction)];
        result.validation = transaction.validation;
        result.rollbackStatus = transaction.rollbackStatus;
        result.blockers = transaction.diagnostics
          .filter(({ severity }) => severity === 'error' || severity === 'blocker')
          .map(({ code, message, details }) => ({
            code,
            message,
            ...(details === undefined ? {} : { details }),
          }));
        await progress.report(3, 3, 'GUI dry run complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}
