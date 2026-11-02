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
 * Game preview timings (issue #74, HOI4 Factory D-16), not a packaged command.
 *
 *   npx tsx scripts/bench/preview-timing.ts --corpus ito --corpus vanilla --out timings.json
 *
 * For each corpus it starts a fresh server with a fresh state folder and calls `hoi4.focus_render`
 * three times on one tree: cold (first touch), warm (same source), and after a one-focus edit.
 * Real mods are never written: the edit runs on a copy of the tree file in a scratch mod that
 * loads the real mod as its dependency. Results stay on this machine.
 */

const { values } = parseArgs({
  options: {
    corpus: { type: 'string', multiple: true, default: [] },
    tree: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    'scratch-root': { type: 'string' },
    args: { type: 'string', default: '{}' },
  },
});

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

/** One focus `x = N` line moved by one column, the smallest edit that changes the render. */
function editOneFocus(source: string): string {
  const match = /(\bx\s*=\s*)(-?\d+)/u.exec(source);
  if (match === null) return `${source}\n# edited\n`;
  const start = match.index + match[1]!.length;
  return `${source.slice(0, start)}${Number(match[2]) + 1}${source.slice(start + match[2]!.length)}`;
}

const scratch = path.resolve(
  values['scratch-root'] ?? (await mkdtemp(path.join(os.tmpdir(), 'hoi4-preview-timing-'))),
);
const extraArgs = JSON.parse(values.args) as Record<string, unknown>;
const results: Array<Record<string, unknown>> = [];
const game = (await locateCorpus(corpora.find(({ kind }) => kind === 'game')!)).root;
const userRoot = await findUserRoot();
const treeOverrides = new Map(
  values.tree.map((entry) => {
    const [id, file] = entry.split('=');
    return [id!, file!] as const;
  }),
);

for (const id of values.corpus) {
  const corpus = corpora.find((candidate) => candidate.id === id);
  if (corpus === undefined) throw new Error(`unknown corpus ${id}`);
  const located = await locateCorpus(corpus);
  if (located.root === undefined) {
    results.push({ corpus: id, unavailable: located.unavailable });
    process.stderr.write(`${id}: unavailable (${located.unavailable})\n`);
    continue;
  }
  const directory = path.join(scratch, id);
  await rm(directory, { recursive: true, force: true });
  // The edited tree lives in a scratch mod so real mod source is never written. The scratch mod
  // loads the corpus (or, for vanilla, only the game) so icons and localisation still resolve.
  const scratchMod = path.join(directory, 'mod');
  await mkdir(path.join(scratchMod, 'common', 'national_focus'), { recursive: true });
  const tree =
    treeOverrides.get(id) ??
    (corpus.kind === 'game'
      ? 'common/national_focus/germany.txt'
      : await largestFocusFile(located.root));
  if (tree === undefined) throw new Error(`${id} has no focus tree`);
  const sourceRoot = located.root;
  const copied = path.join(scratchMod, ...tree.split('/'));
  await mkdir(path.dirname(copied), { recursive: true });
  await copyFile(path.join(sourceRoot, ...tree.split('/')), copied);
  await writeFile(
    path.join(scratchMod, 'descriptor.mod'),
    `name="Preview timing ${id}"\nsupported_version="1.19.*"\n`,
  );
  const workspaces: Array<Record<string, unknown>> =
    corpus.kind === 'game'
      ? [{ id, name: corpus.name, root: scratchMod, gameRoot: located.root }]
      : [
          {
            id,
            name: corpus.name,
            root: scratchMod,
            ...(game === undefined ? {} : { gameRoot: game }),
            dependencies: [{ root: located.root }],
          },
        ];
  const config = await writeSmokeConfig(
    path.join(directory, 'config'),
    workspaces,
    userRoot === undefined ? {} : { gameUserRoot: userRoot },
  );
  const repeat = Number(values.repeat);
  const server = await launchSmokeServer(config);
  const timings: Record<string, number[]> = { cold: [], warm: [], edit: [] };
  const stages: Record<string, Array<[number, string]>> = {};
  const sizes: Record<string, unknown> = {};
  const args = { workspaceId: id, relativePath: tree, ...extraArgs };
  // Progress notifications carry the stage names, so each call also records when each stage began.
  const call = async (label: string) => {
    const started = performance.now();
    const marks: Array<[number, string]> = [];
    const raw = await server.client.callTool(
      { name: 'hoi4.focus_render', arguments: args },
      undefined,
      {
        timeout: 900_000,
        resetTimeoutOnProgress: true,
        onprogress: (progress) => {
          marks.push([Math.round(performance.now() - started), progress.message ?? '']);
        },
      },
    );
    const milliseconds = Math.round(performance.now() - started);
    stages[label] = marks;
    const structured = (raw.structuredContent ?? {}) as Record<string, unknown>;
    let imageBytes = 0;
    for (const item of (raw.content ?? []) as Array<{ type: string; data?: string }>)
      if (item.type === 'image') imageBytes += Buffer.byteLength(item.data ?? '', 'base64');
    return { milliseconds, structured, isError: raw.isError === true, imageBytes, raw };
  };
  try {
    const cold = await call('cold');
    timings.cold!.push(cold.milliseconds);
    sizes.cold = {
      status: cold.structured.status,
      code: cold.structured.code,
      isError: cold.isError,
      imageBytes: cold.imageBytes,
    };
    if (cold.isError || cold.structured.status === 'failed')
      process.stderr.write(`${id}: cold call failed: ${JSON.stringify(cold.raw).slice(0, 600)}\n`);
    for (let index = 0; index < repeat; index += 1) {
      const warm = await call(`warm${index}`);
      timings.warm!.push(warm.milliseconds);
    }
    for (let index = 0; index < repeat; index += 1) {
      const source = await readFile(copied, 'utf8');
      await writeFile(copied, editOneFocus(source));
      const edited = await call(`edit${index}`);
      timings.edit!.push(edited.milliseconds);
      sizes.edit = { status: edited.structured.status, code: edited.structured.code };
    }
  } finally {
    await server.close();
  }
  // Optional per-stage lines the server writes when instrumented (`preview_timing` events).
  const serverStages = server
    .stderr()
    .split('\n')
    .filter((line) => line.includes('"preview_timing"'))
    .map((line) => JSON.parse(line) as { stage: string; ms: number })
    .map(({ stage, ms }) => `${stage}=${ms}`);
  const entry = { corpus: id, tree, root: sourceRoot, timings, stages, serverStages, sizes };
  results.push(entry);
  process.stderr.write(`${id}: ${JSON.stringify(timings)}\n`);
}

const report = {
  startedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  cpus: os.cpus().length,
  load: os.loadavg(),
  results,
};
if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
