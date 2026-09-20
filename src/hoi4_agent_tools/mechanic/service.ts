import { analysisSourceEvidence } from '../core/analysis-evidence.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { copyScenario, type ScenarioState, type SharedScenario } from '../core/scenario-model.js';
import { inspectDecisionCost } from '../decision/cost.js';
import { decisionSourceInventory } from '../decision/source-inventory.js';
import type { MechanicCase, MechanicTestRequest } from '../schemas/scenarios.js';
import { PACKAGE_VERSION } from '../version.js';
import { evaluateMechanicAssertions } from './assertions.js';
import { MechanicInterpreter } from './interpreter.js';
import { scriptedEffectSources, selectMechanicSource } from './source.js';

export interface MechanicServiceInput extends MechanicTestRequest {
  principal?: string;
  signal?: AbortSignal;
}

export function runMechanicCase(snapshot: ScanSnapshot, test: MechanicCase) {
  // Zod's optional output permits explicit undefined; JSON cloning drops those
  // keys before the stricter internal scenario interface is used.
  const scenario = JSON.parse(JSON.stringify(test.scenario)) as SharedScenario;
  const definitions = ClausewitzEvaluationDefinitions.build(snapshot);
  const interpreter = new MechanicInterpreter(
    scenario,
    definitions,
    scriptedEffectSources(snapshot),
  );
  const before = copyScenario(scenario);
  const checkpoints: ScenarioState[] = [copyScenario(scenario)];
  const decisions = decisionSourceInventory(snapshot).decisions;
  for (const step of test.steps) {
    if (step.kind === 'advance_days') interpreter.advanceDays(step.days);
    else {
      const source = selectMechanicSource(snapshot, step.source);
      for (let iteration = 0; iteration < step.repeat; iteration += 1) {
        if (step.source.kind === 'decision') {
          const decision = decisions.find(({ id }) => id === step.source.id);
          if (decision === undefined)
            throw new ServiceError(
              'MECHANIC_SOURCE_MISSING',
              'Selected decision is absent',
              step.source,
            );
          const cost = inspectDecisionCost(snapshot, decision, interpreter.result().state.scenario);
          if (
            cost.kind === 'invalid' ||
            cost.affordable === 'unresolved' ||
            cost.unresolved.length > 0
          ) {
            interpreter.unresolvedDecision(
              decision.path,
              'Decision cost or eligibility is unresolved',
            );
            continue;
          }
          if (cost.affordable === 'false') {
            interpreter.skipDecision(decision.path, 'Decision is unaffordable');
            continue;
          }
          if (cost.kind === 'engine_political_power') {
            if (cost.amount === null) {
              interpreter.unresolvedDecision(decision.path, 'Engine cost amount is unresolved');
              continue;
            }
            interpreter.payDecisionCost(cost.amount, decision.path);
          }
        }
        interpreter.execute(source);
      }
    }
    const current = interpreter.result().state;
    checkpoints.push({
      scenario: structuredClone(current.scenario),
      unknown: new Set(current.unknown),
      day: current.day,
    });
  }
  const execution = interpreter.result();
  const assertions = evaluateMechanicAssertions(
    test.assertions,
    before,
    execution.state,
    checkpoints,
    execution.trace,
  );
  return {
    id: test.id,
    sourceRevision: snapshot.revision,
    status: assertions.some(({ status }) => status === 'failed')
      ? 'failed'
      : assertions.some(({ status }) => status === 'unresolved') || !execution.complete
        ? 'unresolved'
        : 'passed',
    assertions,
    trace: execution.trace,
    unresolved: execution.unresolved,
    finalState: execution.state.scenario,
    unknown: [...execution.state.unknown].sort(),
    day: execution.state.day,
  };
}

/** Source-backed, read-only declared mechanic scenario tests. */
export class MechanicAnalyzer {
  constructor(private readonly engine: CoreEngine) {}

  async test(input: MechanicServiceInput) {
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    if (input.refresh) this.engine.invalidate(input.workspaceId);
    const snapshot = await this.engine.scan(input.workspaceId, {}, input.principal, input.signal);
    if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
      throw new ServiceError('MECHANIC_SOURCE_STALE', 'Mechanic source revision changed', {
        expectedRevision: input.expectedRevision,
        observedRevision: snapshot.revision,
      });
    const report = {
      schemaVersion: 'mechanic-test.v1',
      ...runMechanicCase(snapshot, input.test),
    };
    const reportHash = hashCanonical(report);
    const evidence = analysisSourceEvidence(snapshot);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      `mechanic-${reportHash.slice(0, 24)}.json`,
      'application/json',
      `${canonicalJson(report)}\n`,
      {
        kind: 'mechanic-test',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'mechanic-test.v1',
        sourceHashes: evidence.sourceHashes,
        metadata: {
          beforeRevision: snapshot.revision,
          sourceInventory: evidence.inventory,
        },
      },
      'Revision-pinned mechanic trace and assertion evidence',
      input.signal,
    );
    const result = emptyServiceResult(input.workspaceId, {
      sourceRevision: snapshot.revision,
      reportHash,
      status: report.status,
      assertions: report.assertions.length,
      passed: report.assertions.filter(({ status }) => status === 'passed').length,
      failed: report.assertions.filter(({ status }) => status === 'failed').length,
      unresolved:
        report.assertions.filter(({ status }) => status === 'unresolved').length +
        report.unresolved.length,
      steps: input.test.steps.length,
    });
    result.code =
      report.status === 'passed'
        ? 'MECHANIC_TEST_PASSED'
        : report.status === 'failed'
          ? 'MECHANIC_TEST_FAILED'
          : 'MECHANIC_TEST_UNRESOLVED';
    result.artifacts = [publicArtifactLink(artifact)];
    setInlineFilesScanned(
      result,
      snapshot.files.map(({ displayPath }) => displayPath),
    );
    result.validation = {
      passed: report.status === 'passed',
      checks: [
        {
          id: 'mechanic-assertions',
          passed: report.status === 'passed',
          message:
            report.status === 'passed'
              ? 'All declared mechanic assertions passed'
              : 'Inspect the linked trace for failed or unresolved assertions',
        },
      ],
    };
    return result;
  }
}
