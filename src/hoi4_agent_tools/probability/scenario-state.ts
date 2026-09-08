import type { ProbabilityScenario, ScenarioValue } from './model.js';
import { rootStateValue, scopedExpressionValue } from '../core/scenario-state.js';
export {
  rootScopeContext,
  resolveScopeContext,
  scopeStateValue,
  rootStateValue,
  scopeIdentity,
  scopedExpressionValue,
} from '../core/scenario-state.js';
export type { ConditionScopeContext as ProbabilityScopeContext } from '../core/scenario-state.js';

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
