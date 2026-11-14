import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { engineProvinceRaster } from '../src/hoi4_agent_tools/map/engine-raster.js';
import { buildProvinceRaster, type ProvinceRaster } from '../src/hoi4_agent_tools/map/model.js';
import { AgentNudger } from '../src/hoi4_agent_tools/map/service.js';
import { typeScriptProvinceTopology } from '../src/hoi4_agent_tools/map/validation.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * Parity check for the province raster on the shared Rust engine (ADR 0084). On each workspace
 * it builds the map model (whose raster comes from `hoi4-engine map-provinces`), then builds the
 * TypeScript raster and geometry checks from the same bitmap and definitions, and compares every
 * pixel, every map and set in iteration order, and the components, holes and thin runs. It also
 * times both.
 *
 *   npx tsx scripts/map-raster-parity.ts [--config FILE] [--corpus vanilla,owb] [--out FILE]
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

function ordered(raster: ProvinceRaster) {
  return {
    width: raster.width,
    height: raster.height,
    adjacency: [...raster.adjacency].map(([id, others]) => [id, [...others]]),
    seamOnlyPairs: [...(raster.seamOnlyPairs ?? [])],
    geometry: [...raster.geometry],
    unknownColors: raster.unknownColors,
    unknownColorCount: raster.unknownColorCount,
    coastal: [...raster.coastalProvinceIds],
  };
}

const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-map-raster-parity-'));
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
    const nudger = new AgentNudger(new CoreEngine(resolver));
    let index;
    try {
      ({ index } = await nudger.scan('parity'));
    } catch (error) {
      // A map the model refuses (for example over its record budget) has no raster to compare.
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'error';
      process.stderr.write(`${corpus.id}: map model not built (${code})\n`);
      report[corpus.id] = { unavailable: `map model not built: ${code}` };
      continue;
    }
    const bitmap = index.provinceBitmap;
    if (bitmap === undefined || index.raster === undefined) {
      report[corpus.id] = { unavailable: 'no readable provinces.bmp' };
      continue;
    }
    let started = performance.now();
    const engine = engineProvinceRaster(bitmap, index.definitionsByColor, index.definitionsById);
    const engineMs = Math.round(performance.now() - started);
    started = performance.now();
    const reference = buildProvinceRaster(bitmap, index.definitionsByColor, index.definitionsById);
    const rasterMs = Math.round(performance.now() - started);
    started = performance.now();
    const topology = typeScriptProvinceTopology(reference);
    const topologyMs = Math.round(performance.now() - started);
    const differences: string[] = [];
    let firstPixel = -1;
    for (let pixel = 0; pixel < reference.provinceIds.length; pixel += 1)
      if (engine.provinceIds[pixel] !== reference.provinceIds[pixel]) {
        firstPixel = pixel;
        break;
      }
    if (engine.provinceIds.length !== reference.provinceIds.length || firstPixel >= 0)
      differences.push(`provinceIds (first at ${firstPixel})`);
    const left = ordered(engine);
    const right = ordered(reference);
    for (const key of Object.keys(right) as Array<keyof typeof right>)
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) differences.push(key);
    for (const key of ['components', 'holes', 'thin'] as const)
      if (JSON.stringify([...engine.topology![key]]) !== JSON.stringify([...topology[key]]))
        differences.push(key);
    differs ||= differences.length > 0;
    const entry = {
      bitmap: index.provinceBitmapFile?.displayPath,
      width: bitmap.width,
      height: bitmap.height,
      provinces: reference.geometry.size,
      neighbourPairs: [...reference.adjacency.values()].reduce((sum, set) => sum + set.size, 0) / 2,
      unknownColors: reference.unknownColorCount,
      holes: topology.holes.size,
      thin: topology.thin.size,
      differences,
      engineMs,
      typeScriptRasterMs: rasterMs,
      typeScriptTopologyMs: topologyMs,
    };
    report[corpus.id] = entry;
    process.stderr.write(
      `${corpus.id}: ${entry.provinces} provinces, ${differences.length === 0 ? 'identical' : `differs in ${differences.join(', ')}`}; engine ${engineMs} ms, TypeScript ${rasterMs} + ${topologyMs} ms\n`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const text = `${JSON.stringify({ engine: located.path, corpora: report }, null, 2)}\n`;
if (values.out === undefined) process.stdout.write(text);
else await writeFile(values.out, text);
process.exit(differs ? 1 : 0);
