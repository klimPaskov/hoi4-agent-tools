import type { z } from 'zod/v4';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import {
  systemEngineAuditSchema,
  systemEngineInspectionSchema,
  type systemInspectDataSchema,
  type systemInspectRequestSchema,
} from '../schemas/system.js';

type Input = z.infer<typeof systemInspectRequestSchema>;
type Output = z.infer<typeof systemInspectDataSchema>;

/** An audit reads the system's files, the sprites and every localisation file. */
const SYSTEM_TIMEOUT_MS = 180_000;

/**
 * `hoi4.system_inspect` on the shared Rust engine (`hoi4-engine system`). This side passes the
 * workspace's roots and turns the engine's answer into the tool's data. A missing engine is
 * `ENGINE_UNAVAILABLE`, with no TypeScript fallback.
 */
export async function inspectSystem(
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
  const options = { timeoutMs: SYSTEM_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  if (input.audit) {
    const result = await runEngineCommand('system', request, systemEngineAuditSchema, options);
    if (!result.available)
      throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
    if (result.outcome === 'invalid_request')
      throw new ServiceError(result.error.code, result.error.message);
    return { audit: result.response, durationMs: Date.now() - started };
  }
  const result = await runEngineCommand('system', request, systemEngineInspectionSchema, options);
  if (!result.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
  if (result.outcome === 'invalid_request')
    throw new ServiceError(result.error.code, result.error.message);
  const inspection = result.response;
  if (!inspection.found) {
    const suggestions = inspection.suggestions ?? [];
    throw new ServiceError(
      'SYSTEM_DEFINITION_NOT_FOUND',
      `No loaded ${input.kind} file defines ${input.id ?? ''}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
      { kind: input.kind, id: input.id ?? '', suggestions },
    );
  }
  return { inspection, durationMs: Date.now() - started };
}
