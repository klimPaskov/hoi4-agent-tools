import type { ClausewitzEvaluationDefinitions } from './clausewitz-evaluation.js';
import {
  assignments,
  astPathFor,
  firstScalar,
  nodeLocation,
  type AssignmentNode,
  type BlockNode,
  type SourceEntry,
} from './source/index.js';
import type {
  ConditionScenario,
  ConditionProvenance,
  ConditionUnresolved,
  TriState,
  ConditionTraceStep,
  ConditionSubject,
} from './condition-model.js';
import {
  resolveScopeContext,
  rootScopeContext,
  rootStateValue,
  scopeIdentity,
  scopeStateValue,
  type ConditionScopeContext,
} from './scenario-state.js';

export interface TriggerEvaluation {
  state: TriState;
  unresolved: ConditionUnresolved[];
  helperProvenance?: ConditionProvenance[];
  trace?: ConditionTraceStep[];
}

function helperWithArguments(block: BlockNode, invocation: BlockNode): BlockNode | undefined {
  const parameters = new Map<string, string>();
  for (const entry of invocation.entries) {
    if (entry.type !== 'assignment' || entry.value.type !== 'scalar') return undefined;
    parameters.set(entry.key.value, entry.value.value);
  }
  const missing = new Set<string>();
  const substitute = (value: string): string =>
    value.replace(/\$([A-Za-z0-9_]+)\$/gu, (match: string, key: string) => {
      const replacement = parameters.get(key);
      if (replacement === undefined) {
        missing.add(key);
        return match;
      }
      return replacement;
    });
  const visit = (entry: SourceEntry): SourceEntry => {
    if (entry.type === 'scalar') return { ...entry, value: substitute(entry.value) };
    if (entry.type === 'block') return { ...entry, entries: entry.entries.map(visit) };
    return {
      ...entry,
      key: { ...entry.key, value: substitute(entry.key.value) },
      value:
        entry.value.type === 'scalar'
          ? { ...entry.value, value: substitute(entry.value.value) }
          : { ...entry.value, entries: entry.value.entries.map(visit) },
    };
  };
  const expanded = { ...block, entries: block.entries.map(visit) };
  return missing.size === 0 ? expanded : undefined;
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

function numberValue(
  expression: string,
  scenario: ConditionScenario,
  context: ConditionScopeContext,
  definitions: ClausewitzEvaluationDefinitions,
  path?: string,
  seen = new Set<string>(),
): number | undefined {
  const literal = numeric(expression);
  if (literal !== undefined) return literal;
  const identity = `${path ?? ''}:${expression}`;
  if (seen.has(identity)) return undefined;
  seen.add(identity);
  const constant = expression.startsWith('constant:')
    ? definitions.scriptConstants.get(expression.slice(9))
    : expression.startsWith('@') && path !== undefined
      ? definitions.localConstants.get(path)?.get(expression)
      : undefined;
  if (constant !== undefined)
    return numberValue(
      constant.value,
      scenario,
      context,
      definitions,
      constant.file.displayPath,
      seen,
    );
  const direct =
    scopeStateValue(scenario, expression, context) ??
    scopeStateValue(scenario, `variable.${expression}`, context);
  if (direct !== undefined) return numeric(direct);
  for (
    let split = expression.lastIndexOf('.');
    split > 0;
    split = expression.lastIndexOf('.', split - 1)
  ) {
    const scope = resolveScopeContext(scenario, expression.slice(0, split), context);
    if (scope !== undefined)
      return numberValue(expression.slice(split + 1), scenario, scope, definitions, path, seen);
  }
  return undefined;
}

function unresolved(
  assignment: AssignmentNode,
  candidate: ConditionSubject,
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

function malformedBlock(
  block: BlockNode,
  candidate: ConditionSubject,
): TriggerEvaluation | undefined {
  if (block.entries.every(({ type }) => type === 'assignment')) return undefined;
  return {
    state: 'unresolved',
    unresolved: [
      {
        code: 'TRIGGER_UNRESOLVED',
        message: 'Condition contains a bare value or block instead of a trigger assignment',
        candidateId: candidate.id,
        ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
      },
    ],
  };
}

function evaluateCheckVariable(
  block: BlockNode,
  scenario: ConditionScenario,
  candidate: ConditionSubject,
  assignment: AssignmentNode,
  scopeContext: ConditionScopeContext,
  definitions: ClausewitzEvaluationDefinitions,
): TriggerEvaluation {
  const short = assignments(block).find(
    ({ key }) => !['var', 'value', 'compare', 'tooltip'].includes(key.value),
  );
  const variable = firstScalar(block, 'var')?.value ?? short?.key.value;
  const target =
    firstScalar(block, 'value')?.value ??
    (short?.value.type === 'scalar' ? short.value.value : undefined);
  if (variable === undefined || target === undefined)
    return unresolved(assignment, candidate, 'check_variable requires declared var and value');
  const path = candidate.provenance[0]?.path;
  const leftNumber = numberValue(variable, scenario, scopeContext, definitions, path);
  const rightNumber = numberValue(target, scenario, scopeContext, definitions, path);
  if (leftNumber === undefined || rightNumber === undefined)
    return unresolved(
      assignment,
      candidate,
      `Scenario does not resolve numeric operands ${variable} and ${target}`,
    );
  const compareName =
    firstScalar(block, 'compare')?.value ??
    (short?.operator.text === '>'
      ? 'greater_than'
      : short?.operator.text === '<'
        ? 'less_than'
        : 'equals');
  if (
    ![
      'greater_than',
      'greater_than_or_equals',
      'less_than',
      'less_than_or_equals',
      'not_equals',
      'equals',
    ].includes(compareName)
  )
    return unresolved(
      assignment,
      candidate,
      `Unsupported check_variable comparison ${compareName}`,
    );
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
  scenario: ConditionScenario,
  candidate: ConditionSubject,
  definitions: ClausewitzEvaluationDefinitions,
  helperStack: string[],
  scopeContext: ConditionScopeContext,
): TriggerEvaluation {
  const key = assignment.key.value;
  if (assignment.value.type === 'block') {
    const malformed = malformedBlock(assignment.value, candidate);
    if (malformed !== undefined) return malformed;
    if (key === 'AND')
      return evaluateTriggerBlock(
        assignment.value,
        scenario,
        candidate,
        definitions,
        helperStack,
        scopeContext,
      );
    if (key === 'OR') {
      const children = assignments(assignment.value).map((child) =>
        evaluateAssignment(child, scenario, candidate, definitions, helperStack, scopeContext),
      );
      return {
        state: combineOr(children.map(({ state }) => state)),
        unresolved: children.flatMap(({ unresolved: items }) => items),
        helperProvenance: children.flatMap(({ helperProvenance }) => helperProvenance ?? []),
      };
    }
    if (key === 'NOT' || key === 'NOR' || key === 'NAND') {
      const children = assignments(assignment.value).map((child) =>
        evaluateAssignment(child, scenario, candidate, definitions, helperStack, scopeContext),
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
      return evaluateCheckVariable(
        assignment.value,
        scenario,
        candidate,
        assignment,
        scopeContext,
        definitions,
      );
    if (key === 'is_in_array' || key === 'is_variable_in_array') {
      const arrayId = firstScalar(assignment.value, 'array')?.value;
      const declaredValue = firstScalar(assignment.value, 'value')?.value;
      if (arrayId === undefined || declaredValue === undefined)
        return unresolved(assignment, candidate, `${key} requires array and value`);
      const array =
        scopeStateValue(scenario, `array.${arrayId}`, scopeContext) ??
        rootStateValue(scenario, `array.${arrayId}`);
      if (!Array.isArray(array))
        return unresolved(assignment, candidate, `Scenario does not declare array ${arrayId}`);
      const compared =
        ['THIS', 'ROOT', 'PREV'].includes(declaredValue.toUpperCase()) ||
        resolveScopeContext(scenario, declaredValue, scopeContext) !== undefined
          ? scopeIdentity(
              resolveScopeContext(scenario, declaredValue, scopeContext) ?? scopeContext,
            )
          : (scopeStateValue(scenario, declaredValue, scopeContext) ?? declaredValue);
      return { state: array.includes(compared) ? 'true' : 'false', unresolved: [] };
    }
    const resolvedScope = resolveScopeContext(scenario, key, scopeContext);
    if (resolvedScope !== undefined)
      return evaluateTriggerBlock(
        assignment.value,
        scenario,
        candidate,
        definitions,
        helperStack,
        resolvedScope,
      );
    const helper = definitions.scriptedTriggers.get(key);
    if (helper !== undefined) {
      if (helperStack.includes(key))
        return unresolved(assignment, candidate, `Scripted trigger recursion detected at ${key}`);
      const expanded = helperWithArguments(helper.value, assignment.value);
      if (expanded === undefined)
        return unresolved(
          assignment,
          candidate,
          `Scripted trigger ${key} requires declared scalar arguments for every parameter`,
        );
      const helperProvenance: ConditionProvenance = {
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
        expanded,
        scenario,
        {
          ...candidate,
          document: helper.document,
          provenance: [helperProvenance, ...candidate.provenance],
        },
        definitions,
        [...helperStack, key],
        scopeContext,
      );
      return {
        ...evaluated,
        helperProvenance: [helperProvenance, ...(evaluated.helperProvenance ?? [])],
      };
    }
    const declaredScope = bool(rootStateValue(scenario, `scope.${key}`));
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
    const explicit = bool(scopeStateValue(scenario, `flag.${right}`, scopeContext));
    if (explicit !== undefined) return { state: explicit ? 'true' : 'false', unresolved: [] };
    const flags = scopeContext.expression === 'ROOT' ? scenario.flags : scopeContext.binding.flags;
    if (scenario.closedFlags === false && flags?.includes(right) !== true)
      return unresolved(assignment, candidate, `Scenario does not declare flag ${right}`);
    return { state: flags?.includes(right) === true ? 'true' : 'false', unresolved: [] };
  }
  if (key === 'has_event_target') {
    const eventTargets = scopeContext.binding.eventTargets ?? scenario.eventTargets;
    return {
      state: Object.hasOwn(eventTargets ?? {}, right) ? 'true' : 'false',
      unresolved: [],
    };
  }
  if (key === 'tag' || key === 'original_tag') {
    const actor =
      scopeContext.expression === 'ROOT'
        ? scenario.actor
        : (scopeContext.binding.actor ?? scopeContext.binding.id);
    if (actor === undefined)
      return unresolved(assignment, candidate, `Scenario does not declare actor for ${key}`);
    return {
      state: compare(actor, right, assignment.operator.text) ? 'true' : 'false',
      unresolved: [],
    };
  }
  if (key === 'date') {
    if (scenario.date === undefined)
      return unresolved(assignment, candidate, 'Scenario does not declare date');
    const dateNumber = (value: string): number | undefined => {
      const parts = /^(\d+)\.(\d{1,2})\.(\d{1,2})$/u.exec(value);
      if (parts === null) return undefined;
      const month = Number(parts[2]);
      const day = Number(parts[3]);
      return month < 1 || month > 12 || day < 1 || day > 31
        ? undefined
        : Number(parts[1]) * 10_000 + month * 100 + day;
    };
    const leftDate = dateNumber(scenario.date);
    const rightDate = dateNumber(right);
    if (leftDate === undefined || rightDate === undefined)
      return unresolved(assignment, candidate, 'Date comparison is not numeric');
    return {
      state: compare(leftDate, rightDate, assignment.operator.text) ? 'true' : 'false',
      unresolved: [],
    };
  }
  const helper = definitions.scriptedTriggers.get(key);
  if (helper !== undefined && bool(right) !== undefined) {
    if (helperStack.includes(key))
      return unresolved(assignment, candidate, `Scripted trigger recursion detected at ${key}`);
    const helperProvenance: ConditionProvenance = {
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
      scopeContext,
    );
    return {
      ...evaluated,
      state: bool(right) === false ? invert(evaluated.state) : evaluated.state,
      helperProvenance: [helperProvenance, ...(evaluated.helperProvenance ?? [])],
    };
  }
  const declared =
    scopeStateValue(scenario, key, scopeContext) ??
    numberValue(key, scenario, scopeContext, definitions, candidate.provenance[0]?.path);
  if (declared === undefined)
    return unresolved(assignment, candidate, `Scenario does not declare trigger ${key}`);
  const expectedBoolean = bool(right);
  const actualBoolean = bool(declared);
  if (expectedBoolean !== undefined && actualBoolean !== undefined)
    return { state: expectedBoolean === actualBoolean ? 'true' : 'false', unresolved: [] };
  const leftNumber = numeric(declared);
  const rightNumber = numberValue(
    right,
    scenario,
    scopeContext,
    definitions,
    candidate.provenance[0]?.path,
  );
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
  scenario: ConditionScenario,
  candidate: ConditionSubject,
  definitions: ClausewitzEvaluationDefinitions,
  helperStack: string[],
  scopeContext: ConditionScopeContext,
): TriggerEvaluation {
  const evaluated = evaluateAssignmentCore(
    assignment,
    scenario,
    candidate,
    definitions,
    helperStack,
    scopeContext,
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
  scenario: ConditionScenario,
  candidate: ConditionSubject,
  definitions: ClausewitzEvaluationDefinitions,
  helperStack: string[] = [],
  scopeContext: ConditionScopeContext = rootScopeContext(scenario),
): TriggerEvaluation {
  const override = scenario.candidateOverrides?.[candidate.id];
  if (override !== undefined) return { state: override ? 'true' : 'false', unresolved: [] };
  if (block === undefined) return { state: 'true', unresolved: [] };
  const malformed = malformedBlock(block, candidate);
  if (malformed !== undefined) return malformed;
  const children = assignments(block).map((assignment) =>
    evaluateAssignment(assignment, scenario, candidate, definitions, helperStack, scopeContext),
  );
  return {
    state: combineAnd(children.map(({ state }) => state)),
    unresolved: children.flatMap(({ unresolved: items }) => items),
    helperProvenance: children.flatMap(({ helperProvenance }) => helperProvenance ?? []),
    trace: children.flatMap(({ trace }) => trace ?? []),
  };
}
