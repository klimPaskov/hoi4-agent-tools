import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { sharedResidentEngine } from '../src/hoi4_agent_tools/core/resident-engine.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { buildTechnologyGraph } from '../src/hoi4_agent_tools/technology/graph.js';
import { buildTechnologyGraphOnEngine } from '../src/hoi4_agent_tools/technology/engine-graph.js';
import { scanTechnologySources } from '../src/hoi4_agent_tools/technology/service.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';
import { capEngineMemory } from './bench/engine-memory-cap.js';

// Every engine this script starts runs under a hard memory cap (HOI4_PARITY_ENGINE_MAX_MB).
capEngineMemory({ label: 'tech-parity' });

/**
 * Parity check for the technology graph on the Rust engine (packet P5, ADR 0089). On each corpus
 * it builds the graph with the TypeScript builder and with `tech.analyze` plus `tech.graph` from
 * the same scan, and compares every section of the two snapshots record by record (by canonical
 * JSON). Reports the full number of differing records per section and up to `--samples` examples.
 *
 *   HOI4_ENGINE=<own build> npx tsx scripts/tech-parity.ts [--config FILE] [--corpus vanilla,zin] [--out FILE]
 *
 * Exit status 1 when anything differs, 2 when the engine lacks `tech.graph`.
 */

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    corpus: { type: 'string' },
    out: { type: 'string' },
    samples: { type: 'string', default: '3' },
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
const hello = await sharedResidentEngine().request('hello', {}, undefined, {});
const ops =
  hello.ok && Array.isArray((hello.response.result as { ops?: unknown }).ops)
    ? (hello.response.result as { ops: string[] }).ops
    : [];
for (const op of ['tech.analyze', 'tech.graph', 'tech.query'])
  if (!ops.includes(op)) {
    process.stderr.write(
      `The engine at ${located.path} does not list ${op}; build this branch's own engine.\n`,
    );
    process.exit(2);
  }

const sampleCount = Number(values.samples);
const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

type Json = Record<string, unknown>;
const sections = [
  'technologies',
  'folders',
  'placements',
  'gridboxes',
  'itemLayouts',
  'yearMarkers',
  'backgrounds',
  'edges',
  'categories',
  'doctrineDefinitions',
  'unlockTargets',
  'unlocks',
  'externalReferences',
  'helperCalls',
  'issues',
  'diagnostics',
  'unresolved',
] as const;

function compareSection(before: unknown[], after: unknown[], samples: number) {
  const keyed = (items: unknown[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const item of items) {
      const record = item as Json;
      const key = typeof record.id === 'string' ? record.id : canonicalJson(item);
      const group = map.get(key) ?? [];
      group.push(canonicalJson(item));
      map.set(key, group);
    }
    return map;
  };
  const left = keyed(before);
  const right = keyed(after);
  let onlyTypescript = 0;
  let onlyEngine = 0;
  let changed = 0;
  const examples: unknown[] = [];
  for (const [key, group] of left) {
    const other = right.get(key);
    if (other === undefined) {
      onlyTypescript += group.length;
      if (examples.length < samples) examples.push({ key, only: 'typescript', value: group[0] });
    } else if (group.join('\n') !== other.join('\n')) {
      changed += 1;
      if (examples.length < samples) examples.push({ key, typescript: group[0], engine: other[0] });
    }
  }
  for (const [key, group] of right)
    if (!left.has(key)) {
      onlyEngine += group.length;
      if (examples.length < samples) examples.push({ key, only: 'engine', value: group[0] });
    }
  return {
    typescript: before.length,
    engine: after.length,
    onlyTypescript,
    onlyEngine,
    changed,
    examples,
  };
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-tech-parity-'));
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
    const engine = new CoreEngine(resolver);
    const workspace = resolver.get('parity');
    const snapshot = await scanTechnologySources(engine, 'parity', workspace);
    const analysisMode =
      corpus.kind === 'game' || snapshot.files.length > 1_000 ? ('focused' as const) : undefined;
    const options = {
      workspaceIdentity: workspace.workspaceIdentity,
      ...(analysisMode === undefined ? {} : { analysisMode }),
    };
    process.stderr.write(`${corpus.id}: TypeScript graph\n`);
    const started = performance.now();
    const expected = buildTechnologyGraph(snapshot, options) as unknown as Json;
    const typescriptMs = Math.round(performance.now() - started);
    process.stderr.write(`${corpus.id}: engine graph\n`);
    const engineStarted = performance.now();
    const actual = (await buildTechnologyGraphOnEngine(snapshot, options)) as unknown as Json;
    const engineMs = Math.round(performance.now() - engineStarted);
    const entry: Json = { typescriptMs, engineMs, sections: {} };
    let corpusDiffers = false;
    for (const section of sections) {
      const result = compareSection(
        (expected[section] as unknown[] | undefined) ?? [],
        (actual[section] as unknown[] | undefined) ?? [],
        sampleCount,
      );
      (entry.sections as Json)[section] = result;
      if (result.onlyTypescript + result.onlyEngine + result.changed > 0) corpusDiffers = true;
    }
    const scalars = ['revision', 'complete', 'analysisMode', 'skippedSourceCount'] as const;
    const scalarDifferences = scalars.filter(
      (key) => canonicalJson(expected[key]) !== canonicalJson(actual[key]),
    );
    for (const key of ['statistics', 'sourceHashes', 'filesScanned', 'analysisBoundary'] as const)
      if (canonicalJson(expected[key]) !== canonicalJson(actual[key]))
        scalarDifferences.push(key as never);
    entry.scalarDifferences = scalarDifferences;
    if (scalarDifferences.length > 0) corpusDiffers = true;
    entry.differs = corpusDiffers;
    differs ||= corpusDiffers;
    report[corpus.id] = entry;
    process.stderr.write(`${corpus.id}: ${corpusDiffers ? 'DIFFERS' : 'identical'}\n`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (values.out === undefined) process.stdout.write(text);
else await writeFile(values.out, text);
process.exit(differs ? 1 : 0);
