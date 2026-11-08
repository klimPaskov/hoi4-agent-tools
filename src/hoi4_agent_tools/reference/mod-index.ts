import type { z } from 'zod/v4';
import { defaultPatterns, type CoreEngine } from '../core/engine.js';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import type { ServerConfiguration } from '../core/configuration.js';
import { readModDescriptor, type ResolvedWorkspace, type RootKind } from '../core/workspace.js';
import {
  modIndexEngineResponseSchema,
  type modIndexDataSchema,
  type modIndexRequestSchema,
} from '../schemas/mod-tools.js';

/**
 * A compact map of what a mod defines, and the next free numbered identifier for a prefix.
 * Identifiers are checked against every source layer, so a new ID never collides with a
 * game or dependency definition.
 *
 * The shared Rust engine (`hoi4-engine mod-index`, ADR 0080) builds the symbol index; this side
 * resolves the workspace, passes its roots, the shared scan's patterns and ceilings, reads the
 * descriptor and shapes the answer. A missing engine is `ENGINE_UNAVAILABLE`, with no TypeScript
 * fallback.
 */

type Input = z.infer<typeof modIndexRequestSchema>;
type Output = z.infer<typeof modIndexDataSchema>;

const MAX_NAMESPACES = 200;
const MAX_FOLDERS = 60;
/** A cold index of the game, its DLC and a large mod. */
const MOD_INDEX_TIMEOUT_MS = 180_000;
const MOD_INDEX_REQUEST_SCHEMA = 'hoi4-mod-index-request/1';
/** The roots the shared scan reads; artifacts and caches are never sources. */
export const SOURCE_ROOT_KINDS: readonly RootKind[] = [
  'game',
  'dlc',
  'dependency',
  'mod',
  'fixture',
];

/** The engine request for the workspace's source roots of `rootKinds` (scan roots of ADR 0080). */
export function modIndexEngineRequest(
  workspace: ResolvedWorkspace,
  config: ServerConfiguration,
  rootKinds: readonly RootKind[],
): {
  schema: typeof MOD_INDEX_REQUEST_SCHEMA;
  roots: Array<{
    kind: RootKind;
    path: string;
    loadOrder: number;
    label?: string;
    replacePaths: string[];
  }>;
  patterns: string[];
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number };
} {
  return {
    schema: MOD_INDEX_REQUEST_SCHEMA,
    roots: workspace.roots
      .filter(({ kind }) => rootKinds.includes(kind))
      .map(({ kind, path, loadOrder, label, replacePaths }) => ({
        kind,
        path,
        loadOrder,
        ...(label === undefined ? {} : { label }),
        replacePaths,
      })),
    patterns: defaultPatterns(workspace),
    limits: {
      maxFiles: config.scanMaxFiles,
      maxBytes: config.scanMaxBytes,
      maxFileBytes: config.scanMaxFileBytes,
    },
  };
}

async function runModIndex(
  engine: CoreEngine,
  workspaceId: string,
  request: {
    mode: 'overview' | 'next_id';
    rootKinds: readonly RootKind[];
    kind?: string;
    prefix?: string;
  },
  principal?: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof modIndexEngineResponseSchema>> {
  signal?.throwIfAborted();
  await engine.resolver.refreshDescriptors(workspaceId, principal);
  const workspace = engine.resolver.get(workspaceId, principal);
  const result = await runEngineCommand(
    'mod-index',
    {
      ...modIndexEngineRequest(workspace, engine.resolver.config(), request.rootKinds),
      mode: request.mode,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      ...(request.prefix === undefined ? {} : { prefix: request.prefix }),
    },
    modIndexEngineResponseSchema,
    { timeoutMs: MOD_INDEX_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  if (!result.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
  if (result.outcome === 'invalid_request')
    throw new ServiceError(result.error.code, result.error.message);
  return result.response;
}

export async function modIndex(
  engine: CoreEngine,
  workspaceId: string,
  input: Input,
  principal?: string,
  signal?: AbortSignal,
): Promise<Output> {
  if (input.mode === 'next_id') {
    const prefix =
      input.prefix ??
      (input.namespace === undefined ? undefined : `${input.namespace.replace(/\.$/u, '')}.`);
    if (prefix === undefined)
      throw new ServiceError('MOD_INDEX_PREFIX_REQUIRED', 'next_id needs prefix or namespace');
    // Every layer: a new identifier must not collide with game or dependency definitions.
    const answer = await runModIndex(
      engine,
      workspaceId,
      { mode: 'next_id', rootKinds: SOURCE_ROOT_KINDS, kind: input.kind, prefix },
      principal,
      signal,
    );
    const used = answer.next?.used ?? 0;
    const highest = answer.next?.highest;
    const firstGap = answer.next?.firstGap;
    return {
      mode: 'next_id',
      complete: answer.complete,
      next: {
        kind: input.kind,
        prefix,
        used,
        ...(highest === undefined ? {} : { highest }),
        nextId: `${prefix}${(highest ?? 0) + 1}`,
        ...(firstGap === undefined ? {} : { firstGapId: `${prefix}${firstGap}` }),
      },
    };
  }
  const answer = await runModIndex(
    engine,
    workspaceId,
    { mode: 'overview', rootKinds: input.layer === 'mod' ? ['mod'] : SOURCE_ROOT_KINDS },
    principal,
    signal,
  );
  const allNamespaces = [...(answer.namespaces ?? [])].sort((left, right) =>
    left.namespace.localeCompare(right.namespace, 'en'),
  );
  const modRoot = engine.resolver
    .get(workspaceId, principal)
    .roots.find(({ kind }) => kind === 'mod')?.path;
  const descriptor = modRoot === undefined ? undefined : await readModDescriptor(modRoot);
  return {
    mode: 'overview',
    layer: input.layer,
    complete: answer.complete,
    ...(descriptor === undefined ? {} : { descriptor }),
    files: answer.files ?? 0,
    kinds: [...(answer.kinds ?? [])].sort(
      (left, right) => right.count - left.count || left.kind.localeCompare(right.kind),
    ),
    folders: [...(answer.folders ?? [])]
      .sort((left, right) => right.files - left.files || left.folder.localeCompare(right.folder))
      .slice(0, MAX_FOLDERS),
    namespaces: allNamespaces.slice(0, MAX_NAMESPACES),
    omittedNamespaces: Math.max(0, allNamespaces.length - MAX_NAMESPACES),
  };
}
