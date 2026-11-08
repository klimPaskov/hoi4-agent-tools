import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';

/**
 * Client for the shared Rust engine (`hoi4-engine`, ADR 0074). It runs the binary with a JSON
 * request on stdin and validates the JSON it prints. A missing binary, a crash, a timeout or
 * output that does not match the schema is reported as `available: false` with a reason; the
 * caller decides what to tell the agent. Nothing here falls back to a TypeScript implementation.
 */

export const ENGINE_BINARY_ENV = 'HOI4_ENGINE';
export const ENGINE_DEFAULT_TIMEOUT_MS = 30_000;
export const ENGINE_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const ENGINE_STDERR_TAIL_BYTES = 4096;
const ENGINE_REASON_TEXT_LIMIT = 300;

export type EngineUnavailableReason =
  | 'binary_not_found'
  | 'binary_path_invalid'
  | 'binary_checksum_mismatch'
  | 'spawn_failed'
  | 'timeout'
  | 'output_too_large'
  | 'exit_status'
  | 'invalid_output';

export interface EngineBinaryLocation {
  path: string;
  source: 'environment' | 'package';
}

export interface EngineRunOptions {
  /** Environment that locates the binary (`HOI4_ENGINE`) and that it runs with; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Package root that holds `engine/bin/<platform>-<arch>/`; defaults to this package. */
  packageRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Command-line arguments after the subcommand, for commands that take them (`check`). */
  args?: readonly string[];
}

export type EngineResult<Response> =
  | { available: true; outcome: 'response'; binary: EngineBinaryLocation; response: Response }
  | {
      available: true;
      outcome: 'invalid_request';
      binary: EngineBinaryLocation;
      error: { code: string; message: string };
    }
  | {
      available: false;
      outcome: 'unavailable';
      reason: EngineUnavailableReason;
      message: string;
      binary?: EngineBinaryLocation;
    };

function defaultPackageRoot(): string {
  // src/hoi4_agent_tools/core and dist/hoi4_agent_tools/core both sit three levels below the root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export const ENGINE_BUNDLE_MANIFEST_SCHEMA = 'hoi4-engine-bundle/1';

/** `engine/bin/manifest.json`: the SHA-256 and size of every bundled binary, keyed by `<platform>-<arch>`. */
export const engineBundleManifestSchema = z.strictObject({
  schema: z.literal(ENGINE_BUNDLE_MANIFEST_SCHEMA),
  engineVersion: z.string().min(1),
  binaries: z.record(
    z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/u),
    z.strictObject({
      file: z.string().regex(/^[a-z0-9]+-[a-z0-9]+\/hoi4-engine(?:\.exe)?$/u),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      size: z.number().int().positive(),
    }),
  ),
});
export type EngineBundleManifest = z.infer<typeof engineBundleManifestSchema>;

export function engineBundleManifestPath(packageRoot: string = defaultPackageRoot()): string {
  return path.join(packageRoot, 'engine', 'bin', 'manifest.json');
}

/** Hashes already checked in this process, keyed by path; a changed size or time is hashed again. */
const verifiedBinaries = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

function sha256OfFile(file: string): string {
  const stat = statSync(file);
  const known = verifiedBinaries.get(file);
  if (known?.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha256;
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  verifiedBinaries.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  return sha256;
}

/**
 * A bundled binary runs only when the package's manifest lists it with the same SHA-256, so a
 * damaged or replaced file is reported instead of run.
 */
function verifyPackagedBinary(
  packageRoot: string,
  binary: string,
): { reason: EngineUnavailableReason; message: string } | undefined {
  const key = `${process.platform}-${process.arch}`;
  let manifest: EngineBundleManifest;
  try {
    manifest = engineBundleManifestSchema.parse(
      JSON.parse(readFileSync(engineBundleManifestPath(packageRoot), 'utf8')),
    );
  } catch {
    return {
      reason: 'binary_checksum_mismatch',
      message: `The bundled hoi4-engine for ${key} has no valid engine/bin/manifest.json to check it against`,
    };
  }
  const entry = manifest.binaries[key];
  if (entry === undefined)
    return {
      reason: 'binary_checksum_mismatch',
      message: `engine/bin/manifest.json lists no hoi4-engine for ${key}`,
    };
  let sha256: string;
  try {
    sha256 = sha256OfFile(binary);
  } catch {
    return {
      reason: 'binary_not_found',
      message: `The bundled hoi4-engine for ${key} cannot be read`,
    };
  }
  if (sha256 !== entry.sha256)
    return {
      reason: 'binary_checksum_mismatch',
      message: `The bundled hoi4-engine for ${key} does not match the SHA-256 in engine/bin/manifest.json; reinstall hoi4-agent-tools`,
    };
  return undefined;
}

/** The bundled binary's path for this platform, whether or not it exists. */
export function packagedEngineBinaryPath(
  packageRoot: string = defaultPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(
    packageRoot,
    'engine',
    'bin',
    `${platform}-${arch}`,
    platform === 'win32' ? 'hoi4-engine.exe' : 'hoi4-engine',
  );
}

/**
 * `HOI4_ENGINE` (an absolute path) wins; a set but unusable `HOI4_ENGINE` is reported instead of
 * silently using the bundled binary. Otherwise the package's own `engine/bin` binary, if present
 * and matching the SHA-256 in `engine/bin/manifest.json`.
 */
export function locateEngineBinary(
  options: Pick<EngineRunOptions, 'env' | 'packageRoot'> = {},
): EngineBinaryLocation | { reason: EngineUnavailableReason; message: string } {
  const configured = (options.env ?? process.env)[ENGINE_BINARY_ENV];
  if (configured !== undefined && configured !== '') {
    if (!path.isAbsolute(configured))
      return {
        reason: 'binary_path_invalid',
        message: `${ENGINE_BINARY_ENV} must be an absolute path to the hoi4-engine binary`,
      };
    if (!isFile(configured))
      return {
        reason: 'binary_not_found',
        message: `${ENGINE_BINARY_ENV} names a file that does not exist`,
      };
    return { path: configured, source: 'environment' };
  }
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const packaged = packagedEngineBinaryPath(packageRoot);
  if (isFile(packaged)) {
    const rejected = verifyPackagedBinary(packageRoot, packaged);
    return rejected ?? { path: packaged, source: 'package' };
  }
  return {
    reason: 'binary_not_found',
    message: `No hoi4-engine binary for ${process.platform}-${process.arch} is installed with this package and ${ENGINE_BINARY_ENV} is not set`,
  };
}

function clip(text: string): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length <= ENGINE_REASON_TEXT_LIMIT
    ? single
    : `${single.slice(0, ENGINE_REASON_TEXT_LIMIT)}…`;
}

interface ProcessOutcome {
  kind: 'exited' | 'timeout' | 'output_too_large' | 'spawn_failed';
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderrTail: string;
  error?: string;
}

function runProcess(
  binary: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<ProcessOutcome> {
  // A JavaScript engine (a development wrapper or a test double) runs under this Node, still
  // without a shell, because Windows cannot execute a script file directly.
  const script = /\.(?:c|m)?js$/iu.test(binary);
  const command = script ? process.execPath : binary;
  const commandArgs = script ? [binary, ...args] : [...args];
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    let ending: ProcessOutcome['kind'] | undefined;
    const child = spawn(command, commandArgs, {
      shell: false,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stop = (kind: ProcessOutcome['kind']): void => {
      ending ??= kind;
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      const reason: unknown = signal?.reason;
      reject(reason instanceof Error ? reason : new Error('The engine call was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) stop('output_too_large');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > ENGINE_STDERR_TAIL_BYTES)
        stderr = stderr.subarray(stderr.length - ENGINE_STDERR_TAIL_BYTES);
    });
    child.on('error', (error) =>
      finish({
        kind: 'spawn_failed',
        code: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderrTail: '',
        error: error.message,
      }),
    );
    child.on('close', (code, exitSignal) =>
      finish({
        kind: ending ?? 'exited',
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout),
        stderrTail: stderr.toString('utf8'),
      }),
    );
    // The engine may exit before reading all of stdin (for example on a usage error).
    child.stdin.on('error', () => undefined);
    child.stdin.end(input, 'utf8');
    if (signal?.aborted === true) onAbort();
  });
}

const engineInvalidSchema = z
  .object({
    schema: z.string(),
    status: z.literal('invalid'),
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();

/** Run one engine subcommand with a JSON request and validate its JSON response. */
export async function runEngineCommand<Response>(
  subcommand: string,
  request: unknown,
  responseSchema: z.ZodType<Response>,
  options: EngineRunOptions = {},
): Promise<EngineResult<Response>> {
  options.signal?.throwIfAborted();
  const located = locateEngineBinary(options);
  if (!('path' in located))
    return {
      available: false,
      outcome: 'unavailable',
      reason: located.reason,
      message: located.message,
    };
  const binary = located;
  const unavailable = (
    reason: EngineUnavailableReason,
    message: string,
  ): EngineResult<Response> => ({
    available: false,
    outcome: 'unavailable',
    reason,
    message,
    binary,
  });
  const timeoutMs = options.timeoutMs ?? ENGINE_DEFAULT_TIMEOUT_MS;
  const outcome = await runProcess(
    binary.path,
    [subcommand, ...(options.args ?? [])],
    JSON.stringify(request),
    options.env ?? process.env,
    timeoutMs,
    options.maxOutputBytes ?? ENGINE_DEFAULT_MAX_OUTPUT_BYTES,
    options.signal,
  );
  if (outcome.kind === 'spawn_failed')
    return unavailable('spawn_failed', `hoi4-engine could not start: ${clip(outcome.error ?? '')}`);
  if (outcome.kind === 'timeout')
    return unavailable(
      'timeout',
      `hoi4-engine ${subcommand} did not finish within ${timeoutMs} ms`,
    );
  if (outcome.kind === 'output_too_large')
    return unavailable(
      'output_too_large',
      `hoi4-engine ${subcommand} printed more than ${options.maxOutputBytes ?? ENGINE_DEFAULT_MAX_OUTPUT_BYTES} bytes`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout.toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (outcome.code === 2) {
    const invalid = engineInvalidSchema.safeParse(parsed);
    if (invalid.success)
      return { available: true, outcome: 'invalid_request', binary, error: invalid.data.error };
  }
  if (outcome.code !== 0)
    return unavailable(
      'exit_status',
      `hoi4-engine ${subcommand} exited with ${outcome.code === null ? `signal ${outcome.signal ?? 'unknown'}` : `code ${outcome.code}`}${outcome.stderrTail.trim() === '' ? '' : `: ${clip(outcome.stderrTail)}`}`,
    );
  if (parsed === undefined)
    return unavailable('invalid_output', `hoi4-engine ${subcommand} did not print JSON`);
  const response = responseSchema.safeParse(parsed);
  if (!response.success)
    return unavailable(
      'invalid_output',
      `hoi4-engine ${subcommand} printed a response that does not match its schema: ${clip(
        response.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; '),
      )}`,
    );
  return { available: true, outcome: 'response', binary, response: response.data };
}

// ---------------------------------------------------------------------------------------------
// focus-layout (engine/crates/focus/schemas/*.json)

export const FOCUS_LAYOUT_REQUEST_SCHEMA = 'hoi4-focus-layout-request/1';
export const FOCUS_LAYOUT_RESPONSE_SCHEMA = 'hoi4-focus-layout/1';

export type FocusLayoutEnginePosition =
  | { mode: 'fixed'; x: number; y: number }
  | { mode: 'relative'; x: number; y: number; relativeTo: string }
  | { mode: 'auto'; preferredX?: number; preferredY?: number };

export interface FocusLayoutEngineRequest {
  schema: typeof FOCUS_LAYOUT_REQUEST_SCHEMA;
  operation: 'layout' | 'insert';
  treeId?: string;
  options?: { nodeSpacing?: number; laneSpacing?: number };
  lanes?: Array<{ id: string; order?: number; minimumX?: number; maximumX?: number }>;
  focuses: Array<{
    id: string;
    prerequisites?: string[][];
    mutuallyExclusive?: string[];
    laneId?: string;
    position?: FocusLayoutEnginePosition;
    pinned?: boolean;
  }>;
  insert?: {
    focusIds: string[];
    anchorId?: string;
    preferSide?: 'left' | 'right' | 'either';
    allowShift?: boolean;
  };
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const shiftSchema = z
  .object({
    fromX: z.number().int(),
    columns: z.number().int().min(1),
    direction: z.enum(['right', 'left']),
    focusIds: z.array(z.string()),
  })
  .strict();

export const focusLayoutEngineResponseSchema = z
  .object({
    schema: z.literal(FOCUS_LAYOUT_RESPONSE_SCHEMA),
    status: z.enum(['ok', 'blocked']),
    operation: z.enum(['layout', 'insert']),
    treeId: z.string().optional(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          x: z.number().int(),
          y: z.number().int(),
          laneId: z.string(),
          moved: z.boolean(),
        })
        .strict(),
    ),
    source: z.array(
      z
        .object({
          id: z.string(),
          relativeTo: z.string().optional(),
          x: z.number().int(),
          y: z.number().int(),
        })
        .strict(),
    ),
    diagnostics: z.array(
      z
        .object({
          code: z.string().regex(/^FOCUS_ENGINE_[A-Z_]+$/u),
          severity: z.enum(['error', 'warning', 'info']),
          focusIds: z.array(z.string()),
          message: z.string(),
          details: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
    metrics: z
      .object({
        columns: z.number().int().min(0),
        rows: z.number().int().min(0),
        orthogonalCrossings: z.number().int().min(0),
        stemsThroughPlaques: z.number().int().min(0),
        mergedBars: z.number().int().min(0),
        durationMicros: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    hashes: z
      .object({
        layout: sha256Schema.nullable(),
        untouched: sha256Schema,
        prerequisites: sha256Schema,
        exclusions: sha256Schema,
      })
      .strict(),
    needsRoom: z
      .object({ shift: z.array(shiftSchema) })
      .strict()
      .optional(),
    shifted: z.array(shiftSchema).optional(),
  })
  .strict();

export type FocusLayoutEngineResponse = z.infer<typeof focusLayoutEngineResponseSchema>;

/** `hoi4-engine focus-layout` with the request on stdin. */
export function runFocusLayoutEngine(
  request: FocusLayoutEngineRequest,
  options: EngineRunOptions = {},
): Promise<EngineResult<FocusLayoutEngineResponse>> {
  return runEngineCommand('focus-layout', request, focusLayoutEngineResponseSchema, options);
}
