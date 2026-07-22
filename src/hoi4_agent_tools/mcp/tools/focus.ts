import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import { compareCodeUnits, canonicalJson, hashCanonical } from '../../core/canonical.js';
import type { CoreEngine, ScanSnapshot } from '../../core/engine.js';
import type { ScannedFile } from '../../core/scanner.js';
import { RenderBudget } from '../../core/render-budget.js';
import { emptyServiceResult, ServiceError } from '../../core/result.js';
import { parseClausewitz } from '../../core/source/index.js';
import { readDependenciesFromScannedFiles } from '../../core/transactions.js';
import {
  FocusWorkbench,
  FOCUS_RENDER_MAX_OUTPUT_SCALE,
  FOCUS_RENDER_MIN_OUTPUT_SCALE,
  assertCompactLayoutQuality,
  compactFocusTreePlanAsync,
  focusPlanHash,
  focusPresentationEvidence,
  focusPlanningSidecarPath,
  importContinuousFocusPalettes,
  importFocusTrees,
  linkContinuousFocusPalettes,
  parseFocusPlanningSidecar,
  resolveFocusPresentation,
  enrichFocusPlanFromSidecar,
  type ContinuousFocusPalettePlan,
  type CompactFocusTreePlanAsyncResult,
  type FocusImportResult,
  type FocusLayoutResult,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from '../../focus/index.js';
import {
  continuousFocusPaletteSchema,
  focusLayoutMetricsSchema,
  focusLayoutSchema,
  focusTreePlanSchema,
} from '../../schemas/focus.js';
import { workspaceIdSchema, workspaceRelativePathSchema } from '../../schemas/common.js';
import { PACKAGE_VERSION } from '../../version.js';
import {
  nonNegativeIntegerSchema,
  renderHashesSchema,
  sha256Schema,
} from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';
import { requireServerScope, type ServerContext } from '../server/base-tools.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import {
  autonomousFailureContext,
  autonomousResultArtifacts,
  executePlannedTransaction,
} from '../server/transaction-execution.js';

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
const focusDriftBaseOutputSchema = z
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
const focusDriftOutputSchema = focusDriftBaseOutputSchema;
const continuousFocusDriftOutputSchema = focusDriftBaseOutputSchema;
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
        drift: continuousFocusDriftOutputSchema,
        created: z.boolean(),
        execution: z.enum(['applied', 'blocked', 'unchanged']),
        fileCount: nonNegativeIntegerSchema,
        artifactCount: nonNegativeIntegerSchema,
      })
      .strict(),
  ]),
);
const compactFocusPlanSchema = compactValidatedInputSchema(
  z.union([focusTreePlanSchema, continuousFocusPaletteSchema]),
  `Complete focus plan: https://github.com/klimPaskov/hoi4-agent-tools/blob/v${PACKAGE_VERSION}/docs/focus.md`,
);
const compactFocusLayoutSchema = compactValidatedInputSchema(
  focusLayoutSchema,
  'Prior deterministic focus layout used to stabilize unchanged positions.',
);

const focusInspectInput = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema.optional(),
    treeId: z.string().min(1).max(256).optional(),
    paletteId: z.string().min(1).max(256).optional(),
    previous: compactFocusLayoutSchema.optional(),
    laneSpacing: z.number().int().min(1).max(100).optional(),
    nodeSpacing: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? 'national';
    if (mode === 'national' && value.paletteId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['paletteId'],
        message: 'paletteId is only valid in continuous mode',
      });
    if (mode === 'continuous' && value.treeId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['treeId'],
        message: 'treeId is only valid in national mode',
      });
    if (mode === 'continuous') {
      for (const field of ['previous', 'laneSpacing', 'nodeSpacing'] as const) {
        if (value[field] !== undefined)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is only valid in national mode`,
          });
      }
    }
    if (value.previous !== undefined && value.treeId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['previous'],
        message: 'previous requires treeId so it applies to exactly one tree',
      });
  });

const focusRenderInput = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    treeId: z.string().min(1).max(256).optional(),
    paletteId: z.string().min(1).max(256).optional(),
    horizontalSpacing: z.number().int().min(80).max(1000).optional(),
    verticalSpacing: z.number().int().min(60).max(1000).optional(),
    reviewScale: z
      .number()
      .min(FOCUS_RENDER_MIN_OUTPUT_SCALE)
      .max(FOCUS_RENDER_MAX_OUTPUT_SCALE)
      .optional(),
    columns: z.number().int().min(1).max(12).optional(),
    padding: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? 'national';
    const invalid =
      mode === 'national'
        ? ([
            ['paletteId', value.paletteId],
            ['columns', value.columns],
          ] as const)
        : ([
            ['treeId', value.treeId],
            ['horizontalSpacing', value.horizontalSpacing],
            ['verticalSpacing', value.verticalSpacing],
            ['reviewScale', value.reviewScale],
          ] as const);
    for (const [field, fieldValue] of invalid) {
      if (fieldValue !== undefined)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not valid in ${mode} mode`,
        });
    }
    if (mode === 'continuous' && value.padding !== undefined && value.padding < 24)
      context.addIssue({
        code: 'custom',
        path: ['padding'],
        message: 'continuous focus padding must be at least 24 pixels',
      });
  });

const focusPlanInput = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    treeId: z.string().min(1).max(256).optional(),
    layoutMode: z.enum(['authored', 'compact']).default('authored'),
    plan: compactFocusPlanSchema.optional(),
    createIfMissing: z.boolean().default(false),
    horizontalSpacing: z.number().int().min(80).max(1000).optional(),
    verticalSpacing: z.number().int().min(60).max(1000).optional(),
    padding: z.number().int().min(0).max(1000).optional(),
    reviewScale: z
      .number()
      .min(FOCUS_RENDER_MIN_OUTPUT_SCALE)
      .max(FOCUS_RENDER_MAX_OUTPUT_SCALE)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? 'national';
    const schema = mode === 'continuous' ? continuousFocusPaletteSchema : focusTreePlanSchema;
    if (value.plan !== undefined && !schema.safeParse(value.plan).success)
      context.addIssue({
        code: 'custom',
        path: ['plan'],
        message: `plan must be a ${mode} focus plan`,
      });
    if (mode === 'continuous') {
      if (value.plan === undefined)
        context.addIssue({
          code: 'custom',
          path: ['plan'],
          message: 'plan is required in continuous mode',
        });
      if (value.treeId !== undefined)
        context.addIssue({
          code: 'custom',
          path: ['treeId'],
          message: 'treeId is only valid in national mode',
        });
      if (value.layoutMode !== 'authored')
        context.addIssue({
          code: 'custom',
          path: ['layoutMode'],
          message: 'compact layout mode is only valid in national mode',
        });
      for (const [field, fieldValue] of [
        ['horizontalSpacing', value.horizontalSpacing],
        ['verticalSpacing', value.verticalSpacing],
        ['padding', value.padding],
        ['reviewScale', value.reviewScale],
      ] as const) {
        if (fieldValue !== undefined)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is only valid for national focus review renders`,
          });
      }
    } else {
      if (value.plan === undefined && value.layoutMode !== 'compact')
        context.addIssue({
          code: 'custom',
          path: ['plan'],
          message: 'plan is required unless layoutMode is compact',
        });
      if (value.plan === undefined && value.treeId === undefined)
        context.addIssue({
          code: 'custom',
          path: ['treeId'],
          message: 'treeId is required for plan-free compact reflow',
        });
      if (value.plan === undefined && value.createIfMissing)
        context.addIssue({
          code: 'custom',
          path: ['createIfMissing'],
          message: 'plan-free compact reflow requires an existing focus source',
        });
      if (
        value.plan !== undefined &&
        value.treeId !== undefined &&
        'id' in value.plan &&
        value.plan.id !== value.treeId
      )
        context.addIssue({
          code: 'custom',
          path: ['treeId'],
          message: 'treeId must match the supplied national focus plan',
        });
    }
  });

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const LARGE_FOCUS_RENDER_NODE_THRESHOLD = 200;
const LARGE_FOCUS_RENDER_SCALE = 0.5;

function automaticFocusRenderScale(focusCount: number): number {
  return focusCount >= LARGE_FOCUS_RENDER_NODE_THRESHOLD ? LARGE_FOCUS_RENDER_SCALE : 1;
}

type FocusRenderInput = z.infer<typeof focusRenderInput>;
type ProgressExtra = Parameters<typeof progressReporter>[0];

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
  context: ServerContext,
  workspaceId: string,
  snapshot: ScanSnapshot,
  selectors: readonly FocusVisualRevisionSelector[],
  signal?: AbortSignal,
): Promise<FocusVisualRevision[]> {
  const workspace = engine.resolver.get(workspaceId, context.principal);
  const paletteImport = continuousPalettes(snapshot);
  const revisions: FocusVisualRevision[] = [];
  for (const selector of selectors) {
    signal?.throwIfAborted();
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
      ...(signal === undefined ? {} : { signal }),
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

async function executeFocusVisualTool(
  engine: CoreEngine,
  workbench: FocusWorkbench,
  context: ServerContext,
  input: FocusRenderInput,
  extra: ProgressExtra,
  rasterize: boolean,
) {
  const { workspaceId: requestedWorkspaceId, relativePath } = input;
  const workspaceId = engine.resolver.resolveWorkspaceId(requestedWorkspaceId, context.principal);
  const outputName = rasterize ? 'raster' : 'render';
  try {
    const progress = progressReporter(extra);
    await progress.report(0, 4, 'Importing and indexing focus source');
    const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
    await progress.report(1, 4, 'Focus source index complete');
    const workspace = engine.resolver.get(workspaceId, context.principal);
    const renderBudget = new RenderBudget();
    if (input.mode === 'continuous') {
      selectedContinuousFocusFile(snapshot, relativePath);
      const imported = await workbench.importContinuousPath(
        workspaceId,
        relativePath,
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
        signal: progress.signal,
      });
      await progress.report(2, 4, `Producing continuous focus ${outputName} artifacts`);
      const rendered = await workbench.renderContinuousAndStore(workspaceId, plan, {
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        presentation,
        sourceHashes: presentation.sourceHashes,
        ...(input.columns === undefined ? {} : { columns: input.columns }),
        ...(input.padding === undefined ? {} : { padding: input.padding }),
        renderProfile: { sourceRevision: snapshot.revision, output: outputName },
        rasterize,
        budget: renderBudget,
        signal: progress.signal,
      });
      const diagnostics = [...imported.result.diagnostics, ...rendered.diagnostics];
      const result = emptyServiceResult(workspaceId, {
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
        [...new Set([plan.provenance.sourcePath, ...presentation.filesScanned])].sort(
          (left, right) => compareCodeUnits(left, right),
        ),
      );
      result.diagnostics = diagnostics.slice(0, 100);
      result.artifacts = rendered.artifacts.map(publicArtifactLink);
      result.validation = validationFromDiagnostics(diagnostics);
      await progress.report(4, 4, `Continuous focus ${outputName} complete`);
      return toolResult(result);
    }
    const paletteImport = continuousPalettes(snapshot);
    const imported = importFocusFile(
      snapshot,
      selectedFocusFile(snapshot, workspace.registration.roots.focus, relativePath),
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
      signal: progress.signal,
    });
    await progress.report(2, 4, `Producing focus ${outputName} artifacts`);
    const effectiveReviewScale =
      input.reviewScale ?? automaticFocusRenderScale(plan.focuses.length);
    const rendered = await workbench.renderAndStore(workspaceId, plan, {
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
      renderProfile: {
        sourceRevision: snapshot.revision,
        reviewScale: effectiveReviewScale,
        output: outputName,
      },
      budget: renderBudget,
      signal: progress.signal,
    });
    const diagnostics = [
      ...paletteImport.diagnostics,
      ...imported.diagnostics,
      ...rendered.diagnostics,
    ];
    const result = emptyServiceResult(workspaceId, {
      mode: 'national' as const,
      treeId: plan.id,
      layoutHash: rendered.layout.layoutHash,
      hashes: rendered.bundle.hashes,
      width: rendered.bundle.width,
      height: rendered.bundle.height,
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
    result.validation = validationFromDiagnostics(diagnostics);
    await progress.report(4, 4, `Focus ${outputName} complete`);
    return toolResult(result);
  } catch (error) {
    return errorResult(error, workspaceId);
  }
}

function compactDrift(drift: { status: string; sourceChanged: boolean; planChanged: boolean }) {
  return {
    status: drift.status,
    sourceChanged: drift.sourceChanged,
    planChanged: drift.planChanged,
  };
}

function normalizedRoot(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
}

function underConfiguredRoot(relativePath: string, roots: readonly string[]): boolean {
  const candidate = relativePath.replaceAll('\\', '/').toLowerCase();
  return roots.some((root) => {
    const normalized = normalizedRoot(root);
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function activeFocusFiles(
  snapshot: ScanSnapshot,
  focusRoots: readonly string[],
): ScanSnapshot['files'] {
  return snapshot.files.filter(
    ({ relativePath, shadowedBy }) =>
      shadowedBy === undefined &&
      underConfiguredRoot(relativePath, focusRoots) &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

function activeContinuousFocusFiles(snapshot: ScanSnapshot): ScanSnapshot['files'] {
  return snapshot.files.filter(
    ({ relativePath, shadowedBy }) =>
      shadowedBy === undefined &&
      relativePath.replaceAll('\\', '/').toLowerCase().startsWith('common/continuous_focus/') &&
      relativePath.toLowerCase().endsWith('.txt'),
  );
}

function continuousPalettes(snapshot: ScanSnapshot): {
  palettes: ContinuousFocusPalettePlan[];
  diagnostics: FocusImportResult['diagnostics'];
} {
  const palettes: ContinuousFocusPalettePlan[] = [];
  const diagnostics: FocusImportResult['diagnostics'] = [];
  for (const file of activeContinuousFocusFiles(snapshot)) {
    const document = parseClausewitz(file.bytes, file.displayPath);
    const imported = importContinuousFocusPalettes(document);
    palettes.push(...imported.continuousFocusPalettes);
    diagnostics.push(...imported.diagnostics);
  }
  return { palettes, diagnostics };
}

function activeSidecar(
  snapshot: ScanSnapshot,
  focusFile: Pick<ScannedFile, 'relativePath'>,
): { file: ScannedFile; sidecar: ReturnType<typeof parseFocusPlanningSidecar> } | undefined {
  const relativePath = focusPlanningSidecarPath(focusFile.relativePath).toLowerCase();
  const file = snapshot.files.find(
    (candidate) =>
      candidate.shadowedBy === undefined && candidate.relativePath.toLowerCase() === relativePath,
  );
  return file === undefined ? undefined : { file, sidecar: parseFocusPlanningSidecar(file.bytes) };
}

function importFocusFile(
  snapshot: ScanSnapshot,
  file: ScannedFile,
  palettes: readonly ContinuousFocusPalettePlan[],
): FocusImportResult {
  const document = parseClausewitz(file.bytes, file.displayPath);
  const imported = importFocusTrees(document, { references: referenceCatalog(snapshot) });
  const sidecar = activeSidecar(snapshot, file);
  imported.plans = imported.plans.map((plan) => {
    const enriched =
      sidecar === undefined
        ? { plan, diagnostics: [] }
        : enrichFocusPlanFromSidecar(plan, sidecar.sidecar);
    imported.diagnostics.push(...enriched.diagnostics);
    return linkContinuousFocusPalettes(enriched.plan, palettes);
  });
  return imported;
}

function selectedFocusFile(
  snapshot: ScanSnapshot,
  focusRoots: readonly string[],
  relativePath: string,
): ScannedFile {
  const file = activeFocusFiles(snapshot, focusRoots).find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (file === undefined) {
    throw new ServiceError('FOCUS_SOURCE_NOT_FOUND', `Focus source was not found: ${relativePath}`);
  }
  return file;
}

function selectedContinuousFocusFile(snapshot: ScanSnapshot, relativePath: string): ScannedFile {
  const file = activeContinuousFocusFiles(snapshot).find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (file === undefined) {
    throw new ServiceError(
      'CONTINUOUS_FOCUS_SOURCE_NOT_FOUND',
      `Continuous focus source was not found: ${relativePath}`,
    );
  }
  return file;
}

function selectPlan(result: FocusImportResult, treeId: string | undefined): FocusTreePlan {
  if (result.plans.length === 0) {
    throw new ServiceError('FOCUS_TREE_NOT_FOUND', 'The source file contains no focus tree');
  }
  if (treeId === undefined) {
    if (result.plans.length !== 1) {
      throw new ServiceError(
        'FOCUS_TREE_ID_REQUIRED',
        'The source file contains multiple focus trees; provide treeId',
        { treeIds: result.plans.map(({ id }) => id) },
      );
    }
    return result.plans[0]!;
  }
  const plan = result.plans.find(({ id }) => id === treeId);
  if (plan === undefined) {
    throw new ServiceError('FOCUS_TREE_NOT_FOUND', `Focus tree was not found: ${treeId}`);
  }
  return plan;
}

function selectContinuousPlan(
  result: FocusImportResult,
  paletteId: string | undefined,
): ContinuousFocusPalettePlan {
  if (result.continuousFocusPalettes.length === 0) {
    throw new ServiceError(
      'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
      'The source file contains no continuous focus palette',
    );
  }
  if (paletteId === undefined) {
    if (result.continuousFocusPalettes.length !== 1) {
      throw new ServiceError(
        'CONTINUOUS_FOCUS_PALETTE_ID_REQUIRED',
        'The source file contains multiple continuous focus palettes; provide paletteId',
        { paletteIds: result.continuousFocusPalettes.map(({ id }) => id) },
      );
    }
    return result.continuousFocusPalettes[0]!;
  }
  const plan = result.continuousFocusPalettes.find(({ id }) => id === paletteId);
  if (plan === undefined) {
    throw new ServiceError(
      'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
      `Continuous focus palette was not found: ${paletteId}`,
    );
  }
  return plan;
}

function referenceCatalog(snapshot: ScanSnapshot): FocusReferenceCatalog {
  const identifiers = (kind: Parameters<ScanSnapshot['index']['findAll']>[0]): string[] =>
    [
      ...new Set(
        snapshot.index
          .findAll(kind)
          .filter(({ overridden }) => !overridden)
          .map(({ id }) => id),
      ),
    ].sort((left, right) => compareCodeUnits(left, right));
  return {
    decision: identifiers('decision'),
    decision_category: identifiers('decision_category'),
    event: identifiers('event'),
    idea: identifiers('idea'),
    leader: identifiers('leader'),
    formable: identifiers('formable'),
    helper: identifiers('scripted_effect'),
  };
}

function validationFromDiagnostics(diagnostics: FocusImportResult['diagnostics']): {
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; message: string }>;
} {
  const blocking = diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  return {
    passed: blocking.length === 0,
    checks: [
      {
        id: 'focus-diagnostics',
        passed: blocking.length === 0,
        message:
          blocking.length === 0
            ? 'Focus source, references, and layout have no blocking diagnostics'
            : `${blocking.length} blocking focus diagnostics`,
      },
    ],
  };
}

export function registerFocusTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const workbench = new FocusWorkbench(engine.resolver, engine.transactions, engine.artifacts);

  server.registerTool(
    'hoi4.focus_inspect',
    {
      title: 'Inspect focus trees',
      description:
        'Inspect national trees or continuous palettes for creation and cleanup, including complete plans, references, diagnostics, and stable layout decisions.',
      inputSchema: focusInspectInput,
      outputSchema: focusInspectOutputSchema,
      annotations: artifactProducing,
    },
    async (input, extra) => {
      const { workspaceId: requestedWorkspaceId, relativePath } = input;
      const workspaceId = engine.resolver.resolveWorkspaceId(
        requestedWorkspaceId,
        context.principal,
      );
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Building shared workspace index');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
        const workspace = engine.resolver.get(workspaceId, context.principal);
        if (input.mode === 'continuous') {
          const selectedFiles = activeContinuousFocusFiles(snapshot).filter(
            (file) => relativePath === undefined || file.relativePath === relativePath,
          );
          if (selectedFiles.length === 0) {
            throw new ServiceError(
              'CONTINUOUS_FOCUS_SOURCE_NOT_FOUND',
              'No active continuous focus source matched the request',
            );
          }
          const diagnostics = [] as FocusImportResult['diagnostics'];
          const importedPalettes: ContinuousFocusPalettePlan[] = [];
          for (const file of selectedFiles) {
            progress.signal.throwIfAborted();
            const imported = importContinuousFocusPalettes(
              parseClausewitz(file.bytes, file.displayPath),
            );
            importedPalettes.push(...imported.continuousFocusPalettes);
            diagnostics.push(...imported.diagnostics);
          }
          const palettes = importedPalettes.filter(
            ({ id }) => input.paletteId === undefined || id === input.paletteId,
          );
          if (palettes.length === 0) {
            throw new ServiceError(
              'CONTINUOUS_FOCUS_PALETTE_NOT_FOUND',
              input.paletteId === undefined
                ? 'The selected source contains no continuous focus palette'
                : `Continuous focus palette was not found: ${input.paletteId}`,
            );
          }
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
            signal: progress.signal,
          });
          diagnostics.push(...presentation.diagnostics);
          await progress.report(2, 3, 'Writing continuous focus inspection');
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
            progress.signal,
          );
          const result = emptyServiceResult(workspaceId, {
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
          await progress.report(3, 3, 'Continuous focus inspection complete');
          return toolResult(result);
        }
        const selectedFiles = activeFocusFiles(snapshot, workspace.registration.roots.focus).filter(
          (file) => relativePath === undefined || file.relativePath === relativePath,
        );
        if (selectedFiles.length === 0) {
          throw new ServiceError(
            'FOCUS_SOURCE_NOT_FOUND',
            'No active focus source matched the request',
          );
        }
        const selectedSidecarFiles = selectedFiles.flatMap((file) => {
          const resolved = activeSidecar(snapshot, file);
          return resolved === undefined ? [] : [resolved.file];
        });
        const importedPlans: FocusTreePlan[] = [];
        const diagnostics = [] as FocusImportResult['diagnostics'];
        const paletteImport = continuousPalettes(snapshot);
        diagnostics.push(...paletteImport.diagnostics);
        for (const file of selectedFiles) {
          progress.signal.throwIfAborted();
          const imported = importFocusFile(snapshot, file, paletteImport.palettes);
          importedPlans.push(...imported.plans);
          diagnostics.push(...imported.diagnostics);
        }
        const plans = importedPlans.filter(
          ({ id }) => input.treeId === undefined || id === input.treeId,
        );
        if (plans.length === 0) {
          throw new ServiceError(
            'FOCUS_TREE_NOT_FOUND',
            input.treeId === undefined
              ? 'The selected source contains no national focus tree'
              : `Focus tree was not found: ${input.treeId}`,
          );
        }
        const inspectedPlans: Array<{
          plan: FocusTreePlan;
          layout: FocusLayoutResult;
          diagnosticCount: number;
        }> = [];
        for (const plan of plans) {
          const layout = await workbench.layoutAsync(plan, {
            ...(input.previous === undefined
              ? {}
              : { previous: input.previous as FocusLayoutResult }),
            ...(input.laneSpacing === undefined ? {} : { laneSpacing: input.laneSpacing }),
            ...(input.nodeSpacing === undefined ? {} : { nodeSpacing: input.nodeSpacing }),
            signal: progress.signal,
          });
          const lintDiagnostics = workbench.lint(plan, {
            index: snapshot.index,
            references: referenceCatalog(snapshot),
            layout,
          });
          diagnostics.push(...lintDiagnostics);
          inspectedPlans.push({ plan, layout, diagnosticCount: lintDiagnostics.length });
        }
        const presentation = await resolveFocusPresentation({
          plans,
          palettes: paletteImport.palettes,
          files: snapshot.files,
          index: snapshot.index,
          scanner: engine.scanner,
          workspace,
          decodeIcons: false,
          signal: progress.signal,
        });
        diagnostics.push(...presentation.diagnostics);
        await progress.report(2, 3, 'Writing focus plans, diagnostics, and layouts');
        const completeSourceHashes = Object.fromEntries(
          Object.entries({
            ...Object.fromEntries(
              [
                ...selectedFiles,
                ...selectedSidecarFiles,
                ...activeContinuousFocusFiles(snapshot),
              ].map(({ displayPath, sha256 }) => [displayPath, sha256]),
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
            layouts: inspectedPlans.map(({ plan, layout, diagnosticCount }) => ({
              treeId: plan.id,
              layout,
              diagnosticCount,
            })),
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
          progress.signal,
        );
        const result = emptyServiceResult(workspaceId, {
          mode: 'national' as const,
          revision: snapshot.revision,
          treeCount: plans.length,
          paletteCount: paletteImport.palettes.length,
          trees: inspectedPlans.slice(0, 100).map(({ plan, layout, diagnosticCount }) => ({
            id: plan.id,
            sourcePath: plan.provenance.sourcePath,
            focusCount: plan.focuses.length,
            branchCount: plan.branchGroups.length,
            continuousPaletteCount: plan.continuousFocusPaletteIds.length,
            continuousFocusCount: plan.continuousFocusIds.length,
            resolvedTitleCount: plan.focuses.filter(
              ({ id }) => presentation.entries[id]?.titleSourceLocation !== undefined,
            ).length,
            layoutHash: layout.layoutHash,
            layoutDecisionCount: layout.decisions.length,
            layoutMetrics: layout.metrics!,
            diagnosticCount,
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
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(artifact)];
        result.validation = validationFromDiagnostics(diagnostics);
        await progress.report(3, 3, 'Focus inspection complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.focus_render',
    {
      title: 'Render focus review artifacts',
      description:
        'Render a national tree or continuous palette as fast deterministic HTML, SVG, JSON, and source-map artifacts. Use hoi4.focus_raster when decoded icons and PNG output are needed.',
      inputSchema: focusRenderInput,
      outputSchema: focusRenderOutputSchema,
      annotations: artifactProducing,
    },
    (input, extra) => executeFocusVisualTool(engine, workbench, context, input, extra, false),
  );

  server.registerTool(
    'hoi4.focus_raster',
    {
      title: 'Rasterize focus review artifacts',
      description:
        'Produce the high-fidelity focus review with decoded source icons and deterministic PNG output. Use focus_render for the faster structural HTML, SVG, and JSON view.',
      inputSchema: focusRenderInput,
      outputSchema: focusRenderOutputSchema,
      annotations: artifactProducing,
    },
    (input, extra) => executeFocusVisualTool(engine, workbench, context, input, extra, true),
  );

  server.registerTool(
    'hoi4.focus_rewrite',
    {
      title: 'Create or clean up focus content',
      description:
        'Create or clean up a national tree or continuous palette, validate it, and apply it in one call. Supply a complete plan; set layoutMode compact for automatic arrangement. Existing national trees can omit the plan and use treeId plus layoutMode compact. Set createIfMissing for a new file.',
      inputSchema: focusPlanInput,
      outputSchema: focusPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const {
        workspaceId: requestedWorkspaceId,
        relativePath,
        createIfMissing,
        horizontalSpacing,
        verticalSpacing,
        padding,
        reviewScale,
      } = input;
      const workspaceId = engine.resolver.resolveWorkspaceId(
        requestedWorkspaceId,
        context.principal,
      );
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 5, 'Validating shared index and current source');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
        const workspace = engine.resolver.get(workspaceId, context.principal);
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
              : await workbench.importContinuousPath(workspaceId, relativePath, context.principal);
          const currentPlan = imported?.result.continuousFocusPalettes.find(
            ({ id }) => id === plan.id,
          );
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
            signal: progress.signal,
          });
          await progress.report(1, 5, 'Building proposed continuous focus review');
          const proposedPlanHash = focusPlanHash(plan);
          const reviewPlan: ContinuousFocusPalettePlan = {
            ...plan,
            provenance: {
              sourcePath: `plan:${plan.id}`,
              sourceHash: proposedPlanHash,
              importedPlanHash: proposedPlanHash,
            },
          };
          const proposed = await workbench.renderContinuousAndStore(workspaceId, reviewPlan, {
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
            signal: progress.signal,
          });
          const reviewArtifacts = proposed.artifacts.map(publicArtifactLink);
          await progress.report(3, 5, 'Preparing the continuous focus rewrite');
          const planned = await workbench.planContinuousChanges({
            workspaceId,
            relativePath,
            plan,
            createIfMissing,
            authority: 'plan',
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            artifacts: reviewArtifacts,
            readDependencies: readDependenciesFromScannedFiles(snapshot.files),
            signal: progress.signal,
          });
          await progress.report(4, 5, 'Applying and validating the continuous focus rewrite');
          const execution = await executePlannedTransaction(
            engine,
            planned.transaction,
            context.principal,
            progress.signal,
          );
          const transaction = execution.transaction;
          const result = emptyServiceResult(workspaceId, {
            mode: 'continuous' as const,
            paletteId: plan.id,
            drift: compactDrift(planned.drift),
            created: planned.drift.status === 'target_missing',
            execution: execution.outcome,
            fileCount: transaction.files.length,
            artifactCount: transaction.artifacts.length,
          });
          result.status = transaction.validation.passed ? 'ok' : 'blocked';
          result.code =
            execution.outcome === 'applied'
              ? 'CONTINUOUS_FOCUS_CHANGES_APPLIED'
              : execution.outcome === 'unchanged'
                ? 'CONTINUOUS_FOCUS_CHANGES_UNCHANGED'
                : 'CONTINUOUS_FOCUS_CHANGES_BLOCKED';
          setInlineFilesScanned(
            result,
            [
              ...new Set([
                ...(sourceFile === undefined ? [] : [sourceFile.displayPath]),
                ...presentation.filesScanned,
              ]),
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
            5,
            5,
            execution.outcome === 'applied'
              ? 'Continuous focus rewrite complete'
              : execution.outcome === 'unchanged'
                ? 'Continuous focus content already satisfied the plan'
                : 'Continuous focus rewrite blocked',
          );
          return toolResult(result);
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
                workspaceId,
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
              signal: progress.signal,
            });
            plan = compactPlanning.plan;
          } else {
            plan = suppliedPlan;
          }
        } else {
          if (imported === undefined)
            throw new ServiceError(
              'FOCUS_COMPACT_SOURCE_REQUIRED',
              'Plan-free compact reflow requires an existing national focus source',
              { relativePath },
            );
          compactSourcePlan = selectPlan(imported.result, input.treeId);
          compactPlanning = await compactFocusTreePlanAsync(compactSourcePlan, {
            signal: progress.signal,
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
          signal: progress.signal,
        });
        const currentLayout =
          currentPlan === undefined
            ? undefined
            : currentPlan === compactSourcePlan && compactPlanning !== undefined
              ? compactPlanning.currentLayout
              : await workbench.layoutAsync(currentPlan, { signal: progress.signal });
        await progress.report(1, 5, 'Building proposed focus review');
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
          (await workbench.layoutAsync(reviewPlan, { signal: progress.signal }));
        if (input.layoutMode === 'compact') {
          assertCompactLayoutQuality(currentLayout, proposedLayout);
        }
        const proposed = await workbench.renderAndStore(workspaceId, reviewPlan, {
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
          signal: progress.signal,
          layout: proposedLayout,
        });
        const reviewArtifacts = proposed.artifacts.map(publicArtifactLink);
        await progress.report(3, 5, 'Preparing the focus-tree rewrite');
        const planned = await workbench.planChanges({
          workspaceId,
          relativePath,
          plan,
          createIfMissing,
          authority: 'plan',
          layout: proposed.layout,
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          index: snapshot.index,
          references: catalog,
          artifacts: reviewArtifacts,
          readDependencies: readDependenciesFromScannedFiles(snapshot.files),
          signal: progress.signal,
        });
        await progress.report(4, 5, 'Applying and validating the focus-tree rewrite');
        const execution = await executePlannedTransaction(
          engine,
          planned.transaction,
          context.principal,
          progress.signal,
        );
        const transaction = execution.transaction;
        const result = emptyServiceResult(workspaceId, {
          mode: 'national' as const,
          treeId: plan.id,
          drift: compactDrift(planned.drift),
          created: planned.drift.status === 'target_missing',
          execution: execution.outcome,
          layoutHash: planned.layout.layoutHash,
          fileCount: transaction.files.length,
          artifactCount: transaction.artifacts.length,
        });
        result.status = transaction.validation.passed ? 'ok' : 'blocked';
        result.code =
          execution.outcome === 'applied'
            ? 'FOCUS_CHANGES_APPLIED'
            : execution.outcome === 'unchanged'
              ? 'FOCUS_CHANGES_UNCHANGED'
              : 'FOCUS_CHANGES_BLOCKED';
        setInlineFilesScanned(
          result,
          [
            ...new Set([
              ...(focusFile === undefined ? [] : [focusFile.displayPath]),
              ...presentation.filesScanned,
            ]),
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
          5,
          5,
          execution.outcome === 'applied'
            ? 'Focus rewrite complete'
            : execution.outcome === 'unchanged'
              ? 'Focus content already satisfied the plan'
              : 'Focus rewrite blocked',
        );
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId, autonomousFailureContext(error));
      }
    },
  );
}
