import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { glob } from 'glob';
import {
  launchSmokeServer,
  writeSmokeConfig,
  type SmokeServer,
} from '../../tests/helpers/mcp-stdio-smoke.js';
import { buildSyntheticSmokeWorkspace } from '../../tests/helpers/smoke-fixture.js';
import { checkAssertion, matchingItems, type ObservedCall } from './assertions.js';
import {
  findUserRoot,
  locateCorpus,
  pinCorpus,
  type CorpusPin,
  type LocatedCorpus,
} from './corpus.js';
import {
  caseFileSchema,
  corpusFileSchema,
  type BenchCase,
  type CallCase,
  type Corpus,
  type Machine,
  type Surface,
  type SweepCase,
} from './schema.js';

export const BENCH_ROOT = path.resolve(import.meta.dirname, '..', '..', 'bench');
const run = promisify(execFile);

export interface CaseResult {
  id: string;
  surface: Surface;
  corpus: string;
  problem?: number;
  title: string;
  tool: string;
  outcome: 'passed' | 'failed' | 'unavailable' | 'error';
  /** Passed on the inline result alone, without reading an artifact. */
  inline: boolean;
  failures: string[];
  milliseconds: number[];
  budgetMs?: number;
  structuredBytes: number;
  resultStatus?: string;
  resultCode?: string;
  falsePositives?: number;
  files?: number;
  falsePositiveCodes?: Record<string, number>;
  examples?: string[];
}

export interface RunResult {
  suite: string;
  startedAt: string;
  durationMs: number;
  platform: string;
  node: string;
  toolsCommit?: string;
  machine: Machine;
  corpora: CorpusPin[];
  cases: CaseResult[];
}

export interface RunOptions {
  suite: 'synthetic' | 'real';
  /** Only these corpora; all of the suite's when absent. */
  corpora?: string[];
  /** Only cases whose id contains one of these strings. */
  filter?: string[];
  temporaryRoot: string;
  hashContent: boolean;
  /** Where per-file content digests are kept between runs. */
  hashCacheDirectory?: string;
  /** Write each call's structured result here, for writing and debugging cases. */
  dumpDirectory?: string;
  log?: (line: string) => void;
}

export async function loadCorpora(): Promise<Corpus[]> {
  const file = corpusFileSchema.parse(
    JSON.parse(await readFile(path.join(BENCH_ROOT, 'corpus.json'), 'utf8')),
  );
  return file.corpora;
}

export async function loadCases(): Promise<BenchCase[]> {
  const directory = path.join(BENCH_ROOT, 'cases');
  const cases: BenchCase[] = [];
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.json')).sort()) {
    const parsed = caseFileSchema.safeParse(
      JSON.parse(await readFile(path.join(directory, name), 'utf8')),
    );
    if (!parsed.success)
      throw new Error(
        `bench/cases/${name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    cases.push(...parsed.data.cases);
  }
  const seen = new Set<string>();
  for (const benchCase of cases) {
    if (seen.has(benchCase.id)) throw new Error(`Duplicate benchmark case id ${benchCase.id}`);
    seen.add(benchCase.id);
  }
  return cases;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

/** The p95 a case is judged on: the warm repeats when there are any, else the only call. */
export function caseLatency(result: CaseResult): number | undefined {
  if (result.milliseconds.length === 0) return undefined;
  return percentile(result.milliseconds, 0.95);
}

async function readArtifact(
  server: SmokeServer,
  structured: unknown,
  prefix: string,
): Promise<unknown> {
  const artifacts =
    (structured as { artifacts?: Array<{ uri: string; name: string; mimeType: string }> })
      .artifacts ?? [];
  const artifact = artifacts.find(({ name }) => name.startsWith(prefix));
  if (artifact === undefined) return undefined;
  const read = await server.client.readResource({ uri: artifact.uri });
  const text = read.contents
    .map((content) => ('text' in content && typeof content.text === 'string' ? content.text : ''))
    .join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function textField(structured: unknown, key: string): string {
  const value = (structured as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function observed(result: Awaited<ReturnType<SmokeServer['call']>>): ObservedCall {
  return {
    structured: result.structured,
    text: result.text,
    isError: result.isError,
    structuredBytes: result.structuredBytes,
    milliseconds: result.milliseconds,
  };
}

async function runCall(
  server: SmokeServer,
  benchCase: CallCase,
  workspaceId: string,
  dumpDirectory?: string,
): Promise<CaseResult> {
  const args = { workspaceId, ...benchCase.arguments };
  const milliseconds: number[] = [];
  const base: CaseResult = {
    id: benchCase.id,
    surface: benchCase.surface,
    corpus: benchCase.corpus,
    ...(benchCase.problem === undefined ? {} : { problem: benchCase.problem }),
    title: benchCase.title,
    tool: benchCase.tool,
    outcome: 'failed',
    inline: false,
    failures: [],
    milliseconds,
    ...(benchCase.budgetMs === undefined ? {} : { budgetMs: benchCase.budgetMs }),
    structuredBytes: 0,
  };
  let result: Awaited<ReturnType<SmokeServer['call']>> | undefined;
  try {
    // A warm case is called once before it is measured; a cold one is measured on first touch.
    if (benchCase.timing === 'warm') await server.call(benchCase.tool, benchCase.id, args);
    for (let attempt = 0; attempt < benchCase.repeat; attempt++) {
      result = await server.call(benchCase.tool, benchCase.id, args);
      milliseconds.push(result.milliseconds);
    }
  } catch (error) {
    return {
      ...base,
      outcome: 'error',
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (result === undefined) return { ...base, outcome: 'error', failures: ['no call was made'] };
  const call = observed(result);
  if (dumpDirectory !== undefined) {
    await mkdir(dumpDirectory, { recursive: true });
    await writeFile(
      path.join(dumpDirectory, `${benchCase.id}.json`),
      `${JSON.stringify({ text: call.text, structured: call.structured }, null, 2)}\n`,
    );
  }
  const failures: string[] = [];
  let usedArtifact = false;
  for (const assertion of benchCase.expect) {
    let target = call;
    if (assertion.artifact !== undefined) {
      usedArtifact = true;
      const content = await readArtifact(server, call.structured, assertion.artifact);
      if (content === undefined) {
        failures.push(`no artifact named ${assertion.artifact}*`);
        continue;
      }
      target = { ...call, structured: content };
    }
    const failure = checkAssertion(assertion, target);
    if (failure !== null) failures.push(failure);
  }
  return {
    ...base,
    outcome: failures.length === 0 ? 'passed' : 'failed',
    inline: failures.length === 0 && !usedArtifact,
    failures,
    structuredBytes: call.structuredBytes,
    resultStatus: textField(call.structured, 'status'),
    resultCode: textField(call.structured, 'code'),
  };
}

/** Sorted matches of the globs, thinned evenly to `limit` so a sweep stays a fixed sample. */
export async function sweepFiles(root: string, benchCase: SweepCase): Promise<string[]> {
  const matches = new Set<string>();
  for (const pattern of benchCase.files)
    for (const file of await glob(pattern, {
      cwd: root,
      nodir: true,
      posix: true,
      dot: false,
      ignore: benchCase.exclude,
    }))
      matches.add(file.replaceAll('\\', '/'));
  const sorted = [...matches].sort();
  if (benchCase.limit === undefined || sorted.length <= benchCase.limit) return sorted;
  const step = sorted.length / benchCase.limit;
  return Array.from({ length: benchCase.limit }, (_, index) => sorted[Math.floor(index * step)]!);
}

function substitute(value: unknown, file: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{path}', file);
  if (Array.isArray(value)) return value.map((item) => substitute(item, file));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, file)]),
    );
  return value;
}

async function runSweep(
  server: SmokeServer,
  benchCase: SweepCase,
  workspaceId: string,
  root: string,
  log: (line: string) => void,
): Promise<CaseResult> {
  const files = await sweepFiles(root, benchCase);
  const milliseconds: number[] = [];
  const codes: Record<string, number> = {};
  const examples: string[] = [];
  const failures: string[] = [];
  let falsePositives = 0;
  for (const [index, file] of files.entries()) {
    if (index % 100 === 0) log(`  ${benchCase.id}: ${index}/${files.length}`);
    let result;
    try {
      result = await server.call(benchCase.tool, benchCase.id, {
        workspaceId,
        ...(substitute(benchCase.arguments, file) as Record<string, unknown>),
      });
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    milliseconds.push(result.milliseconds);
    if (result.isError) {
      failures.push(`${file}: tool error ${result.structured.code}`);
      continue;
    }
    const items = matchingItems(
      result.structured,
      benchCase.falsePositives.path,
      benchCase.falsePositives.where,
    ).filter(
      (item) =>
        !benchCase.knownErrors.some(
          (known) => known.file === file && known.line === item.line && known.code === item.code,
        ),
    );
    falsePositives += items.length;
    for (const item of items) {
      const code = typeof item.code === 'string' ? item.code : 'UNKNOWN';
      codes[code] = (codes[code] ?? 0) + 1;
      if (examples.length < 20)
        examples.push(
          `${file}${typeof item.line === 'number' ? `:${item.line}` : ''} ${code}${typeof item.command === 'string' ? ` (${item.command})` : ''}`,
        );
    }
  }
  return {
    id: benchCase.id,
    surface: benchCase.surface,
    corpus: benchCase.corpus,
    ...(benchCase.problem === undefined ? {} : { problem: benchCase.problem }),
    title: benchCase.title,
    tool: benchCase.tool,
    outcome: falsePositives === 0 && failures.length === 0 ? 'passed' : 'failed',
    inline: falsePositives === 0 && failures.length === 0,
    failures: [
      ...failures.slice(0, 20),
      ...(falsePositives > 0 ? [`${falsePositives} false positives`] : []),
    ],
    milliseconds,
    structuredBytes: 0,
    falsePositives,
    files: files.length,
    falsePositiveCodes: codes,
    examples,
  };
}

/** Latency depends on the machine, so every run names it and the engine binary it used. */
export async function describeMachine(): Promise<Machine> {
  const cpus = os.cpus();
  const engine = process.env.HOI4_ENGINE;
  let engineSha256: string | undefined;
  if (engine !== undefined && engine !== '') {
    try {
      engineSha256 = createHash('sha256')
        .update(await readFile(engine))
        .digest('hex');
    } catch {
      engineSha256 = undefined;
    }
  }
  return {
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cores: Math.max(1, cpus.length),
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    ...(engineSha256 === undefined ? {} : { engineSha256 }),
  };
}

async function gitHead(): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', [
      '-C',
      path.resolve(BENCH_ROOT, '..'),
      'rev-parse',
      'HEAD',
    ]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Builds the synthetic corpus: the CI smoke workspace plus the hand-written regression mod. */
async function prepareSynthetic(temporaryRoot: string): Promise<{
  mod: string;
  game: string;
  userRoot: string;
}> {
  const built = await buildSyntheticSmokeWorkspace(path.join(temporaryRoot, 'synthetic'));
  await cp(path.join(BENCH_ROOT, 'fixtures', 'synthetic'), built.mod, {
    recursive: true,
    force: true,
  });
  return built;
}

export async function runSuite(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const corpora = (await loadCorpora()).filter(
    (corpus) =>
      (options.suite === 'synthetic') === (corpus.kind === 'synthetic') &&
      (options.corpora === undefined || options.corpora.includes(corpus.id)),
  );
  const cases = (await loadCases()).filter(
    (benchCase) =>
      corpora.some(({ id }) => id === benchCase.corpus) &&
      (options.filter === undefined || options.filter.some((part) => benchCase.id.includes(part))),
  );
  const located: LocatedCorpus[] = [];
  const workspaces: Array<Record<string, unknown>> = [];
  const extra: Record<string, unknown> = {};
  const roots = new Map<string, string>();
  for (const corpus of corpora) {
    if (corpus.kind === 'synthetic') {
      const built = await prepareSynthetic(options.temporaryRoot);
      workspaces.push({
        id: corpus.id,
        name: corpus.name,
        root: built.mod,
        gameRoot: built.game,
        includeGameDlc: false,
      });
      extra.gameUserRoot = built.userRoot;
      roots.set(corpus.id, built.mod);
      located.push({ corpus, root: built.mod });
      continue;
    }
    const found = await locateCorpus(corpus);
    located.push(found);
    if (found.root === undefined) continue;
    if (corpus.kind === 'game') {
      const emptyMod = path.join(options.temporaryRoot, 'vanilla-mod');
      await mkdir(emptyMod, { recursive: true });
      await writeFile(path.join(emptyMod, 'descriptor.mod'), 'name="Benchmark vanilla"\n');
      workspaces.push({ id: corpus.id, name: corpus.name, root: emptyMod, gameRoot: found.root });
      roots.set(corpus.id, found.root);
    } else {
      const game = located.find(({ corpus: other }) => other.kind === 'game')?.root;
      workspaces.push({
        id: corpus.id,
        name: corpus.name,
        root: found.root,
        ...(game === undefined ? {} : { gameRoot: game }),
      });
      roots.set(corpus.id, found.root);
    }
  }
  if (options.suite === 'real') {
    const userRoot = await findUserRoot();
    if (userRoot !== undefined) extra.gameUserRoot = userRoot;
  }
  const pins: CorpusPin[] = [];
  for (const entry of located) {
    log(`pinning ${entry.corpus.id}`);
    pins.push(
      await pinCorpus(
        entry,
        options.hashContent && entry.corpus.kind !== 'synthetic',
        options.hashCacheDirectory,
      ),
    );
  }
  const results: CaseResult[] = [];
  const unavailable = new Map(
    located
      .filter(({ unavailable }) => unavailable !== undefined)
      .map((entry) => [entry.corpus.id, entry.unavailable!]),
  );
  for (const benchCase of cases)
    if (unavailable.has(benchCase.corpus))
      results.push({
        id: benchCase.id,
        surface: benchCase.surface,
        corpus: benchCase.corpus,
        title: benchCase.title,
        tool: benchCase.tool,
        outcome: 'unavailable',
        inline: false,
        failures: [unavailable.get(benchCase.corpus)!],
        milliseconds: [],
        structuredBytes: 0,
      });
  const runnable = cases.filter((benchCase) => !unavailable.has(benchCase.corpus));
  if (runnable.length > 0) {
    const config = await writeSmokeConfig(
      path.join(options.temporaryRoot, 'config'),
      workspaces,
      extra,
    );
    const server = await launchSmokeServer(config);
    try {
      // Cold cases measure the first touch of a corpus, so they run before everything else.
      const ordered = [
        ...runnable.filter((benchCase) => benchCase.kind === 'call' && benchCase.timing === 'cold'),
        ...runnable.filter(
          (benchCase) => !(benchCase.kind === 'call' && benchCase.timing === 'cold'),
        ),
      ];
      for (const benchCase of ordered) {
        log(benchCase.id);
        const result =
          benchCase.kind === 'sweep'
            ? await runSweep(server, benchCase, benchCase.corpus, roots.get(benchCase.corpus)!, log)
            : await runCall(server, benchCase, benchCase.corpus, options.dumpDirectory);
        log(
          `  ${result.outcome} ${result.milliseconds.join(',')} ms${result.failures.length > 0 ? ` - ${result.failures[0]}` : ''}`,
        );
        results.push(result);
      }
    } finally {
      await server.close();
    }
  }
  const order = new Map(cases.map((benchCase, index) => [benchCase.id, index]));
  results.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const toolsCommit = await gitHead();
  return {
    suite: options.suite,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ...(toolsCommit === undefined ? {} : { toolsCommit }),
    machine: await describeMachine(),
    corpora: pins,
    cases: results,
  };
}
