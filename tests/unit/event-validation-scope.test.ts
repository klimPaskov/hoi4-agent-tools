import { describe, expect, it } from 'vitest';
import { eventGraphValidation } from '../../src/hoi4_agent_tools/event/operations.js';
import type { EventGraphSnapshot } from '../../src/hoi4_agent_tools/event/model.js';

const diagnostic = (path: string, severity: 'error' | 'warning') => ({
  code: 'TEST_DIAGNOSTIC',
  severity,
  category: 'syntax',
  message: 'A diagnostic of the test graph',
  location: {
    path,
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 1, line: 1, column: 2 },
  },
});

function graph(diagnostics: ReturnType<typeof diagnostic>[]): EventGraphSnapshot {
  return {
    complete: false,
    analysisMode: 'focused',
    skippedSourceCount: 0,
    statistics: {},
    diagnostics,
    issues: [],
  } as unknown as EventGraphSnapshot;
}

describe('event validation scope', () => {
  const snapshot = graph([
    diagnostic('mod:events/a.txt', 'error'),
    diagnostic('mod:events/b.txt', 'warning'),
  ]);

  it('counts every blocking diagnostic of the workspace when no answer is named', () => {
    expect(eventGraphValidation(snapshot).passed).toBe(false);
  });

  it('fails an answer whose own files have a blocking diagnostic, and says so', () => {
    const validation = eventGraphValidation(snapshot, new Set(['mod:events/a.txt']));
    expect(validation.passed).toBe(false);
    expect(validation.checks[0]?.message).toContain('in the files of this answer');
  });

  it('passes an answer whose files have none, and names the diagnostics elsewhere', () => {
    const validation = eventGraphValidation(snapshot, new Set(['mod:events/b.txt']));
    expect(validation.passed).toBe(true);
    expect(validation.checks[0]?.message).toContain('1 elsewhere in the workspace');
  });

  it("treats a blocking diagnostic with no file as the workspace's, not the answer's", () => {
    const unlocated = graph([{ ...diagnostic('x', 'error'), location: undefined } as never]);
    // A blocking diagnostic that points at no file is workspace-level: it is not this answer's.
    expect(eventGraphValidation(unlocated, new Set(['mod:events/a.txt'])).passed).toBe(true);
    expect(eventGraphValidation(unlocated).passed).toBe(false);
  });
});
