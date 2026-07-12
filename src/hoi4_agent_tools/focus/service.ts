import { readFile } from 'node:fs/promises';
import {
  ArtifactStore,
  publicArtifactLink,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import type { ArtifactLink } from '../core/result.js';
import { canonicalJson, deterministicId, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { SymbolIndex } from '../core/index.js';
import { ServiceError } from '../core/result.js';
import { parseClausewitz, type SourceDocument } from '../core/source/index.js';
import { TRANSACTION_MAX_DIAGNOSTICS } from '../core/transaction-limits.js';
import type {
  TransactionManager,
  TransactionManifest,
  TransactionReadDependency,
  TransactionValidation,
} from '../core/transactions.js';
import type { WorkspaceResolver } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  assertFocusPlanAuthority,
  detectContinuousFocusDrift,
  detectFocusDrift,
  type ContinuousFocusDriftResult,
  type FocusDriftResult,
} from './drift.js';
import { importContinuousFocusPalettes, importFocusTrees } from './importer.js';
import { layoutFocusTree, layoutFocusTreeAsync } from './layout.js';
import { lintContinuousFocusPalette, lintFocusTree, type FocusLintOptions } from './lint.js';
import {
  focusPlanHash,
  type ContinuousFocusPalettePlan,
  type FocusImportResult,
  type FocusLayoutOptions,
  type FocusLayoutResult,
  type FocusPlanningSidecar,
  type FocusReferenceCatalog,
  type FocusTreePlan,
} from './model.js';
import {
  createFocusPlanningSidecar,
  continuousFocusSourceMapForDocument,
  enrichFocusPlanFromSidecar,
  focusPlanningSidecarPath,
  focusSourceMapForDocument,
  parseFocusPlanningSidecar,
  serializeFocusPlanningSidecar,
} from './planning.js';
import {
  renderContinuousFocusPalette,
  storeContinuousFocusRenderArtifacts,
  type ContinuousFocusRenderBundle,
  type ContinuousFocusRenderOptions,
} from './continuous-render.js';
import {
  renderFocusTree,
  storeFocusRenderArtifacts,
  type FocusRenderBundle,
  type FocusRenderOptions,
} from './render.js';
import { updateContinuousFocusPaletteSource, updateFocusTreeSource } from './source-update.js';

export interface FocusImportedFile {
  document: SourceDocument;
  result: FocusImportResult;
}

export interface FocusPlanChangesInput {
  workspaceId: string;
  relativePath: string;
  plan: FocusTreePlan;
  authority?: 'plan' | 'source';
  createIfMissing?: boolean;
  principal?: string;
  layout?: FocusLayoutResult;
  index?: SymbolIndex;
  references?: FocusReferenceCatalog;
  artifacts?: ArtifactLink[];
  readDependencies?: TransactionReadDependency[];
  signal?: AbortSignal;
}

export interface FocusPlanChangesResult {
  transaction: TransactionManifest;
  drift: FocusDriftResult;
  layout: FocusLayoutResult;
}

export interface FocusStoredRender {
  bundle: FocusRenderBundle;
  layout: FocusLayoutResult;
  diagnostics: ReturnType<typeof lintFocusTree>;
  artifacts: StoredArtifact[];
}

export interface ContinuousFocusStoredRender {
  bundle: ContinuousFocusRenderBundle;
  diagnostics: ReturnType<typeof lintContinuousFocusPalette>;
  artifacts: StoredArtifact[];
}

export interface ContinuousFocusPlanChangesInput {
  workspaceId: string;
  relativePath: string;
  plan: ContinuousFocusPalettePlan;
  authority?: 'plan' | 'source';
  createIfMissing?: boolean;
  principal?: string;
  artifacts?: ArtifactLink[];
  readDependencies?: TransactionReadDependency[];
  signal?: AbortSignal;
}

export interface ContinuousFocusPlanChangesResult {
  transaction: TransactionManifest;
  drift: ContinuousFocusDriftResult;
}

function hardDiagnostic(diagnostic: { severity: string }): boolean {
  return diagnostic.severity === 'error' || diagnostic.severity === 'blocker';
}

const FOCUS_TRANSACTION_PLAN_DIAGNOSTIC_BUDGET = Math.floor(TRANSACTION_MAX_DIAGNOSTICS / 2);

function boundedFocusTransactionDiagnostics(
  diagnostics: readonly Diagnostic[],
  evidenceArtifactName: string,
): Diagnostic[] {
  if (diagnostics.length <= FOCUS_TRANSACTION_PLAN_DIAGNOSTIC_BUDGET) return [...diagnostics];
  const retainedLimit = FOCUS_TRANSACTION_PLAN_DIAGNOSTIC_BUDGET - 1;
  const hard = diagnostics.filter(hardDiagnostic);
  const retainedHard = hard.slice(0, retainedLimit);
  const retainedHardSet = new Set(retainedHard);
  const retainedSoft = diagnostics
    .filter((diagnostic) => !hardDiagnostic(diagnostic) && !retainedHardSet.has(diagnostic))
    .slice(0, retainedLimit - retainedHard.length);
  const omittedHard = hard.length - retainedHard.length;
  return [
    ...retainedHard,
    ...retainedSoft,
    {
      code: 'FOCUS_VALIDATION_DIAGNOSTICS_IN_RESOURCE',
      severity: omittedHard > 0 ? 'blocker' : 'warning',
      category: 'transaction',
      message: `Complete proposed-focus validation contains ${diagnostics.length} diagnostics and is stored in ${evidenceArtifactName}`,
      details: {
        total: diagnostics.length,
        returned: FOCUS_TRANSACTION_PLAN_DIAGNOSTIC_BUDGET,
        omitted: diagnostics.length - retainedLimit,
        omittedHard,
        evidenceArtifactName,
      },
    },
  ];
}

function normalizedSourcePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
}

function underSourceRoots(relativePath: string, roots: readonly string[]): boolean {
  const candidate = normalizedSourcePath(relativePath);
  return roots.some((root) => {
    const normalized = normalizedSourcePath(root);
    return candidate.startsWith(`${normalized}/`);
  });
}

function missingTargetDrift(plan: FocusTreePlan, document: SourceDocument): FocusDriftResult;
function missingTargetDrift(
  plan: ContinuousFocusPalettePlan,
  document: SourceDocument,
): ContinuousFocusDriftResult;
function missingTargetDrift(
  plan: FocusTreePlan | ContinuousFocusPalettePlan,
  document: SourceDocument,
): FocusDriftResult {
  const savedPlanHash = focusPlanHash(plan);
  const currentSourceHash = sha256Bytes(document.bytes);
  return {
    status: 'target_missing',
    sourceChanged: currentSourceHash !== plan.provenance.sourceHash,
    planChanged: savedPlanHash !== plan.provenance.importedPlanHash,
    requiresAuthority: false,
    savedPlanHash,
    currentPlanHash: '',
    importedPlanHash: plan.provenance.importedPlanHash,
    savedSourceHash: plan.provenance.sourceHash,
    currentSourceHash,
  };
}

function missingSourceError(error: unknown): boolean {
  return (
    (error instanceof ServiceError && error.code === 'PATH_NOT_FOUND_IN_ROOTS') ||
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function loadModSource(
  resolver: WorkspaceResolver,
  workspaceId: string,
  relativePath: string,
  createIfMissing: boolean,
  principal?: string,
): Promise<{ before: Buffer; document: SourceDocument; sourceCreated: boolean }> {
  try {
    const resolved = await resolver.resolvePath(
      workspaceId,
      relativePath,
      'read',
      ['mod'],
      principal,
    );
    const before = await readFile(resolved.path);
    return {
      before,
      document: parseClausewitz(before, `mod:${relativePath}`),
      sourceCreated: false,
    };
  } catch (error) {
    if (!createIfMissing || !missingSourceError(error)) throw error;
    await resolver.resolvePath(workspaceId, relativePath, 'write', ['mod'], principal);
    const before = Buffer.alloc(0);
    return {
      before,
      document: parseClausewitz(before, `mod:${relativePath}`),
      sourceCreated: true,
    };
  }
}

export class FocusWorkbench {
  public constructor(
    private readonly resolver: WorkspaceResolver,
    private readonly transactions: TransactionManager,
    private readonly artifactStore = new ArtifactStore(),
  ) {}

  async importPath(
    workspaceId: string,
    relativePath: string,
    principal?: string,
    sidecar?: FocusPlanningSidecar,
    references?: FocusReferenceCatalog,
  ): Promise<FocusImportedFile> {
    const resolved = await this.resolver.resolvePath(
      workspaceId,
      relativePath,
      'read',
      ['mod', 'dependency', 'game', 'fixture'],
      principal,
    );
    const document = parseClausewitz(
      await readFile(resolved.path),
      `${resolved.root.kind}:${relativePath}`,
    );
    const result = importFocusTrees(document, references === undefined ? {} : { references });
    if (sidecar !== undefined) {
      result.plans = result.plans.map((plan) => {
        const enriched = enrichFocusPlanFromSidecar(plan, sidecar);
        result.diagnostics.push(...enriched.diagnostics);
        return enriched.plan;
      });
    }
    return { document, result };
  }

  async importContinuousPath(
    workspaceId: string,
    relativePath: string,
    principal?: string,
  ): Promise<FocusImportedFile> {
    const resolved = await this.resolver.resolvePath(
      workspaceId,
      relativePath,
      'read',
      ['mod', 'dependency', 'game', 'fixture'],
      principal,
    );
    const document = parseClausewitz(
      await readFile(resolved.path),
      `${resolved.root.kind}:${relativePath}`,
    );
    return { document, result: importContinuousFocusPalettes(document) };
  }

  layout(plan: FocusTreePlan, options: FocusLayoutOptions = {}): FocusLayoutResult {
    return layoutFocusTree(plan, options);
  }

  layoutAsync(plan: FocusTreePlan, options: FocusLayoutOptions = {}): Promise<FocusLayoutResult> {
    return layoutFocusTreeAsync(plan, options);
  }

  lint(plan: FocusTreePlan, options: FocusLintOptions = {}): ReturnType<typeof lintFocusTree> {
    return lintFocusTree(plan, options);
  }

  lintContinuous(plan: ContinuousFocusPalettePlan): ReturnType<typeof lintContinuousFocusPalette> {
    return lintContinuousFocusPalette(plan);
  }

  async renderAndStore(
    workspaceId: string,
    plan: FocusTreePlan,
    options: FocusRenderOptions &
      FocusLintOptions & { principal?: string; layout?: FocusLayoutResult } = {},
  ): Promise<FocusStoredRender> {
    options.signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, options.principal);
    const layout =
      options.layout ??
      (await layoutFocusTreeAsync(
        plan,
        options.signal === undefined ? {} : { signal: options.signal },
      ));
    options.signal?.throwIfAborted();
    const diagnostics = [
      ...lintFocusTree(plan, {
        ...(options.index === undefined ? {} : { index: options.index }),
        layout,
        ...(options.references === undefined ? {} : { references: options.references }),
        ...(options.localisationLanguage === undefined
          ? {}
          : { localisationLanguage: options.localisationLanguage }),
        ...(options.genericRewardThreshold === undefined
          ? {}
          : { genericRewardThreshold: options.genericRewardThreshold }),
      }),
      ...(options.presentation?.diagnostics ?? []),
    ].filter(
      (diagnostic, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.code === diagnostic.code &&
            candidate.message === diagnostic.message &&
            candidate.location?.start.offset === diagnostic.location?.start.offset,
        ) === index,
    );
    const bundle = await renderFocusTree(plan, layout, diagnostics, options);
    options.signal?.throwIfAborted();
    const artifacts = await storeFocusRenderArtifacts(
      workspace,
      this.artifactStore,
      plan,
      bundle,
      options,
    );
    options.signal?.throwIfAborted();
    return { bundle, layout, diagnostics, artifacts };
  }

  async renderContinuousAndStore(
    workspaceId: string,
    plan: ContinuousFocusPalettePlan,
    options: ContinuousFocusRenderOptions & { principal?: string } = {},
  ): Promise<ContinuousFocusStoredRender> {
    options.signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, options.principal);
    const diagnostics = [
      ...lintContinuousFocusPalette(plan),
      ...(options.presentation?.diagnostics ?? []),
    ];
    const bundle = await renderContinuousFocusPalette(plan, diagnostics, options);
    const artifacts = await storeContinuousFocusRenderArtifacts(
      workspace,
      this.artifactStore,
      plan,
      bundle,
      options,
    );
    return { bundle, diagnostics, artifacts };
  }

  async planChanges(input: FocusPlanChangesInput): Promise<FocusPlanChangesResult> {
    input.signal?.throwIfAborted();
    const workspace = this.resolver.get(input.workspaceId, input.principal);
    if (
      !input.relativePath.toLowerCase().endsWith('.txt') ||
      !underSourceRoots(input.relativePath, workspace.registration.roots.focus)
    ) {
      throw new ServiceError(
        'FOCUS_SOURCE_PATH_INVALID',
        'National focus source must be a .txt file beneath a configured focus root',
        { relativePath: input.relativePath },
      );
    }
    const { before, document, sourceCreated } = await loadModSource(
      this.resolver,
      input.workspaceId,
      input.relativePath,
      input.createIfMissing === true,
      input.principal,
    );
    const exactCurrentPlan = importFocusTrees(
      document,
      input.references === undefined ? {} : { references: input.references },
    ).plans.find(({ id }) => id === input.plan.id);
    if (input.createIfMissing === true && !sourceCreated && exactCurrentPlan === undefined)
      throw new ServiceError(
        'FOCUS_CREATE_REQUIRES_NEW_SOURCE',
        'Creating a national focus tree requires a new mod source file so an existing source and its planning sidecar cannot be repurposed',
        { relativePath: input.relativePath, treeId: input.plan.id },
      );
    const targetCreated = sourceCreated && exactCurrentPlan === undefined;
    const drift = targetCreated
      ? missingTargetDrift(input.plan, document)
      : detectFocusDrift(input.plan, document, input.references);
    if (!targetCreated) assertFocusPlanAuthority(drift, input.authority);
    const layout =
      input.layout ??
      (await layoutFocusTreeAsync(
        input.plan,
        input.signal === undefined ? {} : { signal: input.signal },
      ));
    const after = updateFocusTreeSource(
      document,
      targetCreated ? undefined : drift.currentSourcePlan,
      input.plan,
      layout,
    );
    const afterHash = sha256Bytes(after);
    const sidecarPath = focusPlanningSidecarPath(input.relativePath);
    const sidecarPlan: FocusTreePlan = {
      ...input.plan,
      provenance: {
        ...input.plan.provenance,
        sourcePath: `mod:${input.relativePath}`,
        sourceHash: afterHash,
      },
    };
    const sidecar = createFocusPlanningSidecar(sidecarPlan, afterHash);
    const sidecarContent = Buffer.from(serializeFocusPlanningSidecar(sidecar), 'utf8');
    const existingSidecar = await this.resolver
      .resolvePath(input.workspaceId, sidecarPath, 'read', ['mod'], input.principal)
      .then(({ path }) => readFile(path))
      .catch((error: unknown) => {
        if (error instanceof ServiceError && error.code === 'PATH_NOT_FOUND_IN_ROOTS')
          return undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
    if (before.equals(after) && existingSidecar?.equals(sidecarContent) === true) {
      throw new ServiceError(
        'FOCUS_NO_CHANGES',
        `Focus tree ${input.plan.id} compiles to the current source`,
      );
    }
    const operationId = deterministicId('focus_change', {
      treeId: input.plan.id,
      relativePath: input.relativePath,
      layoutHash: layout.layoutHash,
      afterHash,
      sidecarHash: sha256Bytes(sidecarContent),
    });
    const proposedDocument = parseClausewitz(after, `mod:${input.relativePath}`);
    const sourceMap = focusSourceMapForDocument(proposedDocument, sidecarPlan);
    if (sourceMap.mappings.length !== input.plan.focuses.length) {
      throw new ServiceError(
        'FOCUS_SOURCE_MAP_INCOMPLETE',
        `Generated source map covers ${sourceMap.mappings.length} of ${input.plan.focuses.length} focuses`,
      );
    }
    const lintOptions: FocusLintOptions = {
      layout,
      ...(input.index === undefined ? {} : { index: input.index }),
      ...(input.references === undefined ? {} : { references: input.references }),
    };
    const validateProposedFocus = async (
      bytes: Buffer | null,
      proposedSidecarBytes: Buffer | null | undefined,
      signal?: AbortSignal,
    ): Promise<TransactionValidation> => {
      signal?.throwIfAborted();
      if (bytes === null) {
        return {
          diagnostics: [
            {
              code: 'FOCUS_PROPOSED_SOURCE_MISSING',
              severity: 'blocker',
              category: 'transaction',
              message: `Proposed source is missing ${input.relativePath}`,
              operationId,
            },
          ],
          checks: [
            { id: 'focus-source-present', passed: false, message: 'Proposed source is present' },
          ],
        };
      }
      const validationDocument = parseClausewitz(bytes, `mod:${input.relativePath}`);
      const imported = importFocusTrees(
        validationDocument,
        input.references === undefined ? {} : { references: input.references },
      );
      let proposedPlan = imported.plans.find(({ id }) => id === input.plan.id);
      const diagnostics = [...imported.diagnostics];
      if (
        proposedPlan !== undefined &&
        proposedSidecarBytes !== undefined &&
        proposedSidecarBytes !== null
      ) {
        const parsedSidecar = parseFocusPlanningSidecar(proposedSidecarBytes);
        const enriched = enrichFocusPlanFromSidecar(proposedPlan, parsedSidecar);
        diagnostics.push(...enriched.diagnostics);
        proposedPlan = enriched.plan;
      }
      if (proposedPlan !== undefined) {
        const proposedLayout = await layoutFocusTreeAsync(
          proposedPlan,
          signal === undefined ? {} : { signal },
        );
        diagnostics.push(
          ...lintFocusTree(proposedPlan, {
            ...lintOptions,
            layout: proposedLayout,
          }),
        );
      } else {
        diagnostics.push({
          code: 'FOCUS_PROPOSED_TREE_MISSING',
          severity: 'blocker',
          category: 'transaction',
          message: `Compiled source does not contain focus tree ${input.plan.id}`,
          operationId,
        });
      }
      const syntaxPassed = !validationDocument.diagnostics.some(hardDiagnostic);
      const lintPassed = !diagnostics.some(hardDiagnostic);
      return {
        diagnostics,
        checks: [
          {
            id: 'focus-source-syntax',
            passed: syntaxPassed,
            message: 'Compiled focus source parses safely',
          },
          {
            id: 'focus-tree-present',
            passed: proposedPlan !== undefined,
            message: 'Compiled source contains the requested focus tree',
          },
          {
            id: 'focus-lint',
            passed: lintPassed,
            message: 'Compiled focus tree has no blocking lint findings',
          },
          {
            id: 'focus-source-map-complete',
            passed: sourceMap.mappings.length === input.plan.focuses.length,
            message: 'Every proposed focus block maps to its planning node',
          },
          {
            id: 'focus-planning-sidecar-present',
            passed: proposedSidecarBytes !== undefined && proposedSidecarBytes !== null,
            message: 'Non-Clausewitz planning metadata is persisted beside the source',
          },
        ],
      };
    };
    const completeValidation = await validateProposedFocus(after, sidecarContent, input.signal);
    const stem = input.plan.id.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'focus-tree';
    const validationArtifactName = `${stem}.focus.proposed-validation.json`;
    const artifactProvenance = {
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'focus-plan.v1',
      sourceHashes: { proposed: afterHash, sidecar: sha256Bytes(sidecarContent) },
    };
    const proposedArtifactWrites: ArtifactWrite[] = [
      {
        name: `${stem}.focus.proposed-source-map.json`,
        mimeType: 'application/json',
        content: `${canonicalJson(sourceMap)}\n`,
        provenance: { ...artifactProvenance, kind: 'focus-proposed-source-map' },
        description: 'Proposed focus ranges mapped to planning nodes and imported source locations',
      },
      {
        name: `${stem}.focus.proposed-plan.json`,
        mimeType: 'application/json',
        content: sidecarContent,
        provenance: { ...artifactProvenance, kind: 'focus-proposed-planning-sidecar' },
        description:
          'Source-hash-bound non-Clausewitz planning metadata proposed with the source edit',
      },
      {
        name: validationArtifactName,
        mimeType: 'application/json',
        content: `${canonicalJson({
          schemaVersion: 1,
          treeId: input.plan.id,
          relativePath: input.relativePath,
          sourceHashes: { proposed: afterHash, sidecar: sha256Bytes(sidecarContent) },
          layoutHash: layout.layoutHash,
          passed:
            !completeValidation.diagnostics.some(hardDiagnostic) &&
            completeValidation.checks.every(({ passed }) => passed),
          diagnosticCount: completeValidation.diagnostics.length,
          checks: completeValidation.checks,
          diagnostics: completeValidation.diagnostics,
        })}\n`,
        provenance: { ...artifactProvenance, kind: 'focus-proposed-validation' },
        description:
          'Complete source-linked validation diagnostics for the compiled focus transaction',
      },
    ];
    const proposedArtifacts = await this.artifactStore.withAtomicWrites(
      workspace,
      proposedArtifactWrites,
      (stored) => Promise.resolve([...stored]),
      input.signal,
    );
    const transaction = await this.transactions.plan({
      workspaceId: input.workspaceId,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      operationKind: 'focus-plan-changes',
      operations: [
        {
          id: operationId,
          kind: targetCreated ? 'create-focus-tree' : 'replace-focus-tree',
          summary: `${targetCreated ? 'Create' : 'Regenerate'} focus tree ${input.plan.id}`,
          data: {
            treeId: input.plan.id,
            relativePath: input.relativePath,
            driftStatus: drift.status,
            layoutHash: layout.layoutHash,
            planningSidecar: sidecarPath,
            sourceMapMappings: sourceMap.mappings.length,
            sourceCreated,
            targetCreated,
          },
        },
      ],
      changes: [
        {
          relativePath: input.relativePath,
          content: after,
          operationIds: [operationId],
          mediaType: 'text/plain',
        },
        {
          relativePath: sidecarPath,
          content: sidecarContent,
          operationIds: [operationId],
          mediaType: 'application/json',
        },
      ],
      ...(input.readDependencies === undefined ? {} : { readDependencies: input.readDependencies }),
      artifacts: [...(input.artifacts ?? []), ...proposedArtifacts.map(publicArtifactLink)],
      validate: async (proposed, signal) => {
        signal?.throwIfAborted();
        const proposedSource = proposed.get(input.relativePath);
        const bytes = proposedSource === undefined ? after : proposedSource;
        const proposedSidecarBytes = proposed.get(sidecarPath);
        const validation = await validateProposedFocus(bytes, proposedSidecarBytes, signal);
        return {
          ...validation,
          diagnostics: boundedFocusTransactionDiagnostics(
            validation.diagnostics,
            validationArtifactName,
          ),
        };
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { transaction, drift, layout };
  }

  async planContinuousChanges(
    input: ContinuousFocusPlanChangesInput,
  ): Promise<ContinuousFocusPlanChangesResult> {
    input.signal?.throwIfAborted();
    if (
      !input.relativePath.toLowerCase().endsWith('.txt') ||
      !underSourceRoots(input.relativePath, ['common/continuous_focus'])
    ) {
      throw new ServiceError(
        'CONTINUOUS_FOCUS_SOURCE_PATH_INVALID',
        'Continuous focus source must be a .txt file beneath common/continuous_focus',
        { relativePath: input.relativePath },
      );
    }
    const { before, document, sourceCreated } = await loadModSource(
      this.resolver,
      input.workspaceId,
      input.relativePath,
      input.createIfMissing === true,
      input.principal,
    );
    const exactCurrentPlan = importContinuousFocusPalettes(document).continuousFocusPalettes.find(
      ({ id }) => id === input.plan.id,
    );
    if (input.createIfMissing === true && !sourceCreated && exactCurrentPlan === undefined)
      throw new ServiceError(
        'CONTINUOUS_FOCUS_CREATE_REQUIRES_NEW_SOURCE',
        'Creating a continuous-focus palette requires a new mod source file so unrelated existing source is never repurposed',
        { relativePath: input.relativePath, paletteId: input.plan.id },
      );
    const targetCreated = sourceCreated && exactCurrentPlan === undefined;
    const drift = targetCreated
      ? missingTargetDrift(input.plan, document)
      : detectContinuousFocusDrift(input.plan, document);
    if (!targetCreated) assertFocusPlanAuthority(drift, input.authority);
    const after = updateContinuousFocusPaletteSource(
      document,
      targetCreated ? undefined : drift.currentSourcePlan,
      input.plan,
    );
    if (before.equals(after))
      throw new ServiceError(
        'FOCUS_NO_CHANGES',
        `Continuous focus palette ${input.plan.id} compiles to the current source`,
      );
    const afterHash = sha256Bytes(after);
    const operationId = deterministicId('continuous_focus_change', {
      paletteId: input.plan.id,
      relativePath: input.relativePath,
      afterHash,
    });
    const proposedDocument = parseClausewitz(after, `mod:${input.relativePath}`);
    const sourceMap = continuousFocusSourceMapForDocument(proposedDocument, input.plan);
    if (sourceMap.mappings.length !== input.plan.focuses.length)
      throw new ServiceError(
        'FOCUS_SOURCE_MAP_INCOMPLETE',
        `Generated source map covers ${sourceMap.mappings.length} of ${input.plan.focuses.length} continuous focuses`,
      );
    const workspace = this.resolver.get(input.workspaceId, input.principal);
    const stem = input.plan.id.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'continuous';
    const sourceMapArtifact = await this.artifactStore.put(
      workspace,
      `${stem}.continuous.proposed-source-map.json`,
      'application/json',
      `${canonicalJson(sourceMap)}\n`,
      {
        kind: 'continuous-focus-proposed-source-map',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'continuous-focus-plan.v1',
        sourceHashes: { proposed: afterHash },
      },
      'Proposed continuous focus ranges mapped to plan nodes and imported source locations',
      input.signal,
    );
    const transaction = await this.transactions.plan({
      workspaceId: input.workspaceId,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      operationKind: 'continuous-focus-plan-changes',
      operations: [
        {
          id: operationId,
          kind: targetCreated
            ? 'create-continuous-focus-palette'
            : 'replace-continuous-focus-palette',
          summary: `${targetCreated ? 'Create' : 'Update'} continuous focus palette ${input.plan.id}`,
          data: {
            paletteId: input.plan.id,
            relativePath: input.relativePath,
            driftStatus: drift.status,
            sourceMapMappings: sourceMap.mappings.length,
            sourceCreated,
            targetCreated,
          },
        },
      ],
      changes: [
        {
          relativePath: input.relativePath,
          content: after,
          operationIds: [operationId],
          mediaType: 'text/plain',
        },
      ],
      ...(input.readDependencies === undefined ? {} : { readDependencies: input.readDependencies }),
      artifacts: [...(input.artifacts ?? []), publicArtifactLink(sourceMapArtifact)],
      validate: (proposed) => {
        input.signal?.throwIfAborted();
        const proposedSource = proposed.get(input.relativePath);
        const bytes = proposedSource === undefined ? after : proposedSource;
        if (bytes === null)
          return Promise.resolve({
            diagnostics: [
              {
                code: 'FOCUS_PROPOSED_SOURCE_MISSING',
                severity: 'blocker' as const,
                category: 'transaction' as const,
                message: `Proposed source is missing ${input.relativePath}`,
                operationId,
              },
            ],
            checks: [
              { id: 'continuous-source-present', passed: false, message: 'Source is present' },
            ],
          });
        const parsed = parseClausewitz(bytes, `mod:${input.relativePath}`);
        const imported = importContinuousFocusPalettes(parsed);
        const proposedPlan = imported.continuousFocusPalettes.find(
          ({ id }) => id === input.plan.id,
        );
        const diagnostics = [
          ...imported.diagnostics,
          ...(proposedPlan === undefined ? [] : lintContinuousFocusPalette(proposedPlan)),
        ].map((diagnostic) =>
          hardDiagnostic(diagnostic) && diagnostic.operationId === undefined
            ? { ...diagnostic, operationId }
            : diagnostic,
        );
        if (proposedPlan === undefined)
          diagnostics.push({
            code: 'CONTINUOUS_FOCUS_PROPOSED_PALETTE_MISSING',
            severity: 'blocker',
            category: 'transaction',
            message: `Compiled source does not contain continuous focus palette ${input.plan.id}`,
            operationId,
          });
        const passed = proposedPlan !== undefined && !diagnostics.some(hardDiagnostic);
        return Promise.resolve({
          diagnostics,
          checks: [
            {
              id: 'continuous-focus-syntax',
              passed: !parsed.diagnostics.some(hardDiagnostic),
              message: 'Compiled continuous focus source parses safely',
            },
            {
              id: 'continuous-focus-palette-present',
              passed: proposedPlan !== undefined,
              message: 'Compiled source contains the requested palette',
            },
            {
              id: 'continuous-focus-lint',
              passed,
              message: 'Compiled continuous focus palette has no blocking lint findings',
            },
            {
              id: 'continuous-focus-source-map-complete',
              passed: sourceMap.mappings.length === input.plan.focuses.length,
              message: 'Every proposed continuous focus block maps to its planning node',
            },
          ],
        });
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { transaction, drift };
  }
}
