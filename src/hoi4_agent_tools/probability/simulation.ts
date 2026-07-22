import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import type {
  ProbabilityDistribution,
  ProbabilitySamplingMethod,
  ProbabilityScenario,
  ProbabilityUnresolved,
  SimulationSummary,
  WeightedSurface,
} from './model.js';
import { evaluateExactCandidates } from './evaluation.js';

export interface SimulationResult {
  summaries: SimulationSummary[];
  unresolved: ProbabilityUnresolved[];
}

interface CorrelationMoments {
  observations: number;
  sumX: number;
  sumY: number;
  sumXX: number;
  sumYY: number;
  sumXY: number;
}

function recordUnresolved(unresolved: ProbabilityUnresolved[], issue: ProbabilityUnresolved): void {
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

export class DeterministicRandom {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  public normal(): number {
    const left = Math.max(Number.MIN_VALUE, this.next());
    const right = this.next();
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
  }
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function inverseNormal(probability: number): number {
  const p = Math.min(1 - 1e-15, Math.max(1e-15, probability));
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - 0.02425) return -inverseNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

function sampleDistribution(
  distribution: ProbabilityDistribution,
  uniform: number,
  normal: number,
): string | number | boolean | null | undefined {
  switch (distribution.kind) {
    case 'uniform': {
      if (distribution.min === undefined || distribution.max === undefined) return undefined;
      return distribution.min + uniform * (distribution.max - distribution.min);
    }
    case 'triangular': {
      if (
        distribution.min === undefined ||
        distribution.max === undefined ||
        distribution.mode === undefined ||
        distribution.max <= distribution.min
      )
        return undefined;
      const ratio = (distribution.mode - distribution.min) / (distribution.max - distribution.min);
      return uniform < ratio
        ? distribution.min +
            Math.sqrt(
              uniform *
                (distribution.max - distribution.min) *
                (distribution.mode - distribution.min),
            )
        : distribution.max -
            Math.sqrt(
              (1 - uniform) *
                (distribution.max - distribution.min) *
                (distribution.max - distribution.mode),
            );
    }
    case 'normal':
      return distribution.mean === undefined || distribution.stddev === undefined
        ? undefined
        : distribution.mean + normal * distribution.stddev;
    case 'lognormal':
      return distribution.mean === undefined || distribution.stddev === undefined
        ? undefined
        : Math.exp(distribution.mean + normal * distribution.stddev);
    case 'categorical':
    case 'empirical': {
      if (distribution.values === undefined || distribution.values.length === 0) return undefined;
      const probabilities = distribution.probabilities;
      if (probabilities === undefined) {
        return distribution.values[
          Math.min(distribution.values.length - 1, Math.floor(uniform * distribution.values.length))
        ];
      }
      let cumulative = 0;
      for (const [index, probability] of probabilities.entries()) {
        cumulative += probability;
        if (uniform <= cumulative) return distribution.values[index];
      }
      return distribution.values.at(-1);
    }
  }
}

function cholesky(matrix: number[][]): number[][] | undefined {
  const size = matrix.length;
  const result = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let sum = matrix[row]![column]!;
      for (let index = 0; index < column; index += 1)
        sum -= result[row]![index]! * result[column]![index]!;
      if (row === column) {
        if (sum < -1e-10) return undefined;
        result[row]![column] = Math.sqrt(Math.max(0, sum));
      } else {
        const divisor = result[column]![column]!;
        if (divisor === 0) return undefined;
        result[row]![column] = sum / divisor;
      }
    }
  }
  return result;
}

function continuousInput(
  input: NonNullable<ProbabilityScenario['uncertainInputs']>[number],
): boolean {
  return (
    input.range !== undefined ||
    (input.distribution !== undefined &&
      input.distribution.kind !== 'categorical' &&
      input.distribution.kind !== 'empirical')
  );
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function mixedUnit(seed: number, sample: number): number {
  let value = (seed + Math.imul(sample + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_296;
}

function continuousSamples(
  scenario: ProbabilityScenario,
  samples: number,
  samplingMethod: ProbabilitySamplingMethod,
  random: DeterministicRandom,
  unresolved: ProbabilityUnresolved[],
): (sample: number) => ReadonlyMap<string, number> {
  const inputs = (scenario.uncertainInputs ?? []).filter(continuousInput);
  const paths = inputs.map(({ path }) => path);
  const pathSet = new Set(paths);
  const parameters = paths.map(() => {
    let multiplier = Math.max(1, Math.floor(random.next() * samples));
    while (greatestCommonDivisor(multiplier, samples) !== 1)
      multiplier = multiplier === samples ? 1 : multiplier + 1;
    return {
      multiplier,
      offset: Math.floor(random.next() * samples),
      jitterSeed: Math.floor(random.next() * 4_294_967_296) >>> 0,
    };
  });
  const baseFor = (pathIndex: number, sample: number): number => {
    const parameter = parameters[pathIndex]!;
    if (samplingMethod === 'pseudo_random') return mixedUnit(parameter.jitterSeed, sample);
    const stratum = (parameter.multiplier * sample + parameter.offset) % samples;
    return (stratum + mixedUnit(parameter.jitterSeed, sample)) / samples;
  };
  const unsupportedCorrelations = (scenario.correlations ?? []).filter(
    ({ left, right }) => !pathSet.has(left) || !pathSet.has(right),
  );
  for (const correlation of unsupportedCorrelations) {
    recordUnresolved(unresolved, {
      code: 'CATEGORICAL_CORRELATION_UNSUPPORTED',
      message: `Correlation ${correlation.left} <-> ${correlation.right} includes a discrete or unresolved input and is not modeled`,
      details: correlation,
    });
    recordUnresolved(unresolved, {
      code: 'CORRELATED_INPUTS_SAMPLED_INDEPENDENTLY',
      message: `Correlation ${correlation.left} <-> ${correlation.right} is declared but its unsupported endpoint is sampled independently`,
      details: correlation,
    });
  }
  const numericCorrelations = (scenario.correlations ?? []).filter(
    ({ left, right }) => pathSet.has(left) && pathSet.has(right),
  );
  if (numericCorrelations.length === 0)
    return (sample) => new Map(paths.map((path, index) => [path, baseFor(index, sample)]));
  const matrix = paths.map((left, row) =>
    paths.map((right, column) => {
      if (row === column) return 1;
      return (
        numericCorrelations.find(
          (correlation) =>
            (correlation.left === left && correlation.right === right) ||
            (correlation.left === right && correlation.right === left),
        )?.coefficient ?? 0
      );
    }),
  );
  const decomposition = cholesky(matrix);
  if (decomposition === undefined) {
    recordUnresolved(unresolved, {
      code: 'CORRELATION_MATRIX_INVALID',
      message: `Scenario ${scenario.id} correlation matrix is not positive semidefinite`,
    });
    recordUnresolved(unresolved, {
      code: 'CORRELATED_INPUTS_SAMPLED_INDEPENDENTLY',
      message: `Scenario ${scenario.id} declares an invalid correlation matrix; numeric inputs are sampled independently`,
    });
    return (sample) => new Map(paths.map((path, index) => [path, baseFor(index, sample)]));
  }
  return (sample) => {
    const independent = paths.map((_, index) => inverseNormal(baseFor(index, sample)));
    return new Map(
      paths.map((path, row) => [
        path,
        normalCdf(
          decomposition[row]!.reduce(
            (sum, coefficient, index) => sum + coefficient * independent[index]!,
            0,
          ),
        ),
      ]),
    );
  };
}

function sampledScenario(
  scenario: ProbabilityScenario,
  continuous: ReadonlyMap<string, number>,
  random: DeterministicRandom,
  unresolved: ProbabilityUnresolved[],
): ProbabilityScenario {
  const inputs = scenario.uncertainInputs ?? [];
  const state = { ...scenario.state };
  for (const input of inputs) {
    let value: string | number | boolean | null | undefined;
    const plannedUniform = continuous.get(input.path);
    if (input.range !== undefined && plannedUniform !== undefined)
      value = input.range.min + plannedUniform * (input.range.max - input.range.min);
    else if (input.alternatives !== undefined)
      value =
        input.alternatives[
          Math.min(
            input.alternatives.length - 1,
            Math.floor(random.next() * input.alternatives.length),
          )
        ];
    else if (input.distribution !== undefined) {
      const uniform = plannedUniform ?? random.next();
      const normal = inverseNormal(uniform);
      value = sampleDistribution(input.distribution, uniform, normal);
    }
    if (value === undefined) {
      recordUnresolved(unresolved, {
        code: 'DISTRIBUTION_PARAMETERS_INVALID',
        message: `Distribution parameters for ${input.path} are incomplete or invalid`,
        path: input.path,
      });
    } else state[input.path] = value;
  }
  return { ...scenario, state, uncertainInputs: [] };
}

function quantileForConfidence(confidence: number): number {
  return inverseNormal(0.5 + confidence / 2);
}

export function wilsonInterval(
  successes: number,
  samples: number,
  confidence: number,
): { low: number; high: number } {
  if (samples <= 0) return { low: 0, high: 1 };
  const z = quantileForConfidence(confidence);
  const probability = successes / samples;
  const denominator = 1 + (z * z) / samples;
  const centre = (probability + (z * z) / (2 * samples)) / denominator;
  const radius =
    (z / denominator) *
    Math.sqrt((probability * (1 - probability)) / samples + (z * z) / (4 * samples * samples));
  return { low: Math.max(0, centre - radius), high: Math.min(1, centre + radius) };
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function orderStatisticInterval(
  sorted: readonly number[],
  probability: number,
  confidence: number,
): { low: number; high: number } {
  if (sorted.length === 0) return { low: Number.NaN, high: Number.NaN };
  const z = quantileForConfidence(confidence);
  const centre = probability * (sorted.length - 1);
  const deviation = z * Math.sqrt(sorted.length * probability * (1 - probability));
  const lowIndex = Math.max(0, Math.floor(centre - deviation));
  const highIndex = Math.min(sorted.length - 1, Math.ceil(centre + deviation));
  return { low: sorted[lowIndex]!, high: sorted[highIndex]! };
}

function sampledMtthWaitDays(mtthDays: number, uniform: number): number | undefined {
  if (!Number.isFinite(mtthDays) || mtthDays <= 0) return undefined;
  const logDailySurvival = -Math.LN2 / mtthDays;
  return Math.floor(Math.log1p(-Math.min(1 - Number.EPSILON, uniform)) / logDailySurvival) + 1;
}

function importanceScore(moment: CorrelationMoments): number | undefined {
  const numerator = moment.observations * moment.sumXY - moment.sumX * moment.sumY;
  const left = moment.observations * moment.sumXX - moment.sumX * moment.sumX;
  const right = moment.observations * moment.sumYY - moment.sumY * moment.sumY;
  const denominator = Math.sqrt(Math.max(0, left * right));
  if (moment.observations < 2 || denominator === 0) return undefined;
  return Math.min(1, Math.abs(numerator / denominator));
}

function chooseWinner(
  surface: WeightedSurface,
  candidates: ReturnType<typeof evaluateExactCandidates>,
  random: DeterministicRandom,
): number[] {
  if (surface.adapter.selectionRule === 'independent_chance')
    return candidates.flatMap(({ probability }, index) =>
      probability !== undefined && random.next() < probability.toNumber() ? [index] : [],
    );
  if (surface.adapter.selectionRule === 'proportional_categorical') {
    const draw =
      surface.adapter.id === 'event_option_ai_chance'
        ? Math.floor(random.next() * 100) / 100
        : random.next();
    let cumulative = 0;
    for (const [index, candidate] of candidates.entries()) {
      cumulative +=
        (surface.adapter.id === 'random_list'
          ? candidate.pathProbability
          : candidate.probability
        )?.toNumber() ?? 0;
      if (draw < cumulative) return [index];
    }
    return [];
  }
  if (surface.adapter.selectionRule === 'uniform_score_race') {
    let winner = -1;
    let maximum = -Infinity;
    for (const [index, candidate] of candidates.entries()) {
      const value = candidate.value?.toNumber() ?? 0;
      const draw = random.next() * Math.max(0, value);
      if (value > 0 && draw > maximum) {
        maximum = draw;
        winner = index;
      }
    }
    return winner < 0 ? [] : [winner];
  }
  return [];
}

function candidateSelectionSupported(
  surface: WeightedSurface,
  candidates: ReturnType<typeof evaluateExactCandidates>,
): boolean[] {
  if (
    surface.adapter.selectionRule === 'score_only' ||
    surface.adapter.selectionRule === 'median_daily_hazard'
  )
    return candidates.map(() => false);
  if (surface.adapter.selectionRule === 'independent_chance')
    return candidates.map(
      (candidate) =>
        candidate.eligibility !== 'unresolved' &&
        candidate.probability !== undefined &&
        candidate.unresolved.length === 0,
    );
  const complete =
    surface.poolComplete &&
    candidates.every(
      (candidate) =>
        candidate.eligibility !== 'unresolved' &&
        candidate.probability !== undefined &&
        (surface.adapter.id !== 'random_list' || candidate.pathProbability !== undefined) &&
        candidate.unresolved.length === 0,
    );
  return candidates.map(() => complete);
}

export function simulateSurface(
  surface: WeightedSurface,
  scenarios: readonly ProbabilityScenario[],
  definitions: ClausewitzEvaluationDefinitions,
  samples: number,
  seed: number,
  confidenceLevel: number,
  samplingMethod: ProbabilitySamplingMethod,
  rareOutcomeMinimumObservations: number,
  signal?: AbortSignal,
): SimulationResult {
  const summaries: SimulationSummary[] = [];
  const unresolved: ProbabilityUnresolved[] = [];
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const scenarioSeed = seed + scenarioIndex * 1_000_003;
    const random = new DeterministicRandom(scenarioSeed);
    const timingRandom = new DeterministicRandom((scenarioSeed ^ 0x9e3779b9) >>> 0);
    const reservoirRandom = new DeterministicRandom((scenarioSeed ^ 0x85ebca6b) >>> 0);
    const plannedContinuous = continuousSamples(
      scenario,
      samples,
      samplingMethod,
      random,
      unresolved,
    );
    const selections = surface.candidates.map(() => 0);
    const firstHalfSelections = surface.candidates.map(() => 0);
    const eligible = surface.candidates.map(() => 0);
    const rawTotals = surface.candidates.map(() => 0);
    const rawCounts = surface.candidates.map(() => 0);
    const selectionSupported = surface.candidates.map(() => true);
    const timingReservoirCapacity = Math.max(
      1,
      Math.floor(100_000 / Math.max(1, surface.candidates.length)),
    );
    const timingReservoirs = surface.candidates.map(() => [] as number[]);
    const timingEvaluations = surface.candidates.map(() => 0);
    const uncertainPaths = (scenario.uncertainInputs ?? []).map(({ path }) => path).sort();
    const importance = new Map<string, CorrelationMoments>();
    for (let sample = 0; sample < samples; sample += 1) {
      if ((sample & 4095) === 0) signal?.throwIfAborted();
      const sampled = sampledScenario(scenario, plannedContinuous(sample), random, unresolved);
      const candidates = evaluateExactCandidates(surface, sampled, definitions);
      for (const candidate of candidates)
        for (const issue of candidate.unresolved) recordUnresolved(unresolved, issue);
      const supported = candidateSelectionSupported(surface, candidates);
      for (const [index, value] of supported.entries())
        selectionSupported[index] = selectionSupported[index]! && value;
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.eligibility === 'true') eligible[index]! += 1;
        if (candidate.value !== undefined) {
          rawTotals[index]! += candidate.value.toNumber();
          rawCounts[index]! += 1;
        }
        if (
          surface.adapter.selectionRule === 'median_daily_hazard' &&
          candidate.eligibility === 'true' &&
          candidate.value !== undefined &&
          candidate.unresolved.length === 0
        ) {
          const wait = sampledMtthWaitDays(candidate.value.toNumber(), timingRandom.next());
          if (wait !== undefined) {
            timingEvaluations[index]! += 1;
            const reservoir = timingReservoirs[index]!;
            if (reservoir.length < timingReservoirCapacity) reservoir.push(wait);
            else {
              const replacement = Math.floor(reservoirRandom.next() * timingEvaluations[index]!);
              if (replacement < timingReservoirCapacity) reservoir[replacement] = wait;
            }
          }
        }
      }
      for (const inputPath of uncertainPaths) {
        const input = sampled.state[inputPath];
        if (typeof input !== 'number' || !Number.isFinite(input)) continue;
        for (const candidate of candidates) {
          const output = candidate.value?.toNumber();
          if (output === undefined || !Number.isFinite(output)) continue;
          const key = `${inputPath}\0${candidate.id}`;
          const moment = importance.get(key) ?? {
            observations: 0,
            sumX: 0,
            sumY: 0,
            sumXX: 0,
            sumYY: 0,
            sumXY: 0,
          };
          moment.observations += 1;
          moment.sumX += input;
          moment.sumY += output;
          moment.sumXX += input * input;
          moment.sumYY += output * output;
          moment.sumXY += input * output;
          importance.set(key, moment);
        }
      }
      const selected: number[] = [];
      if (supported.every(Boolean)) selected.push(...chooseWinner(surface, candidates, random));
      else if (surface.adapter.selectionRule === 'independent_chance')
        for (const [index, candidate] of candidates.entries()) {
          if (!supported[index]) continue;
          const probability = candidate.probability?.toNumber();
          if (probability !== undefined && random.next() < probability) selected.push(index);
        }
      for (const winner of selected) {
        selections[winner]! += 1;
        if (sample < Math.floor(samples / 2)) firstHalfSelections[winner]! += 1;
      }
    }
    const firstHalfSamples = Math.floor(samples / 2);
    const secondHalfSamples = samples - firstHalfSamples;
    const maximumFrequencyDelta = Math.max(
      ...surface.candidates.map((_, index) => {
        if (!selectionSupported[index] || firstHalfSamples === 0 || secondHalfSamples === 0)
          return 0;
        const first = firstHalfSelections[index]! / firstHalfSamples;
        const second = (selections[index]! - firstHalfSelections[index]!) / secondHalfSamples;
        return Math.abs(first - second);
      }),
      0,
    );
    for (const [index, count] of selections.entries()) {
      if (selectionSupported[index] && count > 0 && count < rareOutcomeMinimumObservations)
        recordUnresolved(unresolved, {
          code: 'MONTE_CARLO_RARE_OUTCOME_UNRESOLVED',
          message: `${surface.candidates[index]!.id} was observed only ${count} time(s); the sampled frequency is not stable at the requested precision`,
          candidateId: surface.candidates[index]!.id,
          details: {
            observedSelections: count,
            samples,
            minimumStableObservations: rareOutcomeMinimumObservations,
          },
        });
    }
    summaries.push({
      scenarioId: scenario.id,
      samples,
      seed: scenarioSeed,
      samplingMethod,
      rng: 'mulberry32',
      stoppingRule: 'fixed_sample_budget',
      confidenceLevel,
      confidenceMethod: 'wilson_score',
      effectiveSampleSize: samples,
      globalImportance: [...importance.entries()]
        .flatMap(([key, moment]) => {
          const score = importanceScore(moment);
          if (score === undefined) return [];
          const [path, candidateId] = key.split('\0') as [string, string];
          return [
            {
              path,
              candidateId,
              metric: 'raw_value' as const,
              score,
              method: 'absolute_pearson_correlation' as const,
              observations: moment.observations,
            },
          ];
        })
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.path.localeCompare(right.path) ||
            left.candidateId.localeCompare(right.candidateId),
        ),
      convergence: { firstHalfSamples, secondHalfSamples, maximumFrequencyDelta },
      candidates: surface.candidates.map((candidate, index) => {
        const sortedTiming = timingReservoirs[index]!.slice().sort((left, right) => left - right);
        const timingQuantilesDays =
          sortedTiming.length === 0
            ? undefined
            : {
                p10: quantile(sortedTiming, 0.1),
                p50: quantile(sortedTiming, 0.5),
                p90: quantile(sortedTiming, 0.9),
                p95: quantile(sortedTiming, 0.95),
              };
        const timingQuantileIntervals =
          sortedTiming.length === 0
            ? undefined
            : {
                p10: orderStatisticInterval(sortedTiming, 0.1, confidenceLevel),
                p50: orderStatisticInterval(sortedTiming, 0.5, confidenceLevel),
                p90: orderStatisticInterval(sortedTiming, 0.9, confidenceLevel),
                p95: orderStatisticInterval(sortedTiming, 0.95, confidenceLevel),
              };
        return {
          id: candidate.id,
          ...(selectionSupported[index]
            ? {
                frequency: selections[index]! / samples,
                observedSelections: selections[index]!,
                confidenceInterval: wilsonInterval(selections[index]!, samples, confidenceLevel),
              }
            : {}),
          ...(rawCounts[index]! > 0 ? { rawMean: rawTotals[index]! / rawCounts[index]! } : {}),
          eligibilityFrequency: eligible[index]! / samples,
          ...(timingQuantilesDays === undefined ? {} : { timingQuantilesDays }),
          ...(timingQuantileIntervals === undefined ? {} : { timingQuantileIntervals }),
          ...(sortedTiming.length === 0
            ? {}
            : {
                timingSampleCount: sortedTiming.length,
                timingEvaluations: timingEvaluations[index]!,
                timingReservoirCapacity,
                timingMethod: 'sampled_discrete_daily_hazard' as const,
                timingConfidenceMethod: 'normal_order_statistic' as const,
              }),
        };
      }),
    });
  }
  return { summaries, unresolved };
}
