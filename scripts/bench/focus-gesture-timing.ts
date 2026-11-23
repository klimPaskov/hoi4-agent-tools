import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { launchSmokeServer, writeSmokeConfig } from '../../tests/helpers/mcp-stdio-smoke.js';
import { findUserRoot, locateCorpus } from './corpus.js';
import { corpusFileSchema } from './schema.js';
import { BENCH_ROOT } from './runner.js';

/**
 * Editor gesture timings (issue #137, decision D-98), not a packaged command.
 *
 *   npx tsx scripts/bench/focus-gesture-timing.ts --corpus probe --corpus chaos_redux --rounds 5
 *
 * One gesture is a `hoi4.focus_rewrite` (compact) that changes the tree, then a
 * `hoi4.focus_inspect` of the same file, as an editor sends them. Each round first moves one
 * focus by a column on disk, so every rewrite has something to compact. Normal and
 * `answerBeforeCheck` rewrites alternate in one server, and an untimed inspect after the move stands
 * for the editor having read the tree before the gesture. The `probe` corpus is a project-owned
 * four-focus tree over the installed game (F-FOCUS-SMALL); a real mod corpus runs on a copy of
 * its largest focus file in a scratch mod that loads the real mod as a dependency, so real mod
 * source is never written. Results stay on this machine.
 */

const { values } = parseArgs({
  options: {
    corpus: { type: 'string', multiple: true, default: [] },
    rounds: { type: 'string', default: '5' },
    out: { type: 'string' },
    'scratch-root': { type: 'string' },
  },
});

const PROBE_TREE = `focus_tree = {
	id = perf_probe_tree
	country = { factor = 0 }
	focus = {
		id = perf_probe_a
		icon = GFX_goal_generic_construct_civ_factory
		x = 0
		y = 0
		cost = 10
	}
	focus = {
		id = perf_probe_b
		icon = GFX_goal_generic_construct_civ_factory
		prerequisite = { focus = perf_probe_a }
		x = 0
		y = 1
		cost = 10
	}
	focus = {
		id = perf_probe_c
		icon = GFX_goal_generic_construct_civ_factory
		prerequisite = { focus = perf_probe_a }
		x = 2
		y = 1
		cost = 10
	}
	focus = {
		id = perf_probe_d
		icon = GFX_goal_generic_construct_civ_factory
		prerequisite = { focus = perf_probe_b }
		x = 0
		y = 2
		cost = 10
	}
}
`;

const corpora = corpusFileSchema.parse(
  JSON.parse(await readFile(path.join(BENCH_ROOT, 'corpus.json'), 'utf8')),
).corpora;

/** The largest file in `common/national_focus`, by bytes. */
async function largestFocusFile(root: string): Promise<string | undefined> {
  const folder = path.join(root, 'common', 'national_focus');
  let best: { name: string; size: number } | undefined;
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith('.txt')) continue;
    const { size } = await stat(path.join(folder, name));
    if (best === undefined || size > best.size) best = { name, size };
  }
  return best === undefined ? undefined : `common/national_focus/${best.name}`;
}

/** Move the last focus `x = N` of the file `shift` columns right, so compact has work to do. */
function spreadOneFocus(source: string, shift: number): string {
  const matches = [...source.matchAll(/(\bx\s*=\s*)(-?\d+)/gu)];
  const match = matches.at(-1);
  if (match === undefined) return `${source}\n# edited\n`;
  const start = match.index + match[1]!.length;
  return `${source.slice(0, start)}${Number(match[2]) + shift}${source.slice(start + match[2]!.length)}`;
}

function percentile(samples: readonly number[], fraction: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

const scratch = path.resolve(
  values['scratch-root'] ?? (await mkdtemp(path.join(os.tmpdir(), 'hoi4-gesture-timing-'))),
);
const rounds = Number(values.rounds);
const results: Array<Record<string, unknown>> = [];
const gameCorpus = corpora.find(({ kind }) => kind === 'game')!;
const game = (await locateCorpus(gameCorpus)).root;
const userRoot = await findUserRoot();

for (const id of values.corpus) {
  const directory = path.join(scratch, id);
  await rm(directory, { recursive: true, force: true });
  const scratchMod = path.join(directory, 'mod');
  await mkdir(path.join(scratchMod, 'common', 'national_focus'), { recursive: true });
  await writeFile(
    path.join(scratchMod, 'descriptor.mod'),
    `name="Gesture timing ${id}"\nsupported_version="1.19.*"\n`,
  );
  let tree: string;
  let treeId: string;
  let workspace: Record<string, unknown>;
  if (id === 'probe') {
    if (game === undefined) throw new Error('the probe corpus needs the installed game');
    tree = 'common/national_focus/perf_probe.txt';
    treeId = 'perf_probe_tree';
    await writeFile(path.join(scratchMod, ...tree.split('/')), PROBE_TREE);
    workspace = { id, name: 'Gesture probe', root: scratchMod, gameRoot: game };
  } else {
    const corpus = corpora.find((candidate) => candidate.id === id);
    if (corpus === undefined) throw new Error(`unknown corpus ${id}`);
    const located = await locateCorpus(corpus);
    if (located.root === undefined) {
      results.push({ corpus: id, unavailable: located.unavailable });
      process.stderr.write(`${id}: unavailable (${located.unavailable})\n`);
      continue;
    }
    const found =
      corpus.kind === 'game'
        ? 'common/national_focus/germany.txt'
        : await largestFocusFile(located.root);
    if (found === undefined) throw new Error(`${id} has no focus tree`);
    tree = found;
    const copied = path.join(scratchMod, ...tree.split('/'));
    await mkdir(path.dirname(copied), { recursive: true });
    await copyFile(path.join(located.root, ...tree.split('/')), copied);
    // A plan-free compact layout names its tree: the file's first one.
    const named = /focus_tree\s*=\s*\{[\s\S]*?\bid\s*=\s*"?([\w.-]+)/u.exec(
      await readFile(copied, 'latin1'),
    )?.[1];
    if (named === undefined) throw new Error(`${id}: ${tree} names no focus tree id`);
    treeId = named;
    workspace =
      corpus.kind === 'game'
        ? { id, name: corpus.name, root: scratchMod, gameRoot: located.root }
        : {
            id,
            name: corpus.name,
            root: scratchMod,
            ...(game === undefined ? {} : { gameRoot: game }),
            dependencies: [{ root: located.root }],
          };
  }
  const file = path.join(scratchMod, ...tree.split('/'));
  const config = await writeSmokeConfig(
    path.join(directory, 'config'),
    [workspace],
    userRoot === undefined ? {} : { gameUserRoot: userRoot },
  );
  const server = await launchSmokeServer(config);
  const timings: Record<string, number[]> = {
    coldInspect: [],
    warmInspect: [],
    rewrite: [],
    inspectAfterRewrite: [],
    gesture: [],
    earlyRewrite: [],
    inspectAfterEarlyRewrite: [],
    earlyGesture: [],
  };
  const failures: string[] = [];
  const inspectArgs = { workspaceId: id, relativePath: tree };
  const check = (label: string, result: Awaited<ReturnType<typeof server.call>>) => {
    const status = result.structured.status;
    if (result.isError || status !== 'ok')
      failures.push(`${label}: ${status} ${result.structured.code} ${result.text.slice(0, 300)}`);
  };
  try {
    const cold = await server.call('hoi4.focus_inspect', 'cold', inspectArgs);
    check('cold inspect', cold);
    timings.coldInspect!.push(cold.milliseconds);
    for (let index = 0; index < 3; index += 1) {
      const warm = await server.call('hoi4.focus_inspect', 'warm', inspectArgs);
      check('warm inspect', warm);
      timings.warmInspect!.push(warm.milliseconds);
    }
    for (let round = 0; round < rounds * 2; round += 1) {
      const early = round % 2 === 1;
      await writeFile(file, spreadOneFocus(await readFile(file, 'utf8'), 3));
      // An editor has inspected the tree before the user's gesture; this call is not timed.
      check('inspect before rewrite', await server.call('hoi4.focus_inspect', 'sync', inspectArgs));
      const rewrite = await server.call('hoi4.focus_rewrite', 'compact', {
        ...inspectArgs,
        treeId,
        layoutMode: 'compact',
        ...(early ? { answerBeforeCheck: true } : {}),
      });
      check(early ? 'early rewrite' : 'rewrite', rewrite);
      const inspect = await server.call('hoi4.focus_inspect', 'after rewrite', inspectArgs);
      check('inspect after rewrite', inspect);
      timings[early ? 'earlyRewrite' : 'rewrite']!.push(rewrite.milliseconds);
      timings[early ? 'inspectAfterEarlyRewrite' : 'inspectAfterRewrite']!.push(
        inspect.milliseconds,
      );
      timings[early ? 'earlyGesture' : 'gesture']!.push(
        rewrite.milliseconds + inspect.milliseconds,
      );
    }
  } finally {
    await server.close();
  }
  const summary = Object.fromEntries(
    Object.entries(timings).map(([key, samples]) => [
      key,
      { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), samples },
    ]),
  );
  results.push({ corpus: id, tree, summary, failures });
  process.stderr.write(
    `${id}: ${JSON.stringify(summary)}${failures.length > 0 ? ` FAILURES ${JSON.stringify(failures)}` : ''}\n`,
  );
}

const report = {
  startedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  cpus: os.cpus().map(({ model }) => model)[0],
  freeMemoryGiB: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
  engine: process.env.HOI4_ENGINE === undefined ? 'package' : 'HOI4_ENGINE',
  results,
};
if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
