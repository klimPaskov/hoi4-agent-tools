import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import type { Diagnostic } from '../core/diagnostics.js';
import { callEngineOperation } from '../core/engine-operation.js';
import { locateEngineBinary } from '../core/engine-client.js';
import { ServiceError } from '../core/result.js';
import { PACKAGE_VERSION } from '../version.js';
import type { MapWorkspaceIndex } from './model.js';
import type { MapValidationOptions, MapValidationResult } from './validation.js';

/**
 * Map validation on the engine (`map.validate`, ADR 0089 step 6, packet P13a). The engine builds
 * its own map index from the scanned files sent with the request, so it reads nothing from disk:
 * the scan that chose the files stays the only way a file reaches the map. A missing engine, an
 * engine without the op or an answer out of shape is `ENGINE_UNAVAILABLE`; nothing falls back to
 * TypeScript.
 *
 * `validateMapAsync` calls the resident engine. `validateMap` is synchronous, because the map
 * model and its callers are, so it runs one `hoi4-engine serve` over request and answer files: a
 * synchronous call that piped hundreds of megabytes hung on macOS runners (see engine-raster.ts).
 */

export const MAP_VALIDATE_OP = 'map.validate';
const MAP_VALIDATE_TIMEOUT_MS = 600_000;

const location = z.looseObject({ path: z.string() });
const diagnosticSchema = z
  .object({
    code: z.string(),
    severity: z.enum(['info', 'warning', 'error', 'blocker']),
    category: z.enum([
      'syntax',
      'reference',
      'layout',
      'design',
      'rendering',
      'security',
      'validation',
      'map',
      'configuration',
    ]),
    message: z.string(),
    location: location.optional(),
    related: z.array(location).optional(),
    operationId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const mapValidateAnswerSchema = z
  .object({
    passed: z.boolean(),
    diagnostics: z.array(diagnosticSchema),
    checks: z.array(z.object({ id: z.string(), passed: z.boolean(), message: z.string() }).strict()),
    baselineFingerprint: z.string().optional(),
  })
  .strict();

export type MapValidateAnswer = z.infer<typeof mapValidateAnswerSchema>;

interface MapValidateRequest {
  body: Record<string, unknown>;
  payload: Buffer;
}

/** The request body and payload: every scanned file of the index, and the options. */
export function mapValidateRequest(
  index: MapWorkspaceIndex,
  options: MapValidationOptions = {},
): MapValidateRequest {
  const chunks: Buffer[] = [];
  const files = index.sourceFiles.map((file) => {
    chunks.push(file.bytes);
    return {
      displayPath: file.displayPath,
      relativePath: file.relativePath,
      rootKind: file.rootKind,
      loadOrder: file.loadOrder,
      size: file.size,
      sha256: file.sha256,
      length: file.bytes.length,
    };
  });
  const baselineBitmap = options.baseline?.provinceBitmap?.bytes;
  if (baselineBitmap !== undefined) chunks.push(baselineBitmap);
  const body: Record<string, unknown> = {
    files,
    sourceRoots: index.sourceRoots,
    toolVersion: PACKAGE_VERSION,
    options: {
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      ...(options.expectedChangedBounds === undefined
        ? {}
        : { expectedChangedBounds: options.expectedChangedBounds }),
      ...(options.baseline === undefined
        ? {}
        : {
            baseline: {
              stateIds: [...options.baseline.statesById.keys()],
              ...(baselineBitmap === undefined
                ? {}
                : { provinceBitmapLength: baselineBitmap.length }),
            },
          }),
      includeBaselineDiagnostics: options.includeBaselineDiagnostics === true,
      ...(options.diagnosticLimit === undefined
        ? {}
        : { diagnosticLimit: options.diagnosticLimit }),
      ...(options.edgeMode === undefined ? {} : { edgeMode: options.edgeMode }),
    },
  };
  return { body, payload: Buffer.concat(chunks) };
}

function result(answer: MapValidateAnswer): MapValidationResult {
  return {
    passed: answer.passed,
    diagnostics: answer.diagnostics as Diagnostic[],
    checks: answer.checks,
  };
}

/** `map.validate` on the resident engine. */
export async function engineValidateMapAsync(
  index: MapWorkspaceIndex,
  options: MapValidationOptions = {},
): Promise<MapValidationResult> {
  options.signal?.throwIfAborted();
  const { body, payload } = mapValidateRequest(index, options);
  const answer = await callEngineOperation({
    op: MAP_VALIDATE_OP,
    body,
    payload,
    result: mapValidateAnswerSchema,
    options: {
      timeoutMs: MAP_VALIDATE_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  });
  return result(answer.result);
}

const frameSchema = z.union([
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }).loose(),
  z
    .object({
      id: z.number(),
      ok: z.literal(false),
      error: z.looseObject({ code: z.string(), message: z.string() }),
    })
    .loose(),
]);

const TOOL_CODE = /^[A-Z][A-Z0-9_]*$/u;

/** `map.validate` on a one-shot engine, for the synchronous callers. */
export function engineValidateMapSync(
  index: MapWorkspaceIndex,
  options: MapValidationOptions = {},
): MapValidationResult {
  return result(engineMapOperationSync(MAP_VALIDATE_OP, mapValidateRequest(index, options), mapValidateAnswerSchema));
}

/** One registered engine operation on a one-shot `hoi4-engine serve`, over files. */
export function engineMapOperationSync<T>(
  op: string,
  request: MapValidateRequest,
  schema: z.ZodType<T>,
): T {
  const located = locateEngineBinary();
  if (!('path' in located))
    throw new ServiceError('ENGINE_UNAVAILABLE', located.message, { reason: located.reason });
  const header = `${JSON.stringify({ ...request.body, id: 1, op, payload: request.payload.length })}\n`;
  const script = /\.(?:c|m)?js$/iu.test(located.path);
  const directory = mkdtempSync(path.join(tmpdir(), 'hoi4-map-validate-'));
  const inputPath = path.join(directory, 'request');
  const outputPath = path.join(directory, 'answer');
  let child: SpawnSyncReturns<Buffer>;
  let answer: Buffer;
  try {
    writeFileSync(inputPath, Buffer.concat([Buffer.from(header, 'utf8'), request.payload]));
    const input = openSync(inputPath, 'r');
    const output = openSync(outputPath, 'w');
    try {
      child = spawnSync(
        script ? process.execPath : located.path,
        script ? [located.path, 'serve'] : ['serve'],
        {
          stdio: [input, output, 'pipe'],
          timeout: MAP_VALIDATE_TIMEOUT_MS,
          windowsHide: true,
          shell: false,
        },
      );
    } finally {
      closeSync(input);
      closeSync(output);
    }
    answer = existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const unavailable = (message: string, reason: string): ServiceError =>
    new ServiceError('ENGINE_UNAVAILABLE', message, { op, reason });
  if (child.error !== undefined)
    throw unavailable(`hoi4-engine ${op}: ${child.error.message}`, 'spawn_failed');
  const newline = answer.indexOf(0x0a);
  if (newline < 0)
    throw unavailable(
      `hoi4-engine ${op} gave no answer (exit ${child.status ?? 'none'}): ${child.stderr.toString('utf8').slice(-300)}`,
      'invalid_output',
    );
  let parsedFrame: unknown;
  try {
    parsedFrame = JSON.parse(answer.subarray(0, newline).toString('utf8'));
  } catch {
    throw unavailable(`hoi4-engine ${op} answered an unreadable frame`, 'invalid_output');
  }
  const frame = frameSchema.safeParse(parsedFrame);
  if (!frame.success) throw unavailable(`hoi4-engine ${op} answered an unknown frame`, 'invalid_output');
  if (!frame.data.ok) {
    const { code, message, ...details } = frame.data.error;
    if (TOOL_CODE.test(code)) throw new ServiceError(code, message, details);
    throw unavailable(message, code);
  }
  const parsed = schema.safeParse(frame.data.result);
  if (!parsed.success) throw unavailable(`hoi4-engine ${op} answered out of shape`, 'invalid_response');
  return parsed.data;
}
