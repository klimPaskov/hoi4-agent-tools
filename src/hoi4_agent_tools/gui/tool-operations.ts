import { z } from 'zod/v4';
import { boundedSourceHashEvidence, publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, compareCodeUnits, hashCanonical } from '../core/canonical.js';
import type { CoreEngine } from '../core/engine.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import { emptyServiceResult } from '../core/result.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import type { TransactionManifest } from '../core/transactions.js';
import type {
  GuiInspectToolRequest,
  GuiRenderToolRequest,
  GuiRewriteToolRequest,
} from '../schemas/gui-requests.js';
import { PACKAGE_VERSION } from '../version.js';
import { compileGuiHelpers } from './helpers.js';
import { encodeGuiInspectionArtifact, projectGuiGraphForArtifact } from './inspection-artifact.js';
import type { ScriptedGuiStudio } from './studio.js';
import type { GuiValidationResult } from './types.js';

export interface GuiOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress(completed: number, total: number, message: string): Promise<void>;
}

const guiRewriteRecipeSchema = z
  .object({
    mode: z.enum(['source', 'helpers', 'patches']),
    filesScanned: z.array(z.string().min(1).max(4096)),
    compilation: z
      .object({
        nodeCount: z.number().int().nonnegative(),
        templateInstanceCount: z.number().int().nonnegative(),
        rawEscapeCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GuiRewriteRecipe = z.infer<typeof guiRewriteRecipeSchema>;

function validationSummary(validation: GuiValidationResult) {
  return {
    passed:
      validation.checks.every(({ passed }) => passed) &&
      !validation.diagnostics.some(
        ({ severity }) => severity === 'error' || severity === 'blocker',
      ),
    checks: validation.checks,
  };
}

export function normalizeGuiInspectRequest(input: unknown): GuiInspectToolRequest {
  return input as GuiInspectToolRequest;
}

export function normalizeGuiRenderRequest(input: unknown): GuiRenderToolRequest {
  return input as GuiRenderToolRequest;
}

export function normalizeGuiRewriteRequest(input: unknown): GuiRewriteToolRequest {
  return input as GuiRewriteToolRequest;
}

export async function prepareGuiRewrite(
  studio: ScriptedGuiStudio,
  input: GuiRewriteToolRequest,
  context: GuiOperationContext,
): Promise<{ transaction: TransactionManifest; recipe: GuiRewriteRecipe }> {
  await context.progress(0, 3, 'Validating the requested GUI result');
  const compilation = input.mode === 'helpers' ? compileGuiHelpers(input.helper!) : undefined;
  const transaction = await studio.planSource({
    workspaceId: context.workspaceId,
    relativePath: input.relativePath,
    ...(input.mode === 'patches'
      ? { expectedSourceHash: input.expectedSourceHash!, patches: input.patches! }
      : {
          source: input.mode === 'source' ? input.source! : compilation!.source,
          ...(input.additionalFiles === undefined
            ? {}
            : { additionalFiles: input.additionalFiles }),
        }),
    windowName: input.windowName,
    scenario: input.scenario,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress(2, 3, 'GUI rewrite prepared for journaled application');
  return {
    transaction,
    recipe: guiRewriteRecipeSchema.parse({
      mode: input.mode,
      filesScanned: [
        input.relativePath,
        ...(input.additionalFiles ?? []).map(({ relativePath }) => relativePath),
      ].sort(compareCodeUnits),
      ...(compilation === undefined
        ? {}
        : {
            compilation: {
              nodeCount: compilation.nodeCount,
              templateInstanceCount: compilation.templateInstanceCount,
              rawEscapeCount: compilation.rawEscapeCount,
            },
          }),
    }),
  };
}

export function completeGuiRewrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
) {
  const parsed = guiRewriteRecipeSchema.parse(recipe);
  const transaction = execution.transaction;
  const result = emptyServiceResult(workspaceId, {
    mode: parsed.mode,
    execution: execution.outcome,
    fileCount: transaction.files.length,
    artifactCount: transaction.artifacts.length,
    ...(parsed.compilation ?? {}),
  });
  result.status = transaction.validation.passed ? 'ok' : 'blocked';
  result.code =
    execution.outcome === 'applied'
      ? 'GUI_CHANGES_APPLIED'
      : execution.outcome === 'unchanged'
        ? 'GUI_CHANGES_UNCHANGED'
        : 'GUI_CHANGES_BLOCKED';
  setInlineFilesScanned(result, parsed.filesScanned);
  result.proposedFiles = transaction.files.slice(0, 100).map(({ relativePath }) => relativePath);
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
  return result;
}

export async function inspectGui(
  engine: CoreEngine,
  studio: ScriptedGuiStudio,
  input: GuiInspectToolRequest,
  context: GuiOperationContext,
) {
  await context.progress(0, 3, 'Building GUI source graph');
  const inspected =
    input.windowName === undefined || input.scenario === undefined
      ? {
          graph: (await studio.scan(context.workspaceId, context.principal, context.signal)).graph,
          linted: undefined,
        }
      : await (async () => {
          const linted = await studio.lint({
            workspaceId: context.workspaceId,
            windowName: input.windowName!,
            scenario: input.scenario!,
            ...(input.relatedScenarios === undefined
              ? {}
              : { relatedScenarios: input.relatedScenarios }),
            generatedScenarios: input.generatedScenarios ?? {},
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          return { graph: linted.graph, linted };
        })();
  const { graph, linted } = inspected;
  const sharedRevision = hashCanonical(graph.sourceHashes);
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
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
    context.signal,
  );
  const diagnostics = linted === undefined ? graph.diagnostics : linted.validation.diagnostics;
  const result = emptyServiceResult(context.workspaceId, {
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
          windowName: input.windowName,
          scenarioId: linted.scene.scenario.id,
          inspectedElementCount: linted.scene.elements.length,
          fidelityCounts: Object.fromEntries(
            Object.entries(linted.scene.fidelity).map(([key, values]) => [key, values.length]),
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
  await context.progress(3, 3, 'GUI inspection complete');
  return result;
}

export async function renderGui(
  studio: ScriptedGuiStudio,
  input: GuiRenderToolRequest,
  context: GuiOperationContext,
) {
  await context.progress(0, 4, 'Building GUI source graph');
  const rendered = await studio.renderAndStore({
    workspaceId: context.workspaceId,
    windowName: input.windowName,
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
    ...(input.relatedScenarios === undefined ? {} : { relatedScenarios: input.relatedScenarios }),
    generatedScenarios: input.generatedScenarios ?? {},
    ...(input.comparisonScenario === undefined
      ? {}
      : { comparisonScenario: input.comparisonScenario }),
    ...(input.sourceBaseline === undefined ? {} : { sourceBaseline: input.sourceBaseline }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress(3, 4, 'Preparing GUI result');
  const diagnostics = rendered.validation.diagnostics;
  const result = emptyServiceResult(context.workspaceId, {
    windowName: input.windowName,
    scenarioId: rendered.render.scene.scenario.id,
    sourceRevision: rendered.render.scene.sourceRevision,
    variantCount: rendered.render.images.length,
    variants: rendered.render.images.slice(0, 64).map(({ variant, width, height }) => ({
      variant,
      width,
      height,
    })),
    stateCount: rendered.stateScenes.length,
    scenarioCount: rendered.scenarioScenes.length,
    resolutionCount: rendered.resolutionScenes.length,
    comparison: {
      changedPixels: rendered.comparison.changedPixels,
      changedRatio: rendered.comparison.changedRatio,
    },
    ...(rendered.sourceComparison === undefined
      ? {}
      : {
          sourceComparison: {
            changedPixels: rendered.sourceComparison.changedPixels,
            changedRatio: rendered.sourceComparison.changedRatio,
          },
        }),
    fidelityCounts: Object.fromEntries(
      Object.entries(rendered.render.fidelity).map(([key, values]) => [key, values.length]),
    ),
    offlineRepresentation: true as const,
  });
  result.code = 'GUI_RENDERED';
  setInlineFilesScanned(result, rendered.filesScanned);
  result.diagnostics = diagnostics.slice(0, 100);
  result.artifacts = rendered.artifacts.map(publicArtifactLink);
  result.validation = validationSummary({ diagnostics, checks: rendered.validation.checks });
  await context.progress(4, 4, 'GUI render complete');
  return result;
}
