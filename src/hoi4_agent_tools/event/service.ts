import path from 'node:path';
import { canonicalJson, compareCodeUnits, hashCanonical, sha256Bytes } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import type { ScannedFile } from '../core/scanner.js';
import {
  boundedSourceHashEvidence,
  publicArtifactLink,
  type ArtifactProvenance,
  type ArtifactWrite,
  type StoredArtifact,
} from '../core/artifacts.js';
import { ServiceError } from '../core/result.js';
import { RenderBudget } from '../core/render-budget.js';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { isPortablePathSegment } from '../core/workspace.js';
import { PACKAGE_VERSION } from '../version.js';
import { buildEventGraph } from './graph.js';
import {
  EVENT_FRAGMENT_CACHE_MAX_ENTRIES,
  EVENT_FRAGMENT_CACHE_MAX_SOURCE_BYTES,
  EVENT_PROPOSED_SOURCE_MAX_BYTES,
  EVENT_PROPOSED_SOURCE_MAX_FILES,
} from './limits.js';
import type {
  EventGraphEdge,
  EventGraphNode,
  EventGraphSnapshot,
  EventIssue,
  EventSemanticFragmentCacheLike,
  EventSourceFragment,
  EventStateAccess,
} from './model.js';
import {
  analyzeEventImpact,
  discoverEventRoots,
  explainEventPath,
  inspectEventStateFlow,
  lintEventGraph,
  traceSelectedEvents,
  type EventFeatureManifest,
  type EventImpactSubject,
  type EventSelector,
} from './queries.js';
import { compareEventGraphs, eventGraphHash, type EventGraphComparison } from './compare.js';
import { eventFlowEdges } from './algorithms.js';
import { validateEventGraphArtifact } from './artifact-validation.js';
import {
  renderEventGraph,
  type EventRenderBundle,
  type EventRenderOptions,
  type EventRenderView,
} from './render.js';

export type EventInspectMode =
  'scan' | 'roots' | 'trace' | 'explain_path' | 'state_flow' | 'lint' | 'impact';

export interface EventInspectInput {
  workspaceId: string;
  mode: EventInspectMode;
  selector?: EventSelector;
  from?: EventSelector;
  to?: EventSelector;
  direction?: 'upstream' | 'downstream' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  expandHelpers?: boolean;
  stateSubject?: { kind: EventStateAccess['kind']; name: string };
  impactSubject?: EventImpactSubject;
  refresh?: boolean;
  principal?: string;
  signal?: AbortSignal;
}

export interface EventInspectResult {
  graph: EventGraphSnapshot;
  graphHash: string;
  mode: EventInspectMode;
  report: unknown;
  reportJson: string;
  artifacts: StoredArtifact[];
}

export interface EventRenderServiceInput {
  workspaceId: string;
  view: EventRenderView;
  selector?: EventSelector;
  direction?: 'upstream' | 'downstream' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  expandHelpers?: boolean;
  includeHtml?: boolean;
  refresh?: boolean;
  principal?: string;
  signal?: AbortSignal;
}

export interface EventRenderServiceResult {
  graph: EventGraphSnapshot;
  graphHash: string;
  render: EventRenderBundle;
  branches: EventRenderBundle[];
  manifestJson: string;
  artifacts: StoredArtifact[];
}

export interface EventProposedSource {
  relativePath: string;
  source: string | null;
  expectedSourceHash?: string;
}

export interface EventGraphReference {
  revision?: string;
  artifactUri?: string;
}

export interface EventCompareInput {
  workspaceId: string;
  before?: EventGraphReference;
  after?: EventGraphReference;
  proposedSources?: EventProposedSource[];
  render?: boolean;
  maxRenderNodes?: number;
  refresh?: boolean;
  principal?: string;
  signal?: AbortSignal;
}

export interface EventCompareResult {
  before: EventGraphSnapshot;
  after: EventGraphSnapshot;
  refresh: boolean;
  comparison: EventGraphComparison;
  comparisonJson: string;
  render?: EventRenderBundle;
  artifacts: StoredArtifact[];
}

interface CachedGraph {
  generation: number;
  snapshot: ScanSnapshot;
  graph: EventGraphSnapshot;
}

class BoundedEventFragmentCache implements EventSemanticFragmentCacheLike {
  readonly #entries = new Map<string, { fragment: EventSourceFragment; sourceBytes: number }>();
  #sourceBytes = 0;

  public get(key: string): EventSourceFragment | undefined {
    const cached = this.#entries.get(key);
    if (cached === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, cached);
    return cached.fragment;
  }

  public set(key: string, fragment: EventSourceFragment, sourceBytes: number): void {
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#sourceBytes -= previous.sourceBytes;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { fragment, sourceBytes });
    this.#sourceBytes += sourceBytes;
    while (
      this.#entries.size > EVENT_FRAGMENT_CACHE_MAX_ENTRIES ||
      this.#sourceBytes > EVENT_FRAGMENT_CACHE_MAX_SOURCE_BYTES
    ) {
      const oldest = this.#entries.entries().next().value as
        [string, { fragment: EventSourceFragment; sourceBytes: number }] | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#sourceBytes -= oldest[1].sourceBytes;
    }
  }
}

interface SharedEventServiceState {
  current: Map<string, CachedGraph>;
  history: Map<string, Map<string, EventGraphSnapshot>>;
  fragments: BoundedEventFragmentCache;
}

function eventGraphCacheKey(workspaceId: string, projectHelpers: boolean): string {
  return `${workspaceId}\0${projectHelpers ? 'expanded' : 'structural'}`;
}

const serviceState = new WeakMap<CoreEngine, SharedEventServiceState>();
const EVENT_GRAPH_ARTIFACT_MAX_BYTES = 67_108_864;
const EVENT_GRAPH_ARTIFACT_MAX_CHUNKS = 1_024;
const EVENT_SCAN_FULL_GRAPH_RECORD_LIMIT = 100_000;
const EVENT_SCAN_SUMMARY_SAMPLE_LIMIT = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const graphHashCache = new WeakMap<EventGraphSnapshot, string>();

function groupedCounts<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const group = key(value);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => compareCodeUnits(left, right)));
}

export function eventScanReport(
  graph: EventGraphSnapshot,
  fullGraphRecordLimit = EVENT_SCAN_FULL_GRAPH_RECORD_LIMIT,
): unknown {
  const recordCount =
    graph.nodes.length +
    graph.edges.length +
    graph.stateAccesses.length +
    graph.stateLinks.length +
    graph.issues.length +
    graph.diagnostics.length +
    graph.unresolved.length;
  if (recordCount <= fullGraphRecordLimit) return { graph };
  const sourceEvidence = boundedSourceHashEvidence(graph.sourceHashes);
  return {
    graphSummary: {
      schemaVersion: graph.schemaVersion,
      parserVersion: graph.parserVersion,
      workspaceId: graph.workspaceId,
      workspaceIdentity: graph.workspaceIdentity,
      revision: graph.revision,
      complete: graph.complete,
      statistics: graph.statistics,
      filesScanned: graph.filesScanned.length,
      skippedSourceCount: graph.skippedSourceCount,
      sourceHashInventory: sourceEvidence.inventory,
      recordCounts: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        stateAccesses: graph.stateAccesses.length,
        stateLinks: graph.stateLinks.length,
        issues: graph.issues.length,
        diagnostics: graph.diagnostics.length,
        unresolved: graph.unresolved.length,
      },
      nodeKinds: groupedCounts(graph.nodes, ({ kind }) => kind),
      edgeReasons: groupedCounts(graph.edges, ({ reason }) => reason),
      issueCodes: groupedCounts(graph.issues, ({ code }) => code),
      issueSeverities: groupedCounts(graph.issues, ({ severity }) => severity),
      diagnosticCodes: groupedCounts(graph.diagnostics, ({ code }) => code),
      diagnosticSeverities: groupedCounts(graph.diagnostics, ({ severity }) => severity),
      unresolvedKinds: groupedCounts(graph.unresolved, ({ kind }) => kind),
    },
    issueSamples: graph.issues.slice(0, EVENT_SCAN_SUMMARY_SAMPLE_LIMIT),
    diagnosticSamples: graph.diagnostics.slice(0, EVENT_SCAN_SUMMARY_SAMPLE_LIMIT),
    unresolvedSamples: graph.unresolved.slice(0, EVENT_SCAN_SUMMARY_SAMPLE_LIMIT),
    artifactProjection: {
      mode: 'large-scan-summary',
      fullGraphRecordCount: recordCount,
      fullGraphRecordLimit,
      detailQueries: ['roots', 'trace', 'explain_path', 'state_flow', 'impact'],
    },
  };
}

function cachedEventGraphHash(graph: EventGraphSnapshot, signal?: AbortSignal): string {
  signal?.throwIfAborted();
  const cached = graphHashCache.get(graph);
  if (cached !== undefined) return cached;
  const computed = eventGraphHash(graph, signal);
  graphHashCache.set(graph, computed);
  return computed;
}

function sharedState(engine: CoreEngine): SharedEventServiceState {
  let state = serviceState.get(engine);
  if (state === undefined) {
    state = {
      current: new Map(),
      history: new Map(),
      fragments: new BoundedEventFragmentCache(),
    };
    serviceState.set(engine, state);
  }
  return state;
}

function engineGeneration(engine: CoreEngine, workspaceId: string): number {
  return engine.generation(workspaceId);
}

function rememberGraph(
  state: SharedEventServiceState,
  workspaceId: string,
  graph: EventGraphSnapshot,
): void {
  const history = state.history.get(workspaceId) ?? new Map<string, EventGraphSnapshot>();
  history.delete(graph.revision);
  history.set(graph.revision, graph);
  while (history.size > 8) {
    const oldest = history.keys().next().value;
    if (oldest === undefined) break;
    history.delete(oldest);
  }
  state.history.set(workspaceId, history);
}

function eventIssueDiagnostic(issue: EventIssue): Diagnostic {
  return {
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
  };
}

export function eventDiagnostics(graph: EventGraphSnapshot): Diagnostic[] {
  const existing = new Set(
    graph.diagnostics.map(
      ({ code, location }) => `${code}:${location?.path ?? ''}:${location?.start.offset ?? -1}`,
    ),
  );
  return [
    ...graph.diagnostics,
    ...graph.issues
      .map(eventIssueDiagnostic)
      .filter(
        ({ code, location }) =>
          !existing.has(`${code}:${location?.path ?? ''}:${location?.start.offset ?? -1}`),
      ),
  ];
}

function safeSlug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48) || 'event-chain'
  );
}

function eventProvenance(
  graph: EventGraphSnapshot,
  kind: string,
  metadata: Record<string, unknown> = {},
  signal?: AbortSignal,
): ArtifactProvenance {
  const sourceEvidence = boundedSourceHashEvidence(graph.sourceHashes);
  return {
    kind,
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'event-chain-viewer.v1',
    sourceHashes: sourceEvidence.sourceHashes,
    renderProfile: {
      graphRevision: graph.revision,
      graphHash: cachedEventGraphHash(graph, signal),
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

function validRelativeSourcePath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new ServiceError(
      'EVENT_PROPOSED_PATH_INVALID',
      'Proposed source path must be workspace-relative',
    );
  }
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\.\//u, '');
  const segments = normalized.split('/');
  if (
    normalized === '.' ||
    segments.some((segment) => segment === '..' || !isPortablePathSegment(segment)) ||
    normalized.startsWith('.hoi4-agent/')
  ) {
    throw new ServiceError(
      'EVENT_PROPOSED_PATH_INVALID',
      'Proposed source path is not portable or escapes the workspace',
    );
  }
  if (!/\.(?:txt|yml|yaml)$/iu.test(normalized)) {
    throw new ServiceError(
      'EVENT_PROPOSED_SOURCE_UNSUPPORTED',
      'Event comparison overlays support Clausewitz and localisation text only',
    );
  }
  return normalized;
}

function assertProposedSourceBounds(sources: readonly EventProposedSource[]): void {
  if (sources.length > EVENT_PROPOSED_SOURCE_MAX_FILES) {
    throw new ServiceError(
      'EVENT_PROPOSED_SOURCE_COUNT_LIMIT',
      'Proposed event comparison exceeds the fixed source-file ceiling',
      { count: sources.length, maximumFiles: EVENT_PROPOSED_SOURCE_MAX_FILES },
    );
  }
  const sourceBytes = sources.reduce(
    (total, { source }) => total + (source === null ? 0 : Buffer.byteLength(source, 'utf8')),
    0,
  );
  if (sourceBytes > EVENT_PROPOSED_SOURCE_MAX_BYTES) {
    throw new ServiceError(
      'EVENT_PROPOSED_SOURCE_TOTAL_LIMIT',
      'Proposed event comparison exceeds the fixed total source-byte ceiling',
      { sourceBytes, maximumBytes: EVENT_PROPOSED_SOURCE_MAX_BYTES },
    );
  }
}

function recomputeShadowing(files: ScannedFile[]): void {
  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    delete file.shadowedBy;
    const key = file.relativePath.replaceAll('\\', '/').toLowerCase();
    const values = groups.get(key) ?? [];
    values.push(file);
    groups.set(key, values);
  }
  for (const values of groups.values()) {
    values.sort(
      (left, right) =>
        right.loadOrder - left.loadOrder || compareCodeUnits(left.displayPath, right.displayPath),
    );
    const active = values[0];
    if (active === undefined) continue;
    for (const shadowed of values.slice(1)) shadowed.shadowedBy = active.displayPath;
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

async function readLogicalArtifact(
  engine: CoreEngine,
  workspaceId: string,
  uri: string,
  principal?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const workspace = engine.resolver.get(workspaceId, principal);
  const probe = await engine.artifacts.read(workspace, uri, { offset: 0, length: 1 }, signal);
  if (probe.mimeType !== 'application/json') {
    throw new ServiceError('EVENT_GRAPH_ARTIFACT_INVALID', 'Event graph snapshot must be JSON');
  }
  if (probe.totalSize > EVENT_GRAPH_ARTIFACT_MAX_BYTES) {
    throw new ServiceError(
      'EVENT_GRAPH_ARTIFACT_LIMIT',
      'Event graph snapshot exceeds the fixed comparison byte ceiling',
      { size: probe.totalSize, maximumBytes: EVENT_GRAPH_ARTIFACT_MAX_BYTES },
    );
  }
  const read = await engine.artifacts.read(workspace, uri, undefined, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(
      'EVENT_GRAPH_ARTIFACT_INVALID',
      'Event graph artifact is not valid JSON',
    );
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { type?: unknown }).type === 'hoi4-agent.chunked-artifact'
  ) {
    const index = parsed as {
      schemaVersion?: unknown;
      chunks?: unknown;
      original?: {
        name?: unknown;
        mimeType?: unknown;
        size?: unknown;
        sha256?: unknown;
      };
    };
    if (index.schemaVersion !== 1) {
      throw new ServiceError(
        'EVENT_GRAPH_ARTIFACT_INVALID',
        'Chunked graph index uses an unsupported schema version',
      );
    }
    const chunks = index.chunks;
    if (!Array.isArray(chunks))
      throw new ServiceError('EVENT_GRAPH_ARTIFACT_INVALID', 'Chunked graph index is malformed');
    if (chunks.length === 0 || chunks.length > EVENT_GRAPH_ARTIFACT_MAX_CHUNKS) {
      throw new ServiceError(
        'EVENT_GRAPH_ARTIFACT_LIMIT',
        'Chunked graph index exceeds the fixed chunk-count ceiling',
        { count: chunks.length, maximumChunks: EVENT_GRAPH_ARTIFACT_MAX_CHUNKS },
      );
    }
    const original = index.original;
    const originalSize = original?.size;
    if (
      typeof originalSize !== 'number' ||
      !Number.isSafeInteger(originalSize) ||
      originalSize < 0 ||
      originalSize > EVENT_GRAPH_ARTIFACT_MAX_BYTES
    ) {
      throw new ServiceError(
        'EVENT_GRAPH_ARTIFACT_LIMIT',
        'Chunked event graph exceeds the fixed comparison byte ceiling',
        { size: originalSize, maximumBytes: EVENT_GRAPH_ARTIFACT_MAX_BYTES },
      );
    }
    if (
      original?.mimeType !== 'application/json' ||
      typeof original.name !== 'string' ||
      original.name.length === 0 ||
      original.name.length > 255 ||
      typeof original.sha256 !== 'string' ||
      !SHA256_PATTERN.test(original.sha256)
    ) {
      throw new ServiceError(
        'EVENT_GRAPH_ARTIFACT_INVALID',
        'Chunked graph index has invalid original-content metadata',
      );
    }
    const buffers: Buffer[] = [];
    const chunkUris = new Set<string>();
    let reconstructedSize = 0;
    for (const [chunkIndex, candidate] of chunks.entries()) {
      signal?.throwIfAborted();
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new ServiceError('EVENT_GRAPH_ARTIFACT_INVALID', 'Chunked graph entry is malformed');
      }
      const chunk = candidate as {
        index?: unknown;
        offset?: unknown;
        length?: unknown;
        size?: unknown;
        uri?: unknown;
        name?: unknown;
        mimeType?: unknown;
        sha256?: unknown;
      };
      const validLength =
        typeof chunk.length === 'number' && Number.isSafeInteger(chunk.length) && chunk.length > 0;
      if (
        chunk.index !== chunkIndex ||
        chunk.offset !== reconstructedSize ||
        !validLength ||
        chunk.size !== chunk.length ||
        typeof chunk.uri !== 'string' ||
        chunk.uri.length > 8_192 ||
        typeof chunk.name !== 'string' ||
        chunk.name.length === 0 ||
        chunk.name.length > 255 ||
        chunk.mimeType !== 'application/octet-stream' ||
        typeof chunk.sha256 !== 'string' ||
        !SHA256_PATTERN.test(chunk.sha256) ||
        chunkUris.has(chunk.uri)
      ) {
        throw new ServiceError('EVENT_GRAPH_ARTIFACT_INVALID', 'Chunked graph entry is malformed');
      }
      const chunkLength = chunk.length as number;
      if (reconstructedSize + chunkLength > originalSize) {
        throw new ServiceError(
          'EVENT_GRAPH_ARTIFACT_LIMIT',
          'Chunked graph entries exceed the declared original size',
        );
      }
      chunkUris.add(chunk.uri);
      const chunkProbe = await engine.artifacts.read(
        workspace,
        chunk.uri,
        { offset: 0, length: 1 },
        signal,
      );
      if (
        chunkProbe.mimeType !== 'application/octet-stream' ||
        chunkProbe.totalSize !== chunkLength
      ) {
        throw new ServiceError(
          'EVENT_GRAPH_ARTIFACT_INVALID',
          'Chunked graph content does not match its bounded index entry',
        );
      }
      const chunkRead = await engine.artifacts.read(workspace, chunk.uri, undefined, signal);
      if (sha256Bytes(chunkRead.bytes) !== chunk.sha256) {
        throw new ServiceError(
          'EVENT_GRAPH_ARTIFACT_INVALID',
          'Chunked graph content hash does not match its index entry',
        );
      }
      buffers.push(chunkRead.bytes);
      reconstructedSize += chunkRead.bytes.length;
    }
    if (reconstructedSize !== originalSize) {
      throw new ServiceError(
        'EVENT_GRAPH_ARTIFACT_INVALID',
        'Chunked graph entries do not cover the declared original size',
      );
    }
    const reconstructed = Buffer.concat(buffers, originalSize);
    if (reconstructed.length !== originalSize || sha256Bytes(reconstructed) !== original.sha256) {
      throw new ServiceError(
        'EVENT_GRAPH_ARTIFACT_INVALID',
        'Chunked event graph does not reconstruct the declared artifact',
      );
    }
    return reconstructed;
  }
  return read.bytes;
}

function parseGraphArtifact(bytes: Buffer, signal?: AbortSignal): EventGraphSnapshot {
  signal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(
      'EVENT_GRAPH_ARTIFACT_INVALID',
      'Event graph snapshot is not valid JSON',
    );
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  const report =
    record !== undefined && 'report' in record && record.report !== null
      ? record.report
      : undefined;
  const graphCandidate =
    record !== undefined && 'graph' in record
      ? record.graph
      : report !== undefined && typeof report === 'object' && 'graph' in report
        ? report.graph
        : parsed;
  return validateEventGraphArtifact(graphCandidate, signal);
}

function comparisonRenderProjection(
  before: EventGraphSnapshot,
  after: EventGraphSnapshot,
  comparison: EventGraphComparison,
  signal?: AbortSignal,
): { graph: EventGraphSnapshot; selectedNodeIds: string[] } {
  signal?.throwIfAborted();
  const addedNodes = new Set(comparison.addedNodeIds);
  const changedNodes = new Set(comparison.changedNodeIds);
  const removedNodes = new Set(comparison.removedNodeIds);
  const addedEdges = new Set(comparison.addedEdgeIds);
  const changedEdges = new Set(comparison.changedEdgeIds);
  const removedEdges = new Set(comparison.removedEdgeIds);
  const beforeNodes = new Map<string, EventGraphNode>();
  for (const [index, node] of before.nodes.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    beforeNodes.set(node.id, node);
  }
  const nodes = new Map<string, EventGraphNode>();
  for (const [index, node] of after.nodes.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const status = addedNodes.has(node.id)
      ? 'added'
      : changedNodes.has(node.id)
        ? 'changed'
        : undefined;
    nodes.set(node.id, {
      ...node,
      ...(status === undefined ? {} : { metadata: { ...node.metadata, comparisonStatus: status } }),
    });
  }
  for (const nodeId of removedNodes) {
    signal?.throwIfAborted();
    const node = beforeNodes.get(nodeId);
    if (node !== undefined) {
      nodes.set(nodeId, {
        ...node,
        metadata: { ...node.metadata, comparisonStatus: 'removed' },
      });
    }
  }
  const edges = new Map<string, EventGraphEdge>();
  for (const [index, edge] of after.edges.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const status = addedEdges.has(edge.id)
      ? 'added'
      : changedEdges.has(edge.id)
        ? 'changed'
        : undefined;
    edges.set(edge.id, {
      ...edge,
      ...(status === undefined ? {} : { metadata: { ...edge.metadata, comparisonStatus: status } }),
    });
  }
  const beforeEdges = new Map<string, EventGraphEdge>();
  for (const [index, edge] of before.edges.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    beforeEdges.set(edge.id, edge);
  }
  for (const edgeId of removedEdges) {
    signal?.throwIfAborted();
    const edge = beforeEdges.get(edgeId);
    if (edge === undefined) continue;
    edges.set(edge.id, {
      ...edge,
      metadata: { ...edge.metadata, comparisonStatus: 'removed' },
    });
    for (const nodeId of [edge.from, edge.to]) {
      if (nodes.has(nodeId)) continue;
      const node = beforeNodes.get(nodeId);
      if (node !== undefined) nodes.set(nodeId, node);
    }
  }
  const selectedNodeIds = new Set([
    ...comparison.addedNodeIds,
    ...comparison.removedNodeIds,
    ...comparison.changedNodeIds,
    ...comparison.newlyDisconnectedRootIds,
    ...comparison.newlyDisconnectedBranchIds,
    ...comparison.newlyDisconnectedTerminalIds,
  ]);
  for (const edgeId of [
    ...comparison.addedEdgeIds,
    ...comparison.removedEdgeIds,
    ...comparison.changedEdgeIds,
  ]) {
    signal?.throwIfAborted();
    const edge = edges.get(edgeId) ?? beforeEdges.get(edgeId);
    if (edge === undefined) continue;
    selectedNodeIds.add(edge.from);
    selectedNodeIds.add(edge.to);
  }
  const removedStateAccessIds = new Set(comparison.removedStateAccessIds);
  const stateAccesses = [...after.stateAccesses];
  for (const [index, access] of before.stateAccesses.entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    if (!removedStateAccessIds.has(access.id)) continue;
    stateAccesses.push({
      ...access,
      metadata: { ...access.metadata, comparisonStatus: 'removed' },
    });
  }
  signal?.throwIfAborted();
  return {
    graph: {
      ...after,
      revision: hashCanonical({
        kind: 'event-comparison-render',
        before: before.revision,
        after: after.revision,
      }),
      complete: before.complete && after.complete,
      sourceHashes: { ...before.sourceHashes, ...after.sourceHashes },
      filesScanned: [...new Set([...before.filesScanned, ...after.filesScanned])].sort(
        compareCodeUnits,
      ),
      nodes: [...nodes.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
      edges: [...edges.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
      stateAccesses: stateAccesses.sort((left, right) => compareCodeUnits(left.id, right.id)),
    },
    selectedNodeIds: [...selectedNodeIds].sort(compareCodeUnits),
  };
}

function comparisonEntityEvidence(
  before: EventGraphSnapshot,
  after: EventGraphSnapshot,
  comparison: EventGraphComparison,
  signal?: AbortSignal,
): {
  before: {
    nodes: EventGraphNode[];
    edges: EventGraphEdge[];
    stateAccesses: EventStateAccess[];
    stateLinks: EventGraphSnapshot['stateLinks'];
  };
  after: {
    nodes: EventGraphNode[];
    edges: EventGraphEdge[];
    stateAccesses: EventStateAccess[];
    stateLinks: EventGraphSnapshot['stateLinks'];
  };
} {
  const select = <T extends { id: string }>(
    values: readonly T[],
    ids: ReadonlySet<string>,
  ): T[] => {
    const selected: T[] = [];
    for (const [index, value] of values.entries()) {
      if ((index & 255) === 0) signal?.throwIfAborted();
      if (ids.has(value.id)) selected.push(value);
    }
    return selected;
  };
  const beforeNodeIds = new Set([...comparison.removedNodeIds, ...comparison.changedNodeIds]);
  const afterNodeIds = new Set([...comparison.addedNodeIds, ...comparison.changedNodeIds]);
  const beforeEdgeIds = new Set([...comparison.removedEdgeIds, ...comparison.changedEdgeIds]);
  const afterEdgeIds = new Set([...comparison.addedEdgeIds, ...comparison.changedEdgeIds]);
  const beforeStateAccessIds = new Set([
    ...comparison.removedStateAccessIds,
    ...comparison.changedStateAccessIds,
  ]);
  const afterStateAccessIds = new Set([
    ...comparison.addedStateAccessIds,
    ...comparison.changedStateAccessIds,
  ]);
  const beforeStateLinkIds = new Set([
    ...comparison.removedStateLinkIds,
    ...comparison.changedStateLinkIds,
  ]);
  const afterStateLinkIds = new Set([
    ...comparison.addedStateLinkIds,
    ...comparison.changedStateLinkIds,
  ]);
  return {
    before: {
      nodes: select(before.nodes, beforeNodeIds),
      edges: select(before.edges, beforeEdgeIds),
      stateAccesses: select(before.stateAccesses, beforeStateAccessIds),
      stateLinks: select(before.stateLinks, beforeStateLinkIds),
    },
    after: {
      nodes: select(after.nodes, afterNodeIds),
      edges: select(after.edges, afterEdgeIds),
      stateAccesses: select(after.stateAccesses, afterStateAccessIds),
      stateLinks: select(after.stateLinks, afterStateLinkIds),
    },
  };
}

function coherentBranchPartitions(
  graph: EventGraphSnapshot,
  nodeLimit: number,
  maximumGroups: number,
  signal?: AbortSignal,
): { groups: string[][]; omittedNodeIds: string[] } {
  signal?.throwIfAborted();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const [index, edge] of eventFlowEdges(graph, false).entries()) {
    if ((index & 255) === 0) signal?.throwIfAborted();
    const next = outgoing.get(edge.from) ?? [];
    next.push(edge.to);
    outgoing.set(edge.from, next);
    const previous = incoming.get(edge.to) ?? [];
    previous.push(edge.from);
    incoming.set(edge.to, previous);
  }
  for (const values of [...outgoing.values(), ...incoming.values()]) {
    values.sort(compareCodeUnits);
  }
  const roots = discoverEventRoots(graph, signal);
  const seeds = [
    ...roots.entryPoints.map(({ id }) => id),
    ...roots.automaticEvents.map(({ id }) => id),
    ...roots.callerlessTriggeredEvents.map(({ id }) => id),
    ...graph.nodes.map(({ id }) => id).sort(compareCodeUnits),
  ];
  const visited = new Set<string>();
  const partitions: string[][] = [];
  const isolatedNodeIds: string[] = [];
  let visits = 0;
  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    const component: string[] = [];
    const queue = [seed];
    visited.add(seed);
    for (const current of queue) {
      if ((visits++ & 255) === 0) signal?.throwIfAborted();
      component.push(current);
      const neighbors = [...(outgoing.get(current) ?? []), ...(incoming.get(current) ?? [])].sort(
        compareCodeUnits,
      );
      for (const next of neighbors) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (
      component.length === 1 &&
      (outgoing.get(seed)?.length ?? 0) === 0 &&
      (incoming.get(seed)?.length ?? 0) === 0
    ) {
      isolatedNodeIds.push(seed);
      continue;
    }
    for (let offset = 0; offset < component.length; offset += nodeLimit) {
      partitions.push(component.slice(offset, offset + nodeLimit));
    }
  }
  isolatedNodeIds.sort(compareCodeUnits);
  for (let offset = 0; offset < isolatedNodeIds.length; offset += nodeLimit) {
    partitions.push(isolatedNodeIds.slice(offset, offset + nodeLimit));
  }
  const groups = partitions.slice(0, maximumGroups);
  const omittedNodeIds = partitions.slice(maximumGroups).flat().sort(compareCodeUnits);
  return { groups, omittedNodeIds: omittedNodeIds.sort(compareCodeUnits) };
}

export class EventChainViewer {
  readonly #state: SharedEventServiceState;

  public constructor(private readonly engine: CoreEngine) {
    this.#state = sharedState(engine);
  }

  public async scan(
    workspaceId: string,
    options: {
      refresh?: boolean;
      projectHelpers?: boolean;
      principal?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<EventGraphSnapshot> {
    options.signal?.throwIfAborted();
    // Authorization is request-scoped. Never let a graph cached by one
    // principal bypass the resolver check for a later caller.
    const workspace = this.engine.resolver.get(workspaceId, options.principal);
    const generation = engineGeneration(this.engine, workspaceId);
    const projectHelpers = options.projectHelpers ?? true;
    const cacheKey = eventGraphCacheKey(workspaceId, projectHelpers);
    const cached = this.#state.current.get(cacheKey);
    if (options.refresh !== true && cached?.generation === generation) {
      return cached.graph;
    }
    const sibling = this.#state.current.get(eventGraphCacheKey(workspaceId, !projectHelpers));
    const snapshot =
      options.refresh !== true && sibling?.generation === generation
        ? sibling.snapshot
        : await this.engine.scan(workspaceId, {}, options.principal, options.signal);
    options.signal?.throwIfAborted();
    if (cached?.snapshot.revision === snapshot.revision && cached.generation === generation) {
      return cached.graph;
    }
    const graph = buildEventGraph(snapshot, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      cache: this.#state.fragments,
      workspaceIdentity: workspace.workspaceIdentity,
      projectHelpers,
    });
    this.#state.current.set(cacheKey, { generation, snapshot, graph });
    rememberGraph(this.#state, workspaceId, graph);
    return graph;
  }

  public async inspect(input: EventInspectInput): Promise<EventInspectResult> {
    input.signal?.throwIfAborted();
    const graph = await this.scan(input.workspaceId, {
      refresh: input.refresh ?? input.mode === 'scan',
      projectHelpers: input.mode !== 'scan' && input.mode !== 'roots',
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const maxDepth = input.maxDepth ?? 8;
    const maxNodes = input.maxNodes ?? 500;
    const maxEdges = input.maxEdges ?? 2_000;
    const analysisFilters = {
      ...(input.selector === undefined ? {} : { selector: input.selector }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      direction: input.direction ?? 'both',
      maxDepth,
      maxNodes,
      maxEdges,
      expandHelpers: input.expandHelpers ?? input.mode === 'explain_path',
      ...(input.stateSubject === undefined ? {} : { stateSubject: input.stateSubject }),
      ...(input.impactSubject === undefined ? {} : { impactSubject: input.impactSubject }),
      refresh: input.refresh ?? input.mode === 'scan',
    };
    let report: unknown;
    switch (input.mode) {
      case 'scan':
        report = eventScanReport(graph);
        break;
      case 'roots':
        report = {
          graphRevision: graph.revision,
          sourceHashes: graph.sourceHashes,
          roots: discoverEventRoots(graph, input.signal),
          unresolved: graph.unresolved,
        };
        break;
      case 'trace':
        if (input.selector === undefined)
          throw new ServiceError('EVENT_SELECTOR_REQUIRED', 'Trace requires a selector');
        report = {
          graphRevision: graph.revision,
          sourceHashes: graph.sourceHashes,
          trace: traceSelectedEvents(
            graph,
            input.selector,
            {
              maxDepth,
              maxNodes,
              maxEdges,
              direction: input.direction ?? 'both',
              expandHelpers: input.expandHelpers ?? false,
            },
            input.signal,
          ),
          unresolved: graph.unresolved,
        };
        break;
      case 'explain_path':
        if (input.from === undefined || input.to === undefined)
          throw new ServiceError(
            'EVENT_PATH_SELECTORS_REQUIRED',
            'Path explanation requires from and to selectors',
          );
        report = {
          graphRevision: graph.revision,
          sourceHashes: graph.sourceHashes,
          explanation: explainEventPath(
            graph,
            input.from,
            input.to,
            { maxDepth, maxNodes, expandHelpers: input.expandHelpers ?? true },
            input.signal,
          ),
        };
        break;
      case 'state_flow':
        report = {
          graphRevision: graph.revision,
          sourceHashes: graph.sourceHashes,
          flow: inspectEventStateFlow(graph, input.selector, input.stateSubject, input.signal),
          issues: lintEventGraph(graph, input.selector, input.signal).filter(({ code }) =>
            /(?:STATE|FLAG|VARIABLE|ARRAY|TARGET|SCOPE)/u.test(code),
          ),
        };
        break;
      case 'lint':
        report = {
          graphRevision: graph.revision,
          sourceHashes: graph.sourceHashes,
          issues: lintEventGraph(graph, input.selector, input.signal),
          complete: graph.complete,
          unresolved: graph.unresolved,
        };
        break;
      case 'impact':
        if (input.impactSubject === undefined)
          throw new ServiceError(
            'EVENT_IMPACT_SUBJECT_REQUIRED',
            'Impact analysis requires a subject',
          );
        report = {
          graphRevision: graph.revision,
          sourceHashes: graph.sourceHashes,
          impact: analyzeEventImpact(graph, input.impactSubject, input.signal),
          unresolved: graph.unresolved,
        };
        break;
    }
    const graphHash = cachedEventGraphHash(graph, input.signal);
    const name = `${safeSlug(`event-${input.mode}`)}-${graph.revision.slice(0, 12)}.json`;
    const projectedScan =
      input.mode === 'scan' &&
      typeof report === 'object' &&
      report !== null &&
      'artifactProjection' in report;
    const artifactSourceEvidence = projectedScan
      ? boundedSourceHashEvidence(graph.sourceHashes)
      : undefined;
    const artifactUnresolved = projectedScan
      ? graph.unresolved.slice(0, EVENT_SCAN_SUMMARY_SAMPLE_LIMIT)
      : graph.unresolved;
    const reportJson = `${canonicalJson({
      schemaVersion: 'event-analysis.v1',
      graphSchemaVersion: graph.schemaVersion,
      parserVersion: graph.parserVersion,
      workspaceId: graph.workspaceId,
      mode: input.mode,
      workspaceIdentity: graph.workspaceIdentity,
      graphRevision: graph.revision,
      graphHash,
      sourceHashes: artifactSourceEvidence?.sourceHashes ?? graph.sourceHashes,
      ...(artifactSourceEvidence === undefined
        ? {}
        : { sourceHashInventory: artifactSourceEvidence.inventory }),
      complete: graph.complete,
      filters: analysisFilters,
      unresolved: artifactUnresolved,
      ...(projectedScan
        ? {
            unresolvedInventory: {
              count: graph.unresolved.length,
              retainedCount: artifactUnresolved.length,
              truncated: artifactUnresolved.length !== graph.unresolved.length,
            },
          }
        : {}),
      resources: [{ name, mimeType: 'application/json' }],
      report,
    })}\n`;
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      name,
      'application/json',
      reportJson,
      eventProvenance(
        graph,
        `event-${input.mode}`,
        {
          mode: input.mode,
          ...(input.selector === undefined ? {} : { selector: input.selector }),
        },
        input.signal,
      ),
      `Authoritative Event Chain Viewer ${input.mode.replaceAll('_', ' ')} report`,
      input.signal,
    );
    return {
      graph,
      graphHash,
      mode: input.mode,
      report,
      reportJson,
      artifacts: [artifact],
    };
  }

  public async renderAndStore(input: EventRenderServiceInput): Promise<EventRenderServiceResult> {
    const graph = await this.scan(input.workspaceId, {
      ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      projectHelpers: true,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const budget = new RenderBudget();
    const renderOptions: EventRenderOptions = {
      view: input.view,
      budget,
      ...(input.selector === undefined ? {} : { selector: input.selector }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
      ...(input.expandHelpers === undefined ? {} : { expandHelpers: input.expandHelpers }),
      includeHtml: input.includeHtml ?? false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const render = await renderEventGraph(graph, renderOptions);
    const branches: EventRenderBundle[] = [];
    const branchNodeLimit = 240;
    const partitions =
      input.view === 'overview' &&
      input.selector === undefined &&
      graph.nodes.length > render.selectedNodeIds.length
        ? coherentBranchPartitions(graph, branchNodeLimit, 64, input.signal)
        : { groups: [], omittedNodeIds: [] };
    const branchGroups = partitions.groups;
    for (const [branchIndex, nodeIds] of branchGroups.entries()) {
      input.signal?.throwIfAborted();
      branches.push(
        await renderEventGraph(graph, {
          view: 'neighborhood',
          selector: {
            kind: 'manifest',
            manifest: { id: `overview-branch-${branchIndex + 1}`, nodeIds },
          },
          direction: 'both',
          maxDepth: 0,
          maxNodes: branchNodeLimit,
          expandHelpers: input.expandHelpers ?? false,
          includeHtml: false,
          compactLayout: true,
          budget,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
    }
    const prefix = safeSlug(`event-${input.view}-${graph.revision.slice(0, 12)}`);
    const manifestName = `${prefix}-manifest.json`;
    const resourceNames = {
      manifest: manifestName,
      overview: {
        json: `${prefix}.json`,
        svg: `${prefix}.svg`,
        png: `${prefix}.png`,
        ...(render.html === undefined ? {} : { html: `${prefix}.html` }),
      },
      branches: branches.map((branch, index) => {
        const branchPrefix = `${prefix}-branch-${String(index + 1).padStart(2, '0')}`;
        return {
          index: index + 1,
          json: `${branchPrefix}.json`,
          svg: `${branchPrefix}.svg`,
          png: `${branchPrefix}.png`,
          ...(branch.html === undefined ? {} : { html: `${branchPrefix}.html` }),
        };
      }),
    };
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    const provenance = eventProvenance(
      graph,
      'event-render',
      {
        view: input.view,
        selectedNodeCount: render.selectedNodeIds.length,
        omittedNodeCount: render.omittedNodeCount,
        layoutHash: render.layout.layoutHash,
        filters: {
          ...(input.selector === undefined ? {} : { selector: input.selector }),
          direction: input.direction ?? 'both',
          maxDepth: input.maxDepth ?? 4,
          maxNodes: input.maxNodes ?? 120,
          expandHelpers: input.expandHelpers ?? false,
        },
      },
      input.signal,
    );
    const dataWrites: ArtifactWrite[] = [
      {
        name: `${prefix}.json`,
        mimeType: 'application/json',
        content: render.json,
        provenance,
        description: `Authoritative ${input.view} event-chain render data`,
      },
      {
        name: `${prefix}.svg`,
        mimeType: 'image/svg+xml',
        content: render.svg,
        provenance,
        description: `Source-linked ${input.view} event-chain diagram`,
      },
      {
        name: `${prefix}.png`,
        mimeType: 'image/png',
        content: render.png,
        provenance,
        description: `${input.view} event-chain image`,
      },
      ...(render.html === undefined
        ? []
        : [
            {
              name: `${prefix}.html`,
              mimeType: 'text/html',
              content: render.html,
              provenance,
              description: `Static ${input.view} event-chain evidence`,
            },
          ]),
      ...branches.flatMap((branch, index): ArtifactWrite[] => {
        const branchPrefix = `${prefix}-branch-${String(index + 1).padStart(2, '0')}`;
        return [
          {
            name: `${branchPrefix}.json`,
            mimeType: 'application/json',
            content: branch.json,
            provenance,
            description: `Authoritative bounded event-chain branch ${index + 1}`,
          },
          {
            name: `${branchPrefix}.svg`,
            mimeType: 'image/svg+xml',
            content: branch.svg,
            provenance,
            description: `Source-linked event-chain branch ${index + 1}`,
          },
          {
            name: `${branchPrefix}.png`,
            mimeType: 'image/png',
            content: branch.png,
            provenance,
            description: `Event-chain branch ${index + 1} image`,
          },
        ];
      }),
    ];
    const dataArtifacts = await this.engine.artifacts.withAtomicChunkedWrites(
      workspace,
      dataWrites,
      (stored) => Promise.resolve([...stored]),
      input.signal,
    );
    const resourceLinks = dataArtifacts
      .map(publicArtifactLink)
      .sort(
        (left, right) =>
          compareCodeUnits(left.name, right.name) || compareCodeUnits(left.uri, right.uri),
      );
    const manifestJson = `${canonicalJson({
      schemaVersion: 'event-render-manifest.v1',
      graphSchemaVersion: graph.schemaVersion,
      parserVersion: graph.parserVersion,
      workspaceId: graph.workspaceId,
      workspaceIdentity: graph.workspaceIdentity,
      graphRevision: graph.revision,
      graphHash: cachedEventGraphHash(graph, input.signal),
      sourceHashes: graph.sourceHashes,
      complete: graph.complete,
      filters: {
        view: input.view,
        ...(input.selector === undefined ? {} : { selector: input.selector }),
        direction: input.direction ?? 'both',
        maxDepth: input.maxDepth ?? 4,
        maxNodes: input.maxNodes ?? 120,
        expandHelpers: input.expandHelpers ?? false,
        includeHtml: input.includeHtml ?? false,
        refresh: input.refresh ?? false,
      },
      unresolved: graph.unresolved,
      resources: { ...resourceNames, artifacts: resourceLinks },
      overview: {
        selectedNodeIds: render.selectedNodeIds,
        hashes: render.hashes,
      },
      branches: branches.map((branch, index) => ({
        index: index + 1,
        selectedNodeIds: branch.selectedNodeIds,
        omittedNodeCount: branch.omittedNodeCount,
        hashes: branch.hashes,
      })),
      coverage: {
        totalNodes: graph.nodes.length,
        retainedBranchSourceNodes: branchGroups.reduce((total, group) => total + group.length, 0),
        omittedNodeCount: partitions.omittedNodeIds.length,
        omittedNodeIds: partitions.omittedNodeIds,
        omittedNodeHash: hashCanonical(partitions.omittedNodeIds),
        truncated: partitions.omittedNodeIds.length > 0,
      },
    })}\n`;
    const manifestArtifact = await this.engine.artifacts.putChunked(
      workspace,
      manifestName,
      'application/json',
      manifestJson,
      provenance,
      `Event-chain ${input.view} render and bounded branch manifest`,
      input.signal,
    );
    const artifacts = [manifestArtifact, ...dataArtifacts];
    return {
      graph,
      graphHash: cachedEventGraphHash(graph, input.signal),
      render,
      branches,
      manifestJson,
      artifacts,
    };
  }

  #proposedGraph(
    workspaceId: string,
    sources: readonly EventProposedSource[],
    principal?: string,
    signal?: AbortSignal,
  ): EventGraphSnapshot {
    if (sources.length === 0)
      throw new ServiceError(
        'EVENT_PROPOSED_SOURCE_REQUIRED',
        'Proposed comparison source list is empty',
      );
    assertProposedSourceBounds(sources);
    const cached = this.#state.current.get(eventGraphCacheKey(workspaceId, false));
    if (cached === undefined)
      throw new ServiceError(
        'EVENT_BASELINE_MISSING',
        'Scan the workspace before comparing proposed source',
      );
    const paths = sources.map(({ relativePath }) => validRelativeSourcePath(relativePath));
    if (new Set(paths.map((value) => value.toLowerCase())).size !== paths.length) {
      throw new ServiceError(
        'EVENT_PROPOSED_PATH_DUPLICATE',
        'Proposed source paths must be unique',
      );
    }
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
      const logicalActive =
        candidates.find(({ file }) => file.shadowedBy === undefined) ?? candidates[0];
      const modCandidate = candidates.find(({ file }) => file.rootKind === 'mod');
      if (
        source.expectedSourceHash !== undefined &&
        logicalActive?.file.sha256 !== source.expectedSourceHash
      ) {
        throw new ServiceError(
          'EVENT_PROPOSED_SOURCE_STALE',
          'Proposed source baseline hash is stale',
          {
            relativePath,
            expectedSourceHash: source.expectedSourceHash,
            actualSourceHash: logicalActive?.file.sha256 ?? null,
          },
        );
      }
      if (source.source === null) {
        if (modCandidate === undefined)
          throw new ServiceError(
            'EVENT_PROPOSED_SOURCE_MISSING',
            'Cannot delete a source absent from the active mod root',
            { relativePath },
          );
        files.splice(modCandidate.index, 1);
        continue;
      }
      const bytes = Buffer.from(source.source, 'utf8');
      if (bytes.length > SOURCE_MAX_BYTES)
        throw new ServiceError(
          'SOURCE_FILE_LIMIT',
          'Proposed event source exceeds the parser byte ceiling',
          { relativePath, size: bytes.length, limit: SOURCE_MAX_BYTES },
        );
      if (modCandidate !== undefined) {
        modCandidate.file.bytes = bytes;
        modCandidate.file.size = bytes.length;
        modCandidate.file.sha256 = sha256Bytes(bytes);
        modCandidate.file.modifiedMs = 0;
      } else {
        const modRoot = [...workspace.roots]
          .filter(({ kind }) => kind === 'mod')
          .sort((left, right) => right.loadOrder - left.loadOrder)[0];
        if (modRoot === undefined)
          throw new ServiceError(
            'EVENT_PROPOSED_ROOT_MISSING',
            'Workspace has no mod root for a proposed new source',
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
        left.loadOrder - right.loadOrder || compareCodeUnits(left.relativePath, right.relativePath),
    );
    const index = this.engine.indexFiles(files);
    const revision = snapshotRevision(files);
    const snapshot: ScanSnapshot = {
      workspaceId,
      revision,
      files,
      index,
      complete: index.complete,
      skippedSourceCount: index.skippedSourceCount,
      skippedSources: index.skippedSources,
      diagnostics: index.diagnostics,
    };
    return buildEventGraph(snapshot, {
      ...(signal === undefined ? {} : { signal }),
      cache: this.#state.fragments,
      workspaceIdentity: workspace.workspaceIdentity,
      projectHelpers: false,
    });
  }

  async #resolveGraphReference(
    workspaceId: string,
    reference: EventGraphReference | undefined,
    current: EventGraphSnapshot,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<EventGraphSnapshot> {
    if (reference?.artifactUri !== undefined) {
      const selected = parseGraphArtifact(
        await readLogicalArtifact(
          this.engine,
          workspaceId,
          reference.artifactUri,
          principal,
          signal,
        ),
        signal,
      );
      if (selected.workspaceId !== workspaceId) {
        throw new ServiceError(
          'EVENT_GRAPH_WORKSPACE_MISMATCH',
          'Event graph snapshot names a different workspace',
        );
      }
      if (selected.workspaceIdentity !== current.workspaceIdentity) {
        throw new ServiceError(
          'EVENT_GRAPH_WORKSPACE_MISMATCH',
          'Event graph snapshot was produced for a different workspace topology',
        );
      }
      return selected;
    }
    if (reference?.revision !== undefined) {
      const selected = this.#state.history.get(workspaceId)?.get(reference.revision);
      if (selected === undefined)
        throw new ServiceError(
          'EVENT_REVISION_NOT_CACHED',
          'Requested event graph revision is not cached',
        );
      return selected;
    }
    return current;
  }

  public async compareAndStore(input: EventCompareInput): Promise<EventCompareResult> {
    input.signal?.throwIfAborted();
    if (input.proposedSources !== undefined) assertProposedSourceBounds(input.proposedSources);
    const refresh =
      input.refresh ??
      (input.proposedSources !== undefined ||
        input.before === undefined ||
        input.after === undefined);
    const current = await this.scan(input.workspaceId, {
      refresh,
      projectHelpers: false,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    let before = await this.#resolveGraphReference(
      input.workspaceId,
      input.before,
      current,
      input.principal,
      input.signal,
    );
    let after =
      input.proposedSources === undefined
        ? await this.#resolveGraphReference(
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
      const history = [...(this.#state.history.get(input.workspaceId)?.values() ?? [])];
      const previous = history.filter(({ revision }) => revision !== current.revision).at(-1);
      if (previous === undefined)
        throw new ServiceError(
          'EVENT_COMPARISON_BASELINE_REQUIRED',
          'Provide a cached revision, graph artifact, or proposed source overlay',
        );
      before = previous;
      after = current;
    }
    const comparison = compareEventGraphs(before, after, input.signal);
    graphHashCache.set(before, comparison.beforeGraphHash);
    graphHashCache.set(after, comparison.afterGraphHash);
    let render: EventRenderBundle | undefined;
    if (input.render !== false) {
      const projection = comparisonRenderProjection(before, after, comparison, input.signal);
      const selector: EventSelector = {
        kind: 'manifest',
        manifest: {
          id: 'comparison',
          nodeIds: projection.selectedNodeIds,
        } satisfies EventFeatureManifest,
      };
      render = await renderEventGraph(projection.graph, {
        view: 'neighborhood',
        selector,
        direction: 'both',
        maxDepth: 2,
        maxNodes: input.maxRenderNodes ?? 120,
        includeHtml: false,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    const prefix = safeSlug(
      `event-compare-${before.revision.slice(0, 8)}-${after.revision.slice(0, 8)}`,
    );
    const resourceNames = {
      json: `${prefix}.json`,
      ...(render === undefined
        ? {}
        : {
            svg: `${prefix}.svg`,
            png: `${prefix}.png`,
            ...(render.html === undefined ? {} : { html: `${prefix}.html` }),
          }),
    };
    const comparisonJson = `${canonicalJson({
      schemaVersion: 'event-comparison-artifact.v1',
      graphSchemaVersion: after.schemaVersion,
      parserVersion: after.parserVersion,
      workspaceId: current.workspaceId,
      workspaceIdentity: current.workspaceIdentity,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      beforeComplete: before.complete,
      afterComplete: after.complete,
      beforeSourceHashes: before.sourceHashes,
      afterSourceHashes: after.sourceHashes,
      filters: {
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        proposedSources:
          input.proposedSources?.map(({ relativePath, source, expectedSourceHash }) => ({
            relativePath,
            operation: source === null ? 'delete' : 'overlay',
            ...(source === null ? {} : { sourceHash: sha256Bytes(source) }),
            ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
          })) ?? [],
        render: input.render ?? true,
        maxRenderNodes: input.maxRenderNodes ?? 120,
        refresh,
      },
      beforeUnresolved: before.unresolved,
      afterUnresolved: after.unresolved,
      beforeIssues: before.issues,
      afterIssues: after.issues,
      evidence: comparisonEntityEvidence(before, after, comparison, input.signal),
      resources: resourceNames,
      comparison,
    })}\n`;
    const provenance = eventProvenance(
      after,
      'event-comparison',
      {
        beforeRevision: before.revision,
        afterRevision: after.revision,
        changeCount: comparison.changes.length,
      },
      input.signal,
    );
    const writes: ArtifactWrite[] = [
      {
        name: `${prefix}.json`,
        mimeType: 'application/json',
        content: comparisonJson,
        provenance,
        description: 'Authoritative Event Chain Viewer structural comparison',
      },
      ...(render === undefined
        ? []
        : [
            {
              name: `${prefix}.svg`,
              mimeType: 'image/svg+xml',
              content: render.svg,
              provenance,
              description: 'Source-linked event-chain comparison diagram',
            },
            {
              name: `${prefix}.png`,
              mimeType: 'image/png',
              content: render.png,
              provenance,
              description: 'Event-chain comparison image',
            },
            ...(render.html === undefined
              ? []
              : [
                  {
                    name: `${prefix}.html`,
                    mimeType: 'text/html',
                    content: render.html,
                    provenance,
                    description: 'Static event-chain comparison evidence',
                  },
                ]),
          ]),
    ];
    const artifacts = await this.engine.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (stored) => Promise.resolve([...stored]),
      input.signal,
    );
    return {
      before,
      after,
      refresh,
      comparison,
      comparisonJson,
      ...(render === undefined ? {} : { render }),
      artifacts,
    };
  }
}
