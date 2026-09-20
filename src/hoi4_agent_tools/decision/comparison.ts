import { hashCanonical } from '../core/canonical.js';
import type { ConditionScenario } from '../core/condition-model.js';
import type { ScanSnapshot } from '../core/engine.js';
import { inspectDecisionCost, type DecisionCostInspection } from './cost.js';
import { evaluateDecisionGates, type DecisionGateEvaluation } from './evaluation.js';
import { inspectDecisionLifecycle, type DecisionLifecycleInspection } from './lifecycle.js';
import {
  decisionSourceInventory,
  decisionTargetCatalog,
  type DecisionTargetCatalog,
} from './source-inventory.js';

export interface DecisionScenarioInspection {
  targeting: DecisionTargetCatalog;
  gates: DecisionGateEvaluation;
  cost: DecisionCostInspection;
  lifecycle: DecisionLifecycleInspection;
}

export interface DecisionScenarioComparison {
  scenarioId: string;
  before: DecisionScenarioInspection | null;
  after: DecisionScenarioInspection | null;
  changed: string[];
}

export interface DecisionComparison {
  id: string;
  beforeRevision: string;
  afterRevision: string;
  complete: boolean;
  cases: DecisionScenarioComparison[];
}

export function inspectDecisionScenario(
  snapshot: ScanSnapshot,
  id: string,
  scenario: ConditionScenario,
): DecisionScenarioInspection | null {
  const source = decisionSourceInventory(snapshot).decisions.find(
    (candidate) => candidate.id === id,
  );
  if (source === undefined) return null;
  return {
    targeting: decisionTargetCatalog(source),
    gates: evaluateDecisionGates(snapshot, id, scenario),
    cost: inspectDecisionCost(snapshot, source, scenario),
    lifecycle: inspectDecisionLifecycle(snapshot, source, scenario),
  };
}

function differences(
  before: DecisionScenarioInspection | null,
  after: DecisionScenarioInspection | null,
): string[] {
  if (before === null || after === null) return before === after ? [] : ['definition'];
  const fields: Array<[string, unknown, unknown]> = [
    ['targeting', before.targeting, after.targeting],
    ['category_allowed', before.gates.categoryAllowed.state, after.gates.categoryAllowed.state],
    ['decision_allowed', before.gates.decisionAllowed.state, after.gates.decisionAllowed.state],
    ['category_visible', before.gates.categoryVisible.state, after.gates.categoryVisible.state],
    [
      'decision_visible',
      before.gates.decisionVisible?.state ?? null,
      after.gates.decisionVisible?.state ?? null,
    ],
    [
      'category_available',
      before.gates.categoryAvailable.state,
      after.gates.categoryAvailable.state,
    ],
    [
      'decision_available',
      before.gates.decisionAvailable.state,
      after.gates.decisionAvailable.state,
    ],
    ['eligible', before.gates.eligible, after.gates.eligible],
    ['visible', before.gates.visible, after.gates.visible],
    ['available', before.gates.available, after.gates.available],
    ['target_selection', before.gates.targetSelection.state, after.gates.targetSelection.state],
    ['target_trigger', before.gates.targetTrigger.state, after.gates.targetTrigger.state],
    ['cost_kind', before.cost.kind, after.cost.kind],
    ['cost_amount', before.cost.amount, after.cost.amount],
    ['affordable', before.cost.affordable, after.cost.affordable],
    [
      'payment_effects',
      before.cost.paymentEffects.map(({ resource, amount, operation, scope }) => ({
        resource,
        amount,
        operation,
        scope,
      })),
      after.cost.paymentEffects.map(({ resource, amount, operation, scope }) => ({
        resource,
        amount,
        operation,
        scope,
      })),
    ],
    ['lifecycle', before.lifecycle, after.lifecycle],
  ];
  return fields
    .filter(([, left, right]) => hashCanonical(left) !== hashCanonical(right))
    .map(([field]) => field);
}

/** Compare declared scenarios against two revision-pinned source snapshots. */
export function compareDecisionScenarios(
  before: ScanSnapshot,
  after: ScanSnapshot,
  id: string,
  scenarios: readonly ConditionScenario[],
): DecisionComparison {
  if (before.workspaceId !== after.workspaceId)
    throw new Error('Decision comparison crosses workspace boundaries');
  if (scenarios.length < 1 || scenarios.length > 64)
    throw new RangeError('Decision comparison requires 1-64 scenarios');
  if (id.length === 0 || id.length > 512) throw new RangeError('Decision identifier is invalid');
  const seen = new Set<string>();
  const cases = scenarios.map((scenario) => {
    if (seen.has(scenario.id)) throw new Error(`Duplicate decision scenario: ${scenario.id}`);
    seen.add(scenario.id);
    const baseline = inspectDecisionScenario(before, id, scenario);
    const proposed = inspectDecisionScenario(after, id, scenario);
    return {
      scenarioId: scenario.id,
      before: baseline,
      after: proposed,
      changed: differences(baseline, proposed),
    };
  });
  return {
    id,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    complete:
      before.complete &&
      after.complete &&
      cases.every(
        ({ before: baseline, after: proposed }) =>
          (baseline !== null || proposed !== null) &&
          (baseline?.gates.complete ?? true) &&
          (proposed?.gates.complete ?? true) &&
          (baseline?.cost.unresolved.length ?? 0) === 0 &&
          (proposed?.cost.unresolved.length ?? 0) === 0 &&
          (baseline?.lifecycle.unresolved.length ?? 0) === 0 &&
          (proposed?.lifecycle.unresolved.length ?? 0) === 0,
      ),
    cases,
  };
}
