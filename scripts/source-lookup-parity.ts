import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine, defaultPatterns } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import {
  SOURCE_ROOT_KINDS,
  modIndexEngineRequest,
} from '../src/hoi4_agent_tools/reference/mod-index.js';
import { nearestNames } from '../src/hoi4_agent_tools/reference/suggestions.js';
import { sourceLookupEngineResponseSchema } from '../src/hoi4_agent_tools/schemas/mod-tools.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * Parity check for `hoi4.source_lookup` on the shared Rust engine (M-8, ADR 0082). On each
 * workspace it runs the TypeScript shared scan (`CoreEngine.scan`, which built the old answer) and
 * `hoi4-engine source-lookup`, for sampled symbols of every kind and a few misses, and diffs the
 * scan revision, completeness, the definitions (kind, file, load order, overridden, lines, order),
 * their count and distinct kinds, and the near-miss names.
 *
 *   npx tsx scripts/source-lookup-parity.ts [--config FILE] [--corpus vanilla,zin] [--out FILE]
 *
 * Configuration and corpora are found as in `scripts/mod-index-parity.ts`. The engine is
 * `HOI4_ENGINE` or the package's bundled binary. Exit status 1 when anything differs.
 */

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    corpus: { type: 'string' },
    out: { type: 'string' },
    'per-kind': { type: 'string', default: '1' },
    'max-lookups': { type: 'string', default: '40' },
    'max-samples': { type: 'string', default: '12' },
  },
});

function defaultConfigPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.platform === 'win32'
    ? path.join(appData, 'hoi4-agent-tools', 'config.json')
    : path.join(os.homedir(), '.config', 'hoi4-agent-tools', 'config.json');
}

const perKind = Number(values['per-kind']);
const maxLookups = Number(values['max-lookups']);
const maxSamples = Number(values['max-samples']);
const serverConfig = JSON.parse(await readFile(values.config ?? defaultConfigPath(), 'utf8')) as {
  gameRoot?: string;
  modRoots?: string[];
};
if (serverConfig.modRoots?.[0] !== undefined && process.env.HOI4_MOD_ROOT === undefined)
  process.env.HOI4_MOD_ROOT = serverConfig.modRoots[0];
if (serverConfig.gameRoot !== undefined && process.env.HOI4_GAME_ROOT === undefined)
  process.env.HOI4_GAME_ROOT = serverConfig.gameRoot;
const located = locateEngineBinary();
if (!('path' in located)) {
  process.stderr.write(`${located.message}\n`);
  process.exit(2);
}
const binary = located.path;

function runEngine(request: unknown): { response: unknown; milliseconds: number } {
  const started = performance.now();
  const run = spawnSync(binary, ['source-lookup'], {
    input: JSON.stringify(request),
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  const milliseconds = Math.round(performance.now() - started);
  if (run.status !== 0)
    throw new Error(
      `hoi4-engine source-lookup exited with ${String(run.status)}: ${run.stdout.toString('utf8').slice(0, 500)}`,
    );
  return { response: JSON.parse(run.stdout.toString('utf8')), milliseconds };
}

function nearestOf(candidates: ReadonlyArray<{ id: string; distance: number }>): string[] {
  return [...candidates]
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id, 'en'))
    .slice(0, 5)
    .map(({ id }) => id);
}

const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-source-lookup-parity-'));
const report: Record<string, unknown> = {};
let differs = false;
try {
  for (const corpus of corpora) {
    const found = await locateCorpus(corpus);
    if (found.root === undefined) {
      process.stderr.write(`${corpus.id}: ${found.unavailable ?? 'not found'}\n`);
      report[corpus.id] = { unavailable: found.unavailable };
      continue;
    }
    let root = found.root;
    const gameRoot = corpus.kind === 'game' ? found.root : serverConfig.gameRoot;
    if (corpus.kind === 'game') {
      root = path.join(temporary, 'vanilla-mod');
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'descriptor.mod'), 'name="Parity vanilla"\n');
    }
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state', corpus.id),
        workspaces: [
          {
            id: 'parity',
            name: corpus.name,
            root,
            ...(gameRoot === undefined ? {} : { gameRoot }),
          },
        ],
      }),
    );
    const engine = new CoreEngine(resolver, { persistentAnalysisCache: null });
    const workspace = resolver.get('parity');
    const entry: Record<string, unknown> = {};
    const scopes: Array<{ name: string; patterns: string[] | undefined; kind?: string }> = [
      { name: 'workspace', patterns: undefined },
      { name: 'events', patterns: ['events/**/*.txt'], kind: 'event' },
    ];
    for (const scope of scopes) {
      process.stderr.write(`${corpus.id} ${scope.name}: TypeScript scan\n`);
      const started = performance.now();
      const snapshot = await engine.scan(
        'parity',
        scope.patterns === undefined ? {} : { patterns: scope.patterns },
      );
      const typescriptMs = Math.round(performance.now() - started);
      const base = {
        ...modIndexEngineRequest(workspace, resolver.config(), SOURCE_ROOT_KINDS),
        schema: 'hoi4-source-lookup-request/1',
        patterns: scope.patterns ?? defaultPatterns(workspace),
      };
      // Sampled symbols: a few of every kind (first, middle, last), plus misses.
      const byKind = new Map<string, string[]>();
      for (const symbol of snapshot.index.symbols) {
        if (scope.kind !== undefined && symbol.kind !== scope.kind) continue;
        const list = byKind.get(symbol.kind) ?? [];
        list.push(symbol.id);
        byKind.set(symbol.kind, list);
      }
      const samples: Array<{ symbol: string; kind: string | undefined }> = [];
      for (const [kind, ids] of byKind) {
        const unique = [...new Set(ids)];
        const picks = new Set([
          0,
          Math.floor(unique.length / 2),
          unique.length - 1,
          ...Array.from({ length: perKind }, (_, n) =>
            Math.floor((unique.length * (n + 1)) / (perKind + 2)),
          ),
        ]);
        for (const index of picks)
          if (unique[index] !== undefined) samples.push({ symbol: unique[index], kind });
      }
      const anyKind = samples.slice(0, 20).map(({ symbol }) => ({ symbol, kind: undefined }));
      const misses = samples.slice(0, 6).flatMap(({ symbol, kind }) => [
        { symbol: `${symbol}x`, kind },
        { symbol: symbol.slice(0, -1), kind: undefined },
      ]);
      const checked: Array<Record<string, unknown>> = [];
      let engineMs = 0;
      const everything = [...samples, ...anyKind, ...misses];
      const stride = Math.max(1, Math.floor(everything.length / maxLookups));
      const chosen = everything.filter((_, index) => index % stride === 0).slice(0, maxLookups);
      // Misses are the cheapest to get wrong, so they always run.
      for (const sample of [...new Set([...chosen, ...misses])]) {
        const request = {
          ...base,
          symbol: sample.symbol,
          ...(sample.kind === undefined ? {} : { kind: sample.kind }),
          maxDefinitions: 3,
        };
        const { response, milliseconds } = runEngine(request);
        engineMs += milliseconds;
        const answer = sourceLookupEngineResponseSchema.parse(response);
        const matched = snapshot.index.symbols
          .filter(
            (symbolEntry) =>
              symbolEntry.id === sample.symbol &&
              (sample.kind === undefined || symbolEntry.kind === sample.kind),
          )
          .sort(
            (left, right) =>
              Number(left.overridden) - Number(right.overridden) ||
              right.loadOrder - left.loadOrder,
          );
        const expected = {
          revision: snapshot.revision,
          complete: snapshot.complete,
          skippedSourceCount: snapshot.skippedSourceCount,
          definitionCount: matched.length,
          kindCount: new Set(matched.map(({ kind }) => kind)).size,
          definitions: matched.slice(0, 3).map((definition) => ({
            kind: definition.kind,
            id: definition.id,
            path: definition.path,
            rootKind: definition.rootKind,
            loadOrder: definition.loadOrder,
            overridden: definition.overridden,
            sourceShadowed: definition.sourceShadowed,
            startLine: definition.location?.start.line ?? 0,
            endLine: definition.location?.end.line ?? 0,
          })),
          suggestions:
            matched.length === 0
              ? nearestNames(
                  sample.symbol,
                  new Set(
                    snapshot.index.symbols
                      .filter(
                        (symbolEntry) =>
                          sample.kind === undefined || symbolEntry.kind === sample.kind,
                      )
                      .map(({ id }) => id),
                  ),
                )
              : [],
        };
        const actual = {
          revision: answer.revision,
          complete: answer.complete,
          skippedSourceCount: answer.skippedSourceCount,
          definitionCount: answer.definitionCount,
          kindCount: answer.kindCount,
          definitions: answer.definitions.map(
            ({ absolutePath: _absolutePath, sha256: _sha256, ...rest }) => rest,
          ),
          suggestions: answer.definitionCount === 0 ? nearestOf(answer.suggestionCandidates) : [],
        };
        const equal = JSON.stringify(expected) === JSON.stringify(actual);
        if (!equal) {
          differs = true;
          if (checked.filter(({ equal: ok }) => !ok).length < maxSamples)
            checked.push({ ...sample, equal, expected, actual });
        }
      }
      const total = new Set([...chosen, ...misses]).size;
      entry[scope.name] = {
        typescriptScanMs: typescriptMs,
        engineMsTotal: engineMs,
        engineMsPerCall: Math.round(engineMs / Math.max(1, total)),
        sampled: total,
        differing: checked,
      };
      process.stderr.write(
        `${corpus.id} ${scope.name}: ${total} lookups, ${checked.length} differing; TypeScript scan ${typescriptMs} ms, engine ${Math.round(engineMs / Math.max(1, total))} ms per call\n`,
      );
    }
    engine.releaseScanCaches();
    report[corpus.id] = entry;
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (values.out === undefined) process.stdout.write(text);
else await writeFile(values.out, text);
process.exit(differs ? 1 : 0);
