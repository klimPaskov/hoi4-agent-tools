/**
 * Run every campaign map that has no result yet, each in its own process so a crash, a hang or
 * an out-of-memory stop is recorded for that map instead of ending the campaign (request ZR-4).
 *
 * Usage: tsx scripts/map-campaign/run-all.ts --store <dir> --game <game root>
 *        [--maps <dir>] [--manifest <file>] [--concurrency 3] [--timeout-minutes 45]
 *        [--only <id,id>] [--rerun]
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manifestSchema } from './manifest.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const store = option('--store');
  const game = option('--game');
  if (store === undefined || game === undefined) throw new Error('--store and --game are required');
  const manifestPath = path.resolve(
    option('--manifest') ?? 'docs/plans/map-campaign/manifest.json',
  );
  const maps = option('--maps') ?? path.join(store, 'maps');
  const concurrency = Number(option('--concurrency') ?? 3);
  const timeoutMs = Number(option('--timeout-minutes') ?? 45) * 60_000;
  const only = option('--only')?.split(',');
  const rerun = process.argv.includes('--rerun');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const pending: string[] = [];
  for (const entry of manifest.maps) {
    if (only !== undefined && !only.includes(entry.id)) continue;
    const done = await stat(path.join(store, 'results', `${entry.id}.json`)).then(
      () => true,
      () => false,
    );
    if (rerun || !done) pending.push(entry.id);
  }
  process.stderr.write(`${pending.length} maps to run, ${concurrency} at a time\n`);
  const tsx = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');

  const runOne = (id: string): Promise<void> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(
        process.execPath,
        [
          '--max-old-space-size=8192',
          tsx,
          'scripts/map-campaign/run-one.ts',
          '--id',
          id,
          '--store',
          store,
          '--maps',
          maps,
          '--game',
          game,
          '--manifest',
          manifestPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4_000);
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        void (async () => {
          const target = path.join(store, 'results', `${id}.json`);
          const written = await stat(target).then(
            (status) => status.mtimeMs >= started,
            () => false,
          );
          if (!written) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(
              target,
              `${JSON.stringify(
                {
                  id,
                  crash:
                    signal !== null
                      ? `stopped by ${signal} after ${Math.round((Date.now() - started) / 60_000)} min (timeout or memory)`
                      : `process exited with ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`.slice(
                          0,
                          800,
                        ),
                  milliseconds: Date.now() - started,
                },
                null,
                2,
              )}\n`,
            );
          }
          process.stderr.write(
            `${id}: ${written ? 'done' : 'failed'} in ${Math.round((Date.now() - started) / 1000)} s\n`,
          );
          resolve();
        })();
      });
    });

  const queue = [...pending];
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await runOne(id);
    }),
  );
}

await main();
