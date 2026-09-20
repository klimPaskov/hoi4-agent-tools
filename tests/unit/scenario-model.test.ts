import { describe, expect, it } from 'vitest';
import {
  copyScenario,
  scenarioFromProbability,
  scenarioValue,
  setScenarioValue,
} from '../../src/hoi4_agent_tools/core/scenario-model.js';

describe('shared scenario model', () => {
  it('copies scope state and makes unsupported writes explicitly unknown', () => {
    const source = {
      schemaVersion: '1.0' as const,
      id: 'case',
      state: { treasury: 12 },
      scopes: { FROM: { id: 'TARGET', type: 'country' as const, state: { population: 8 } } },
    };
    const state = copyScenario(source);
    setScenarioValue(state, 'treasury', 7);
    setScenarioValue(state, 'population', undefined, 'FROM');
    expect(source.state.treasury).toBe(12);
    expect(source.scopes.FROM.state.population).toBe(8);
    expect(scenarioValue(state, 'treasury')).toBe(7);
    expect(scenarioValue(state, 'population', 'FROM')).toBeUndefined();
    expect(state.unknown.has('FROM.population')).toBe(true);
  });

  it('projects probability state and complete pool membership without mutating it', () => {
    const source = {
      id: 'weighted',
      state: { value: 3 },
      scopePools: [
        {
          id: 'countries',
          selection: 'enumeration' as const,
          complete: true,
          candidates: [
            { id: 'A', state: {} },
            { id: 'B', state: {} },
          ],
        },
      ],
    };
    const projected = scenarioFromProbability(source);
    expect(projected.scopeCatalogs?.countries).toEqual({ complete: true, members: ['A', 'B'] });
    projected.state.value = 9;
    expect(source.state.value).toBe(3);
  });
});
