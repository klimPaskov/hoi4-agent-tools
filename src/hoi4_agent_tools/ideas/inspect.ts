import type { z } from 'zod/v4';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import {
  ideaEngineAuditSchema,
  ideaEngineInspectionSchema,
  type ideaInspectDataSchema,
  type ideaInspectRequestSchema,
} from '../schemas/ideas.js';

type Input = z.infer<typeof ideaInspectRequestSchema>;
type Output = z.infer<typeof ideaInspectDataSchema>;

/** A whole-mod audit of a large mod reads every idea, character, sprite and name. */
const IDEAS_TIMEOUT_MS = 180_000;

/**
 * `hoi4.idea_inspect` on the shared Rust engine (`hoi4-engine ideas`). This side passes the
 * workspace's roots and turns the engine's answer into the tool's data. A missing engine is
 * `ENGINE_UNAVAILABLE`, with no TypeScript fallback.
 */
export async function inspectIdeas(
  workspace: ResolvedWorkspace,
  input: Input,
  signal?: AbortSignal,
): Promise<Output> {
  const started = Date.now();
  const request = {
    ...(workspace.gameRoot === undefined ? {} : { game: workspace.gameRoot }),
    ...(workspace.registration.kind === 'game' ? {} : { mod: workspace.modRoot }),
    dependencies: workspace.dependencyRoots,
    includeDlc: workspace.dlcLayers.length > 0,
    kind: input.kind,
    ...(input.id === undefined ? {} : { id: input.id }),
    audit: input.audit,
    limit: input.limit,
  };
  const options = { timeoutMs: IDEAS_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  if (input.audit) {
    const result = await runEngineCommand('ideas', request, ideaEngineAuditSchema, options);
    if (!result.available)
      throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
    if (result.outcome === 'invalid_request')
      throw new ServiceError(result.error.code, result.error.message);
    return { audit: result.response, durationMs: Date.now() - started };
  }
  const result = await runEngineCommand('ideas', request, ideaEngineInspectionSchema, options);
  if (!result.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
  if (result.outcome === 'invalid_request')
    throw new ServiceError(result.error.code, result.error.message);
  const inspection = result.response;
  if (!inspection.found) {
    const suggestions = inspection.suggestions ?? [];
    throw new ServiceError(
      input.kind === 'idea' ? 'IDEA_NOT_FOUND' : 'CHARACTER_NOT_FOUND',
      `No loaded file defines the ${input.kind} ${input.id ?? ''}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
      { id: input.id ?? '', suggestions },
    );
  }
  return { inspection, durationMs: Date.now() - started };
}
