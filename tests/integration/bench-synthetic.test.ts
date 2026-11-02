import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareRun, markdownReport, toBaseline } from '../../scripts/bench/compare.js';
import { BENCH_ROOT, runSuite, type RunResult } from '../../scripts/bench/runner.js';
import { baselineSchema } from '../../scripts/bench/schema.js';

/**
 * The CI gate of the benchmark (decision Q-1): the synthetic suite runs through the real stdio
 * server on every platform, and any case that passed in `bench/baselines/synthetic.json` and
 * fails now, answers inline no longer, or finds more false positives fails the build. A fix
 * that makes a case pass updates the baseline with `npm run bench -- --update-baseline`.
 */

let temporary = '';
let run: RunResult;

beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-bench-ci-'));
  run = await runSuite({ suite: 'synthetic', temporaryRoot: temporary, hashContent: false });
}, 900_000);

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
});

describe('benchmark synthetic suite', () => {
  it('runs every synthetic case without a harness error', () => {
    expect(run.cases.length).toBeGreaterThan(20);
    expect(run.cases.filter(({ outcome }) => outcome === 'error')).toEqual([]);
  });

  it('has no regression against the committed baseline', async () => {
    const baseline = baselineSchema.parse(
      JSON.parse(await readFile(path.join(BENCH_ROOT, 'baselines', 'synthetic.json'), 'utf8')),
    );
    const comparison = compareRun(run, baseline);
    if (comparison.regressions.length > 0) process.stderr.write(markdownReport(run, comparison));
    expect(comparison.regressions).toEqual([]);
    // A case that newly passes must be recorded, so it cannot silently fail again later.
    expect(comparison.improvements, 'update bench/baselines/synthetic.json').toEqual([]);
    expect(Object.keys(baseline.cases).sort()).toEqual(
      Object.keys(toBaseline(run, false).cases).sort(),
    );
  });
});
