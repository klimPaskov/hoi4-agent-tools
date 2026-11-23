import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { z } from 'zod/v4';
import { hashCanonical } from '../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import type { Diagnostic } from '../src/hoi4_agent_tools/core/diagnostics.js';
import { CoreEngine } from '../src/hoi4_agent_tools/core/engine.js';
import { locateEngineBinary } from '../src/hoi4_agent_tools/core/engine-client.js';
import { callEngineOperation } from '../src/hoi4_agent_tools/core/engine-operation.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { MAP_BASELINE_DIAGNOSTIC_LIMIT } from '../src/hoi4_agent_tools/map/baseline.js';
import { engineValidateMapAsync } from '../src/hoi4_agent_tools/map/engine-validation.js';
import { AgentNudger } from '../src/hoi4_agent_tools/map/service.js';
import {
  typeScriptValidateMap,
  type MapValidationOptions,
  type MapValidationResult,
} from '../src/hoi4_agent_tools/map/validation.js';
import { locateCorpus } from './bench/corpus.js';
import { corpusFileSchema } from './bench/schema.js';

/**
 * Parity check for map validation on the engine (`map.validate`, ADR 0089 step 6, packet P13a).
 * On each workspace it scans the map with its appearance files, validates it with the
 * TypeScript checks and with the engine, and compares the findings by fingerprint (code,
 * message, path and symbol, as the map writer compares them), the order of the sorted findings,
 * `passed` and every check. It runs once with the default 2,000-finding ceiling and once with
 * the stated-baseline ceiling of 50,000, so no finding hides behind the cut.
 *
 *   npx tsx scripts/map-validation-parity.ts [--config FILE] [--corpus vanilla,owb] [--out FILE]
 *
 * The engine is `HOI4_ENGINE` (build it from this branch); the script stops when its `hello`
 * does not list `map.validate`. Difference counts are full counts, never a capped sample's length.
 * Exit status 1 when anything differs.
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
const hello = await callEngineOperation({
  op: 'hello',
  result: z.looseObject({ engine: z.string(), ops: z.array(z.string()) }),
});
if (!hello.result.ops.includes('map.validate')) {
  process.stderr.write(
    `${located.path} does not list map.validate; build the engine from this branch\n`,
  );
  process.exit(2);
}

function fingerprint(diagnostic: Diagnostic): string {
  return hashCanonical({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: diagnostic.location?.path ?? null,
    symbol: diagnostic.location?.symbol ?? null,
  });
}

interface Comparison {
  typeScript: number;
  engine: number;
  onlyTypeScript: number;
  onlyEngine: number;
  sameOrder: boolean;
  samePassed: boolean;
  differingChecks: string[];
  /** Codes of the differing findings with their counts, every one of them. */
  onlyTypeScriptByCode: Record<string, number>;
  onlyEngineByCode: Record<string, number>;
  samples: { typeScript: Diagnostic[]; engine: Diagnostic[] };
  typeScriptMs: number;
  engineMs: number;
}

function compare(
  left: MapValidationResult,
  right: MapValidationResult,
  typeScriptMs: number,
  engineMs: number,
): Comparison {
  const counts = new Map<string, number>();
  for (const d of left.diagnostics)
    counts.set(fingerprint(d), (counts.get(fingerprint(d)) ?? 0) + 1);
  const onlyEngine: Diagnostic[] = [];
  for (const d of right.diagnostics) {
    const key = fingerprint(d);
    const count = counts.get(key) ?? 0;
    if (count === 0) onlyEngine.push(d);
    else counts.set(key, count - 1);
  }
  const remaining = new Map(counts);
  const onlyTypeScript = left.diagnostics.filter((d) => {
    const key = fingerprint(d);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return false;
    remaining.set(key, count - 1);
    return true;
  });
  const byCode = (list: Diagnostic[]) => {
    const out: Record<string, number> = {};
    for (const { code } of list) out[code] = (out[code] ?? 0) + 1;
    return out;
  };
  return {
    typeScript: left.diagnostics.length,
    engine: right.diagnostics.length,
    onlyTypeScript: onlyTypeScript.length,
    onlyEngine: onlyEngine.length,
    sameOrder:
      JSON.stringify(left.diagnostics.map(fingerprint)) ===
      JSON.stringify(right.diagnostics.map(fingerprint)),
    samePassed: left.passed === right.passed,
    differingChecks: left.checks
      .filter((check, index) => JSON.stringify(check) !== JSON.stringify(right.checks[index]))
      .map(({ id }) => id),
    onlyTypeScriptByCode: byCode(onlyTypeScript),
    onlyEngineByCode: byCode(onlyEngine),
    samples: { typeScript: onlyTypeScript.slice(0, 5), engine: onlyEngine.slice(0, 5) },
    typeScriptMs,
    engineMs,
  };
}

async function run(
  index: Parameters<typeof typeScriptValidateMap>[0],
  options: MapValidationOptions,
): Promise<Comparison> {
  let started = performance.now();
  const left = typeScriptValidateMap(index, options);
  const typeScriptMs = Math.round(performance.now() - started);
  started = performance.now();
  const right = await engineValidateMapAsync(index, options);
  const engineMs = Math.round(performance.now() - started);
  return compare(left, right, typeScriptMs, engineMs);
}

const corpora = corpusFileSchema
  .parse(JSON.parse(await readFile(path.join('bench', 'corpus.json'), 'utf8')))
  .corpora.filter(({ kind }) => kind !== 'synthetic')
  .filter(({ id }) => values.corpus === undefined || values.corpus.split(',').includes(id));

const temporary = await mkdtemp(path.join(os.tmpdir(), 'hoi4-map-validation-parity-'));
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
      ({ index } = await nudger.scan('parity', undefined, undefined, false, false, true));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'error';
      process.stderr.write(`${corpus.id}: map model not built (${code})\n`);
      report[corpus.id] = { unavailable: `map model not built: ${code}` };
      continue;
    }
    const files = index.sourceFiles.length;
    const bytes = index.sourceFiles.reduce((sum, file) => sum + file.bytes.length, 0);
    const standard = await run(index, {});
    const full = await run(index, { diagnosticLimit: MAP_BASELINE_DIAGNOSTIC_LIMIT });
    const clean = (c: Comparison) =>
      c.onlyEngine === 0 &&
      c.onlyTypeScript === 0 &&
      c.samePassed &&
      c.differingChecks.length === 0;
    differs ||= !clean(standard) || !clean(full);
    report[corpus.id] = { files, bytes, standard, full };
    process.stderr.write(
      `${corpus.id}: ${files} files; ${full.typeScript} findings (TypeScript) / ${full.engine} (engine); only TypeScript ${full.onlyTypeScript}, only engine ${full.onlyEngine}, order ${full.sameOrder ? 'same' : 'differs'}; 2,000 cut: only TypeScript ${standard.onlyTypeScript}, only engine ${standard.onlyEngine}; TypeScript ${full.typeScriptMs} ms, engine ${full.engineMs} ms\n`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const text = `${JSON.stringify({ engine: located.path, engineVersion: hello.result.engine, corpora: report }, null, 2)}\n`;
if (values.out === undefined) process.stdout.write(text);
else await writeFile(values.out, text);
process.exit(differs ? 1 : 0);
