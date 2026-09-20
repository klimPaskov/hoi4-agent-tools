import { canonicalJson } from '../core/canonical.js';
import { scenarioValue, type ScenarioState } from '../core/scenario-model.js';
import type { MechanicAssertion } from '../schemas/scenarios.js';
import type { MechanicTrace } from './interpreter.js';

export interface AssertionResult {
  id: string;
  kind: MechanicAssertion['kind'];
  status: 'passed' | 'failed' | 'unresolved';
  observed?: unknown;
  reason?: string;
}

function value(state: ScenarioState, path: { scope: string; key: string }): unknown {
  return scenarioValue(state, path.key, path.scope);
}

function number(state: ScenarioState, path: { scope: string; key: string }): number | undefined {
  const found = value(state, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

function result(
  assertion: MechanicAssertion,
  status: AssertionResult['status'],
  observed?: unknown,
  reason?: string,
): AssertionResult {
  return {
    id: assertion.id,
    kind: assertion.kind,
    status,
    ...(observed === undefined ? {} : { observed }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function evaluateMechanicAssertions(
  assertions: readonly MechanicAssertion[],
  before: ScenarioState,
  after: ScenarioState,
  checkpoints: readonly ScenarioState[],
  trace: readonly MechanicTrace[],
): AssertionResult[] {
  return assertions.map((assertion) => {
    if (before.unknown.has('*') || after.unknown.has('*'))
      return result(
        assertion,
        'unresolved',
        undefined,
        'An unsupported effect may write this state',
      );
    if (assertion.kind === 'equals' || assertion.kind === 'end_state') {
      const found = value(after, assertion.path);
      if (found === undefined)
        return result(assertion, 'unresolved', undefined, 'End-state value is unknown');
      return result(assertion, found === assertion.expected ? 'passed' : 'failed', found);
    }
    if (assertion.kind === 'conservation') {
      const starting = assertion.paths.map((path) => number(before, path));
      const ending = assertion.paths.map((path) => number(after, path));
      if ([...starting, ...ending].some((item) => item === undefined))
        return result(
          assertion,
          'unresolved',
          undefined,
          'Conserved values must be declared numbers',
        );
      const initial = (starting as number[]).reduce((sum, item) => sum + item, 0);
      const final = (ending as number[]).reduce((sum, item) => sum + item, 0);
      return result(
        assertion,
        Math.abs(initial - final) <= assertion.tolerance ? 'passed' : 'failed',
        { initial, final, difference: final - initial },
      );
    }
    if (assertion.kind === 'array_alignment') {
      const arrays = assertion.paths.map((path) => value(after, path));
      if (arrays.some((item) => !Array.isArray(item)))
        return result(
          assertion,
          'unresolved',
          undefined,
          'All aligned values must be declared arrays',
        );
      const lengths = (arrays as unknown[][]).map((array) => array.length);
      return result(
        assertion,
        lengths.every((length) => length === lengths[0]) ? 'passed' : 'failed',
        lengths,
      );
    }
    if (assertion.kind === 'affordability') {
      const available = number(before, assertion.balance);
      return available === undefined
        ? result(assertion, 'unresolved', undefined, 'Starting balance is unknown')
        : result(assertion, available >= assertion.cost ? 'passed' : 'failed', {
            available,
            cost: assertion.cost,
          });
    }
    if (assertion.kind === 'single_payment') {
      const starting = number(before, assertion.balance);
      const ending = number(after, assertion.balance);
      const reductions = trace.flatMap((step) =>
        step.status === 'applied' &&
        step.scope === assertion.balance.scope &&
        step.target === assertion.balance.key &&
        typeof step.before === 'number' &&
        typeof step.after === 'number' &&
        step.before > step.after
          ? [step.before - step.after]
          : [],
      );
      return starting === undefined || ending === undefined
        ? result(assertion, 'unresolved', undefined, 'Payment balance is unknown')
        : result(
            assertion,
            reductions.length === 1 &&
              reductions[0] === assertion.cost &&
              starting - ending === assertion.cost
              ? 'passed'
              : 'failed',
            {
              paid: starting - ending,
              expected: assertion.cost,
              deductions: reductions,
            },
          );
    }
    if (assertion.kind === 'repeated_setup') {
      const first = checkpoints[assertion.firstStep];
      const second = checkpoints[assertion.secondStep];
      if (
        first === undefined ||
        second === undefined ||
        first.unknown.size > 0 ||
        second.unknown.size > 0
      )
        return result(
          assertion,
          'unresolved',
          undefined,
          'Repeated setup checkpoints are unavailable',
        );
      return result(
        assertion,
        canonicalJson(first.scenario) === canonicalJson(second.scenario) ? 'passed' : 'failed',
        { firstStep: assertion.firstStep, secondStep: assertion.secondStep },
      );
    }
    if (assertion.kind === 'exclusive_flags') {
      const flags =
        assertion.scope === 'GLOBAL'
          ? after.scenario.globalFlags
          : assertion.scope === 'ROOT'
            ? after.scenario.flags
            : after.scenario.scopes?.[assertion.scope]?.flags;
      if (flags === undefined)
        return result(assertion, 'unresolved', undefined, 'Flag scope is undeclared');
      const active = assertion.flags.filter((flag) => flags.includes(flag));
      return result(assertion, active.length <= 1 ? 'passed' : 'failed', active);
    }
    const flags =
      assertion.scope === 'GLOBAL'
        ? after.scenario.globalFlags
        : assertion.scope === 'ROOT'
          ? after.scenario.flags
          : after.scenario.scopes?.[assertion.scope]?.flags;
    const targets =
      assertion.scope === 'ROOT'
        ? after.scenario.eventTargets
        : after.scenario.scopes?.[assertion.scope]?.eventTargets;
    if (flags === undefined && assertion.flags.length > 0)
      return result(assertion, 'unresolved', undefined, 'Cleanup flag scope is undeclared');
    const lingeringFlags = assertion.flags.filter((flag) => flags?.includes(flag));
    const lingeringTargets = assertion.targets.filter((target) => targets?.[target] !== undefined);
    return result(
      assertion,
      lingeringFlags.length === 0 && lingeringTargets.length === 0 ? 'passed' : 'failed',
      { lingeringFlags, lingeringTargets },
    );
  });
}
