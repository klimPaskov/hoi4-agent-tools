import { writeFileSync } from 'node:fs';
import process from 'node:process';
import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
  TestSpecification,
} from 'vitest/node';
import { compareCodeUnits } from '../src/hoi4_agent_tools/core/canonical.js';
import type { LocalTestCompletion, LocalTestReport } from './testing/local-test-harness.js';

// Machine-readable evidence for the project-owned local validation harness.
export default class LocalTestReporter implements Reporter {
  readonly #reportPath = process.env.HOI4_LOCAL_TEST_REPORT;
  readonly #report: LocalTestReport = {
    completed: [],
    ended: false,
    modules: [],
    specifications: [],
    started: false,
    unhandledErrors: 0,
    version: 1,
  };

  constructor() {
    this.#write();
  }

  onTestRunStart(specifications: readonly TestSpecification[]): void {
    this.#report.started = true;
    this.#report.specifications = specifications.map(({ moduleId }) => moduleId).sort();
    this.#write();
  }

  onTestModuleCollected(testModule: TestModule): void {
    if (!this.#report.modules.includes(testModule.moduleId)) {
      this.#report.modules.push(testModule.moduleId);
      this.#report.modules.sort();
      this.#write();
    }
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    if (result.state === 'pending') return;
    const completion: LocalTestCompletion = {
      id: testCase.id,
      moduleId: testCase.module.moduleId,
      name: testCase.fullName,
      state: result.state,
    };
    this.#report.completed = this.#report.completed.filter(({ id }) => id !== completion.id);
    this.#report.completed.push(completion);
    this.#report.completed.sort((left, right) => compareCodeUnits(left.id, right.id));
    this.#write();
  }

  onTestRunEnd(
    testModules: readonly TestModule[],
    unhandledErrors: readonly unknown[],
    reason: TestRunEndReason,
  ): void {
    this.#report.modules = [
      ...new Set([...this.#report.modules, ...testModules.map(({ moduleId }) => moduleId)]),
    ].sort();
    this.#report.unhandledErrors = unhandledErrors.length;
    this.#report.reason = reason;
    this.#report.ended = true;
    this.#write();
  }

  #write(): void {
    if (this.#reportPath === undefined) return;
    writeFileSync(this.#reportPath, `${JSON.stringify(this.#report, null, 2)}\n`, 'utf8');
  }
}
