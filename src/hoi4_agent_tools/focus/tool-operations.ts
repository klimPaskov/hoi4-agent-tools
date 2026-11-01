import { z } from 'zod/v4';
import { boundedSourceHashEvidence, publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { focusDomainScanPatterns } from '../core/domain-scan-patterns.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { RenderBudget } from '../core/render-budget.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { parseClausewitz } from '../core/source/index.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import {
  readDependenciesFromScannedFiles,
  type TransactionManifest,
} from '../core/transactions.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import type {
  FocusInspectToolRequest,
  FocusRenderToolRequest,
  FocusRewriteToolRequest,
} from '../schemas/focus-requests.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  focusPlanHash,
  focusPresentationEvidence,
  importContinuousFocusPalettes,
  assertCompactLayoutQuality,
  compactFocusTreePlanAsync,
  linkContinuousFocusPalettes,
  resolveFocusPresentation,
  type ContinuousFocusPalettePlan,
  type CompactFocusTreePlanAsyncResult,
  type FocusWorkbench,
  type FocusImportResult,
  type FocusLayoutResult,
  type FocusTreePlan,
} from './index.js';
import {
  activeContinuousFocusFiles,
  activeFocusFiles,
  activeSidecar,
  continuousPalettes,
  importFocusFile,
  referenceCatalog,
  selectContinuousPlan,
  selectedContinuousFocusFile,
  selectedFocusFile,
  selectPlan,
  underConfiguredRoot,
  validationFromDiagnostics,
} from './tool-support.js';
import { inspectFocusScenario, type FocusScenarioEvidence } from './scenario.js';
import {
  describeLayoutDelta,
  evaluateFocusLayoutQuality,
  layoutQualityOutput,
  layoutValidationCheck,
  layoutVerdictDiagnostic,
  withoutCurvedConnectorDiagnostics,
  worstVerdict,
  type FocusLayoutDelta,
  type FocusLayoutQualityEvaluation,
  type FocusLayoutQualityOutput,
  renderInlineImages,
  type LayoutQualityDetail,
} from './quality/index.js';

const LARGE_FOCUS_RENDER_NODE_THRESHOLD = 200;
const LARGE_FOCUS_RENDER_SCALE = 0.5;

function automaticFocusRenderScale(focusCount: number): number {
  return focusCount >= LARGE_FOCUS_RENDER_NODE_THRESHOLD ? LARGE_FOCUS_RENDER_SCALE : 1;
}

export interface FocusOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress(completed: number, total: number, message: string): Promise<void>;
}

const jsonObject = z.record(z.string(), z.json());
const focusRewriteRecipeSchema = z
  .object({
    data: jsonObject,
    filesScanned: z.array(z.string().min(1).max(4096)),
  })
  .strict();

export type FocusRewriteRecipe = z.infer<typeof focusRewriteRecipeSchema>;

export interface FocusVisualRevisionSelector {
  relativePath: string;
  treeId: string;
}

export interface FocusVisualRevision {
  relativePath: string;
  treeId: string;
  revision: string;
  filesScanned: string[];
}

export async function computeFocusVisualRevisions(
  engine: CoreEngine,
  context: Pick<FocusOperationContext, 'principal' | 'signal'>,
  workspaceId: string,
  snapshot: ScanSnapshot,
  selectors: readonly FocusVisualRevisionSelector[],
): Promise<FocusVisualRevision[]> {
  const workspace = engine.resolver.get(workspaceId, context.principal);
  const paletteImport = continuousPalettes(snapshot);
  const revisions: FocusVisualRevision[] = [];
  for (const selector of selectors) {
    context.signal?.throwIfAborted();
    const imported = importFocusFile(
      snapshot,
      selectedFocusFile(snapshot, workspace.registration.roots.focus, selector.relativePath),
      paletteImport.palettes,
    );
    const plan = selectPlan(imported, selector.treeId);
    const linkedPalettes = paletteImport.palettes.filter(({ id }) =>
      plan.continuousFocusPaletteIds.includes(id),
    );
    const presentation = await resolveFocusPresentation({
      plans: [plan],
      palettes: linkedPalettes,
      files: snapshot.files,
      index: snapshot.index,
      scanner: engine.scanner,
      workspace,
      decodeIcons: false,
      budget: new RenderBudget(),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const filesScanned = [
      ...new Set([plan.provenance.sourcePath, ...presentation.filesScanned]),
    ].sort(compareCodeUnits);
    revisions.push({
      relativePath: selector.relativePath,
      treeId: plan.id,
      revision: hashCanonical({
        planHash: focusPlanHash(plan),
        linkedPalettes,
        presentationSourceHashes: presentation.sourceHashes,
      }),
      filesScanned,
    });
  }
  return revisions;
}

export function normalizeFocusInspectRequest(input: unknown): FocusInspectToolRequest {
  return input as FocusInspectToolRequest;
}

export function normalizeFocusRenderRequest(input: unknown): FocusRenderToolRequest {
  return input as FocusRenderToolRequest;
}

export function normalizeFocusRewriteRequest(input: unknown): FocusRewriteToolRequest {
  return input as FocusRewriteToolRequest;
}

/** Many trees in one result share the response budget, so each gets less of its scorecard. */
function inspectDetail(treeCount: number): LayoutQualityDetail {
  return treeCount === 1 ? 'full' : treeCount <= 4 ? 'compact' : 'minimal';
}

function compactDrift(drift: { status: string; sourceChanged: boolean; planChanged: boolean }) {
  return {
    status: drift.status,
    sourceChanged: drift.sourceChanged,
    planChanged: drift.planChanged,
  };
}

export async function prepareFocusRewrite(
  engine: CoreEngine,
  workbench: FocusWorkbench,
  input: FocusRewriteToolRequest,
  context: FocusOperationContext,
): Promise<{ transaction: TransactionManifest; recipe: FocusRewriteRecipe }> {
  const {
    relativePath,
    createIfMissing,
    horizontalSpacing,
    verticalSpacing,
    padding,
    reviewScale,
  } = input;
  await context.progress(0, 5, 'Validating shared index and current source');
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const snapshot = await engine.scan(
    context.workspaceId,
    { patterns: focusDomainScanPatterns(workspace) },
    context.principal,
    context.signal,
  );
  if (input.mode === 'continuous') {
    const plan = input.plan as ContinuousFocusPalettePlan;
    if (
      createIfMissing &&
      (!relativePath.toLowerCase().endsWith('.txt') ||
        !underConfiguredRoot(relativePath, ['common/continuous_focus']))
    )
      throw new ServiceError(
        'CONTINUOUS_FOCUS_SOURCE_PATH_INVALID',
        'New continuous focus sources must be .txt files beneath common/continuous_focus',
        { relativePath },
      );
    const sourceFile = activeContinuousFocusFiles(snapshot).find(
      (candidate) => candidate.relativePath === relativePath,
    );
    if (sourceFile === undefined && !createIfMissing)
      selectedContinuousFocusFile(snapshot, relativePath);
    if (sourceFile !== undefined && sourceFile.rootKind !== 'mod')
      throw new ServiceError(
        'CONTINUOUS_FOCUS_SOURCE_READ_ONLY',
        'Continuous focus changes require a mod-owned source; create a new mod source path instead of shadowing a read-only file',
        { relativePath, rootKind: sourceFile.rootKind },
      );
    const imported =
      sourceFile === undefined
        ? undefined
        : await workbench.importContinuousPath(
            context.workspaceId,
            relativePath,
            context.principal,
          );
    const currentPlan = imported?.result.continuousFocusPalettes.find(({ id }) => id === plan.id);
    if (currentPlan === undefined && !createIfMissing) {
      if (imported === undefined) selectedContinuousFocusFile(snapshot, relativePath);
      else selectContinuousPlan(imported.result, plan.id);
    }
    if (currentPlan === undefined && createIfMissing && sourceFile !== undefined)
      throw new ServiceError(
        'CONTINUOUS_FOCUS_CREATE_REQUIRES_NEW_SOURCE',
        'Creating a continuous-focus palette requires a new mod source file so unrelated existing source is never repurposed',
        { relativePath, paletteId: plan.id },
      );
    const renderBudget = new RenderBudget();
    const presentation = await resolveFocusPresentation({
      plans: [],
      palettes: [...(currentPlan === undefined ? [] : [currentPlan]), plan],
      files: snapshot.files,
      index: snapshot.index,
      scanner: engine.scanner,
      workspace,
      decodeIcons: false,
      budget: renderBudget,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    await context.progress(1, 5, 'Building proposed continuous focus review');
    const proposedPlanHash = focusPlanHash(plan);
    const reviewPlan: ContinuousFocusPalettePlan = {
      ...plan,
      provenance: {
        sourcePath: `plan:${plan.id}`,
        sourceHash: proposedPlanHash,
        importedPlanHash: proposedPlanHash,
      },
    };
    const proposed = await workbench.renderContinuousAndStore(context.workspaceId, reviewPlan, {
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      presentation,
      sourceHashes: presentation.sourceHashes,
      renderProfile: {
        sourceRevision: snapshot.revision,
        proposedPlanHash,
        output: 'vector',
      },
      rasterize: false,
      budget: renderBudget,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const reviewArtifacts = proposed.artifacts.map(publicArtifactLink);
    await context.progress(3, 5, 'Preparing the continuous focus rewrite');
    const planned = await workbench.planContinuousChanges({
      workspaceId: context.workspaceId,
      relativePath,
      plan,
      createIfMissing,
      authority: 'plan',
      onSemanticSourceDrift: 'refuse',
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      artifacts: reviewArtifacts,
      readDependencies: readDependenciesFromScannedFiles(snapshot.files),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    await context.progress(4, 5, 'Continuous focus rewrite prepared for journaled application');
    return {
      transaction: planned.transaction,
      recipe: focusRewriteRecipeSchema.parse({
        data: jsonObject.parse({
          mode: 'continuous',
          paletteId: plan.id,
          drift: compactDrift(planned.drift),
          created: planned.drift.status === 'target_missing',
        }),
        filesScanned: [
          ...new Set([
            ...(sourceFile === undefined ? [] : [sourceFile.displayPath]),
            ...presentation.filesScanned,
          ]),
        ].sort(compareCodeUnits),
      }),
    };
  }

  const suppliedPlan = input.plan as FocusTreePlan | undefined;
  if (
    createIfMissing &&
    (!relativePath.toLowerCase().endsWith('.txt') ||
      !underConfiguredRoot(relativePath, workspace.registration.roots.focus))
  )
    throw new ServiceError(
      'FOCUS_SOURCE_PATH_INVALID',
      'New national focus sources must be .txt files beneath a configured focus root',
      { relativePath },
    );
  const focusFile = activeFocusFiles(snapshot, workspace.registration.roots.focus).find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (focusFile === undefined && !createIfMissing)
    selectedFocusFile(snapshot, workspace.registration.roots.focus, relativePath);
  if (focusFile !== undefined && focusFile.rootKind !== 'mod')
    throw new ServiceError(
      'FOCUS_SOURCE_READ_ONLY',
      'National focus changes require a mod-owned source; create a new mod source path instead of shadowing a read-only file',
      { relativePath, rootKind: focusFile.rootKind },
    );
  const sidecar = focusFile === undefined ? undefined : activeSidecar(snapshot, focusFile);
  const catalog = referenceCatalog(snapshot);
  const imported =
    focusFile === undefined
      ? undefined
      : await workbench.importPath(
          context.workspaceId,
          relativePath,
          context.principal,
          sidecar?.sidecar,
          catalog,
        );
  const paletteImport = continuousPalettes(snapshot);
  if (imported !== undefined)
    imported.result.plans = imported.result.plans.map((current) =>
      linkContinuousFocusPalettes(current, paletteImport.palettes),
    );
  let compactPlanning: CompactFocusTreePlanAsyncResult | undefined;
  let compactSourcePlan: FocusTreePlan | undefined;
  let plan: FocusTreePlan;
  if (suppliedPlan !== undefined) {
    if (input.layoutMode === 'compact') {
      compactSourcePlan = suppliedPlan;
      compactPlanning = await compactFocusTreePlanAsync(suppliedPlan, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(input.compactFocusIds === undefined ? {} : { focusIds: input.compactFocusIds }),
        ...(input.pinnedFocusIds === undefined ? {} : { pinnedFocusIds: input.pinnedFocusIds }),
        ...(input.symmetryGroups === undefined ? {} : { symmetryGroups: input.symmetryGroups }),
      });
      plan = compactPlanning.plan;
    } else plan = suppliedPlan;
  } else {
    if (imported === undefined)
      throw new ServiceError(
        'FOCUS_COMPACT_SOURCE_REQUIRED',
        'Plan-free compact reflow requires an existing national focus source',
        { relativePath },
      );
    compactSourcePlan = selectPlan(imported.result, input.treeId);
    compactPlanning = await compactFocusTreePlanAsync(compactSourcePlan, {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(input.compactFocusIds === undefined ? {} : { focusIds: input.compactFocusIds }),
      ...(input.pinnedFocusIds === undefined ? {} : { pinnedFocusIds: input.pinnedFocusIds }),
      ...(input.symmetryGroups === undefined ? {} : { symmetryGroups: input.symmetryGroups }),
    });
    plan = compactPlanning.plan;
  }
  const currentPlan = imported?.result.plans.find(({ id }) => id === plan.id);
  if (currentPlan === undefined && !createIfMissing) {
    if (imported === undefined)
      selectedFocusFile(snapshot, workspace.registration.roots.focus, relativePath);
    else selectPlan(imported.result, plan.id);
  }
  if (currentPlan === undefined && createIfMissing && focusFile !== undefined)
    throw new ServiceError(
      'FOCUS_CREATE_REQUIRES_NEW_SOURCE',
      'Creating a national focus tree requires a new mod source file so an existing source and its planning sidecar cannot be repurposed',
      { relativePath, treeId: plan.id },
    );
  const renderBudget = new RenderBudget();
  const effectiveReviewScale = reviewScale ?? automaticFocusRenderScale(plan.focuses.length);
  const reviewRenderOptions = {
    ...(horizontalSpacing === undefined ? {} : { horizontalSpacing }),
    ...(verticalSpacing === undefined ? {} : { verticalSpacing }),
    ...(padding === undefined ? {} : { padding }),
    outputScale: effectiveReviewScale,
  };
  const reviewRenderProfile = {
    ...(horizontalSpacing === undefined ? {} : { horizontalSpacing }),
    ...(verticalSpacing === undefined ? {} : { verticalSpacing }),
    ...(padding === undefined ? {} : { padding }),
    reviewScale: effectiveReviewScale,
  };
  const presentation = await resolveFocusPresentation({
    plans: [...(currentPlan === undefined ? [] : [currentPlan]), plan],
    palettes: paletteImport.palettes.filter(({ id }) =>
      plan.continuousFocusPaletteIds.includes(id),
    ),
    files: snapshot.files,
    index: snapshot.index,
    scanner: engine.scanner,
    workspace,
    decodeIcons: false,
    budget: renderBudget,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const currentLayout =
    currentPlan === undefined
      ? undefined
      : currentPlan === compactSourcePlan && compactPlanning !== undefined
        ? compactPlanning.currentLayout
        : await workbench.layoutAsync(currentPlan, {
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
  await context.progress(1, 5, 'Building proposed focus review');
  const proposedPlanHash = focusPlanHash(plan);
  const reviewPlan: FocusTreePlan = {
    ...plan,
    provenance: {
      sourcePath: `plan:${plan.id}`,
      sourceHash: proposedPlanHash,
      importedPlanHash: proposedPlanHash,
    },
  };
  const proposedLayout =
    compactPlanning?.proposedLayout ??
    (await workbench.layoutAsync(reviewPlan, {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }));
  if (input.layoutMode === 'compact')
    assertCompactLayoutQuality(currentLayout, proposedLayout, input.compactFocusIds !== undefined, {
      ...(currentPlan === undefined ? {} : { current: currentPlan }),
      proposed: plan,
    });
  const proposed = await workbench.renderAndStore(context.workspaceId, reviewPlan, {
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    index: snapshot.index,
    references: catalog,
    presentation,
    sourceHashes: presentation.sourceHashes,
    ...reviewRenderOptions,
    rasterize: false,
    renderProfile: {
      sourceRevision: snapshot.revision,
      proposedPlanHash,
      reviewRenderProfile,
      output: 'vector',
    },
    budget: renderBudget,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    layout: proposedLayout,
  });
  const reviewArtifacts = proposed.artifacts.map(publicArtifactLink);
  await context.progress(3, 5, 'Preparing the focus-tree rewrite');
  const planned = await workbench.planChanges({
    workspaceId: context.workspaceId,
    relativePath,
    plan,
    createIfMissing,
    authority: 'plan',
    onSemanticSourceDrift: 'refuse',
    layout: proposed.layout,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    index: snapshot.index,
    references: catalog,
    artifacts: reviewArtifacts,
    readDependencies: readDependenciesFromScannedFiles(snapshot.files),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress(4, 5, 'Focus rewrite prepared for journaled application');
  const after = evaluateFocusLayoutQuality(plan, planned.layout.nodes);
  const delta = describeLayoutDelta(
    currentPlan === undefined || currentLayout === undefined
      ? undefined
      : {
          plan: currentPlan,
          nodes: currentLayout.nodes,
          report: evaluateFocusLayoutQuality(currentPlan, currentLayout.nodes).report,
        },
    { plan, nodes: planned.layout.nodes, report: after.report },
  );
  return {
    transaction: planned.transaction,
    recipe: focusRewriteRecipeSchema.parse({
      data: jsonObject.parse({
        mode: 'national',
        treeId: plan.id,
        drift: compactDrift(planned.drift),
        created: planned.drift.status === 'target_missing',
        layoutHash: planned.layout.layoutHash,
        layoutQuality: layoutQualityOutput(after.report, 'full'),
        layoutDelta: delta,
        sourcePath: plan.provenance.sourcePath,
        ...(compactPlanning?.outcome === 'nothing_to_improve'
          ? {
              compactOutcome: {
                outcome: 'nothing_to_improve',
                reason: compactPlanning.reason ?? 'no_better_candidate',
                blockedBy: compactPlanning.blockedBy ?? [],
              },
            }
          : {}),
      }),
      filesScanned: [
        ...new Set([
          ...(focusFile === undefined ? [] : [focusFile.displayPath]),
          ...presentation.filesScanned,
        ]),
      ].sort(compareCodeUnits),
    }),
  };
}

/** A string recorded in a write recipe, or an empty one. */
function recipeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function completeFocusRewrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
) {
  const parsed = focusRewriteRecipeSchema.parse(recipe);
  const transaction = execution.transaction;
  const mode = parsed.data.mode;
  const result = emptyServiceResult(workspaceId, {
    ...parsed.data,
    execution: execution.outcome,
    fileCount: transaction.files.length,
    artifactCount: transaction.artifacts.length,
  });
  result.status = transaction.validation.passed ? 'ok' : 'blocked';
  const quality = parsed.data.layoutQuality as FocusLayoutQualityOutput | undefined;
  const compactOutcome = parsed.data.compactOutcome as
    { outcome: string; reason: string; blockedBy: string[] } | undefined;
  result.code =
    mode === 'continuous'
      ? execution.outcome === 'applied'
        ? 'CONTINUOUS_FOCUS_CHANGES_APPLIED'
        : execution.outcome === 'unchanged'
          ? 'CONTINUOUS_FOCUS_CHANGES_UNCHANGED'
          : 'CONTINUOUS_FOCUS_CHANGES_BLOCKED'
      : execution.outcome === 'applied'
        ? 'FOCUS_CHANGES_APPLIED'
        : execution.outcome === 'unchanged'
          ? 'FOCUS_CHANGES_UNCHANGED'
          : 'FOCUS_CHANGES_BLOCKED';
  setInlineFilesScanned(result, parsed.filesScanned);
  result.proposedFiles = transaction.files.slice(0, 100).map(({ relativePath }) => relativePath);
  result.changedFiles = transaction.appliedFiles.slice(0, 100);
  const sourcePath = recipeText(parsed.data.sourcePath);
  const treeId = recipeText(parsed.data.treeId);
  const noteLocation =
    sourcePath === ''
      ? undefined
      : {
          path: sourcePath,
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        };
  const layoutNotes: Diagnostic[] = [
    ...(compactOutcome === undefined
      ? []
      : [
          {
            code: 'FOCUS_COMPACT_NOTHING_TO_IMPROVE',
            severity: 'info' as const,
            category: 'layout' as const,
            message:
              compactOutcome.reason === 'verdict_pass'
                ? 'The layout already passes every calibrated metric, so compact reflow has nothing to improve; the source is unchanged'
                : compactOutcome.blockedBy.length === 0
                  ? 'Compact reflow found no layout that beats the current one under the in-game connector model; the source is unchanged'
                  : `Compact reflow found no layout that is at least as good as the current one (${compactOutcome.blockedBy.join(', ')}); the source is unchanged`,
            ...(noteLocation === undefined ? {} : { location: noteLocation }),
            details: {
              reason: compactOutcome.reason,
              blockedBy: compactOutcome.blockedBy,
              verdict: quality?.verdict ?? null,
            },
          },
        ]),
    ...(quality === undefined
      ? []
      : [layoutVerdictDiagnostic(treeId, quality, noteLocation)].filter(
          (entry): entry is Diagnostic => entry !== undefined,
        )),
  ];
  result.diagnostics = [...layoutNotes, ...transaction.diagnostics].slice(0, 100);
  result.artifacts = autonomousResultArtifacts(execution);
  result.validation =
    quality === undefined
      ? transaction.validation
      : {
          passed: transaction.validation.passed,
          // First, because the inline list of checks is capped and the layout verdict must stay.
          checks: [
            layoutValidationCheck([{ treeId, report: quality }]),
            ...transaction.validation.checks,
          ],
        };
  result.blockers = transaction.diagnostics
    .filter(({ severity }) => severity === 'error' || severity === 'blocker')
    .map(({ code, message, details }) => ({
      code,
      message,
      ...(details === undefined ? {} : { details }),
    }));
  return result;
}

export async function inspectFocus(
  engine: CoreEngine,
  workbench: FocusWorkbench,
  input: FocusInspectToolRequest,
  context: FocusOperationContext,
) {
  await context.progress(0, 3, 'Building shared workspace index');
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const snapshot = await engine.scan(
    context.workspaceId,
    { patterns: focusDomainScanPatterns(workspace) },
    context.principal,
    context.signal,
  );
  if (input.mode === 'continuous') {
    const selectedFiles = activeContinuousFocusFiles(snapshot).filter(
      (file) => input.relativePath === undefined || file.relativePath === input.relativePath,
    );
    if (selectedFiles.length === 0)
      throw new ServiceError(
        'CONTINUOUS_FOCUS_SOURCE_NOT_FOUND',
        'No active continuous focus source matched the request',
      );
    const diagnostics = [] as FocusImportResult['diagnostics'];
    const importedPalettes: ContinuousFocusPalettePlan[] = [];
    for (const file of selectedFiles) {
      context.signal?.throwIfAborted();
      const imported = importContinuousFocusPalettes(parseClausewitz(file.bytes, file.displayPath));
      importedPalettes.push(...imported.continuousFocusPalettes);
      diagnostics.push(...imported.diagnostics);
    }
    const palettes = importedPalettes.filter(
      ({ id }) => input.paletteId === undefined || id === input.paletteId,
    );
    if (palettes.length === 0)
      throw new ServiceError(
        'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
        input.paletteId === undefined
          ? 'The selected source contains no continuous focus palette'
          : `Continuous focus palette was not found: ${input.paletteId}`,
      );
    const paletteDiagnosticCounts = new Map<string, number>();
    for (const palette of palettes) {
      const lintDiagnostics = workbench.lintContinuous(palette);
      paletteDiagnosticCounts.set(palette.id, lintDiagnostics.length);
      diagnostics.push(...lintDiagnostics);
    }
    const presentation = await resolveFocusPresentation({
      plans: [],
      palettes,
      files: snapshot.files,
      index: snapshot.index,
      scanner: engine.scanner,
      workspace,
      decodeIcons: false,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    diagnostics.push(...presentation.diagnostics);
    await context.progress(2, 3, 'Writing continuous focus inspection');
    const completeSourceHashes = Object.fromEntries(
      Object.entries({
        ...Object.fromEntries(
          selectedFiles.map(({ displayPath, sha256 }) => [displayPath, sha256]),
        ),
        ...presentation.sourceHashes,
      }).sort(([left], [right]) => compareCodeUnits(left, right)),
    );
    const sourceEvidence = boundedSourceHashEvidence(completeSourceHashes);
    const artifact = await engine.artifacts.putChunked(
      workspace,
      `focus-inspect.${snapshot.revision.slice(0, 16)}.json`,
      'application/json',
      `${canonicalJson({
        schemaVersion: 1,
        mode: 'continuous',
        revision: snapshot.revision,
        continuousFocusPalettes: palettes,
        presentation: focusPresentationEvidence(presentation),
        sourceHashes: completeSourceHashes,
        diagnostics,
      })}\n`,
      {
        kind: 'focus-inspect',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'focus-inspect.v1',
        sourceHashes: sourceEvidence.sourceHashes,
        metadata: { sourceHashInventory: sourceEvidence.inventory },
      },
      'Continuous focus plans and diagnostics',
      context.signal,
    );
    const result = emptyServiceResult(context.workspaceId, {
      mode: 'continuous' as const,
      revision: snapshot.revision,
      treeCount: 0,
      paletteCount: palettes.length,
      trees: [],
      palettes: palettes.slice(0, 100).map((palette) => ({
        id: palette.id,
        sourcePath: palette.provenance.sourcePath,
        focusCount: palette.focuses.length,
        diagnosticCount: paletteDiagnosticCounts.get(palette.id) ?? 0,
      })),
    });
    result.code = 'FOCUS_INSPECTED';
    setInlineFilesScanned(
      result,
      [
        ...new Set([
          ...selectedFiles.map(({ displayPath }) => displayPath),
          ...presentation.filesScanned,
        ]),
      ].sort((left, right) => compareCodeUnits(left, right)),
    );
    result.diagnostics = diagnostics.slice(0, 100);
    result.artifacts = [publicArtifactLink(artifact)];
    result.validation = validationFromDiagnostics(diagnostics);
    await context.progress(3, 3, 'Continuous focus inspection complete');
    return { result, sourceRevision: snapshot.revision };
  }
  const selectedFiles = activeFocusFiles(snapshot, workspace.registration.roots.focus).filter(
    (file) => input.relativePath === undefined || file.relativePath === input.relativePath,
  );
  if (selectedFiles.length === 0)
    throw new ServiceError('FOCUS_SOURCE_NOT_FOUND', 'No active focus source matched the request');
  const selectedSidecarFiles = selectedFiles.flatMap((file) => {
    const resolved = activeSidecar(snapshot, file);
    return resolved === undefined ? [] : [resolved.file];
  });
  const importedPlans: FocusTreePlan[] = [];
  const diagnostics = [] as FocusImportResult['diagnostics'];
  const paletteImport = continuousPalettes(snapshot);
  diagnostics.push(...paletteImport.diagnostics);
  for (const file of selectedFiles) {
    context.signal?.throwIfAborted();
    const imported = importFocusFile(snapshot, file, paletteImport.palettes);
    importedPlans.push(...imported.plans);
    diagnostics.push(...imported.diagnostics);
  }
  const plans = importedPlans.filter(({ id }) => input.treeId === undefined || id === input.treeId);
  if (plans.length === 0)
    throw new ServiceError(
      'FOCUS_TREE_NOT_FOUND',
      input.treeId === undefined
        ? 'The selected source contains no national focus tree'
        : `Focus tree was not found: ${input.treeId}`,
    );
  const inspectedPlans: Array<{
    plan: FocusTreePlan;
    layout: FocusLayoutResult;
    diagnosticCount: number;
    quality: FocusLayoutQualityEvaluation;
    delta?: FocusLayoutDelta;
    scenario?: FocusScenarioEvidence;
  }> = [];
  for (const plan of plans) {
    const layout = await workbench.layoutAsync(plan, {
      ...(input.previous === undefined ? {} : { previous: input.previous as FocusLayoutResult }),
      ...(input.laneSpacing === undefined ? {} : { laneSpacing: input.laneSpacing }),
      ...(input.nodeSpacing === undefined ? {} : { nodeSpacing: input.nodeSpacing }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const lintDiagnostics = workbench.lint(plan, {
      index: snapshot.index,
      references: referenceCatalog(snapshot),
      layout,
    });
    diagnostics.push(...lintDiagnostics);
    const quality = evaluateFocusLayoutQuality(plan, layout.nodes);
    const previousLayout = input.previous as FocusLayoutResult | undefined;
    const delta =
      previousLayout === undefined
        ? undefined
        : describeLayoutDelta(
            {
              plan,
              nodes: previousLayout.nodes,
              report: evaluateFocusLayoutQuality(plan, previousLayout.nodes).report,
            },
            { plan, nodes: layout.nodes, report: quality.report },
          );
    inspectedPlans.push({
      plan,
      layout,
      diagnosticCount: withoutCurvedConnectorDiagnostics(lintDiagnostics).length,
      quality,
      ...(delta === undefined ? {} : { delta }),
      ...(input.scenario === undefined
        ? {}
        : { scenario: inspectFocusScenario(plan, input.scenario.completedFocusIds) }),
    });
  }
  const presentation = await resolveFocusPresentation({
    plans,
    palettes: paletteImport.palettes,
    files: snapshot.files,
    index: snapshot.index,
    scanner: engine.scanner,
    workspace,
    decodeIcons: false,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  diagnostics.push(...presentation.diagnostics);
  await context.progress(2, 3, 'Writing focus plans, diagnostics, and layouts');
  const completeSourceHashes = Object.fromEntries(
    Object.entries({
      ...Object.fromEntries(
        [...selectedFiles, ...selectedSidecarFiles, ...activeContinuousFocusFiles(snapshot)].map(
          ({ displayPath, sha256 }) => [displayPath, sha256],
        ),
      ),
      ...presentation.sourceHashes,
    }).sort(([left], [right]) => compareCodeUnits(left, right)),
  );
  const sourceEvidence = boundedSourceHashEvidence(completeSourceHashes);
  const artifact = await engine.artifacts.putChunked(
    workspace,
    `focus-inspect.${snapshot.revision.slice(0, 16)}.json`,
    'application/json',
    `${canonicalJson({
      schemaVersion: 1,
      revision: snapshot.revision,
      plans,
      layouts: inspectedPlans.map(
        ({ plan, layout, diagnosticCount, scenario, quality, delta }) => ({
          treeId: plan.id,
          layout,
          diagnosticCount,
          layoutQuality: quality.report,
          ...(delta === undefined ? {} : { layoutDelta: delta }),
          ...(scenario === undefined ? {} : { scenario }),
        }),
      ),
      continuousFocusPalettes: paletteImport.palettes,
      presentation: focusPresentationEvidence(presentation),
      sourceHashes: completeSourceHashes,
      diagnostics,
    })}\n`,
    {
      kind: 'focus-inspect',
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'focus-inspect.v1',
      sourceHashes: sourceEvidence.sourceHashes,
      metadata: { sourceHashInventory: sourceEvidence.inventory },
    },
    'Focus plans, diagnostics, and stable layout decisions',
    context.signal,
  );
  const result = emptyServiceResult(context.workspaceId, {
    mode: 'national' as const,
    revision: snapshot.revision,
    treeCount: plans.length,
    paletteCount: paletteImport.palettes.length,
    layoutVerdict: worstVerdict(inspectedPlans.map(({ quality }) => quality.report.verdict)),
    trees: inspectedPlans
      .slice(0, 100)
      .map(({ plan, layout, diagnosticCount, scenario, quality, delta }) => ({
        id: plan.id,
        sourcePath: plan.provenance.sourcePath,
        focusCount: plan.focuses.length,
        branchCount: plan.branchGroups.length,
        continuousPaletteCount: plan.continuousFocusPaletteIds.length,
        continuousFocusCount: plan.continuousFocusIds.length,
        continuousFocusPosition: plan.continuousFocusPosition ?? null,
        continuousFocusPaletteIds: plan.continuousFocusPaletteIds.slice(0, 100),
        resolvedTitleCount: plan.focuses.filter(
          ({ id }) => presentation.entries[id]?.titleSourceLocation !== undefined,
        ).length,
        layoutHash: layout.layoutHash,
        layoutDecisionCount: layout.decisions.length,
        layoutMetrics: layout.metrics!,
        layoutQuality: layoutQualityOutput(quality.report, inspectDetail(inspectedPlans.length)),
        ...(delta === undefined ? {} : { layoutDelta: delta }),
        diagnosticCount,
        ...(scenario === undefined
          ? {}
          : {
              scenarioSummary: {
                ...scenario.counts,
                choiceConflictCount: scenario.mutualExclusionConflicts.length,
              },
            }),
      })),
    palettes: [],
  });
  result.code = 'FOCUS_INSPECTED';
  setInlineFilesScanned(
    result,
    [
      ...new Set([
        ...selectedFiles.map(({ displayPath }) => displayPath),
        ...selectedSidecarFiles.map(({ displayPath }) => displayPath),
        ...activeContinuousFocusFiles(snapshot).map(({ displayPath }) => displayPath),
        ...presentation.filesScanned,
      ]),
    ].sort((left, right) => compareCodeUnits(left, right)),
  );
  // The curved-connector findings are replaced by the in-game connector model in the scorecard;
  // the linked report keeps every raw diagnostic.
  // The verdicts come first: the inline list is capped, and a verdict must never be cut off.
  const reported = [
    ...inspectedPlans.flatMap(({ plan, quality }) => {
      const verdict = layoutVerdictDiagnostic(plan.id, quality.report, plan.sourceLocation);
      return verdict === undefined ? [] : [verdict];
    }),
    ...withoutCurvedConnectorDiagnostics(diagnostics),
  ];
  result.diagnostics = reported.slice(0, 100);
  result.artifacts = [publicArtifactLink(artifact)];
  const structure = validationFromDiagnostics(reported);
  result.validation = {
    passed: structure.passed,
    checks: [
      ...structure.checks,
      layoutValidationCheck(
        inspectedPlans.map(({ plan, quality }) => ({ treeId: plan.id, report: quality.report })),
      ),
    ],
  };
  await context.progress(3, 3, 'Focus inspection complete');
  return { result, sourceRevision: snapshot.revision };
}

export async function renderFocus(
  engine: CoreEngine,
  workbench: FocusWorkbench,
  input: FocusRenderToolRequest,
  context: FocusOperationContext,
  rasterize: boolean,
) {
  const outputName = rasterize ? 'raster' : 'render';
  if (!rasterize && (input.cropFocusIds?.length ?? 0) > 0)
    throw new ServiceError(
      'FOCUS_CROP_REQUIRES_RASTER',
      'Focus problem crops are PNG images; omit png: false',
    );
  await context.progress(0, 4, 'Importing and indexing focus source');
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const snapshot = await engine.scan(
    context.workspaceId,
    { patterns: focusDomainScanPatterns(workspace) },
    context.principal,
    context.signal,
  );
  await context.progress(1, 4, 'Focus source index complete');
  const renderBudget = new RenderBudget();
  if (input.mode === 'continuous') {
    selectedContinuousFocusFile(snapshot, input.relativePath);
    const imported = await workbench.importContinuousPath(
      context.workspaceId,
      input.relativePath,
      context.principal,
    );
    const plan = selectContinuousPlan(imported.result, input.paletteId);
    const presentation = await resolveFocusPresentation({
      plans: [],
      palettes: [plan],
      files: snapshot.files,
      index: snapshot.index,
      scanner: engine.scanner,
      workspace,
      decodeIcons: rasterize,
      budget: renderBudget,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    await context.progress(2, 4, `Producing continuous focus ${outputName} artifacts`);
    const rendered = await workbench.renderContinuousAndStore(context.workspaceId, plan, {
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      presentation,
      sourceHashes: presentation.sourceHashes,
      ...(input.columns === undefined ? {} : { columns: input.columns }),
      ...(input.padding === undefined ? {} : { padding: input.padding }),
      renderProfile: { sourceRevision: snapshot.revision, output: outputName },
      rasterize,
      budget: renderBudget,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const diagnostics = [...imported.result.diagnostics, ...rendered.diagnostics];
    const result = emptyServiceResult(context.workspaceId, {
      mode: 'continuous' as const,
      paletteId: plan.id,
      focusCount: plan.focuses.length,
      hashes: rendered.bundle.hashes,
      width: rendered.bundle.width,
      height: rendered.bundle.height,
    });
    result.code = rasterize ? 'CONTINUOUS_FOCUS_RASTERIZED' : 'CONTINUOUS_FOCUS_RENDERED';
    setInlineFilesScanned(
      result,
      [...new Set([plan.provenance.sourcePath, ...presentation.filesScanned])].sort((left, right) =>
        compareCodeUnits(left, right),
      ),
    );
    result.diagnostics = diagnostics.slice(0, 100);
    result.artifacts = rendered.artifacts.map(publicArtifactLink);
    result.validation = validationFromDiagnostics(diagnostics);
    await context.progress(4, 4, `Continuous focus ${outputName} complete`);
    return { result, sourceRevision: snapshot.revision };
  }
  const paletteImport = continuousPalettes(snapshot);
  const imported = importFocusFile(
    snapshot,
    selectedFocusFile(snapshot, workspace.registration.roots.focus, input.relativePath),
    paletteImport.palettes,
  );
  const plan = selectPlan(imported, input.treeId);
  const linkedPalettes = paletteImport.palettes.filter(({ id }) =>
    plan.continuousFocusPaletteIds.includes(id),
  );
  const presentation = await resolveFocusPresentation({
    plans: [plan],
    palettes: linkedPalettes,
    files: snapshot.files,
    index: snapshot.index,
    scanner: engine.scanner,
    workspace,
    decodeIcons: rasterize,
    budget: renderBudget,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  await context.progress(2, 4, `Producing focus ${outputName} artifacts`);
  const effectiveReviewScale = input.reviewScale ?? automaticFocusRenderScale(plan.focuses.length);
  const rendered = await workbench.renderAndStore(context.workspaceId, plan, {
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    index: snapshot.index,
    references: referenceCatalog(snapshot),
    presentation,
    sourceHashes: presentation.sourceHashes,
    ...(input.horizontalSpacing === undefined
      ? {}
      : { horizontalSpacing: input.horizontalSpacing }),
    ...(input.verticalSpacing === undefined ? {} : { verticalSpacing: input.verticalSpacing }),
    ...(input.padding === undefined ? {} : { padding: input.padding }),
    outputScale: effectiveReviewScale,
    rasterize,
    ...(input.cropFocusIds === undefined ? {} : { cropFocusIds: input.cropFocusIds }),
    renderProfile: {
      sourceRevision: snapshot.revision,
      reviewScale: effectiveReviewScale,
      output: outputName,
    },
    budget: renderBudget,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const quality = evaluateFocusLayoutQuality(plan, rendered.layout.nodes);
  // The inline pictures are the in-game-style schematic the scorecard measures: right-angle
  // connectors, 1.6-column plaques, cropped to branches and to the places the metrics blame.
  const inline =
    input.inline === false
      ? undefined
      : await renderInlineImages(
          quality.graph,
          quality.report,
          {
            ...(input.cropBranchIds === undefined ? {} : { cropBranchIds: input.cropBranchIds }),
            ...(input.cropFocusIds === undefined ? {} : { cropFocusIds: input.cropFocusIds }),
            budget: renderBudget,
          },
          `${plan.id} · ${plan.focuses.length} focuses · layout ${quality.report.verdict}`,
        );
  // The layout verdict and the crop notes come first: the inline list is capped.
  const diagnostics = [
    ...[layoutVerdictDiagnostic(plan.id, quality.report, plan.sourceLocation)].filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    ),
    // A location keeps these in the group of the mod's own findings, which the inline list shows first.
    ...(inline?.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      ...(plan.sourceLocation === undefined ? {} : { location: plan.sourceLocation }),
    })),
    ...paletteImport.diagnostics,
    ...imported.diagnostics,
    ...withoutCurvedConnectorDiagnostics(rendered.diagnostics),
  ];
  const result = emptyServiceResult(context.workspaceId, {
    mode: 'national' as const,
    treeId: plan.id,
    layoutHash: rendered.layout.layoutHash,
    hashes: rendered.bundle.hashes,
    width: rendered.bundle.width,
    height: rendered.bundle.height,
    layoutQuality: layoutQualityOutput(quality.report, 'compact'),
    ...(inline === undefined ? {} : { inlineImages: inline.descriptions }),
  });
  result.code = rasterize ? 'FOCUS_RASTERIZED' : 'FOCUS_RENDERED';
  setInlineFilesScanned(
    result,
    [...new Set([plan.provenance.sourcePath, ...presentation.filesScanned])].sort((left, right) =>
      compareCodeUnits(left, right),
    ),
  );
  result.diagnostics = diagnostics.slice(0, 100);
  result.artifacts = rendered.artifacts.map(publicArtifactLink);
  const structure = validationFromDiagnostics(diagnostics);
  result.validation = {
    passed: structure.passed,
    checks: [
      ...structure.checks,
      layoutValidationCheck([{ treeId: plan.id, report: quality.report }]),
    ],
  };
  await context.progress(4, 4, `Focus ${outputName} complete`);
  return {
    result,
    sourceRevision: snapshot.revision,
    ...(inline === undefined || inline.images.length === 0 ? {} : { images: inline.images }),
  };
}
