import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ArtifactStore,
  boundedSourceHashEvidence,
  publicArtifactLink,
  type ArtifactProvenance,
  type ArtifactWrite,
} from '../core/artifacts.js';
import {
  compareCodeUnits,
  canonicalJson,
  deterministicId,
  sha256Bytes,
} from '../core/canonical.js';
import { DiagnosticCollector } from '../core/diagnostic-collector.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { sortDiagnostics } from '../core/diagnostics.js';
import { CoreEngine } from '../core/engine.js';
import { assertRenderDimensions, RenderBudget, RENDER_MAX_PIXELS } from '../core/render-budget.js';
import { ServiceError, type ArtifactLink } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { WorkspaceScanner } from '../core/scanner.js';
import {
  applyReplacements,
  decodeSource,
  encodeSource,
  parseClausewitz,
  parseLocalisation,
  SOURCE_MAX_BYTES,
  sourcePartialLimitDiagnostics,
  type SourceReplacement,
} from '../core/source/index.js';
import {
  readDependenciesFromScannedFiles,
  type TransactionManager,
  type TransactionManifest,
} from '../core/transactions.js';
import type { ResolvedWorkspace, WorkspaceResolver } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import { isSafeAnimationSourcePath } from './animation-manifest.js';
import { GuiAssetCatalog, parseBmFont } from './assets.js';
import { buildGuiScene } from './layout.js';
import { GUI_VALIDATION_MAX_DIAGNOSTICS } from './limits.js';
import {
  compareGuiImages,
  galleryDimensions,
  renderGallerySvg,
  renderGuiScene,
  type GalleryItem,
} from './renderer.js';
import { parsePreviewScenario } from './scenario.js';
import { buildGuiSourceGraph } from './source-graph.js';
import { assertGuiSourcePatchesSafe } from './source-patch.js';
import type {
  GuiArtifactSet,
  GuiComparisonResult,
  GuiPreviewScenario,
  GuiPreviewState,
  GuiRenderResult,
  GuiScene,
  GuiSourceGraph,
  GuiValidationResult,
} from './types.js';
import { validateGuiScene, validateResolutionDrift, validateStateMatrix } from './validators.js';

const staticGuiDefinitionPatterns = [
  'common/scripted_localisation/**/*.txt',
  'common/decisions/**/*.txt',
  'common/decision_categories/**/*.txt',
  'fonts/**/*.{gfx,txt}',
  'hoi4_agent/animation_sources/**/*.json',
] as const;

export const GUI_TEXT_PACKAGE_MAX_FILES = 32;
export const GUI_TEXT_PACKAGE_MAX_BYTES = 16_777_216;

type GuiTextPackageFileKind = 'gui' | 'gfx' | 'scripted-gui' | 'localisation';

export interface GuiTextPackageFileInput {
  relativePath: string;
  source: string;
}

interface PreparedGuiTextPackageFile {
  relativePath: string;
  kind: GuiTextPackageFileKind;
  bytes: Buffer;
  absolutePath: string;
  loadOrder: number;
}

function normalizeConfiguredRoot(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!isSafeAnimationSourcePath(normalized)) {
    throw new ServiceError(
      'GUI_CONFIGURED_ROOT_INVALID',
      `GUI source root must be a safe workspace-relative path: ${value}`,
    );
  }
  return normalized;
}

function portableSourcePathKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function pathIsUnder(relativePath: string, roots: readonly string[]): boolean {
  const candidate = portableSourcePathKey(relativePath);
  return roots.some((root) => {
    const normalizedRoot = portableSourcePathKey(normalizeConfiguredRoot(root));
    return candidate.startsWith(`${normalizedRoot}/`);
  });
}

function guiTextPackageFileKind(
  workspace: ResolvedWorkspace,
  relativePath: string,
  main: boolean,
): GuiTextPackageFileKind {
  if (
    !isSafeAnimationSourcePath(relativePath) ||
    relativePath.split('/').some((segment) => segment === '.')
  ) {
    throw new ServiceError(
      'GUI_TEXT_PACKAGE_PATH_INVALID',
      'GUI text-package paths must be safe workspace-relative paths using forward slashes',
      { relativePath },
    );
  }
  const lower = relativePath.toLocaleLowerCase('en-US');
  const roots = workspace.registration.roots;
  const kind =
    lower.endsWith('.gui') && pathIsUnder(relativePath, roots.interface)
      ? 'gui'
      : lower.endsWith('.gfx') && pathIsUnder(relativePath, [...roots.interface, ...roots.gfx])
        ? 'gfx'
        : lower.endsWith('.txt') && pathIsUnder(relativePath, roots.scriptedGui)
          ? 'scripted-gui'
          : lower.endsWith('.yml') && pathIsUnder(relativePath, roots.localisation)
            ? 'localisation'
            : undefined;
  if (kind === undefined || (main && kind !== 'gui')) {
    throw new ServiceError(
      'GUI_TEXT_PACKAGE_PATH_UNSUPPORTED',
      main
        ? 'The main GUI text-package file must be a .gui file under a configured interface root'
        : 'Additional GUI text-package files must be interface .gui/.gfx, configured GFX .gfx, common/scripted_guis .txt, or localisation .yml files',
      { relativePath },
    );
  }
  return kind;
}

function parseGuiTextPackageFile(
  file: Pick<PreparedGuiTextPackageFile, 'bytes' | 'kind' | 'relativePath'>,
) {
  const sourcePath = `mod:${file.relativePath}`;
  return file.kind === 'localisation'
    ? parseLocalisation(file.bytes, sourcePath)
    : parseClausewitz(file.bytes, sourcePath);
}

function overlayGuiTextPackageFiles(
  files: readonly ScannedFile[],
  prepared: readonly PreparedGuiTextPackageFile[],
): ScannedFile[] {
  const replacements = new Map(
    prepared.map((file) => [portableSourcePathKey(file.relativePath), file] as const),
  );
  const replaced = new Set<string>();
  const proposed = files.map((file) => {
    const key = portableSourcePathKey(file.relativePath);
    const replacement = replacements.get(key);
    if (replacement === undefined) return file;
    const displayPath = `mod:${replacement.relativePath}`;
    if (file.rootKind !== 'mod') return { ...file, shadowedBy: displayPath };
    replaced.add(key);
    const { shadowedBy: _shadowedBy, ...activeFile } = file;
    void _shadowedBy;
    return {
      ...activeFile,
      absolutePath: replacement.absolutePath,
      displayPath,
      relativePath: replacement.relativePath,
      bytes: replacement.bytes,
      size: replacement.bytes.length,
      modifiedMs: 0,
      sha256: sha256Bytes(replacement.bytes),
    };
  });
  for (const replacement of prepared) {
    const key = portableSourcePathKey(replacement.relativePath);
    if (replaced.has(key)) continue;
    proposed.push({
      absolutePath: replacement.absolutePath,
      displayPath: `mod:${replacement.relativePath}`,
      relativePath: replacement.relativePath,
      rootKind: 'mod',
      loadOrder: replacement.loadOrder,
      size: replacement.bytes.length,
      modifiedMs: 0,
      sha256: sha256Bytes(replacement.bytes),
      bytes: replacement.bytes,
    });
  }
  return mergeScannedFiles(proposed);
}

function under(roots: readonly string[], suffixes: readonly string[]): string[] {
  return roots.flatMap((root) => {
    const normalized = normalizeConfiguredRoot(root);
    return suffixes.map((suffix) => `${normalized}/${suffix}`);
  });
}

function guiDefinitionPatterns(workspace: ResolvedWorkspace): string[] {
  const roots = workspace.registration.roots;
  return [
    ...new Set([
      ...under(roots.interface, ['**/*.gui', '**/*.gfx']),
      ...under(roots.gfx, ['**/*.gfx']),
      ...under(roots.scriptedGui, ['**/*.txt']),
      ...staticGuiDefinitionPatterns,
    ]),
  ].sort((left, right) => compareCodeUnits(left, right));
}

function guiLocalisationPatterns(
  workspace: ResolvedWorkspace,
  languages: readonly string[] = ['l_english'],
): string[] {
  const roots = workspace.registration.roots;
  const languageDirectories = [...new Set(languages)].map((language) => {
    if (!/^l_[a-z_]+$/u.test(language)) {
      throw new ServiceError('GUI_LANGUAGE_INVALID', `Invalid GUI preview language: ${language}`);
    }
    return language.slice(2);
  });
  return [
    ...new Set([
      ...under(roots.localisation, [
        '*.{yml,yaml}',
        ...languageDirectories.flatMap((directory) => [
          `${directory}/**/*.yml`,
          `${directory}/**/*.yaml`,
        ]),
      ]),
    ]),
  ].sort((left, right) => compareCodeUnits(left, right));
}

function normalizedAssetReference(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|^\.\//u, '');
  return isSafeAnimationSourcePath(normalized) ? normalized : undefined;
}

function referenceVariants(value: string): string[] {
  const normalized = normalizedAssetReference(value);
  if (normalized === undefined) return [];
  const extension = path.posix.extname(normalized);
  const candidates =
    extension.length === 0
      ? ['.fnt', '.ttf', '.otf', '.woff', '.woff2', '.png', '.bmp', '.tga', '.dds', '.svg'].map(
          (suffix) => `${normalized}${suffix}`,
        )
      : [normalized];
  return candidates;
}

function basenameFallbackPatterns(
  exactPaths: readonly string[],
  exactFiles: readonly ScannedFile[],
): string[] {
  const resolved = new Set(
    exactFiles
      .filter(({ shadowedBy }) => shadowedBy === undefined)
      .map(({ relativePath }) => relativePath.replaceAll('\\', '/').toLowerCase()),
  );
  return [
    ...new Set(
      exactPaths
        .filter((candidate) => !resolved.has(candidate.toLowerCase()))
        .map((candidate) => `**/${path.posix.basename(candidate)}`),
    ),
  ].sort((left, right) => compareCodeUnits(left, right));
}

function selectedElements(graph: GuiSourceGraph, windowName: string): GuiSourceGraph['elements'] {
  const byId = new Map(graph.elements.map((element) => [element.id, element]));
  const pending = graph.elements.filter(({ name }) => name === windowName).map(({ id }) => id);
  const selected = new Map<string, GuiSourceGraph['elements'][number]>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || selected.has(id)) continue;
    const element = byId.get(id);
    if (element === undefined) continue;
    selected.set(id, element);
    pending.push(...element.childIds);
  }
  return [...selected.values()];
}

function assertTargetWindowAvailable(graph: GuiSourceGraph, windowName: string): void {
  if (graph.elements.some(({ name }) => name === windowName)) return;
  if (!graph.skippedPossibleSymbolKinds.includes('gui_element')) return;
  const possibleSources = graph.skippedSources.filter(({ possibleSymbolKinds }) =>
    possibleSymbolKinds.includes('gui_element'),
  );
  throw new ServiceError(
    'GUI_TARGET_SOURCE_SKIPPED_LIMIT',
    `The partial GUI inventory cannot determine whether skipped source defines window ${windowName}`,
    {
      windowName,
      skippedSourceCount: graph.skippedSourceCount,
      skippedSourceSamplesRetained: possibleSources.length,
      skippedSources: possibleSources.slice(0, 10).map(({ path, reasonCodes }) => ({
        path,
        reasonCodes,
      })),
    },
  );
}

function collectNamedAttributes(
  value: unknown,
  keys: ReadonlySet<string>,
  output: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectNamedAttributes(entry, keys, output);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key) && typeof entry === 'string') output.add(entry);
    collectNamedAttributes(entry, keys, output);
  }
}

function referencedAssetPatternsForWindow(graph: GuiSourceGraph, windowName: string): string[] {
  const spriteNames = new Set<string>();
  const fontNames = new Set<string>();
  for (const element of selectedElements(graph, windowName)) {
    collectNamedAttributes(
      element.attributes,
      new Set(['spriteType', 'quadTextureSprite']),
      spriteNames,
    );
    collectNamedAttributes(element.attributes, new Set(['font', 'buttonFont']), fontNames);
  }
  const spritesByName = new Map(graph.sprites.map((sprite) => [sprite.name, sprite]));
  const selectedSprites = new Map<string, GuiSourceGraph['sprites'][number]>();
  const pendingSprites = [...spriteNames];
  while (pendingSprites.length > 0) {
    const name = pendingSprites.pop();
    if (name === undefined || selectedSprites.has(name)) continue;
    const sprite = spritesByName.get(name);
    if (sprite === undefined) continue;
    selectedSprites.set(name, sprite);
    if (sprite.staticFallback !== undefined) pendingSprites.push(sprite.staticFallback);
  }
  const selectedManifests = graph.animationSources.filter(({ sprite }) =>
    selectedSprites.has(sprite),
  );
  const selectedFonts = graph.fonts.filter(({ name }) => fontNames.has(name));
  const references = [
    ...[...selectedSprites.values()].flatMap(({ texturePath, texturePath2 }) =>
      [texturePath, texturePath2].filter((value): value is string => value !== undefined),
    ),
    ...selectedFonts.flatMap(({ assetPaths }) => assetPaths),
    ...selectedManifests.flatMap((manifest) => [
      manifest.sheet.path,
      manifest.staticFallback.path,
      ...manifest.sourceFrames.map(({ path: framePath }) => framePath),
    ]),
  ];
  return [...new Set(references.flatMap(referenceVariants))].sort((left, right) =>
    compareCodeUnits(left, right),
  );
}

function bmFontPagePatterns(files: readonly ScannedFile[]): string[] {
  const references = files.flatMap((file) => {
    if (!file.relativePath.toLowerCase().endsWith('.fnt') || file.shadowedBy !== undefined)
      return [];
    const metrics = parseBmFont(file.bytes.toString('utf8'));
    if (metrics === undefined) return [];
    return metrics.pages.map((page) =>
      path.posix.join(path.posix.dirname(file.relativePath), page),
    );
  });
  return [...new Set(references.flatMap(referenceVariants))].sort((left, right) =>
    compareCodeUnits(left, right),
  );
}

function mergeScannedFiles(...groups: readonly ScannedFile[][]): ScannedFile[] {
  const byDisplayPath = new Map<string, ScannedFile>();
  for (const file of groups.flat()) byDisplayPath.set(file.displayPath, file);
  return [...byDisplayPath.values()].sort(
    (left, right) =>
      left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
  );
}

function withGraphDiagnostics(
  graph: GuiSourceGraph,
  validation: GuiValidationResult,
): GuiValidationResult {
  const hard = graph.diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  const diagnostics = new DiagnosticCollector(GUI_VALIDATION_MAX_DIAGNOSTICS, {
    code: 'GUI_VALIDATION_DIAGNOSTICS_TRUNCATED',
    category: 'layout',
    message: 'Combined GUI source and validation diagnostics exceeded the fixed result ceiling',
  });
  diagnostics.pushMany(graph.diagnostics);
  diagnostics.pushMany(validation.diagnostics);
  return {
    diagnostics: sortDiagnostics(diagnostics.values()),
    checks: [
      {
        id: 'gui-source-graph',
        passed: hard.length === 0,
        message:
          hard.length === 0
            ? 'GUI source graph parsed and linked without blocking diagnostics'
            : `GUI source graph has ${hard.length} blocking diagnostic${hard.length === 1 ? '' : 's'}`,
      },
      ...validation.checks,
    ],
  };
}

const galleryStates: readonly GuiPreviewState[] = [
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
];

export interface GuiStudioScanResult {
  files: ScannedFile[];
  graph: GuiSourceGraph;
}

export interface GuiStudioRenderInput {
  workspaceId: string;
  windowName: string;
  scenario: unknown;
  states?: GuiPreviewState[];
  resolutions?: { width: number; height: number; uiScale?: number }[];
  comparisonScenario?: unknown;
  principal?: string;
  signal?: AbortSignal;
}

export interface GuiStudioLintInput {
  workspaceId: string;
  windowName: string;
  scenario: unknown;
  relatedScenarios?: unknown[];
  principal?: string;
  signal?: AbortSignal;
}

export interface GuiStudioCompareInput {
  workspaceId: string;
  windowName: string;
  before: unknown;
  after: unknown;
  principal?: string;
  signal?: AbortSignal;
}

export interface GuiStudioCompareResult {
  before: GuiScene;
  after: GuiScene;
  comparison: GuiComparisonResult;
  evidenceJson: string;
  graph: GuiSourceGraph;
}

export interface PlanGuiSourceInput {
  workspaceId: string;
  relativePath: string;
  source?: string;
  additionalFiles?: GuiTextPackageFileInput[];
  expectedSourceHash?: string;
  patches?: (SourceReplacement & {
    expectedText: string;
  })[];
  windowName?: string;
  scenario?: unknown;
  principal?: string;
  signal?: AbortSignal;
}

function safeSlug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48) || 'gui'
  );
}

function scenarioWith(
  base: GuiPreviewScenario,
  patch: Partial<GuiPreviewScenario>,
): GuiPreviewScenario {
  return parsePreviewScenario({ ...base, ...patch });
}

function fullImage(render: GuiRenderResult): GuiRenderResult['images'][number] {
  const image = render.images.find(({ variant }) => variant === 'full') ?? render.images[0];
  if (image === undefined) throw new Error('GUI render did not produce an image.');
  return image;
}

export function guiArtifactProvenance(
  graph: GuiSourceGraph,
  kind: string,
  primaryScene: GuiScene,
  scenarioScenes: readonly GuiScene[] = [primaryScene],
  metadata: Record<string, unknown> = {},
): ArtifactProvenance {
  const { scenario } = primaryScene;
  const sourceEvidence = boundedSourceHashEvidence(graph.sourceHashes);
  const fidelitySummary = (report: GuiScene['fidelity']) =>
    Object.fromEntries(
      Object.entries(report).map(([category, items]) => {
        const fields = [...new Set(items.map(({ field }) => field))].sort((left, right) =>
          compareCodeUnits(left, right),
        );
        return [
          category,
          {
            count: items.length,
            fields: fields.slice(0, 256),
            fieldsTruncated: fields.length > 256,
          },
        ];
      }),
    );
  const scenarioSummary = (value: GuiScene['scenario']) => ({
    id: value.id,
    resolution: value.resolution,
    uiScale: value.uiScale,
    state: value.state,
    animationTimeSeconds: value.animationTimeSeconds,
  });
  return {
    kind,
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'gui-studio.v1',
    sourceHashes: sourceEvidence.sourceHashes,
    renderProfile: {
      offline: true,
      scenarioId: scenario.id,
      sourceRevision: primaryScene.sourceRevision,
      resolution: scenario.resolution,
      uiScale: scenario.uiScale,
      state: scenario.state,
      animationTimeSeconds: scenario.animationTimeSeconds,
      fidelity: fidelitySummary(primaryScene.fidelity),
      scenarios: scenarioScenes.map((scene) => ({
        scenario: scenarioSummary(scene.scenario),
        sourceRevision: scene.sourceRevision,
        fidelity: fidelitySummary(scene.fidelity),
      })),
    },
    metadata: {
      rendererLabel: 'OFFLINE APPROXIMATION · NOT HOI4',
      ...metadata,
      sourceHashInventory: sourceEvidence.inventory,
    },
  };
}

export class ScriptedGuiStudio {
  private readonly engine: CoreEngine;
  private readonly resolver: WorkspaceResolver;
  private readonly transactions: TransactionManager;
  private readonly scanner: WorkspaceScanner;
  private readonly artifacts: ArtifactStore;

  public constructor(engine: CoreEngine);
  public constructor(
    resolver: WorkspaceResolver,
    transactions?: TransactionManager,
    scanner?: WorkspaceScanner,
    artifacts?: ArtifactStore,
  );
  public constructor(
    engineOrResolver: CoreEngine | WorkspaceResolver,
    transactions?: TransactionManager,
    scanner = new WorkspaceScanner(),
    artifacts = new ArtifactStore(),
  ) {
    this.engine =
      engineOrResolver instanceof CoreEngine
        ? engineOrResolver
        : new CoreEngine(engineOrResolver, {
            scanner,
            artifacts,
            ...(transactions === undefined ? {} : { transactions }),
          });
    this.resolver = this.engine.resolver;
    this.transactions = this.engine.transactions;
    this.scanner = this.engine.scanner;
    this.artifacts = this.engine.artifacts;
  }

  public async scan(
    workspaceId: string,
    principal?: string,
    signal?: AbortSignal,
    languages: readonly string[] = ['l_english'],
  ): Promise<GuiStudioScanResult> {
    signal?.throwIfAborted();
    const workspace = this.resolver.get(workspaceId, principal);
    const [snapshot, localisationFiles] = await Promise.all([
      this.engine.scan(
        workspaceId,
        { patterns: guiDefinitionPatterns(workspace) },
        principal,
        signal,
      ),
      this.scanner.scan(workspace, {
        patterns: guiLocalisationPatterns(workspace, languages),
        ...(signal === undefined ? {} : { signal }),
      }),
    ]);
    signal?.throwIfAborted();
    const files = mergeScannedFiles(snapshot.files, localisationFiles);
    return {
      files,
      graph: buildGuiSourceGraph(files, snapshot.index),
    };
  }

  private async scanWindow(
    workspaceId: string,
    windowName: string,
    principal?: string,
    signal?: AbortSignal,
    languages: readonly string[] = ['l_english'],
  ): Promise<GuiStudioScanResult> {
    const definitions = await this.scan(workspaceId, principal, signal, languages);
    assertTargetWindowAvailable(definitions.graph, windowName);
    const workspace = this.resolver.get(workspaceId, principal);
    const referencedPatterns = referencedAssetPatternsForWindow(definitions.graph, windowName);
    const exactReferenced =
      referencedPatterns.length === 0
        ? []
        : await this.scanner.scan(workspace, {
            patterns: referencedPatterns,
            ...(signal === undefined ? {} : { signal }),
          });
    signal?.throwIfAborted();
    const fallbackPatterns = basenameFallbackPatterns(referencedPatterns, exactReferenced);
    const fallbackReferenced =
      fallbackPatterns.length === 0
        ? []
        : await this.scanner.scan(workspace, {
            patterns: fallbackPatterns,
            ...(signal === undefined ? {} : { signal }),
          });
    const referenced = mergeScannedFiles(exactReferenced, fallbackReferenced);
    const fontPagePatterns = bmFontPagePatterns(referenced);
    const exactFontPages =
      fontPagePatterns.length === 0
        ? []
        : await this.scanner.scan(workspace, {
            patterns: fontPagePatterns,
            ...(signal === undefined ? {} : { signal }),
          });
    signal?.throwIfAborted();
    const fontPageFallbackPatterns = basenameFallbackPatterns(fontPagePatterns, exactFontPages);
    const fallbackFontPages =
      fontPageFallbackPatterns.length === 0
        ? []
        : await this.scanner.scan(workspace, {
            patterns: fontPageFallbackPatterns,
            ...(signal === undefined ? {} : { signal }),
          });
    const fontPages = mergeScannedFiles(exactFontPages, fallbackFontPages);
    signal?.throwIfAborted();
    const files = mergeScannedFiles(definitions.files, referenced, fontPages);
    return { files, graph: buildGuiSourceGraph(files, this.engine.indexFiles(files)) };
  }

  public async lint(
    input: GuiStudioLintInput,
  ): Promise<{ scene: GuiScene; graph: GuiSourceGraph; validation: GuiValidationResult }> {
    input.signal?.throwIfAborted();
    const scenario = parsePreviewScenario(input.scenario);
    const relatedScenarios = (input.relatedScenarios ?? []).map(parsePreviewScenario);
    const scanned = await this.scanWindow(
      input.workspaceId,
      input.windowName,
      input.principal,
      input.signal,
      [scenario.language, ...relatedScenarios.map(({ language }) => language)],
    );
    const budget = new RenderBudget();
    const catalog = new GuiAssetCatalog(scanned.graph, scanned.files, budget);
    const scene = await buildGuiScene(
      scanned.graph,
      scanned.files,
      input.windowName,
      scenario,
      catalog,
    );
    const relatedScenes: GuiScene[] = [];
    for (const related of relatedScenarios) {
      input.signal?.throwIfAborted();
      relatedScenes.push(
        await buildGuiScene(scanned.graph, scanned.files, input.windowName, related, catalog),
      );
    }
    const validation = withGraphDiagnostics(
      scanned.graph,
      await validateGuiScene(scanned.graph, scene, scanned.files, relatedScenes, catalog),
    );
    return { scene, graph: scanned.graph, validation };
  }

  public async compare(input: GuiStudioCompareInput): Promise<GuiStudioCompareResult> {
    input.signal?.throwIfAborted();
    const budget = new RenderBudget();
    const beforeScenario = parsePreviewScenario(input.before);
    const afterScenario = parsePreviewScenario(input.after);
    const scanned = await this.scanWindow(
      input.workspaceId,
      input.windowName,
      input.principal,
      input.signal,
      [beforeScenario.language, afterScenario.language],
    );
    const catalog = new GuiAssetCatalog(scanned.graph, scanned.files, budget);
    const before = await buildGuiScene(
      scanned.graph,
      scanned.files,
      input.windowName,
      beforeScenario,
      catalog,
    );
    const after = await buildGuiScene(
      scanned.graph,
      scanned.files,
      input.windowName,
      afterScenario,
      catalog,
    );
    const [beforeRender, afterRender] = await Promise.all([
      renderGuiScene(before, ['full'], input.signal, budget),
      renderGuiScene(after, ['full'], input.signal, budget),
    ]);
    const comparison = await compareGuiImages(
      fullImage(beforeRender).png,
      fullImage(afterRender).png,
      budget,
      input.signal,
    );
    const evidenceJson = `${canonicalJson({
      offline: true,
      kind: 'gui-comparison',
      windowName: input.windowName,
      sourceHashes: scanned.graph.sourceHashes,
      before: {
        scenario: before.scenario,
        sourceRevision: before.sourceRevision,
        fidelity: before.fidelity,
      },
      after: {
        scenario: after.scenario,
        sourceRevision: after.sourceRevision,
        fidelity: after.fidelity,
      },
      comparison: JSON.parse(comparison.json) as unknown,
    })}\n`;
    return { before, after, comparison, evidenceJson, graph: scanned.graph };
  }

  public async renderAndStore(input: GuiStudioRenderInput): Promise<GuiArtifactSet> {
    input.signal?.throwIfAborted();
    const budget = new RenderBudget();
    const workspace = this.resolver.get(input.workspaceId, input.principal);
    const scenario = parsePreviewScenario(input.scenario);
    const baselineScenario = parsePreviewScenario(
      input.comparisonScenario ?? { ...scenario, id: `${scenario.id}-comparison`, state: 'normal' },
    );
    const scanned = await this.scanWindow(
      input.workspaceId,
      input.windowName,
      input.principal,
      input.signal,
      [scenario.language, baselineScenario.language],
    );
    const catalog = new GuiAssetCatalog(scanned.graph, scanned.files, budget);
    const scene = await buildGuiScene(
      scanned.graph,
      scanned.files,
      input.windowName,
      scenario,
      catalog,
    );
    const render = await renderGuiScene(scene, undefined, input.signal, budget);
    const stateScenes: GuiScene[] = [];
    const stateItems: GalleryItem[] = [];
    for (const state of input.states ?? [...galleryStates]) {
      input.signal?.throwIfAborted();
      const stateScenario = scenarioWith(scenario, { id: `${scenario.id}-${state}`, state });
      const stateScene = await buildGuiScene(
        scanned.graph,
        scanned.files,
        input.windowName,
        stateScenario,
        catalog,
      );
      stateScenes.push(stateScene);
      const stateRender = await renderGuiScene(stateScene, ['full'], input.signal, budget);
      const image = fullImage(stateRender);
      stateItems.push({ label: state, png: image.png, width: image.width, height: image.height });
    }
    const resolutionScenes: GuiScene[] = [];
    const resolutionItems: GalleryItem[] = [];
    const resolutions = input.resolutions ?? [
      { width: 1280, height: 720, uiScale: 1 },
      { width: 1920, height: 1080, uiScale: 1 },
      { width: 2560, height: 1440, uiScale: 1 },
      { width: 1920, height: 1080, uiScale: 1.25 },
    ];
    for (const resolution of resolutions) {
      input.signal?.throwIfAborted();
      const uiScale = resolution.uiScale ?? scenario.uiScale;
      const resolutionScenario = scenarioWith(scenario, {
        id: `${scenario.id}-${resolution.width}x${resolution.height}-${uiScale}`,
        resolution: { width: resolution.width, height: resolution.height },
        uiScale,
      });
      const resolutionScene = await buildGuiScene(
        scanned.graph,
        scanned.files,
        input.windowName,
        resolutionScenario,
        catalog,
      );
      resolutionScenes.push(resolutionScene);
      const resolutionRender = await renderGuiScene(
        resolutionScene,
        ['full'],
        input.signal,
        budget,
      );
      const image = fullImage(resolutionRender);
      resolutionItems.push({
        label: `${resolution.width}×${resolution.height} · UI ${uiScale}`,
        png: image.png,
        width: image.width,
        height: image.height,
      });
    }
    const baselineScene = await buildGuiScene(
      scanned.graph,
      scanned.files,
      input.windowName,
      baselineScenario,
      catalog,
    );
    const baselineRender = await renderGuiScene(baselineScene, ['full'], input.signal, budget);
    const comparison = await compareGuiImages(
      fullImage(baselineRender).png,
      fullImage(render).png,
      budget,
      input.signal,
    );
    const validation = await validateGuiScene(
      scanned.graph,
      scene,
      scanned.files,
      resolutionScenes,
      catalog,
    );
    const stateValidation = validateStateMatrix(stateScenes);
    const resolutionValidation = validateResolutionDrift(resolutionScenes);
    validation.diagnostics.push(
      ...stateValidation.diagnostics,
      ...resolutionValidation.diagnostics,
    );
    validation.checks.push(...stateValidation.checks, ...resolutionValidation.checks);
    const completeValidation = withGraphDiagnostics(scanned.graph, validation);

    const stateGallerySvg = renderGallerySvg(`${input.windowName} state matrix`, stateItems);
    const resolutionGallerySvg = renderGallerySvg(
      `${input.windowName} resolution and UI-scale matrix`,
      resolutionItems,
    );
    const stateGallerySize = galleryDimensions(stateItems);
    const resolutionGallerySize = galleryDimensions(resolutionItems);
    budget.reserve(stateGallerySize.width, stateGallerySize.height, 'GUI state gallery PNG');
    budget.reserve(
      resolutionGallerySize.width,
      resolutionGallerySize.height,
      'GUI resolution gallery PNG',
    );
    budget.reserveRasterOperation(
      `gui-gallery:${sha256Bytes(stateGallerySvg)}`,
      'GUI state gallery SVG rasterization',
    );
    budget.reserveRasterOperation(
      `gui-gallery:${sha256Bytes(resolutionGallerySvg)}`,
      'GUI resolution gallery SVG rasterization',
    );
    const [stateGalleryPng, resolutionGalleryPng] = await Promise.all([
      sharp(Buffer.from(stateGallerySvg), { limitInputPixels: RENDER_MAX_PIXELS })
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer(),
      sharp(Buffer.from(resolutionGallerySvg), { limitInputPixels: RENDER_MAX_PIXELS })
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer(),
    ]);
    const slug = safeSlug(input.windowName);
    const writes: ArtifactWrite[] = [];
    const add = (
      name: string,
      mimeType: string,
      content: Buffer | string,
      kind: string,
      scenarioScenes: readonly GuiScene[] = [scene],
      metadata: Record<string, unknown> = {},
    ): void => {
      input.signal?.throwIfAborted();
      writes.push({
        name,
        mimeType,
        content,
        provenance: guiArtifactProvenance(
          scanned.graph,
          kind,
          scenarioScenes[0] ?? scene,
          scenarioScenes,
          metadata,
        ),
      });
    };
    for (const image of render.images) {
      add(`${slug}-${image.variant}.svg`, 'image/svg+xml', image.svg, `gui-${image.variant}-svg`);
      add(`${slug}-${image.variant}.png`, 'image/png', image.png, `gui-${image.variant}-png`);
    }
    add(`${slug}-hierarchy.svg`, 'image/svg+xml', render.hierarchySvg, 'gui-hierarchy');
    add(`${slug}-layout.json`, 'application/json', render.layoutJson, 'gui-layout-json');
    add(`${slug}-scenario.json`, 'application/json', render.scenarioJson, 'gui-preview-scenario');
    add(
      `${slug}-fidelity.json`,
      'application/json',
      `${canonicalJson({ offline: true, fidelity: render.fidelity })}\n`,
      'gui-fidelity-report',
    );
    add(
      `${slug}-source-graph.json`,
      'application/json',
      `${canonicalJson(scanned.graph)}\n`,
      'gui-source-graph',
    );
    add(
      `${slug}-validation.json`,
      'application/json',
      `${canonicalJson(completeValidation)}\n`,
      'gui-validation-report',
      [scene, ...stateScenes, ...resolutionScenes],
    );
    add(
      `${slug}-state-matrix.svg`,
      'image/svg+xml',
      stateGallerySvg,
      'gui-state-matrix',
      stateScenes,
    );
    add(`${slug}-state-matrix.png`, 'image/png', stateGalleryPng, 'gui-state-matrix', stateScenes);
    add(
      `${slug}-state-matrix.json`,
      'application/json',
      `${canonicalJson({ offline: true, scenarios: stateScenes.map(({ scenario: stateScenario, fidelity }) => ({ scenario: stateScenario, fidelity })) })}\n`,
      'gui-state-matrix-json',
      stateScenes,
    );
    add(
      `${slug}-resolution-scale.svg`,
      'image/svg+xml',
      resolutionGallerySvg,
      'gui-resolution-scale-matrix',
      resolutionScenes,
    );
    add(
      `${slug}-resolution-scale.png`,
      'image/png',
      resolutionGalleryPng,
      'gui-resolution-scale-matrix',
      resolutionScenes,
    );
    add(
      `${slug}-resolution-scale.json`,
      'application/json',
      `${canonicalJson({ offline: true, scenarios: resolutionScenes.map(({ scenario: resolutionScenario, fidelity }) => ({ scenario: resolutionScenario, fidelity })) })}\n`,
      'gui-resolution-scale-json',
      resolutionScenes,
    );
    add(`${slug}-comparison.png`, 'image/png', comparison.png, 'gui-before-after-comparison', [
      scene,
      baselineScene,
    ]);
    add(
      `${slug}-comparison.json`,
      'application/json',
      comparison.json,
      'gui-before-after-comparison',
      [scene, baselineScene],
    );
    const stored = await this.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (artifacts) => Promise.resolve([...artifacts]),
      input.signal,
    );
    return {
      artifacts: stored,
      filesScanned: scanned.graph.filesScanned,
      render,
      stateScenes,
      resolutionScenes,
      comparison,
      validation: completeValidation,
    };
  }

  public async planSource(input: PlanGuiSourceInput): Promise<TransactionManifest> {
    input.signal?.throwIfAborted();
    const workspace = this.resolver.get(input.workspaceId, input.principal);
    guiTextPackageFileKind(workspace, input.relativePath, true);
    if ((input.source === undefined) === (input.patches === undefined))
      throw new ServiceError(
        'GUI_SOURCE_MODE_INVALID',
        'Provide either a new source file or targeted source patches',
      );
    if (input.patches !== undefined && (input.additionalFiles?.length ?? 0) > 0) {
      throw new ServiceError(
        'GUI_TEXT_PACKAGE_PATCH_MODE_INVALID',
        'Additional GUI text-package files are accepted only with whole-source or helper rewrites',
      );
    }

    let prepared: PreparedGuiTextPackageFile[];
    if (input.patches !== undefined) {
      if (
        input.expectedSourceHash === undefined ||
        !/^[a-f0-9]{64}$/u.test(input.expectedSourceHash)
      )
        throw new ServiceError(
          'GUI_EXPECTED_SOURCE_HASH_REQUIRED',
          'Targeted GUI patches require the exact expected source hash',
        );
      const existing = await this.resolver.resolvePath(
        input.workspaceId,
        input.relativePath,
        'read',
        ['mod'],
        input.principal,
      );
      const before = await readFile(existing.path);
      if (sha256Bytes(before) !== input.expectedSourceHash)
        throw new ServiceError(
          'GUI_SOURCE_STALE',
          'GUI source changed after the patch was prepared',
        );
      const document = parseClausewitz(before, `mod:${input.relativePath}`);
      const limitDiagnostics = sourcePartialLimitDiagnostics(document.diagnostics);
      if (limitDiagnostics.length > 0) {
        throw new ServiceError(
          'GUI_TARGET_SOURCE_SKIPPED_LIMIT',
          'The targeted GUI source exceeds a parser limit and cannot be patched safely',
          {
            path: `mod:${input.relativePath}`,
            reasonCodes: [...new Set(limitDiagnostics.map(({ code }) => code))],
          },
        );
      }
      for (const patch of input.patches) {
        if (document.text.slice(patch.start, patch.end) !== patch.expectedText) {
          throw new ServiceError(
            'GUI_PATCH_PRECONDITION_FAILED',
            'A targeted GUI patch no longer matches its expected token range',
            { start: patch.start, end: patch.end },
          );
        }
      }
      assertGuiSourcePatchesSafe(document, input.patches);
      const proposedBytes = applyReplacements(document, input.patches);
      prepared = [
        {
          relativePath: input.relativePath,
          kind: 'gui',
          bytes: proposedBytes,
          absolutePath: existing.path,
          loadOrder: existing.root.loadOrder,
        },
      ];
    } else {
      if (input.source === undefined)
        throw new ServiceError('GUI_SOURCE_REQUIRED', 'A new GUI source file requires source text');
      const requests = [
        { relativePath: input.relativePath, source: input.source, main: true },
        ...(input.additionalFiles ?? []).map((file) => ({ ...file, main: false })),
      ];
      if (requests.length > GUI_TEXT_PACKAGE_MAX_FILES) {
        throw new ServiceError(
          'GUI_TEXT_PACKAGE_FILE_BUDGET_BLOCKED',
          'GUI text package exceeds the fixed file-count ceiling',
          { files: requests.length, maximumFiles: GUI_TEXT_PACKAGE_MAX_FILES },
        );
      }
      const seen = new Map<string, string>();
      const classified = requests.map((request) => {
        const key = portableSourcePathKey(request.relativePath);
        const duplicate = seen.get(key);
        if (duplicate !== undefined) {
          throw new ServiceError(
            'GUI_TEXT_PACKAGE_DUPLICATE_PATH',
            'GUI text-package paths must be unique under portable path comparison',
            { first: duplicate, duplicate: request.relativePath },
          );
        }
        seen.set(key, request.relativePath);
        return {
          ...request,
          kind: guiTextPackageFileKind(workspace, request.relativePath, request.main),
        };
      });
      classified.sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
      prepared = [];
      let totalBytes = 0;
      for (const request of classified) {
        input.signal?.throwIfAborted();
        const resolved = await this.resolver.resolvePath(
          input.workspaceId,
          request.relativePath,
          'write',
          ['mod'],
          input.principal,
        );
        let existingBytes: Buffer | undefined;
        try {
          existingBytes = await readFile(resolved.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const encoding =
          request.kind === 'localisation'
            ? 'utf8-bom'
            : existingBytes === undefined
              ? 'utf8'
              : decodeSource(existingBytes).encoding;
        const source = request.source.startsWith('\ufeff')
          ? request.source.slice(1)
          : request.source;
        const bytes = encodeSource(source, encoding);
        if (bytes.length > SOURCE_MAX_BYTES) {
          throw new ServiceError(
            'GUI_TEXT_PACKAGE_FILE_BYTE_BUDGET_BLOCKED',
            'A GUI text-package file exceeds the Clausewitz parser byte ceiling',
            {
              relativePath: request.relativePath,
              bytes: bytes.length,
              maximumBytes: SOURCE_MAX_BYTES,
            },
          );
        }
        totalBytes += bytes.length;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > GUI_TEXT_PACKAGE_MAX_BYTES) {
          throw new ServiceError(
            'GUI_TEXT_PACKAGE_BYTE_BUDGET_BLOCKED',
            'GUI text package exceeds the fixed aggregate byte ceiling',
            { bytes: totalBytes, maximumBytes: GUI_TEXT_PACKAGE_MAX_BYTES },
          );
        }
        prepared.push({
          relativePath: request.relativePath,
          kind: request.kind,
          bytes,
          absolutePath: resolved.path,
          loadOrder: resolved.root.loadOrder,
        });
      }
    }

    const proposedSourceDiagnostics = prepared.flatMap(
      (file) => parseGuiTextPackageFile(file).diagnostics,
    );
    const blockingProposedSourceDiagnostics = proposedSourceDiagnostics.filter(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
    if (blockingProposedSourceDiagnostics.length > 0)
      throw new ServiceError(
        'GUI_PROPOSED_SOURCE_INVALID',
        'Proposed GUI text package contains blocking parser diagnostics',
        {
          diagnostics: blockingProposedSourceDiagnostics.slice(0, 100),
          diagnosticCount: blockingProposedSourceDiagnostics.length,
        },
      );
    if ((input.windowName === undefined) !== (input.scenario === undefined))
      throw new Error('GUI visual preflight requires both windowName and scenario.');
    const initiallyScanned =
      input.windowName === undefined
        ? await this.scan(input.workspaceId, input.principal, input.signal)
        : await this.scanWindow(
            input.workspaceId,
            input.windowName,
            input.principal,
            input.signal,
            [parsePreviewScenario(input.scenario).language],
          );
    const exactTargets = await this.scanner.scan(workspace, {
      patterns: prepared.map(({ relativePath }) => relativePath),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const baselineFiles = mergeScannedFiles(initiallyScanned.files, exactTargets);
    const baseline = {
      files: baselineFiles,
      graph: buildGuiSourceGraph(baselineFiles, this.engine.indexFiles(baselineFiles)),
    };
    const preflightDiagnostics: Diagnostic[] = [];
    const preflightChecks: { id: string; passed: boolean; message: string }[] = [];
    const preflightArtifacts: ArtifactLink[] = [];
    let dependencyFiles = baseline.files;
    if (input.windowName !== undefined && input.scenario !== undefined) {
      let proposedFiles = overlayGuiTextPackageFiles(baseline.files, prepared);
      const scenario = parsePreviewScenario(input.scenario);
      const renderBudget = new RenderBudget();
      let proposedGraph = buildGuiSourceGraph(proposedFiles, this.engine.indexFiles(proposedFiles));
      const proposedAssetPatterns = referencedAssetPatternsForWindow(
        proposedGraph,
        input.windowName,
      );
      const exactProposedAssets =
        proposedAssetPatterns.length === 0
          ? []
          : await this.scanner.scan(workspace, {
              patterns: proposedAssetPatterns,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
      const proposedFallbackPatterns = basenameFallbackPatterns(
        proposedAssetPatterns,
        exactProposedAssets,
      );
      const fallbackProposedAssets =
        proposedFallbackPatterns.length === 0
          ? []
          : await this.scanner.scan(workspace, {
              patterns: proposedFallbackPatterns,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
      const proposedAssets = mergeScannedFiles(exactProposedAssets, fallbackProposedAssets);
      const proposedFontPagePatterns = bmFontPagePatterns(proposedAssets);
      const exactProposedFontPages =
        proposedFontPagePatterns.length === 0
          ? []
          : await this.scanner.scan(workspace, {
              patterns: proposedFontPagePatterns,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
      const proposedFontFallbackPatterns = basenameFallbackPatterns(
        proposedFontPagePatterns,
        exactProposedFontPages,
      );
      const fallbackProposedFontPages =
        proposedFontFallbackPatterns.length === 0
          ? []
          : await this.scanner.scan(workspace, {
              patterns: proposedFontFallbackPatterns,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
      const proposedFontPages = mergeScannedFiles(
        exactProposedFontPages,
        fallbackProposedFontPages,
      );
      input.signal?.throwIfAborted();
      dependencyFiles = mergeScannedFiles(baseline.files, proposedAssets, proposedFontPages);
      proposedFiles = mergeScannedFiles(proposedFiles, proposedAssets, proposedFontPages);
      proposedGraph = buildGuiSourceGraph(proposedFiles, this.engine.indexFiles(proposedFiles));
      const proposedCatalog = new GuiAssetCatalog(proposedGraph, proposedFiles, renderBudget);
      const proposedScene = await buildGuiScene(
        proposedGraph,
        proposedFiles,
        input.windowName,
        scenario,
        proposedCatalog,
      );
      const proposedRender = await renderGuiScene(
        proposedScene,
        ['full'],
        input.signal,
        renderBudget,
      );
      const proposedImage = fullImage(proposedRender);
      const proposedValidation = await validateGuiScene(
        proposedGraph,
        proposedScene,
        proposedFiles,
        [],
        proposedCatalog,
      );
      preflightDiagnostics.push(
        ...proposedGraph.diagnostics,
        ...proposedScene.diagnostics,
        ...proposedValidation.diagnostics,
      );
      const visualPassed =
        proposedValidation.checks.every(({ passed }) => passed) &&
        !preflightDiagnostics.some(
          ({ severity }) => severity === 'error' || severity === 'blocker',
        );
      preflightChecks.push(...proposedValidation.checks, {
        id: 'gui-visual-preflight',
        passed: visualPassed,
        message: visualPassed
          ? 'Proposed GUI renders and validates offline'
          : 'Proposed GUI has blocking offline render or validation findings',
      });

      const baselineScene = await buildGuiScene(
        baseline.graph,
        baseline.files,
        input.windowName,
        scenario,
        new GuiAssetCatalog(baseline.graph, baseline.files, renderBudget),
      );
      let baselinePng: Buffer;
      if (baseline.graph.elements.some(({ name }) => name === input.windowName)) {
        baselinePng = fullImage(
          await renderGuiScene(baselineScene, ['full'], input.signal, renderBudget),
        ).png;
      } else {
        renderBudget.reserve(
          proposedImage.width,
          proposedImage.height,
          'GUI empty comparison baseline',
        );
        assertRenderDimensions(
          proposedImage.width,
          proposedImage.height,
          'GUI empty comparison Sharp raster',
        );
        renderBudget.reserveRasterOperation(
          `gui-empty-baseline:${proposedImage.width}x${proposedImage.height}`,
          'GUI empty comparison rasterization',
        );
        baselinePng = await sharp({
          create: {
            width: proposedImage.width,
            height: proposedImage.height,
            channels: 4,
            background: '#00000000',
          },
        })
          .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
          .toBuffer();
        preflightDiagnostics.push({
          code: 'GUI_COMPARISON_BASELINE_EMPTY',
          severity: 'info',
          category: 'rendering',
          message:
            'The proposed window has no renderable baseline; comparison uses an explicit empty canvas.',
        });
      }
      const comparison = await compareGuiImages(
        baselinePng,
        proposedImage.png,
        renderBudget,
        input.signal,
      );
      const slug = safeSlug(input.windowName);
      const metadata = {
        relativePath: input.relativePath,
        packageFiles: prepared.map(({ relativePath }) => relativePath),
      };
      const writes: ArtifactWrite[] = [
        {
          name: `${slug}-before.png`,
          mimeType: 'image/png',
          content: baselinePng,
          provenance: guiArtifactProvenance(
            baseline.graph,
            'gui-before-render',
            baselineScene,
            [baselineScene],
            metadata,
          ),
        },
        {
          name: `${slug}-proposed.png`,
          mimeType: 'image/png',
          content: proposedImage.png,
          provenance: guiArtifactProvenance(
            proposedGraph,
            'gui-proposed-render',
            proposedScene,
            [proposedScene],
            metadata,
          ),
        },
        {
          name: `${slug}-visual-diff.png`,
          mimeType: 'image/png',
          content: comparison.png,
          provenance: guiArtifactProvenance(
            proposedGraph,
            'gui-visual-diff',
            proposedScene,
            [proposedScene, baselineScene],
            metadata,
          ),
        },
        {
          name: `${slug}-visual-diff.json`,
          mimeType: 'application/json',
          content: comparison.json,
          provenance: guiArtifactProvenance(
            proposedGraph,
            'gui-visual-diff-json',
            proposedScene,
            [proposedScene, baselineScene],
            metadata,
          ),
        },
        {
          name: `${slug}-proposed-fidelity.json`,
          mimeType: 'application/json',
          content: `${canonicalJson({
            offline: true,
            scenario,
            fidelity: proposedScene.fidelity,
            validation: proposedValidation,
          })}\n`,
          provenance: guiArtifactProvenance(
            proposedGraph,
            'gui-proposed-fidelity',
            proposedScene,
            [proposedScene],
            metadata,
          ),
        },
      ];
      const stored = await this.artifacts.withAtomicWrites(
        workspace,
        writes,
        (artifacts) => Promise.resolve([...artifacts]),
        input.signal,
      );
      preflightArtifacts.push(...stored.map(publicArtifactLink));
    }
    const operationId = deterministicId('gui_source_change', {
      relativePath: input.relativePath,
      files: prepared.map(({ relativePath, bytes }) => ({
        relativePath,
        sourceHash: sha256Bytes(bytes),
      })),
      patchCount: input.patches?.length ?? 0,
    });
    return this.transactions.plan({
      workspaceId: input.workspaceId,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      operationKind: 'gui-source-change',
      operations: [
        {
          id: operationId,
          kind: prepared.length === 1 ? 'replace-gui-source' : 'replace-gui-text-package',
          summary:
            prepared.length === 1
              ? `Plan GUI source ${input.relativePath}`
              : `Plan ${prepared.length}-file GUI text package rooted at ${input.relativePath}`,
          data: {
            relativePath: input.relativePath,
            fileCount: prepared.length,
            files: prepared.map(({ relativePath, kind }) => ({ relativePath, kind })),
          },
        },
      ],
      changes: prepared.map((file) => ({
        relativePath: file.relativePath,
        content: file.bytes,
        operationIds: [operationId],
        mediaType: 'text/plain',
      })),
      readDependencies: readDependenciesFromScannedFiles(dependencyFiles),
      artifacts: preflightArtifacts,
      diagnostics: preflightDiagnostics,
      validate: (proposed, signal) => {
        const diagnostics: Diagnostic[] = [];
        let present = true;
        let syntaxPassed = true;
        for (const file of prepared) {
          signal?.throwIfAborted();
          const proposedSource = proposed.has(file.relativePath)
            ? proposed.get(file.relativePath)
            : file.bytes;
          if (proposedSource === null || proposedSource === undefined) {
            present = false;
            syntaxPassed = false;
            diagnostics.push({
              code: 'GUI_PROPOSED_SOURCE_MISSING',
              severity: 'blocker',
              category: 'validation',
              message: `Proposed source is missing ${file.relativePath}`,
              operationId,
            });
            continue;
          }
          const document = parseGuiTextPackageFile({ ...file, bytes: proposedSource });
          const blocking = document.diagnostics.filter(
            ({ severity }) => severity === 'error' || severity === 'blocker',
          );
          if (blocking.length > 0) syntaxPassed = false;
          diagnostics.push(...blocking.map((diagnostic) => ({ ...diagnostic, operationId })));
        }
        return Promise.resolve({
          diagnostics,
          checks: [
            ...preflightChecks,
            {
              id: 'gui-package-files-present',
              passed: present,
              message: 'Every requested GUI text-package file is present.',
            },
            {
              id: 'gui-package-source-syntax',
              passed: syntaxPassed,
              message: 'Every requested GUI text-package file parses safely for its source type.',
            },
          ],
        });
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public applyPlannedSource(
    workspaceId: string,
    transactionId: string,
    planHash: string,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<TransactionManifest> {
    return this.transactions.apply(workspaceId, transactionId, planHash, {
      ...(principal === undefined ? {} : { principal }),
      ...(signal === undefined ? {} : { signal }),
      postValidate: async (_manifest, validationSignal) => {
        this.engine.invalidate(workspaceId);
        const scanned = await this.scan(workspaceId, principal, validationSignal);
        const passed = !scanned.graph.diagnostics.some(
          ({ severity }) => severity === 'error' || severity === 'blocker',
        );
        return {
          diagnostics: scanned.graph.diagnostics,
          checks: [
            {
              id: 'post-write-gui-graph',
              passed,
              message: passed
                ? 'Applied GUI source graph rebuilt successfully'
                : 'Applied GUI source graph has blocking diagnostics',
            },
          ],
        };
      },
    });
  }
}
