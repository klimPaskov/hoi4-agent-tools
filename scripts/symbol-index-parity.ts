import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { engineSymbolIndex } from '../src/hoi4_agent_tools/core/engine-index.js';
import type { SymbolIndex } from '../src/hoi4_agent_tools/core/index.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * Parity check for the shared symbol index on the Rust engine (ADR 0085, step 5 of M-8). On each
 * workspace it runs the TypeScript scan and index (`CoreEngine.scan`), then builds the index of
 * the same files from `hoi4-engine index-files` (`engineSymbolIndex`), and compares every symbol
 * (kind, id, file, location, metadata, overridden, sourceShadowed), every reference, every
 * diagnostic, the skipped sources, completeness and the file list, in order.
 *
 *   npx tsx scripts/symbol-index-parity.ts [--config FILE] [--corpus vanilla,zin] [--out FILE]
 *
 * Configuration and corpora are found as in `scripts/source-lookup-parity.ts`. The engine is
 * `HOI4_ENGINE` or the package's bundled binary. Exit status 1 when anything differs.
 */

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    corpus: { type: 'string' },
    out: { type: 'string' },
  },
});

function defaultConfigPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.platform === 'win32'
    ? path.join(appData, 'hoi4-agent-tools', 'config.json')
    : path.join(os.homedir(), '.config', 'hoi4-agent-tools', 'config.json');
}

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

/** Each part of an index as canonical JSON lines, so a difference names its position. */
function parts(index: SymbolIndex): Record<string, string[]> {
  const lines = (items: readonly unknown[]) => items.map((item) => canonicalJson(item));
  return {
    symbols: lines(index.symbols),
    references: lines(index.references),
    diagnostics: lines(index.diagnostics),
    skippedSources: lines(index.skippedSources),
    coverage: lines([
      {
        complete: index.complete,
        skippedSourceCount: index.skippedSourceCount,
        skippedPossibleSymbolKinds: index.skippedPossibleSymbolKinds,
      },
    ]),
    files: [...index.files.keys()],
  };
}

const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-symbol-index-parity-'));
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
    let started = performance.now();
    const snapshot = await engine.scan('parity');
    const typescriptMs = Math.round(performance.now() - started);
    started = performance.now();
    const fromEngine = await engineSymbolIndex(snapshot.files);
    const engineMs = Math.round(performance.now() - started);
    // A second call reads the files again: the engine keeps no cache yet.
    started = performance.now();
    await engineSymbolIndex(snapshot.files);
    const engineAgainMs = Math.round(performance.now() - started);
    const left = parts(snapshot.index);
    const right = parts(fromEngine);
    const differences: Record<string, unknown> = {};
    for (const key of Object.keys(left)) {
      const a = left[key]!;
      const b = right[key]!;
      const first = a.findIndex((line, position) => line !== b[position]);
      if (a.length !== b.length || first >= 0)
        differences[key] = {
          typescript: a.length,
          engine: b.length,
          firstDifference: first >= 0 ? first : Math.min(a.length, b.length),
          typescriptLine: a[first >= 0 ? first : Math.min(a.length, b.length)]?.slice(0, 600),
          engineLine: b[first >= 0 ? first : Math.min(a.length, b.length)]?.slice(0, 600),
          differing: a.filter((line, position) => line !== b[position]).length,
        };
    }
    differs ||= Object.keys(differences).length > 0;
    const entry = {
      files: snapshot.files.length,
      symbols: left.symbols!.length,
      references: left.references!.length,
      diagnostics: left.diagnostics!.length,
      complete: snapshot.index.complete,
      differences,
      typescriptScanAndIndexMs: typescriptMs,
      engineIndexMs: engineMs,
      engineIndexAgainMs: engineAgainMs,
    };
    report[corpus.id] = entry;
    process.stderr.write(
      `${corpus.id}: ${entry.files} files, ${entry.symbols} symbols, ${entry.references} references, ${entry.diagnostics} diagnostics; ${Object.keys(differences).length === 0 ? 'identical' : `differs in ${Object.keys(differences).join(', ')}`}; TypeScript scan and index ${typescriptMs} ms, engine index ${engineMs} ms (again ${engineAgainMs} ms)\n`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const text = `${JSON.stringify({ engine: located.path, corpora: report }, null, 2)}\n`;
if (values.out === undefined) process.stdout.write(text);
else await writeFile(values.out, text);
process.exit(differs ? 1 : 0);
