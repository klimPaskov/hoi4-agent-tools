import { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { evaluateTriggerBlock, type TriggerEvaluation } from '../core/condition-evaluator.js';
import type {
  ConditionScenario,
  ConditionSubject,
  ConditionUnresolved,
  TriState,
} from '../core/condition-model.js';
import type { ScanSnapshot } from '../core/engine.js';
import { assignments, type AssignmentNode, type BlockNode } from '../core/source/index.js';
import {
  decisionSourceInventory,
  type DecisionCategorySource,
  type DecisionFieldName,
  type DecisionSource,
} from './source-inventory.js';

export interface DecisionGateEvaluation {
  sourceRevision: string;
  id: string;
  category: string;
  kind: 'decision' | 'mission';
  actor: string | null;
  target: string | null;
  categoryAllowed: TriggerEvaluation;
  decisionAllowed: TriggerEvaluation;
  categoryVisible: TriggerEvaluation;
  decisionVisible: TriggerEvaluation | null;
  categoryAvailable: TriggerEvaluation;
  decisionAvailable: TriggerEvaluation;
  targetRoot: TriggerEvaluation;
  targetSelection: TriggerEvaluation;
  targetTrigger: TriggerEvaluation;
  activation: TriggerEvaluation | null;
  eligible: TriState;
  visible: TriState | null;
  available: TriState;
  complete: boolean;
  unresolved: ConditionUnresolved[];
}

function combine(values: readonly TriState[]): TriState {
  if (values.includes('false')) return 'false';
  return values.includes('unresolved') ? 'unresolved' : 'true';
}

function combineAny(values: readonly TriState[]): TriState {
  if (values.includes('true')) return 'true';
  return values.includes('unresolved') ? 'unresolved' : 'false';
}

function unresolved(message: string, candidateId: string): TriggerEvaluation {
  return {
    state: 'unresolved',
    unresolved: [{ code: 'DECISION_UNRESOLVED', message, candidateId }],
  };
}

function scalar(assignment: AssignmentNode | undefined): string | undefined {
  return assignment?.value.type === 'scalar' ? assignment.value.value : undefined;
}

function block(assignment: AssignmentNode | undefined): BlockNode | undefined {
  return assignment?.value.type === 'block' ? assignment.value : undefined;
}

function subject(source: DecisionSource | DecisionCategorySource): ConditionSubject {
  return {
    id: source.id,
    document: source.document,
    provenance: [
      {
        path: source.path,
        rootKind: source.rootKind,
        loadOrder: source.loadOrder,
        sourceHash: source.sourceHash,
        ...(source.location === undefined ? {} : { location: source.location }),
        symbol: source.id,
      },
    ],
  };
}

export function evaluateDecisionField(
  source: DecisionSource | DecisionCategorySource,
  name: DecisionFieldName,
  scenario: ConditionScenario,
  definitions: ClausewitzEvaluationDefinitions,
): TriggerEvaluation {
  const occurrences = source.fields[name];
  if (occurrences.length > 1)
    return unresolved(`Multiple ${name} blocks in ${source.path}`, source.id);
  const assignment = occurrences[0];
  if (assignment !== undefined && assignment.value.type !== 'block')
    return unresolved(`${name} is not a trigger block`, source.id);
  return evaluateTriggerBlock(block(assignment), scenario, subject(source), definitions);
}

function evaluateCategoryField(
  categories: readonly DecisionCategorySource[],
  name: DecisionFieldName,
  scenario: ConditionScenario,
  definitions: ClausewitzEvaluationDefinitions,
  decisionId: string,
): TriggerEvaluation {
  const definitionsWithField = categories.filter(({ fields }) => fields[name].length > 0);
  if (definitionsWithField.length > 1)
    return unresolved(
      `Multiple active category fragments define ${name}; merge semantics are unresolved`,
      decisionId,
    );
  const source = definitionsWithField[0];
  return source === undefined
    ? { state: 'true', unresolved: [] }
    : evaluateDecisionField(source, name, scenario, definitions);
}

function explicitTargets(source: DecisionSource, scenario: ConditionScenario): TriggerEvaluation {
  const targets = source.fields.targets;
  const arrays = source.fields.target_array;
  const stateFilters = source.fields.state_trigger;
  const activeStateFilters = stateFilters.filter((assignment) => scalar(assignment) !== 'no');
  const targeted =
    targets.length +
    arrays.length +
    activeStateFilters.length +
    source.fields.target_root_trigger.length +
    source.fields.target_trigger.length;
  if (targeted === 0) return { state: 'true', unresolved: [] };
  const target = scenario.scopes?.FROM;
  if (target === undefined)
    return unresolved('Targeted decision requires an explicit FROM scope binding', source.id);
  const targetId = target.actor ?? target.id;
  if (targets.length + arrays.length + stateFilters.length === 0)
    return { state: 'true', unresolved: [] };
  const candidateChecks: TriState[] = [];
  const stateChecks: TriState[] = [];
  const findings: ConditionUnresolved[] = [];
  for (const assignment of targets) {
    if (assignment.value.type !== 'block') {
      findings.push({
        code: 'DECISION_UNRESOLVED',
        message: 'targets must be a block',
        candidateId: source.id,
      });
      candidateChecks.push('unresolved');
      continue;
    }
    const listed = assignment.value.entries
      .filter((entry) => entry.type === 'scalar')
      .map((entry) => entry.value);
    const state = scalar(assignments(assignment.value, 'state')[0]);
    if (state !== undefined) listed.push(state);
    candidateChecks.push(listed.includes(targetId) ? 'true' : 'false');
  }
  for (const assignment of arrays) {
    const name = scalar(assignment);
    const value = name === undefined ? undefined : scenario.state[`array.${name}`];
    if (!Array.isArray(value)) {
      findings.push({
        code: 'DECISION_UNRESOLVED',
        message: `Scenario does not declare target array ${name ?? '<unknown>'}`,
        candidateId: source.id,
      });
      candidateChecks.push('unresolved');
    } else candidateChecks.push(value.includes(targetId) ? 'true' : 'false');
  }
  for (const assignment of activeStateFilters) {
    const filter = scalar(assignment);
    if (target.type === undefined || target.type === 'unknown') {
      findings.push({
        code: 'DECISION_UNRESOLVED',
        message: 'Scenario does not declare the target scope type',
        candidateId: source.id,
      });
      stateChecks.push('unresolved');
      continue;
    }
    if (target.type !== 'state') {
      stateChecks.push('false');
      continue;
    }
    if (filter === 'yes' || filter === 'any') {
      stateChecks.push('true');
      continue;
    }
    if (filter === 'any_owned_state' || filter === 'any_controlled_state') {
      const key = filter === 'any_owned_state' ? 'owner' : 'controller';
      const declared = target.state[key];
      if (typeof declared !== 'string' || scenario.actor === undefined) {
        findings.push({
          code: 'DECISION_UNRESOLVED',
          message: `State target needs declared ${key} and actor for ${filter}`,
          candidateId: source.id,
        });
        stateChecks.push('unresolved');
      } else stateChecks.push(declared === scenario.actor ? 'true' : 'false');
      continue;
    }
    if (filter !== undefined && /^[a-z][a-z0-9_]*$/u.test(filter)) {
      const continent = target.state.continent;
      if (typeof continent !== 'string') {
        findings.push({
          code: 'DECISION_UNRESOLVED',
          message: `State target needs a declared continent for ${filter}`,
          candidateId: source.id,
        });
        stateChecks.push('unresolved');
      } else stateChecks.push(continent === filter ? 'true' : 'false');
      continue;
    }
    findings.push({
      code: 'DECISION_UNRESOLVED',
      message: `State target filter ${filter ?? '<dynamic>'} is unsupported`,
      candidateId: source.id,
    });
    stateChecks.push('unresolved');
  }
  return {
    state: combine([
      ...(candidateChecks.length === 0 ? [] : [combineAny(candidateChecks)]),
      ...stateChecks,
    ]),
    unresolved: findings,
  };
}

/** Evaluates only declared source and scenario facts; it does not execute a decision. */
export function evaluateDecisionGates(
  snapshot: ScanSnapshot,
  id: string,
  scenario: ConditionScenario,
): DecisionGateEvaluation {
  const inventory = decisionSourceInventory(snapshot);
  const source = inventory.decisions.find((candidate) => candidate.id === id);
  if (source === undefined) throw new Error(`Decision ${id} has no active source definition`);
  const definitions = ClausewitzEvaluationDefinitions.build(snapshot);
  const guardedScenario: ConditionScenario = {
    ...scenario,
    closedFlags: scenario.closedFlags ?? false,
  };
  const actorOnlyScenario: ConditionScenario = {
    ...guardedScenario,
    scopes: Object.fromEntries(
      Object.entries(guardedScenario.scopes ?? {}).filter(([scope]) => scope !== 'FROM'),
    ),
  };
  const categories = inventory.categories.filter(
    ({ id: category }) => category === source.category,
  );
  const categoryAllowed = evaluateCategoryField(
    categories,
    'allowed',
    actorOnlyScenario,
    definitions,
    id,
  );
  const categoryVisible = evaluateCategoryField(
    categories,
    'visible',
    guardedScenario,
    definitions,
    id,
  );
  const categoryAvailable = evaluateCategoryField(
    categories,
    'available',
    guardedScenario,
    definitions,
    id,
  );
  const decisionAllowed = evaluateDecisionField(source, 'allowed', actorOnlyScenario, definitions);
  const decisionAvailable = evaluateDecisionField(
    source,
    'available',
    guardedScenario,
    definitions,
  );
  const decisionVisible =
    source.kind === 'mission'
      ? null
      : evaluateDecisionField(source, 'visible', guardedScenario, definitions);
  const targetRoot = evaluateDecisionField(
    source,
    'target_root_trigger',
    actorOnlyScenario,
    definitions,
  );
  const targetSelection = explicitTargets(source, guardedScenario);
  const targetTrigger = evaluateDecisionField(
    source,
    'target_trigger',
    guardedScenario,
    definitions,
  );
  const activation =
    source.kind === 'mission'
      ? evaluateDecisionField(source, 'activation', guardedScenario, definitions)
      : null;
  const eligible = combine([
    categoryAllowed.state,
    decisionAllowed.state,
    targetRoot.state,
    targetSelection.state,
    targetTrigger.state,
    ...(activation === null ? [] : [activation.state]),
  ]);
  const visible =
    decisionVisible === null
      ? null
      : combine([eligible, categoryVisible.state, decisionVisible.state]);
  const available = combine([eligible, categoryAvailable.state, decisionAvailable.state]);
  const gates = [
    categoryAllowed,
    decisionAllowed,
    categoryAvailable,
    decisionAvailable,
    targetRoot,
    targetSelection,
    targetTrigger,
    ...(decisionVisible === null ? [] : [decisionVisible]),
    ...(decisionVisible === null ? [] : [categoryVisible]),
    ...(activation === null ? [] : [activation]),
  ];
  return {
    sourceRevision: snapshot.revision,
    id,
    category: source.category,
    kind: source.kind,
    actor: scenario.actor ?? null,
    target:
      scenario.scopes?.FROM === undefined
        ? null
        : (scenario.scopes.FROM.actor ?? scenario.scopes.FROM.id),
    categoryAllowed,
    decisionAllowed,
    categoryVisible,
    decisionVisible,
    categoryAvailable,
    decisionAvailable,
    targetRoot,
    targetSelection,
    targetTrigger,
    activation,
    eligible,
    visible,
    available,
    complete: inventory.complete && gates.every(({ state }) => state !== 'unresolved'),
    unresolved: gates.flatMap(({ unresolved: findings }) => findings),
  };
}
