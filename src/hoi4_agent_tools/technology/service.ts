import path from 'node:path';
import { canonicalJson, compareCodeUnits, hashCanonical, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  boundedSourceHashEvidence,
  type ArtifactProvenance,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import { RenderBudget } from '../core/render-budget.js';
import { ServiceError } from '../core/result.js';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { isPortablePathSegment } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import { compareTechnologyGraphs, type TechnologyGraphComparison } from './compare.js';
import { buildTechnologyGraph, technologyAssetPatterns } from './graph.js';
import type {
  TechnologyDefectClass,
  TechnologyGraphSnapshot,
  TechnologySourceFragment,
  TechnologyUnlockKind,
} from './model.js';
import {
  analyzeTechnologyImpact,
  discoverTechnologyFolders,
  explainTechnology,
  inspectTechnologyUnlocks,
  lintTechnologyGraph,
  technologyBonusCoverage,
  technologyScanReport,
  traceTechnology,
  type TechnologyImpactInput,
} from './queries.js';
import {
  renderTechnologyGraph,
  type TechnologyRenderBundle,
  type TechnologyRenderOptions,
  type TechnologyRenderView,
} from './render.js';
import type { TechnologySourceFragmentCacheLike } from './source-analysis.js';

const FRAGMENT_CACHE_ENTRIES = 8_192;
const FRAGMENT_CACHE_BYTES = 134_217_728;
const PROPOSED_SOURCE_FILES = 128;
const PROPOSED_SOURCE_BYTES = 67_108_864;
const GRAPH_ARTIFACT_BYTES = 134_217_728;
const GRAPH_ARTIFACT_CHUNKS = 2_048;
const HISTORY_ENTRIES = 12;
const FOCUSED_RENDER_LIMIT = 32;

export type TechnologyAnalysisMode =
  'scan' | 'folders' | 'trace' | 'explain' | 'unlocks' | 'bonus_coverage' | 'lint' | 'impact';

export interface TechnologyAnalysisInput {
  workspaceId: string;
  mode: TechnologyAnalysisMode;
  folderId?: string;
  technologyId?: string;
  categoryId?: string;
  targetKind?: TechnologyUnlockKind;
  targetId?: string;
  direction?: 'prerequisites' | 'descendants' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  includeSubTechnologies?: boolean;
  classifications?: TechnologyDefectClass[];
  codes?: string[];
  impact?: TechnologyImpactInput;
  refresh?: boolean;
  principal?: string;
  signal?: AbortSignal;
}

export interface TechnologyAnalysisResult {
  graph: TechnologyGraphSnapshot;
  report: unknown;
  reportJson: string;
  artifacts: StoredArtifact[];
}

export interface TechnologyRenderServiceInput {
  workspaceId: string;
  view: TechnologyRenderView;
  folderId?: string;
  technologyId?: string;
  categoryId?: string;
  targetId?: string;
  maxNodes?: number;
  includeHtml?: boolean;
  refresh?: boolean;
  principal?: string;
  signal?: AbortSignal;
}

export interface TechnologyRenderServiceResult {
  graph: TechnologyGraphSnapshot;
  render: TechnologyRenderBundle;
  focused: TechnologyRenderBundle[];
  manifestJson: string;
  artifacts: StoredArtifact[];
}

export interface TechnologyProposedSource {
  relativePath: string;
  source: string | null;
  expectedSourceHash?: string;
}

export interface TechnologyGraphReference {
  revision?: string;
  artifactUri?: string;
}

export interface TechnologyCompareInput {
  workspaceId: string;
  before?: TechnologyGraphReference;
  after?: TechnologyGraphReference;
  proposedSources?: TechnologyProposedSource[];
  render?: boolean;
  maxRenderNodes?: number;
  refresh?: boolean;
  principal?: string;
  signal?: AbortSignal;
}

export interface TechnologyCompareResult {
  before: TechnologyGraphSnapshot;
  after: TechnologyGraphSnapshot;
  comparison: TechnologyGraphComparison;
  comparisonJson: string;
  render?: TechnologyRenderBundle;
  artifacts: StoredArtifact[];
}

interface CachedTechnologyGraph {
  generation: number;
  snapshot: ScanSnapshot;
  assetFiles: ScannedFile[];
  graph: TechnologyGraphSnapshot;
}

interface SharedTechnologyState {
  current: Map<string, CachedTechnologyGraph>;
  history: Map<string, Map<string, TechnologyGraphSnapshot>>;
  fragments: BoundedTechnologyFragmentCache;
}

class BoundedTechnologyFragmentCache implements TechnologySourceFragmentCacheLike {
  readonly #values = new Map<string, { fragment: TechnologySourceFragment; bytes: number }>();
  #bytes = 0;

  public get(key: string): TechnologySourceFragment | undefined {
    const value = this.#values.get(key);
    if (value === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value);
    return value.fragment;
  }

  public set(key: string, fragment: TechnologySourceFragment, sourceBytes: number): void {
    const previous = this.#values.get(key);
    if (previous !== undefined) this.#bytes -= previous.bytes;
    this.#values.delete(key);
    this.#values.set(key, { fragment, bytes: sourceBytes });
    this.#bytes += sourceBytes;
    while (this.#values.size > FRAGMENT_CACHE_ENTRIES || this.#bytes > FRAGMENT_CACHE_BYTES) {
      const oldest = this.#values.entries().next().value as
        [string, { fragment: TechnologySourceFragment; bytes: number }] | undefined;
      if (oldest === undefined) break;
      this.#values.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
    }
  }
}

const sharedTechnologyStates = new WeakMap<CoreEngine, SharedTechnologyState>();

function sharedState(engine: CoreEngine): SharedTechnologyState {
  let state = sharedTechnologyStates.get(engine);
  if (state === undefined) {
    state = {
      current: new Map(),
      history: new Map(),
      fragments: new BoundedTechnologyFragmentCache(),
    };
    sharedTechnologyStates.set(engine, state);
  }
  return state;
}

function rememberGraph(state: SharedTechnologyState, graph: TechnologyGraphSnapshot): void {
  const history =
    state.history.get(graph.workspaceId) ?? new Map<string, TechnologyGraphSnapshot>();
  history.delete(graph.revision);
  history.set(graph.revision, graph);
  while (history.size > HISTORY_ENTRIES) {
    const oldest = history.keys().next().value;
    if (oldest === undefined) break;
    history.delete(oldest);
  }
  state.history.set(graph.workspaceId, history);
}

function safeSlug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 64) || 'technology'
  );
}

function graphHash(graph: TechnologyGraphSnapshot): string {
  return hashCanonical({
    schemaVersion: graph.schemaVersion,
    workspaceIdentity: graph.workspaceIdentity,
    revision: graph.revision,
    statistics: graph.statistics,
    sourceHashes: graph.sourceHashes,
  });
}

function technologyProvenance(
  graph: TechnologyGraphSnapshot,
  kind: string,
  metadata: Record<string, unknown> = {},
): ArtifactProvenance {
  const sourceEvidence = boundedSourceHashEvidence(graph.sourceHashes);
  return {
    kind,
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'technology-tree-viewer.v1',
    sourceHashes: sourceEvidence.sourceHashes,
    renderProfile: {
      graphRevision: graph.revision,
      graphHash: graphHash(graph),
      complete: graph.complete,
      parserVersion: graph.parserVersion,
    },
    metadata: {
      ...metadata,
      sourceHashInventory: sourceEvidence.inventory,
      unresolvedCount: graph.unresolved.length,
    },
  };
}

function issueDiagnostic(graph: TechnologyGraphSnapshot): Diagnostic[] {
  return graph.issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    category: issue.classification === 'confirmed_error' ? 'reference' : 'design',
    message: issue.message,
    ...(issue.location === undefined ? {} : { location: issue.location }),
    ...(issue.related === undefined ? {} : { related: issue.related }),
    details: {
      classification: issue.classification,
      confidence: issue.confidence,
      blockers: issue.blockers,
      ...issue.details,
    },
  }));
}

export function technologyDiagnostics(graph: TechnologyGraphSnapshot): Diagnostic[] {
  return [...graph.diagnostics, ...issueDiagnostic(graph)];
}

function validRelativeSourcePath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  )
    throw new ServiceError(
      'TECH_PROPOSED_PATH_INVALID',
      'Proposed source path must be workspace-relative',
    );
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\.\//u, '');
  const segments = normalized.split('/');
  if (
    normalized === '.' ||
    normalized.startsWith('.hoi4-agent/') ||
    segments.some((segment) => segment === '..' || !isPortablePathSegment(segment))
  )
    throw new ServiceError(
      'TECH_PROPOSED_PATH_INVALID',
      'Proposed source path escapes the workspace or is not portable',
    );
  if (!/\.(?:txt|gui|gfx|yml|yaml)$/iu.test(normalized))
    throw new ServiceError(
      'TECH_PROPOSED_SOURCE_UNSUPPORTED',
      'Technology comparison overlays support HOI4 text sources only',
    );
  return normalized;
}

function assertProposedBounds(sources: readonly TechnologyProposedSource[]): void {
  if (sources.length === 0)
    throw new ServiceError('TECH_PROPOSED_SOURCE_REQUIRED', 'Proposed source list is empty');
  if (sources.length > PROPOSED_SOURCE_FILES)
    throw new ServiceError(
      'TECH_PROPOSED_SOURCE_COUNT_LIMIT',
      'Proposed source list exceeds its fixed file ceiling',
      {
        count: sources.length,
        maximumFiles: PROPOSED_SOURCE_FILES,
      },
    );
  const bytes = sources.reduce(
    (total, item) => total + (item.source === null ? 0 : Buffer.byteLength(item.source, 'utf8')),
    0,
  );
  if (bytes > PROPOSED_SOURCE_BYTES)
    throw new ServiceError(
      'TECH_PROPOSED_SOURCE_TOTAL_LIMIT',
      'Proposed sources exceed their fixed byte ceiling',
      {
        bytes,
        maximumBytes: PROPOSED_SOURCE_BYTES,
      },
    );
}

function recomputeShadowing(files: ScannedFile[]): void {
  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    delete file.shadowedBy;
    const key = file.relativePath.replaceAll('\\', '/').toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        right.loadOrder - left.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
    );
    const active = group[0];
    if (active !== undefined)
      for (const file of group.slice(1)) file.shadowedBy = active.displayPath;
  }
}

function snapshotRevision(files: readonly ScannedFile[]): string {
  return hashCanonical(
    [...files]
      .sort(
        (left, right) =>
          left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
      )
      .map(({ displayPath, loadOrder, sha256 }) => ({ displayPath, loadOrder, sha256 })),
  );
}

function validateGraph(value: unknown): TechnologyGraphSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_INVALID',
      'Technology graph artifact is not an object',
    );
  const graph = value as Partial<TechnologyGraphSnapshot>;
  const sourceHashes = (value as Record<string, unknown>).sourceHashes;
  if (
    graph.schemaVersion !== 1 ||
    typeof graph.workspaceId !== 'string' ||
    typeof graph.workspaceIdentity !== 'string' ||
    typeof graph.revision !== 'string' ||
    !Array.isArray(graph.technologies) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.placements) ||
    sourceHashes === null ||
    typeof sourceHashes !== 'object'
  )
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_INVALID',
      'Technology graph artifact has an invalid schema',
    );
  return graph as TechnologyGraphSnapshot;
}

async function readLogicalArtifact(
  engine: CoreEngine,
  workspaceId: string,
  uri: string,
  principal?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const workspace = engine.resolver.get(workspaceId, principal);
  const probe = await engine.artifacts.read(workspace, uri, { offset: 0, length: 1 }, signal);
  if (probe.mimeType !== 'application/json' || probe.totalSize > GRAPH_ARTIFACT_BYTES)
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_INVALID',
      'Technology graph artifact must be bounded JSON',
    );
  const read = await engine.artifacts.read(workspace, uri, undefined, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_INVALID',
      'Technology graph artifact is not valid JSON',
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { type?: unknown }).type !== 'hoi4-agent.chunked-artifact'
  )
    return read.bytes;
  const index = parsed as {
    schemaVersion?: unknown;
    original?: { size?: unknown; sha256?: unknown; mimeType?: unknown };
    chunks?: unknown;
  };
  if (index.schemaVersion !== 1 || !Array.isArray(index.chunks))
    throw new ServiceError('TECH_GRAPH_ARTIFACT_INVALID', 'Chunked graph index is malformed');
  if (index.chunks.length === 0 || index.chunks.length > GRAPH_ARTIFACT_CHUNKS)
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_LIMIT',
      'Chunked graph index exceeds the chunk ceiling',
    );
  const size = index.original?.size;
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > GRAPH_ARTIFACT_BYTES
  )
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_LIMIT',
      'Chunked graph exceeds the comparison byte ceiling',
    );
  if (index.original?.mimeType !== 'application/json' || typeof index.original.sha256 !== 'string')
    throw new ServiceError('TECH_GRAPH_ARTIFACT_INVALID', 'Chunked graph metadata is malformed');
  const buffers: Buffer[] = [];
  let offset = 0;
  for (const [chunkIndex, candidate] of index.chunks.entries()) {
    signal?.throwIfAborted();
    if (candidate === null || typeof candidate !== 'object')
      throw new ServiceError('TECH_GRAPH_ARTIFACT_INVALID', 'Chunked graph entry is malformed');
    const chunk = candidate as {
      index?: unknown;
      offset?: unknown;
      length?: unknown;
      uri?: unknown;
      sha256?: unknown;
    };
    if (
      chunk.index !== chunkIndex ||
      chunk.offset !== offset ||
      typeof chunk.length !== 'number' ||
      !Number.isSafeInteger(chunk.length) ||
      chunk.length <= 0 ||
      typeof chunk.uri !== 'string' ||
      typeof chunk.sha256 !== 'string'
    )
      throw new ServiceError('TECH_GRAPH_ARTIFACT_INVALID', 'Chunked graph entry is malformed');
    const content = await engine.artifacts.read(workspace, chunk.uri, undefined, signal);
    if (content.bytes.length !== chunk.length || sha256Bytes(content.bytes) !== chunk.sha256)
      throw new ServiceError(
        'TECH_GRAPH_ARTIFACT_INVALID',
        'Chunked graph content hash does not match',
      );
    buffers.push(content.bytes);
    offset += content.bytes.length;
  }
  const reconstructed = Buffer.concat(buffers, size);
  if (offset !== size || sha256Bytes(reconstructed) !== index.original.sha256)
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_INVALID',
      'Chunked graph does not reconstruct its declared content',
    );
  return reconstructed;
}

function parseGraphArtifact(bytes: Buffer): TechnologyGraphSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(
      'TECH_GRAPH_ARTIFACT_INVALID',
      'Technology graph snapshot is not valid JSON',
    );
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  const report =
    record !== undefined &&
    'report' in record &&
    record.report !== null &&
    typeof record.report === 'object'
      ? record.report
      : undefined;
  const candidate =
    record !== undefined && 'graph' in record
      ? record.graph
      : report !== undefined && 'graph' in report
        ? report.graph
        : parsed;
  return validateGraph(candidate);
}

function renderWrites(
  prefix: string,
  render: TechnologyRenderBundle,
  provenance: ArtifactProvenance,
  label: string,
): ArtifactWrite[] {
  return [
    {
      name: `${prefix}.json`,
      mimeType: 'application/json',
      content: render.json,
      provenance,
      description: `Authoritative ${label} technology data`,
    },
    {
      name: `${prefix}.svg`,
      mimeType: 'image/svg+xml',
      content: render.svg,
      provenance,
      description: `Source-linked ${label} technology diagram`,
    },
    {
      name: `${prefix}.png`,
      mimeType: 'image/png',
      content: render.png,
      provenance,
      description: `${label} technology image`,
    },
    ...(render.html === undefined
      ? []
      : [
          {
            name: `${prefix}.html`,
            mimeType: 'text/html',
            content: render.html,
            provenance,
            description: `Static ${label} technology report`,
          },
        ]),
  ];
}

export class TechnologyTreeViewer {
  readonly #state: SharedTechnologyState;

  public constructor(private readonly engine: CoreEngine) {
    this.#state = sharedState(engine);
  }

  public async scan(
    workspaceId: string,
    options: { refresh?: boolean; principal?: string; signal?: AbortSignal } = {},
  ): Promise<TechnologyGraphSnapshot> {
    options.signal?.throwIfAborted();
    const workspace = this.engine.resolver.get(workspaceId, options.principal);
    const generation = this.engine.generation(workspaceId);
    const cached = this.#state.current.get(workspaceId);
    if (options.refresh !== true && cached?.generation === generation) return cached.graph;
    const snapshot = await this.engine.scan(workspaceId, {}, options.principal, options.signal);
    const preliminary = buildTechnologyGraph(snapshot, {
      workspaceIdentity: workspace.workspaceIdentity,
      cache: this.#state.fragments,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const patterns = technologyAssetPatterns(preliminary);
    const assetFiles =
      patterns.length === 0
        ? []
        : await this.engine.scanner.scan(workspace, {
            patterns,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
    const graph = buildTechnologyGraph(snapshot, {
      workspaceIdentity: workspace.workspaceIdentity,
      cache: this.#state.fragments,
      assetFiles,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.#state.current.set(workspaceId, { generation, snapshot, assetFiles, graph });
    rememberGraph(this.#state, graph);
    return graph;
  }

  public async analyze(input: TechnologyAnalysisInput): Promise<TechnologyAnalysisResult> {
    const graph = await this.scan(input.workspaceId, {
      refresh: input.refresh ?? input.mode === 'scan',
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    let report: unknown;
    switch (input.mode) {
      case 'scan':
        report = { ...(technologyScanReport(graph) as Record<string, unknown>), graph };
        break;
      case 'folders':
        report = discoverTechnologyFolders(graph, input.folderId);
        break;
      case 'trace':
        if (input.technologyId === undefined)
          throw new ServiceError('TECHNOLOGY_REQUIRED', 'Technology trace requires technologyId');
        report = traceTechnology(graph, {
          technologyId: input.technologyId,
          direction: input.direction ?? 'both',
          maxDepth: input.maxDepth ?? 32,
          maxNodes: input.maxNodes ?? 2_000,
          includeSubTechnologies: input.includeSubTechnologies ?? true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        break;
      case 'explain':
        if (input.technologyId === undefined)
          throw new ServiceError(
            'TECHNOLOGY_REQUIRED',
            'Technology explanation requires technologyId',
          );
        report = explainTechnology(graph, input.technologyId, input.signal);
        break;
      case 'unlocks':
        report = inspectTechnologyUnlocks(graph, {
          ...(input.technologyId === undefined ? {} : { technologyId: input.technologyId }),
          ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
          ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
        });
        break;
      case 'bonus_coverage':
        report = technologyBonusCoverage(graph, {
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.technologyId === undefined ? {} : { technologyId: input.technologyId }),
        });
        break;
      case 'lint':
        report = lintTechnologyGraph(graph, {
          ...(input.classifications === undefined
            ? {}
            : { classifications: input.classifications }),
          ...(input.codes === undefined ? {} : { codes: input.codes }),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          ...(input.technologyId === undefined ? {} : { technologyId: input.technologyId }),
        });
        break;
      case 'impact':
        if (input.impact === undefined)
          throw new ServiceError(
            'TECH_IMPACT_REQUIRED',
            'Technology impact analysis requires a subject',
          );
        report = analyzeTechnologyImpact(graph, input.impact);
        break;
    }
    const reportJson = `${canonicalJson({
      schemaVersion: 'technology-analysis.v1',
      workspaceId: graph.workspaceId,
      workspaceIdentity: graph.workspaceIdentity,
      graphRevision: graph.revision,
      graphHash: graphHash(graph),
      complete: graph.complete,
      analysisBoundary: graph.analysisBoundary,
      mode: input.mode,
      report,
    })}\n`;
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      `${safeSlug(`technology-${input.mode}`)}-${graph.revision.slice(0, 12)}.json`,
      'application/json',
      reportJson,
      technologyProvenance(graph, `technology-${input.mode}`, { mode: input.mode }),
      `Authoritative Technology Tree Viewer ${input.mode.replaceAll('_', ' ')} report`,
      input.signal,
    );
    return { graph, report, reportJson, artifacts: [artifact] };
  }

  public async renderAndStore(
    input: TechnologyRenderServiceInput,
  ): Promise<TechnologyRenderServiceResult> {
    const graph = await this.scan(input.workspaceId, {
      ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const budget = new RenderBudget();
    const renderOptions: TechnologyRenderOptions = {
      view: input.view,
      maxNodes: input.maxNodes ?? 1_000,
      includeHtml: input.includeHtml ?? false,
      budget,
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      ...(input.technologyId === undefined ? {} : { technologyId: input.technologyId }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const render = await renderTechnologyGraph(graph, renderOptions);
    const focused: TechnologyRenderBundle[] = [];
    const focusedFolders =
      input.view === 'dependencies' && input.folderId === undefined
        ? graph.folders
            .filter((folder) => graph.placements.some(({ folderId }) => folderId === folder.id))
            .slice(0, FOCUSED_RENDER_LIMIT)
        : [];
    for (const folder of focusedFolders) {
      input.signal?.throwIfAborted();
      focused.push(
        await renderTechnologyGraph(graph, {
          view: 'folder',
          folderId: folder.id,
          maxNodes: 1_000,
          includeHtml: false,
          budget,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
    }
    const prefix = safeSlug(`technology-${input.view}-${graph.revision.slice(0, 12)}`);
    const provenance = technologyProvenance(graph, 'technology-render', {
      view: input.view,
      selectedNodeCount: render.selectedIds.length,
      omittedNodeCount: render.omittedNodeCount,
    });
    const writes: ArtifactWrite[] = [
      ...renderWrites(prefix, render, provenance, input.view),
      ...focused.flatMap((bundle, index) =>
        renderWrites(
          `${prefix}-folder-${String(index + 1).padStart(2, '0')}`,
          bundle,
          provenance,
          `focused folder ${index + 1}`,
        ),
      ),
    ];
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    const dataArtifacts = await this.engine.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (stored) => Promise.resolve([...stored]),
      input.signal,
    );
    const manifestJson = `${canonicalJson({
      schemaVersion: 'technology-render-manifest.v1',
      workspaceId: graph.workspaceId,
      workspaceIdentity: graph.workspaceIdentity,
      graphRevision: graph.revision,
      graphHash: graphHash(graph),
      analysisBoundary: graph.analysisBoundary,
      view: input.view,
      overview: {
        selectedIds: render.selectedIds,
        omittedNodeCount: render.omittedNodeCount,
        sourceAccurate: render.sourceAccurate,
        generatedAnalysisLayout: render.generatedAnalysisLayout,
        hashes: render.hashes,
      },
      focusedFolders: focused.map((bundle, index) => ({
        index: index + 1,
        folderId: focusedFolders[index]?.id,
        selectedIds: bundle.selectedIds,
        omittedNodeCount: bundle.omittedNodeCount,
        hashes: bundle.hashes,
      })),
      focusedFolderCoverage: {
        total: graph.folders.length,
        rendered: focused.length,
        remainingFolderIds: graph.folders.slice(focused.length).map(({ id }) => id),
      },
      resources: dataArtifacts.map(({ name, uri, mimeType, size }) => ({
        name,
        uri,
        mimeType,
        size,
      })),
    })}\n`;
    const manifest = await this.engine.artifacts.putChunked(
      workspace,
      `${prefix}-manifest.json`,
      'application/json',
      manifestJson,
      provenance,
      `Technology ${input.view} render manifest`,
      input.signal,
    );
    return { graph, render, focused, manifestJson, artifacts: [manifest, ...dataArtifacts] };
  }

  #proposedGraph(
    workspaceId: string,
    sources: readonly TechnologyProposedSource[],
    principal?: string,
    signal?: AbortSignal,
  ): TechnologyGraphSnapshot {
    assertProposedBounds(sources);
    const cached = this.#state.current.get(workspaceId);
    if (cached === undefined)
      throw new ServiceError(
        'TECH_BASELINE_MISSING',
        'Scan the workspace before comparing proposed source',
      );
    const paths = sources.map(({ relativePath }) => validRelativeSourcePath(relativePath));
    if (new Set(paths.map((value) => value.toLowerCase())).size !== paths.length)
      throw new ServiceError(
        'TECH_PROPOSED_PATH_DUPLICATE',
        'Proposed source paths must be unique',
      );
    const files = cached.snapshot.files.map((file) => ({
      ...file,
      bytes: Buffer.from(file.bytes),
    }));
    const workspace = this.engine.resolver.get(workspaceId, principal);
    for (const [sourceIndex, source] of sources.entries()) {
      signal?.throwIfAborted();
      const relativePath = paths[sourceIndex]!;
      const candidates = files
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => file.relativePath.toLowerCase() === relativePath.toLowerCase())
        .sort(
          (left, right) =>
            right.file.loadOrder - left.file.loadOrder ||
            compareCodeUnits(left.file.displayPath, right.file.displayPath),
        );
      const active = candidates.find(({ file }) => file.shadowedBy === undefined) ?? candidates[0];
      const mod = candidates.find(({ file }) => file.rootKind === 'mod');
      if (
        source.expectedSourceHash !== undefined &&
        active?.file.sha256 !== source.expectedSourceHash
      )
        throw new ServiceError(
          'TECH_PROPOSED_SOURCE_STALE',
          'Proposed source baseline hash is stale',
          {
            relativePath,
            expectedSourceHash: source.expectedSourceHash,
            actualSourceHash: active?.file.sha256 ?? null,
          },
        );
      if (source.source === null) {
        if (mod === undefined)
          throw new ServiceError(
            'TECH_PROPOSED_SOURCE_MISSING',
            'Cannot delete a source absent from the mod root',
          );
        files.splice(mod.index, 1);
        continue;
      }
      const bytes = Buffer.from(source.source, 'utf8');
      if (bytes.length > SOURCE_MAX_BYTES)
        throw new ServiceError(
          'SOURCE_FILE_LIMIT',
          'Proposed technology source exceeds the parser byte ceiling',
        );
      if (mod !== undefined) {
        Object.assign(mod.file, {
          bytes,
          size: bytes.length,
          sha256: sha256Bytes(bytes),
          modifiedMs: 0,
        });
      } else {
        const modRoot = [...workspace.roots]
          .filter(({ kind }) => kind === 'mod')
          .sort((a, b) => b.loadOrder - a.loadOrder)[0];
        if (modRoot === undefined)
          throw new ServiceError(
            'TECH_PROPOSED_ROOT_MISSING',
            'Workspace has no mod root for a proposed source',
          );
        files.push({
          absolutePath: path.join(modRoot.path, relativePath),
          displayPath: `mod:${relativePath}`,
          relativePath,
          rootKind: 'mod',
          loadOrder: modRoot.loadOrder,
          size: bytes.length,
          modifiedMs: 0,
          sha256: sha256Bytes(bytes),
          bytes,
        });
      }
    }
    recomputeShadowing(files);
    files.sort(
      (left, right) =>
        left.loadOrder - right.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
    );
    const index = this.engine.indexFiles(files);
    const snapshot: ScanSnapshot = {
      workspaceId,
      revision: snapshotRevision(files),
      files,
      index,
      complete: index.complete,
      skippedSourceCount: index.skippedSourceCount,
      skippedSources: index.skippedSources,
      diagnostics: index.diagnostics,
    };
    return buildTechnologyGraph(snapshot, {
      workspaceIdentity: workspace.workspaceIdentity,
      cache: this.#state.fragments,
      assetFiles: cached.assetFiles,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #resolveReference(
    workspaceId: string,
    reference: TechnologyGraphReference | undefined,
    current: TechnologyGraphSnapshot,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<TechnologyGraphSnapshot> {
    if (reference?.artifactUri !== undefined) {
      const graph = parseGraphArtifact(
        await readLogicalArtifact(
          this.engine,
          workspaceId,
          reference.artifactUri,
          principal,
          signal,
        ),
      );
      if (
        graph.workspaceId !== workspaceId ||
        graph.workspaceIdentity !== current.workspaceIdentity
      )
        throw new ServiceError(
          'TECH_GRAPH_WORKSPACE_MISMATCH',
          'Technology graph belongs to a different workspace',
        );
      return graph;
    }
    if (reference?.revision !== undefined) {
      const graph = this.#state.history.get(workspaceId)?.get(reference.revision);
      if (graph === undefined)
        throw new ServiceError(
          'TECH_REVISION_NOT_CACHED',
          'Requested technology revision is not cached',
        );
      return graph;
    }
    return current;
  }

  public async compareAndStore(input: TechnologyCompareInput): Promise<TechnologyCompareResult> {
    input.signal?.throwIfAborted();
    if (input.proposedSources !== undefined) assertProposedBounds(input.proposedSources);
    const current = await this.scan(input.workspaceId, {
      refresh: input.refresh ?? input.proposedSources !== undefined,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    let before = await this.#resolveReference(
      input.workspaceId,
      input.before,
      current,
      input.principal,
      input.signal,
    );
    let after =
      input.proposedSources === undefined
        ? await this.#resolveReference(
            input.workspaceId,
            input.after,
            current,
            input.principal,
            input.signal,
          )
        : this.#proposedGraph(
            input.workspaceId,
            input.proposedSources,
            input.principal,
            input.signal,
          );
    if (
      input.before === undefined &&
      input.after === undefined &&
      input.proposedSources === undefined
    ) {
      const previous = [...(this.#state.history.get(input.workspaceId)?.values() ?? [])]
        .filter(({ revision }) => revision !== current.revision)
        .at(-1);
      if (previous === undefined)
        throw new ServiceError(
          'TECH_COMPARISON_BASELINE_REQUIRED',
          'Provide a cached revision, graph artifact, or proposed source overlay',
        );
      before = previous;
      after = current;
    }
    const comparison = compareTechnologyGraphs(before, after, input.signal);
    const render =
      input.render === false
        ? undefined
        : await renderTechnologyGraph(after, {
            view: 'comparison',
            comparison,
            maxNodes: input.maxRenderNodes ?? 500,
            includeHtml: false,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
    const comparisonJson = `${canonicalJson({
      schemaVersion: 'technology-comparison.v1',
      workspaceId: current.workspaceId,
      workspaceIdentity: current.workspaceIdentity,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      beforeComplete: before.complete,
      afterComplete: after.complete,
      beforeSourceHashes: before.sourceHashes,
      afterSourceHashes: after.sourceHashes,
      analysisBoundary: after.analysisBoundary,
      comparison,
    })}\n`;
    const prefix = safeSlug(
      `technology-compare-${before.revision.slice(0, 8)}-${after.revision.slice(0, 8)}`,
    );
    const provenance = technologyProvenance(after, 'technology-comparison', {
      beforeRevision: before.revision,
      afterRevision: after.revision,
      regressionCount: comparison.regressions.length,
    });
    const writes: ArtifactWrite[] = [
      {
        name: `${prefix}.json`,
        mimeType: 'application/json',
        content: comparisonJson,
        provenance,
        description: 'Authoritative technology structural comparison',
      },
      ...(render === undefined
        ? []
        : renderWrites(prefix, render, provenance, 'comparison').filter(
            ({ mimeType }) => mimeType !== 'application/json',
          )),
    ];
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    const artifacts = await this.engine.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (stored) => Promise.resolve([...stored]),
      input.signal,
    );
    return {
      before,
      after,
      comparison,
      comparisonJson,
      ...(render === undefined ? {} : { render }),
      artifacts,
    };
  }
}
