import { describe, expect, it } from 'vitest';
import { rankProblems, type CheckRun } from '../../src/hoi4_agent_tools/reference/mod-health.js';
import { modHealthDataSchema } from '../../src/hoi4_agent_tools/schemas/modder-tools.js';

const finding = (code: string, severity: 'error' | 'warning', path = 'events/a.txt', line = 3) => ({
  code,
  severity,
  message: `${code} at ${path}:${line}`,
  path,
  line,
});

describe('mod health ranking', () => {
  it('ranks errors first, then by weight and count, and counts each kind once', () => {
    const runs: CheckRun[] = [
      {
        check: 'engine_check',
        status: 'ran',
        ms: 10,
        findings: [
          ...Array.from({ length: 40 }, (_, index) =>
            finding('LINT_FLAG_NEVER_SET', 'warning', 'events/flags.txt', index + 1),
          ),
          finding('REF_UNKNOWN_EFFECT', 'error'),
          finding('REF_UNKNOWN_EFFECT', 'error', 'events/b.txt', 9),
          finding('REF_UNKNOWN_EFFECT', 'error', 'events/c.txt', 1),
          finding('REF_MISSING_LOCALISATION_KEY', 'error'),
        ],
      },
      {
        check: 'localisation',
        status: 'ran',
        ms: 5,
        // The localisation audit reports the same missing key; it is one problem.
        findings: [
          finding('LOC_KEY_UNDEFINED', 'warning', 'localisation/english/a_l_english.yml', 1),
        ],
        counts: { LOC_KEY_UNDEFINED: 4 },
      },
    ];
    const result = rankProblems(runs, 10);
    expect(modHealthDataSchema.safeParse(result).success).toBe(true);
    expect(result.problems.map(({ code, rank }) => `${rank}:${code}`)).toEqual([
      '1:REF_UNKNOWN_EFFECT',
      '2:REF_MISSING_LOCALISATION_KEY',
      '3:LINT_FLAG_NEVER_SET',
    ]);
    expect(result.problems[0]).toMatchObject({
      severity: 'error',
      count: 3,
      title: 'Effects the game does not know',
      examples: [
        { path: 'events/a.txt', line: 3 },
        { path: 'events/b.txt', line: 9 },
      ],
    });
    expect(result.problems[1]).toMatchObject({ check: 'engine_check', count: 4 });
    expect(result.verdict).toBe('problems');
    expect(result.totals).toEqual({
      problems: 3,
      findings: 47,
      errors: 2,
      warnings: 1,
      omitted: 0,
    });
  });

  it('keeps the top problems within the limit and says how many it left out', () => {
    const runs: CheckRun[] = [
      {
        check: 'script',
        status: 'ran',
        ms: 1,
        findings: ['A', 'B', 'C', 'D'].map((code) => finding(`CODE_${code}`, 'warning')),
      },
    ];
    const result = rankProblems(runs, 2);
    expect(result.problems).toHaveLength(2);
    expect(result.totals.omitted).toBe(2);
  });

  it('is healthy only when every audit ran, and incomplete when one could not', () => {
    const ran: CheckRun = { check: 'script', status: 'ran', ms: 1, findings: [] };
    const skipped: CheckRun = { check: 'assets', status: 'skipped', ms: 0, findings: [] };
    const unavailable: CheckRun = {
      check: 'engine_check',
      status: 'unavailable',
      ms: 0,
      findings: [],
      note: 'ENGINE_UNAVAILABLE: no engine',
    };
    expect(rankProblems([ran, skipped], 10).verdict).toBe('healthy');
    const incomplete = rankProblems([ran, unavailable], 10);
    expect(incomplete.verdict).toBe('incomplete');
    expect(incomplete.checks[1]).toMatchObject({
      status: 'unavailable',
      note: 'ENGINE_UNAVAILABLE: no engine',
    });
  });

  it("uses a check's own description for its groups", () => {
    const result = rankProblems(
      [
        {
          check: 'error_log',
          status: 'ran',
          ms: 1,
          findings: [finding('LOG_INVALID_TRIGGER', 'error')],
          describe: () => ({
            title: 'The game reports: invalid trigger',
            fix: 'Fix it.',
            weight: 90,
          }),
        },
        {
          check: 'engine_check',
          status: 'ran',
          ms: 1,
          findings: [finding('REF_UNKNOWN_EFFECT', 'error')],
        },
      ],
      10,
    );
    expect(result.problems.map(({ code }) => code)).toEqual([
      'LOG_INVALID_TRIGGER',
      'REF_UNKNOWN_EFFECT',
    ]);
    expect(result.problems[0]).toMatchObject({
      title: 'The game reports: invalid trigger',
      fix: 'Fix it.',
    });
  });
});
