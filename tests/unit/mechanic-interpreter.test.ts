import { describe, expect, it } from 'vitest';
import { ClausewitzEvaluationDefinitions } from '../../src/hoi4_agent_tools/core/clausewitz-evaluation.js';
import {
  MechanicInterpreter,
  parseMechanicBlock,
} from '../../src/hoi4_agent_tools/mechanic/interpreter.js';

const definitions = new ClausewitzEvaluationDefinitions();
const scenario = () => ({
  schemaVersion: '1.0' as const,
  id: 'mechanic-case',
  actor: 'AAA',
  state: { treasury: 10, political_power: 20, people: [1, 2] },
  flags: [] as string[],
});

describe('bounded mechanic interpreter', () => {
  it('runs arithmetic, flags, arrays, and explicit time on a copy', () => {
    const input = scenario();
    const runner = new MechanicInterpreter(input, definitions, new Map());
    runner.execute(
      parseMechanicBlock(`
      add_to_variable = { treasury = 5 }
      subtract_from_variable = { treasury = 2 }
      add_political_power = -4
      add_to_array = { array = people value = 3 }
      set_country_flag = { flag = ready days = 2 }
    `),
    );
    expect(runner.result().state.scenario.state).toMatchObject({
      treasury: 13,
      political_power: 16,
      people: [1, 2, 3],
    });
    expect(runner.result().state.scenario.flags).toContain('ready');
    runner.advanceDays(2);
    expect(runner.result().state.scenario.flags).not.toContain('ready');
    expect(input.state.treasury).toBe(10);
    expect(runner.result().complete).toBe(true);
  });

  it('models unscoped temporary-variable arithmetic and scope-valued assignments', () => {
    const runner = new MechanicInterpreter(
      {
        ...scenario(),
        scopes: { FROM: { id: 'BBB', type: 'country', state: { treasury: 2 } } },
      },
      definitions,
      new Map(),
    );
    runner.execute(
      parseMechanicBlock(`
      FROM = {
        set_temp_variable = { scratch = treasury }
        multiply_temp_variable = { scratch = 1.55 }
        round_temp_variable = scratch
        subtract_from_temp_variable = { scratch = 2 }
        clamp_temp_variable = { var = scratch min = 0 max = 20 }
        set_temp_variable = { selected_actor = ROOT }
      }
    `),
    );
    expect(runner.result().state.scenario.state).toMatchObject({
      scratch: 1,
      selected_actor: 'AAA',
    });
    expect(runner.result().state.scenario.scopes?.FROM?.state.scratch).toBeUndefined();
    expect(runner.result().complete).toBe(true);
  });

  it('resolves has_variable for declared and absent scenario variables', () => {
    const runner = new MechanicInterpreter(scenario(), definitions, new Map());
    runner.execute(
      parseMechanicBlock(`
      if = {
        limit = { has_variable = treasury }
        set_temp_variable = { declared_variable_seen = 1 }
      }
      if = {
        limit = { NOT = { has_variable = missing_variable } }
        set_temp_variable = { missing_variable_defaulted = 1 }
      }
    `),
    );

    expect(runner.result().state.scenario.state).toMatchObject({
      declared_variable_seen: 1,
      missing_variable_defaulted: 1,
    });
    expect(runner.result().complete).toBe(true);
  });

  it('keeps skipped branches from changing state', () => {
    const runner = new MechanicInterpreter(scenario(), definitions, new Map());
    runner.execute(
      parseMechanicBlock(`
      if = { limit = { check_variable = { var = treasury value = 20 compare = greater_than_or_equals } }
        set_variable = { treasury = 99 } }
      else = { set_variable = { treasury = 11 } }
    `),
    );
    expect(runner.result().state.scenario.state.treasury).toBe(11);
    expect(
      runner.result().trace.some((step) => step.effect === 'if' && step.status === 'skipped'),
    ).toBe(true);
  });

  it('requires a complete finite catalog and taints unsupported operations', () => {
    const runner = new MechanicInterpreter(scenario(), definitions, new Map());
    runner.execute(parseMechanicBlock('every_country = { add_to_variable = { treasury = 1 } }'));
    expect(runner.result().complete).toBe(false);
    expect(runner.result().unresolved).toContainEqual(
      expect.stringContaining('Finite complete scope catalog'),
    );
  });

  it('rejects recursive helper expansion', () => {
    const helper = parseMechanicBlock('loop = yes', 'fixture:helper.txt');
    const runner = new MechanicInterpreter(scenario(), definitions, new Map([['loop', helper]]));
    runner.execute(parseMechanicBlock('loop = { }'));
    expect(runner.result().unresolved).toContainEqual(
      expect.stringContaining('Scripted helper cycle'),
    );
  });

  it('applies documented math expressions and bounded meta substitutions', () => {
    const runner = new MechanicInterpreter(scenario(), definitions, new Map());
    runner.execute(
      parseMechanicBlock(`
      set_variable = { treasury = { value = treasury add = 2 multiply = 3 } }
      meta_effect = {
        text = { add_to_variable = { [TARGET] = [AMOUNT] } }
        TARGET = treasury
        AMOUNT = 4
      }
    `),
    );
    expect(runner.result().state.scenario.state.treasury).toBe(40);
    expect(runner.result().complete).toBe(true);
  });

  it('propagates unknown dynamic substitutions without executing guessed source', () => {
    const runner = new MechanicInterpreter(scenario(), definitions, new Map());
    runner.execute(
      parseMechanicBlock(`
      meta_effect = {
        text = { set_variable = { treasury = [MISSING] } }
      }
    `),
    );
    expect(runner.result().complete).toBe(false);
    expect(runner.result().state.unknown.has('*')).toBe(true);
  });

  it('resolves ROOT, FROM, PREV and short-lived event targets', () => {
    const runner = new MechanicInterpreter(
      {
        ...scenario(),
        scopes: { FROM: { id: 'BBB', type: 'country', state: { treasury: 2 } } },
      },
      definitions,
      new Map(),
    );
    runner.execute(
      parseMechanicBlock(`
      FROM = {
        set_variable = { treasury = 5 }
        PREV = { add_to_variable = { treasury = 1 } }
        save_event_target_as = chosen
      }
      event_target:chosen = { add_to_variable = { treasury = 1 } }
    `),
    );
    expect(runner.result().state.scenario.state.treasury).toBe(11);
    expect(runner.result().state.scenario.scopes?.FROM?.state.treasury).toBe(6);
    expect(runner.result().state.scenario.eventTargets?.chosen).toBeUndefined();
    expect(runner.result().complete).toBe(true);
  });

  it('keeps global flags distinct from actor flags', () => {
    const runner = new MechanicInterpreter(scenario(), definitions, new Map());
    runner.execute(parseMechanicBlock('set_global_flag = world_event'));
    expect(runner.result().state.scenario.globalFlags).toContain('world_event');
    expect(runner.result().state.scenario.flags).not.toContain('world_event');
  });
});
