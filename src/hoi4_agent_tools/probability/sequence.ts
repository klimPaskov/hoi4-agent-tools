import { canonicalJson } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import type {
  CustomPoolAction,
  CustomWeightedPoolManifest,
  ProbabilityScenario,
  ProbabilityUnresolved,
  ScenarioValue,
  SequenceSummary,
} from './model.js';
import { DeterministicRandom } from './simulation.js';

interface CandidateState {
  id: string;
  category?: string;
  weight: number;
  cap?: number;
  active: boolean;
  oneTime: boolean;
  cooldownDays: number;
  cooldownUntil: number;
}

interface SequenceState {
  day: number;
  step: number;
  values: Record<string, ScenarioValue>;
  candidates: CandidateState[];
  timerMinDays: number;
  timerMaxDays: number;
  terminal: boolean;
  selectedIds: string[];
  selectionDays: Record<string, number[]>;
}

interface WeightedState {
  state: SequenceState;
  probability: number;
}

interface Aggregate {
  selections: number[];
  ever: number[];
  terminal: number;
  timeline: SequenceSummary['timeline'];
}

const EXACT_STATE_LIMIT = 5_000;
const BEAM_STATE_LIMIT = 5_000;

function recordSequenceIssue(
  unresolved: ProbabilityUnresolved[],
  issue: ProbabilityUnresolved,
): void {
  if (
    unresolved.some(
      (existing) =>
        existing.code === issue.code &&
        existing.path === issue.path &&
        existing.candidateId === issue.candidateId &&
        existing.message === issue.message,
    )
  )
    return;
  unresolved.push(issue);
}

function pathValue(
  state: SequenceState,
  path: string,
  selected?: CandidateState,
): ScenarioValue | undefined {
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'selected.id') return selected?.id;
  if (path === 'selected.category') return selected?.category;
  if (path === 'selected.one_time') return selected?.oneTime;
  if (path.startsWith('selected.')) return undefined;
  if (path.startsWith('state.')) return state.values[path.slice('state.'.length)];
  if (path.startsWith('candidate.')) {
    const parts = path.split('.');
    const candidate = state.candidates.find(({ id }) => id === parts[1]);
    if (candidate === undefined) return undefined;
    if (parts[2] === 'weight') return candidate.weight;
    if (parts[2] === 'cap') return candidate.cap;
    if (parts[2] === 'active') return candidate.active;
  }
  if (path === 'selection.timer_min_days') return state.timerMinDays;
  if (path === 'selection.timer_max_days') return state.timerMaxDays;
  if (Object.hasOwn(state.values, path)) return state.values[path];
  return undefined;
}

interface Token {
  kind: 'number' | 'identifier' | 'operator' | 'left' | 'right';
  text: string;
}

function tokenize(expression: string): Token[] | undefined {
  const output: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    if (/\s/u.test(expression[index]!)) {
      index += 1;
      continue;
    }
    const rest = expression.slice(index);
    const number = /^-?\d+(?:\.\d+)?/u.exec(rest)?.[0];
    if (number !== undefined) {
      output.push({ kind: 'number', text: number });
      index += number.length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/u.exec(rest)?.[0];
    if (identifier !== undefined) {
      output.push({ kind: 'identifier', text: identifier });
      index += identifier.length;
      continue;
    }
    const operator = /^(?:==|!=|<=|>=|[+*/<>-])/u.exec(rest)?.[0];
    if (operator !== undefined) {
      output.push({ kind: 'operator', text: operator });
      index += operator.length;
      continue;
    }
    if (rest.startsWith('(') || rest.startsWith(')')) {
      output.push({
        kind: rest.startsWith('(') ? 'left' : 'right',
        text: rest.startsWith('(') ? '(' : ')',
      });
      index += 1;
      continue;
    }
    return undefined;
  }
  return output;
}

class ArithmeticParser {
  private index = 0;

  public constructor(
    private readonly tokens: Token[],
    private readonly state: SequenceState,
    private readonly selected?: CandidateState,
  ) {}

  public parse(): number | undefined {
    const result = this.sum();
    return this.index === this.tokens.length ? result : undefined;
  }

  private sum(): number | undefined {
    let left = this.product();
    while (left !== undefined && ['+', '-'].includes(this.tokens[this.index]?.text ?? '')) {
      const operation = this.tokens[this.index++]!.text;
      const right = this.product();
      if (right === undefined) return undefined;
      left = operation === '+' ? left + right : left - right;
    }
    return left;
  }

  private product(): number | undefined {
    let left = this.primary();
    while (left !== undefined && ['*', '/'].includes(this.tokens[this.index]?.text ?? '')) {
      const operation = this.tokens[this.index++]!.text;
      const right = this.primary();
      if (right === undefined || (operation === '/' && right === 0)) return undefined;
      left = operation === '*' ? left * right : left / right;
    }
    return left;
  }

  private primary(): number | undefined {
    const token = this.tokens[this.index];
    if (token === undefined) return undefined;
    if (token.kind === 'number') {
      this.index += 1;
      return Number(token.text);
    }
    if (token.kind === 'identifier' && ['floor', 'ceil', 'round'].includes(token.text)) {
      this.index += 1;
      if (this.tokens[this.index++]?.kind !== 'left') return undefined;
      const value = this.sum();
      if (this.tokens[this.index++]?.kind !== 'right' || value === undefined) return undefined;
      return token.text === 'floor'
        ? Math.floor(value)
        : token.text === 'ceil'
          ? Math.ceil(value)
          : Math.round(value);
    }
    if (token.kind === 'identifier') {
      this.index += 1;
      const value = pathValue(this.state, token.text, this.selected);
      return typeof value === 'number' ? value : undefined;
    }
    if (token.kind === 'left') {
      this.index += 1;
      const value = this.sum();
      if (this.tokens[this.index++]?.kind !== 'right') return undefined;
      return value;
    }
    return undefined;
  }
}

function numberExpression(
  value: number | string | boolean | null | undefined,
  state: SequenceState,
  selected?: CandidateState,
): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const tokens = tokenize(value);
  return tokens === undefined ? undefined : new ArithmeticParser(tokens, state, selected).parse();
}

function condition(
  expression: string,
  state: SequenceState,
  selected?: CandidateState,
): boolean | undefined {
  const source = expression.trim();
  if (source === 'true') return true;
  if (source === 'false') return false;
  if (source.startsWith('not ')) {
    const value = condition(source.slice(4), state, selected);
    return value === undefined ? undefined : !value;
  }
  const booleanParts = /^(.*?)\s+(and|or)\s+(.*)$/u.exec(source);
  if (booleanParts !== null) {
    const left = condition(booleanParts[1]!, state, selected);
    const right = condition(booleanParts[3]!, state, selected);
    if (left === undefined || right === undefined) return undefined;
    return booleanParts[2] === 'and' ? left && right : left || right;
  }
  if (/^selected\.[A-Za-z0-9_]+$/u.test(source)) {
    const simple = pathValue(state, source, selected);
    if (typeof simple === 'boolean') return simple;
    return state.selectedIds.includes(source.slice('selected.'.length));
  }
  const comparison = /^(.*?)\s*(==|!=|<=|>=|<|>)\s*(.*?)$/u.exec(source);
  if (comparison !== null) {
    const leftPath = comparison[1]!.trim();
    const rightSource = comparison[3]!.trim();
    const left =
      pathValue(state, leftPath, selected) ?? numberExpression(leftPath, state, selected);
    const right =
      pathValue(state, rightSource, selected) ??
      numberExpression(rightSource, state, selected) ??
      rightSource;
    if (left === undefined) return undefined;
    if (comparison[2] === '==') return left === right;
    if (comparison[2] === '!=') return left !== right;
    if (typeof left !== 'number' || typeof right !== 'number') return undefined;
    if (comparison[2] === '<') return left < right;
    if (comparison[2] === '>') return left > right;
    if (comparison[2] === '<=') return left <= right;
    return left >= right;
  }
  const value = pathValue(state, source, selected);
  return typeof value === 'boolean' ? value : undefined;
}

function cloneState(state: SequenceState): SequenceState {
  return {
    ...state,
    values: { ...state.values },
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
    selectedIds: [...state.selectedIds],
    selectionDays: Object.fromEntries(
      Object.entries(state.selectionDays).map(([id, days]) => [id, [...days]]),
    ),
  };
}

function targetCandidate(
  state: SequenceState,
  target: string,
  selected?: CandidateState,
): CandidateState | undefined {
  if (target === 'selected.candidate') return selected;
  if (!target.startsWith('candidate.')) return undefined;
  return state.candidates.find(({ id }) => id === target.split('.')[1]);
}

function rounded(value: number, mode: CustomWeightedPoolManifest['selection']['rounding']): number {
  if (mode === 'floor') return Math.floor(value);
  if (mode === 'ceil') return Math.ceil(value);
  if (mode === 'nearest') return Math.round(value);
  return value;
}

function applyAction(
  state: SequenceState,
  manifest: CustomWeightedPoolManifest,
  action: CustomPoolAction,
  selected: CandidateState | undefined,
  unresolved: ProbabilityUnresolved[],
): void {
  const value = numberExpression(action.value, state, selected);
  if (action.operation === 'terminate') {
    state.terminal = true;
    return;
  }
  if (action.operation === 'remove') {
    const candidate = targetCandidate(state, action.target, selected);
    if (candidate !== undefined) candidate.active = false;
    else
      recordSequenceIssue(unresolved, {
        code: 'SEQUENCE_TARGET_UNRESOLVED',
        message: `Cannot remove ${action.target}`,
        path: action.target,
      });
    return;
  }
  if (action.operation === 'reset_category') {
    const category = action.target.replace(/^category\./u, '');
    for (const candidate of state.candidates.filter(({ category: id }) => id === category))
      candidate.weight = rounded(value ?? 0, manifest.selection.rounding);
    return;
  }
  if (action.operation === 'reset_timer') {
    state.timerMinDays = manifest.selection.timerMinDays ?? 0;
    state.timerMaxDays = manifest.selection.timerMaxDays ?? state.timerMinDays;
    return;
  }
  if (action.operation === 'compress_timer') {
    if (value === undefined) {
      recordSequenceIssue(unresolved, {
        code: 'SEQUENCE_VALUE_UNRESOLVED',
        message: `Cannot resolve ${String(action.value)}`,
        path: action.target,
      });
      return;
    }
    state.timerMaxDays = rounded(
      Math.max(state.timerMinDays, state.timerMaxDays - value),
      manifest.selection.rounding,
    );
    return;
  }
  const candidate = targetCandidate(state, action.target, selected);
  const field = action.target.split('.').at(-1);
  if (action.operation === 'cooldown') {
    if (candidate !== undefined && value !== undefined) candidate.cooldownUntil = state.day + value;
    else
      recordSequenceIssue(unresolved, {
        code: 'SEQUENCE_VALUE_UNRESOLVED',
        message: `Cannot apply cooldown ${action.target}`,
        path: action.target,
      });
    return;
  }
  if (value === undefined) {
    recordSequenceIssue(unresolved, {
      code: 'SEQUENCE_VALUE_UNRESOLVED',
      message: `Cannot resolve ${String(action.value)}`,
      path: action.target,
    });
    return;
  }
  if (action.target.startsWith('state.')) {
    const key = action.target.slice('state.'.length);
    const current = typeof state.values[key] === 'number' ? state.values[key] : 0;
    state.values[key] =
      action.operation === 'set'
        ? value
        : action.operation === 'add'
          ? current + value
          : action.operation === 'multiply'
            ? current * value
            : Math.min(current, value);
    return;
  }
  if (candidate !== undefined && (field === 'weight' || field === 'cap')) {
    const current = field === 'weight' ? candidate.weight : (candidate.cap ?? Infinity);
    const next =
      action.operation === 'set'
        ? value
        : action.operation === 'add'
          ? current + value
          : action.operation === 'multiply'
            ? current * value
            : Math.min(current, value);
    if (field === 'weight') candidate.weight = rounded(next, manifest.selection.rounding);
    else candidate.cap = rounded(next, manifest.selection.rounding);
    return;
  }
  recordSequenceIssue(unresolved, {
    code: 'SEQUENCE_TARGET_UNRESOLVED',
    message: `Cannot update ${action.target}`,
    path: action.target,
  });
}

function cadenceDays(manifest: CustomWeightedPoolManifest, state: SequenceState): number[] {
  if (manifest.selection.cadence === 'daily') return [1];
  if (manifest.selection.cadence === 'weekly') return [7];
  if (manifest.selection.cadence === 'monthly') return [30];
  const min = Math.ceil(state.timerMinDays);
  const max = Math.floor(state.timerMaxDays);
  if (max < min) return [Math.max(0, state.timerMinDays)];
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function applyRecovery(
  state: SequenceState,
  manifest: CustomWeightedPoolManifest,
  elapsed: number,
  unresolved: ProbabilityUnresolved[],
): void {
  for (const recovery of manifest.recovery ?? []) {
    const period = recovery.cadence === 'daily' ? 1 : recovery.cadence === 'weekly' ? 7 : 30;
    const occurrences = Math.floor(elapsed / period);
    if (occurrences <= 0) continue;
    const candidate = targetCandidate(state, recovery.target);
    const amount = numberExpression(recovery.amount, state);
    if (candidate === undefined || amount === undefined) {
      recordSequenceIssue(unresolved, {
        code: 'SEQUENCE_RECOVERY_UNRESOLVED',
        message: `Cannot resolve recovery ${recovery.target}`,
        path: recovery.target,
      });
      continue;
    }
    candidate.weight += amount * occurrences;
    const cap = recovery.cap === undefined ? candidate.cap : numberExpression(recovery.cap, state);
    if (cap !== undefined) candidate.weight = Math.min(candidate.weight, cap);
    candidate.weight = rounded(candidate.weight, manifest.selection.rounding);
  }
}

function eligibleCandidates(
  state: SequenceState,
  manifest: CustomWeightedPoolManifest,
  unresolved: ProbabilityUnresolved[],
): CandidateState[] {
  return state.candidates.filter((candidate) => {
    if (!candidate.active || candidate.cooldownUntil > state.day) return false;
    if (candidate.weight <= 0) return false;
    const expression = manifest.candidates.find(({ id }) => id === candidate.id)?.eligibleWhen;
    if (expression === undefined) return true;
    const result = condition(expression, state, candidate);
    if (result === undefined)
      recordSequenceIssue(unresolved, {
        code: 'SEQUENCE_ELIGIBILITY_UNRESOLVED',
        message: `Cannot resolve eligibility ${expression}`,
        candidateId: candidate.id,
      });
    return result === true;
  });
}

function selectionBranches(
  state: SequenceState,
  manifest: CustomWeightedPoolManifest,
  unresolved: ProbabilityUnresolved[],
): Array<{ selected: CandidateState[]; probability: number }> {
  const eligible = eligibleCandidates(state, manifest, unresolved);
  if (manifest.selection.mode === 'categorical_weighted') {
    const total = eligible.reduce((sum, candidate) => sum + candidate.weight, 0);
    return total <= 0
      ? [{ selected: [], probability: 1 }]
      : eligible.map((selected) => ({
          selected: [selected],
          probability: selected.weight / total,
        }));
  }
  if (eligible.length > 20) {
    recordSequenceIssue(unresolved, {
      code: 'SEQUENCE_INDEPENDENT_COMBINATION_LIMIT',
      message:
        'Independent custom pools above 20 eligible candidates require Monte Carlo sequence analysis',
    });
    return [{ selected: [], probability: 1 }];
  }
  const branches: Array<{ selected: CandidateState[]; probability: number }> = [];
  const combinations = 2 ** eligible.length;
  for (let mask = 0; mask < combinations; mask += 1) {
    const selected: CandidateState[] = [];
    let probability = 1;
    for (const [index, candidate] of eligible.entries()) {
      const chance = Math.max(0, Math.min(1, candidate.weight / 100));
      if ((mask & (2 ** index)) !== 0) {
        selected.push(candidate);
        probability *= chance;
      } else probability *= 1 - chance;
    }
    if (probability > 0) branches.push({ selected, probability });
  }
  return branches;
}

function advance(
  state: SequenceState,
  manifest: CustomWeightedPoolManifest,
  selectedCandidates: readonly CandidateState[],
  unresolved: ProbabilityUnresolved[],
): SequenceState {
  const next = cloneState(state);
  next.step += 1;
  const actualSelections = selectedCandidates.flatMap((selected) => {
    const candidate = next.candidates.find(({ id }) => id === selected.id);
    return candidate === undefined ? [] : [candidate];
  });
  const transitionSubjects: Array<CandidateState | undefined> =
    actualSelections.length === 0 ? [undefined] : actualSelections;
  for (const actualSelected of actualSelections) {
    next.selectedIds.push(actualSelected.id);
    (next.selectionDays[actualSelected.id] ??= []).push(next.day);
    if (actualSelected.cooldownDays > 0)
      actualSelected.cooldownUntil = next.day + actualSelected.cooldownDays;
  }
  for (const actualSelected of transitionSubjects) {
    for (const transition of manifest.transitions) {
      const applies = condition(transition.when, next, actualSelected);
      if (applies === undefined) {
        recordSequenceIssue(unresolved, {
          code: 'SEQUENCE_TRANSITION_UNRESOLVED',
          message: `Cannot resolve transition ${transition.when}`,
        });
        continue;
      }
      if (!applies) continue;
      for (const action of transition.actions)
        applyAction(next, manifest, action, actualSelected, unresolved);
    }
    if (actualSelected?.oneTime === true) actualSelected.active = false;
  }
  return next;
}

function initialState(
  manifest: CustomWeightedPoolManifest,
  scenario: ProbabilityScenario,
): SequenceState {
  const candidateIds = new Set<string>();
  const candidates = manifest.candidates.map((candidate) => {
    if (candidateIds.has(candidate.id))
      throw new ServiceError(
        'SEQUENCE_CANDIDATE_DUPLICATE',
        'Custom pool candidate IDs must be unique',
        { id: candidate.id },
      );
    candidateIds.add(candidate.id);
    const weight =
      typeof candidate.weight === 'number' ? candidate.weight : Number(candidate.weight);
    const cap =
      candidate.cap === undefined
        ? undefined
        : typeof candidate.cap === 'number'
          ? candidate.cap
          : Number(candidate.cap);
    if (!Number.isFinite(weight) || (cap !== undefined && !Number.isFinite(cap)))
      throw new ServiceError(
        'SEQUENCE_INITIAL_VALUE_INVALID',
        'Initial custom pool weights and caps must resolve numerically',
        { id: candidate.id },
      );
    return {
      id: candidate.id,
      ...(candidate.category === undefined ? {} : { category: candidate.category }),
      weight: rounded(weight, manifest.selection.rounding),
      ...(cap === undefined ? {} : { cap: rounded(cap, manifest.selection.rounding) }),
      active: true,
      oneTime: candidate.oneTime ?? false,
      cooldownDays: candidate.cooldownDays ?? 0,
      cooldownUntil: 0,
    };
  });
  return {
    day: 0,
    step: 0,
    values: { ...(manifest.state ?? {}), ...scenario.state },
    candidates,
    timerMinDays: manifest.selection.timerMinDays ?? 0,
    timerMaxDays: manifest.selection.timerMaxDays ?? manifest.selection.timerMinDays ?? 0,
    terminal: false,
    selectedIds: [],
    selectionDays: {},
  };
}

function stateKey(state: SequenceState): string {
  return canonicalJson(state);
}

function addAggregate(
  aggregate: Aggregate,
  state: SequenceState,
  probability: number,
  manifest: CustomWeightedPoolManifest,
): void {
  if (state.terminal) aggregate.terminal += probability;
  for (const [index, candidate] of manifest.candidates.entries()) {
    const selections = state.selectedIds.filter((id) => id === candidate.id).length;
    aggregate.selections[index]! += selections * probability;
    if (selections > 0) aggregate.ever[index]! += probability;
  }
}

function leadingCandidate(
  aggregate: Aggregate,
  manifest: CustomWeightedPoolManifest,
): string | undefined {
  let index = -1;
  let maximum = 0;
  for (const [candidateIndex, selections] of aggregate.selections.entries()) {
    if (selections > maximum) {
      maximum = selections;
      index = candidateIndex;
    }
  }
  return index < 0 ? undefined : manifest.candidates[index]?.id;
}

function exactSequence(
  manifest: CustomWeightedPoolManifest,
  scenario: ProbabilityScenario,
  horizonDays: number,
  maxSteps: number,
  signal: AbortSignal | undefined,
  unresolved: ProbabilityUnresolved[],
): SequenceSummary {
  let distribution = new Map<string, WeightedState>();
  const start = initialState(manifest, scenario);
  distribution.set(stateKey(start), { state: start, probability: 1 });
  const aggregate: Aggregate = {
    selections: manifest.candidates.map(() => 0),
    ever: manifest.candidates.map(() => 0),
    terminal: 0,
    timeline: [],
  };
  let method: SequenceSummary['method'] = 'exact_state_distribution';
  let omittedProbability = 0;
  let completedSteps = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    signal?.throwIfAborted();
    const next = new Map<string, WeightedState>();
    let active = false;
    for (const { state, probability } of distribution.values()) {
      if (state.terminal || state.day >= horizonDays) {
        const key = stateKey(state);
        const existing = next.get(key);
        next.set(key, { state, probability: probability + (existing?.probability ?? 0) });
        continue;
      }
      active = true;
      const days = cadenceDays(manifest, state);
      for (const elapsed of days) {
        const elapsedProbability = probability / days.length;
        const selectionState = cloneState(state);
        const actualElapsed = Math.min(elapsed, horizonDays - state.day);
        selectionState.day += actualElapsed;
        applyRecovery(selectionState, manifest, actualElapsed, unresolved);
        if (elapsed > horizonDays - state.day) {
          const key = stateKey(selectionState);
          const existing = next.get(key);
          next.set(key, {
            state: selectionState,
            probability: elapsedProbability + (existing?.probability ?? 0),
          });
          continue;
        }
        const selections = selectionBranches(selectionState, manifest, unresolved);
        for (const selection of selections) {
          const advanced = advance(selectionState, manifest, selection.selected, unresolved);
          const branchProbability = elapsedProbability * selection.probability;
          const key = stateKey(advanced);
          const existing = next.get(key);
          next.set(key, {
            state: advanced,
            probability: branchProbability + (existing?.probability ?? 0),
          });
        }
      }
    }
    distribution = next;
    completedSteps = step + 1;
    if (distribution.size > EXACT_STATE_LIMIT) {
      method = 'bounded_beam';
      const ordered = [...distribution.values()].sort(
        (left, right) => right.probability - left.probability,
      );
      const retained = ordered.slice(0, BEAM_STATE_LIMIT);
      omittedProbability += ordered
        .slice(BEAM_STATE_LIMIT)
        .reduce((sum, item) => sum + item.probability, 0);
      distribution = new Map(retained.map((item) => [stateKey(item.state), item]));
    }
    const snapshot: Aggregate = {
      selections: manifest.candidates.map(() => 0),
      ever: manifest.candidates.map(() => 0),
      terminal: 0,
      timeline: [],
    };
    for (const item of distribution.values())
      addAggregate(snapshot, item.state, item.probability, manifest);
    const currentLeader = leadingCandidate(snapshot, manifest);
    aggregate.timeline.push({
      step: step + 1,
      day: Math.max(...[...distribution.values()].map(({ state }) => state.day), 0),
      ...(currentLeader === undefined ? {} : { leadingCandidate: currentLeader }),
      terminalProbability: snapshot.terminal,
    });
    if (!active) break;
  }
  for (const item of distribution.values())
    addAggregate(aggregate, item.state, item.probability, manifest);
  const pathProbabilities = new Map<
    string,
    { candidateIds: string[]; probability: number; terminal: boolean; endDay: number }
  >();
  const countDistributions = manifest.candidates.map(() => new Map<number, number>());
  const categoryIds = [
    ...new Set(
      manifest.candidates.flatMap(({ category }) => (category === undefined ? [] : [category])),
    ),
  ].sort();
  const categoryNext = new Map(categoryIds.map((category) => [category, 0]));
  const categoryEver = new Map(categoryIds.map((category) => [category, 0]));
  const categoryFirstDayTotals = new Map(categoryIds.map((category) => [category, 0]));
  const nextSelectionProbabilities = manifest.candidates.map(() => 0);
  const firstDayTotals = manifest.candidates.map(() => 0);
  for (const item of distribution.values()) {
    const pathKey = canonicalJson(item.state.selectedIds);
    const path = pathProbabilities.get(pathKey);
    if (path === undefined)
      pathProbabilities.set(pathKey, {
        candidateIds: [...item.state.selectedIds],
        probability: item.probability,
        terminal: item.state.terminal,
        endDay: item.state.day,
      });
    else {
      path.probability += item.probability;
      path.terminal = path.terminal || item.state.terminal;
      path.endDay = Math.max(path.endDay, item.state.day);
    }
    for (const [index, candidate] of manifest.candidates.entries()) {
      const count = item.state.selectedIds.filter((id) => id === candidate.id).length;
      countDistributions[index]!.set(
        count,
        (countDistributions[index]!.get(count) ?? 0) + item.probability,
      );
      if (item.state.selectedIds[0] === candidate.id)
        nextSelectionProbabilities[index]! += item.probability;
      const firstDay = item.state.selectionDays[candidate.id]?.[0];
      if (firstDay !== undefined) firstDayTotals[index]! += firstDay * item.probability;
    }
    const firstSelected = manifest.candidates.find(({ id }) => id === item.state.selectedIds[0]);
    if (firstSelected?.category !== undefined)
      categoryNext.set(
        firstSelected.category,
        categoryNext.get(firstSelected.category)! + item.probability,
      );
    for (const category of categoryIds) {
      const categoryCandidates = manifest.candidates.filter(
        (candidate) => candidate.category === category,
      );
      const firstDays = categoryCandidates.flatMap(({ id }) => {
        const day = item.state.selectionDays[id]?.[0];
        return day === undefined ? [] : [day];
      });
      if (firstDays.length === 0) continue;
      categoryEver.set(category, categoryEver.get(category)! + item.probability);
      categoryFirstDayTotals.set(
        category,
        categoryFirstDayTotals.get(category)! + Math.min(...firstDays) * item.probability,
      );
    }
  }
  return {
    scenarioId: scenario.id,
    method,
    steps: completedSteps,
    terminalProbability: aggregate.terminal,
    stateCount: distribution.size,
    ...(omittedProbability > 0 ? { omittedProbability } : {}),
    candidates: manifest.candidates.map((candidate, index) => ({
      id: candidate.id,
      expectedSelections: aggregate.selections[index]!,
      everSelectedProbability: aggregate.ever[index]!,
      nextSelectionProbability: nextSelectionProbabilities[index]!,
      starvationProbability: Math.max(0, 1 - aggregate.ever[index]!),
      ...(aggregate.ever[index]! <= 0
        ? {}
        : { expectedFirstSelectionDay: firstDayTotals[index]! / aggregate.ever[index]! }),
      countDistribution: [...countDistributions[index]!.entries()]
        .sort(([left], [right]) => left - right)
        .map(([count, probability]) => ({ count, probability })),
    })),
    categories: categoryIds.map((category) => {
      const candidateIndexes = manifest.candidates.flatMap((candidate, index) =>
        candidate.category === category ? [index] : [],
      );
      const everSelectedProbability = categoryEver.get(category)!;
      return {
        id: category,
        nextSelectionProbability: categoryNext.get(category)!,
        expectedSelections: candidateIndexes.reduce(
          (sum, index) => sum + aggregate.selections[index]!,
          0,
        ),
        everSelectedProbability,
        starvationProbability: Math.max(0, 1 - everSelectedProbability),
        ...(everSelectedProbability <= 0
          ? {}
          : {
              expectedFirstSelectionDay:
                categoryFirstDayTotals.get(category)! / everSelectedProbability,
            }),
      };
    }),
    topPaths: [...pathProbabilities.values()]
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 20),
    timeline: aggregate.timeline,
  };
}

function monteCarloSequence(
  manifest: CustomWeightedPoolManifest,
  scenario: ProbabilityScenario,
  horizonDays: number,
  maxSteps: number,
  samples: number,
  seed: number,
  confidenceLevel: number,
  signal: AbortSignal | undefined,
  unresolved: ProbabilityUnresolved[],
): SequenceSummary {
  const random = new DeterministicRandom(seed);
  const selections = manifest.candidates.map(() => 0);
  const ever = manifest.candidates.map(() => 0);
  const next = manifest.candidates.map(() => 0);
  const firstDayTotals = manifest.candidates.map(() => 0);
  const countDistributions = manifest.candidates.map(() => new Map<number, number>());
  const categoryIds = [
    ...new Set(
      manifest.candidates.flatMap(({ category }) => (category === undefined ? [] : [category])),
    ),
  ].sort();
  const categoryNext = new Map(categoryIds.map((category) => [category, 0]));
  const categoryEver = new Map(categoryIds.map((category) => [category, 0]));
  const categoryFirstDayTotals = new Map(categoryIds.map((category) => [category, 0]));
  const pathCounts = new Map<
    string,
    { candidateIds: string[]; count: number; terminal: boolean; endDay: number }
  >();
  let terminal = 0;
  let maximumSteps = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    if ((sample & 1023) === 0) signal?.throwIfAborted();
    let state = initialState(manifest, scenario);
    while (!state.terminal && state.day < horizonDays && state.step < maxSteps) {
      const days = cadenceDays(manifest, state);
      const elapsed = days[Math.min(days.length - 1, Math.floor(random.next() * days.length))]!;
      const selectionState = cloneState(state);
      const actualElapsed = Math.min(elapsed, horizonDays - state.day);
      selectionState.day += actualElapsed;
      applyRecovery(selectionState, manifest, actualElapsed, unresolved);
      if (elapsed > horizonDays - state.day) {
        state = selectionState;
        break;
      }
      const eligible = eligibleCandidates(selectionState, manifest, unresolved);
      let selected: CandidateState[] = [];
      if (manifest.selection.mode === 'categorical_weighted') {
        const total = eligible.reduce((sum, candidate) => sum + candidate.weight, 0);
        if (total > 0) {
          let draw = random.next() * total;
          for (const candidate of eligible) {
            draw -= candidate.weight;
            if (draw <= 0) {
              selected = [candidate];
              break;
            }
          }
        }
      } else {
        selected = eligible.filter(
          (candidate) => random.next() < Math.max(0, Math.min(1, candidate.weight / 100)),
        );
      }
      state = advance(selectionState, manifest, selected, unresolved);
    }
    maximumSteps = Math.max(maximumSteps, state.step);
    if (state.terminal) terminal += 1;
    const pathKey = canonicalJson(state.selectedIds);
    const path = pathCounts.get(pathKey);
    if (path === undefined)
      pathCounts.set(pathKey, {
        candidateIds: [...state.selectedIds],
        count: 1,
        terminal: state.terminal,
        endDay: state.day,
      });
    else {
      path.count += 1;
      path.terminal = path.terminal || state.terminal;
      path.endDay = Math.max(path.endDay, state.day);
    }
    for (const [index, candidate] of manifest.candidates.entries()) {
      const count = state.selectedIds.filter((id) => id === candidate.id).length;
      selections[index]! += count;
      if (count > 0) ever[index]! += 1;
      countDistributions[index]!.set(count, (countDistributions[index]!.get(count) ?? 0) + 1);
      if (state.selectedIds[0] === candidate.id) next[index]! += 1;
      const firstDay = state.selectionDays[candidate.id]?.[0];
      if (firstDay !== undefined) firstDayTotals[index]! += firstDay;
    }
    const firstSelected = manifest.candidates.find(({ id }) => id === state.selectedIds[0]);
    if (firstSelected?.category !== undefined)
      categoryNext.set(firstSelected.category, categoryNext.get(firstSelected.category)! + 1);
    for (const category of categoryIds) {
      const firstDays = manifest.candidates.flatMap((candidate) => {
        if (candidate.category !== category) return [];
        const day = state.selectionDays[candidate.id]?.[0];
        return day === undefined ? [] : [day];
      });
      if (firstDays.length === 0) continue;
      categoryEver.set(category, categoryEver.get(category)! + 1);
      categoryFirstDayTotals.set(
        category,
        categoryFirstDayTotals.get(category)! + Math.min(...firstDays),
      );
    }
  }
  return {
    scenarioId: scenario.id,
    method: 'seeded_monte_carlo',
    steps: maximumSteps,
    samples,
    seed,
    rng: 'mulberry32',
    stoppingRule: 'fixed_sample_budget',
    confidenceLevel,
    terminalProbability: terminal / samples,
    stateCount: samples,
    candidates: manifest.candidates.map((candidate, index) => ({
      id: candidate.id,
      expectedSelections: selections[index]! / samples,
      everSelectedProbability: ever[index]! / samples,
      nextSelectionProbability: next[index]! / samples,
      starvationProbability: 1 - ever[index]! / samples,
      ...((ever[index] ?? 0) === 0
        ? {}
        : { expectedFirstSelectionDay: firstDayTotals[index]! / (ever[index] ?? 1) }),
      countDistribution: [...countDistributions[index]!.entries()]
        .sort(([left], [right]) => left - right)
        .map(([count, observations]) => ({ count, probability: observations / samples })),
    })),
    categories: categoryIds.map((category) => {
      const candidateIndexes = manifest.candidates.flatMap((candidate, index) =>
        candidate.category === category ? [index] : [],
      );
      const everObservations = categoryEver.get(category)!;
      return {
        id: category,
        nextSelectionProbability: categoryNext.get(category)! / samples,
        expectedSelections:
          candidateIndexes.reduce((sum, index) => sum + selections[index]!, 0) / samples,
        everSelectedProbability: everObservations / samples,
        starvationProbability: 1 - everObservations / samples,
        ...(everObservations === 0
          ? {}
          : {
              expectedFirstSelectionDay: categoryFirstDayTotals.get(category)! / everObservations,
            }),
      };
    }),
    topPaths: [...pathCounts.values()]
      .map(({ count, ...path }) => ({ ...path, probability: count / samples }))
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 20),
    timeline: [],
  };
}

export function analyzeSequence(
  manifest: CustomWeightedPoolManifest,
  scenario: ProbabilityScenario,
  horizonDays: number,
  maxSteps: number,
  samples: number,
  seed: number,
  confidenceLevel: number,
  signal?: AbortSignal,
): { summary: SequenceSummary; unresolved: ProbabilityUnresolved[] } {
  const unresolved: ProbabilityUnresolved[] = [];
  const estimatedBranching =
    manifest.candidates.length *
    Math.max(
      1,
      Math.ceil(
        (manifest.selection.timerMaxDays ?? 1) - (manifest.selection.timerMinDays ?? 1) + 1,
      ),
    );
  const useMonteCarlo =
    estimatedBranching > 50 ||
    maxSteps > 250 ||
    manifest.candidates.length > 20 ||
    (manifest.selection.mode === 'independent_chances' && manifest.candidates.length > 10);
  const summary = useMonteCarlo
    ? monteCarloSequence(
        manifest,
        scenario,
        horizonDays,
        maxSteps,
        samples,
        seed,
        confidenceLevel,
        signal,
        unresolved,
      )
    : exactSequence(manifest, scenario, horizonDays, maxSteps, signal, unresolved);
  return { summary, unresolved };
}
