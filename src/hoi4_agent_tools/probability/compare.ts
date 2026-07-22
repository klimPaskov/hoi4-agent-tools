import type {
  ComparisonSummary,
  ProbabilityAcceptanceBand,
  ProbabilityAnalysisResult,
  ScenarioAnalysis,
} from './model.js';

function raw(candidate: ScenarioAnalysis['candidates'][number] | undefined): number | undefined {
  const value = candidate?.rawValue;
  if (typeof value === 'object' && value !== null) return value.value;
  if (typeof value === 'number') return value;
  return undefined;
}

function traceSignature(
  candidate: ScenarioAnalysis['candidates'][number] | undefined,
): Set<string> {
  return new Set(
    (candidate?.trace ?? []).map(
      ({ operation, expression, applied, after }) =>
        `${operation}:${expression}:${applied}:${after?.decimal ?? ''}`,
    ),
  );
}

function attribution(
  before: ScenarioAnalysis['candidates'][number] | undefined,
  after: ScenarioAnalysis['candidates'][number] | undefined,
): string[] {
  if (before === undefined) return ['candidate added'];
  if (after === undefined) return ['candidate removed'];
  const beforeTrace = traceSignature(before);
  const afterTrace = traceSignature(after);
  const changes = [
    ...[...afterTrace].filter((item) => !beforeTrace.has(item)).map((item) => `added ${item}`),
    ...[...beforeTrace].filter((item) => !afterTrace.has(item)).map((item) => `removed ${item}`),
  ];
  if (before.eligibility !== after.eligibility)
    changes.unshift(`eligibility ${before.eligibility} -> ${after.eligibility}`);
  return changes.length > 0 ? changes : ['source or scenario metadata changed'];
}

function changedAstPaths(
  before: ScenarioAnalysis['candidates'][number] | undefined,
  after: ScenarioAnalysis['candidates'][number] | undefined,
): ComparisonSummary['scenarioChanges'][number]['changedAstPaths'] {
  const terms = (candidate: typeof before) =>
    new Map(
      (candidate?.trace ?? []).flatMap((step) => {
        const provenance = step.provenance;
        if (provenance?.astPath === undefined) return [];
        const key = JSON.stringify({
          operation: step.operation,
          expression: step.expression,
          applied: step.applied,
          after: step.after?.decimal,
          path: provenance.path,
          astPath: provenance.astPath,
        });
        return [[key, { path: provenance.path, astPath: provenance.astPath }] as const];
      }),
    );
  const previous = terms(before);
  const current = terms(after);
  return [
    ...[...current]
      .filter(([key]) => !previous.has(key))
      .map(([, source]) => ({ change: 'added' as const, ...source })),
    ...[...previous]
      .filter(([key]) => !current.has(key))
      .map(([, source]) => ({ change: 'removed' as const, ...source })),
  ];
}

function metricValue(
  candidate: ScenarioAnalysis['candidates'][number] | undefined,
  metric: ProbabilityAcceptanceBand['metric'],
): number | undefined {
  if (candidate === undefined) return undefined;
  if (metric === 'raw_value') return raw(candidate);
  if (metric === 'conditional_probability') return candidate.conditionalProbability ?? undefined;
  if (metric === 'cumulative_chance') return candidate.cumulativeChance;
  return candidate.effectiveMtthDays;
}

function insideBand(value: number | undefined, band: ProbabilityAcceptanceBand): boolean {
  return (
    value !== undefined &&
    (band.min === undefined || value >= band.min) &&
    (band.max === undefined || value <= band.max)
  );
}

export function compareProbabilityResults(
  before: ProbabilityAnalysisResult,
  after: ProbabilityAnalysisResult,
  acceptanceBands: readonly ProbabilityAcceptanceBand[] = [],
): ComparisonSummary {
  const scenarioChanges: ComparisonSummary['scenarioChanges'] = [];
  const regressions: ComparisonSummary['regressions'] = [];
  const scenarioIds = new Set([
    ...before.scenarios.map(({ id }) => id),
    ...after.scenarios.map(({ id }) => id),
  ]);
  for (const scenarioId of scenarioIds) {
    const beforeScenario = before.scenarios.find(({ id }) => id === scenarioId);
    const afterScenario = after.scenarios.find(({ id }) => id === scenarioId);
    const candidateIds = new Set([
      ...(beforeScenario?.candidates.map(({ id }) => id) ?? []),
      ...(afterScenario?.candidates.map(({ id }) => id) ?? []),
    ]);
    for (const candidateId of candidateIds) {
      const previous = beforeScenario?.candidates.find(({ id }) => id === candidateId);
      const current = afterScenario?.candidates.find(({ id }) => id === candidateId);
      const rawBefore = raw(previous);
      const rawAfter = raw(current);
      const probabilityBefore = previous?.conditionalProbability ?? undefined;
      const probabilityAfter = current?.conditionalProbability ?? undefined;
      const rankBefore = previous?.rank ?? undefined;
      const rankAfter = current?.rank ?? undefined;
      const timingBefore = previous?.effectiveMtthDays;
      const timingAfter = current?.effectiveMtthDays;
      const cumulativeBefore = previous?.cumulativeChance;
      const cumulativeAfter = current?.cumulativeChance;
      const changed =
        previous === undefined ||
        current === undefined ||
        rawBefore !== rawAfter ||
        probabilityBefore !== probabilityAfter ||
        rankBefore !== rankAfter ||
        previous.eligibility !== current.eligibility ||
        timingBefore !== timingAfter ||
        cumulativeBefore !== cumulativeAfter ||
        previous.unresolved.length !== current.unresolved.length;
      if (!changed) continue;
      scenarioChanges.push({
        scenarioId,
        candidateId,
        ...(rawBefore === undefined || rawAfter === undefined
          ? {}
          : { rawDelta: rawAfter - rawBefore }),
        ...(probabilityBefore === undefined || probabilityAfter === undefined
          ? {}
          : { probabilityDelta: probabilityAfter - probabilityBefore }),
        ...(rankBefore === undefined || rankAfter === undefined
          ? {}
          : { rankDelta: rankAfter - rankBefore }),
        ...(timingBefore === undefined || timingAfter === undefined
          ? {}
          : { timingDeltaDays: timingAfter - timingBefore }),
        ...(cumulativeBefore === undefined || cumulativeAfter === undefined
          ? {}
          : { cumulativeChanceDelta: cumulativeAfter - cumulativeBefore }),
        ...(previous === undefined ||
        current === undefined ||
        previous.eligibility === current.eligibility
          ? {}
          : {
              eligibilityChange: {
                before: previous.eligibility,
                after: current.eligibility,
              },
            }),
        unresolvedDelta: (current?.unresolved.length ?? 0) - (previous?.unresolved.length ?? 0),
        attribution: attribution(previous, current),
        changedAstPaths: changedAstPaths(previous, current),
      });
      if ((previous?.unresolved.length ?? 0) < (current?.unresolved.length ?? 0))
        regressions.push({
          code: 'UNRESOLVED_ANALYSIS_INTRODUCED',
          message: `Patch introduced unresolved analysis for ${candidateId}`,
          scenarioId,
          candidateId,
        });
      if (probabilityBefore !== undefined && probabilityBefore > 0 && probabilityAfter === 0)
        regressions.push({
          code: 'CANDIDATE_STARVED',
          message: `Patch reduces ${candidateId} from a selectable outcome to zero probability`,
          scenarioId,
          candidateId,
        });
      for (const band of acceptanceBands) {
        if (
          band.candidateId !== candidateId ||
          (band.scenarioId !== undefined && band.scenarioId !== scenarioId)
        )
          continue;
        const previousMetric = metricValue(previous, band.metric);
        const currentMetric = metricValue(current, band.metric);
        if (insideBand(previousMetric, band) && !insideBand(currentMetric, band))
          regressions.push({
            code: 'ACCEPTANCE_BAND_REGRESSION',
            message: `Patch moves ${candidateId} outside acceptance band ${band.id}`,
            scenarioId,
            candidateId,
          });
      }
    }
  }
  return {
    beforeAnalysisId: before.analysisId,
    afterAnalysisId: after.analysisId,
    assumptionsChanged: before.metadata.scenarioHash !== after.metadata.scenarioHash,
    adapterChanged:
      before.metadata.adapterId !== after.metadata.adapterId ||
      before.metadata.adapterVersion !== after.metadata.adapterVersion,
    scenarioChanges,
    regressions,
  };
}
