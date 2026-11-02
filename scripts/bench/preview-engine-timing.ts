import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { ResidentEngine } from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { gameLayers } from '../../src/hoi4_agent_tools/focus/game-render.js';

/**
 * The resident engine's own render time, without the MCP call around it (issue #74), not a
 * packaged command. Run `preview-timing.ts --args '{"view":"game"}'` first; this reads each
 * corpus's game-view JSON artifact (which records the engine request) and the workspace config
 * from that scratch root, then renders the same tree in a fresh `hoi4-engine serve`: once cold,
 * five times warm, and three times after moving one focus by a column.
 *
 *   npx tsx scripts/bench/preview-engine-timing.ts --scratch-root .tmp/timing/after-game --out engine.json
 */

const { values } = parseArgs({
  options: { 'scratch-root': { type: 'string' }, out: { type: 'string' } },
});
const scratch = path.resolve(values['scratch-root'] ?? '.');

async function files(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile() && accept(entry.name)) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

const results: Array<Record<string, unknown>> = [];
for (const corpus of (await readdir(scratch, { withFileTypes: true })).filter((e) =>
  e.isDirectory(),
)) {
  const directory = path.join(scratch, corpus.name);
  const configFile = path.join(directory, 'config', 'config.json');
  const config = serverConfigurationSchema.parse(JSON.parse(await readFile(configFile, 'utf8')));
  const resolver = await WorkspaceResolver.create(config);
  const workspace = resolver.get(corpus.name);
  let newest: { file: string; time: number } | undefined;
  for (const file of await files(directory, (name) => name.endsWith('.focus.json'))) {
    const text = await readFile(file, 'utf8');
    if (!text.includes('"view":"game"')) continue;
    const time = (await stat(file)).mtimeMs;
    if (newest === undefined || time > newest.time) newest = { file, time };
  }
  if (newest === undefined) {
    process.stderr.write(`${corpus.name}: no game-view artifact\n`);
    continue;
  }
  const artifact = JSON.parse(await readFile(newest.file, 'utf8')) as {
    request: { focuses: Array<{ x: number }> };
  };
  const request = artifact.request;
  const engine = new ResidentEngine();
  const layers = gameLayers(workspace);
  const call = async () => {
    const started = performance.now();
    const outcome = await engine.request('focus.render', { layers, request });
    const wall = Math.round(performance.now() - started);
    if (!outcome.ok) throw new Error(`${corpus.name}: ${outcome.message}`);
    return {
      wall,
      engine: outcome.response.result.timings,
      bytes: outcome.response.payload.length,
    };
  };
  const cold = await call();
  const warm = [];
  for (let index = 0; index < 5; index += 1) warm.push(await call());
  const edit = [];
  for (let index = 0; index < 3; index += 1) {
    request.focuses[0]!.x += 1;
    edit.push(await call());
  }
  engine.close();
  const entry = { corpus: corpus.name, focuses: request.focuses.length, cold, warm, edit };
  results.push(entry);
  process.stderr.write(
    `${corpus.name}: ${request.focuses.length} focuses, cold ${cold.wall} ms, warm ${warm.map((w) => w.wall).join('/')} ms, edit ${edit.map((e) => e.wall).join('/')} ms\n`,
  );
}
if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(results, null, 2)}\n`);
