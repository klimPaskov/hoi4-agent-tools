import { z } from 'zod/v4';
import { PACKAGE_VERSION } from '../version.js';
import {
  helperExpansionRequestSchema,
  type HelperExpansionRequest,
  type HelperExpansionSummary,
} from '../schemas/helper-expansion.js';
import { canonicalJson, compareCodeUnits, hashCanonical } from './canonical.js';
import { boundedSourceHashEvidence, type ArtifactWrite, type StoredArtifact } from './artifacts.js';
import { DependencyPages, dependencyPageCursorSchema } from './dependency-pages.js';
import type { CoreEngine } from './engine.js';
import { ServiceError } from './result.js';
import { transactionRootFingerprint } from './transactions.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const querySchema = helperExpansionRequestSchema
  .pick({ rootIds: true })
  .extend({ maxDepth: z.number().int().min(1).max(256) });
const continuationSchema = z
  .object({
    version: z.literal(1),
    toolVersion: z.string(),
    domain: z.enum(['event', 'technology']),
    scope: digest,
    sourceRevision: digest,
    query: querySchema,
    cursor: dependencyPageCursorSchema,
  })
  .strict();

export interface HelperExpansionInventory {
  domain: 'event' | 'technology';
  sourceRevision: string;
  sourceComplete: boolean;
  sourceHashes: Record<string, string>;
  unresolved?: readonly unknown[];
  edges: Array<{ id: string; from: string; to: string; evidence: unknown }>;
  roots: string[];
  branches: string[];
}
export interface HelperExpansionResult {
  report: unknown;
  reportJson: string;
  summary: HelperExpansionSummary;
  artifacts: StoredArtifact[];
}

export function helperExpansionValidation(summary: HelperExpansionSummary) {
  return {
    passed: summary.complete,
    checks: [
      {
        id: 'helper-expansion-coverage',
        passed: summary.complete,
        message: `${summary.completedRoots}/${summary.totalRoots} roots finished; ${summary.depthStops} depth stops; source inventory ${summary.sourceComplete ? 'complete' : 'partial'}; static source coverage only, not runtime validity`,
      },
    ],
  };
}

/** Read-only structural evidence, with authenticated opaque continuation resources shared by both domains. */
export async function inspectHelperExpansion(
  engine: CoreEngine,
  workspaceId: string,
  inventory: HelperExpansionInventory,
  request: HelperExpansionRequest = {},
  principal?: string,
  signal?: AbortSignal,
): Promise<HelperExpansionResult> {
  signal?.throwIfAborted();
  const options = helperExpansionRequestSchema.parse(request);
  const workspace = engine.resolver.get(workspaceId, principal);
  const scope = hashCanonical({
    workspaceId: workspace.id,
    workspaceIdentity: workspace.workspaceIdentity,
    ownerIdentity: workspace.ownerIdentity,
    roots: transactionRootFingerprint(workspace),
    principal: principal ?? null,
  });
  let restored: z.infer<typeof continuationSchema> | undefined;
  if (options.continuationUri !== undefined) {
    const resource = await engine.artifacts.readLogical(
      workspace,
      options.continuationUri,
      { mimeType: 'application/json', maxBytes: 8_388_608, maxChunks: 8_192 },
      signal,
    );
    try {
      restored = continuationSchema.parse(JSON.parse(resource.bytes.toString('utf8')) as unknown);
    } catch {
      throw new ServiceError(
        'HELPER_CONTINUATION_INVALID',
        'Helper continuation does not contain a valid bounded traversal envelope',
      );
    }
    if (restored.domain !== inventory.domain || restored.scope !== scope)
      throw new ServiceError(
        'HELPER_CONTINUATION_SCOPE_MISMATCH',
        'Helper continuation belongs to a different domain, workspace, root topology, or principal',
      );
    if (
      restored.toolVersion !== PACKAGE_VERSION ||
      restored.sourceRevision !== inventory.sourceRevision
    )
      throw new ServiceError(
        'HELPER_CONTINUATION_STALE',
        'Helper continuation requires the same tool version and exact source revision; start a new analysis',
      );
  }
  const rootIds =
    options.rootIds === undefined
      ? restored?.query.rootIds
      : [...new Set(options.rootIds)].sort(compareCodeUnits);
  const query = querySchema.parse({
    ...(rootIds === undefined ? {} : { rootIds }),
    maxDepth: options.maxDepth ?? restored?.query.maxDepth ?? 64,
  });
  if (restored !== undefined && hashCanonical(restored.query) !== hashCanonical(query))
    throw new ServiceError(
      'HELPER_CONTINUATION_QUERY_MISMATCH',
      'Helper continuation cannot change root selection or depth; start a new analysis',
    );
  const knownRoots = new Set(inventory.roots);
  if (query.rootIds?.some((id) => !knownRoots.has(id)) === true)
    throw new ServiceError(
      'HELPER_ROOT_UNKNOWN',
      'Every selected root must be a structural helper-call root in the current source inventory',
    );
  const input = {
    domain: `${inventory.domain}-helper-expansion.v1`,
    sourceRevision: inventory.sourceRevision,
    edges: inventory.edges.map(({ id, from, to }) => ({ id, from, to })),
    roots: query.rootIds ?? [...inventory.roots].sort(compareCodeUnits),
    branches: inventory.branches,
    maximumDepth: query.maxDepth,
    visitPolicy: 'edge_path' as const,
    reverseEdges: false,
  };
  const pager = new DependencyPages(input, restored?.cursor);
  const page = pager.page(options.maxRecords ?? 250, options.maxWork ?? 5_000, signal);
  const summary: HelperExpansionSummary = {
    complete: inventory.sourceComplete && page.finished && page.cursor.depthStops === 0,
    finished: page.finished,
    sourceComplete: inventory.sourceComplete,
    maxDepth: query.maxDepth,
    records: page.records.length,
    totalRecords: page.cursor.emitted,
    work: page.work,
    totalWork: page.cursor.steps,
    completedRoots: page.completedRoots,
    totalRoots: page.totalRoots,
    cycles: page.cursor.cycles,
    depthStops: page.cursor.depthStops,
  };
  const used = new Set(page.records.flatMap(({ path }) => path));
  const records = page.records.map(({ kind, root, path }) => ({
    id: hashCanonical({ key: pager.key, kind, root, path }),
    kind,
    rootId: input.roots[root]!,
    path: path.map((index) => inventory.edges[index]!.id),
  }));
  const continuationName = `${inventory.domain}-helper-continuation.json`;
  const report = {
    schemaVersion: 'helper-expansion.v1',
    domain: inventory.domain,
    workspaceId: workspace.id,
    workspaceIdentity: workspace.workspaceIdentity,
    sourceRevision: inventory.sourceRevision,
    sourceEvidence: boundedSourceHashEvidence(inventory.sourceHashes),
    unresolved: {
      count: inventory.unresolved?.length ?? 0,
      retainedCount: Math.min(100, inventory.unresolved?.length ?? 0),
      sample: (inventory.unresolved ?? []).slice(0, 100),
    },
    query,
    coverage: summary,
    analysisBoundary: {
      staticAnalysis: true,
      visitPolicy: 'edge_path',
      cyclePolicy: 'report_and_stop',
      conditions: 'source evidence only; not evaluated',
      directReferences:
        'helper-owned leaves only; use the ordinary inspection modes for non-helper references',
      completeness:
        'recognized static call paths under report-and-stop cycle semantics; not runtime outcomes or resolution of dynamic source findings',
    },
    records,
    edges: [...used].sort((left, right) => left - right).map((index) => inventory.edges[index]!),
    ...(page.finished
      ? {}
      : {
          continuation: {
            name: continuationName,
            mimeType: 'application/json',
            resolution:
              'helperExpansion.continuationUri in the tool result; also linked as a sibling artifact',
          },
        }),
  };
  const reportJson = `${canonicalJson(report)}\n`;
  const provenance = {
    kind: `${inventory.domain}-helper-expansion`,
    toolVersion: PACKAGE_VERSION,
    schemaVersion: '1',
    sourceHashes: {},
    metadata: { scope, sourceRevision: inventory.sourceRevision, traversal: pager.key },
  };
  const writes: ArtifactWrite[] = [
    {
      name: `${inventory.domain}-helper-expansion.json`,
      mimeType: 'application/json',
      content: reportJson,
      provenance,
      description: 'Bounded source-linked helper path evidence and explicit traversal coverage',
    },
  ];
  if (!page.finished)
    writes.push({
      name: continuationName,
      mimeType: 'application/json',
      content: canonicalJson(
        continuationSchema.parse({
          version: 1,
          toolVersion: PACKAGE_VERSION,
          domain: inventory.domain,
          scope,
          sourceRevision: inventory.sourceRevision,
          query,
          cursor: page.cursor,
        }),
      ),
      provenance,
      description:
        'Opaque revision- and principal-bound helper continuation; pass as helperExpansion.continuationUri',
    });
  const artifacts = await engine.artifacts.withAtomicChunkedWrites(
    workspace,
    writes,
    (stored) => Promise.resolve([...stored]),
    signal,
  );
  return {
    report,
    reportJson,
    summary: {
      ...summary,
      ...(artifacts[1] === undefined ? {} : { continuationUri: artifacts[1].uri }),
    },
    artifacts,
  };
}
