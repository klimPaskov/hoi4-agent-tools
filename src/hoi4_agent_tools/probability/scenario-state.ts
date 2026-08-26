import type { ProbabilityScenario, ProbabilityScopeBinding, ScenarioValue } from './model.js';

export interface ProbabilityScopeContext {
  expression: string;
  binding: ProbabilityScopeBinding;
  parent?: ProbabilityScopeContext;
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

export function rootScopeContext(scenario: ProbabilityScenario): ProbabilityScopeContext {
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
  scenario: ProbabilityScenario,
  expression: string,
  parent: ProbabilityScopeContext,
): ProbabilityScopeContext | undefined {
  const binding = caseInsensitiveEntry(scenario.scopes, expression);
  return binding === undefined ? undefined : { expression, binding, parent };
}

export function resolveScopeContext(
  scenario: ProbabilityScenario,
  expression: string,
  current: ProbabilityScopeContext,
): ProbabilityScopeContext | undefined {
  const upper = expression.toUpperCase();
  if (upper === 'ROOT') return rootScopeContext(scenario);
  if (upper === 'THIS') return current;
  if (upper === 'PREV') return current.parent ?? rootScopeContext(scenario);

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
  scenario: ProbabilityScenario,
  key: string,
  current: ProbabilityScopeContext,
): unknown {
  if (Object.hasOwn(current.binding.state, key)) return current.binding.state[key];
  if (Object.hasOwn(current.binding.state, `trigger.${key}`))
    return current.binding.state[`trigger.${key}`];
  if (current.expression !== 'ROOT') return undefined;
  if (Object.hasOwn(scenario.state, key)) return scenario.state[key];
  if (Object.hasOwn(scenario.state, `trigger.${key}`)) return scenario.state[`trigger.${key}`];
  return undefined;
}

export function rootStateValue(scenario: ProbabilityScenario, key: string): unknown {
  if (Object.hasOwn(scenario.state, key)) return scenario.state[key];
  if (Object.hasOwn(scenario.state, `trigger.${key}`)) return scenario.state[`trigger.${key}`];
  return undefined;
}

export function scopeIdentity(current: ProbabilityScopeContext): string {
  return current.binding.actor ?? current.binding.id;
}

export function scopedExpressionValue(scenario: ProbabilityScenario, expression: string): unknown {
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

function updateScopeState(
  scenario: ProbabilityScenario,
  path: string,
  value: ScenarioValue,
): ProbabilityScenario | undefined {
  const scopes = Object.entries(scenario.scopes ?? {}).sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [scope, binding] of scopes) {
    for (const prefix of [`scope.${scope}.`, `scopes.${scope}.`]) {
      if (!path.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const key = path.slice(prefix.length).replace(/^state\./u, '');
      return {
        ...scenario,
        scopes: {
          ...scenario.scopes,
          [scope]: { ...binding, state: { ...binding.state, [key]: value } },
        },
      };
    }
  }
  return undefined;
}

function updatePoolCandidateState(
  scenario: ProbabilityScenario,
  path: string,
  value: ScenarioValue,
): ProbabilityScenario | undefined {
  if (!path.startsWith('scopePools.')) return undefined;
  for (const [poolIndex, pool] of (scenario.scopePools ?? []).entries()) {
    const poolPrefix = `scopePools.${pool.id}.`;
    if (!path.startsWith(poolPrefix)) continue;
    for (const [candidateIndex, candidate] of pool.candidates.entries()) {
      const candidatePrefix = `${poolPrefix}${candidate.id}.`;
      if (!path.startsWith(candidatePrefix)) continue;
      const key = path.slice(candidatePrefix.length).replace(/^state\./u, '');
      const candidates = [...pool.candidates];
      candidates[candidateIndex] = {
        ...candidate,
        state: { ...candidate.state, [key]: value },
      };
      const pools = [...(scenario.scopePools ?? [])];
      pools[poolIndex] = { ...pool, candidates };
      return { ...scenario, scopePools: pools };
    }
  }
  return undefined;
}

export function scenarioPathValue(scenario: ProbabilityScenario, path: string): unknown {
  const scoped = scopedExpressionValue(scenario, path);
  if (scoped !== undefined) return scoped;
  if (path.startsWith('scopePools.')) {
    for (const pool of scenario.scopePools ?? []) {
      const poolPrefix = `scopePools.${pool.id}.`;
      if (!path.startsWith(poolPrefix)) continue;
      for (const candidate of pool.candidates) {
        const candidatePrefix = `${poolPrefix}${candidate.id}.`;
        if (!path.startsWith(candidatePrefix)) continue;
        const key = path.slice(candidatePrefix.length).replace(/^state\./u, '');
        if (Object.hasOwn(candidate.state, key)) return candidate.state[key];
      }
    }
  }
  return rootStateValue(scenario, path);
}

export function withScenarioPathValue(
  scenario: ProbabilityScenario,
  path: string,
  value: ScenarioValue,
): ProbabilityScenario {
  return (
    updateScopeState(scenario, path, value) ??
    updatePoolCandidateState(scenario, path, value) ?? {
      ...scenario,
      state: { ...scenario.state, [path]: value },
    }
  );
}
