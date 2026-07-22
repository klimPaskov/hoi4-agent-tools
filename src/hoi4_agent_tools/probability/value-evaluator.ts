import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import {
  assignments,
  astPathFor,
  nodeLocation,
  type AssignmentNode,
  type BlockNode,
} from '../core/source/index.js';
import type {
  ProbabilityScenario,
  ProbabilitySourceProvenance,
  ProbabilityUnresolved,
  ValueTraceStep,
  WeightedCandidate,
} from './model.js';
import { Rational } from './rational.js';
import { evaluateTriggerBlock } from './trigger-evaluator.js';

export interface RationalInterval {
  min: Rational;
  max: Rational;
}

export interface ValueEvaluation {
  value?: Rational;
  interval?: RationalInterval;
  trace: ValueTraceStep[];
  unresolved: ProbabilityUnresolved[];
  referencedProvenance?: ProbabilitySourceProvenance[];
}

function appendReference(
  evaluated: ValueEvaluation,
  reference: ProbabilitySourceProvenance,
): ValueEvaluation {
  return {
    ...evaluated,
    referencedProvenance: [reference, ...(evaluated.referencedProvenance ?? [])],
  };
}

function interval(value: Rational): RationalInterval {
  return { min: value, max: value };
}

function nodeProvenance(
  candidate: WeightedCandidate,
  node: AssignmentNode | BlockNode,
  symbol?: string,
): ProbabilitySourceProvenance | undefined {
  const source = candidate.provenance[0];
  if (source === undefined || candidate.document === undefined) return source;
  const astPath = astPathFor(candidate.document, node);
  return {
    ...source,
    location: nodeLocation(candidate.document, node, symbol),
    ...(astPath === undefined ? {} : { astPath }),
    ...(symbol === undefined ? {} : { symbol }),
  };
}

function conditionSignature(block: BlockNode): string {
  const encode = (value: BlockNode): unknown[] =>
    assignments(value).map((assignment) => [
      assignment.key.value,
      assignment.operator.text,
      assignment.value.type === 'scalar' ? assignment.value.value : encode(assignment.value),
    ]);
  const encoded = encode(block);
  return encoded.length === 0 ? 'always' : JSON.stringify(encoded);
}

function multiplyIntervals(left: RationalInterval, right: RationalInterval): RationalInterval {
  const products = [
    left.min.multiply(right.min),
    left.min.multiply(right.max),
    left.max.multiply(right.min),
    left.max.multiply(right.max),
  ].sort((a, b) => a.compare(b));
  return { min: products[0]!, max: products.at(-1)! };
}

function addIntervals(left: RationalInterval, right: RationalInterval): RationalInterval {
  return { min: left.min.add(right.min), max: left.max.add(right.max) };
}

function scenarioNumber(scenario: ProbabilityScenario, expression: string): unknown {
  if (Object.hasOwn(scenario.state, expression)) return scenario.state[expression];
  if (Object.hasOwn(scenario.state, `variable.${expression}`))
    return scenario.state[`variable.${expression}`];
  if (
    expression.startsWith('var:') &&
    Object.hasOwn(scenario.state, `variable.${expression.slice(4)}`)
  )
    return scenario.state[`variable.${expression.slice(4)}`];
  return undefined;
}

function expressionValue(
  expression: string,
  candidate: WeightedCandidate,
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
  mtthStack: string[],
): ValueEvaluation {
  const numeric = Rational.parse(expression);
  if (numeric !== undefined && Number.isFinite(numeric.toNumber()))
    return { value: numeric, interval: interval(numeric), trace: [], unresolved: [] };
  if (numeric !== undefined || /^(?:[+-]?(?:inf(?:inity)?|nan))$/iu.test(expression.trim()))
    return {
      trace: [],
      unresolved: [
        {
          code: 'VALUE_NON_FINITE',
          message: `Numeric expression ${expression} is outside finite analyzer range`,
          path: expression,
          candidateId: candidate.id,
          ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
        },
      ],
    };
  if (expression.startsWith('@')) {
    const definition = definitions.localConstants
      .get(candidate.provenance[0]?.path ?? '')
      ?.get(expression);
    if (definition !== undefined)
      return appendReference(
        expressionValue(definition.value, candidate, scenario, definitions, mtthStack),
        {
          path: definition.file.displayPath,
          rootKind: definition.file.rootKind,
          loadOrder: definition.file.loadOrder,
          sourceHash: definition.file.sha256,
          location: nodeLocation(definition.document, definition.node, expression),
          ...(astPathFor(definition.document, definition.node) === undefined
            ? {}
            : { astPath: astPathFor(definition.document, definition.node)! }),
          symbol: expression,
        },
      );
    const inline =
      candidate.document === undefined
        ? undefined
        : assignments(candidate.document.root, expression).find(
            ({ value }) => value.type === 'scalar',
          );
    if (inline?.value.type === 'scalar')
      return appendReference(
        expressionValue(inline.value.value, candidate, scenario, definitions, mtthStack),
        {
          path: candidate.provenance[0]?.path ?? 'proposed:inline-probability-source.txt',
          rootKind: candidate.provenance[0]?.rootKind ?? 'fixture',
          loadOrder: candidate.provenance[0]?.loadOrder ?? 0,
          sourceHash: candidate.provenance[0]?.sourceHash ?? '',
          location: nodeLocation(candidate.document!, inline, expression),
          ...(astPathFor(candidate.document!, inline) === undefined
            ? {}
            : { astPath: astPathFor(candidate.document!, inline)! }),
          symbol: expression,
        },
      );
  }
  if (expression.startsWith('constant:')) {
    const id = expression.slice('constant:'.length);
    const definition = definitions.scriptConstants.get(id);
    if (definition !== undefined)
      return appendReference(
        expressionValue(definition.value, candidate, scenario, definitions, mtthStack),
        {
          path: definition.file.displayPath,
          rootKind: definition.file.rootKind,
          loadOrder: definition.file.loadOrder,
          sourceHash: definition.file.sha256,
          location: nodeLocation(definition.document, definition.node, id),
          ...(astPathFor(definition.document, definition.node) === undefined
            ? {}
            : { astPath: astPathFor(definition.document, definition.node)! }),
          symbol: id,
        },
      );
  }
  if (expression.startsWith('mtth:')) {
    const id = expression.slice('mtth:'.length);
    const definition = definitions.mtthVariables.get(id);
    if (definition !== undefined && !mtthStack.includes(id)) {
      const definitionCandidate: WeightedCandidate = {
        ...candidate,
        document: definition.document,
        provenance: [
          {
            path: definition.file.displayPath,
            rootKind: definition.file.rootKind,
            loadOrder: definition.file.loadOrder,
            sourceHash: definition.file.sha256,
            location: nodeLocation(definition.document, definition.node, id),
            ...(astPathFor(definition.document, definition.node) === undefined
              ? {}
              : { astPath: astPathFor(definition.document, definition.node)! }),
            symbol: id,
            helperChain: [...mtthStack, id],
          },
          ...candidate.provenance,
        ],
      };
      return appendReference(
        evaluateValueBlock(
          definition.value,
          definitionCandidate,
          scenario,
          definitions,
          Rational.one,
          [...mtthStack, id],
        ),
        definitionCandidate.provenance[0]!,
      );
    }
    if (mtthStack.includes(id))
      return {
        trace: [],
        unresolved: [
          {
            code: 'MTTH_RECURSION',
            message: `MTTH variable recursion detected at ${id}`,
            candidateId: candidate.id,
            ...(candidate.provenance[0] === undefined
              ? {}
              : { provenance: candidate.provenance[0] }),
          },
        ],
      };
  }
  const declared = scenarioNumber(scenario, expression);
  if (typeof declared === 'number' || typeof declared === 'string') {
    const parsed = Rational.parse(declared);
    if (parsed !== undefined)
      return { value: parsed, interval: interval(parsed), trace: [], unresolved: [] };
  }
  return {
    trace: [],
    unresolved: [
      {
        code: 'VALUE_UNRESOLVED',
        message: `Scenario or source definitions do not resolve numeric expression ${expression}`,
        path: expression,
        candidateId: candidate.id,
        ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
      },
    ],
  };
}

function conditionBlock(block: BlockNode): BlockNode {
  const operationKeys = new Set(['base', 'add', 'factor', 'days', 'months', 'years']);
  return {
    ...block,
    entries: block.entries.filter(
      (entry) => entry.type !== 'assignment' || !operationKeys.has(entry.key.value),
    ),
  };
}

function applyOperation(
  current: RationalInterval,
  operation: 'base' | 'add' | 'factor',
  operand: RationalInterval,
): RationalInterval {
  if (operation === 'base') return operand;
  return operation === 'add' ? addIntervals(current, operand) : multiplyIntervals(current, operand);
}

export function evaluateValueBlock(
  block: BlockNode | undefined,
  candidate: WeightedCandidate,
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
  initial: Rational,
  mtthStack: string[] = [],
): ValueEvaluation {
  let current = interval(initial);
  const trace: ValueTraceStep[] = [];
  const unresolved: ProbabilityUnresolved[] = [];
  const referencedProvenance: ProbabilitySourceProvenance[] = [];
  if (block === undefined) return { value: initial, interval: current, trace, unresolved };
  for (const assignment of assignments(block)) {
    if (assignment.value.type === 'scalar') {
      let operation: 'base' | 'add' | 'factor' | undefined;
      let unit = Rational.one;
      if (assignment.key.value === 'base') operation = 'base';
      else if (assignment.key.value === 'add') operation = 'add';
      else if (assignment.key.value === 'factor') operation = 'factor';
      else if (assignment.key.value === 'days') operation = 'add';
      else if (assignment.key.value === 'months') {
        operation = 'add';
        unit = new Rational(30n);
      } else if (assignment.key.value === 'years') {
        operation = 'add';
        unit = new Rational(365n);
      }
      if (operation === undefined) continue;
      const operand = expressionValue(
        assignment.value.value,
        candidate,
        scenario,
        definitions,
        mtthStack,
      );
      unresolved.push(...operand.unresolved);
      referencedProvenance.push(...(operand.referencedProvenance ?? []));
      if (operand.interval === undefined) continue;
      const scaled = multiplyIntervals(operand.interval, interval(unit));
      const before = current;
      current = applyOperation(current, operation, scaled);
      if (!Number.isFinite(current.min.toNumber()) || !Number.isFinite(current.max.toNumber())) {
        unresolved.push({
          code: 'VALUE_NON_FINITE',
          message: `${candidate.id} modifier chain exceeds finite analyzer range`,
          candidateId: candidate.id,
          ...(nodeProvenance(candidate, assignment, assignment.key.value) === undefined
            ? {}
            : { provenance: nodeProvenance(candidate, assignment, assignment.key.value)! }),
        });
        return { trace, unresolved, referencedProvenance };
      }
      trace.push({
        operation,
        expression: assignment.value.value,
        applied: 'true',
        ...(scaled.min.compare(scaled.max) === 0 ? { value: scaled.min.toJSON() } : {}),
        ...(before.min.compare(before.max) === 0 ? { before: before.min.toJSON() } : {}),
        ...(current.min.compare(current.max) === 0 ? { after: current.min.toJSON() } : {}),
        ...(nodeProvenance(candidate, assignment, assignment.key.value) === undefined
          ? {}
          : { provenance: nodeProvenance(candidate, assignment, assignment.key.value)! }),
      });
      continue;
    }
    if (assignment.key.value !== 'modifier') continue;
    const modifier = assignment.value;
    const condition = evaluateTriggerBlock(
      conditionBlock(modifier),
      scenario,
      candidate,
      definitions,
    );
    const conditionExpression = conditionSignature(conditionBlock(modifier));
    unresolved.push(...condition.unresolved);
    referencedProvenance.push(...(condition.helperProvenance ?? []));
    for (const modifierAssignment of assignments(modifier)) {
      if (
        modifierAssignment.value.type !== 'scalar' ||
        !['base', 'add', 'factor'].includes(modifierAssignment.key.value)
      )
        continue;
      const operation = modifierAssignment.key.value as 'base' | 'add' | 'factor';
      const expression = modifierAssignment.value.value;
      const operand = expressionValue(expression, candidate, scenario, definitions, mtthStack);
      unresolved.push(...operand.unresolved);
      referencedProvenance.push(...(operand.referencedProvenance ?? []));
      if (operand.interval === undefined || condition.state === 'false') {
        trace.push({
          operation,
          expression,
          applied: condition.state,
          conditionExpression,
          ...(nodeProvenance(candidate, modifierAssignment, modifierAssignment.key.value) ===
          undefined
            ? {}
            : {
                provenance: nodeProvenance(
                  candidate,
                  modifierAssignment,
                  modifierAssignment.key.value,
                )!,
              }),
        });
        continue;
      }
      const before = current;
      const applied = applyOperation(current, operation, operand.interval);
      current =
        condition.state === 'true'
          ? applied
          : {
              min: current.min.min(applied.min),
              max: current.max.max(applied.max),
            };
      if (!Number.isFinite(current.min.toNumber()) || !Number.isFinite(current.max.toNumber())) {
        unresolved.push({
          code: 'VALUE_NON_FINITE',
          message: `${candidate.id} modifier chain exceeds finite analyzer range`,
          candidateId: candidate.id,
          ...(nodeProvenance(candidate, modifierAssignment, modifierAssignment.key.value) ===
          undefined
            ? {}
            : {
                provenance: nodeProvenance(
                  candidate,
                  modifierAssignment,
                  modifierAssignment.key.value,
                )!,
              }),
        });
        return { trace, unresolved, referencedProvenance };
      }
      trace.push({
        operation,
        expression,
        applied: condition.state,
        conditionExpression,
        ...(condition.helperProvenance?.length
          ? {
              note: `Condition helper chain: ${condition.helperProvenance
                .map(({ symbol }) => symbol)
                .filter(Boolean)
                .join(' -> ')}`,
            }
          : {}),
        ...(operand.interval.min.compare(operand.interval.max) === 0
          ? { value: operand.interval.min.toJSON() }
          : {}),
        ...(before.min.compare(before.max) === 0 ? { before: before.min.toJSON() } : {}),
        ...(current.min.compare(current.max) === 0 ? { after: current.min.toJSON() } : {}),
        ...(nodeProvenance(candidate, modifierAssignment, modifierAssignment.key.value) ===
        undefined
          ? {}
          : {
              provenance: nodeProvenance(
                candidate,
                modifierAssignment,
                modifierAssignment.key.value,
              )!,
            }),
      });
    }
  }
  return {
    ...(current.min.compare(current.max) === 0 ? { value: current.min } : {}),
    interval: current,
    trace,
    unresolved,
    ...(referencedProvenance.length === 0 ? {} : { referencedProvenance }),
  };
}

export function evaluateCandidateValue(
  candidate: WeightedCandidate,
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
): ValueEvaluation {
  const initialExpression = candidate.valueExpression ?? candidate.defaultValue;
  const initial = expressionValue(initialExpression, candidate, scenario, definitions, []);
  if (initial.interval === undefined) return initial;
  const evaluated = evaluateValueBlock(
    candidate.weightBlock,
    candidate,
    scenario,
    definitions,
    initial.interval.min,
  );
  return {
    ...evaluated,
    trace: [...initial.trace, ...evaluated.trace],
    unresolved: [...initial.unresolved, ...evaluated.unresolved],
    referencedProvenance: [
      ...(initial.referencedProvenance ?? []),
      ...(evaluated.referencedProvenance ?? []),
    ],
  };
}
