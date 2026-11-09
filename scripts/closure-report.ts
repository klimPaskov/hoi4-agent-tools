import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { defaultPatterns } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import {
  SOURCE_ROOT_KINDS,
  modIndexEngineRequest,
} from '../src/hoi4_agent_tools/reference/mod-index.js';
import { closureEngineResponseSchema } from '../src/hoi4_agent_tools/schemas/mod-tools.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * The closure of each benchmark mod (ADR 0083): `hoi4-engine closure` over the mod, its game and
 * its dependencies, with the time it took, the verdict and the counts per kind.
 *
 *   npx tsx scripts/closure-report.ts [--config FILE] [--corpus zin,ito] [--out FILE]
 *
 * Configuration and corpora are found as in `scripts/source-lookup-parity.ts`. The engine is
 * `HOI4_ENGINE` or the package's bundled binary. The vanilla game has no mod of its own to close
 * and is skipped.
 */

const { values } = parseArgs({
  options: { config: { type: 'string' }, corpus: { type: 'string' }, out: { type: 'string' } },
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

const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic' && kind !== 'game')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-closure-report-'));
const report: Record<string, unknown> = {};
try {
  for (const corpus of corpora) {
    const found = await locateCorpus(corpus);
    if (found.root === undefined) {
      process.stderr.write(`${corpus.id}: ${found.unavailable ?? 'not found'}\n`);
      report[corpus.id] = { unavailable: found.unavailable };
      continue;
    }
    await mkdir(path.join(temporary, 'state', corpus.id), { recursive: true });
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(temporary, 'state', corpus.id),
        workspaces: [
          {
            id: 'report',
            name: corpus.name,
            root: found.root,
            ...(serverConfig.gameRoot === undefined ? {} : { gameRoot: serverConfig.gameRoot }),
          },
        ],
      }),
    );
    const workspace = resolver.get('report');
    const request = {
      ...modIndexEngineRequest(workspace, resolver.config(), SOURCE_ROOT_KINDS),
      schema: 'hoi4-closure-request/1',
      patterns: defaultPatterns(workspace),
    };
    const started = performance.now();
    const run = spawnSync(located.path, ['closure'], {
      input: JSON.stringify(request),
      maxBuffer: 1024 * 1024 * 1024,
      windowsHide: true,
    });
    const milliseconds = Math.round(performance.now() - started);
    if (run.status !== 0) {
      process.stderr.write(
        `${corpus.id}: exit ${String(run.status)} ${run.stdout.toString('utf8').slice(0, 300)}\n`,
      );
      report[corpus.id] = { failed: run.stdout.toString('utf8').slice(0, 300) };
      continue;
    }
    const response = closureEngineResponseSchema.parse(JSON.parse(run.stdout.toString('utf8')));
    process.stderr.write(
      `${corpus.id}: ${response.verdict} in ${milliseconds} ms; resolved ${response.totals.resolved}, unresolved ${response.totals.unresolved}, unknown ${response.totals.unknown} over ${response.sources} sources\n`,
    );
    report[corpus.id] = { milliseconds, ...response };
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (values.out === undefined) process.stdout.write(text);
else await writeFile(values.out, text);
