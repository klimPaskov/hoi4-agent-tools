import type { z } from 'zod/v4';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import {
  assetEngineAuditSchema,
  assetEngineInspectionSchema,
  type assetInspectDataSchema,
  type assetInspectRequestSchema,
  systemEngineAuditSchema,
  systemEngineInspectionSchema,
  unitEngineAuditSchema,
  unitEngineInspectionSchema,
  type systemInspectDataSchema,
  type systemInspectRequestSchema,
  type unitInspectDataSchema,
  type unitInspectRequestSchema,
} from '../schemas/system.js';

/** An audit reads the system's files, the sprites and every localisation file. */
const SYSTEM_TIMEOUT_MS = 180_000;

interface Request {
  kind: string;
  id?: string | undefined;
  audit: boolean;
  limit: number;
}

/**
 * Runs one engine command that answers a definition or an audit. This side passes the workspace's
 * roots and turns the engine's answer into the tool's data. A missing engine is
 * `ENGINE_UNAVAILABLE`, with no TypeScript fallback.
 */
async function inspectDefinitions<I extends z.ZodType, A extends z.ZodType>(
  command: 'system' | 'units' | 'assets',
  schemas: { inspection: I; audit: A },
  notFound: string,
  workspace: ResolvedWorkspace,
  input: Request,
  signal?: AbortSignal,
): Promise<{ inspection?: z.infer<I>; audit?: z.infer<A>; durationMs: number }> {
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
    const result = await runEngineCommand(command, request, schemas.audit, options);
    if (!result.available)
      throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
    if (result.outcome === 'invalid_request')
      throw new ServiceError(result.error.code, result.error.message);
    return { audit: result.response as z.infer<A>, durationMs: Date.now() - started };
  }
  const result = await runEngineCommand(command, request, schemas.inspection, options);
  if (!result.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
  if (result.outcome === 'invalid_request')
    throw new ServiceError(result.error.code, result.error.message);
  const inspection = result.response as { found: boolean; suggestions?: string[] | undefined };
  if (!inspection.found) {
    const suggestions = inspection.suggestions ?? [];
    throw new ServiceError(
      notFound,
      `No loaded ${input.kind} file defines ${input.id ?? ''}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
      { kind: input.kind, id: input.id ?? '', suggestions },
    );
  }
  return { inspection: result.response as z.infer<I>, durationMs: Date.now() - started };
}

/** `hoi4.system_inspect` on the shared Rust engine (`hoi4-engine system`). */
export async function inspectSystem(
  workspace: ResolvedWorkspace,
  input: z.infer<typeof systemInspectRequestSchema>,
  signal?: AbortSignal,
): Promise<z.infer<typeof systemInspectDataSchema>> {
  return inspectDefinitions(
    'system',
    { inspection: systemEngineInspectionSchema, audit: systemEngineAuditSchema },
    'SYSTEM_DEFINITION_NOT_FOUND',
    workspace,
    input,
    signal,
  );
}

/** `hoi4.unit_inspect` on the shared Rust engine (`hoi4-engine units`). */
export async function inspectUnits(
  workspace: ResolvedWorkspace,
  input: z.infer<typeof unitInspectRequestSchema>,
  signal?: AbortSignal,
): Promise<z.infer<typeof unitInspectDataSchema>> {
  return inspectDefinitions(
    'units',
    { inspection: unitEngineInspectionSchema, audit: unitEngineAuditSchema },
    'UNIT_DEFINITION_NOT_FOUND',
    workspace,
    input,
    signal,
  );
}

/** `hoi4.asset_inspect` on the shared Rust engine (`hoi4-engine assets`). */
export async function inspectAssets(
  workspace: ResolvedWorkspace,
  input: z.infer<typeof assetInspectRequestSchema>,
  signal?: AbortSignal,
): Promise<z.infer<typeof assetInspectDataSchema>> {
  return inspectDefinitions(
    'assets',
    { inspection: assetEngineInspectionSchema, audit: assetEngineAuditSchema },
    'ASSET_NOT_FOUND',
    workspace,
    input,
    signal,
  );
}
