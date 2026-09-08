import type { ConditionScenario, ConditionScopeBinding } from './condition-model.js';

export interface ConditionScopeContext {
  expression: string;
  binding: ConditionScopeBinding;
  parent?: ConditionScopeContext;
}

function caseInsensitiveEntry<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  if (record === undefined) return undefined;
  if (Object.hasOwn(record, key)) return record[key];
  const normalized = key.toLowerCase();
  const found = Object.entries(record).find(
    ([candidate]) => candidate.toLowerCase() === normalized,
  );
  return found?.[1];
}

export function rootScopeContext(scenario: ConditionScenario): ConditionScopeContext {
  return {
    expression: 'ROOT',
    binding: {
      id: scenario.actor ?? 'ROOT',
      ...(scenario.actor === undefined ? {} : { actor: scenario.actor }),
      state: scenario.state,
      ...(scenario.flags === undefined ? {} : { flags: scenario.flags }),
      ...(scenario.eventTargets === undefined ? {} : { eventTargets: scenario.eventTargets }),
    },
  };
}

function explicitScope(
  scenario: ConditionScenario,
  expression: string,
  parent: ConditionScopeContext,
): ConditionScopeContext | undefined {
  const binding = caseInsensitiveEntry(scenario.scopes, expression);
  return binding === undefined ? undefined : { expression, binding, parent };
}

export function resolveScopeContext(
  scenario: ConditionScenario,
  expression: string,
  current: ConditionScopeContext,
): ConditionScopeContext | undefined {
  const upper = expression.toUpperCase();
  if (upper === 'ROOT')
    return current.expression === 'ROOT'
      ? current
      : { ...rootScopeContext(scenario), parent: current };
  if (upper === 'THIS') return current;
  if (upper === 'PREV') return current.parent ?? explicitScope(scenario, expression, current);

  const chained =
    current.expression === 'ROOT' || current.expression === 'THIS'
      ? expression
      : `${current.expression}.${expression}`;
  const chainedBinding = explicitScope(scenario, chained, current);
  if (chainedBinding !== undefined) return chainedBinding;
  const direct = explicitScope(scenario, expression, current);
  if (direct !== undefined) return direct;

  const targetMatch = /^(?:event_target|scope):(.+)$/iu.exec(expression);
  const targetId =
    targetMatch === null
      ? undefined
      : (caseInsensitiveEntry(current.binding.eventTargets, targetMatch[1]!) ??
        caseInsensitiveEntry(scenario.eventTargets, targetMatch[1]!));
  if (targetId !== undefined) {
    const declaredBinding = Object.values(scenario.scopes ?? {}).find(
      (binding) => binding.id === targetId || binding.actor === targetId,
    );
    return {
      expression,
      binding: declaredBinding ?? { id: targetId, actor: targetId, state: {} },
      parent: current,
    };
  }
  return undefined;
}

export function scopeStateValue(
  scenario: ConditionScenario,
  key: string,
  current: ConditionScopeContext,
): unknown {
  if (Object.hasOwn(current.binding.state, key)) return current.binding.state[key];
  if (Object.hasOwn(current.binding.state, `trigger.${key}`))
    return current.binding.state[`trigger.${key}`];
  if (current.expression !== 'ROOT') return undefined;
  if (Object.hasOwn(scenario.state, key)) return scenario.state[key];
  if (Object.hasOwn(scenario.state, `trigger.${key}`)) return scenario.state[`trigger.${key}`];
  return undefined;
}

export function rootStateValue(scenario: ConditionScenario, key: string): unknown {
  if (Object.hasOwn(scenario.state, key)) return scenario.state[key];
  if (Object.hasOwn(scenario.state, `trigger.${key}`)) return scenario.state[`trigger.${key}`];
  return undefined;
}

export function scopeIdentity(current: ConditionScopeContext): string {
  return current.binding.actor ?? current.binding.id;
}

export function scopedExpressionValue(scenario: ConditionScenario, expression: string): unknown {
  const scopes = Object.entries(scenario.scopes ?? {}).sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [scope, binding] of scopes) {
    for (const prefix of [`${scope}.`, `scope.${scope}.`, `scopes.${scope}.`]) {
      if (!expression.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const key = expression.slice(prefix.length).replace(/^state\./u, '');
      if (Object.hasOwn(binding.state, key)) return binding.state[key];
      if (Object.hasOwn(binding.state, `variable.${key}`)) return binding.state[`variable.${key}`];
    }
  }
  return undefined;
}
