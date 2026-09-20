import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { evaluateTriggerBlock } from '../core/condition-evaluator.js';
import type { ConditionSubject, TriState } from '../core/condition-model.js';
import {
  copyScenario,
  scenarioValue,
  setScenarioValue,
  type ScenarioState,
  type SharedScenario,
} from '../core/scenario-model.js';
import { resolveScopeContext, rootScopeContext } from '../core/scenario-state.js';
import {
  assignments,
  firstScalar,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
  type SourceEntry,
} from '../core/source/index.js';

export interface MechanicTrace {
  effect: string;
  path: string;
  scope: string;
  target?: string;
  status: 'applied' | 'skipped' | 'unresolved';
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface MechanicExecution {
  state: ScenarioState;
  trace: MechanicTrace[];
  unresolved: string[];
  complete: boolean;
}

export interface MechanicSource {
  id: string;
  path: string;
  block: BlockNode;
}

const MAX_OPERATIONS = 20_000;
const MAX_DEPTH = 32;
const MAX_ITERATION = 2_048;
const numericEffects = new Map<
  string,
  { key: string; mode: 'add' | 'set'; min?: number; max?: number }
>([
  ['add_political_power', { key: 'political_power', mode: 'add' }],
  ['set_political_power', { key: 'political_power', mode: 'set' }],
  ['add_manpower', { key: 'manpower', mode: 'add' }],
  ['add_stability', { key: 'stability', mode: 'add', min: 0, max: 1 }],
  ['add_war_support', { key: 'war_support', mode: 'add', min: 0, max: 1 }],
]);
const harmlessEffects = new Set(['hidden_effect', 'custom_effect_tooltip', 'log', 'tooltip']);

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function asText(value: AssignmentNode['value']): string | undefined {
  return value.type === 'scalar' ? value.value : undefined;
}

function entriesOnly(block: BlockNode): AssignmentNode[] | undefined {
  return block.entries.every((entry) => entry.type === 'assignment') ? block.entries : undefined;
}

function substitute(
  block: BlockNode,
  parameters: ReadonlyMap<string, string>,
): BlockNode | undefined {
  const missing = new Set<string>();
  const replace = (value: string): string =>
    value.replace(/\$([A-Za-z0-9_]+)\$/gu, (match, key: string) => {
      const found = parameters.get(key);
      if (found === undefined) {
        missing.add(key);
        return match;
      }
      return found;
    });
  const visit = (entry: SourceEntry): SourceEntry => {
    if (entry.type === 'scalar') return { ...entry, value: replace(entry.value) };
    if (entry.type === 'block') return { ...entry, entries: entry.entries.map(visit) };
    return {
      ...entry,
      key: { ...entry.key, value: replace(entry.key.value) },
      value:
        entry.value.type === 'scalar'
          ? { ...entry.value, value: replace(entry.value.value) }
          : { ...entry.value, entries: entry.value.entries.map(visit) },
    };
  };
  const result = { ...block, entries: block.entries.map(visit) };
  return missing.size > 0 ? undefined : result;
}

/**
 * A bounded source interpreter. It models declared state transitions, never a
 * campaign tick or an implicit on action. Unsupported operations taint state.
 */
export class MechanicInterpreter {
  private readonly state: ScenarioState;
  private readonly trace: MechanicTrace[] = [];
  private readonly unresolved: string[] = [];
  private readonly expiry = new Map<string, number>();
  private readonly localTargets = new Set<string>();
  private operations = 0;

  constructor(
    scenario: SharedScenario,
    private readonly definitions: ClausewitzEvaluationDefinitions,
    private readonly helpers: ReadonlyMap<string, MechanicSource>,
  ) {
    this.state = copyScenario(scenario);
  }

  result(): MechanicExecution {
    return {
      state: this.state,
      trace: this.trace,
      unresolved: this.unresolved,
      complete: this.unresolved.length === 0,
    };
  }

  advanceDays(days: number): void {
    if (!Number.isInteger(days) || days < 0 || days > 36_500)
      throw new RangeError('Explicit time advance must be between zero and 36500 days');
    this.state.day += days;
    for (const [key, expiry] of this.expiry) {
      if (expiry > this.state.day) continue;
      const [scope, flag] = key.split('|', 2);
      const flags = this.flags(scope!);
      if (flags !== undefined) {
        const index = flags.indexOf(flag!);
        if (index >= 0) flags.splice(index, 1);
      }
      this.expiry.delete(key);
    }
  }

  execute(source: MechanicSource, scope = 'ROOT'): void {
    this.block(source.block, source.path, scope, [], 0);
    for (const target of this.localTargets) delete this.state.scenario.eventTargets?.[target];
    this.localTargets.clear();
  }

  /** Apply a source-declared engine decision cost before complete_effect. */
  payDecisionCost(amount: number, path: string): void {
    const before = numeric(scenarioValue(this.state, 'political_power'));
    if (before === undefined || !Number.isFinite(amount) || amount < 0) {
      this.unknown('decision_cost', path, 'ROOT', 'Decision cost or balance is unknown');
      return;
    }
    if (before < amount) {
      this.note(
        'decision_cost',
        path,
        'ROOT',
        'skipped',
        before,
        before,
        'Political power is below the declared engine cost',
      );
      return;
    }
    const after = before - amount;
    setScenarioValue(this.state, 'political_power', after);
    this.note(
      'decision_cost',
      path,
      'ROOT',
      'applied',
      before,
      after,
      undefined,
      'political_power',
    );
  }

  skipDecision(path: string, reason: string): void {
    this.note('decision', path, 'ROOT', 'skipped', undefined, undefined, reason);
  }

  unresolvedDecision(path: string, reason: string): void {
    this.unknown('decision', path, 'ROOT', reason);
  }

  private flags(scope: string): string[] | undefined {
    if (scope === 'GLOBAL') return (this.state.scenario.globalFlags ??= []);
    if (scope === 'ROOT') return (this.state.scenario.flags ??= []);
    const binding = this.state.scenario.scopes?.[scope];
    if (binding === undefined) return undefined;
    return (binding.flags ??= []);
  }

  private note(
    effect: string,
    path: string,
    scope: string,
    status: MechanicTrace['status'],
    before?: unknown,
    after?: unknown,
    reason?: string,
    target?: string,
  ): void {
    this.trace.push({
      effect,
      path,
      scope,
      status,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(reason === undefined ? {} : { reason }),
      ...(target === undefined ? {} : { target }),
    });
    if (status === 'unresolved')
      this.unresolved.push(`${path}: ${effect}: ${reason ?? 'unresolved'}`);
  }

  private unknown(effect: string, path: string, scope: string, reason: string): void {
    this.state.unknown.add('*');
    this.note(effect, path, scope, 'unresolved', undefined, undefined, reason);
  }

  private number(
    expression: string,
    path: string,
    scope: string,
    seen = new Set<string>(),
  ): number | undefined {
    const literal = numeric(expression);
    if (literal !== undefined) return literal;
    if (seen.has(expression)) return undefined;
    seen.add(expression);
    if (expression.startsWith('constant:')) {
      const definition = this.definitions.scriptConstants.get(expression.slice(9));
      return definition === undefined
        ? undefined
        : this.number(definition.value, definition.file.displayPath, scope, seen);
    }
    if (expression.startsWith('@')) {
      const definition = this.definitions.localConstants.get(path)?.get(expression);
      return definition === undefined
        ? undefined
        : this.number(definition.value, definition.file.displayPath, scope, seen);
    }
    const dotted = /^(ROOT|THIS|FROM|PREV)\.(.+)$/iu.exec(expression);
    const targetScope =
      dotted?.[1]?.toUpperCase() === 'THIS' ? scope : (dotted?.[1]?.toUpperCase() ?? scope);
    const key = dotted?.[2] ?? expression;
    return (
      numeric(scenarioValue(this.state, key, targetScope)) ??
      numeric(scenarioValue(this.state, `variable.${key}`, targetScope))
    );
  }

  private mathExpression(block: BlockNode, path: string, scope: string): number | undefined {
    const entries = entriesOnly(block);
    if (entries === undefined || entries[0]?.key.value !== 'value') return undefined;
    const initial = asText(entries[0].value);
    let accumulator = initial === undefined ? undefined : this.number(initial, path, scope);
    for (const entry of entries.slice(1)) {
      if (accumulator === undefined) return undefined;
      const operator = entry.key.value;
      if (operator === 'round' && asText(entry.value) === 'yes') {
        accumulator = Math.round(accumulator);
        continue;
      }
      if (operator === 'clamp' && entry.value.type === 'block') {
        const minimum = firstScalar(entry.value, 'min')?.value;
        const maximum = firstScalar(entry.value, 'max')?.value;
        const min = minimum === undefined ? undefined : this.number(minimum, path, scope);
        const max = maximum === undefined ? undefined : this.number(maximum, path, scope);
        accumulator =
          min === undefined || max === undefined
            ? undefined
            : Math.max(min, Math.min(max, accumulator));
        continue;
      }
      const operandText = asText(entry.value);
      const operand = operandText === undefined ? undefined : this.number(operandText, path, scope);
      if (operand === undefined) return undefined;
      switch (operator) {
        case 'add':
          accumulator += operand;
          break;
        case 'subtract':
          accumulator -= operand;
          break;
        case 'multiply':
          accumulator *= operand;
          break;
        case 'divide':
          accumulator = operand === 0 ? undefined : accumulator / operand;
          break;
        case 'min':
          accumulator = Math.min(accumulator, operand);
          break;
        case 'max':
          accumulator = Math.max(accumulator, operand);
          break;
        default:
          return undefined;
      }
    }
    return accumulator;
  }

  private condition(block: BlockNode, path: string, scope: string, stack: string[]): TriState {
    const scenario = this.state.scenario;
    const subject: ConditionSubject = {
      id: 'mechanic',
      provenance: [{ path, rootKind: 'mod', loadOrder: 0, sourceHash: '' }],
    };
    let context = rootScopeContext(scenario);
    for (const previous of stack.filter((item) => item.startsWith('scope:'))) {
      context = resolveScopeContext(scenario, previous.slice(6), context) ?? context;
    }
    context = resolveScopeContext(scenario, scope, context) ?? context;
    return evaluateTriggerBlock(block, scenario, subject, this.definitions, [], context).state;
  }

  private block(
    block: BlockNode,
    path: string,
    scope: string,
    stack: string[],
    depth: number,
  ): void {
    if (depth > MAX_DEPTH) {
      this.unknown('depth', path, scope, 'Helper or scope depth limit reached');
      return;
    }
    const entries = entriesOnly(block);
    if (entries === undefined) {
      this.unknown('block', path, scope, 'Effect block has bare values or malformed entries');
      return;
    }
    let precedingBranch: TriState | undefined;
    for (const entry of entries) {
      if (++this.operations > MAX_OPERATIONS) {
        this.unknown('work', path, scope, 'Operation budget exceeded');
        return;
      }
      const key = entry.key.value;
      const child = entry.value.type === 'block' ? entry.value : undefined;
      if (key === 'else_if' || key === 'else') {
        if (precedingBranch === undefined) {
          this.unknown(key, path, scope, 'Branch has no preceding if');
          continue;
        }
        if (precedingBranch === 'true') {
          this.note(key, path, scope, 'skipped');
          continue;
        }
        if (precedingBranch === 'unresolved') {
          this.unknown(key, path, scope, 'Earlier branch eligibility is unresolved');
          continue;
        }
      } else precedingBranch = undefined;
      if (key === 'if' || key === 'else_if' || key === 'else') {
        if (child === undefined) {
          this.unknown(key, path, scope, 'Branch requires an effect block');
          continue;
        }
        const gate = assignments(child, 'limit')[0]?.value;
        const eligible =
          key === 'else'
            ? 'true'
            : gate?.type === 'block'
              ? this.condition(gate, path, scope, stack)
              : 'unresolved';
        precedingBranch = eligible;
        if (eligible === 'true')
          this.block(
            {
              ...child,
              entries: child.entries.filter(
                (item) => item.type !== 'assignment' || item.key.value !== 'limit',
              ),
            },
            path,
            scope,
            stack,
            depth + 1,
          );
        else if (eligible === 'false') this.note(key, path, scope, 'skipped');
        else this.unknown(key, path, scope, 'Branch eligibility is unresolved');
        continue;
      }
      this.effect(entry, path, scope, stack, depth);
    }
  }

  private effect(
    entry: AssignmentNode,
    path: string,
    scope: string,
    stack: string[],
    depth: number,
  ): void {
    const key = entry.key.value;
    const child = entry.value.type === 'block' ? entry.value : undefined;
    if (key === 'hidden_effect' && child !== undefined) {
      this.block(child, path, scope, stack, depth + 1);
      return;
    }
    if (key === 'meta_effect') {
      const template = child === undefined ? undefined : assignments(child, 'text')[0]?.value;
      if (child === undefined || template?.type !== 'block') {
        this.unknown(key, path, scope, 'Meta effect has no text block');
        return;
      }
      const parameters = new Map<string, string>();
      for (const item of assignments(child)) {
        if (item.key.value === 'text' || item.key.value === 'debug') continue;
        const raw = asText(item.value);
        if (raw === undefined) {
          this.unknown(key, path, scope, 'Meta parameter must be scalar');
          return;
        }
        const variable = /^\[\?([A-Za-z0-9_.]+)(?:\|\.0)?\]$/u.exec(raw);
        const resolved =
          variable === null ? raw : this.number(variable[1]!, path, scope)?.toString();
        if (resolved === undefined || !/^[A-Za-z0-9_.:+-]+$/u.test(resolved)) {
          this.unknown(key, path, scope, 'Meta parameter is unknown or not a safe token');
          return;
        }
        parameters.set(item.key.value, resolved);
      }
      const missing = new Set<string>();
      const replace = (value: string): string =>
        value.replace(/\[([A-Za-z0-9_]+)\]/gu, (match, token: string) => {
          const resolved = parameters.get(token);
          if (resolved === undefined) {
            missing.add(token);
            return match;
          }
          return resolved;
        });
      const visit = (item: SourceEntry): SourceEntry => {
        if (item.type === 'scalar') return { ...item, value: replace(item.value) };
        if (item.type === 'block') return { ...item, entries: item.entries.map(visit) };
        return {
          ...item,
          key: { ...item.key, value: replace(item.key.value) },
          value:
            item.value.type === 'scalar'
              ? { ...item.value, value: replace(item.value.value) }
              : { ...item.value, entries: item.value.entries.map(visit) },
        };
      };
      const expanded = { ...template, entries: template.entries.map(visit) };
      if (missing.size > 0) this.unknown(key, path, scope, 'Meta parameter is missing');
      else this.block(expanded, path, scope, stack, depth + 1);
      return;
    }
    if (
      key === 'ROOT' ||
      key === 'THIS' ||
      key === 'FROM' ||
      key === 'PREV' ||
      key.startsWith('event_target:')
    ) {
      const savedTarget = key.startsWith('event_target:')
        ? this.state.scenario.eventTargets?.[key.slice(13)]
        : undefined;
      const target =
        key === 'THIS'
          ? scope
          : key === 'PREV'
            ? stack.findLast((item) => item.startsWith('scope:'))?.slice(6)
            : key.startsWith('event_target:')
              ? savedTarget === this.state.scenario.actor
                ? 'ROOT'
                : Object.entries(this.state.scenario.scopes ?? {}).find(
                    ([, binding]) => binding.id === savedTarget,
                  )?.[0]
              : key;
      const found = target === 'ROOT' || this.state.scenario.scopes?.[target ?? ''] !== undefined;
      if (child === undefined || target === undefined || !found)
        this.unknown(key, path, scope, 'Scope is not declared');
      else this.block(child, path, target, [...stack, `scope:${scope}`], depth + 1);
      return;
    }
    if (key === 'for_each_scope_loop' || key === 'every_country') {
      if (child === undefined) {
        this.unknown(key, path, scope, 'Iterator requires a block');
        return;
      }
      const catalogId = key === 'every_country' ? 'countries' : firstScalar(child, 'array')?.value;
      const catalog =
        catalogId === undefined ? undefined : this.state.scenario.scopeCatalogs?.[catalogId];
      if (catalog === undefined || !catalog.complete || catalog.members.length > MAX_ITERATION) {
        this.unknown(key, path, scope, 'Finite complete scope catalog is required');
        return;
      }
      const body = {
        ...child,
        entries: child.entries.filter(
          (item) =>
            item.type !== 'assignment' || !['array', 'break', 'tooltip'].includes(item.key.value),
        ),
      };
      for (const member of catalog.members) {
        const binding = Object.entries(this.state.scenario.scopes ?? {}).find(
          ([, value]) => value.id === member,
        );
        if (binding === undefined) {
          this.unknown(key, path, scope, `Scope catalog member ${member} has no binding`);
          break;
        }
        this.block(body, path, binding[0], [...stack, `scope:${scope}`], depth + 1);
      }
      return;
    }
    if (
      [
        'set_variable',
        'add_to_variable',
        'subtract_from_variable',
        'multiply_variable',
        'divide_variable',
        'clamp_variable',
      ].includes(key)
    ) {
      if (child === undefined) {
        this.unknown(key, path, scope, 'Variable effect requires a block');
        return;
      }
      const short = assignments(child).find(
        (item) => !['var', 'value', 'min', 'max', 'tooltip'].includes(item.key.value),
      );
      const variable = firstScalar(child, 'var')?.value ?? short?.key.value;
      const expression =
        firstScalar(child, 'value')?.value ??
        (short === undefined ? undefined : asText(short.value));
      if (variable === undefined || expression === undefined) {
        if (variable === undefined || short?.value.type !== 'block') {
          this.unknown(key, path, scope, 'Variable and operand must resolve');
          return;
        }
      }
      const value =
        expression === undefined
          ? this.mathExpression(short!.value as BlockNode, path, scope)
          : this.number(expression, path, scope);
      const before = numeric(scenarioValue(this.state, variable, scope)) ?? 0;
      let after = value;
      if (value !== undefined && key === 'add_to_variable') after = before + value;
      if (value !== undefined && key === 'subtract_from_variable') after = before - value;
      if (value !== undefined && key === 'multiply_variable') after = before * value;
      if (value !== undefined && key === 'divide_variable')
        after = value === 0 ? undefined : before / value;
      if (value !== undefined && key === 'clamp_variable') {
        const minimum = firstScalar(child, 'min')?.value;
        const maximum = firstScalar(child, 'max')?.value;
        const min = minimum === undefined ? -Infinity : this.number(minimum, path, scope);
        const max = maximum === undefined ? Infinity : this.number(maximum, path, scope);
        after =
          min === undefined || max === undefined ? undefined : Math.max(min, Math.min(max, before));
      }
      setScenarioValue(this.state, variable, after, scope);
      this.note(
        key,
        path,
        scope,
        after === undefined ? 'unresolved' : 'applied',
        before,
        after,
        after === undefined ? 'Numeric operand is unknown or division by zero' : undefined,
        variable,
      );
      return;
    }
    if (
      key === 'set_country_flag' ||
      key === 'clr_country_flag' ||
      key === 'set_state_flag' ||
      key === 'clr_state_flag' ||
      key === 'set_global_flag' ||
      key === 'clr_global_flag'
    ) {
      const flag =
        asText(entry.value) ??
        (child === undefined ? undefined : firstScalar(child, 'flag')?.value);
      const flagScope = key.includes('global_flag') ? 'GLOBAL' : scope;
      const flags = this.flags(flagScope);
      if (flag === undefined || flags === undefined) {
        this.unknown(key, path, scope, 'Flag or scope is unresolved');
        return;
      }
      const before = flags.includes(flag);
      if (key.startsWith('set_') && !before) flags.push(flag);
      if (key.startsWith('clr_') && before) flags.splice(flags.indexOf(flag), 1);
      const days = child === undefined ? undefined : firstScalar(child, 'days')?.value;
      if (days !== undefined) {
        const duration = this.number(days, path, scope);
        if (duration === undefined) this.unknown(key, path, scope, 'Flag duration is unknown');
        else this.expiry.set(`${flagScope}|${flag}`, this.state.day + duration);
      }
      this.note(key, path, scope, 'applied', before, flags.includes(flag));
      return;
    }
    if (key === 'save_event_target_as' || key === 'save_global_event_target_as') {
      const target = asText(entry.value);
      if (target === undefined) this.unknown(key, path, scope, 'Target name is unresolved');
      else {
        (this.state.scenario.eventTargets ??= {})[target] =
          scope === 'ROOT'
            ? (this.state.scenario.actor ?? 'ROOT')
            : (this.state.scenario.scopes?.[scope]?.id ?? scope);
        if (key === 'save_event_target_as') this.localTargets.add(target);
        else this.localTargets.delete(target);
        this.note(key, path, scope, 'applied', undefined, this.state.scenario.eventTargets[target]);
      }
      return;
    }
    if (key === 'clear_global_event_target') {
      const target = asText(entry.value);
      if (target === undefined) this.unknown(key, path, scope, 'Target name is unresolved');
      else {
        delete this.state.scenario.eventTargets?.[target];
        this.note(key, path, scope, 'applied');
      }
      return;
    }
    if (key === 'add_to_array' || key === 'remove_from_array' || key === 'clear_array') {
      const short =
        child === undefined
          ? undefined
          : assignments(child).find(
              (item) => !['array', 'value', 'index'].includes(item.key.value),
            );
      const array =
        asText(entry.value) ??
        (child === undefined
          ? undefined
          : (firstScalar(child, 'array')?.value ?? short?.key.value));
      const expression =
        child === undefined
          ? undefined
          : (firstScalar(child, 'value')?.value ??
            (short === undefined ? undefined : asText(short.value)));
      const current = array === undefined ? undefined : scenarioValue(this.state, array, scope);
      if (array === undefined || (current !== undefined && !Array.isArray(current))) {
        this.unknown(key, path, scope, 'Array name or current array is unresolved');
        return;
      }
      const next = [...(current ?? [])];
      if (key === 'clear_array') next.length = 0;
      else {
        const numberValue =
          expression === undefined ? undefined : this.number(expression, path, scope);
        const value = numberValue ?? expression;
        if (value === undefined) {
          this.unknown(key, path, scope, 'Array element is unresolved');
          return;
        }
        if (key === 'add_to_array') {
          const index = child === undefined ? undefined : firstScalar(child, 'index')?.value;
          const position = index === undefined ? next.length : this.number(index, path, scope);
          if (
            position === undefined ||
            !Number.isInteger(position) ||
            position < 0 ||
            position > next.length
          ) {
            this.unknown(key, path, scope, 'Array index is unresolved');
            return;
          }
          next.splice(position, 0, value);
        } else {
          const index = next.indexOf(value);
          if (index >= 0) next.splice(index, 1);
        }
      }
      setScenarioValue(this.state, array, next, scope);
      this.note(key, path, scope, 'applied', current, next);
      return;
    }
    const balance = numericEffects.get(key);
    if (balance !== undefined) {
      const expression = asText(entry.value);
      const value = expression === undefined ? undefined : this.number(expression, path, scope);
      const before = numeric(scenarioValue(this.state, balance.key, scope));
      const after =
        value === undefined || (balance.mode === 'add' && before === undefined)
          ? undefined
          : balance.mode === 'set'
            ? value
            : before! + value;
      const bounded =
        after === undefined
          ? undefined
          : Math.max(balance.min ?? -Infinity, Math.min(balance.max ?? Infinity, after));
      setScenarioValue(this.state, balance.key, bounded, scope);
      this.note(
        key,
        path,
        scope,
        bounded === undefined ? 'unresolved' : 'applied',
        before,
        bounded,
        bounded === undefined ? 'Balance input is unknown' : undefined,
        balance.key,
      );
      return;
    }
    const helper = this.helpers.get(key);
    if (helper !== undefined && (child !== undefined || asText(entry.value) === 'yes')) {
      if (stack.includes(`helper:${key}`)) {
        this.unknown(key, path, scope, 'Scripted helper cycle');
        return;
      }
      const parameters = new Map<string, string>();
      for (const item of child === undefined ? [] : assignments(child)) {
        const value = asText(item.value);
        if (value === undefined) {
          this.unknown(key, path, scope, 'Scripted helper argument is not scalar');
          return;
        }
        parameters.set(item.key.value, value);
      }
      const expanded = substitute(helper.block, parameters);
      if (expanded === undefined)
        this.unknown(key, path, scope, 'Scripted helper parameter is missing');
      else this.block(expanded, helper.path, scope, [...stack, `helper:${key}`], depth + 1);
      return;
    }
    if (harmlessEffects.has(key)) {
      this.note(key, path, scope, 'skipped');
      return;
    }
    this.unknown(key, path, scope, 'Effect is outside the documented interpreter subset');
  }
}

export function parseMechanicBlock(text: string, path = 'fixture:mechanic.txt'): MechanicSource {
  const document = parseClausewitz(Buffer.from(`mechanic = { ${text} }`), path);
  const block = assignments(document.root, 'mechanic')[0]?.value;
  if (
    block?.type !== 'block' ||
    document.diagnostics.some(({ severity }) => severity === 'error' || severity === 'blocker')
  )
    throw new Error('Mechanic source block is invalid');
  return { id: 'mechanic', path, block };
}
