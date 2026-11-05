import type { z } from 'zod/v4';
import { runEngineCommand } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import type { ResolvedWorkspace } from '../core/workspace.js';
import {
  localisationEngineResponseSchema,
  type localisationInspectDataSchema,
  type localisationInspectRequestSchema,
} from '../schemas/localisation.js';

type Input = z.infer<typeof localisationInspectRequestSchema>;
type Output = z.infer<typeof localisationInspectDataSchema>;

/** A whole-mod audit of a large mod reads every localisation file and the mod's script. */
const LOCALISATION_TIMEOUT_MS = 180_000;

/**
 * `hoi4.localisation_inspect` on the shared Rust engine. The engine reads the workspace's layers
 * in load order; this side only passes the roots and turns its answer into the tool's data. A
 * missing engine is `ENGINE_UNAVAILABLE`, with no TypeScript fallback.
 */
export async function inspectLocalisation(
  workspace: ResolvedWorkspace,
  input: Input,
  signal?: AbortSignal,
): Promise<Output> {
  const started = Date.now();
  const isGame = workspace.registration.kind === 'game';
  const result = await runEngineCommand(
    'localisation',
    {
      ...(workspace.gameRoot === undefined ? {} : { game: workspace.gameRoot }),
      ...(isGame ? {} : { mod: workspace.modRoot }),
      dependencies: workspace.dependencyRoots,
      includeDlc: workspace.dlcLayers.length > 0,
      mode: input.mode,
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.language === undefined ? {} : { language: input.language }),
      limit: input.limit,
    },
    localisationEngineResponseSchema,
    { timeoutMs: LOCALISATION_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  if (!result.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
  if (result.outcome === 'invalid_request')
    throw new ServiceError(result.error.code, result.error.message);
  const answer = result.response;
  if (answer.key?.found === false) {
    const suggestions = answer.key.suggestions ?? [];
    throw new ServiceError(
      'LOCALISATION_KEY_NOT_FOUND',
      `No language defines ${input.key ?? ''}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
      { key: input.key ?? '', suggestions, mentions: answer.key.mentions.length },
    );
  }
  return { ...answer, durationMs: Date.now() - started };
}
