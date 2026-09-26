import type { GuiPreviewScenario } from '../gui/types.js';
import type { ProbabilityScenario } from '../probability/model.js';
import type { ConditionScenario, ScenarioValue } from './condition-model.js';

/** Versioned, declared state shared by source-backed scenario services. */
export interface SharedScenario extends ConditionScenario {
  schemaVersion: '1.0';
  globalFlags?: string[];
  /** Complete catalogs are required before a finite scope iterator can execute. */
  scopeCatalogs?: Record<string, { complete: boolean; members: string[] }> | undefined;
}

export interface ScenarioState {
  scenario: SharedScenario;
  /** A missing value is distinct from a value made unknown by an unsupported effect. */
  unknown: Set<string>;
  day: number;
}

export function copyScenario(scenario: SharedScenario): ScenarioState {
  return {
    scenario: structuredClone(scenario),
    unknown: new Set<string>(),
    day: 0,
  };
}

export function scenarioValue(
  state: ScenarioState,
  key: string,
  scope = 'ROOT',
): ScenarioValue | undefined {
  if (state.unknown.has('*') || state.unknown.has(`${scope}.${key}`)) return undefined;
  if (scope === 'ROOT' || scope === 'THIS') return state.scenario.state[key];
  return state.scenario.scopes?.[scope]?.state[key];
}

export function setScenarioValue(
  state: ScenarioState,
  key: string,
  value: ScenarioValue | undefined,
  scope = 'ROOT',
): void {
  const identity = `${scope}.${key}`;
  if (value === undefined) state.unknown.add(identity);
  else {
    state.unknown.delete(identity);
    if (scope === 'ROOT' || scope === 'THIS') state.scenario.state[key] = value;
    else if (state.scenario.scopes?.[scope] !== undefined)
      state.scenario.scopes[scope].state[key] = value;
  }
}

/** Preserve the GUI's existing input precedence and exploratory flag semantics. */
export function scenarioFromGui(base: GuiPreviewScenario, values = base.values): SharedScenario {
  const state: Record<string, ScenarioValue> = {
    ...base.stateValues,
    ...base.variables,
    ...values,
  };
  for (const [key, value] of Object.entries(base.flags)) state[`flag.${key}`] = value;
  const scopes = structuredClone(base.scopes ?? {});
  for (const stateId of Object.keys(base.controls ?? {})) {
    scopes[stateId] ??= { id: stateId, type: 'state', state: {} };
  }
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
    schemaVersion: '1.0',
    id: base.id,
    ...(base.date === undefined ? {} : { date: base.date }),
    ...(base.controls === undefined ? {} : { controls: { ...base.controls } }),
    state,
    scopes,
    closedFlags: false,
    ...(typeof actor === 'string' ? { actor } : {}),
  };
}

/** Probability retains pools, uncertainty, correlations and schedule in its own adapter. */
export function scenarioFromProbability(base: ProbabilityScenario): SharedScenario {
  return {
    schemaVersion: '1.0',
    id: base.id,
    ...(base.actor === undefined ? {} : { actor: base.actor }),
    ...(base.date === undefined ? {} : { date: base.date }),
    ...(base.controls === undefined ? {} : { controls: { ...base.controls } }),
    state: structuredClone(base.state),
    ...(base.flags === undefined ? {} : { flags: [...base.flags] }),
    ...(base.eventTargets === undefined ? {} : { eventTargets: { ...base.eventTargets } }),
    ...(base.scopes === undefined ? {} : { scopes: structuredClone(base.scopes) }),
    ...(base.candidateOverrides === undefined
      ? {}
      : { candidateOverrides: { ...base.candidateOverrides } }),
    closedFlags: true,
    ...(base.scopePools === undefined
      ? {}
      : {
          scopeCatalogs: Object.fromEntries(
            base.scopePools.map((pool) => [
              pool.id,
              {
                complete: pool.complete,
                members: pool.candidates.map((candidate) => candidate.id),
              },
            ]),
          ),
        }),
  };
}
