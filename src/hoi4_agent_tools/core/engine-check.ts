import { z } from 'zod/v4';
import { runEngineCommand, type EngineRunOptions } from './engine-client.js';
import { ServiceError } from './result.js';

/**
 * `hoi4-engine check` (ADR 0074) for the tools that judge a whole mod: one run reads every layer
 * in load order and reports references, lints and the override audit. The tools read the fields
 * below and ignore the rest, so the engine can add fields without breaking them.
 */

export const ENGINE_CHECK_SCHEMA = 'hoi4-engine-report/1';
/** A whole-mod check of a large mod reads every file of every layer. */
export const ENGINE_CHECK_TIMEOUT_MS = 180_000;

export const engineCheckFindingSchema = z.looseObject({
  code: z.string().max(128),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string().max(4096),
  /** Relative to the layer root, with forward slashes. */
  path: z.string().max(4096),
  /** The name of the layer that owns the file. */
  layer: z.string().max(512),
  line: z.number().int().min(0),
  column: z.number().int().min(0),
  subject: z.string().max(1024).optional(),
  context: z.string().max(1024).optional(),
  suggestion: z.string().max(1024).optional(),
  fingerprint: z.string().max(128).optional(),
});

export const engineCheckLayerSchema = z.looseObject({
  kind: z.string().max(32),
  name: z.string().max(512),
  path: z.string().max(4096),
  replace_paths: z.array(z.string().max(1024)).max(4096),
});

export const engineCheckReportSchema = z.looseObject({
  schema: z.literal(ENGINE_CHECK_SCHEMA),
  engine_version: z.string().max(64),
  verdict: z.string().max(32),
  inputs: z.looseObject({
    layers: z.array(engineCheckLayerSchema).max(512),
    game_version: z.string().max(64).nullable().optional(),
  }),
  summary: z.looseObject({
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
    infos: z.number().int().min(0),
    by_code: z.record(z.string(), z.number().int().min(0)),
  }),
  stats: z.looseObject({ elapsed_ms: z.number().min(0).optional() }),
  overrides: z
    .array(
      z.looseObject({
        path: z.string().max(4096),
        winner: z.string().max(512),
        replaced: z.array(z.string().max(4096)).max(512),
      }),
    )
    .max(100_000),
  findings: z.array(engineCheckFindingSchema).max(1_000_000),
});

export type EngineCheckReport = z.infer<typeof engineCheckReportSchema>;
export type EngineCheckFinding = z.infer<typeof engineCheckFindingSchema>;

export interface EngineCheckRequest {
  /** The mod checked; its layer is the one findings are about. */
  mod: string;
  game?: string;
  /** Loaded before the mod, in load order. */
  dependencies?: readonly string[];
  includeDlc?: boolean;
}

/**
 * Run `hoi4-engine check --format json --fail-on never` on one mod. A missing engine is
 * `ENGINE_UNAVAILABLE`; nothing falls back to TypeScript.
 */
export async function runEngineCheck(
  request: EngineCheckRequest,
  options: Omit<EngineRunOptions, 'args'> = {},
): Promise<EngineCheckReport> {
  const args = [
    '--mod',
    request.mod,
    ...(request.game === undefined ? [] : ['--game', request.game]),
    ...(request.dependencies ?? []).flatMap((dependency) => ['--dependency', dependency]),
    ...(request.includeDlc === false ? ['--no-dlc'] : []),
    '--format',
    'json',
    '--fail-on',
    'never',
  ];
  const result = await runEngineCommand('check', null, engineCheckReportSchema, {
    timeoutMs: ENGINE_CHECK_TIMEOUT_MS,
    ...options,
    args,
  });
  if (!result.available)
    throw new ServiceError('ENGINE_UNAVAILABLE', result.message, { reason: result.reason });
  if (result.outcome === 'invalid_request')
    throw new ServiceError(result.error.code, result.error.message);
  return result.response;
}

/** The checked mod's own layer: the last one in load order that is not the game or a DLC. */
export function checkedLayerName(report: EngineCheckReport): string | undefined {
  return report.inputs.layers.at(-1)?.name;
}
