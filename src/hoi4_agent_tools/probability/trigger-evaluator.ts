import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import {
  assignments,
  astPathFor,
  firstScalar,
  nodeLocation,
  type AssignmentNode,
  type BlockNode,
} from '../core/source/index.js';
import type {
  ProbabilityScenario,
  ProbabilitySourceProvenance,
  ProbabilityUnresolved,
  TriState,
  ValueTraceStep,
  WeightedCandidate,
} from './model.js';

export interface TriggerEvaluation {
  state: TriState;
  unresolved: ProbabilityUnresolved[];
  helperProvenance?: ProbabilitySourceProvenance[];
  trace?: ValueTraceStep[];
}

function combineAnd(values: readonly TriState[]): TriState {
  if (values.includes('false')) return 'false';
  return values.includes('unresolved') ? 'unresolved' : 'true';
}

function combineOr(values: readonly TriState[]): TriState {
  if (values.includes('true')) return 'true';
  return values.includes('unresolved') ? 'unresolved' : 'false';
}

function invert(value: TriState): TriState {
  return value === 'true' ? 'false' : value === 'false' ? 'true' : 'unresolved';
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function compare(left: number | string, right: number | string, operator: string): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === '>') return left > right;
    if (operator === '<') return left < right;
  }
  return operator === '!=' ? left !== right : left === right;
}

function unresolved(
  assignment: AssignmentNode,
  candidate: WeightedCandidate,
  reason: string,
): TriggerEvaluation {
  return {
    state: 'unresolved',
    unresolved: [
      {
        code: 'TRIGGER_UNRESOLVED',
        message: reason,
        path: assignment.key.value,
        candidateId: candidate.id,
        ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
      },
    ],
  };
}

function stateValue(scenario: ProbabilityScenario, key: string): unknown {
  if (Object.hasOwn(scenario.state, key)) return scenario.state[key];
  if (Object.hasOwn(scenario.state, `trigger.${key}`)) return scenario.state[`trigger.${key}`];
  return undefined;
}

function evaluateCheckVariable(
  block: BlockNode,
  scenario: ProbabilityScenario,
  candidate: WeightedCandidate,
  assignment: AssignmentNode,
): TriggerEvaluation {
  const variable = firstScalar(block, 'var')?.value;
  const target = firstScalar(block, 'value')?.value;
  if (variable === undefined || target === undefined)
    return unresolved(assignment, candidate, 'check_variable requires declared var and value');
  const left = stateValue(scenario, `variable.${variable}`) ?? stateValue(scenario, variable);
  const leftNumber = numeric(left);
  const rightNumber = numeric(target);
  if (leftNumber === undefined || rightNumber === undefined)
    return unresolved(
      assignment,
      candidate,
      `Scenario does not declare numeric variable ${variable}`,
    );
  const compareName = firstScalar(block, 'compare')?.value ?? 'equals';
  const result =
    compareName === 'greater_than'
      ? leftNumber > rightNumber
      : compareName === 'greater_than_or_equals'
        ? leftNumber >= rightNumber
        : compareName === 'less_than'
          ? leftNumber < rightNumber
          : compareName === 'less_than_or_equals'
            ? leftNumber <= rightNumber
            : compareName === 'not_equals'
              ? leftNumber !== rightNumber
              : leftNumber === rightNumber;
  return { state: result ? 'true' : 'false', unresolved: [] };
}

function evaluateAssignmentCore(
  assignment: AssignmentNode,
  scenario: ProbabilityScenario,
  candidate: WeightedCandidate,
  definitions: ClausewitzEvaluationDefinitions,
  helperStack: string[],
): TriggerEvaluation {
  const key = assignment.key.value;
  if (assignment.value.type === 'block') {
    if (key === 'AND')
      return evaluateTriggerBlock(assignment.value, scenario, candidate, definitions, helperStack);
    if (key === 'OR') {
      const children = assignments(assignment.value).map((child) =>
        evaluateAssignment(child, scenario, candidate, definitions, helperStack),
      );
      return {
        state: combineOr(children.map(({ state }) => state)),
        unresolved: children.flatMap(({ unresolved: items }) => items),
        helperProvenance: children.flatMap(({ helperProvenance }) => helperProvenance ?? []),
      };
    }
    if (key === 'NOT' || key === 'NOR' || key === 'NAND') {
      const children = assignments(assignment.value).map((child) =>
        evaluateAssignment(child, scenario, candidate, definitions, helperStack),
      );
      const base =
        key === 'NAND'
          ? combineAnd(children.map(({ state }) => state))
          : combineOr(children.map(({ state }) => state));
      return {
        state: invert(base),
        unresolved: children.flatMap(({ unresolved: items }) => items),
        helperProvenance: children.flatMap(({ helperProvenance }) => helperProvenance ?? []),
      };
    }
    if (key === 'check_variable')
      return evaluateCheckVariable(assignment.value, scenario, candidate, assignment);
    if (key === 'is_in_array' || key === 'is_variable_in_array') {
      const arrayId = firstScalar(assignment.value, 'array')?.value;
      const declaredValue = firstScalar(assignment.value, 'value')?.value;
      if (arrayId === undefined || declaredValue === undefined)
        return unresolved(assignment, candidate, `${key} requires array and value`);
      const array = stateValue(scenario, `array.${arrayId}`);
      if (!Array.isArray(array))
        return unresolved(assignment, candidate, `Scenario does not declare array ${arrayId}`);
      const compared = stateValue(scenario, declaredValue) ?? declaredValue;
      return { state: array.includes(compared) ? 'true' : 'false', unresolved: [] };
    }
    const helper = definitions.scriptedTriggers.get(key);
    if (helper !== undefined) {
      if (helperStack.includes(key))
        return unresolved(assignment, candidate, `Scripted trigger recursion detected at ${key}`);
      if (assignments(assignment.value).length > 0)
        return unresolved(
          assignment,
          candidate,
          `Parameterized scripted trigger ${key} is not expanded without declared arguments`,
        );
      const helperProvenance: ProbabilitySourceProvenance = {
        path: helper.file.displayPath,
        rootKind: helper.file.rootKind,
        loadOrder: helper.file.loadOrder,
        sourceHash: helper.file.sha256,
        location: nodeLocation(helper.document, helper.node, key),
        ...(astPathFor(helper.document, helper.node) === undefined
          ? {}
          : { astPath: astPathFor(helper.document, helper.node)! }),
        symbol: key,
        helperChain: [...helperStack, key],
      };
      const evaluated = evaluateTriggerBlock(
        helper.value,
        scenario,
        {
          ...candidate,
          document: helper.document,
          provenance: [helperProvenance, ...candidate.provenance],
        },
        definitions,
        [...helperStack, key],
      );
      return {
        ...evaluated,
        helperProvenance: [helperProvenance, ...(evaluated.helperProvenance ?? [])],
      };
    }
    const declaredScope = bool(stateValue(scenario, `scope.${key}`));
    if (declaredScope !== undefined)
      return { state: declaredScope ? 'true' : 'false', unresolved: [] };
    return unresolved(
      assignment,
      candidate,
      `Scoped or compound trigger ${key} is not declared by the scenario`,
    );
  }

  const right = assignment.value.value;
  if (key === 'always') {
    const value = bool(right);
    return value === undefined
      ? unresolved(assignment, candidate, 'always trigger is not boolean')
      : { state: value ? 'true' : 'false', unresolved: [] };
  }
  if (key === 'has_country_flag' || key === 'has_global_flag' || key === 'has_state_flag') {
    return { state: scenario.flags?.includes(right) === true ? 'true' : 'false', unresolved: [] };
  }
  if (key === 'has_event_target') {
    return {
      state: Object.hasOwn(scenario.eventTargets ?? {}, right) ? 'true' : 'false',
      unresolved: [],
    };
  }
  if (key === 'tag' || key === 'original_tag') {
    if (scenario.actor === undefined)
      return unresolved(assignment, candidate, `Scenario does not declare actor for ${key}`);
    return {
      state: compare(scenario.actor, right, assignment.operator.text) ? 'true' : 'false',
      unresolved: [],
    };
  }
  if (key === 'date') {
    if (scenario.date === undefined)
      return unresolved(assignment, candidate, 'Scenario does not declare date');
    const leftDate = Number(scenario.date.replaceAll('.', ''));
    const rightDate = Number(right.replaceAll('.', ''));
    if (!Number.isFinite(leftDate) || !Number.isFinite(rightDate))
      return unresolved(assignment, candidate, 'Date comparison is not numeric');
    return {
      state: compare(leftDate, rightDate, assignment.operator.text) ? 'true' : 'false',
      unresolved: [],
    };
  }
  const helper = definitions.scriptedTriggers.get(key);
  if (helper !== undefined && bool(right) === true) {
    if (helperStack.includes(key))
      return unresolved(assignment, candidate, `Scripted trigger recursion detected at ${key}`);
    const helperProvenance: ProbabilitySourceProvenance = {
      path: helper.file.displayPath,
      rootKind: helper.file.rootKind,
      loadOrder: helper.file.loadOrder,
      sourceHash: helper.file.sha256,
      location: nodeLocation(helper.document, helper.node, key),
      ...(astPathFor(helper.document, helper.node) === undefined
        ? {}
        : { astPath: astPathFor(helper.document, helper.node)! }),
      symbol: key,
      helperChain: [...helperStack, key],
    };
    const evaluated = evaluateTriggerBlock(
      helper.value,
      scenario,
      {
        ...candidate,
        document: helper.document,
        provenance: [helperProvenance, ...candidate.provenance],
      },
      definitions,
      [...helperStack, key],
    );
    return {
      ...evaluated,
      helperProvenance: [helperProvenance, ...(evaluated.helperProvenance ?? [])],
    };
  }
  const declared = stateValue(scenario, key);
  if (declared === undefined)
    return unresolved(assignment, candidate, `Scenario does not declare trigger ${key}`);
  const expectedBoolean = bool(right);
  const actualBoolean = bool(declared);
  if (expectedBoolean !== undefined && actualBoolean !== undefined)
    return { state: expectedBoolean === actualBoolean ? 'true' : 'false', unresolved: [] };
  const leftNumber = numeric(declared);
  const rightNumber = numeric(right);
  if (leftNumber !== undefined && rightNumber !== undefined)
    return {
      state: compare(leftNumber, rightNumber, assignment.operator.text) ? 'true' : 'false',
      unresolved: [],
    };
  if (typeof declared === 'string')
    return {
      state: compare(declared, right, assignment.operator.text) ? 'true' : 'false',
      unresolved: [],
    };
  return unresolved(
    assignment,
    candidate,
    `Trigger ${key} cannot compare the declared scenario value`,
  );
}

function evaluateAssignment(
  assignment: AssignmentNode,
  scenario: ProbabilityScenario,
  candidate: WeightedCandidate,
  definitions: ClausewitzEvaluationDefinitions,
  helperStack: string[],
): TriggerEvaluation {
  const evaluated = evaluateAssignmentCore(
    assignment,
    scenario,
    candidate,
    definitions,
    helperStack,
  );
  const source = candidate.provenance[0];
  const provenance =
    candidate.document === undefined || source === undefined
      ? source
      : {
          ...source,
          location: nodeLocation(candidate.document, assignment, assignment.key.value),
          ...(astPathFor(candidate.document, assignment) === undefined
            ? {}
            : { astPath: astPathFor(candidate.document, assignment)! }),
          symbol: assignment.key.value,
        };
  const expression =
    assignment.value.type === 'scalar'
      ? `${assignment.key.value} ${assignment.operator.text} ${assignment.value.value}`
      : assignment.key.value;
  return {
    ...evaluated,
    trace: [
      {
        operation: 'eligibility',
        expression,
        applied: evaluated.state,
        ...(provenance === undefined ? {} : { provenance }),
      },
      ...(evaluated.trace ?? []),
    ],
  };
}

export function evaluateTriggerBlock(
  block: BlockNode | undefined,
  scenario: ProbabilityScenario,
  candidate: WeightedCandidate,
  definitions: ClausewitzEvaluationDefinitions,
  helperStack: string[] = [],
): TriggerEvaluation {
  const override = scenario.candidateOverrides?.[candidate.id];
  if (override !== undefined) return { state: override ? 'true' : 'false', unresolved: [] };
  if (block === undefined) return { state: 'true', unresolved: [] };
  const children = assignments(block).map((assignment) =>
    evaluateAssignment(assignment, scenario, candidate, definitions, helperStack),
  );
  return {
    state: combineAnd(children.map(({ state }) => state)),
    unresolved: children.flatMap(({ unresolved: items }) => items),
    helperProvenance: children.flatMap(({ helperProvenance }) => helperProvenance ?? []),
    trace: children.flatMap(({ trace }) => trace ?? []),
  };
}
