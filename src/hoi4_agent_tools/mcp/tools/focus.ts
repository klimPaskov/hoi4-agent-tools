import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { boundedSourceHashEvidence, publicArtifactLink } from '../../core/artifacts.js';
import { compareCodeUnits, canonicalJson, sha256Bytes } from '../../core/canonical.js';
import type { CoreEngine, ScanSnapshot } from '../../core/engine.js';
import type { ScannedFile } from '../../core/scanner.js';
import { comparePngImages, createTransparentPng } from '../../core/image-diff.js';
import { RenderBudget } from '../../core/render-budget.js';
import { emptyServiceResult, ServiceError } from '../../core/result.js';
import { parseClausewitz } from '../../core/source/index.js';
import { readDependenciesFromScannedFiles } from '../../core/transactions.js';
import {
  FocusWorkbench,
  FOCUS_RENDER_MAX_OUTPUT_SCALE,
  FOCUS_RENDER_MIN_OUTPUT_SCALE,
  assertFocusPlanAuthority,
  detectContinuousFocusDrift,
  detectFocusDrift,
  focusPlanHash,
  focusPresentationEvidence,
  focusPlanningSidecarPath,
  importContinuousFocusPalettes,
  importFocusTrees,
  linkContinuousFocusPalettes,
  parseFocusPlanningSidecar,
  renderContinuousFocusPalette,
  renderFocusTree,
  resolveFocusPresentation,
  enrichFocusPlanFromSidecar,
  type ContinuousFocusPalettePlan,
  type FocusImportResult,
  type FocusLayoutResult,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from '../../focus/index.js';
import {
  continuousFocusPaletteSchema,
  focusLayoutDecisionSchema,
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
import {
  requireServerScope,
  transactionResourceLink,
  type ServerContext,
} from '../server/base-tools.js';

const focusScanOutputSchema = strictOperationResultSchema(
  z
    .object({
      revision: sha256Schema,
      treeCount: nonNegativeIntegerSchema,
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
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
);
const focusLintOutputSchema = strictOperationResultSchema(
  z.discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('national'),
        treeId: z.string().max(256),
        focusCount: nonNegativeIntegerSchema,
        layoutHash: sha256Schema,
        diagnosticCount: nonNegativeIntegerSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal('continuous'),
        paletteId: z.string().max(256),
        focusCount: nonNegativeIntegerSchema,
        diagnosticCount: nonNegativeIntegerSchema,
      })
      .strict(),
  ]),
);
const focusLayoutOutputSchema = strictOperationResultSchema(
  z
    .object({
      treeId: z.string().max(256),
      layoutHash: sha256Schema,
      nodeCount: nonNegativeIntegerSchema,
      decisions: z.array(focusLayoutDecisionSchema).max(100),
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
    requiresAuthority: z.boolean(),
    savedPlanHash: sha256Schema,
    currentPlanHash: z.string().max(256),
    importedPlanHash: sha256Schema,
    savedSourceHash: sha256Schema,
    currentSourceHash: sha256Schema,
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
        layoutHash: sha256Schema,
        expiresAt: z.iso.datetime(),
        transactionFileCount: nonNegativeIntegerSchema,
        transactionArtifactCount: nonNegativeIntegerSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal('continuous'),
        paletteId: z.string().max(256),
        drift: continuousFocusDriftOutputSchema,
        created: z.boolean(),
        expiresAt: z.iso.datetime(),
        transactionFileCount: nonNegativeIntegerSchema,
        transactionArtifactCount: nonNegativeIntegerSchema,
      })
      .strict(),
  ]),
);

const focusPathInput = z
  .object({
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    treeId: z.string().min(1).max(256).optional(),
  })
  .strict();

const focusLintInput = z
  .object({
    mode: z.enum(['national', 'continuous']).optional(),
    workspaceId: workspaceIdSchema,
    relativePath: workspaceRelativePathSchema,
    treeId: z.string().min(1).max(256).optional(),
    paletteId: z.string().min(1).max(256).optional(),
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
    plan: z.union([focusTreePlanSchema, continuousFocusPaletteSchema]),
    authority: z.enum(['plan', 'source']).optional(),
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
    if (!schema.safeParse(value.plan).success)
      context.addIssue({
        code: 'custom',
        path: ['plan'],
        message: `plan must be a ${mode} focus plan`,
      });
    if (mode === 'continuous') {
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
            message: `${field} is only valid for national focus transaction review renders`,
          });
      }
    }
  });

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function compactDrift<T extends { currentSourcePlan?: unknown }>(
  drift: T,
): Omit<T, 'currentSourcePlan'> {
  const { currentSourcePlan: _currentSourcePlan, ...summary } = drift;
  return summary;
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
    'hoi4.focus_scan',
    {
      title: 'Scan focus trees',
      description:
        'Import active focus-tree source through the shared lossless parser and return compact summaries plus a full resource artifact.',
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          relativePath: workspaceRelativePathSchema.optional(),
        })
        .strict(),
      outputSchema: focusScanOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, relativePath }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Building shared workspace index');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
        const workspace = engine.resolver.get(workspaceId, context.principal);
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
        const plans: FocusTreePlan[] = [];
        const diagnostics = [] as FocusImportResult['diagnostics'];
        const paletteImport = continuousPalettes(snapshot);
        diagnostics.push(...paletteImport.diagnostics);
        for (const file of selectedFiles) {
          progress.signal.throwIfAborted();
          const imported = importFocusFile(snapshot, file, paletteImport.palettes);
          plans.push(...imported.plans);
          diagnostics.push(...imported.diagnostics);
        }
        const presentation = await resolveFocusPresentation({
          plans,
          palettes: paletteImport.palettes,
          files: snapshot.files,
          index: snapshot.index,
          scanner: engine.scanner,
          workspace,
          signal: progress.signal,
        });
        diagnostics.push(...presentation.diagnostics);
        await progress.report(2, 3, 'Writing imported planning models');
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
          `focus-scan.${snapshot.revision.slice(0, 16)}.json`,
          'application/json',
          `${canonicalJson({
            schemaVersion: 1,
            revision: snapshot.revision,
            plans,
            continuousFocusPalettes: paletteImport.palettes,
            presentation: focusPresentationEvidence(presentation),
            sourceHashes: completeSourceHashes,
            diagnostics,
          })}\n`,
          {
            kind: 'focus-scan',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'focus-scan.v1',
            sourceHashes: sourceEvidence.sourceHashes,
            metadata: { sourceHashInventory: sourceEvidence.inventory },
          },
          'Imported focus planning models and source-linked diagnostics',
          progress.signal,
        );
        const result = emptyServiceResult(workspaceId, {
          revision: snapshot.revision,
          treeCount: plans.length,
          trees: plans.slice(0, 100).map((plan) => ({
            id: plan.id,
            sourcePath: plan.provenance.sourcePath,
            focusCount: plan.focuses.length,
            branchCount: plan.branchGroups.length,
            continuousPaletteCount: plan.continuousFocusPaletteIds.length,
            continuousFocusCount: plan.continuousFocusIds.length,
            resolvedTitleCount: plan.focuses.filter(
              ({ id }) => presentation.entries[id]?.titleSourceLocation !== undefined,
            ).length,
          })),
        });
        result.code = 'FOCUS_SCANNED';
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
        await progress.report(3, 3, 'Focus scan complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.focus_lint',
    {
      title: 'Lint focus source',
      description:
        'Lint one national focus tree or continuous focus palette. Omit mode for backward-compatible national behavior.',
      inputSchema: focusLintInput,
      outputSchema: focusLintOutputSchema,
      annotations: artifactProducing,
    },
    async (input, extra) => {
      const { workspaceId, relativePath } = input;
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Importing and indexing focus source');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
        const workspace = engine.resolver.get(workspaceId, context.principal);
        if (input.mode === 'continuous') {
          selectedContinuousFocusFile(snapshot, relativePath);
          const imported = await workbench.importContinuousPath(
            workspaceId,
            relativePath,
            context.principal,
          );
          const plan = selectContinuousPlan(imported.result, input.paletteId);
          const diagnostics = [...imported.result.diagnostics, ...workbench.lintContinuous(plan)];
          await progress.report(2, 3, 'Writing continuous focus lint evidence');
          const artifact = await engine.artifacts.put(
            workspace,
            `${plan.id.replace(/[^A-Za-z0-9._-]/gu, '_')}.continuous-focus-lint.json`,
            'application/json',
            `${canonicalJson({ schemaVersion: 1, mode: 'continuous', paletteId: plan.id, diagnostics })}\n`,
            {
              kind: 'continuous-focus-lint',
              toolVersion: PACKAGE_VERSION,
              schemaVersion: 'continuous-focus-lint.v1',
              sourceHashes: { [plan.provenance.sourcePath]: plan.provenance.sourceHash },
            },
            'Complete continuous focus lint report',
            progress.signal,
          );
          const result = emptyServiceResult(workspaceId, {
            mode: 'continuous' as const,
            paletteId: plan.id,
            focusCount: plan.focuses.length,
            diagnosticCount: diagnostics.length,
          });
          result.code = 'CONTINUOUS_FOCUS_LINTED';
          setInlineFilesScanned(result, [plan.provenance.sourcePath]);
          result.diagnostics = diagnostics.slice(0, 100);
          result.artifacts = [publicArtifactLink(artifact)];
          result.validation = validationFromDiagnostics(diagnostics);
          await progress.report(3, 3, 'Continuous focus lint complete');
          return toolResult(result);
        }
        const paletteImport = continuousPalettes(snapshot);
        const imported = importFocusFile(
          snapshot,
          selectedFocusFile(snapshot, workspace.registration.roots.focus, relativePath),
          paletteImport.palettes,
        );
        const plan = selectPlan(imported, input.treeId);
        const layout = await workbench.layoutAsync(plan, { signal: progress.signal });
        const diagnostics = [
          ...paletteImport.diagnostics,
          ...imported.diagnostics,
          ...workbench.lint(plan, {
            index: snapshot.index,
            references: referenceCatalog(snapshot),
            layout,
          }),
        ];
        await progress.report(2, 3, 'Writing focus lint evidence');
        const artifact = await engine.artifacts.put(
          workspace,
          `${plan.id.replace(/[^A-Za-z0-9._-]/gu, '_')}.focus-lint.json`,
          'application/json',
          `${canonicalJson({ schemaVersion: 1, treeId: plan.id, layoutHash: layout.layoutHash, diagnostics })}\n`,
          {
            kind: 'focus-lint',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'focus-lint.v1',
            sourceHashes: { [plan.provenance.sourcePath]: plan.provenance.sourceHash },
          },
          'Complete focus lint report',
          progress.signal,
        );
        const result = emptyServiceResult(workspaceId, {
          mode: 'national' as const,
          treeId: plan.id,
          focusCount: plan.focuses.length,
          layoutHash: layout.layoutHash,
          diagnosticCount: diagnostics.length,
        });
        result.code = 'FOCUS_LINTED';
        setInlineFilesScanned(result, [plan.provenance.sourcePath]);
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(artifact)];
        result.validation = validationFromDiagnostics(diagnostics);
        await progress.report(3, 3, 'Focus lint complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.focus_layout',
    {
      title: 'Plan stable focus layout',
      description:
        'Create a deterministic constraint layout while preserving pinned, relative, and previous automatic positions. Imported authored coordinates remain fixed; a full existing-tree repair must submit a complete plan whose movable nodes use position.mode "auto".',
      inputSchema: focusPathInput
        .extend({
          previous: focusLayoutSchema.optional(),
          laneSpacing: z.number().int().min(1).max(100).optional(),
          nodeSpacing: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      outputSchema: focusLayoutOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, relativePath, treeId, previous, laneSpacing, nodeSpacing }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Importing and indexing focus source');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const paletteImport = continuousPalettes(snapshot);
        const imported = importFocusFile(
          snapshot,
          selectedFocusFile(snapshot, workspace.registration.roots.focus, relativePath),
          paletteImport.palettes,
        );
        const plan = selectPlan(imported, treeId);
        const layout = await workbench.layoutAsync(plan, {
          ...(previous === undefined ? {} : { previous: previous as FocusLayoutResult }),
          ...(laneSpacing === undefined ? {} : { laneSpacing }),
          ...(nodeSpacing === undefined ? {} : { nodeSpacing }),
          signal: progress.signal,
        });
        progress.signal.throwIfAborted();
        await progress.report(2, 3, 'Writing stable focus layout evidence');
        const artifact = await engine.artifacts.put(
          workspace,
          `${plan.id.replace(/[^A-Za-z0-9._-]/gu, '_')}.focus-layout.json`,
          'application/json',
          `${canonicalJson(layout)}\n`,
          {
            kind: 'focus-layout',
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'focus-layout.v1',
            sourceHashes: { [plan.provenance.sourcePath]: plan.provenance.sourceHash },
          },
          'Stable focus layout decisions and diagnostics',
          progress.signal,
        );
        const diagnostics = [
          ...paletteImport.diagnostics,
          ...imported.diagnostics,
          ...layout.diagnostics,
        ];
        const result = emptyServiceResult(workspaceId, {
          treeId: plan.id,
          layoutHash: layout.layoutHash,
          nodeCount: layout.nodes.length,
          decisions: layout.decisions.slice(0, 100),
        });
        result.code = 'FOCUS_LAYOUT_PLANNED';
        setInlineFilesScanned(result, [plan.provenance.sourcePath]);
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = [publicArtifactLink(artifact)];
        result.validation = validationFromDiagnostics(diagnostics);
        await progress.report(3, 3, 'Focus layout complete');
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
        'Generate deterministic HTML, SVG, genuine PNG, JSON, and source-map artifacts for a national tree or continuous palette. Omit mode for national behavior. National renders accept a uniform reviewScale from 0.25 through 1.0 so very large trees can fit bounded artifacts without changing logical node geometry or source coordinates.',
      inputSchema: focusRenderInput,
      outputSchema: focusRenderOutputSchema,
      annotations: artifactProducing,
    },
    async (input, extra) => {
      const { workspaceId, relativePath } = input;
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Importing and indexing focus source');
        const snapshot = await engine.scan(workspaceId, {}, context.principal, progress.signal);
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
            budget: renderBudget,
            signal: progress.signal,
          });
          await progress.report(1, 3, 'Rendering continuous focus artifacts');
          const rendered = await workbench.renderContinuousAndStore(workspaceId, plan, {
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            presentation,
            sourceHashes: presentation.sourceHashes,
            ...(input.columns === undefined ? {} : { columns: input.columns }),
            ...(input.padding === undefined ? {} : { padding: input.padding }),
            renderProfile: { sourceRevision: snapshot.revision },
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
          result.code = 'CONTINUOUS_FOCUS_RENDERED';
          setInlineFilesScanned(
            result,
            [...new Set([plan.provenance.sourcePath, ...presentation.filesScanned])].sort(
              (left, right) => compareCodeUnits(left, right),
            ),
          );
          result.diagnostics = diagnostics.slice(0, 100);
          result.artifacts = rendered.artifacts.map(publicArtifactLink);
          result.validation = validationFromDiagnostics(diagnostics);
          await progress.report(3, 3, 'Continuous focus render complete');
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
          budget: renderBudget,
          signal: progress.signal,
        });
        await progress.report(1, 3, 'Rendering focus artifacts');
        const rendered = await workbench.renderAndStore(workspaceId, plan, {
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          index: snapshot.index,
          references: referenceCatalog(snapshot),
          presentation,
          sourceHashes: presentation.sourceHashes,
          ...(input.horizontalSpacing === undefined
            ? {}
            : { horizontalSpacing: input.horizontalSpacing }),
          ...(input.verticalSpacing === undefined
            ? {}
            : { verticalSpacing: input.verticalSpacing }),
          ...(input.padding === undefined ? {} : { padding: input.padding }),
          ...(input.reviewScale === undefined ? {} : { outputScale: input.reviewScale }),
          renderProfile: {
            sourceRevision: snapshot.revision,
            ...(input.reviewScale === undefined ? {} : { reviewScale: input.reviewScale }),
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
        result.code = 'FOCUS_RENDERED';
        setInlineFilesScanned(
          result,
          [...new Set([plan.provenance.sourcePath, ...presentation.filesScanned])].sort(
            (left, right) => compareCodeUnits(left, right),
          ),
        );
        result.diagnostics = diagnostics.slice(0, 100);
        result.artifacts = rendered.artifacts.map(publicArtifactLink);
        result.validation = validationFromDiagnostics(diagnostics);
        await progress.report(3, 3, 'Focus render complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.focus_plan_changes',
    {
      title: 'Dry-run focus source changes',
      description:
        'Compile a validated national tree or continuous palette plan into source and create a hash-bound dry-run transaction; never applies it. Omit mode for national behavior. National plans accept the same bounded horizontalSpacing, verticalSpacing, and padding controls as focus_render plus a uniform reviewScale that preserves logical SVG geometry while reducing both before/proposed raster outputs. For an unoccupied new source, pass createIfMissing: true with plan:<id> and zero-hash creation provenance.',
      inputSchema: focusPlanInput,
      outputSchema: focusPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const {
        workspaceId,
        relativePath,
        authority,
        createIfMissing,
        horizontalSpacing,
        verticalSpacing,
        padding,
        reviewScale,
      } = input;
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 5, 'Validating shared index and source authority');
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
          if (currentPlan !== undefined && imported !== undefined)
            assertFocusPlanAuthority(
              detectContinuousFocusDrift(plan, imported.document),
              authority,
            );
          const renderBudget = new RenderBudget();
          const presentation = await resolveFocusPresentation({
            plans: [],
            palettes: [...(currentPlan === undefined ? [] : [currentPlan]), plan],
            files: snapshot.files,
            index: snapshot.index,
            scanner: engine.scanner,
            workspace,
            budget: renderBudget,
            signal: progress.signal,
          });
          const currentDiagnostics =
            currentPlan === undefined
              ? []
              : [...(imported?.result.diagnostics ?? []), ...workbench.lintContinuous(currentPlan)];
          await progress.report(1, 5, 'Rendering before and proposed continuous focus plans');
          const currentRender =
            currentPlan === undefined
              ? undefined
              : await renderContinuousFocusPalette(currentPlan, currentDiagnostics, {
                  presentation,
                  signal: progress.signal,
                  budget: renderBudget,
                });
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
            renderProfile: { sourceRevision: snapshot.revision, proposedPlanHash },
            budget: renderBudget,
            signal: progress.signal,
          });
          const beforePng =
            currentRender?.png ??
            (await createTransparentPng(
              proposed.bundle.width,
              proposed.bundle.height,
              'new continuous focus baseline',
              renderBudget,
            ));
          const comparison = await comparePngImages(
            beforePng,
            proposed.bundle.png,
            8,
            progress.signal,
            renderBudget,
          );
          const stem = plan.id.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'continuous';
          const provenance = {
            toolVersion: PACKAGE_VERSION,
            schemaVersion: 'continuous-focus-visual-diff.v1',
            sourceHashes: {
              before: sourceFile?.sha256 ?? sha256Bytes(Buffer.alloc(0)),
              proposedPlan: proposedPlanHash,
            },
            renderProfile: { offline: true, kind: 'continuous-focus-palette' },
          };
          const comparisonArtifacts = await engine.artifacts.withAtomicWrites(
            workspace,
            [
              {
                name: `${stem}.continuous-focus-before.png`,
                mimeType: 'image/png',
                content: beforePng,
                provenance: { ...provenance, kind: 'continuous-focus-before-render' },
              },
              {
                name: `${stem}.continuous-focus-visual-diff.png`,
                mimeType: 'image/png',
                content: comparison.png,
                provenance: { ...provenance, kind: 'continuous-focus-visual-diff' },
              },
              {
                name: `${stem}.continuous-focus-visual-diff.json`,
                mimeType: 'application/json',
                content: comparison.json,
                provenance: { ...provenance, kind: 'continuous-focus-visual-diff-json' },
              },
            ],
            (stored) => Promise.resolve([...stored]),
            progress.signal,
          );
          const reviewArtifacts = [
            ...proposed.artifacts.map(publicArtifactLink),
            ...comparisonArtifacts.map(publicArtifactLink),
          ];
          await progress.report(3, 5, 'Creating hash-bound continuous focus transaction');
          const planned = await workbench.planContinuousChanges({
            workspaceId,
            relativePath,
            plan,
            createIfMissing,
            ...(authority === undefined ? {} : { authority }),
            ...(context.principal === undefined ? {} : { principal: context.principal }),
            artifacts: reviewArtifacts,
            readDependencies: readDependenciesFromScannedFiles(snapshot.files),
            signal: progress.signal,
          });
          const transaction = planned.transaction;
          const result = emptyServiceResult(workspaceId, {
            mode: 'continuous' as const,
            paletteId: plan.id,
            drift: compactDrift(planned.drift),
            created: planned.drift.status === 'target_missing',
            expiresAt: transaction.expiresAt,
            transactionFileCount: transaction.files.length,
            transactionArtifactCount: transaction.artifacts.length,
          });
          result.status = transaction.validation.passed ? 'ok' : 'blocked';
          result.code = transaction.validation.passed
            ? 'CONTINUOUS_FOCUS_CHANGES_PLANNED'
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
          await progress.report(5, 5, 'Continuous focus dry run complete');
          return toolResult(result);
        }
        const plan = input.plan as FocusTreePlan;
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
        if (currentPlan !== undefined && imported !== undefined)
          assertFocusPlanAuthority(detectFocusDrift(plan, imported.document, catalog), authority);
        const renderBudget = new RenderBudget();
        const reviewRenderOptions = {
          ...(horizontalSpacing === undefined ? {} : { horizontalSpacing }),
          ...(verticalSpacing === undefined ? {} : { verticalSpacing }),
          ...(padding === undefined ? {} : { padding }),
          ...(reviewScale === undefined ? {} : { outputScale: reviewScale }),
        };
        const reviewRenderProfile = {
          ...(horizontalSpacing === undefined ? {} : { horizontalSpacing }),
          ...(verticalSpacing === undefined ? {} : { verticalSpacing }),
          ...(padding === undefined ? {} : { padding }),
          ...(reviewScale === undefined ? {} : { reviewScale }),
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
          budget: renderBudget,
          signal: progress.signal,
        });
        const currentLayout =
          currentPlan === undefined
            ? undefined
            : await workbench.layoutAsync(currentPlan, { signal: progress.signal });
        const currentDiagnostics =
          currentPlan === undefined || currentLayout === undefined
            ? []
            : workbench.lint(currentPlan, {
                index: snapshot.index,
                references: catalog,
                layout: currentLayout,
              });
        await progress.report(1, 5, 'Rendering before and proposed focus plans');
        const currentRender =
          currentPlan === undefined || currentLayout === undefined
            ? undefined
            : await renderFocusTree(currentPlan, currentLayout, currentDiagnostics, {
                presentation,
                ...reviewRenderOptions,
                signal: progress.signal,
                budget: renderBudget,
              });
        const proposedPlanHash = focusPlanHash(plan);
        const reviewPlan: FocusTreePlan = {
          ...plan,
          provenance: {
            sourcePath: `plan:${plan.id}`,
            sourceHash: proposedPlanHash,
            importedPlanHash: proposedPlanHash,
          },
        };
        const proposed = await workbench.renderAndStore(workspaceId, reviewPlan, {
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          index: snapshot.index,
          references: catalog,
          presentation,
          sourceHashes: presentation.sourceHashes,
          ...reviewRenderOptions,
          renderProfile: {
            sourceRevision: snapshot.revision,
            proposedPlanHash,
            reviewRenderProfile,
          },
          budget: renderBudget,
          signal: progress.signal,
        });
        const beforePng =
          currentRender?.png ??
          (await createTransparentPng(
            proposed.bundle.width,
            proposed.bundle.height,
            'new national focus baseline',
            renderBudget,
          ));
        const comparison = await comparePngImages(
          beforePng,
          proposed.bundle.png,
          8,
          progress.signal,
          renderBudget,
        );
        const stem = plan.id.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'focus-tree';
        const provenance = {
          toolVersion: PACKAGE_VERSION,
          schemaVersion: 'focus-visual-diff.v1',
          sourceHashes: {
            before: focusFile?.sha256 ?? sha256Bytes(Buffer.alloc(0)),
            proposedPlan: proposedPlanHash,
          },
          renderProfile: {
            offline: true,
            layoutHash: proposed.layout.layoutHash,
            reviewRenderProfile,
          },
        };
        const comparisonArtifacts = await engine.artifacts.withAtomicWrites(
          workspace,
          [
            {
              name: `${stem}.focus-before.png`,
              mimeType: 'image/png',
              content: beforePng,
              provenance: { ...provenance, kind: 'focus-before-render' },
            },
            {
              name: `${stem}.focus-visual-diff.png`,
              mimeType: 'image/png',
              content: comparison.png,
              provenance: { ...provenance, kind: 'focus-visual-diff' },
            },
            {
              name: `${stem}.focus-visual-diff.json`,
              mimeType: 'application/json',
              content: comparison.json,
              provenance: { ...provenance, kind: 'focus-visual-diff-json' },
            },
          ],
          (stored) => Promise.resolve([...stored]),
          progress.signal,
        );
        const reviewArtifacts = [
          ...proposed.artifacts.map(publicArtifactLink),
          ...comparisonArtifacts.map(publicArtifactLink),
        ];
        await progress.report(3, 5, 'Creating hash-bound focus transaction');
        const planned = await workbench.planChanges({
          workspaceId,
          relativePath,
          plan,
          createIfMissing,
          ...(authority === undefined ? {} : { authority }),
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          index: snapshot.index,
          references: catalog,
          artifacts: reviewArtifacts,
          readDependencies: readDependenciesFromScannedFiles(snapshot.files),
          signal: progress.signal,
        });
        const transaction = planned.transaction;
        const result = emptyServiceResult(workspaceId, {
          mode: 'national' as const,
          treeId: plan.id,
          drift: compactDrift(planned.drift),
          created: planned.drift.status === 'target_missing',
          layoutHash: planned.layout.layoutHash,
          expiresAt: transaction.expiresAt,
          transactionFileCount: transaction.files.length,
          transactionArtifactCount: transaction.artifacts.length,
        });
        result.status = transaction.validation.passed ? 'ok' : 'blocked';
        result.code = transaction.validation.passed
          ? 'FOCUS_CHANGES_PLANNED'
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
        await progress.report(5, 5, 'Focus dry run complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}
