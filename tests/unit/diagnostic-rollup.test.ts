import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import {
  diagnosticOccurrenceCount,
  diagnosticSeverityCounts,
  rollupRepeatedSoftDiagnostics,
} from '../../src/hoi4_agent_tools/core/diagnostic-rollup.js';

function warning(index: number): Diagnostic {
  return {
    code: 'MAP_REPEATED_WARNING',
    severity: 'warning',
    category: 'map',
    message: `Province ${index} needs review`,
    operationId: index % 2 === 0 ? 'one' : 'two',
    location: {
      path: `mod:map/${index}.txt`,
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 2, offset: 1 },
    },
    details: { provinceId: index },
  };
}

describe('bounded diagnostic warning rollups', () => {
  it('keeps occurrence counts, deterministic samples and complete evidence links', () => {
    const diagnostics = Array.from({ length: 500 }, (_, index) => warning(index));
    const evidence = {
      uri: 'hoi4://artifact/report',
      name: 'map-validation.json',
      mimeType: 'application/json',
    };
    const rolled = rollupRepeatedSoftDiagnostics(diagnostics, evidence);
    expect(rolled).toHaveLength(1);
    expect(rolled[0]).toMatchObject({
      code: 'MAP_REPEATED_WARNING',
      severity: 'warning',
      details: {
        occurrenceCount: 500,
        retainedSamples: 8,
        operationCount: 2,
        operationIds: ['one', 'two'],
        locationCount: 500,
        completeDiagnosticEvidence: evidence,
      },
    });
    expect(rollupRepeatedSoftDiagnostics([...diagnostics].reverse(), evidence)).toEqual(rolled);
    expect(diagnosticSeverityCounts(rolled).warning).toBe(500);
  });

  it('never groups or drops errors, blockers or omission markers', () => {
    const hard: Diagnostic[] = [
      { code: 'MAP_ERROR', severity: 'error', category: 'map', message: 'First error' },
      { code: 'MAP_ERROR', severity: 'error', category: 'map', message: 'Second error' },
      { code: 'MAP_BLOCKED', severity: 'blocker', category: 'map', message: 'Blocked' },
      {
        code: 'MAP_DIAGNOSTICS_TRUNCATED',
        severity: 'blocker',
        category: 'map',
        message: 'Hard diagnostics omitted',
        details: { omittedBySeverity: { error: 12, warning: 25 } },
      },
    ];
    const rolled = rollupRepeatedSoftDiagnostics([
      ...Array.from({ length: 500 }, (_, index) => warning(index)),
      ...hard,
    ]);
    for (const diagnostic of hard) expect(rolled).toContainEqual(diagnostic);
    expect(rolled.filter(({ severity }) => severity === 'error')).toHaveLength(2);
    expect(diagnosticSeverityCounts(rolled)).toEqual({
      info: 0,
      warning: 525,
      error: 14,
      blocker: 1,
    });
  });

  it('preserves distinct severities and codes and ignores unrelated count fields', () => {
    const first = warning(0);
    expect(diagnosticOccurrenceCount({ ...first, details: { occurrenceCount: 999 } })).toBe(1);
    const rolled = rollupRepeatedSoftDiagnostics([
      first,
      { ...warning(1), severity: 'info' },
      { ...warning(2), code: 'OTHER_CODE' },
    ]);
    expect(rolled).toHaveLength(3);
    expect(diagnosticSeverityCounts(rolled)).toEqual({ info: 1, warning: 2, error: 0, blocker: 0 });
  });
});
