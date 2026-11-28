import { z } from 'zod/v4';
import { callEngineOperation } from './engine-operation.js';
import type { ResidentEngineRequestOptions } from './resident-engine.js';

/**
 * Typed calls of the `artifacts.*` and `diff.*` engine operations (hoi4-artifacts, ADR 0089 and
 * 0091). Each call returns what the TypeScript service returned, or throws the `ServiceError` the
 * engine reports: an upper-case code keeps its code, anything else is `ENGINE_UNAVAILABLE`.
 */

export interface EngineStoreWorkspace {
  id: string;
  artifactRoot: string;
  workspaceIdentity: string;
  ownerIdentity: string;
}

export interface EngineStoreLimits {
  maxBytes?: number;
  maxEntries?: number;
  maxSingleBytes?: number;
}

type Options = ResidentEngineRequestOptions;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const engineArtifactLinkSchema = z
  .object({
    uri: z.string(),
    name: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    sha256,
    description: z.string().optional(),
  })
  .strict();

export const engineStoredArtifactSchema = engineArtifactLinkSchema.extend({
  provenanceHash: sha256,
  path: z.string(),
  provenance: z.record(z.string(), z.unknown()),
});

const createdSchema = z.object({
  targets: z.array(z.string()),
  manifests: z.array(z.string()),
  /** The engine's claim on these files until the caller commits or releases the put. */
  batch: z.string().optional(),
});
const putResultSchema = z.object({
  artifacts: z.array(engineStoredArtifactSchema),
  physical: z.array(engineStoredArtifactSchema),
  created: createdSchema,
});

export type EngineStoredArtifact = z.infer<typeof engineStoredArtifactSchema>;
export type EngineCreated = z.infer<typeof createdSchema>;

export interface EngineArtifactWrite {
  name: string;
  mimeType: string;
  content: Uint8Array | string;
  provenance: Record<string, unknown>;
  description?: string;
}

function packWrites(writes: readonly EngineArtifactWrite[]): {
  writes: Array<Record<string, unknown>>;
  payload: Buffer;
} {
  const buffers = writes.map(({ content }) =>
    typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content),
  );
  return {
    writes: writes.map((write, index) => ({
      name: write.name,
      mimeType: write.mimeType,
      length: buffers[index]!.length,
      provenance: write.provenance,
      ...(write.description === undefined ? {} : { description: write.description }),
    })),
    payload: Buffer.concat(buffers),
  };
}

function storeBody(
  workspace: EngineStoreWorkspace,
  limits?: EngineStoreLimits,
): Record<string, unknown> {
  return { workspace, ...(limits === undefined ? {} : { limits }) };
}

/**
 * Stores a batch of artifacts. `retention` supplies the caller's durable pins: the engine asks for
 * them (`ARTIFACT_RETENTION_REQUIRED`) only when it must evict to make room, and the call is made
 * again with them.
 */
export async function putArtifacts(
  workspace: EngineStoreWorkspace,
  writes: readonly EngineArtifactWrite[],
  options: {
    chunked?: boolean;
    limits?: EngineStoreLimits;
    retention?: () => Promise<Iterable<string>>;
    request?: Options;
  } = {},
): Promise<z.infer<typeof putResultSchema>> {
  const packed = packWrites(writes);
  const call = (retained?: string[], epoch?: number) =>
    callEngineOperation({
      op: options.chunked === true ? 'artifacts.put_chunked' : 'artifacts.put',
      body: {
        ...storeBody(workspace, options.limits),
        writes: packed.writes,
        ...(options.retention === undefined ? {} : { retentionPending: true }),
        ...(retained === undefined ? {} : { retainedUris: retained }),
        ...(epoch === undefined ? {} : { retentionEpoch: epoch }),
      },
      payload: packed.payload,
      result: putResultSchema,
      ...(options.request === undefined ? {} : { options: options.request }),
    });
  let retained: string[] | undefined;
  let epoch: number | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await call(retained, epoch)).result;
    } catch (error) {
      if (
        options.retention === undefined ||
        attempt >= retentionAttempts ||
        (error as { code?: string }).code !== 'ARTIFACT_RETENTION_REQUIRED'
      )
        throw error;
      // The epoch is taken before the pins are read: a commit made meanwhile moves it, and the
      // engine then asks again instead of evicting an artifact that list does not know about.
      const reported = (error as { details?: { epoch?: unknown } }).details?.epoch;
      epoch = typeof reported === 'number' ? reported : undefined;
      retained = [...(await options.retention())];
    }
  }
}

/** How many times a put re-reads the caller's pins when commits keep changing them. */
const retentionAttempts = 5;

/** Takes back the files a put created, when the caller's own commit failed. */
export async function releaseArtifacts(
  workspace: EngineStoreWorkspace,
  created: EngineCreated,
  limits?: EngineStoreLimits,
): Promise<void> {
  await callEngineOperation({
    op: 'artifacts.release',
    body: { ...storeBody(workspace, limits), created },
    result: z.object({}),
  });
}

/**
 * Tells the engine the caller's commit succeeded, so the files of a put are no longer held against
 * eviction. A put's claim also expires on its own after ten minutes.
 */
export async function commitArtifacts(
  workspace: EngineStoreWorkspace,
  created: EngineCreated,
  limits?: EngineStoreLimits,
): Promise<void> {
  await callEngineOperation({
    op: 'artifacts.commit',
    body: { ...storeBody(workspace, limits), created },
    result: z.object({}),
  });
}

export async function readArtifact(
  workspace: EngineStoreWorkspace,
  uri: string,
  range?: { offset: number; length: number },
  limits?: EngineStoreLimits,
  request?: Options,
): Promise<{ bytes: Buffer; mimeType: string; name: string; totalSize: number }> {
  const { result, payload } = await callEngineOperation({
    op: 'artifacts.read',
    body: { ...storeBody(workspace, limits), uri, ...(range === undefined ? {} : { range }) },
    result: z.object({ mimeType: z.string(), name: z.string(), totalSize: z.number() }),
    ...(request === undefined ? {} : { options: request }),
  });
  return { bytes: payload, ...result };
}

export async function readLogicalArtifact(
  workspace: EngineStoreWorkspace,
  uri: string,
  logical: { mimeType: string; maxBytes: number; maxChunks: number },
  limits?: EngineStoreLimits,
): Promise<{ bytes: Buffer; mimeType: string; name: string; totalSize: number }> {
  const { result, payload } = await callEngineOperation({
    op: 'artifacts.read_logical',
    body: { ...storeBody(workspace, limits), uri, ...logical },
    result: z.object({ mimeType: z.string(), name: z.string(), totalSize: z.number() }),
  });
  return { bytes: payload, ...result };
}

export async function describeArtifact(
  workspace: EngineStoreWorkspace,
  uri: string,
  limits?: EngineStoreLimits,
): Promise<EngineStoredArtifact> {
  return (
    await callEngineOperation({
      op: 'artifacts.describe',
      body: { ...storeBody(workspace, limits), uri },
      result: engineStoredArtifactSchema,
    })
  ).result;
}

export async function artifactsAvailable(
  workspace: EngineStoreWorkspace,
  uris: readonly string[],
  limits?: EngineStoreLimits,
): Promise<boolean> {
  return (
    await callEngineOperation({
      op: 'artifacts.available',
      body: { ...storeBody(workspace, limits), uris },
      result: z.object({ available: z.boolean() }),
    })
  ).result.available;
}

export async function listArtifacts(
  workspace: EngineStoreWorkspace,
  limits?: EngineStoreLimits,
): Promise<Array<z.infer<typeof engineArtifactLinkSchema>>> {
  return (
    await callEngineOperation({
      op: 'artifacts.list',
      body: storeBody(workspace, limits),
      result: z.object({ artifacts: z.array(engineArtifactLinkSchema) }),
    })
  ).result.artifacts;
}

export async function listArtifactPage(
  workspace: EngineStoreWorkspace,
  page: { limit: number; afterUri?: string },
  limits?: EngineStoreLimits,
): Promise<{
  artifacts: Array<z.infer<typeof engineArtifactLinkSchema>>;
  total: number;
  revision: string;
  afterFound: boolean;
  hasMore: boolean;
}> {
  return (
    await callEngineOperation({
      op: 'artifacts.list_page',
      body: { ...storeBody(workspace, limits), ...page },
      result: z.object({
        artifacts: z.array(engineArtifactLinkSchema),
        total: z.number(),
        revision: z.string(),
        afterFound: z.boolean(),
        hasMore: z.boolean(),
      }),
    })
  ).result;
}

const changedSummarySchema = z.object({
  total: z.number(),
  created: z.number(),
  removed: z.number(),
  modified: z.number(),
  folders: z.array(
    z.object({
      folder: z.string(),
      created: z.number(),
      removed: z.number(),
      modified: z.number(),
    }),
  ),
  omittedFolders: z.number(),
});

export async function summarizeChangedFilesOnEngine(
  files: ReadonlyArray<{
    relativePath: string;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>,
  limit?: number,
): Promise<z.infer<typeof changedSummarySchema>> {
  return (
    await callEngineOperation({
      op: 'artifacts.changed_summary',
      body: { files, ...(limit === undefined ? {} : { limit }) },
      result: changedSummarySchema,
    })
  ).result;
}

export async function unifiedTextDiffOnEngine(
  oldText: string,
  newText: string,
  oldName: string,
  newName: string,
  options: { context?: number; maxMatrixCells?: number } = {},
): Promise<string> {
  // Both texts and the diff travel as payload: a real file's diff is larger than a response header may be.
  const oldBytes = Buffer.from(oldText, 'utf8');
  const answer = await callEngineOperation({
    op: 'diff.text',
    body: { oldLength: oldBytes.length, oldName, newName, ...options },
    payload: Buffer.concat([oldBytes, Buffer.from(newText, 'utf8')]),
    result: z.object({ length: z.number() }),
  });
  return answer.payload.toString('utf8');
}

const binaryDiffSchema = z.object({
  oldSize: z.number(),
  newSize: z.number(),
  changedBytes: z.number(),
  firstChangedOffset: z.number().optional(),
  lastChangedOffset: z.number().optional(),
});

export async function binaryDiffOnEngine(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): Promise<z.infer<typeof binaryDiffSchema>> {
  return (
    await callEngineOperation({
      op: 'diff.binary',
      body: { oldLength: oldBytes.length },
      payload: Buffer.concat([oldBytes, newBytes]),
      result: binaryDiffSchema,
    })
  ).result;
}

export async function comparePngImagesOnEngine(
  left: Buffer,
  right: Buffer,
  options: { threshold?: number; reservedPixels?: number } = {},
): Promise<{
  width: number;
  height: number;
  changedPixels: number;
  changedRatio: number;
  json: string;
  png: Buffer;
  reservedPixels: number;
}> {
  const { result, payload } = await callEngineOperation({
    op: 'diff.image',
    body: { leftLength: left.length, ...options },
    payload: Buffer.concat([left, right]),
    result: z.object({
      width: z.number(),
      height: z.number(),
      changedPixels: z.number(),
      changedRatio: z.number(),
      json: z.string(),
      reservedPixels: z.number(),
    }),
  });
  return { ...result, png: payload };
}

/** A path rule: data in place of the predicates of the TypeScript managed-output planner. */
export type EnginePathRule =
  | { any: EnginePathRule[] }
  | { all: EnginePathRule[] }
  | { not: EnginePathRule }
  | { path: string }
  | { dir: { dirs: string[]; files?: string[]; pattern?: string } };

export interface EngineManagedSource {
  relativePath: string;
  rootKind: string;
  sha256: string;
}

export interface EngineManagedChange {
  relativePath: string;
  sha256: string | null;
  operationIds: string[];
}

const managedPlanSchema = z.object({
  deletions: z.array(z.object({ relativePath: z.string(), operationIds: z.array(z.string()) })),
  manifest: z.string(),
  written: z.array(z.string()),
  retired: z.array(z.string()),
  released: z.array(z.string()),
  ignored: z.array(z.string()),
});

export async function planManagedOutputsOnEngine(input: {
  manifestPath: string;
  sources: readonly EngineManagedSource[];
  manifestText?: string;
  proposed: readonly EngineManagedChange[];
  operationId: string;
  permits: EnginePathRule;
  releasable?: EnginePathRule;
}): Promise<z.infer<typeof managedPlanSchema>> {
  return (
    await callEngineOperation({
      op: 'artifacts.managed_plan',
      body: { ...input },
      result: managedPlanSchema,
    })
  ).result;
}

const managedRefreshSchema = z.object({
  refresh: z
    .object({
      content: z.string().nullable().optional(),
      refreshed: z.array(z.string()),
      dropped: z.array(z.string()),
      keptEdited: z.array(z.string()),
      unchanged: z.array(z.string()),
      unscanned: z.array(z.string()),
      added: z.array(z.string()),
      operationIds: z.array(z.string()),
    })
    .nullable(),
});

export async function refreshManagedOutputsOnEngine(input: {
  manifestPath: string;
  sources: readonly EngineManagedSource[];
  manifestText?: string;
  proposed: readonly EngineManagedChange[];
  manifestWritten?: string;
  manifestDeleted?: boolean;
  adoptAll?: boolean;
  adoptUnrecorded?: boolean;
  addable?: EnginePathRule;
  alwaysScanned?: EnginePathRule;
}): Promise<z.infer<typeof managedRefreshSchema>['refresh']> {
  return (
    await callEngineOperation({
      op: 'artifacts.managed_refresh',
      body: { ...input },
      result: managedRefreshSchema,
    })
  ).result.refresh;
}

export async function sweepTemporaryDirectoriesOnEngine(
  parent: string,
  options: {
    referenceSnapshotsOnly?: boolean;
    ownedFixturesOnly?: boolean;
    now?: number;
    staleMs?: number;
    maxBytes?: number;
    protectedRoots?: readonly string[];
    currentUid?: number;
  } = {},
): Promise<{ removed: number; retainedBytes: number }> {
  return (
    await callEngineOperation({
      op: 'artifacts.sweep_temporary',
      body: { parent, ...options },
      result: z.object({ removed: z.number(), retainedBytes: z.number() }),
    })
  ).result;
}
