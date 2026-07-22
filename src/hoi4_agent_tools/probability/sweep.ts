import type { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import { ServiceError } from '../core/result.js';
import type {
  LocalElasticity,
  PairwiseInteraction,
  ProbabilityScenario,
  RankReversal,
  SweepPoint,
  WeightedSurface,
} from './model.js';
import { conditionBreakpointValues, evaluateSurfaceScenarios } from './evaluation.js';

export interface SweepRequest {
  paths: string[];
  steps: number;
  pairwise: boolean;
  findRankReversals: boolean;
}

export interface SweepResult {
  points: SweepPoint[];
  rankReversals: RankReversal[];
  breakpoints: SweepPoint[];
  localElasticities: LocalElasticity[];
  pairwiseInteractions: PairwiseInteraction[];
}

const MAX_SWEEP_POINTS = 250_000;

function declaredValues(
  surface: WeightedSurface,
  scenario: ProbabilityScenario,
  path: string,
  steps: number,
): number[] {
  const uncertain = scenario.uncertainInputs?.find((input) => input.path === path);
  if (uncertain?.range !== undefined)
    return [
      ...new Set([
        ...values(uncertain.range, steps),
        ...conditionBreakpointValues(surface, uncertain.range.min, uncertain.range.max),
      ]),
    ].sort((left, right) => left - right);
  if (uncertain?.alternatives !== undefined) {
    const values = uncertain.alternatives.filter(
      (value): value is number => typeof value === 'number',
    );
    if (values.length > 0) return [...new Set(values)].sort((left, right) => left - right);
  }
  const current = scenario.state[path];
  if (typeof current === 'number') return [current];
  throw new ServiceError(
    'PROBABILITY_SWEEP_RANGE_REQUIRED',
    'Every sweep path requires a scenario range, numeric alternatives, or numeric state value',
    { scenarioId: scenario.id, path },
  );
}

function values(range: { min: number; max: number }, steps: number): number[] {
  if (range.min === range.max) return [range.min];
  return Array.from(
    { length: steps },
    (_, index) => range.min + ((range.max - range.min) * index) / (steps - 1),
  );
}

function point(
  surface: WeightedSurface,
  scenario: ProbabilityScenario,
  definitions: ClausewitzEvaluationDefinitions,
  path: string,
  value: number,
  assigned: Record<string, number>,
): SweepPoint {
  const evaluated = evaluateSurfaceScenarios(
    surface,
    [{ ...scenario, state: { ...scenario.state, ...assigned }, uncertainInputs: [] }],
    definitions,
  )[0]!;
  return {
    scenarioId: scenario.id,
    path,
    value,
    ...(Object.keys(assigned).length > 1 ? { values: assigned } : {}),
    candidates: evaluated.candidates.map((candidate) => ({
      id: candidate.id,
      ...(typeof candidate.rawValue === 'object' && candidate.rawValue !== null
        ? { rawValue: candidate.rawValue.value }
        : {}),
      ...(candidate.conditionalProbability === undefined ||
      candidate.conditionalProbability === null
        ? {}
        : { conditionalProbability: candidate.conditionalProbability }),
      ...(candidate.rank === undefined || candidate.rank === null ? {} : { rank: candidate.rank }),
    })),
  };
}

function leader(point: SweepPoint): string | undefined {
  return point.candidates.find(({ rank }) => rank === 1)?.id;
}

function discoverReversals(points: readonly SweepPoint[]): RankReversal[] {
  const output: RankReversal[] = [];
  const groups = new Map<string, SweepPoint[]>();
  for (const item of points) {
    const key = `${item.scenarioId}:${item.path}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.value - right.value);
    for (let index = 1; index < group.length; index += 1) {
      const before = group[index - 1]!;
      const after = group[index]!;
      const beforeLeader = leader(before);
      const afterLeader = leader(after);
      if (beforeLeader === undefined || afterLeader === undefined || beforeLeader === afterLeader)
        continue;
      output.push({
        scenarioId: before.scenarioId,
        path: before.path,
        between: [before.value, after.value],
        beforeLeader,
        afterLeader,
      });
    }
  }
  return output;
}

const pointCandidateMaps = new WeakMap<SweepPoint, Map<string, SweepPoint['candidates'][number]>>();

function candidateMetrics(
  point: SweepPoint,
  candidateId: string,
): Array<{ metric: LocalElasticity['metric']; value: number }> {
  let candidates = pointCandidateMaps.get(point);
  if (candidates === undefined) {
    candidates = new Map(point.candidates.map((candidate) => [candidate.id, candidate]));
    pointCandidateMaps.set(point, candidates);
  }
  const candidate = candidates.get(candidateId);
  if (candidate === undefined) return [];
  return [
    ...(candidate.rawValue === undefined
      ? []
      : [{ metric: 'raw_value' as const, value: candidate.rawValue }]),
    ...(candidate.conditionalProbability === undefined
      ? []
      : [
          {
            metric: 'conditional_probability' as const,
            value: candidate.conditionalProbability,
          },
        ]),
  ];
}

function localElasticities(points: readonly SweepPoint[]): LocalElasticity[] {
  const output: LocalElasticity[] = [];
  const groups = new Map<string, SweepPoint[]>();
  for (const point of points) {
    if (point.values !== undefined) continue;
    const key = `${point.scenarioId}\0${point.path}`;
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.value - right.value);
    for (let index = 1; index < group.length; index += 1) {
      const before = group[index - 1]!;
      const after = group[index]!;
      const deltaInput = after.value - before.value;
      if (deltaInput === 0) continue;
      for (const candidate of after.candidates) {
        const afterMetrics = candidateMetrics(after, candidate.id);
        const beforeMetrics = new Map(
          candidateMetrics(before, candidate.id).map(({ metric, value }) => [metric, value]),
        );
        for (const { metric, value: afterValue } of afterMetrics) {
          const beforeValue = beforeMetrics.get(metric);
          if (beforeValue === undefined) continue;
          const slope = (afterValue - beforeValue) / deltaInput;
          const midpointInput = (before.value + after.value) / 2;
          const midpointOutput = (beforeValue + afterValue) / 2;
          output.push({
            scenarioId: after.scenarioId,
            path: after.path,
            candidateId: candidate.id,
            metric,
            between: [before.value, after.value],
            slope,
            ...(midpointInput === 0 || midpointOutput === 0
              ? {}
              : { elasticity: (slope * midpointInput) / midpointOutput }),
          });
        }
      }
    }
  }
  return output;
}

function pairwiseInteractions(points: readonly SweepPoint[]): PairwiseInteraction[] {
  const output: PairwiseInteraction[] = [];
  const groups = new Map<string, SweepPoint[]>();
  for (const point of points) {
    if (point.values === undefined) continue;
    const key = `${point.scenarioId}\0${point.path}`;
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const paths = first.path.split('|');
    if (paths.length !== 2) continue;
    const [leftPath, rightPath] = paths as [string, string];
    const leftValues = [...new Set(group.map(({ values }) => values![leftPath]!))].sort(
      (left, right) => left - right,
    );
    const rightValues = [...new Set(group.map(({ values }) => values![rightPath]!))].sort(
      (left, right) => left - right,
    );
    const byCoordinates = new Map(
      group.map((point) => [`${point.values![leftPath]}\0${point.values![rightPath]}`, point]),
    );
    for (let leftIndex = 1; leftIndex < leftValues.length; leftIndex += 1) {
      for (let rightIndex = 1; rightIndex < rightValues.length; rightIndex += 1) {
        const leftLow = leftValues[leftIndex - 1]!;
        const leftHigh = leftValues[leftIndex]!;
        const rightLow = rightValues[rightIndex - 1]!;
        const rightHigh = rightValues[rightIndex]!;
        const lowLow = byCoordinates.get(`${leftLow}\0${rightLow}`)!;
        const highLow = byCoordinates.get(`${leftHigh}\0${rightLow}`)!;
        const lowHigh = byCoordinates.get(`${leftLow}\0${rightHigh}`)!;
        const highHigh = byCoordinates.get(`${leftHigh}\0${rightHigh}`)!;
        for (const candidate of highHigh.candidates) {
          for (const { metric, value: highHighValue } of candidateMetrics(highHigh, candidate.id)) {
            const lowLowValue = candidateMetrics(lowLow, candidate.id).find(
              (item) => item.metric === metric,
            )?.value;
            const highLowValue = candidateMetrics(highLow, candidate.id).find(
              (item) => item.metric === metric,
            )?.value;
            const lowHighValue = candidateMetrics(lowHigh, candidate.id).find(
              (item) => item.metric === metric,
            )?.value;
            if (
              lowLowValue === undefined ||
              highLowValue === undefined ||
              lowHighValue === undefined
            )
              continue;
            const mixedDifference = highHighValue - highLowValue - lowHighValue + lowLowValue;
            output.push({
              scenarioId: highHigh.scenarioId,
              paths: [leftPath, rightPath],
              candidateId: candidate.id,
              metric,
              cell: { left: [leftLow, leftHigh], right: [rightLow, rightHigh] },
              mixedDifference,
              mixedDifferencePerUnit:
                mixedDifference / ((leftHigh - leftLow) * (rightHigh - rightLow)),
            });
          }
        }
      }
    }
  }
  return output;
}

export function sweepSurface(
  surface: WeightedSurface,
  scenarios: readonly ProbabilityScenario[],
  definitions: ClausewitzEvaluationDefinitions,
  request: SweepRequest,
  signal?: AbortSignal,
): SweepResult {
  const estimate = request.pairwise
    ? scenarios.length *
      Math.max(1, (request.paths.length * (request.paths.length - 1)) / 2) *
      request.steps ** 2
    : scenarios.length * request.paths.length * request.steps;
  if (estimate > MAX_SWEEP_POINTS)
    throw new ServiceError(
      'PROBABILITY_SWEEP_LIMIT',
      'Requested sweep exceeds the analysis point limit',
      {
        estimatedPoints: estimate,
        limit: MAX_SWEEP_POINTS,
      },
    );
  const points: SweepPoint[] = [];
  for (const scenario of scenarios) {
    if (request.pairwise && request.paths.length > 1) {
      for (let leftIndex = 0; leftIndex < request.paths.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < request.paths.length; rightIndex += 1) {
          const leftPath = request.paths[leftIndex]!;
          const rightPath = request.paths[rightIndex]!;
          const leftValues = declaredValues(surface, scenario, leftPath, request.steps);
          const rightValues = declaredValues(surface, scenario, rightPath, request.steps);
          for (const left of leftValues) {
            for (const right of rightValues) {
              if ((points.length & 1023) === 0) signal?.throwIfAborted();
              if (points.length >= MAX_SWEEP_POINTS)
                throw new ServiceError(
                  'PROBABILITY_SWEEP_LIMIT',
                  'Expanded threshold-aware sweep exceeds the analysis point limit',
                  { limit: MAX_SWEEP_POINTS },
                );
              points.push(
                point(surface, scenario, definitions, `${leftPath}|${rightPath}`, left, {
                  [leftPath]: left,
                  [rightPath]: right,
                }),
              );
            }
          }
        }
      }
    } else {
      for (const path of request.paths) {
        for (const value of declaredValues(surface, scenario, path, request.steps)) {
          if ((points.length & 1023) === 0) signal?.throwIfAborted();
          if (points.length >= MAX_SWEEP_POINTS)
            throw new ServiceError(
              'PROBABILITY_SWEEP_LIMIT',
              'Expanded threshold-aware sweep exceeds the analysis point limit',
              { limit: MAX_SWEEP_POINTS },
            );
          points.push(point(surface, scenario, definitions, path, value, { [path]: value }));
        }
      }
    }
  }
  const rankReversals = request.findRankReversals ? discoverReversals(points) : [];
  const breakpoints = rankReversals.flatMap((reversal) => {
    const [low, high] = reversal.between;
    return points.filter(
      ({ scenarioId, path, value }) =>
        scenarioId === reversal.scenarioId &&
        path === reversal.path &&
        (value === low || value === high),
    );
  });
  return {
    points,
    rankReversals,
    breakpoints,
    localElasticities: localElasticities(points),
    pairwiseInteractions: pairwiseInteractions(points),
  };
}
