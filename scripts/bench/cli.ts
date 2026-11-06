import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import { compareRun, markdownReport, toBaseline } from './compare.js';
import { findGameRoot } from './corpus.js';
import { gameUpdateMarkdown, watchGame, type GameUpdate } from './game-watch.js';
import { BENCH_ROOT, runSuite } from './runner.js';
import { baselineSchema, type Baseline } from './schema.js';

/**
 * Project benchmark, not a packaged command.
 *
 *   npm run bench                       # synthetic suite, compared with bench/baselines/synthetic.json
 *   npm run bench -- --suite real       # installed game and mods; results stay on this machine
 *   npm run bench -- --suite real --corpus chaos_redux --case event.
 *   npm run bench -- --update-baseline  # accept this run as the new baseline
 *   npm run bench -- --suite real --from-results <results.json>   # accept a finished run
 *   npm run bench -- --suite real --watch-game --accept-if-clean   # what nightly.sh runs
 *
 * The real suite keeps its results, report and baseline in the benchmark data folder
 * (HOI4_BENCH_DIR, else %LOCALAPPDATA%\hoi4-agent-tools\bench, ~/Library/Application
 * Support/hoi4-agent-tools/bench or ~/.local/share/hoi4-agent-tools/bench). Exit status is 1
 * when a case regressed on an unchanged corpus.
 */

function benchDataRoot(): string {
  if (process.env.HOI4_BENCH_DIR !== undefined) return path.resolve(process.env.HOI4_BENCH_DIR);
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
      'hoi4-agent-tools',
      'bench',
    );
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'hoi4-agent-tools', 'bench');
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'),
    'hoi4-agent-tools',
    'bench',
  );
}

async function readBaseline(file: string): Promise<Baseline | undefined> {
  try {
    return baselineSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'synthetic' },
    corpus: { type: 'string' },
    case: { type: 'string' },
    out: { type: 'string' },
    baseline: { type: 'string' },
    'update-baseline': { type: 'boolean', default: false },
    'accept-if-clean': { type: 'boolean', default: false },
    'watch-game': { type: 'boolean', default: false },
    'from-results': { type: 'string' },
    'no-hash': { type: 'boolean', default: false },
    dump: { type: 'boolean', default: false },
  },
});
if (values.suite !== 'synthetic' && values.suite !== 'real') {
  process.stderr.write('--suite is synthetic or real\n');
  process.exit(2);
}
const suite = values.suite;
const dataRoot = benchDataRoot();
const stamp = new Date()
  .toISOString()
  .replaceAll(':', '-')
  .replace(/\.[0-9]+Z$/u, 'Z');
const out =
  values.out ??
  (suite === 'real'
    ? path.join(dataRoot, 'runs', stamp)
    : path.resolve(BENCH_ROOT, '..', '.tmp', 'bench', stamp));
const baselinePath =
  values.baseline ??
  (suite === 'real'
    ? path.join(dataRoot, 'baseline.json')
    : path.join(BENCH_ROOT, 'baselines', 'synthetic.json'));
if (values['from-results'] !== undefined) {
  // Accepts a finished run as the baseline without running it again.
  const result = JSON.parse(await readFile(values['from-results'], 'utf8')) as Parameters<
    typeof toBaseline
  >[0];
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(
    baselinePath,
    `${JSON.stringify(JSON.parse(canonicalJson(toBaseline(result, suite === 'real'))), null, 2)}
`,
  );
  process.stderr.write(`Baseline written to ${baselinePath}
`);
  process.exit(0);
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-bench-'));
try {
  // The game-update watcher runs first, so a new build's baseline is kept before the run moves it.
  let gameUpdate: GameUpdate | undefined;
  const gameRoot = values['watch-game'] ? await findGameRoot() : undefined;
  if (gameRoot !== undefined) {
    gameUpdate = await watchGame(gameRoot, dataRoot);
    for (const pin of gameUpdate.stalePins)
      process.stderr.write(
        `game-update watcher: ${pin.data} was checked against ${pin.pinned}, installed ${pin.installed}\n`,
      );
    const previous = gameUpdate.previous?.rawVersion;
    if (gameUpdate.status === 'changed' && previous !== undefined) {
      const kept = await readBaseline(baselinePath);
      if (kept !== undefined)
        await writeFile(
          path.join(path.dirname(baselinePath), `baseline-${previous}.json`),
          `${JSON.stringify(kept, null, 2)}
`,
        );
    }
  }
  const result = await runSuite({
    suite,
    ...(values.corpus === undefined ? {} : { corpora: values.corpus.split(',') }),
    ...(values.case === undefined ? {} : { filter: values.case.split(',') }),
    temporaryRoot: temporary,
    hashContent: !values['no-hash'],
    ...(suite === 'real' ? { hashCacheDirectory: path.join(dataRoot, 'hash-cache') } : {}),
    ...(values.dump ? { dumpDirectory: path.join(out, 'calls') } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const baseline = await readBaseline(baselinePath);
  const comparison = compareRun(result, baseline);
  const report = `${markdownReport(result, comparison)}${
    gameUpdate === undefined
      ? ''
      : `
${gameUpdateMarkdown(gameUpdate)}`
  }`;
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'results.json'), `${canonicalJson(result)}\n`);
  await writeFile(path.join(out, 'report.md'), report);
  if (suite === 'real') {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'latest-report.md'), report);
  }
  // The nightly run keeps the last good state: it accepts a run only when nothing regressed and
  // no case moved on a changed corpus, so a failure is never absorbed into the baseline.
  const clean =
    comparison.regressions.length === 0 && comparison.changedCorpusFindings.length === 0;
  if (values['update-baseline'] || (values['accept-if-clean'] && clean)) {
    // A filtered run only replaces the cases it ran.
    const next = toBaseline(result, suite === 'real');
    const merged: Baseline =
      baseline === undefined || (values.case === undefined && values.corpus === undefined)
        ? next
        : {
            ...baseline,
            cases: { ...baseline.cases, ...next.cases },
            corpora: { ...baseline.corpora, ...next.corpora },
            ...(next.latency === undefined
              ? {}
              : { latency: { ...baseline.latency, ...next.latency } }),
          };
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(
      baselinePath,
      `${JSON.stringify(JSON.parse(canonicalJson(merged)), null, 2)}\n`,
    );
    process.stderr.write(`Baseline written to ${baselinePath}\n`);
  }
  process.stdout.write(report);
  process.stderr.write(`Results in ${out}\n`);
  if (comparison.regressions.length > 0 && !values['update-baseline']) process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
}
