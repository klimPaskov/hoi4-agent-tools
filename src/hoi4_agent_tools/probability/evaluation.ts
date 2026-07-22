import { compareCodeUnits } from '../core/canonical.js';
import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { assignments, type BlockNode } from '../core/source/index.js';
import type {
  CandidateAnalysis,
  ProbabilityScenario,
  ProbabilityUnresolved,
  ScenarioAnalysis,
  ScenarioScalar,
  SupportLevel,
  ValueTraceStep,
  WeightedCandidate,
  WeightedSurface,
} from './model.js';
import { Rational, sumRationals, uniformRaceProbabilities } from './rational.js';
import { evaluateTriggerBlock } from './trigger-evaluator.js';
import { evaluateCandidateValue } from './value-evaluator.js';

export interface ExactCandidateEvaluation {
  id: string;
  eligibility: CandidateAnalysis['eligibility'];
  value?: Rational;
  probability?: Rational;
  pathProbability?: Rational;
  trace: ValueTraceStep[];
  unresolved: ProbabilityUnresolved[];
  provenance: WeightedCandidate['provenance'];
}

const BRANCH_LIMIT = 4_096;

function numericState(value: unknown): Rational | undefined {
  return typeof value === 'number' || typeof value === 'string' ? Rational.parse(value) : undefined;
}

function externalFactor(
  surface: WeightedSurface,
  candidate: WeightedCandidate,
  scenario: ProbabilityScenario,
): { factor: Rational; trace: ValueTraceStep[]; unresolved: ProbabilityUnresolved[] } {
  let factor = Rational.one;
  const trace: ValueTraceStep[] = [];
  const unresolved: ProbabilityUnresolved[] = [];
  if (surface.adapter.id === 'national_focus_ai_will_do') {
    const sourceFactor = numericState(
      scenario.state[`focus_factor.${candidate.id}`] ??
        scenario.state[`ai_strategy.focus_factor.${candidate.id}`],
    );
    if (sourceFactor !== undefined) {
      const before = factor;
      factor = factor.multiply(sourceFactor);
      trace.push({
        operation: 'external_factor',
        expression: `focus_factor.${candidate.id}`,
        applied: 'true',
        value: sourceFactor.toJSON(),
        before: before.toJSON(),
        after: factor.toJSON(),
        note: 'Declared aggregate AI strategy focus factor',
      });
    }
    if (scenario.state[`focus_prerequisite_completed.${candidate.id}`] === true) {
      const prerequisite = new Rational(3n, 2n);
      const before = factor;
      factor = factor.multiply(prerequisite);
      trace.push({
        operation: 'external_factor',
        expression: `focus_prerequisite_completed.${candidate.id}`,
        applied: 'true',
        value: prerequisite.toJSON(),
        before: before.toJSON(),
        after: factor.toJSON(),
        note: 'Verified recently-completed prerequisite multiplier',
      });
    }
    if (scenario.state['focus.external_factors_complete'] !== true) {
      unresolved.push({
        code: 'FOCUS_EXTERNAL_FACTORS_UNDECLARED',
        message:
          'Exact focus selection requires the scenario to declare that strategy-plan and prerequisite factors are complete',
        path: 'focus.external_factors_complete',
        candidateId: candidate.id,
        ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
      });
    }
  }
  if (
    surface.adapter.id === 'technology_ai_will_do' ||
    surface.adapter.id === 'doctrine_ai_will_do'
  ) {
    const percentage = numericState(
      scenario.state[`research_weight_factor.${candidate.id}`] ??
        scenario.state['research_weight_factor.all'],
    );
    if (percentage !== undefined) {
      const multiplier = Rational.one.add(percentage.divide(new Rational(100n)));
      const before = factor;
      factor = factor.multiply(multiplier.max(Rational.zero));
      trace.push({
        operation: 'external_factor',
        expression: `research_weight_factor.${candidate.id}`,
        applied: 'true',
        value: multiplier.toJSON(),
        before: before.toJSON(),
        after: factor.toJSON(),
        note: 'Declared research_weight_factor percentage converted to a score multiplier',
      });
    }
    if (scenario.state['technology.external_factors_complete'] !== true) {
      unresolved.push({
        code: 'TECHNOLOGY_EXTERNAL_FACTORS_UNDECLARED',
        message:
          'Exact technology selection requires all research cost, bonus, date, strategy, and candidate factors to be declared complete',
        path: 'technology.external_factors_complete',
        candidateId: candidate.id,
        ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
      });
    }
  }
  return { factor, trace, unresolved };
}

export function evaluateExactCandidates(
  surface: WeightedSurface,
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
): ExactCandidateEvaluation[] {
  const candidates = surface.candidates.map((candidate): ExactCandidateEvaluation => {
    const eligibility = evaluateTriggerBlock(
      candidate.eligibilityBlock,
      scenario,
      candidate,
      definitions,
    );
    const value = evaluateCandidateValue(candidate, scenario, definitions);
    const external = externalFactor(surface, candidate, scenario);
    const exactValue =
      eligibility.state === 'false'
        ? Rational.zero
        : value.value?.multiply(external.factor).max(Rational.zero);
    return {
      id: candidate.id,
      eligibility: eligibility.state,
      ...(exactValue === undefined ? {} : { value: exactValue }),
      trace: [
        ...(candidate.eligibilityBlock === undefined
          ? [
              {
                operation: 'eligibility' as const,
                expression: 'implicit true',
                applied: eligibility.state,
                ...(candidate.provenance[0] === undefined
                  ? {}
                  : { provenance: candidate.provenance[0] }),
              },
            ]
          : (eligibility.trace ?? [])),
        ...value.trace,
        ...external.trace,
      ],
      unresolved: [...eligibility.unresolved, ...value.unresolved, ...external.unresolved],
      provenance: [
        ...candidate.provenance,
        ...(eligibility.helperProvenance ?? []),
        ...(value.referencedProvenance ?? []),
      ],
    };
  });
  const eligible = candidates.filter(
    ({ eligibility, value }) => eligibility === 'true' && value !== undefined,
  );
  if (surface.adapter.selectionRule === 'proportional_categorical' && surface.poolComplete) {
    const poolResolved = candidates.every(
      ({ eligibility, value }) => eligibility !== 'unresolved' && value !== undefined,
    );
    const total = sumRationals(eligible.map(({ value }) => value!));
    if (poolResolved && !total.isZero()) {
      for (const candidate of candidates)
        candidate.probability =
          candidate.eligibility === 'true' && candidate.value !== undefined
            ? candidate.value.divide(total)
            : Rational.zero;
    } else if (
      poolResolved &&
      surface.adapter.id === 'event_option_ai_chance' &&
      candidates.length > 0
    ) {
      for (const [index, candidate] of candidates.entries())
        candidate.probability = index === 0 ? Rational.one : Rational.zero;
    }
  }
  if (surface.adapter.selectionRule === 'uniform_score_race' && surface.poolComplete) {
    const externalComplete = candidates.every(({ unresolved: items }) =>
      items.every(
        ({ code }) =>
          code !== 'FOCUS_EXTERNAL_FACTORS_UNDECLARED' &&
          code !== 'TECHNOLOGY_EXTERNAL_FACTORS_UNDECLARED',
      ),
    );
    if (
      externalComplete &&
      candidates.every(
        ({ eligibility, value }) => eligibility !== 'unresolved' && value !== undefined,
      )
    ) {
      const probabilities = uniformRaceProbabilities(candidates.map(({ value }) => value!));
      for (const [index, probability] of probabilities.entries())
        candidates[index]!.probability = probability;
    }
  }
  if (surface.adapter.selectionRule === 'independent_chance') {
    for (const candidate of candidates) {
      if (candidate.value === undefined) continue;
      candidate.probability = candidate.value
        .divide(new Rational(100n))
        .max(Rational.zero)
        .min(Rational.one);
    }
  }
  if (surface.adapter.id === 'random_list') {
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.probability === undefined) continue;
      let pathProbability = candidate.probability;
      let pathResolved = true;
      for (const parent of surface.candidates[index]?.parentRandomPools ?? []) {
        const parentSurface: WeightedSurface = {
          id: parent.id,
          adapter: surface.adapter,
          candidates: parent.candidates,
          poolComplete: true,
          sourceRevision: surface.sourceRevision,
          sourceHash: surface.sourceHash,
          filesScanned: surface.filesScanned,
          unsupported: [],
        };
        const parentEvaluated = evaluateExactCandidates(parentSurface, scenario, definitions);
        const selected = parentEvaluated[parent.selectedEntryIndex];
        if (selected?.probability === undefined || selected.unresolved.length > 0) {
          pathResolved = false;
          candidate.unresolved.push({
            code: 'NESTED_RANDOM_PATH_UNRESOLVED',
            message: `Parent random-list path ${parent.id} cannot be evaluated exactly`,
            candidateId: candidate.id,
            ...(selected?.provenance[0] === undefined
              ? {}
              : { provenance: selected.provenance[0] }),
            details: { parentRandomListId: parent.id },
          });
          break;
        }
        pathProbability = pathProbability.multiply(selected.probability);
        candidate.provenance.push(...selected.provenance);
      }
      if (pathResolved) candidate.pathProbability = pathProbability;
    }
  }
  return candidates;
}

function scalarThresholds(block: BlockNode | undefined): number[] {
  if (block === undefined) return [];
  const values: number[] = [];
  for (const assignment of assignments(block)) {
    if (assignment.value.type === 'scalar') {
      const value = Number(assignment.value.value);
      if (Number.isFinite(value)) values.push(value);
    } else values.push(...scalarThresholds(assignment.value));
  }
  return values;
}

export function boundedRangeValues(surface: WeightedSurface, min: number, max: number): number[] {
  const values = new Set([min, max]);
  for (const candidate of surface.candidates) {
    for (const threshold of [
      ...scalarThresholds(candidate.weightBlock),
      ...scalarThresholds(candidate.eligibilityBlock),
    ]) {
      if (threshold < min || threshold > max) continue;
      values.add(threshold);
      const epsilon = Math.max(1e-9, Math.abs(threshold) * 1e-9);
      if (threshold - epsilon >= min) values.add(threshold - epsilon);
      if (threshold + epsilon <= max) values.add(threshold + epsilon);
    }
  }
  return [...values].sort((left, right) => left - right);
}

function triggerThresholds(block: BlockNode | undefined): number[] {
  if (block === undefined) return [];
  const values: number[] = [];
  for (const assignment of assignments(block)) {
    if (assignment.key.value === 'check_variable' && assignment.value.type === 'block') {
      const threshold = assignments(assignment.value).find(({ key }) => key.value === 'value');
      if (threshold?.value.type === 'scalar') {
        const value = Number(threshold.value.value);
        if (Number.isFinite(value)) values.push(value);
      }
    }
    if (assignment.value.type === 'block') values.push(...triggerThresholds(assignment.value));
  }
  return values;
}

export function conditionBreakpointValues(
  surface: WeightedSurface,
  min: number,
  max: number,
): number[] {
  const values = new Set<number>();
  for (const candidate of surface.candidates)
    for (const threshold of [
      ...triggerThresholds(candidate.weightBlock),
      ...triggerThresholds(candidate.eligibilityBlock),
    ]) {
      if (threshold < min || threshold > max) continue;
      values.add(threshold);
      const epsilon = Math.max(1e-9, Math.abs(threshold) * 1e-9);
      if (threshold - epsilon >= min) values.add(threshold - epsilon);
      if (threshold + epsilon <= max) values.add(threshold + epsilon);
    }
  return [...values].sort((left, right) => left - right);
}

function scenarioBranches(
  surface: WeightedSurface,
  scenario: ProbabilityScenario,
): { branches: ProbabilityScenario[]; bounded: boolean; unresolved: ProbabilityUnresolved[] } {
  let branches: ProbabilityScenario[] = [{ ...scenario, state: { ...scenario.state } }];
  let bounded = false;
  const unresolved: ProbabilityUnresolved[] = [];
  for (const input of scenario.uncertainInputs ?? []) {
    let values: ScenarioScalar[] = [];
    if (input.alternatives !== undefined) values = input.alternatives;
    else if (input.range !== undefined) {
      values = boundedRangeValues(surface, input.range.min, input.range.max);
      bounded = true;
    } else if (input.distribution !== undefined) {
      unresolved.push({
        code: 'DISTRIBUTION_REQUIRES_SIMULATION',
        message: `Distribution for ${input.path} requires seeded simulation`,
        path: input.path,
      });
      continue;
    } else if (input.unresolved === true) {
      unresolved.push({
        code: 'SCENARIO_INPUT_UNRESOLVED',
        message: `Scenario explicitly leaves ${input.path} unresolved`,
        path: input.path,
      });
      continue;
    }
    if (values.length === 0) continue;
    if (branches.length * values.length > BRANCH_LIMIT) {
      unresolved.push({
        code: 'SCENARIO_BRANCH_LIMIT',
        message: `Exact alternative expansion exceeds ${BRANCH_LIMIT} branches`,
        path: input.path,
        details: { currentBranches: branches.length, alternatives: values.length },
      });
      break;
    }
    branches = branches.flatMap((branch) =>
      values.map((value) => ({ ...branch, state: { ...branch.state, [input.path]: value } })),
    );
    if (values.length > 1) bounded = true;
  }
  return { branches, bounded, unresolved };
}

function supportLevel(
  surface: WeightedSurface,
  bounded: boolean,
  unresolved: readonly ProbabilityUnresolved[],
  hasExactProbability: boolean,
): SupportLevel {
  if (surface.adapter.selectionRule === 'score_only') return 'score_only';
  if (bounded) return 'bounded';
  const externalCodes = new Set([
    'FOCUS_EXTERNAL_FACTORS_UNDECLARED',
    'TECHNOLOGY_EXTERNAL_FACTORS_UNDECLARED',
  ]);
  if (
    unresolved.length > 0 &&
    unresolved.every(({ code }) => externalCodes.has(code)) &&
    !hasExactProbability
  )
    return 'external';
  if (unresolved.length > 0 && !hasExactProbability) return 'unsupported';
  return 'exact';
}

function rankCandidates(candidates: CandidateAnalysis[]): void {
  const ranked = candidates
    .filter(
      ({ rawValue, eligibility }) =>
        rawValue !== undefined && rawValue !== null && eligibility !== 'false',
    )
    .sort((left, right) => {
      const leftValue =
        typeof left.rawValue === 'object' && left.rawValue !== null
          ? left.rawValue.value
          : Number(left.rawValue);
      const rightValue =
        typeof right.rawValue === 'object' && right.rawValue !== null
          ? right.rawValue.value
          : Number(right.rawValue);
      return rightValue - leftValue || compareCodeUnits(left.id, right.id);
    });
  for (const [index, candidate] of ranked.entries()) candidate.rank = index + 1;
}

function scenarioSummary(candidates: readonly CandidateAnalysis[]): ScenarioAnalysis['summary'] {
  const eligible = candidates
    .filter(({ eligibility }) => eligibility === 'true')
    .sort(
      (left, right) =>
        (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
        compareCodeUnits(left.id, right.id),
    );
  const metric = (
    candidate: CandidateAnalysis,
  ): { value: number; kind: 'probability' | 'raw_value' } => {
    if (candidate.conditionalProbability !== undefined && candidate.conditionalProbability !== null)
      return { value: candidate.conditionalProbability, kind: 'probability' };
    return {
      value:
        typeof candidate.rawValue === 'object' && candidate.rawValue !== null
          ? candidate.rawValue.value
          : (candidate.rawInterval?.max ?? 0),
      kind: 'raw_value',
    };
  };
  const [leader, runnerUp] = eligible;
  let closestRankReversal: ScenarioAnalysis['summary']['closestRankReversal'];
  if (leader !== undefined && runnerUp !== undefined) {
    const leaderMetric = metric(leader);
    const runnerUpMetric = metric(runnerUp);
    if (leaderMetric.kind === runnerUpMetric.kind)
      closestRankReversal = {
        candidates: [leader.id, runnerUp.id],
        gap: Math.abs(leaderMetric.value - runnerUpMetric.value),
        metric: leaderMetric.kind,
      };
  }
  const dominantFactors = (leader?.trace ?? [])
    .filter(({ applied, operation }) => applied === 'true' && operation !== 'eligibility')
    .map(({ operation, expression }) => `${operation} ${expression}`)
    .slice(-5);
  return {
    topOutcomes: eligible.slice(0, 3).map(({ id }) => id),
    bottomEligibleOutcomes: eligible
      .slice(-3)
      .reverse()
      .map(({ id }) => id),
    impossibleOutcomes: candidates
      .filter(
        ({ eligibility, conditionalProbability }) =>
          eligibility === 'false' || conditionalProbability === 0,
      )
      .map(({ id }) => id),
    unresolvedOutcomes: candidates
      .filter(
        ({ eligibility, unresolved }) => eligibility === 'unresolved' || unresolved.length > 0,
      )
      .map(({ id }) => id),
    dominantFactors,
    ...(closestRankReversal === undefined ? {} : { closestRankReversal }),
  };
}

function scheduledMtthChance(
  surface: WeightedSurface,
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
  horizonDays: number,
): {
  chance?: number;
  survival?: number;
  chanceInterval?: { low: number; high: number };
  survivalInterval?: { low: number; high: number };
  intervals?: NonNullable<ScenarioAnalysis['timingIntervals']>;
  unresolved: ProbabilityUnresolved[];
} {
  if (surface.adapter.id !== 'event_mean_time_to_happen' || surface.candidates.length !== 1)
    return { unresolved: [] };
  let state: ProbabilityScenario = {
    ...scenario,
    state: { ...scenario.state },
    flags: [...(scenario.flags ?? [])],
  };
  const schedule = [...(scenario.schedule ?? [])]
    .filter(({ atDay }) => atDay >= 0 && atDay <= horizonDays)
    .sort((left, right) => left.atDay - right.atDay);
  const boundaries = [0, ...schedule.map(({ atDay }) => atDay), horizonDays];
  let minimumHazard = 0;
  let maximumHazard = 0;
  let previousEligibility: 'true' | 'false' | 'unresolved' | undefined;
  const unresolved: ProbabilityUnresolved[] = [];
  const intervals: NonNullable<ScenarioAnalysis['timingIntervals']> = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    if (index > 0) {
      const change = schedule[index - 1];
      if (change !== undefined) {
        state = {
          ...state,
          state: { ...state.state, ...change.set },
          flags: [
            ...new Set([
              ...(state.flags ?? []).filter((flag) => !change.clearFlags?.includes(flag)),
              ...(change.addFlags ?? []),
            ]),
          ],
        };
      }
    }
    if (end <= start) continue;
    const [candidate] = evaluateExactCandidates(surface, state, definitions);
    if (candidate?.eligibility === 'false') {
      intervals.push({
        startDay: start,
        endDay: end,
        eligibility: 'false',
        minimumHazardContribution: 0,
        maximumHazardContribution: 0,
      });
      previousEligibility = 'false';
      continue;
    }
    if (
      candidate?.eligibility !== 'true' ||
      candidate.value === undefined ||
      candidate.value.compare(Rational.zero) <= 0
    ) {
      intervals.push({
        startDay: start,
        endDay: end,
        eligibility: candidate?.eligibility ?? 'unresolved',
        minimumHazardContribution: 0,
        maximumHazardContribution: 0,
      });
      unresolved.push(...(candidate?.unresolved ?? []));
      previousEligibility = candidate?.eligibility;
      continue;
    }
    const duration = end - start;
    const mtth = candidate.value.toNumber();
    let intervalMinimumHazard: number;
    let intervalMaximumHazard: number;
    if (previousEligibility === 'false') {
      const declaredPhase = state.state['mtth.poll_phase_days'];
      if (typeof declaredPhase === 'number' && declaredPhase >= 0 && declaredPhase <= 20) {
        const activeDays = Math.max(0, duration - declaredPhase);
        intervalMinimumHazard = activeDays / mtth;
        intervalMaximumHazard = activeDays / mtth;
      } else {
        intervalMinimumHazard = Math.max(0, duration - 20) / mtth;
        intervalMaximumHazard = duration / mtth;
        unresolved.push({
          code: 'MTTH_POLL_PHASE_UNDECLARED',
          message:
            'Trigger became true after inactivity; the verified 20-day inactive polling phase is not declared, so horizon chance is bounded',
          candidateId: candidate.id,
          ...(candidate.provenance[0] === undefined ? {} : { provenance: candidate.provenance[0] }),
          details: { transitionDay: start, pollWindowDays: 20 },
        });
      }
    } else {
      intervalMinimumHazard = duration / mtth;
      intervalMaximumHazard = duration / mtth;
    }
    minimumHazard += intervalMinimumHazard;
    maximumHazard += intervalMaximumHazard;
    intervals.push({
      startDay: start,
      endDay: end,
      eligibility: 'true',
      effectiveMtthDays: mtth,
      minimumHazardContribution: intervalMinimumHazard,
      maximumHazardContribution: intervalMaximumHazard,
    });
    previousEligibility = 'true';
  }
  const minimumChance = 1 - 2 ** -minimumHazard;
  const maximumChance = 1 - 2 ** -maximumHazard;
  if (minimumHazard !== maximumHazard)
    return {
      chanceInterval: { low: minimumChance, high: maximumChance },
      survivalInterval: { low: 1 - maximumChance, high: 1 - minimumChance },
      intervals,
      unresolved,
    };
  if (unresolved.length > 0) return { intervals, unresolved };
  return { chance: maximumChance, survival: 1 - maximumChance, intervals, unresolved: [] };
}

export function evaluateSurfaceScenarios(
  surface: WeightedSurface,
  scenarios: readonly ProbabilityScenario[],
  definitions: ClausewitzEvaluationDefinitions,
  horizonDays?: number,
): ScenarioAnalysis[] {
  return scenarios.map((scenario): ScenarioAnalysis => {
    const expanded = scenarioBranches(surface, scenario);
    const branchResults = expanded.branches.map((branch) =>
      evaluateExactCandidates(surface, branch, definitions),
    );
    const candidates = surface.candidates.map(
      (sourceCandidate, candidateIndex): CandidateAnalysis => {
        const evaluated = branchResults.map((branch) => branch[candidateIndex]!).filter(Boolean);
        const values = evaluated.flatMap(({ value }) => (value === undefined ? [] : [value]));
        const probabilities = evaluated.flatMap(({ probability }) =>
          probability === undefined ? [] : [probability],
        );
        const pathProbabilities = evaluated.flatMap(({ pathProbability }) =>
          pathProbability === undefined ? [] : [pathProbability],
        );
        const unresolved = [
          ...expanded.unresolved,
          ...evaluated.flatMap(({ unresolved: items }) => items),
        ];
        const provenance = [
          ...new Map(
            evaluated
              .flatMap(({ provenance: items }) => items)
              .map((item) => [JSON.stringify(item), item] as const),
          ).values(),
        ];
        const eligibilityStates = new Set(evaluated.map(({ eligibility }) => eligibility));
        const eligibility =
          eligibilityStates.size === 1 ? (evaluated[0]?.eligibility ?? 'unresolved') : 'unresolved';
        const minValue = values.reduce(
          (minimum, value) => value.min(minimum),
          values[0] ?? Rational.zero,
        );
        const maxValue = values.reduce(
          (maximum, value) => value.max(maximum),
          values[0] ?? Rational.zero,
        );
        const minProbability = probabilities.reduce(
          (minimum, value) => value.min(minimum),
          probabilities[0] ?? Rational.zero,
        );
        const maxProbability = probabilities.reduce(
          (maximum, value) => value.max(maximum),
          probabilities[0] ?? Rational.zero,
        );
        const minPathProbability = pathProbabilities.reduce(
          (minimum, value) => value.min(minimum),
          pathProbabilities[0] ?? Rational.zero,
        );
        const maxPathProbability = pathProbabilities.reduce(
          (maximum, value) => value.max(maximum),
          pathProbabilities[0] ?? Rational.zero,
        );
        const exactRaw =
          values.length > 0 && values.every((value) => value.compare(values[0]!) === 0);
        const exactProbability =
          probabilities.length === branchResults.length &&
          probabilities.length > 0 &&
          probabilities.every((value) => value.compare(probabilities[0]!) === 0);
        const exactPathProbability =
          pathProbabilities.length === branchResults.length &&
          pathProbabilities.length > 0 &&
          pathProbabilities.every((value) => value.compare(pathProbabilities[0]!) === 0);
        const support = supportLevel(surface, expanded.bounded, unresolved, exactProbability);
        const result: CandidateAnalysis = {
          id: sourceCandidate.id,
          eligibility,
          supportLevel: support,
          ...(exactRaw ? { rawValue: values[0]!.toJSON() } : {}),
          ...(values.length > 0 && !exactRaw
            ? { rawInterval: { min: minValue.toNumber(), max: maxValue.toNumber() } }
            : {}),
          ...(exactProbability
            ? {
                conditionalProbability: probabilities[0]!.toNumber(),
                exactConditionalProbability: probabilities[0]!.toJSON(),
              }
            : probabilities.length > 0
              ? {
                  conditionalProbabilityInterval: {
                    low: minProbability.toNumber(),
                    high: maxProbability.toNumber(),
                  },
                }
              : { conditionalProbability: null }),
          ...(surface.adapter.id !== 'random_list'
            ? {}
            : exactPathProbability
              ? {
                  pathProbability: pathProbabilities[0]!.toNumber(),
                  exactPathProbability: pathProbabilities[0]!.toJSON(),
                }
              : pathProbabilities.length > 0
                ? {
                    pathProbabilityInterval: {
                      low: minPathProbability.toNumber(),
                      high: maxPathProbability.toNumber(),
                    },
                  }
                : { pathProbability: null }),
          ...(surface.adapter.id === 'event_mean_time_to_happen' && exactRaw
            ? {
                effectiveMtthDays: values[0]!.toNumber(),
                timingModel: 'verified daily discrete checks with median parameter',
                ...(scenario.schedule?.length
                  ? {}
                  : {
                      timingQuantilesDays: {
                        p10: -values[0]!.toNumber() * Math.log2(0.9),
                        p50: values[0]!.toNumber(),
                        p90: -values[0]!.toNumber() * Math.log2(0.1),
                        p95: -values[0]!.toNumber() * Math.log2(0.05),
                      },
                    }),
              }
            : {}),
          rank: null,
          trace: evaluated[0]?.trace ?? [],
          provenance: provenance.length === 0 ? sourceCandidate.provenance : provenance,
          unresolved,
        };
        return result;
      },
    );
    rankCandidates(candidates);
    const allUnresolved = [
      ...surface.unsupported,
      ...expanded.unresolved,
      ...candidates.flatMap(({ unresolved }) => unresolved),
    ];
    const timing =
      horizonDays === undefined
        ? { unresolved: [] }
        : scheduledMtthChance(surface, scenario, definitions, horizonDays);
    allUnresolved.push(...timing.unresolved);
    if (timing.chance !== undefined && candidates[0] !== undefined)
      candidates[0].cumulativeChance = timing.chance;
    if (timing.chanceInterval !== undefined && candidates[0] !== undefined)
      Object.assign(candidates[0], {
        cumulativeChanceInterval: timing.chanceInterval,
        supportLevel: 'bounded' as const,
      });
    const exactValues = candidates.flatMap(({ rawValue }) =>
      typeof rawValue === 'object' && rawValue !== null ? [Rational.parse(rawValue.decimal)!] : [],
    );
    return {
      id: scenario.id,
      ...(scenario.label === undefined ? {} : { label: scenario.label }),
      ...(scenario.prevalence === undefined ? {} : { prevalence: scenario.prevalence }),
      poolComplete: surface.poolComplete,
      supportLevel: candidates.some(({ supportLevel: support }) => support === 'unsupported')
        ? 'unsupported'
        : candidates.some(({ supportLevel: support }) => support === 'external')
          ? 'external'
          : timing.chanceInterval !== undefined ||
              candidates.some(({ supportLevel: support }) => support === 'bounded')
            ? 'bounded'
            : surface.adapter.selectionRule === 'score_only'
              ? 'score_only'
              : 'exact',
      candidates,
      ...(exactValues.length === candidates.length &&
      surface.adapter.selectionRule === 'proportional_categorical'
        ? { poolTotal: sumRationals(exactValues).toJSON() }
        : {}),
      ...(horizonDays === undefined ? {} : { horizonDays }),
      ...(timing.survival === undefined ? {} : { survivalChance: timing.survival }),
      ...(timing.survivalInterval === undefined
        ? {}
        : { survivalChanceInterval: timing.survivalInterval }),
      ...(timing.intervals === undefined ? {} : { timingIntervals: timing.intervals }),
      summary: scenarioSummary(candidates),
      unresolved: allUnresolved,
    };
  });
}
