export type LocalTestState = 'passed' | 'failed' | 'skipped';

export interface LocalTestCompletion {
  id: string;
  moduleId: string;
  name: string;
  state: LocalTestState;
}

export interface LocalTestReport {
  completed: LocalTestCompletion[];
  ended: boolean;
  modules: string[];
  reason?: 'passed' | 'interrupted' | 'failed';
  specifications: string[];
  started: boolean;
  unhandledErrors: number;
  version: number;
}

export interface LocalTestObservation {
  exitCode: number | null;
  fatalOutputDetected?: boolean;
  output: string;
  report?: LocalTestReport;
  reportError?: string;
  signal: NodeJS.Signals | null;
}

export interface LocalTestEvaluation {
  exitCode: number;
  issues: string[];
}

const fatalOutputPattern =
  /(?:ERR_WORKER_OUT_OF_MEMORY|heap out of memory|worker[^\r\n]*(?:out of memory|memory limit)|fatal error[^\r\n]*(?:heap|allocation)|vitest caught \d+ unhandled errors?|unhandled (?:error|rejection))/iu;

export const REQUIRED_LOCAL_TEST_NAMES = [
  'local installed-game and external-mod integration > indexes both roots and deterministically renders a large vanilla focus tree',
  'local installed-game and external-mod integration > builds and deterministically renders an offline GUI scene without launching HOI4',
  'local installed-game and external-mod integration > scans, renders, and stores the current map without launching HOI4',
  'local installed-game and external-mod integration > analyzes a large vanilla and external-mod event family without copying or changing sources',
] as const;

export function localVitestArguments(): string[] {
  return ['run', '--config', 'vitest.local.config.ts', 'tests/local'];
}

export function containsFatalLocalTestOutput(output: string): boolean {
  return fatalOutputPattern.test(output);
}

function isLocalTestPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith('tests/local/') || normalized.includes('/tests/local/');
}

export function evaluateLocalTestRun(observation: LocalTestObservation): LocalTestEvaluation {
  if (observation.signal !== null) {
    return {
      exitCode: 1,
      issues: [`Vitest terminated from signal ${observation.signal}`],
    };
  }
  if (observation.exitCode !== 0) {
    return {
      exitCode:
        observation.exitCode === null || observation.exitCode < 1 ? 1 : observation.exitCode,
      issues: [`Vitest exited with code ${observation.exitCode ?? 'unknown'}`],
    };
  }

  const issues: string[] = [];
  if (
    observation.fatalOutputDetected === true ||
    containsFatalLocalTestOutput(observation.output)
  ) {
    issues.push('Vitest output contains an unhandled worker, rejection, or out-of-memory error');
  }
  if (observation.reportError !== undefined) issues.push(observation.reportError);
  const report = observation.report;
  if (report === undefined) {
    issues.push('Vitest did not produce a local-test completion report');
    return { exitCode: 1, issues };
  }
  if (report.version !== 1 || !report.started || !report.ended) {
    issues.push('Vitest did not complete the reporter lifecycle');
  }
  if (report.reason !== 'passed') {
    issues.push(`Vitest reporter ended with reason ${report.reason ?? 'missing'}`);
  }
  if (report.unhandledErrors > 0) {
    issues.push(`Vitest reported ${report.unhandledErrors} unhandled error(s)`);
  }
  if (report.specifications.length === 0 || report.modules.length === 0) {
    issues.push('Vitest did not collect a local test module');
  }
  const routedOutsideLocal = [...report.specifications, ...report.modules].filter(
    (moduleId) => !isLocalTestPath(moduleId),
  );
  if (routedOutsideLocal.length > 0) {
    issues.push(`Vitest routed outside tests/local: ${routedOutsideLocal.join(', ')}`);
  }
  const completed = report.completed.filter(
    ({ state }) => state === 'passed' || state === 'failed',
  );
  const completedNames = new Set(completed.map(({ name }) => name));
  const missingRequired = REQUIRED_LOCAL_TEST_NAMES.filter((name) => !completedNames.has(name));
  if (missingRequired.length > 0) {
    issues.push(`Missing required local tests: ${missingRequired.join(', ')}`);
  }
  const unsuccessful = report.completed.filter(({ state }) => state !== 'passed');
  if (unsuccessful.length > 0) {
    issues.push(
      `Local tests did not pass: ${unsuccessful.map(({ name, state }) => `${name} (${state})`).join(', ')}`,
    );
  }

  return { exitCode: issues.length === 0 ? 0 : 1, issues };
}
