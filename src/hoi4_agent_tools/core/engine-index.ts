import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { locateEngineBinary } from './engine-client.js';
import { SymbolIndex, type EngineIndexFileAnswer, type EngineIndexFileRequest } from './index.js';
import { sharedResidentEngine, type ResidentEngine } from './resident-engine.js';
import { ServiceError } from './result.js';
import type { Diagnostic, SourceLocation } from './diagnostics.js';
import type { SymbolKind } from './index.js';
import type { ScannedFile } from './scanner.js';

/**
 * The shared symbol index built by the Rust engine (`hoi4-engine index-files`, ADR 0085). The
 * engine parses and walks the files; `SymbolIndex.fromEngine` keeps the bookkeeping across them.
 *
 * Files are named by path with the SHA-256 the scan read. A file the engine cannot read with that
 * hash (a proposed rewrite in memory, or an edit since the scan) comes back as `retry`, and its
 * bytes go in a second request. A missing or failing engine is `ENGINE_UNAVAILABLE`.
 */

export const INDEX_FILES_REQUEST_SCHEMA = 'hoi4-index-files-request/1';
const INDEX_FILES_TIMEOUT_MS = 300_000;
const STDERR_MAX_BYTES = 1024 * 1024;

/** Start line, column and UTF-16 offset, then the end's; the path and symbol are added here. */
type Loc = [number, number, number, number, number, number];

interface RawAnswer {
  symbols: Array<[SymbolKind, string, Loc | null, Record<string, unknown>]>;
  references: Array<[string, string, SymbolKind, string, Loc]>;
  diagnostics: Diagnostic[];
  skip: Diagnostic[] | null;
  incomplete: boolean;
}
type Answer = { retry: true } | RawAnswer;

const diagnostic = z.looseObject({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error', 'blocker']),
  category: z.string(),
  message: z.string(),
});
const diagnostics = z.array(diagnostic);

const isLoc = (value: unknown): value is Loc =>
  Array.isArray(value) && value.length === 6 && value.every((part) => typeof part === 'number');

/**
 * A structural check of each answer. Records are checked by shape, not by schema, because a
 * workspace has hundreds of thousands of them; the diagnostics are few and fully checked.
 */
function checkAnswer(value: unknown): Answer {
  if (typeof value !== 'object' || value === null) throw outOfShape();
  const answer = value as Partial<RawAnswer> & { retry?: unknown };
  if (answer.retry === true) return { retry: true };
  if (
    !Array.isArray(answer.symbols) ||
    !Array.isArray(answer.references) ||
    typeof answer.incomplete !== 'boolean' ||
    !diagnostics.safeParse(answer.diagnostics).success ||
    (answer.skip !== null && !diagnostics.safeParse(answer.skip).success)
  )
    throw outOfShape();
  for (const symbol of answer.symbols as unknown[])
    if (
      !Array.isArray(symbol) ||
      symbol.length !== 4 ||
      typeof symbol[0] !== 'string' ||
      typeof symbol[1] !== 'string' ||
      (symbol[2] !== null && !isLoc(symbol[2])) ||
      typeof symbol[3] !== 'object' ||
      symbol[3] === null
    )
      throw outOfShape();
  for (const reference of answer.references as unknown[])
    if (
      !Array.isArray(reference) ||
      reference.length !== 5 ||
      reference.slice(0, 4).some((part) => typeof part !== 'string') ||
      !isLoc(reference[4])
    )
      throw outOfShape();
  return answer as RawAnswer;
}

/** The answer with full `SourceLocation`s: the file's display path, and the symbol it names. */
function located(answer: RawAnswer, file: ScannedFile): EngineIndexFileAnswer {
  const location = (loc: Loc, symbol?: string): SourceLocation => ({
    path: file.displayPath,
    start: { line: loc[0], column: loc[1], offset: loc[2] },
    end: { line: loc[3], column: loc[4], offset: loc[5] },
    ...(symbol === undefined ? {} : { symbol }),
  });
  return {
    symbols: answer.symbols.map(([kind, id, loc, metadata]) => [
      kind,
      id,
      // A localisation key's location names no symbol, as `locationFor` gives it.
      loc === null ? null : location(loc, kind === 'localisation' ? undefined : id),
      metadata,
    ]),
    references: answer.references.map(([kind, from, toKind, to, loc]) => [
      kind,
      from,
      toKind,
      to,
      location(loc, from),
    ]),
    diagnostics: answer.diagnostics,
    skip: answer.skip,
    incomplete: answer.incomplete,
  };
}

const EMPTY: EngineIndexFileAnswer = {
  symbols: [],
  references: [],
  diagnostics: [],
  skip: null,
  incomplete: false,
};

/** Whether `indexFile` reads anything from this file (the rest are answered locally, empty). */
function indexed(request: EngineIndexFileRequest): boolean {
  const lower = request.file.relativePath.toLowerCase();
  if (lower.endsWith('.yml') || request.definitionFile) return true;
  if (
    lower.endsWith('adjacencies.csv') ||
    lower.endsWith('supply_nodes.txt') ||
    lower.endsWith('railways.txt')
  )
    return true;
  return /\.(?:txt|gui|gfx)$/u.test(lower) && request.file.bytes.includes(0x3d);
}

interface Frame {
  header: Record<string, unknown>;
  payload: Buffer;
}

function frame(requests: readonly EngineIndexFileRequest[], inline: boolean): Frame {
  const parts: Buffer[] = [];
  let offset = 0;
  const files = requests.map(({ file, definitionFile, owned, shadowed }) => {
    const common = {
      displayPath: file.displayPath,
      relativePath: file.relativePath,
      definitionFile,
      owned,
      shadowed,
    };
    if (!inline && path.isAbsolute(file.absolutePath))
      return { ...common, path: file.absolutePath, sha256: file.sha256 };
    parts.push(file.bytes);
    const at = [offset, file.bytes.length];
    offset += file.bytes.length;
    return { ...common, payload: at };
  });
  const payload = Buffer.concat(parts);
  return {
    header: { schema: INDEX_FILES_REQUEST_SCHEMA, files, payload: payload.length },
    payload,
  };
}

function outOfShape(): ServiceError {
  return new ServiceError('ENGINE_UNAVAILABLE', 'hoi4-engine index-files answered out of shape', {
    reason: 'invalid_output',
  });
}

function parseResponse(value: unknown): Answer[] {
  const response = value as { schema?: unknown; files?: unknown } | null;
  if (response?.schema !== 'hoi4-index-files/1' || !Array.isArray(response.files))
    throw outOfShape();
  return response.files.map(checkAnswer);
}

/** Keep the answers of a pass; returns the requests answered with `retry`. */
function keep(
  asked: readonly EngineIndexFileRequest[],
  answers: readonly Answer[],
  into: Map<EngineIndexFileRequest, EngineIndexFileAnswer>,
  retryAllowed: boolean,
): EngineIndexFileRequest[] {
  if (answers.length !== asked.length) throw outOfShape();
  const retry: EngineIndexFileRequest[] = [];
  for (const [position, request] of asked.entries()) {
    const answer = answers[position]!;
    if ('retry' in answer) {
      if (!retryAllowed) throw outOfShape();
      retry.push(request);
    } else into.set(request, located(answer, request.file));
  }
  return retry;
}

function inOrder(
  requests: readonly EngineIndexFileRequest[],
  answers: ReadonlyMap<EngineIndexFileRequest, EngineIndexFileAnswer>,
): EngineIndexFileAnswer[] {
  return requests.map((request) => answers.get(request) ?? EMPTY);
}

function runSync({ header, payload }: Frame): unknown {
  const located = locateEngineBinary();
  if (!('path' in located))
    throw new ServiceError('ENGINE_UNAVAILABLE', located.message, { reason: located.reason });
  const script = /\.(?:c|m)?js$/iu.test(located.path);
  // The frames go through files, as for the map raster: a synchronous call that moved large
  // frames through the child's pipes hung until its timeout on macOS runners.
  const directory = mkdtempSync(path.join(tmpdir(), 'hoi4-index-files-'));
  const inputPath = path.join(directory, 'request');
  const outputPath = path.join(directory, 'answer');
  let child: SpawnSyncReturns<Buffer>;
  let output: Buffer;
  try {
    writeFileSync(
      inputPath,
      Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), payload]),
    );
    const args = ['index-files', '--input', inputPath, '--output', outputPath];
    child = spawnSync(
      script ? process.execPath : located.path,
      script ? [located.path, ...args] : args,
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: STDERR_MAX_BYTES,
        timeout: INDEX_FILES_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
      },
    );
    output = existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (child.error !== undefined)
    throw new ServiceError(
      'ENGINE_UNAVAILABLE',
      `hoi4-engine index-files: ${child.error.message}`,
      {
        reason: 'spawn_failed',
      },
    );
  let line: unknown;
  try {
    line = JSON.parse(output.toString('utf8'));
  } catch {
    throw new ServiceError(
      'ENGINE_UNAVAILABLE',
      `hoi4-engine index-files gave no answer (exit ${child.status ?? 'none'}): ${child.stderr.toString('utf8').slice(-300)}`,
      { reason: 'invalid_output' },
    );
  }
  const answer = line as {
    ok?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (answer.ok !== true) {
    const message = typeof answer.error?.message === 'string' ? answer.error.message : 'no reason';
    const code = typeof answer.error?.code === 'string' ? answer.error.code : 'unknown';
    throw new ServiceError(
      'ENGINE_UNAVAILABLE',
      `hoi4-engine index-files refused the request: ${message}`,
      { reason: 'invalid_output', code },
    );
  }
  return answer.result;
}

/** The shared index of `files`, synchronously, from a one-shot engine. */
export function engineSymbolIndexSync(files: readonly ScannedFile[]): SymbolIndex {
  const requests = SymbolIndex.engineRequestFiles(files);
  const wanted = requests.filter(indexed);
  const answers = new Map<EngineIndexFileRequest, EngineIndexFileAnswer>();
  if (wanted.length > 0) {
    const retry = keep(wanted, parseResponse(runSync(frame(wanted, false))), answers, true);
    if (retry.length > 0) keep(retry, parseResponse(runSync(frame(retry, true))), answers, false);
  }
  return SymbolIndex.fromEngine(files, inOrder(requests, answers));
}

/** The shared index of `files` from the resident engine (ADR 0077). */
export async function engineSymbolIndex(
  files: readonly ScannedFile[],
  signal?: AbortSignal,
  engine: ResidentEngine = sharedResidentEngine(),
): Promise<SymbolIndex> {
  const run = async ({ header, payload }: Frame): Promise<unknown> => {
    const { payload: _count, ...body } = header;
    const outcome = await engine.request('index.files', body, payload, {
      timeoutMs: INDEX_FILES_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!outcome.ok)
      throw new ServiceError(
        'ENGINE_UNAVAILABLE',
        outcome.message,
        outcome.kind === 'unavailable' ? { reason: outcome.reason } : { code: outcome.code },
      );
    return JSON.parse(outcome.response.payload.toString('utf8')) as unknown;
  };
  const requests = SymbolIndex.engineRequestFiles(files);
  const wanted = requests.filter(indexed);
  const answers = new Map<EngineIndexFileRequest, EngineIndexFileAnswer>();
  if (wanted.length > 0) {
    const retry = keep(wanted, parseResponse(await run(frame(wanted, false))), answers, true);
    if (retry.length > 0) keep(retry, parseResponse(await run(frame(retry, true))), answers, false);
  }
  return SymbolIndex.fromEngine(files, inOrder(requests, answers));
}
