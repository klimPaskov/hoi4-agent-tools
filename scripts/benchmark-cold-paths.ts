import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Project benchmark, not a packaged command: wall-clock timings of the slow first calls of a
 * real mod through the stdio entry point. It starts a server with an empty state folder, times
 * the calls, stops the server and starts a second one on the same state folder, so the second
 * column shows what the persistent analysis cache and a fresh process contribute.
 *
 *   HOI4_GAME_ROOT=... HOI4_EXTERNAL_MOD_ROOT=... npm run benchmark:cold
 *
 * Timings are wall-clock and depend on the machine's load; run it on a quiet machine to compare.
 */

const gameRoot = process.env.HOI4_GAME_ROOT;
const modRoot = process.env.HOI4_EXTERNAL_MOD_ROOT;
if (gameRoot === undefined || modRoot === undefined) {
  process.stderr.write('Set HOI4_GAME_ROOT and HOI4_EXTERNAL_MOD_ROOT.\n');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(root, 'src', 'bin', 'stdio.ts');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-cold-paths-'));
const configPath = path.join(temporary, 'config.json');
await mkdir(temporary, { recursive: true });
await writeFile(
  configPath,
  `${JSON.stringify({
    version: 1,
    serverStateRoot: path.join(temporary, 'state'),
    workspaceStorageRoot: path.join(temporary, 'workspaces'),
    workspaces: [{ id: 'bench', name: 'Benchmark mod', root: modRoot, gameRoot }],
  })}\n`,
);

interface Timing {
  label: string;
  milliseconds: number;
  code: string;
}

async function session(namespace: string | undefined): Promise<{ timings: Timing[]; ns: string }> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) environment[key] = value;
  environment.HOI4_AGENT_CONFIG = configPath;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, entry],
    cwd: root,
    env: environment,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'cold-path-benchmark', version: '1.0.0' });
  await client.connect(transport, { timeout: 300_000 });
  const timings: Timing[] = [];
  const call = async (label: string, name: string, args: Record<string, unknown>) => {
    const started = performance.now();
    const result = await client.callTool(
      { name, arguments: { workspaceId: 'bench', ...args } },
      undefined,
      { timeout: 1_800_000, resetTimeoutOnProgress: true },
    );
    const structured = (result.structuredContent ?? {}) as { code?: string; data?: unknown };
    timings.push({
      label,
      milliseconds: Math.round(performance.now() - started),
      code: structured.code ?? '',
    });
    return structured;
  };
  const overview = await call('mod_index overview', 'hoi4.mod_index', { mode: 'overview' });
  const picked =
    namespace ??
    (
      overview.data as { namespaces?: Array<{ namespace: string; events: number }> }
    ).namespaces?.sort((left, right) => right.events - left.events)[0]?.namespace ??
    '';
  await call('event_inspect lint (largest namespace)', 'hoi4.event_inspect', {
    mode: 'lint',
    selector: picked,
  });
  await call('decision_inspect inventory', 'hoi4.decision_inspect', { mode: 'inventory' });
  await client.close();
  return { timings, ns: picked };
}

try {
  const first = await session(undefined);
  const second = await session(first.ns);
  process.stdout.write(
    `| Call | First process, empty state (ms) | Second process, same state (ms) |\n| --- | --- | --- |\n`,
  );
  for (const [index, timing] of first.timings.entries())
    process.stdout.write(
      `| ${timing.label} | ${timing.milliseconds} (${timing.code}) | ${second.timings[index]?.milliseconds ?? ''} (${second.timings[index]?.code ?? ''}) |\n`,
    );
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
}
