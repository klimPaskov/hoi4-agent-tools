import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine, type ScanSnapshot } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import type { SymbolRecord } from '../src/hoi4_agent_tools/core/index.js';
import { WorkspaceResolver, type RootKind } from '../src/hoi4_agent_tools/core/workspace.js';
import {
  SOURCE_ROOT_KINDS,
  modIndex,
  modIndexEngineRequest,
} from '../src/hoi4_agent_tools/reference/mod-index.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * Parity check for `hoi4.mod_index` on the shared Rust engine (M-8, ADR 0080). On each workspace
 * it runs the TypeScript shared scan (`CoreEngine.scan`, which built the old answer) and the
 * engine (`hoi4-engine symbol-index`, and the tool itself through `hoi4-engine mod-index`), then
 * diffs the (kind, id, overridden) multisets, file counts, completeness, folder totals, kind
 * counts, event namespaces and next_id answers.
 *
 *   npx tsx scripts/mod-index-parity.ts [--config FILE] [--corpus vanilla,zin] [--out FILE]
 *
 * The game and the mods come from the server configuration (`gameRoot`, `modRoots`, default
 * `%APPDATA%\hoi4-agent-tools\config.json`) and `bench/corpus.json`; Workshop items are found in
 * the Steam libraries. Files are read where they are installed and never copied. The engine is
 * `HOI4_ENGINE` or the package's bundled binary. Exit status 1 when anything differs.
 */

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    corpus: { type: 'string' },
    out: { type: 'string' },
    'max-samples': { type: 'string', default: '12' },
  },
});

function defaultConfigPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.platform === 'win32'
    ? path.join(appData, 'hoi4-agent-tools', 'config.json')
    : path.join(os.homedir(), '.config', 'hoi4-agent-tools', 'config.json');
}

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

type Overview = Awaited<ReturnType<typeof modIndex>>;

// ------------------------------------------------------------------------------------------
// The TypeScript answers, as the route computed them before the move (src/hoi4_agent_tools/
// reference/mod-index.ts at commit 5c75b21).

function oldNamespaces(symbols: readonly SymbolRecord[]): NonNullable<Overview['namespaces']> {
  const byNamespace = new Map<string, { numbers: number[]; files: Set<string> }>();
  for (const symbol of symbols) {
    if (symbol.kind !== 'event') continue;
    const match = /^(.+)\.(\d{1,9})$/u.exec(symbol.id);
    if (match === null) continue;
    const entry = byNamespace.get(match[1]!) ?? { numbers: [], files: new Set<string>() };
    entry.numbers.push(Number(match[2]));
    entry.files.add(symbol.path);
    byNamespace.set(match[1]!, entry);
  }
  return [...byNamespace]
    .map(([namespace, { numbers, files }]) => ({
      namespace,
      events: new Set(numbers).size,
      lowest: Math.min(...numbers),
      highest: Math.max(...numbers),
      files: files.size,
    }))
    .sort((left, right) => left.namespace.localeCompare(right.namespace, 'en'));
}

function oldOverview(snapshot: ScanSnapshot): {
  complete: boolean;
  files: number;
  kinds: Array<{ kind: string; count: number }>;
  folders: Array<{ folder: string; files: number; bytes: number }>;
  namespaces: NonNullable<Overview['namespaces']>;
} {
  const symbols = snapshot.index.symbols.filter(({ overridden }) => !overridden);
  const kinds = new Map<string, number>();
  for (const symbol of symbols) kinds.set(symbol.kind, (kinds.get(symbol.kind) ?? 0) + 1);
  const folders = new Map<string, { files: number; bytes: number }>();
  for (const file of snapshot.files) {
    const parts = file.relativePath.split('/');
    const folder =
      parts.length > 2 && parts[0] === 'common' ? parts.slice(0, 2).join('/') : parts[0]!;
    const totals = folders.get(folder) ?? { files: 0, bytes: 0 };
    totals.files += 1;
    totals.bytes += file.size;
    folders.set(folder, totals);
  }
  return {
    complete: snapshot.complete,
    files: snapshot.files.length,
    kinds: [...kinds]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    folders: [...folders]
      .map(([folder, totals]) => ({ folder, ...totals }))
      .sort((left, right) => right.files - left.files || left.folder.localeCompare(right.folder)),
    namespaces: oldNamespaces(symbols),
  };
}

function oldNextId(
  snapshot: ScanSnapshot,
  kind: string,
  prefix: string,
): { used: number; highest?: number; nextId: string; firstGapId?: string } {
  const used = new Set<number>();
  for (const symbol of snapshot.index.symbols) {
    if (symbol.kind !== kind || !symbol.id.startsWith(prefix)) continue;
    const suffix = symbol.id.slice(prefix.length);
    if (/^\d{1,9}$/u.test(suffix)) used.add(Number(suffix));
  }
  const highest = used.size === 0 ? undefined : Math.max(...used);
  let firstGap: number | undefined;
  for (let number = 1; highest !== undefined && number < highest; number += 1)
    if (!used.has(number)) {
      firstGap = number;
      break;
    }
  return {
    used: used.size,
    ...(highest === undefined ? {} : { highest }),
    nextId: `${prefix}${(highest ?? 0) + 1}`,
    ...(firstGap === undefined ? {} : { firstGapId: `${prefix}${firstGap}` }),
  };
}

// ------------------------------------------------------------------------------------------
// The engine's records.

interface EngineRecord {
  kind: string;
  id: string;
  path: string;
  overridden: boolean;
}

function engineSymbols(request: unknown): {
  complete: boolean;
  files: number;
  symbols: EngineRecord[];
  milliseconds: number;
} {
  const started = performance.now();
  const run = spawnSync(binary, ['symbol-index'], {
    input: JSON.stringify(request),
    maxBuffer: 4 * 1024 * 1024 * 1024,
    windowsHide: true,
  });
  const milliseconds = Math.round(performance.now() - started);
  if (run.status !== 0)
    throw new Error(
      `hoi4-engine symbol-index exited with ${String(run.status)}: ${run.stdout.toString('utf8').slice(0, 500)} ${run.stderr.toString('utf8').slice(0, 500)}`,
    );
  const parsed = JSON.parse(run.stdout.toString('utf8')) as {
    complete: boolean;
    files: number;
    symbols: EngineRecord[];
  };
  return { ...parsed, milliseconds };
}

// ------------------------------------------------------------------------------------------

interface Difference {
  key: string;
  typescript: number;
  engine: number;
}

function multiset(records: Iterable<{ kind: string; id: string; overridden: boolean }>) {
  const counts = new Map<string, number>();
  for (const { kind, id, overridden } of records) {
    const key = `${kind}\t${id}\t${overridden ? 'overridden' : 'active'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function diffMultisets(left: Map<string, number>, right: Map<string, number>): Difference[] {
  const out: Difference[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const typescript = left.get(key) ?? 0;
    const engine = right.get(key) ?? 0;
    if (typescript !== engine) out.push({ key, typescript, engine });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Differences grouped by kind and direction, with samples. */
function classes(differences: Difference[]) {
  const groups = new Map<string, { count: number; samples: Difference[] }>();
  for (const difference of differences) {
    const [kind, , state] = difference.key.split('\t');
    const side = difference.typescript > difference.engine ? 'only-typescript' : 'only-engine';
    const name = `${kind} ${state} ${side}`;
    const group = groups.get(name) ?? { count: 0, samples: [] };
    group.count += Math.abs(difference.typescript - difference.engine);
    if (group.samples.length < maxSamples) group.samples.push(difference);
    groups.set(name, group);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-mod-index-parity-'));
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
    for (const layer of ['mod', 'all'] as const) {
      const rootKinds: readonly RootKind[] = layer === 'mod' ? ['mod'] : SOURCE_ROOT_KINDS;
      process.stderr.write(`${corpus.id} ${layer}: TypeScript scan\n`);
      let started = performance.now();
      const snapshot = await engine.scan('parity', layer === 'mod' ? { rootKinds: ['mod'] } : {});
      const typescriptMs = Math.round(performance.now() - started);
      process.stderr.write(`${corpus.id} ${layer}: engine\n`);
      const records = engineSymbols(modIndexEngineRequest(workspace, resolver.config(), rootKinds));
      const symbolDifferences = diffMultisets(
        multiset(snapshot.index.symbols),
        multiset(records.symbols),
      );
      const old = oldOverview(snapshot);
      started = performance.now();
      const now = await modIndex(engine, 'parity', {
        workspaceId: 'parity',
        mode: 'overview',
        layer,
        kind: 'event',
      });
      const toolMs = Math.round(performance.now() - started);
      const result: Record<string, unknown> = {
        typescriptScanMs: typescriptMs,
        engineSymbolIndexMs: records.milliseconds,
        engineToolMs: toolMs,
        typescriptSymbols: snapshot.index.symbols.length,
        engineSymbols: records.symbols.length,
        files: { typescript: old.files, engine: records.files, tool: now.files },
        complete: { typescript: old.complete, engine: records.complete, tool: now.complete },
        symbolDifferences: symbolDifferences.length,
        differenceClasses: classes(symbolDifferences),
        kindsEqual: sameJson(old.kinds, now.kinds),
        foldersEqual: sameJson(old.folders.slice(0, 60), now.folders),
        namespacesEqual: sameJson(old.namespaces.slice(0, 200), now.namespaces),
        omittedNamespacesEqual: Math.max(0, old.namespaces.length - 200) === now.omittedNamespaces,
      };
      if (!result.kindsEqual) result.kinds = { typescript: old.kinds, tool: now.kinds };
      if (!result.foldersEqual) result.folders = { typescript: old.folders, tool: now.folders };
      if (!result.namespacesEqual)
        result.namespaces = { typescript: old.namespaces, tool: now.namespaces };
      if (layer === 'all') {
        // next_id for the mod's own numbered prefixes of every kind the tool accepts.
        const prefixes = new Map<string, Map<string, number>>();
        for (const symbol of snapshot.index.symbols) {
          if (symbol.rootKind !== (corpus.kind === 'game' ? 'game' : 'mod')) continue;
          if (!['event', 'focus', 'decision', 'idea', 'leader', 'technology'].includes(symbol.kind))
            continue;
          const match = /^(.*?)(\d{1,9})$/u.exec(symbol.id);
          if (match === null || match[1] === '') continue;
          const byKind = prefixes.get(symbol.kind) ?? new Map<string, number>();
          byKind.set(match[1]!, (byKind.get(match[1]!) ?? 0) + 1);
          prefixes.set(symbol.kind, byKind);
        }
        const nextIds: Array<Record<string, unknown>> = [];
        for (const [kind, byPrefix] of prefixes)
          for (const [prefix] of [...byPrefix].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
            const typescript = oldNextId(snapshot, kind, prefix);
            const tool = await modIndex(engine, 'parity', {
              workspaceId: 'parity',
              mode: 'next_id',
              layer: 'mod',
              kind: kind as 'event',
              prefix,
            });
            const equal = sameJson(typescript, {
              used: tool.next!.used,
              ...(tool.next!.highest === undefined ? {} : { highest: tool.next!.highest }),
              nextId: tool.next!.nextId,
              ...(tool.next!.firstGapId === undefined ? {} : { firstGapId: tool.next!.firstGapId }),
            });
            nextIds.push({
              kind,
              prefix,
              equal,
              ...(equal ? {} : { typescript, tool: tool.next }),
            });
          }
        result.nextIds = {
          checked: nextIds.length,
          differing: nextIds.filter(({ equal }) => !equal),
        };
        if (nextIds.some(({ equal }) => !equal)) differs = true;
      }
      if (
        symbolDifferences.length > 0 ||
        !result.kindsEqual ||
        !result.foldersEqual ||
        !result.namespacesEqual ||
        !result.omittedNamespacesEqual ||
        old.files !== records.files ||
        old.complete !== records.complete
      )
        differs = true;
      entry[layer] = result;
      process.stderr.write(
        `${corpus.id} ${layer}: ${snapshot.index.symbols.length} TypeScript records, ${records.symbols.length} engine records, ${symbolDifferences.length} differing keys; TypeScript ${typescriptMs} ms, engine ${records.milliseconds} ms\n`,
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
