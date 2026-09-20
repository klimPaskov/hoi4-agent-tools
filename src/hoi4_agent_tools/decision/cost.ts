import { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { evaluateTriggerBlock, resolveConditionNumber } from '../core/condition-evaluator.js';
import type { ConditionScenario, ConditionUnresolved, TriState } from '../core/condition-model.js';
import type { SourceLocation } from '../core/diagnostics.js';
import type { ScanSnapshot } from '../core/engine.js';
import { rootScopeContext } from '../core/scenario-state.js';
import { assignments, nodeLocation, type AssignmentNode } from '../core/source/index.js';
import type { DecisionSource } from './source-inventory.js';

export interface DecisionPaymentEffect {
  resource: string;
  amount: number | null;
  operation: 'add' | 'subtract';
  scope: 'ROOT';
  location?: SourceLocation;
}

export interface DecisionCostInspection {
  kind: 'none' | 'engine_political_power' | 'custom' | 'invalid';
  expression: string | null;
  amount: number | null;
  affordable: TriState;
  paymentEffects: DecisionPaymentEffect[];
  conditionalOrHelperEffects: string[];
  unresolved: ConditionUnresolved[];
}

function scalar(assignment: AssignmentNode | undefined): string | undefined {
  return assignment?.value.type === 'scalar' ? assignment.value.value : undefined;
}

function unresolved(source: DecisionSource, message: string): ConditionUnresolved {
  return {
    code: 'DECISION_COST_UNRESOLVED',
    message,
    candidateId: source.id,
    provenance: {
      path: source.path,
      rootKind: source.rootKind,
      loadOrder: source.loadOrder,
      sourceHash: source.sourceHash,
      ...(source.location === undefined ? {} : { location: source.location }),
      symbol: source.id,
    },
  };
}

function directPayments(
  snapshot: ScanSnapshot,
  source: DecisionSource,
  scenario: ConditionScenario,
  definitions: ClausewitzEvaluationDefinitions,
): {
  paymentEffects: DecisionPaymentEffect[];
  conditionalOrHelperEffects: string[];
} {
  const paymentEffects: DecisionPaymentEffect[] = [];
  const conditionalOrHelperEffects: string[] = [];
  for (const effect of source.fields.complete_effect) {
    if (effect.value.type !== 'block') {
      conditionalOrHelperEffects.push('malformed complete_effect');
      continue;
    }
    for (const entry of assignments(effect.value)) {
      const key = entry.key.value;
      let resource: string | undefined;
      let operation: 'add' | 'subtract' | undefined;
      let expression: string | undefined;
      if (key === 'add_political_power' || key === 'add_command_power') {
        resource = key.slice(4);
        operation = 'add';
        expression = scalar(entry);
      } else if (key === 'add_to_variable' || key === 'subtract_from_variable') {
        if (entry.value.type === 'block') {
          const values = assignments(entry.value).filter(
            ({ key: field }) => field.value !== 'tooltip',
          );
          if (values.length === 1) {
            resource = `variable.${values[0]!.key.value}`;
            operation = key === 'add_to_variable' ? 'add' : 'subtract';
            expression = scalar(values[0]);
          }
        }
      }
      if (resource !== undefined && operation !== undefined) {
        const amount =
          expression === undefined
            ? undefined
            : resolveConditionNumber(
                expression,
                scenario,
                rootScopeContext(scenario),
                definitions,
                source.path,
              );
        const normalizedOperation =
          amount !== undefined && amount < 0
            ? operation === 'add'
              ? 'subtract'
              : 'add'
            : operation;
        paymentEffects.push({
          resource,
          amount: amount === undefined ? null : Math.abs(amount),
          operation: normalizedOperation,
          scope: 'ROOT',
          location: nodeLocation(source.document, entry, key),
        });
        if (amount === undefined) conditionalOrHelperEffects.push(`dynamic payment: ${key}`);
      } else if (
        key === 'add_political_power' ||
        key === 'add_command_power' ||
        key === 'add_to_variable' ||
        key === 'subtract_from_variable'
      ) {
        conditionalOrHelperEffects.push(`unparsed payment: ${key}`);
      } else if (
        snapshot.index.find('scripted_effect', key) !== undefined ||
        ['if', 'else_if', 'else', 'random', 'random_list', 'ROOT', 'FROM', 'meta_effect'].includes(
          key,
        )
      ) {
        conditionalOrHelperEffects.push(key);
      }
    }
  }
  return { paymentEffects, conditionalOrHelperEffects };
}

/** Cost and payment evidence is source-bounded; a custom cost is never treated as automatic payment. */
export function inspectDecisionCost(
  snapshot: ScanSnapshot,
  source: DecisionSource,
  scenario: ConditionScenario,
): DecisionCostInspection {
  const definitions = ClausewitzEvaluationDefinitions.build(snapshot);
  const base = directPayments(snapshot, source, scenario, definitions);
  const cost = source.fields.cost;
  const custom = source.fields.custom_cost_trigger;
  const findings: ConditionUnresolved[] = [];
  const deductions = base.paymentEffects.filter(({ operation }) => operation === 'subtract');
  const seenDeductions = new Set<string>();
  for (const deduction of deductions) {
    if (seenDeductions.has(deduction.resource))
      findings.push(unresolved(source, `Multiple direct payments deduct ${deduction.resource}`));
    seenDeductions.add(deduction.resource);
  }
  if (cost.length > 1 || custom.length > 1 || (cost.length > 0 && custom.length > 0)) {
    findings.push(unresolved(source, 'Conflicting or repeated decision cost declarations'));
    return {
      kind: 'invalid',
      expression: null,
      amount: null,
      affordable: 'unresolved',
      ...base,
      unresolved: findings,
    };
  }
  if (cost.length === 1) {
    if (deductions.some(({ resource }) => resource === 'political_power'))
      findings.push(
        unresolved(
          source,
          'Engine political-power cost also has an explicit political-power deduction',
        ),
      );
    const expression = scalar(cost[0]);
    const amount =
      expression === undefined
        ? undefined
        : resolveConditionNumber(
            expression,
            scenario,
            rootScopeContext(scenario),
            definitions,
            source.path,
          );
    const politicalPower = resolveConditionNumber(
      'political_power',
      scenario,
      rootScopeContext(scenario),
      definitions,
      source.path,
    );
    if (amount === undefined || amount < 0)
      findings.push(
        unresolved(source, 'Engine political-power cost is not a resolved nonnegative number'),
      );
    if (politicalPower === undefined)
      findings.push(unresolved(source, 'Scenario does not declare current political power'));
    return {
      kind: 'engine_political_power',
      expression: expression ?? null,
      amount: amount ?? null,
      affordable:
        amount === undefined || amount < 0 || politicalPower === undefined
          ? 'unresolved'
          : politicalPower >= amount
            ? 'true'
            : 'false',
      ...base,
      unresolved: findings,
    };
  }
  if (custom.length === 1) {
    const trigger = custom[0]!.value;
    const evaluated =
      trigger.type === 'block'
        ? evaluateTriggerBlock(
            trigger,
            { ...scenario, closedFlags: scenario.closedFlags ?? false },
            {
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
            },
            definitions,
          )
        : {
            state: 'unresolved' as const,
            unresolved: [unresolved(source, 'custom_cost_trigger is not a block')],
          };
    findings.push(...evaluated.unresolved);
    if (base.conditionalOrHelperEffects.length > 0)
      findings.push(
        unresolved(
          source,
          'Custom payment crosses a conditional, helper, dynamic, or unparsed effect path',
        ),
      );
    if (base.paymentEffects.length === 0 && base.conditionalOrHelperEffects.length === 0)
      findings.push(
        unresolved(
          source,
          'Custom cost has no recognized direct payment effect; other effect semantics remain unverified',
        ),
      );
    return {
      kind: 'custom',
      expression: scalar(source.fields.custom_cost_text[0]) ?? null,
      amount: null,
      affordable: evaluated.state,
      ...base,
      unresolved: findings,
    };
  }
  return {
    kind: 'none',
    expression: null,
    amount: 0,
    affordable: 'true',
    ...base,
    unresolved: findings,
  };
}
