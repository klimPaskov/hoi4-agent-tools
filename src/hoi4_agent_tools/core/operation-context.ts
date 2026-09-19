import { lstat } from 'node:fs/promises';
import type { CoreEngine } from './engine.js';
import { ServiceError } from './result.js';

export interface OperationContext {
  principal?: string;
  scopes?: readonly string[];
  resolveCurrentWorkspaceId?: (signal?: AbortSignal) => Promise<string>;
}

export async function resolveOperationWorkspaceId(
  engine: CoreEngine,
  context: OperationContext,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (workspaceId === 'current' && context.resolveCurrentWorkspaceId !== undefined) {
    return context.resolveCurrentWorkspaceId(signal);
  }
  return engine.resolver.resolveWorkspaceId(workspaceId, context.principal);
}

export async function resolveOperationWorkspaceForSource(
  engine: CoreEngine,
  context: OperationContext,
  workspaceId: string,
  relativePath: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const resolvedWorkspaceId = await resolveOperationWorkspaceId(
    engine,
    context,
    workspaceId,
    signal,
  );
  if (workspaceId !== 'current' || relativePath === undefined) return resolvedWorkspaceId;

  try {
    const resolved = await engine.resolver.resolvePath(
      resolvedWorkspaceId,
      relativePath,
      'read',
      ['mod'],
      context.principal,
    );
    signal?.throwIfAborted();
    if ((await lstat(resolved.path)).isFile()) return resolvedWorkspaceId;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
  }

  return (
    (await engine.resolver.resolveUniqueModSourceWorkspaceId(
      relativePath,
      context.principal,
      signal,
    )) ?? resolvedWorkspaceId
  );
}

export function requireOperationScope(context: OperationContext, scope: string): void {
  if (context.scopes !== undefined && !context.scopes.includes(scope)) {
    throw new ServiceError('AUTH_SCOPE_REQUIRED', `This operation requires the ${scope} scope`, {
      requiredScope: scope,
    });
  }
}
