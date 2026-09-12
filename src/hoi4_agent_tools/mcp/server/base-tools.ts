import { lstat } from 'node:fs/promises';
import type { CoreEngine } from '../../core/engine.js';
import { ServiceError } from '../../core/result.js';
export { postValidateTransaction } from '../../core/domain-validation.js';

export interface ServerContext {
  principal?: string;
  scopes?: readonly string[];
  resolveCurrentWorkspaceId?: (signal?: AbortSignal) => Promise<string>;
}

export async function resolveServerWorkspaceId(
  engine: CoreEngine,
  context: ServerContext,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (workspaceId === 'current' && context.resolveCurrentWorkspaceId !== undefined) {
    return context.resolveCurrentWorkspaceId(signal);
  }
  return engine.resolver.resolveWorkspaceId(workspaceId, context.principal);
}

export async function resolveServerWorkspaceForSource(
  engine: CoreEngine,
  context: ServerContext,
  workspaceId: string,
  relativePath: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const resolvedWorkspaceId = await resolveServerWorkspaceId(engine, context, workspaceId, signal);
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

export function requireServerScope(context: ServerContext, scope: string): void {
  if (context.scopes !== undefined && !context.scopes.includes(scope)) {
    throw new ServiceError('AUTH_SCOPE_REQUIRED', `This operation requires the ${scope} scope`, {
      requiredScope: scope,
    });
  }
}
