import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAssertion, matchingItems, resolvePath } from '../../scripts/bench/assertions.js';
import { compareRun, isSlower, markdownReport, toBaseline } from '../../scripts/bench/compare.js';
import { contentHash } from '../../scripts/bench/corpus.js';
import {
  gameUpdateMarkdown,
  pinnedBuilds,
  stalePins,
  watchGame,
} from '../../scripts/bench/game-watch.js';
import { VERIFIED_GAME_RAW_VERSION } from '../../src/hoi4_agent_tools/probability/model.js';
import { documentedEffects, renderNativeEffects } from '../../scripts/generate-native-effects.js';
import { loadCases, loadCorpora, sweepFiles, type RunResult } from '../../scripts/bench/runner.js';
import { assertionSchema, caseSchema, type Assertion } from '../../scripts/bench/schema.js';

const result = {
  status: 'ok',
  code: 'EVENT_INSPECTED',
  data: {
    findings: [
      { code: 'A', status: 'error', line: 3 },
      { code: 'B', status: 'warning' },
    ],
    trace: { eventIds: ['x.1', 'x.2'] },
    nested: { deep: { owner: 'death_effect' } },
  },
  filesScanned: ['mod:events/a.txt'],
};

function check(assertion: Assertion, structured: unknown = result) {
  return checkAssertion(assertionSchema.parse(assertion), {
    structured,
    text: '{"status":"ok"}',
    isError: false,
    structuredBytes: 300,
    milliseconds: 12,
  });
}

describe('benchmark assertions', () => {
  it('reads dotted, indexed, wildcard and deep paths', () => {
    expect(resolvePath(result, 'data.findings[1].code').values).toEqual(['B']);
    expect(resolvePath(result, 'data.findings[*].code')).toEqual({
      values: ['A', 'B'],
      many: true,
    });
    expect(resolvePath(result, 'data.missing.key').values).toEqual([]);
    expect(resolvePath(result, '**').values).toContain('death_effect');
  });

  it('checks each operator and explains a failure', () => {
    expect(check({ path: 'status', equals: 'ok' })).toBeNull();
    expect(check({ path: 'status', equals: 'error' })).toBe('status is "ok", expected "error"');
    expect(check({ path: 'status', notEquals: 'ok' })).toBe('status is "ok"');
    expect(check({ path: 'data.findings[*].code', includes: 'A' })).toBeNull();
    expect(check({ path: 'data.trace.eventIds', includes: 'x.2' })).toBeNull();
    expect(check({ path: 'data.trace.eventIds', includes: 'x.3' })).toMatch(/does not contain/u);
    expect(check({ path: 'data.findings[*].status', excludes: 'error' })).toMatch(/contains/u);
    expect(check({ path: 'data.findings[*].status', excludes: 'fatal' })).toBeNull();
    expect(check({ path: '**', includes: 'death_eff' })).toBeNull();
    expect(check({ path: 'filesScanned', atMost: 1 })).toBeNull();
    expect(check({ path: 'filesScanned', atMost: 0 })).toBe(
      'filesScanned is 1, expected at most 0',
    );
    expect(check({ path: 'data.findings[*]', atLeast: 2 })).toBeNull();
    expect(check({ path: 'code', matches: '^EVENT_' })).toBeNull();
    expect(check({ path: 'data.nested', exists: true })).toBeNull();
    expect(check({ path: 'data.absent', exists: false })).toBeNull();
    expect(check({ path: 'data.absent', equals: 1 })).toBe('data.absent is missing');
  });

  it('reads the call facts behind the special paths', () => {
    expect(check({ path: '$text', includes: 'ok' })).toBeNull();
    expect(check({ path: '$bytes', atMost: 200 })).toBe('$bytes is 300, expected at most 200');
    expect(check({ path: '$isError', equals: false })).toBeNull();
    expect(check({ path: '$ms', atMost: 50 })).toBeNull();
  });

  it('rejects an assertion with no operator or two', () => {
    expect(assertionSchema.safeParse({ path: 'status' }).success).toBe(false);
    expect(assertionSchema.safeParse({ path: 'status', equals: 1, exists: true }).success).toBe(
      false,
    );
  });

  it('selects false positives by their fields', () => {
    expect(matchingItems(result, 'data.findings[*]', { status: 'error' })).toEqual([
      { code: 'A', status: 'error', line: 3 },
    ]);
  });
});

function run(cases: RunResult['cases'], identity = 'v1'): RunResult {
  return {
    suite: 'real',
    startedAt: '2026-11-01T00:00:00.000Z',
    durationMs: 1000,
    platform: 'win32-x64',
    node: 'v24.0.0',
    corpora: [{ id: 'mod', identity }],
    cases,
  };
}

function caseResult(
  id: string,
  outcome: 'passed' | 'failed',
  extra: Partial<RunResult['cases'][number]> = {},
): RunResult['cases'][number] {
  return {
    id,
    surface: 'event',
    corpus: 'mod',
    title: id,
    tool: 'hoi4.event_inspect',
    outcome,
    inline: outcome === 'passed',
    failures: outcome === 'passed' ? [] : ['status is "ok"'],
    milliseconds: [10],
    structuredBytes: 100,
    ...extra,
  };
}

describe('benchmark comparison', () => {
  const before = run([
    caseResult('kept', 'passed'),
    caseResult('broken', 'passed'),
    caseResult('fixed', 'failed'),
    caseResult('sweep', 'failed', { falsePositives: 4, files: 10, inline: false }),
    caseResult('slow', 'passed', { milliseconds: [100] }),
  ]);
  const baseline = toBaseline(before, true);

  it('stores outcomes, false positives and latency, not the run details', () => {
    expect(baseline.cases.sweep).toEqual({
      passed: false,
      inline: false,
      falsePositives: 4,
      files: 10,
    });
    expect(baseline.latency?.slow).toBe(100);
    expect(toBaseline(before, false).latency).toBeUndefined();
  });

  it('reports regressions and improvements against the baseline', () => {
    const after = run([
      caseResult('kept', 'passed'),
      caseResult('broken', 'failed'),
      caseResult('fixed', 'passed'),
      caseResult('sweep', 'failed', { falsePositives: 6, files: 10, inline: false }),
      caseResult('slow', 'passed', { milliseconds: [400] }),
      caseResult('new', 'passed'),
    ]);
    const comparison = compareRun(after, baseline);
    expect(comparison.regressions).toEqual([
      'broken now fails: status is "ok"',
      'sweep false positives 4 -> 6',
      'slow p95 100 -> 400 ms',
    ]);
    expect(comparison.improvements).toEqual(['fixed now passes']);
    expect(comparison.newCases).toEqual(['new: passed']);
    expect(markdownReport(after, comparison)).toContain('- Regressions: 3');
  });

  it('lists findings on a changed corpus apart instead of failing the run', () => {
    const after = run([caseResult('broken', 'failed')], 'v2');
    const comparison = compareRun(after, baseline);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.changedCorpora).toEqual(['mod']);
    expect(comparison.changedCorpusFindings).toEqual(['broken now fails: status is "ok"']);
  });

  it('treats a run without a baseline as having nothing to compare', () => {
    expect(compareRun(before, undefined).regressions).toEqual([]);
  });

  it('counts a p95 as slower only when it is both relatively and absolutely worse', () => {
    expect(isSlower(30, 10)).toBe(false);
    expect(isSlower(160, 100)).toBe(true);
    expect(isSlower(140, 100)).toBe(false);
  });
});

describe('benchmark data', () => {
  it('loads every case file and corpus with unique ids', async () => {
    const cases = await loadCases();
    const corpora = new Set((await loadCorpora()).map(({ id }) => id));
    expect(cases.length).toBeGreaterThan(20);
    for (const benchCase of cases) expect(corpora.has(benchCase.corpus)).toBe(true);
  });

  it('refuses a case without evidence for its expected answer', () => {
    expect(
      caseSchema.safeParse({
        id: 'x.case',
        surface: 'event',
        corpus: 'synthetic',
        title: 'A case',
        tool: 'hoi4.event_inspect',
        arguments: {},
        expect: [{ path: 'status', equals: 'ok' }],
      }).success,
    ).toBe(false);
  });

  it('samples sweep files evenly and hashes content deterministically', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bench-corpus-'));
    try {
      await mkdir(path.join(root, 'events'), { recursive: true });
      await mkdir(path.join(root, '.claude'), { recursive: true });
      await writeFile(path.join(root, '.claude', 'copy.txt'), 'ignored');
      for (let index = 0; index < 10; index++)
        await writeFile(path.join(root, 'events', `e${index}.txt`), `id = e.${index}\n`);
      await writeFile(path.join(root, 'events', 'icon.dds'), 'binary');
      const sweep = caseSchema.parse({
        id: 'x.sweep',
        kind: 'sweep',
        surface: 'validation',
        corpus: 'synthetic',
        title: 'Sweep',
        evidence: 'Synthetic',
        tool: 'hoi4.script_validate',
        files: ['events/*.txt'],
        exclude: ['events/e9.txt'],
        limit: 3,
        arguments: { path: '{path}' },
        falsePositives: { path: 'data.findings[*]', where: { status: 'error' } },
      });
      if (sweep.kind !== 'sweep') throw new Error('expected a sweep');
      expect(await sweepFiles(root, sweep)).toEqual([
        'events/e0.txt',
        'events/e3.txt',
        'events/e6.txt',
      ]);
      const first = await contentHash(root);
      expect(first.files).toBe(10);
      expect(await contentHash(root)).toEqual(first);
      expect((await contentHash(root, first.cache)).hash).toBe(first.hash);
      await writeFile(path.join(root, 'events', 'e0.txt'), 'id = e.changed\n');
      expect((await contentHash(root)).hash).not.toBe(first.hash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('game-update watcher', () => {
  async function game(root: string, version: string, effects: string[], strategyDoc: string) {
    await mkdir(path.join(root, 'documentation'), { recursive: true });
    await mkdir(path.join(root, 'common', 'ai_strategy'), { recursive: true });
    await writeFile(
      path.join(root, 'launcher-settings.json'),
      JSON.stringify({ rawVersion: version, version: `Test v${version} (abcd)` }),
    );
    await writeFile(
      path.join(root, 'documentation', 'effects_documentation.md'),
      effects.map((name) => `## ${name}\n\n* Supported Scopes: COUNTRY\n`).join('\n'),
    );
    await writeFile(path.join(root, 'common', 'ai_strategy', '_documentation.md'), strategyDoc);
  }

  it('records a build, sees no change, then reports a new build without touching the repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bench-game-'));
    try {
      const gameRoot = path.join(root, 'game');
      const data = path.join(root, 'data');
      await game(gameRoot, '1.0.0', ['add_political_power', 'old_effect'], '# Strategies\n\nA\n');
      expect((await watchGame(gameRoot, data)).status).toBe('recorded');
      expect((await watchGame(gameRoot, data)).status).toBe('unchanged');
      await game(
        gameRoot,
        '1.0.1',
        ['add_political_power', 'new_effect'],
        '# Strategies\n\nA changed\n\n## stockpile_fuel\n\nB\n',
      );
      const update = await watchGame(gameRoot, data);
      expect(update.status).toBe('changed');
      expect(update.previous?.rawVersion).toBe('1.0.0');
      expect(update.files.changed).toEqual([
        'common/ai_strategy/_documentation.md',
        'documentation/effects_documentation.md',
      ]);
      expect(update.headings).toContainEqual({
        file: 'common/ai_strategy/_documentation.md',
        added: ['stockpile_fuel'],
        removed: [],
        changed: ['Strategies'],
      });
      expect(update.nativeEffects?.added).toEqual(['new_effect']);
      expect(update.nativeEffects?.proposed.startsWith(data)).toBe(true);
      expect(gameUpdateMarkdown(update)).toContain('Game build changed');
      // The hand-kept data was checked against another build, so every run flags it (#70).
      expect(update.stalePins.map(({ installed }) => installed)).toEqual(['1.0.1', '1.0.1']);
      expect(gameUpdateMarkdown(update)).toContain('### Checked against another build');
      const unchanged = await watchGame(gameRoot, data);
      expect(unchanged.status).toBe('unchanged');
      expect(gameUpdateMarkdown(unchanged)).toContain('installed 1.0.1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flags only hand-kept data pinned to a build other than the installed one', async () => {
    const pins = [
      { data: 'adapters', pinned: '1.19.4.1' },
      { data: 'effects', pinned: '1.19.2.0' },
    ];
    expect(await stalePins('1.19.4.1', pins)).toEqual([
      { data: 'effects', pinned: '1.19.2.0', installed: '1.19.4.1' },
    ]);
    // The repository's own pins agree with each other.
    const own = await pinnedBuilds();
    expect(new Set(own.map(({ pinned }) => pinned)).size).toBe(1);
    expect(own[0]?.pinned).toBe(VERIFIED_GAME_RAW_VERSION);
  });

  it('generates the native-effects list from the documentation headings', () => {
    const names = documentedEffects('## b_effect\n\ntext\n\n## a_effect\n\n## Not An Effect\n');
    expect(names).toEqual(['a_effect', 'b_effect']);
    expect(renderNativeEffects(names, '1.19.4.1')).toContain("  'a_effect',\n  'b_effect',\n]);");
  });
});
