import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { serverConfigurationSchema } from '../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../src/hoi4_agent_tools/core/workspace.js';
import { ReferenceService } from '../src/hoi4_agent_tools/reference/service.js';
import { referenceSearchRequestSchema } from '../src/hoi4_agent_tools/schemas/reference.js';
import { discoveryCases, validationCases } from './reference-discovery-cases.js';

/**
 * Measures held-out documentation discovery against a real offline wiki and installed game.
 * A result answers a case when its cited section contains a hand-checked answer line; it
 * lands when its cited line is within `LANDING_LINES` of that answer, so one bounded read
 * starting there shows the answer.
 */
const LANDING_LINES = 8;
const modRoot = process.argv[2];
const gameRoot = process.argv[3];
const cases = process.argv[4] === '--validation' ? validationCases : discoveryCases;
if (modRoot === undefined || gameRoot === undefined) {
  process.stderr.write('Usage: tsx scripts/evaluate-reference-discovery.ts MOD_ROOT GAME_ROOT\n');
  process.exit(2);
}

const resolver = await WorkspaceResolver.create(
  serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(tmpdir(), 'hoi4-reference-discovery-state'),
    workspaces: [{ id: 'evaluation', name: 'Reference discovery', root: modRoot, gameRoot }],
  }),
);
const workspace = resolver.get('evaluation');
const service = new ReferenceService();
const files = new Map<string, string[]>();
async function lines(file: string): Promise<string[]> {
  let cached = files.get(file);
  if (cached === undefined) {
    cached = (await readFile(file, 'utf8')).replace(/^\uFEFF/u, '').split(/\r?\n/u);
    files.set(file, cached);
  }
  return cached;
}

interface DiscoveryRow {
  query: string;
  kind: string;
  answerRank: number | null;
  landingRank: number | null;
  results: number;
  total: number;
  bytes: number;
  ms: number;
  top: string[];
}
const rows: DiscoveryRow[] = [];
const missingAnswers: string[] = [];
for (const item of cases) {
  const started = performance.now();
  const response = await service.search(
    workspace,
    referenceSearchRequestSchema.parse({ workspaceId: 'evaluation', query: item.query, limit: 5 }),
  );
  const ms = Math.round(performance.now() - started);
  let answerRank: number | null = null;
  let landingRank: number | null = null;
  for (const [index, result] of response.results.entries()) {
    const answers = item.answers.filter(({ file }) => path.basename(result.path) === file);
    if (answers.length === 0) continue;
    const source = await lines(result.path);
    const cited = result.matchLine ?? result.startLine;
    for (const answer of answers)
      for (
        let line = result.startLine;
        line <= Math.min(result.endLine, source.length);
        line += 1
      ) {
        if (!answer.line.test(source[line - 1]!)) continue;
        answerRank ??= index + 1;
        if (Math.abs(cited - line) <= LANDING_LINES) landingRank ??= index + 1;
      }
  }
  rows.push({
    query: item.query,
    kind: item.kind,
    answerRank,
    landingRank,
    results: response.results.length,
    total: response.total,
    bytes: Buffer.byteLength(JSON.stringify(response)),
    ms,
    top: response.results
      .slice(0, 3)
      .map(({ path: file, heading }) => `${path.basename(file)}#${heading}`),
  });
}

// Every case needs at least one answer that exists in the local sources, or it is invalid.
for (const item of cases) {
  let found = item.answers.length === 0;
  for (const answer of item.answers)
    for (const candidate of [
      path.join(gameRoot, 'documentation', answer.file),
      path.join(modRoot, 'paradox_wiki', answer.file),
    ]) {
      try {
        if ((await lines(candidate)).some((line) => answer.line.test(line))) found = true;
      } catch {
        // An absent source root leaves this alternative unconfirmed.
      }
    }
  if (!found) missingAnswers.push(item.query);
}

const scored = rows.filter(({ kind }) => kind !== 'negative');
const within = (rank: number | null, k: number) => rank !== null && rank <= k;
const rate = (predicate: (row: DiscoveryRow) => boolean, set = scored) =>
  `${set.filter(predicate).length}/${set.length}`;
const summary = {
  cases: scored.length,
  answerTop1: rate(({ answerRank }) => within(answerRank, 1)),
  answerTop3: rate(({ answerRank }) => within(answerRank, 3)),
  answerTop5: rate(({ answerRank }) => within(answerRank, 5)),
  landedTop3: rate(({ landingRank }) => within(landingRank, 3)),
  meanReciprocalRank: Number(
    (
      scored.reduce((sum, { answerRank }) => sum + (answerRank === null ? 0 : 1 / answerRank), 0) /
      scored.length
    ).toFixed(3),
  ),
  identifierTop1: rate(
    ({ answerRank }) => answerRank === 1,
    scored.filter(({ kind }) => kind === 'identifier'),
  ),
  negativeResults: rows.filter(({ kind }) => kind === 'negative').map(({ results }) => results),
  medianBytes: [...rows.map(({ bytes }) => bytes)].sort((a, b) => a - b)[
    Math.floor(rows.length / 2)
  ],
  maxMs: Math.max(...rows.map(({ ms }) => ms)),
  missingAnswers,
};
process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
if (missingAnswers.length > 0) process.exitCode = 1;
