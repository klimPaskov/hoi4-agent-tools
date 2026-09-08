import { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { hasBlockingDiagnostics } from '../core/diagnostics.js';
import { evaluateTriggerBlock, type TriggerEvaluation } from '../core/condition-evaluator.js';
import type { ConditionScenario, ConditionSubject } from '../core/condition-model.js';
import { resolveScopeContext, rootScopeContext } from '../core/scenario-state.js';
import { assignments, firstScalar, parseClausewitz, type BlockNode } from '../core/source/index.js';
import type { GuiPreviewScenario } from './types.js';

/** Keep declared scoped scalars out of exploratory value generation. */
export function guiExplicitConditionValues(
  base: GuiPreviewScenario,
): Record<string, string | number | boolean> {
  const values = { ...base.stateValues, ...base.variables, ...base.values };
  for (const [key, value] of Object.entries(values)) {
    if (key.includes('.')) continue;
    values[`ROOT.${key}`] ??= value;
    values[`THIS.${key}`] ??= value;
  }
  for (const [scope, binding] of Object.entries(base.scopes ?? {})) {
    for (const [key, value] of Object.entries(binding.state)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        values[`${scope}.${key}`] ??= value;
    }
  }
  return values;
}

function parsedCondition(expression: string): { block?: BlockNode; invalid: boolean } {
  const text = expression.trim();
  const document = parseClausewitz(
    Buffer.from(`condition = ${text.startsWith('{') ? text : `{ ${text} }`}`),
    'scenario:condition',
  );
  const assignment = assignments(document.root, 'condition')[0];
  return {
    ...(assignment?.value.type === 'block' ? { block: assignment.value } : {}),
    invalid: hasBlockingDiagnostics(document.diagnostics) || assignment?.value.type !== 'block',
  };
}

export function guiConditionScenario(
  base: GuiPreviewScenario,
  values = base.values,
): ConditionScenario {
  const state = { ...base.stateValues, ...base.variables, ...values };
  for (const [key, value] of Object.entries(base.flags)) state[`flag.${key}`] = value;
  const scopes = structuredClone(base.scopes ?? {});
  for (const [key, value] of Object.entries(state)) {
    const match = /^(ROOT|THIS|FROM(?:\.FROM)*|PREV)\.(.+)$/u.exec(key);
    if (match === null) continue;
    if (match[1] === 'ROOT' || match[1] === 'THIS') state[match[2]!] ??= value;
    else {
      const scope = (scopes[match[1]!] ??= { id: match[1]!, state: {} });
      scope.state[match[2]!] ??= value;
    }
  }
  const actor = base.country?.tag ?? base.country?.countryTag ?? base.country?.GetTag;
  return {
    id: base.id,
    state,
    scopes,
    closedFlags: false,
    ...(typeof actor === 'string' ? { actor } : {}),
  };
}

export function evaluateGuiCondition(
  expression: string | undefined,
  scenario: ConditionScenario,
  subject: ConditionSubject,
  definitions = new ClausewitzEvaluationDefinitions(),
  scope = 'ROOT',
): TriggerEvaluation {
  const context = resolveScopeContext(scenario, scope, rootScopeContext(scenario));
  const parsed = expression === undefined ? { invalid: false } : parsedCondition(expression);
  if (parsed.invalid || context === undefined)
    return {
      state: 'unresolved',
      unresolved: [
        {
          code: 'GUI_CONDITION_UNRESOLVED',
          message: parsed.invalid
            ? 'Condition could not be parsed'
            : `Scenario does not declare scope ${scope}`,
          candidateId: subject.id,
        },
      ],
    };
  return evaluateTriggerBlock(parsed.block, scenario, subject, definitions, [], context);
}

/** Find operands structurally for exploratory previews, without asserting branch eligibility. */
export function guiConditionVariables(
  expression: string | undefined,
  definitions: ClausewitzEvaluationDefinitions,
): string[] {
  if (expression === undefined) return [];
  const parsed = parsedCondition(expression);
  if (parsed.invalid || parsed.block === undefined) return [];
  const output = new Set<string>();
  const visit = (block: BlockNode, scope: string, stack: ReadonlySet<string>): void => {
    const add = (key: string | undefined): void => {
      // Scoped operands need actual bindings; fabricated flat values can shadow ROOT/PREV.
      if (
        scope === '' &&
        key !== undefined &&
        !key.includes('.') &&
        !key.startsWith('@') &&
        !key.startsWith('constant:') &&
        !Number.isFinite(Number(key))
      )
        output.add(key);
    };
    for (const assignment of assignments(block)) {
      const key = assignment.key.value;
      if (key === 'check_variable' && assignment.value.type === 'block') {
        const short = assignments(assignment.value).find(
          ({ key }) => !['var', 'value', 'compare', 'tooltip'].includes(key.value),
        );
        add(firstScalar(assignment.value, 'var')?.value ?? short?.key.value);
        add(
          firstScalar(assignment.value, 'value')?.value ??
            (short?.value.type === 'scalar' ? short.value.value : undefined),
        );
      } else if (assignment.value.type === 'block') {
        const prefix = ['ROOT', 'THIS', 'FROM', 'PREV'].includes(key) ? `${key}.` : scope;
        visit(assignment.value, prefix, stack);
      } else if (assignment.operator.text === '>' || assignment.operator.text === '<') {
        add(key);
        add(assignment.value.value);
      } else {
        const helper = definitions.scriptedTriggers.get(key);
        if (helper !== undefined && !stack.has(key))
          visit(helper.value, scope, new Set([...stack, key]));
      }
    }
  };
  visit(parsed.block, '', new Set());
  return [...output].sort();
}
