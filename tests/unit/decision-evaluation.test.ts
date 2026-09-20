import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import type { ScanSnapshot } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { inspectDecisionCost } from '../../src/hoi4_agent_tools/decision/cost.js';
import { evaluateDecisionGates } from '../../src/hoi4_agent_tools/decision/evaluation.js';
import { inspectDecisionLifecycle } from '../../src/hoi4_agent_tools/decision/lifecycle.js';
import { decisionSourceInventory } from '../../src/hoi4_agent_tools/decision/source-inventory.js';

function file(relativePath: string, text: string): ScannedFile {
  const bytes = Buffer.from(text);
  return {
    absolutePath: `/fixture/${relativePath}`,
    displayPath: `mod:${relativePath}`,
    relativePath,
    rootKind: 'mod',
    loadOrder: 1,
    size: bytes.length,
    modifiedMs: 0,
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

function snapshot(): ScanSnapshot {
  const files = [
    file(
      'common/decisions/categories/actions.txt',
      'actions = { allowed = { original_tag = GER } visible = { has_country_flag = unlocked } }',
    ),
    file(
      'common/decisions/actions.txt',
      `actions = {
        pressure_target = {
          targets = { FRA BEL }
          target_root_trigger = { has_country_flag = unlocked }
          target_trigger = { FROM = { has_idea = ready } }
          available = { FROM = { has_idea = ready } }
        }
        state_action = {
          targets = { 123 }
          state_trigger = any
          target_trigger = { FROM = { is_owned_by = ROOT } }
        }
        owned_state_action = { state_trigger = any_owned_state }
        controlled_state_action = { state_trigger = any_controlled_state }
        european_state_action = { state_trigger = europe }
        untargeted_action = { state_trigger = no }
        invalid_allowed = { allowed = { FROM = { has_idea = ready } } }
        fund_plan = {
          cost = constant:economy.decision_cost
          days_remove = -1
          days_re_enable = 60
          complete_effect = { set_country_flag = plan_funded }
        }
        fund_custom = {
          custom_cost_trigger = { check_variable = { treasury = 10 compare = greater_than_or_equals } }
          custom_cost_text = treasury_cost
          complete_effect = { subtract_from_variable = { treasury = 10 } }
        }
        fund_without_payment = {
          custom_cost_trigger = { check_variable = { treasury = 10 compare = greater_than_or_equals } }
          custom_cost_text = treasury_cost
          complete_effect = { set_country_flag = plan_funded }
        }
        fund_twice = {
          custom_cost_trigger = { check_variable = { treasury = 10 } }
          complete_effect = {
            subtract_from_variable = { treasury = 10 }
            subtract_from_variable = { treasury = 10 }
          }
        }
        fund_engine_twice = {
          cost = 10
          complete_effect = { add_political_power = -10 }
        }
        timed_action = {
          visible = { has_country_flag = action_visible }
          cancel_if_not_visible = yes
          cancel_trigger = { has_country_flag = action_cancelled }
          remove_trigger = { has_country_flag = action_removed }
          days_remove = 30
          remove_effect = { set_country_flag = action_expired }
        }
        clock = {
          activation = { has_country_flag = mission_ready }
          visible = { always = no }
          days_mission_timeout = 30
          available = { has_country_flag = mission_complete }
          timeout_effect = { set_country_flag = failed }
          cancel_trigger = { has_country_flag = mission_cancelled }
          cancel_effect = { set_country_flag = cancellation_recorded }
        }
      }`,
    ),
    file('common/script_constants/economy.txt', 'economy = { decision_cost = 25 }'),
  ];
  const index = SymbolIndex.build(files);
  return {
    workspaceId: 'fixture',
    revision: 'revision-one',
    files,
    index,
    complete: index.complete,
    skippedSourceCount: index.skippedSourceCount,
    skippedSources: index.skippedSources,
    diagnostics: index.diagnostics,
  };
}

describe('decision gate evaluation', () => {
  it('uses declared owner, controller, and continent for state target selection', () => {
    const scan = snapshot();
    const actor = {
      id: 'state_target',
      actor: 'GER',
      state: {},
      scopes: {
        FROM: {
          id: '123',
          type: 'state' as const,
          state: { owner: 'GER', controller: 'FRA', continent: 'europe' },
        },
      },
    };
    expect(evaluateDecisionGates(scan, 'owned_state_action', actor).eligible).toBe('true');
    expect(evaluateDecisionGates(scan, 'controlled_state_action', actor).eligible).toBe('false');
    expect(evaluateDecisionGates(scan, 'european_state_action', actor).eligible).toBe('true');
    expect(
      evaluateDecisionGates(scan, 'untargeted_action', {
        id: 'untargeted',
        actor: 'GER',
        state: {},
      }).eligible,
    ).toBe('true');
    expect(
      evaluateDecisionGates(scan, 'owned_state_action', {
        ...actor,
        scopes: { FROM: { id: '123', type: 'state', state: {} } },
      }).eligible,
    ).toBe('unresolved');
    expect(
      evaluateDecisionGates(scan, 'owned_state_action', {
        ...actor,
        scopes: { FROM: { id: '123', state: { owner: 'GER' } } },
      }).eligible,
    ).toBe('unresolved');
    expect(
      evaluateDecisionGates(scan, 'invalid_allowed', {
        ...actor,
        scopes: { FROM: { id: 'FRA', type: 'country', state: { has_idea: 'ready' } } },
      }).decisionAllowed.state,
    ).toBe('unresolved');
  });

  it('keeps ROOT actor and FROM target separate and fails closed on missing target state', () => {
    const scan = snapshot();
    const base = {
      id: 'france',
      actor: 'GER',
      state: {},
      flags: ['unlocked'],
      scopes: {
        FROM: { id: 'FRA', actor: 'FRA', type: 'country' as const, state: { has_idea: 'ready' } },
      },
    };
    const eligible = evaluateDecisionGates(scan, 'pressure_target', base);
    expect(eligible).toMatchObject({
      actor: 'GER',
      target: 'FRA',
      eligible: 'true',
      visible: 'true',
      available: 'true',
      complete: true,
    });
    expect(
      evaluateDecisionGates(scan, 'pressure_target', {
        ...base,
        scopes: {
          FROM: { id: 'SOV', actor: 'SOV', type: 'country', state: { has_idea: 'ready' } },
        },
      }).eligible,
    ).toBe('false');
    expect(evaluateDecisionGates(scan, 'pressure_target', { ...base, scopes: {} }).eligible).toBe(
      'unresolved',
    );
    expect(evaluateDecisionGates(scan, 'pressure_target', { ...base, actor: 'ITA' }).eligible).toBe(
      'false',
    );
  });

  it('treats mission activation and completion separately from ignored mission visibility', () => {
    const result = evaluateDecisionGates(snapshot(), 'clock', {
      id: 'mission',
      actor: 'GER',
      state: {},
      flags: ['mission_ready'],
      closedFlags: true,
    });
    expect(result.kind).toBe('mission');
    expect(result.activation?.state).toBe('true');
    expect(result.decisionVisible).toBeNull();
    expect(result.visible).toBeNull();
    expect(result.eligible).toBe('true');
    expect(result.available).toBe('false');
    expect(result.complete).toBe(true);
  });

  it('requires a state binding when an explicit target list also has a state filter', () => {
    const scan = snapshot();
    const base = {
      id: 'state',
      actor: 'GER',
      state: {},
      scopes: {
        FROM: { id: '123', type: 'state' as const, state: { is_owned_by: 'GER' } },
      },
    };
    expect(evaluateDecisionGates(scan, 'state_action', base).eligible).toBe('true');
    expect(
      evaluateDecisionGates(scan, 'state_action', {
        ...base,
        scopes: {
          FROM: { id: '123', type: 'country', state: { is_owned_by: 'GER' } },
        },
      }).eligible,
    ).toBe('false');
    const unknownActor = evaluateDecisionGates(scan, 'state_action', {
      id: base.id,
      state: base.state,
      scopes: base.scopes,
    });
    expect(unknownActor.targetTrigger.state).toBe('unresolved');
    expect(unknownActor.complete).toBe(false);
  });

  it('separates engine political-power payment from custom affordability and effect payment', () => {
    const scan = snapshot();
    const scenario = {
      id: 'costs',
      actor: 'GER',
      state: { political_power: 30, treasury: 20 },
    };
    const decisions = decisionSourceInventory(scan).decisions;
    const source = (id: string) => decisions.find((decision) => decision.id === id)!;
    expect(inspectDecisionCost(scan, source('fund_plan'), scenario)).toMatchObject({
      kind: 'engine_political_power',
      expression: 'constant:economy.decision_cost',
      amount: 25,
      affordable: 'true',
      paymentEffects: [],
    });
    expect(
      inspectDecisionCost(scan, source('fund_plan'), {
        ...scenario,
        state: { ...scenario.state, political_power: 20 },
      }).affordable,
    ).toBe('false');
    expect(inspectDecisionCost(scan, source('fund_custom'), scenario)).toMatchObject({
      kind: 'custom',
      expression: 'treasury_cost',
      affordable: 'true',
      paymentEffects: [{ resource: 'variable.treasury', amount: 10, operation: 'subtract' }],
      unresolved: [],
    });
    expect(
      inspectDecisionCost(scan, source('fund_without_payment'), scenario).unresolved.map(
        ({ code }) => code,
      ),
    ).toContain('DECISION_COST_UNRESOLVED');
    const duplicate = inspectDecisionCost(scan, source('fund_twice'), scenario);
    expect(duplicate.paymentEffects).toHaveLength(2);
    expect(
      duplicate.unresolved.some(({ message }) => message.includes('Multiple direct payments')),
    ).toBe(true);
    const engineDuplicate = inspectDecisionCost(scan, source('fund_engine_twice'), scenario);
    expect(engineDuplicate.paymentEffects).toMatchObject([
      { resource: 'political_power', amount: 10, operation: 'subtract' },
    ]);
    expect(engineDuplicate.unresolved.some(({ message }) => message.includes('also has'))).toBe(
      true,
    );
  });

  it('reports cooldown, indefinite removal, and each mission outcome path without executing them', () => {
    const scan = snapshot();
    const decisions = decisionSourceInventory(scan).decisions;
    const source = (id: string) => decisions.find((decision) => decision.id === id)!;
    const scenario = { id: 'lifecycle', actor: 'GER', state: {}, closedFlags: true };
    expect(inspectDecisionLifecycle(scan, source('fund_plan'), scenario)).toMatchObject({
      kind: 'decision',
      fireOnlyOnce: false,
      cooldown: { expression: '60', days: 60 },
      removal: { expression: '-1', days: -1 },
      hasCompletionEffect: true,
      unresolved: [],
    });
    expect(inspectDecisionLifecycle(scan, source('clock'), scenario)).toMatchObject({
      kind: 'mission',
      selectableMission: false,
      missionTimeout: { expression: '30', days: 30 },
      hasActivation: true,
      hasCancellationTrigger: true,
      hasCancellationEffect: true,
      cancellationTrigger: { state: 'false', unresolved: [] },
      cancellationTriggerState: 'false',
      hasTimeoutEffect: true,
      ignoredMissionVisible: true,
      unresolved: [],
    });
    expect(inspectDecisionLifecycle(scan, source('timed_action'), scenario)).toMatchObject({
      removalTrigger: { state: 'false' },
      cancellationTrigger: { state: 'false' },
      cancelIfNotVisible: true,
      visibilityCancellation: 'true',
      cancellationTriggerState: 'true',
      unresolved: [],
    });
    expect(
      inspectDecisionLifecycle(scan, source('timed_action'), {
        ...scenario,
        flags: ['action_visible', 'action_removed'],
      }),
    ).toMatchObject({
      removalTrigger: { state: 'true' },
      cancellationTrigger: { state: 'false' },
      visibilityCancellation: 'false',
      cancellationTriggerState: 'false',
    });
  });
});
