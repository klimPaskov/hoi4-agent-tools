import { describe, expect, it } from 'vitest';
import {
  evaluateLocalTestRun,
  localVitestArguments,
  REQUIRED_LOCAL_TEST_NAMES,
  type LocalTestObservation,
  type LocalTestReport,
} from '../../scripts/testing/local-test-harness.js';

function report(overrides: Partial<LocalTestReport> = {}): LocalTestReport {
  return {
    completed: REQUIRED_LOCAL_TEST_NAMES.map((name, index) => ({
      id: `required-${index}`,
      moduleId: '/project/tests/local/external-workspaces.test.ts',
      name,
      state: 'passed',
    })),
    ended: true,
    modules: ['/project/tests/local/external-workspaces.test.ts'],
    reason: 'passed',
    specifications: ['/project/tests/local/external-workspaces.test.ts'],
    started: true,
    unhandledErrors: 0,
    version: 1,
    ...overrides,
  };
}

function observation(overrides: Partial<LocalTestObservation> = {}): LocalTestObservation {
  return {
    exitCode: 0,
    output: '',
    report: report(),
    signal: null,
    ...overrides,
  };
}

describe('local integration test harness', () => {
  it('routes Vitest only through the standalone local config and tests/local', () => {
    expect(localVitestArguments()).toEqual([
      'run',
      '--config',
      'vitest.local.config.ts',
      'tests/local',
    ]);
  });

  it('accepts only a run containing all four required local workflows', () => {
    expect(evaluateLocalTestRun(observation())).toEqual({ exitCode: 0, issues: [] });
  });

  it('propagates ordinary Vitest failures', () => {
    expect(evaluateLocalTestRun(observation({ exitCode: 7 })).exitCode).toBe(7);
  });

  it('rejects the zero-exit Vitest worker OOM signature', () => {
    const result = evaluateLocalTestRun(
      observation({
        output: `Vitest caught 1 unhandled error during the test run.
Unhandled Error
Error: Worker terminated due to reaching memory limit: JS heap out of memory
code: 'ERR_WORKER_OUT_OF_MEMORY'`,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.issues.join('\n')).toMatch(/out-of-memory/u);
  });

  it('fails closed on incomplete, skipped, unhandled, OOM, and non-local runs', () => {
    const incomplete = evaluateLocalTestRun(
      observation({ report: report({ completed: report().completed.slice(0, 1) }) }),
    );
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.issues.join('\n')).toMatch(/missing required local tests/iu);

    const skipped = evaluateLocalTestRun(
      observation({
        report: report({
          completed: report().completed.map((entry) => ({ ...entry, state: 'skipped' })),
        }),
      }),
    );
    expect(skipped.exitCode).toBe(1);

    const unhandled = evaluateLocalTestRun(observation({ report: report({ unhandledErrors: 1 }) }));
    expect(unhandled.exitCode).toBe(1);

    const oom = evaluateLocalTestRun(
      observation({ output: 'FATAL ERROR: Allocation failed - JavaScript heap out of memory' }),
    );
    expect(oom.exitCode).toBe(1);

    const nonLocal = evaluateLocalTestRun(
      observation({ report: report({ modules: ['/project/tests/unit/not-local.test.ts'] }) }),
    );
    expect(nonLocal.exitCode).toBe(1);
    expect(nonLocal.issues.join('\n')).toMatch(/outside tests\/local/u);
  });
});
