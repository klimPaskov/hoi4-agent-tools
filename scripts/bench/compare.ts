import { caseLatency, type CaseResult, type RunResult } from './runner.js';
import { SURFACES, type Baseline } from './schema.js';

/**
 * Compares a run with a stored baseline and writes the report. A regression is a case that
 * passed and now fails, an answer that was inline and now needs an artifact, more false
 * positives on a known-good sweep, or (in the local run) a warm p95 that got much slower. Cases
 * on a corpus whose pin changed are listed apart: a changed mod or game build can move the
 * ground truth, so they are flagged for a look instead of failing the run.
 */

export interface Comparison {
  regressions: string[];
  changedCorpusFindings: string[];
  improvements: string[];
  newCases: string[];
  changedCorpora: string[];
}

/** A warm p95 counts as slower above 1.5 times the baseline and at least 50 ms more. */
export function isSlower(current: number, baseline: number): boolean {
  return current > baseline * 1.5 && current - baseline >= 50;
}

export function toBaseline(run: RunResult, withLatency: boolean): Baseline {
  const cases: Baseline['cases'] = {};
  const latency: Record<string, number> = {};
  for (const result of run.cases) {
    if (result.outcome === 'unavailable' || result.outcome === 'error') continue;
    cases[result.id] = {
      passed: result.outcome === 'passed',
      inline: result.inline,
      ...(result.falsePositives === undefined ? {} : { falsePositives: result.falsePositives }),
      ...(result.files === undefined ? {} : { files: result.files }),
    };
    const p95 = caseLatency(result);
    if (withLatency && p95 !== undefined) latency[result.id] = p95;
  }
  return {
    suite: run.suite,
    cases,
    corpora: Object.fromEntries(
      run.corpora
        .filter(({ identity }) => identity !== 'unavailable')
        .map(({ id, identity }) => [id, identity]),
    ),
    ...(withLatency ? { latency } : {}),
  };
}

export function compareRun(run: RunResult, baseline: Baseline | undefined): Comparison {
  const comparison: Comparison = {
    regressions: [],
    changedCorpusFindings: [],
    improvements: [],
    newCases: [],
    changedCorpora: [],
  };
  if (baseline === undefined) return comparison;
  const changed = new Set<string>();
  for (const pin of run.corpora) {
    const before = baseline.corpora[pin.id];
    if (before !== undefined && pin.identity !== 'unavailable' && before !== pin.identity) {
      changed.add(pin.id);
      comparison.changedCorpora.push(pin.id);
    }
  }
  for (const result of run.cases) {
    if (result.outcome === 'unavailable') continue;
    const before = baseline.cases[result.id];
    if (before === undefined) {
      comparison.newCases.push(`${result.id}: ${result.outcome}`);
      continue;
    }
    const findings: string[] = [];
    const passed = result.outcome === 'passed';
    if (before.passed && !passed)
      findings.push(`${result.id} now fails: ${result.failures[0] ?? result.outcome}`);
    else if (!before.passed && passed) comparison.improvements.push(`${result.id} now passes`);
    if (before.inline && passed && !result.inline)
      findings.push(`${result.id} no longer answers inline`);
    else if (!before.inline && result.inline && before.passed)
      comparison.improvements.push(`${result.id} now answers inline`);
    if (before.falsePositives !== undefined && result.falsePositives !== undefined) {
      if (result.falsePositives > before.falsePositives)
        findings.push(
          `${result.id} false positives ${before.falsePositives} -> ${result.falsePositives}`,
        );
      else if (result.falsePositives < before.falsePositives)
        comparison.improvements.push(
          `${result.id} false positives ${before.falsePositives} -> ${result.falsePositives}`,
        );
    }
    const p95 = caseLatency(result);
    const baselineP95 = baseline.latency?.[result.id];
    if (p95 !== undefined && baselineP95 !== undefined && passed) {
      if (isSlower(p95, baselineP95)) findings.push(`${result.id} p95 ${baselineP95} -> ${p95} ms`);
      else if (isSlower(baselineP95, p95))
        comparison.improvements.push(`${result.id} p95 ${baselineP95} -> ${p95} ms`);
    }
    if (changed.has(result.corpus)) comparison.changedCorpusFindings.push(...findings);
    else comparison.regressions.push(...findings);
  }
  return comparison;
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function surfaceRows(cases: CaseResult[]): string[] {
  const rows: string[] = [];
  for (const surface of SURFACES) {
    const own = cases.filter(
      (result) => result.surface === surface && result.outcome !== 'unavailable',
    );
    if (own.length === 0) continue;
    const passed = own.filter(({ outcome }) => outcome === 'passed').length;
    const inline = own.filter(({ inline }) => inline).length;
    const sweeps = own.filter(({ falsePositives }) => falsePositives !== undefined);
    const falsePositives = sweeps.reduce((sum, { falsePositives = 0 }) => sum + falsePositives, 0);
    const files = sweeps.reduce((sum, { files = 0 }) => sum + files, 0);
    const budgets = own.filter(({ budgetMs }) => budgetMs !== undefined);
    const withinBudget = budgets.filter(
      (result) => (caseLatency(result) ?? Infinity) <= result.budgetMs!,
    ).length;
    rows.push(
      `| ${surface} | ${passed}/${own.length} | ${inline}/${own.length} | ${sweeps.length === 0 ? '' : `${falsePositives} in ${files} files`} | ${budgets.length === 0 ? '' : `${withinBudget}/${budgets.length}`} |`,
    );
  }
  return rows;
}

export function markdownReport(run: RunResult, comparison: Comparison): string {
  const lines = [
    `# Benchmark: ${run.suite} suite`,
    '',
    `Run ${run.startedAt} on ${run.platform}, Node ${run.node}${run.toolsCommit === undefined ? '' : `, hoi4-agent-tools ${run.toolsCommit.slice(0, 12)}`}, ${Math.round(run.durationMs / 1000)} s.`,
    '',
    '## Corpora',
    '',
    '| Corpus | Version | Git commit | Workshop manifest | Content hash | Files |',
    '| --- | --- | --- | --- | --- | --- |',
    ...run.corpora.map(
      (pin) =>
        `| ${pin.id} | ${pin.identity === 'unavailable' ? 'unavailable' : (pin.version ?? '')} | ${pin.gitCommit?.slice(0, 12) ?? ''}${pin.gitDirtyFiles ? ` (+${pin.gitDirtyFiles} changed)` : ''} | ${pin.workshopManifest ?? ''} | ${pin.contentHash?.slice(0, 16) ?? ''} | ${pin.files ?? ''} |`,
    ),
    '',
    '## By surface',
    '',
    '| Surface | Correct | Answered inline | False positives on known-good files | Within latency target |',
    '| --- | --- | --- | --- | --- |',
    ...surfaceRows(run.cases),
    '',
    '## Compared with the baseline',
    '',
    `- Regressions: ${comparison.regressions.length}`,
    ...comparison.regressions.map((line) => `  - ${line}`),
    `- Improvements: ${comparison.improvements.length}`,
    ...comparison.improvements.map((line) => `  - ${line}`),
    ...(comparison.changedCorpora.length === 0
      ? []
      : [
          `- Corpora changed since the baseline: ${comparison.changedCorpora.join(', ')}. Possible regressions on them, for a look:`,
          ...comparison.changedCorpusFindings.map((line) => `  - ${line}`),
        ]),
    ...(comparison.newCases.length === 0
      ? []
      : [
          `- New cases: ${comparison.newCases.length}`,
          ...comparison.newCases.map((line) => `  - ${line}`),
        ]),
    '',
    '## Cases',
    '',
    '| Case | Problem | Outcome | Inline | ms (p95) | Target | Bytes | First failure |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.cases.map(
      (result) =>
        `| ${result.id} | ${result.problem ?? ''} | ${result.outcome} | ${result.inline ? 'yes' : 'no'} | ${caseLatency(result) ?? ''} | ${result.budgetMs ?? ''} | ${result.structuredBytes || ''} | ${cell((result.failures[0] ?? '').slice(0, 200))} |`,
    ),
  ];
  const sweeps = run.cases.filter(({ examples }) => examples !== undefined && examples.length > 0);
  if (sweeps.length > 0) {
    lines.push('', '## False positives on known-good files', '');
    for (const sweep of sweeps) {
      lines.push(
        `### ${sweep.id}`,
        '',
        `${sweep.falsePositives} in ${sweep.files} files. By code: ${Object.entries(
          sweep.falsePositiveCodes ?? {},
        )
          .sort((left, right) => right[1] - left[1])
          .map(([code, count]) => `${code} ${count}`)
          .join(', ')}.`,
        '',
        ...(sweep.examples ?? []).map((example) => `- ${cell(example)}`),
        '',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
