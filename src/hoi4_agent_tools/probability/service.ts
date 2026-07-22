import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import { ClausewitzEvaluationDefinitions } from '../core/clausewitz-evaluation.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import type { ArtifactLink } from '../core/result.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { ServiceError } from '../core/result.js';
import { PACKAGE_VERSION } from '../version.js';
import { probabilityAdapter, probabilityAdapters } from './adapters.js';
import { compareProbabilityResults } from './compare.js';
import { evaluateExactCandidates, evaluateSurfaceScenarios } from './evaluation.js';
import {
  VERIFIED_GAME_CHECKSUM,
  VERIFIED_GAME_RAW_VERSION,
  VERIFIED_GAME_VERSION,
} from './model.js';
import type {
  AdapterDescriptor,
  CandidateAnalysis,
  ComparisonSummary,
  CustomWeightedPoolManifest,
  GameVersionVerification,
  ProbabilityAdapterId,
  ProbabilityAcceptanceBand,
  ProbabilityAnalysisResult,
  ProbabilityDiagnosticThresholds,
  ProbabilityMetric,
  ProbabilitySamplingMethod,
  ProbabilityScenarioSet,
  ProbabilitySourceInput,
  ProbabilityUnresolved,
  SequenceSummary,
  SimulationSummary,
  WeightedSurface,
} from './model.js';
import { renderProbabilityResult, type ProbabilityVisual } from './render.js';
import { analyzeSequence } from './sequence.js';
import { simulateSurface } from './simulation.js';
import { discoverWeightedSurface } from './source-analysis.js';
import { sweepSurface, type SweepRequest } from './sweep.js';

export interface ProbabilityServiceContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  refresh?: boolean;
}

export interface ProbabilityAnalysisRequest extends ProbabilityServiceContext {
  adapter: ProbabilityAdapterId;
  source: ProbabilitySourceInput;
  scenarioSet: ProbabilityScenarioSet;
  candidatePool?: string[];
  horizonDays?: number;
  metrics?: ProbabilityMetric[];
  acceptanceBands?: ProbabilityAcceptanceBand[];
  diagnosticThresholds?: ProbabilityDiagnosticThresholds;
  outputs?: Array<'json' | ProbabilityVisual>;
}

export interface ProbabilitySweepRequest extends ProbabilityAnalysisRequest {
  sweep: SweepRequest;
}

export interface ProbabilitySimulationRequest extends ProbabilityAnalysisRequest {
  samples: number;
  seed: number;
  confidenceLevel: number;
  samplingMethod?: ProbabilitySamplingMethod;
}

export interface ProbabilitySequenceRequest extends ProbabilityServiceContext {
  scenarioSet: ProbabilityScenarioSet;
  customPoolManifest: CustomWeightedPoolManifest;
  horizonDays: number;
  maxSteps: number;
  samples: number;
  seed: number;
  confidenceLevel: number;
  acceptanceBands?: ProbabilityAcceptanceBand[];
  diagnosticThresholds?: ProbabilityDiagnosticThresholds;
  outputs?: Array<'json' | ProbabilityVisual>;
}

export interface ProbabilityCompareRequest extends ProbabilityServiceContext {
  adapter: ProbabilityAdapterId;
  before: ProbabilitySourceInput;
  after: ProbabilitySourceInput;
  scenarioSet: ProbabilityScenarioSet;
  candidatePool?: string[];
  horizonDays?: number;
  acceptanceBands?: ProbabilityAcceptanceBand[];
  diagnosticThresholds?: ProbabilityDiagnosticThresholds;
  outputs?: Array<'json' | ProbabilityVisual>;
}

export interface ProbabilityRenderRequest extends ProbabilityServiceContext {
  analysisId: string;
  expectedScenarioHash?: string;
  outputs: ProbabilityVisual[];
  includeHtml: boolean;
  filter?: {
    scenarioIds?: string[];
    candidateIds?: string[];
    diagnosticSeverities?: Array<'info' | 'warning' | 'error' | 'blocker'>;
    sourcePaths?: string[];
    metrics?: ProbabilityMetric[];
    offset: number;
    limit: number;
  };
}

export interface ProbabilityInspectResult {
  adapters: AdapterDescriptor[];
  surface?: {
    id: string;
    adapter: AdapterDescriptor;
    poolComplete: boolean;
    sourceRevision: string;
    sourceHash: string;
    gameVersionVerification: GameVersionVerification;
    candidateCount: number;
    candidates: Array<{
      id: string;
      sourceKind: string;
      provenance: WeightedSurface['candidates'][number]['provenance'];
      hasEligibility: boolean;
      hasWeightBlock: boolean;
      requiredInputs: string[];
      referencedProvenance: WeightedSurface['candidates'][number]['provenance'];
      analysisSupport: 'exact' | 'score_only' | 'requires_scenario' | 'requires_complete_pool';
    }>;
    requiredInputs: string[];
    unsupported: ProbabilityUnresolved[];
  };
  artifacts: ArtifactLink[];
  filesScanned: string[];
}

interface AnalyzerState {
  byId: Map<string, ProbabilityAnalysisResult>;
  byCacheKey: Map<string, ProbabilityAnalysisResult>;
}

const states = new WeakMap<CoreEngine, AnalyzerState>();

function analyzerState(engine: CoreEngine): AnalyzerState {
  let state = states.get(engine);
  if (state === undefined) {
    state = { byId: new Map(), byCacheKey: new Map() };
    states.set(engine, state);
  }
  return state;
}

const DEFAULT_DIAGNOSTIC_THRESHOLDS: Required<ProbabilityDiagnosticThresholds> = {
  dominantProbability: 0.9,
  dominantScenarioPrevalence: 0.8,
  starvedProbability: 0.01,
  negligibleCumulativeChance: 0.01,
  extremeGrowthRatio: 1_000,
  thresholdCliffDelta: 0.5,
  rareOutcomeMinimumObservations: 20,
};

function resolvedThresholds(
  values: ProbabilityDiagnosticThresholds | undefined,
): Required<ProbabilityDiagnosticThresholds> {
  return { ...DEFAULT_DIAGNOSTIC_THRESHOLDS, ...values };
}

function candidateMetric(
  candidate: ProbabilityAnalysisResult['scenarios'][number]['candidates'][number] | undefined,
  metric: ProbabilityAcceptanceBand['metric'],
): number | undefined {
  if (candidate === undefined) return undefined;
  if (metric === 'conditional_probability') return candidate.conditionalProbability ?? undefined;
  if (metric === 'cumulative_chance') return candidate.cumulativeChance;
  if (metric === 'effective_mtth_days') return candidate.effectiveMtthDays;
  return typeof candidate.rawValue === 'object' && candidate.rawValue !== null
    ? candidate.rawValue.value
    : undefined;
}

function insideBand(value: number, band: ProbabilityAcceptanceBand): boolean {
  return (
    (band.min === undefined || value >= band.min) && (band.max === undefined || value <= band.max)
  );
}

function filterCandidateMetrics(
  candidate: CandidateAnalysis,
  metrics: ReadonlySet<ProbabilityMetric>,
): CandidateAnalysis {
  if (metrics.size === 0) return candidate;
  const {
    rawValue: _rawValue,
    rawInterval: _rawInterval,
    conditionalProbability: _conditionalProbability,
    exactConditionalProbability: _exactConditionalProbability,
    pathProbability: _pathProbability,
    exactPathProbability: _exactPathProbability,
    pathProbabilityInterval: _pathProbabilityInterval,
    conditionalProbabilityInterval: _conditionalProbabilityInterval,
    confidenceInterval: _confidenceInterval,
    sampledFrequency: _sampledFrequency,
    effectiveMtthDays: _effectiveMtthDays,
    timingModel: _timingModel,
    timingQuantilesDays: _timingQuantilesDays,
    timingQuantileIntervals: _timingQuantileIntervals,
    timingSampleCount: _timingSampleCount,
    timingEvaluations: _timingEvaluations,
    timingReservoirCapacity: _timingReservoirCapacity,
    timingMethod: _timingMethod,
    timingConfidenceMethod: _timingConfidenceMethod,
    cumulativeChance: _cumulativeChance,
    cumulativeChanceInterval: _cumulativeChanceInterval,
    ...base
  } = candidate;
  return {
    ...base,
    ...(metrics.has('raw_value')
      ? {
          ...(candidate.rawValue === undefined ? {} : { rawValue: candidate.rawValue }),
          ...(candidate.rawInterval === undefined ? {} : { rawInterval: candidate.rawInterval }),
        }
      : {}),
    ...(metrics.has('conditional_probability')
      ? {
          ...(candidate.conditionalProbability === undefined
            ? {}
            : { conditionalProbability: candidate.conditionalProbability }),
          ...(candidate.exactConditionalProbability === undefined
            ? {}
            : { exactConditionalProbability: candidate.exactConditionalProbability }),
          ...(candidate.pathProbability === undefined
            ? {}
            : { pathProbability: candidate.pathProbability }),
          ...(candidate.exactPathProbability === undefined
            ? {}
            : { exactPathProbability: candidate.exactPathProbability }),
          ...(candidate.pathProbabilityInterval === undefined
            ? {}
            : { pathProbabilityInterval: candidate.pathProbabilityInterval }),
          ...(candidate.conditionalProbabilityInterval === undefined
            ? {}
            : { conditionalProbabilityInterval: candidate.conditionalProbabilityInterval }),
          ...(candidate.confidenceInterval === undefined
            ? {}
            : { confidenceInterval: candidate.confidenceInterval }),
          ...(candidate.sampledFrequency === undefined
            ? {}
            : { sampledFrequency: candidate.sampledFrequency }),
        }
      : {}),
    ...(metrics.has('effective_mtth_days')
      ? {
          ...(candidate.effectiveMtthDays === undefined
            ? {}
            : { effectiveMtthDays: candidate.effectiveMtthDays }),
          ...(candidate.timingModel === undefined ? {} : { timingModel: candidate.timingModel }),
          ...(candidate.timingQuantilesDays === undefined
            ? {}
            : { timingQuantilesDays: candidate.timingQuantilesDays }),
          ...(candidate.timingQuantileIntervals === undefined
            ? {}
            : { timingQuantileIntervals: candidate.timingQuantileIntervals }),
          ...(candidate.timingSampleCount === undefined
            ? {}
            : { timingSampleCount: candidate.timingSampleCount }),
          ...(candidate.timingEvaluations === undefined
            ? {}
            : { timingEvaluations: candidate.timingEvaluations }),
          ...(candidate.timingReservoirCapacity === undefined
            ? {}
            : { timingReservoirCapacity: candidate.timingReservoirCapacity }),
          ...(candidate.timingMethod === undefined ? {} : { timingMethod: candidate.timingMethod }),
          ...(candidate.timingConfidenceMethod === undefined
            ? {}
            : { timingConfidenceMethod: candidate.timingConfidenceMethod }),
        }
      : {}),
    ...(metrics.has('cumulative_chance')
      ? {
          ...(candidate.cumulativeChance === undefined
            ? {}
            : { cumulativeChance: candidate.cumulativeChance }),
          ...(candidate.cumulativeChanceInterval === undefined
            ? {}
            : { cumulativeChanceInterval: candidate.cumulativeChanceInterval }),
        }
      : {}),
  };
}

function diagnosticsFor(
  scenarios: ProbabilityAnalysisResult['scenarios'],
  surface: WeightedSurface,
  extra: {
    sweep?: NonNullable<ProbabilityAnalysisResult['sweep']>;
    simulation?: SimulationSummary[];
    acceptanceBands?: ProbabilityAcceptanceBand[];
    diagnosticThresholds?: ProbabilityDiagnosticThresholds;
    unresolved?: ProbabilityUnresolved[];
  } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const thresholds = resolvedThresholds(extra.diagnosticThresholds);
  if (!surface.poolComplete && surface.adapter.completePoolRequired)
    diagnostics.push({
      code: 'PROBABILITY_CANDIDATE_POOL_INCOMPLETE',
      severity: 'warning',
      category: 'validation',
      message:
        'The complete candidate pool is not proven, so normalized probabilities are withheld',
      details: { adapterId: surface.adapter.id, candidatesFound: surface.candidates.length },
    });
  if (
    surface.adapter.id === 'event_option_ai_chance' &&
    surface.candidates.length > 0 &&
    surface.candidates.every(({ eligibilityBlock }) => eligibilityBlock !== undefined)
  )
    diagnostics.push({
      code: 'EVENT_OPTION_FALLBACK_NOT_PROVEN',
      severity: 'warning',
      category: 'validation',
      message: 'Every discovered option is gated; no unconditional AI fallback option is proven',
    });
  for (const scenario of scenarios) {
    const probabilities = scenario.candidates.flatMap(({ conditionalProbability }) =>
      conditionalProbability === undefined || conditionalProbability === null
        ? []
        : [conditionalProbability],
    );
    if (probabilities.some((probability) => probability >= thresholds.dominantProbability))
      diagnostics.push({
        code: 'PROBABILITY_DOMINANT_OUTCOME',
        severity: 'warning',
        category: 'design',
        message: `Scenario ${scenario.id} has an outcome at or above the configured dominance threshold`,
        details: { scenarioId: scenario.id, maximum: Math.max(...probabilities) },
      });
    for (const candidate of scenario.candidates) {
      if (
        candidate.eligibility === 'true' &&
        candidate.conditionalProbability !== undefined &&
        candidate.conditionalProbability !== null &&
        candidate.conditionalProbability <= thresholds.starvedProbability
      )
        diagnostics.push({
          code: 'PROBABILITY_STARVED_OUTCOME',
          severity: 'warning',
          category: 'design',
          message: `${candidate.id} is eligible but at or below the configured starvation threshold in ${scenario.id}`,
          ...(candidate.provenance[0]?.location === undefined
            ? {}
            : { location: candidate.provenance[0].location }),
          details: { scenarioId: scenario.id, candidateId: candidate.id },
        });
      if (
        surface.adapter.id === 'event_option_ai_chance' &&
        candidate.conditionalProbability !== undefined &&
        candidate.conditionalProbability !== null &&
        candidate.conditionalProbability > 0 &&
        candidate.conditionalProbability < 0.01
      )
        diagnostics.push({
          code: 'EVENT_OPTION_D100_QUANTIZATION_RISK',
          severity: 'warning',
          category: 'design',
          message: `${candidate.id} is below one percent; verified event-option runtime selection has d100 granularity`,
          ...(candidate.provenance[0]?.location === undefined
            ? {}
            : { location: candidate.provenance[0].location }),
          details: { scenarioId: scenario.id, candidateId: candidate.id },
        });
      const finalTrace = candidate.trace.at(-1);
      if (candidate.unresolved.some(({ code }) => code === 'VALUE_NON_FINITE'))
        diagnostics.push({
          code: 'PROBABILITY_NON_FINITE_VALUE',
          severity: 'error',
          category: 'validation',
          message: `${candidate.id} produces a non-finite value in ${scenario.id}; the result is withheld`,
          ...(candidate.provenance[0]?.location === undefined
            ? {}
            : { location: candidate.provenance[0].location }),
          details: { scenarioId: scenario.id, candidateId: candidate.id },
        });
      if ((finalTrace?.after?.value ?? 0) < 0)
        diagnostics.push({
          code: 'PROBABILITY_NEGATIVE_VALUE_CLAMPED',
          severity: 'warning',
          category: 'validation',
          message: `${candidate.id} evaluates below zero in ${scenario.id} and is clamped before selection`,
          ...(candidate.provenance[0]?.location === undefined
            ? {}
            : { location: candidate.provenance[0].location }),
          details: {
            scenarioId: scenario.id,
            candidateId: candidate.id,
            value: finalTrace!.after!.value,
          },
        });
      for (const step of candidate.trace) {
        const before = Math.abs(step.before?.value ?? 0);
        const after = Math.abs(step.after?.value ?? 0);
        if (before > 0 && after / before >= thresholds.extremeGrowthRatio)
          diagnostics.push({
            code: 'PROBABILITY_EXTREME_MODIFIER_GROWTH',
            severity: 'warning',
            category: 'design',
            message: `${candidate.id} exceeds the configured modifier-growth ratio in one step`,
            ...(step.provenance?.location === undefined
              ? {}
              : { location: step.provenance.location }),
            details: { scenarioId: scenario.id, candidateId: candidate.id, before, after },
          });
      }
      if (
        candidate.conditionalProbabilityInterval !== undefined &&
        candidate.conditionalProbabilityInterval.high -
          candidate.conditionalProbabilityInterval.low >=
          0.5
      )
        diagnostics.push({
          code: 'PROBABILITY_UNKNOWN_INPUT_DOMINATES_RESULT',
          severity: 'warning',
          category: 'validation',
          message: `Uncertain inputs span at least 50 percentage points for ${candidate.id} in ${scenario.id}`,
          details: {
            scenarioId: scenario.id,
            candidateId: candidate.id,
            interval: candidate.conditionalProbabilityInterval,
          },
        });
      if (
        candidate.cumulativeChance !== undefined &&
        candidate.cumulativeChance < thresholds.negligibleCumulativeChance &&
        (scenario.horizonDays ?? 0) > 0
      )
        diagnostics.push({
          code: 'MTTH_HORIZON_CHANCE_NEGLIGIBLE',
          severity: 'info',
          category: 'design',
          message: `${candidate.id} is below the configured cumulative-chance threshold inside the requested horizon`,
          details: {
            scenarioId: scenario.id,
            candidateId: candidate.id,
            horizonDays: scenario.horizonDays,
            cumulativeChance: candidate.cumulativeChance,
          },
        });
    }
    if (
      surface.adapter.selectionRule === 'proportional_categorical' &&
      scenario.poolComplete &&
      scenario.candidates.some(({ eligibility }) => eligibility === 'true') &&
      scenario.candidates
        .filter(({ eligibility }) => eligibility === 'true')
        .every(
          ({ rawValue }) =>
            typeof rawValue === 'object' && rawValue !== null && rawValue.value === 0,
        )
    )
      diagnostics.push({
        code: 'PROBABILITY_ALL_ELIGIBLE_VALUES_ZERO',
        severity: 'warning',
        category: 'validation',
        message: `All eligible values are zero in ${scenario.id}; adapter fallback behavior controls the result`,
        details: { scenarioId: scenario.id, adapterId: surface.adapter.id },
      });
  }
  for (const scenario of scenarios)
    if (scenario.timingIntervals?.some(({ eligibility }) => eligibility === 'unresolved') === true)
      diagnostics.push({
        code: 'MTTH_SCHEDULE_INTERVAL_UNRESOLVED',
        severity: 'warning',
        category: 'validation',
        message: `Scenario ${scenario.id} has a timing interval whose eligibility cannot be established`,
        details: {
          scenarioId: scenario.id,
          unresolvedIntervals: scenario.timingIntervals.filter(
            ({ eligibility }) => eligibility === 'unresolved',
          ),
        },
      });
  for (const candidate of surface.candidates) {
    const results = scenarios.flatMap((scenario) => {
      const result = scenario.candidates.find(({ id }) => id === candidate.id);
      return result === undefined ? [] : [{ scenario, result }];
    });
    if (results.length > 0 && results.every(({ result }) => result.eligibility === 'false'))
      diagnostics.push({
        code: 'PROBABILITY_OUTCOME_NEVER_ELIGIBLE',
        severity: 'warning',
        category: 'design',
        message: `${candidate.id} is never eligible across the supplied scenarios`,
        ...(candidate.provenance[0]?.location === undefined
          ? {}
          : { location: candidate.provenance[0].location }),
        details: { candidateId: candidate.id, scenarios: results.length },
      });
    const modifierKeys = new Set(
      results.flatMap(({ result }) =>
        result.trace
          .filter(({ operation }) => operation !== 'eligibility')
          .map(({ operation, expression }) => `${operation}:${expression}`),
      ),
    );
    for (const key of modifierKeys) {
      const applications = results.flatMap(({ result }) =>
        result.trace.filter(({ operation, expression }) => `${operation}:${expression}` === key),
      );
      if (applications.length > 0 && applications.every(({ applied }) => applied === 'false'))
        diagnostics.push({
          code: 'PROBABILITY_MODIFIER_UNSATISFIED_IN_SCENARIOS',
          severity: 'info',
          category: 'design',
          message: `${candidate.id} modifier ${key} is not active in any supplied scenario`,
          ...(applications[0]?.provenance?.location === undefined
            ? {}
            : { location: applications[0].provenance.location }),
          details: { candidateId: candidate.id, modifier: key, scenarios: results.length },
        });
    }
    const sourceTerms = [
      ...new Map(
        results
          .flatMap(({ result }) => result.trace)
          .filter(
            ({ operation, conditionExpression }) =>
              operation !== 'eligibility' && conditionExpression !== undefined,
          )
          .map((step) => [
            hashCanonical({
              path: step.provenance?.path,
              astPath: step.provenance?.astPath,
              location: step.provenance?.location,
              operation: step.operation,
              expression: step.expression,
              conditionExpression: step.conditionExpression,
            }),
            step,
          ]),
      ).values(),
    ];
    const exactModifierGroups = new Map<string, typeof sourceTerms>();
    const conditionGroups = new Map<string, typeof sourceTerms>();
    for (const term of sourceTerms) {
      const exactKey = `${term.operation}\0${term.expression}\0${term.conditionExpression ?? ''}`;
      exactModifierGroups.set(exactKey, [...(exactModifierGroups.get(exactKey) ?? []), term]);
      const conditionKey = `${term.operation}\0${term.conditionExpression ?? ''}`;
      conditionGroups.set(conditionKey, [...(conditionGroups.get(conditionKey) ?? []), term]);
    }
    for (const [signature, terms] of exactModifierGroups) {
      if (terms.length < 2) continue;
      diagnostics.push({
        code: 'PROBABILITY_DUPLICATE_MODIFIER',
        severity: 'warning',
        category: 'design',
        message: `${candidate.id} repeats the same modifier operation and condition`,
        ...(terms[0]?.provenance?.location === undefined
          ? {}
          : { location: terms[0].provenance.location }),
        details: { candidateId: candidate.id, signature, occurrences: terms.length },
      });
    }
    for (const [condition, terms] of conditionGroups) {
      if (new Set(terms.map(({ expression }) => expression)).size < 2) continue;
      diagnostics.push({
        code: 'PROBABILITY_CONFLICTING_MODIFIER_CONDITION',
        severity: 'warning',
        category: 'design',
        message: `${candidate.id} applies different modifier values under the same condition`,
        ...(terms[0]?.provenance?.location === undefined
          ? {}
          : { location: terms[0].provenance.location }),
        details: {
          candidateId: candidate.id,
          condition,
          expressions: [...new Set(terms.map(({ expression }) => expression))],
        },
      });
    }
  }
  const dominantCounts = new Map<string, number>();
  for (const scenario of scenarios) {
    const dominant = scenario.candidates.find(
      ({ conditionalProbability }) =>
        conditionalProbability !== undefined &&
        conditionalProbability !== null &&
        conditionalProbability >= thresholds.dominantProbability,
    );
    if (dominant !== undefined)
      dominantCounts.set(dominant.id, (dominantCounts.get(dominant.id) ?? 0) + 1);
  }
  for (const [candidateId, count] of dominantCounts) {
    if (scenarios.length >= 2 && count / scenarios.length >= thresholds.dominantScenarioPrevalence)
      diagnostics.push({
        code: 'PROBABILITY_OUTCOME_DOMINANT_ACROSS_SCENARIOS',
        severity: 'warning',
        category: 'design',
        message: `${candidateId} exceeds the configured dominance threshold in ${count} of ${scenarios.length} supplied scenarios`,
        details: { candidateId, dominantScenarios: count, suppliedScenarios: scenarios.length },
      });
  }
  const orderedSweep = [...(extra.sweep?.points ?? [])].sort(
    (left, right) =>
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.path.localeCompare(right.path) ||
      left.value - right.value,
  );
  for (let index = 1; index < orderedSweep.length; index += 1) {
    const before = orderedSweep[index - 1]!;
    const after = orderedSweep[index]!;
    if (before.scenarioId !== after.scenarioId || before.path !== after.path) continue;
    for (const candidate of after.candidates) {
      const previous = before.candidates.find(({ id }) => id === candidate.id);
      const beforeValue = previous?.conditionalProbability ?? previous?.rawValue;
      const afterValue = candidate.conditionalProbability ?? candidate.rawValue;
      if (
        beforeValue !== undefined &&
        afterValue !== undefined &&
        Math.abs(afterValue - beforeValue) >= thresholds.thresholdCliffDelta
      )
        diagnostics.push({
          code: 'PROBABILITY_SWEEP_THRESHOLD_CLIFF',
          severity: 'warning',
          category: 'design',
          message: `${candidate.id} exceeds the configured change threshold between adjacent sweep points`,
          details: {
            scenarioId: after.scenarioId,
            candidateId: candidate.id,
            path: after.path,
            between: [before.value, after.value],
            delta: afterValue - beforeValue,
          },
        });
    }
  }
  for (const band of extra.acceptanceBands ?? []) {
    const matchingScenarios = scenarios.filter(
      ({ id }) => band.scenarioId === undefined || band.scenarioId === id,
    );
    if (matchingScenarios.length === 0)
      diagnostics.push({
        code: 'PROBABILITY_ACCEPTANCE_BAND_UNRESOLVED',
        severity: 'warning',
        category: 'validation',
        message: `Acceptance band ${band.id} names no supplied scenario`,
        details: { band },
      });
    for (const scenario of matchingScenarios) {
      const candidate = scenario.candidates.find(({ id }) => id === band.candidateId);
      const value = candidateMetric(candidate, band.metric);
      if (value === undefined) {
        diagnostics.push({
          code: 'PROBABILITY_ACCEPTANCE_BAND_UNRESOLVED',
          severity: 'warning',
          category: 'validation',
          message: `Acceptance band ${band.id} cannot be evaluated for ${scenario.id}`,
          details: { band, scenarioId: scenario.id },
        });
        if (band.min !== undefined && band.min > 0)
          diagnostics.push({
            code: 'PROBABILITY_INTENDED_OUTCOME_UNREACHABLE',
            severity: 'warning',
            category: 'design',
            message: `${band.candidateId} cannot be shown to reach the intended minimum in ${scenario.id}`,
            details: { band, scenarioId: scenario.id },
          });
        continue;
      }
      if (insideBand(value, band)) continue;
      diagnostics.push({
        code: 'PROBABILITY_ACCEPTANCE_BAND_MISSED',
        severity: 'warning',
        category: 'design',
        message: `${band.candidateId} is outside acceptance band ${band.id} in ${scenario.id}`,
        ...(candidate?.provenance[0]?.location === undefined
          ? {}
          : { location: candidate.provenance[0].location }),
        details: { band, scenarioId: scenario.id, value },
      });
      if (
        band.max !== undefined &&
        value > band.max &&
        (band.metric === 'conditional_probability' || band.metric === 'cumulative_chance')
      )
        diagnostics.push({
          code: 'PROBABILITY_RARE_OUTCOME_UNEXPECTEDLY_COMMON',
          severity: 'warning',
          category: 'design',
          message: `${band.candidateId} exceeds its declared maximum in ${scenario.id}`,
          details: { band, scenarioId: scenario.id, value },
        });
      if (
        band.min !== undefined &&
        value < band.min &&
        (candidate?.eligibility === 'false' || value <= thresholds.starvedProbability)
      )
        diagnostics.push({
          code: 'PROBABILITY_INTENDED_OUTCOME_UNREACHABLE',
          severity: 'warning',
          category: 'design',
          message: `${band.candidateId} is effectively unreachable relative to acceptance band ${band.id}`,
          details: { band, scenarioId: scenario.id, value },
        });
    }
    if (
      extra.sweep !== undefined &&
      (band.metric === 'raw_value' || band.metric === 'conditional_probability')
    ) {
      const values = extra.sweep.points.flatMap((point) => {
        if (band.scenarioId !== undefined && point.scenarioId !== band.scenarioId) return [];
        const candidate = point.candidates.find(({ id }) => id === band.candidateId);
        const value =
          band.metric === 'raw_value' ? candidate?.rawValue : candidate?.conditionalProbability;
        return value === undefined ? [] : [value];
      });
      if (values.length === 0 || !values.some((value) => insideBand(value, band)))
        diagnostics.push({
          code: 'PROBABILITY_SWEEP_TARGET_BAND_UNREACHED',
          severity: 'warning',
          category: 'design',
          message: `The tested sweep never reaches acceptance band ${band.id}`,
          details: { band, testedValues: values.length },
        });
    }
  }
  for (const issue of extra.unresolved ?? []) {
    if (
      issue.code !== 'CORRELATED_INPUTS_SAMPLED_INDEPENDENTLY' &&
      issue.code !== 'MONTE_CARLO_RARE_OUTCOME_UNRESOLVED'
    )
      continue;
    diagnostics.push({
      code: issue.code,
      severity: 'warning',
      category: 'validation',
      message: issue.message,
      ...(issue.provenance?.location === undefined ? {} : { location: issue.provenance.location }),
      ...(issue.details === undefined ? {} : { details: issue.details }),
    });
  }
  return diagnostics;
}

function deduplicateUnresolved(values: readonly ProbabilityUnresolved[]): ProbabilityUnresolved[] {
  const output = new Map<string, ProbabilityUnresolved>();
  for (const value of values) {
    const key = hashCanonical({
      code: value.code,
      message: value.message,
      path: value.path,
      candidateId: value.candidateId,
      provenance: value.provenance,
    });
    if (!output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

function resultStatus(
  unresolved: readonly ProbabilityUnresolved[],
): ProbabilityAnalysisResult['status'] {
  return unresolved.length === 0 ? 'complete' : 'partial';
}

function resultWithoutResources(result: ProbabilityAnalysisResult): ProbabilityAnalysisResult {
  return { ...result, resources: [] };
}

function visualOutputs(outputs: readonly string[] | undefined): ProbabilityVisual[] {
  return (outputs ?? []).filter((output): output is ProbabilityVisual => output !== 'json');
}

function customSurface(
  manifest: CustomWeightedPoolManifest,
  sourceRevision: string,
): WeightedSurface {
  const sourceHash = hashCanonical(manifest);
  return {
    id: manifest.id,
    adapter: probabilityAdapter('custom_weighted_pool'),
    candidates: manifest.candidates.map((candidate) => ({
      id: candidate.id,
      adapterId: 'custom_weighted_pool',
      sourceKind: 'custom_pool_candidate',
      defaultValue: String(candidate.weight),
      valueExpression: String(candidate.weight),
      provenance: [
        {
          path: `manifest:${manifest.id}`,
          rootKind: 'fixture',
          loadOrder: 0,
          sourceHash,
          symbol: candidate.id,
        },
      ],
      metadata: {
        ...(candidate.category === undefined ? {} : { category: candidate.category }),
        oneTime: candidate.oneTime ?? false,
      },
    })),
    poolComplete: true,
    sourceRevision,
    sourceHash,
    filesScanned: [],
    unsupported: [],
  };
}

export class ProbabilityAnalyzer {
  private readonly state: AnalyzerState;

  public constructor(private readonly engine: CoreEngine) {
    this.state = analyzerState(engine);
  }

  private async scan(context: ProbabilityServiceContext): Promise<ScanSnapshot> {
    if (context.refresh === true) this.engine.invalidate(context.workspaceId);
    return this.engine.scan(context.workspaceId, {}, context.principal, context.signal);
  }

  private async verifyGameVersion(
    context: ProbabilityServiceContext,
    adapter: ProbabilityAdapterId,
  ): Promise<GameVersionVerification> {
    const workspace = this.engine.resolver.get(context.workspaceId, context.principal);
    if (adapter === 'custom_weighted_pool' || workspace.gameRoot === undefined)
      return { status: 'adapter_target_only', adapterTarget: VERIFIED_GAME_VERSION };
    const sourcePath = path.join(workspace.gameRoot, 'launcher-settings.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown;
    } catch (error) {
      throw new ServiceError(
        'PROBABILITY_GAME_VERSION_UNVERIFIED',
        'The configured game version could not be verified from launcher-settings.json',
        { sourcePath, reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (typeof parsed !== 'object' || parsed === null)
      throw new ServiceError(
        'PROBABILITY_GAME_VERSION_UNVERIFIED',
        'The configured launcher-settings.json does not contain a version object',
        { sourcePath },
      );
    const settings = parsed as Record<string, unknown>;
    const observedVersion = typeof settings.version === 'string' ? settings.version : undefined;
    const observedRawVersion =
      typeof settings.rawVersion === 'string' ? settings.rawVersion : undefined;
    const observedChecksum = observedVersion?.match(/\(([a-z0-9]+)\)\s*$/iu)?.[1];
    if (
      observedVersion === undefined ||
      observedRawVersion === undefined ||
      observedChecksum === undefined
    )
      throw new ServiceError(
        'PROBABILITY_GAME_VERSION_UNVERIFIED',
        'The configured launcher-settings.json is missing version, rawVersion, or checksum data',
        { sourcePath, observedVersion, observedRawVersion, observedChecksum },
      );
    if (
      observedRawVersion !== VERIFIED_GAME_RAW_VERSION ||
      observedChecksum.toLowerCase() !== VERIFIED_GAME_CHECKSUM
    )
      throw new ServiceError(
        'PROBABILITY_GAME_VERSION_UNSUPPORTED',
        `Probability adapters are verified for ${VERIFIED_GAME_VERSION}, not the configured game version`,
        {
          sourcePath,
          observedVersion,
          observedRawVersion,
          observedChecksum,
          adapterTarget: VERIFIED_GAME_VERSION,
        },
      );
    return {
      status: 'workspace_verified',
      adapterTarget: VERIFIED_GAME_VERSION,
      sourcePath,
      observedVersion,
      observedRawVersion,
      observedChecksum: observedChecksum.toLowerCase(),
    };
  }

  private metadata(
    context: ProbabilityServiceContext,
    snapshot: ScanSnapshot,
    surface: WeightedSurface,
    scenarioSet: ProbabilityScenarioSet,
    candidatePool: readonly string[],
    gameVersionVerification: GameVersionVerification,
    extra: Record<string, unknown> = {},
  ): ProbabilityAnalysisResult['metadata'] {
    const workspace = this.engine.resolver.get(context.workspaceId, context.principal);
    const scenarioHash = hashCanonical(scenarioSet);
    const candidatePoolHash = hashCanonical(candidatePool);
    const cacheKey = hashCanonical({
      workspaceIdentity: workspace.workspaceIdentity,
      sourceRevision: snapshot.revision,
      sourceHash: surface.sourceHash,
      scenarioHash,
      candidatePoolHash,
      adapter: surface.adapter,
      gameVersionVerification,
      extra,
    });
    return {
      workspaceId: context.workspaceId,
      workspaceIdentity: workspace.workspaceIdentity,
      sourceRevision: snapshot.revision,
      sourceHash: surface.sourceHash,
      scenarioHash,
      candidatePoolHash,
      gameVersion: surface.adapter.gameVersion,
      gameVersionVerification,
      adapterId: surface.adapter.id,
      adapterVersion: surface.adapter.version,
      ...(Array.isArray(extra.requestedMetrics)
        ? { requestedMetrics: extra.requestedMetrics as ProbabilityMetric[] }
        : {}),
      ...(typeof extra.seed === 'number' ? { seed: extra.seed } : {}),
      ...(typeof extra.samples === 'number' ? { samples: extra.samples } : {}),
      numericalPrecision:
        'exact bigint rationals for finite source arithmetic; IEEE-754 for hazards, distributions, and sampled summaries',
      cacheKey,
    };
  }

  private buildResult(
    operation: ProbabilityAnalysisResult['operation'],
    metadata: ProbabilityAnalysisResult['metadata'],
    surface: WeightedSurface,
    scenarios: ProbabilityAnalysisResult['scenarios'],
    extra: {
      sweep?: NonNullable<ProbabilityAnalysisResult['sweep']>;
      simulation?: SimulationSummary[];
      sequence?: SequenceSummary;
      comparison?: ComparisonSummary;
      unresolved?: ProbabilityUnresolved[];
      acceptanceBands?: ProbabilityAcceptanceBand[];
      diagnosticThresholds?: ProbabilityDiagnosticThresholds;
    } = {},
  ): ProbabilityAnalysisResult {
    const unresolved = deduplicateUnresolved([
      ...surface.unsupported,
      ...scenarios.flatMap(({ unresolved: items }) => items),
      ...(extra.unresolved ?? []),
    ]);
    const analysisId = `probability-${metadata.cacheKey.slice(0, 24)}`;
    const prevalenceRows = scenarios.filter(
      (scenario): scenario is typeof scenario & { prevalence: number } =>
        scenario.prevalence !== undefined,
    );
    const prevalenceTotal = prevalenceRows.reduce((sum, scenario) => sum + scenario.prevalence, 0);
    const aggregateCandidateIds = [
      ...new Set(prevalenceRows.flatMap(({ candidates }) => candidates.map(({ id }) => id))),
    ].sort();
    const prevalenceAggregate =
      prevalenceTotal <= 0
        ? undefined
        : {
            prevalenceTotal,
            candidates: aggregateCandidateIds.map((id) => {
              const rows = prevalenceRows.flatMap((scenario) => {
                const candidate = scenario.candidates.find((item) => item.id === id);
                return candidate === undefined ? [] : [{ scenario, candidate }];
              });
              const probabilityRows = rows.filter(
                ({ candidate }) =>
                  candidate.conditionalProbability !== undefined &&
                  candidate.conditionalProbability !== null,
              );
              return {
                id,
                eligibilityPrevalence:
                  rows.reduce(
                    (sum, { scenario, candidate }) =>
                      sum + (candidate.eligibility === 'true' ? scenario.prevalence : 0),
                    0,
                  ) / prevalenceTotal,
                ...(probabilityRows.length === rows.length
                  ? {
                      weightedConditionalProbability:
                        probabilityRows.reduce(
                          (sum, { scenario, candidate }) =>
                            sum + scenario.prevalence * candidate.conditionalProbability!,
                          0,
                        ) / prevalenceTotal,
                    }
                  : {}),
              };
            }),
          };
    return {
      schemaVersion: '1.0',
      status: resultStatus(unresolved),
      operation,
      analysisId,
      metadata,
      adapter: surface.adapter,
      scenarios,
      ...(prevalenceAggregate === undefined ? {} : { prevalenceAggregate }),
      diagnostics: diagnosticsFor(scenarios, surface, {
        ...(extra.sweep === undefined ? {} : { sweep: extra.sweep }),
        ...(extra.simulation === undefined ? {} : { simulation: extra.simulation }),
        ...(extra.acceptanceBands === undefined ? {} : { acceptanceBands: extra.acceptanceBands }),
        ...(extra.diagnosticThresholds === undefined
          ? {}
          : { diagnosticThresholds: extra.diagnosticThresholds }),
        ...(extra.unresolved === undefined ? {} : { unresolved: extra.unresolved }),
      }),
      unresolved,
      ...(extra.sweep === undefined ? {} : { sweep: extra.sweep }),
      ...(extra.simulation === undefined ? {} : { simulation: extra.simulation }),
      ...(extra.sequence === undefined ? {} : { sequence: extra.sequence }),
      ...(extra.comparison === undefined ? {} : { comparison: extra.comparison }),
      resources: [],
    };
  }

  private async store(
    result: ProbabilityAnalysisResult,
    outputs: readonly string[] | undefined,
    includeHtml = false,
    signal?: AbortSignal,
    principal?: string,
  ): Promise<ProbabilityAnalysisResult> {
    const cached = this.state.byCacheKey.get(result.metadata.cacheKey);
    if (
      cached?.operation === result.operation &&
      cached.status === result.status &&
      visualOutputs(outputs).length === 0
    )
      return cached;
    const workspace = this.engine.resolver.get(result.metadata.workspaceId, principal);
    const provenance = {
      kind: 'probability-analysis',
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'probability-analysis.v1',
      sourceHashes: { aggregate: result.metadata.sourceHash },
      metadata: {
        analysisId: result.analysisId,
        operation: result.operation,
        adapterId: result.adapter.id,
        adapterVersion: result.adapter.version,
        scenarioHash: result.metadata.scenarioHash,
        candidatePoolHash: result.metadata.candidatePoolHash,
      },
    };
    const visuals = visualOutputs(outputs);
    const rendered = await renderProbabilityResult(
      result,
      visuals,
      includeHtml,
      provenance,
      signal,
    );
    const writes = [
      {
        name: `${result.analysisId}.json`,
        mimeType: 'application/json',
        content: `${canonicalJson(resultWithoutResources(result))}\n`,
        provenance,
        description: 'Authoritative AI and MTTH scenario analysis JSON',
      },
      ...rendered.writes,
    ];
    const stored = await this.engine.artifacts.withAtomicChunkedWrites(
      workspace,
      writes,
      (artifacts) => Promise.resolve([...artifacts]),
      signal,
    );
    const complete = { ...result, resources: stored.map(publicArtifactLink) };
    if (complete.operation !== 'render') {
      this.state.byId.set(complete.analysisId, complete);
      this.state.byCacheKey.set(complete.metadata.cacheKey, complete);
    }
    return complete;
  }

  public async inspect(
    context: ProbabilityServiceContext,
    adapter?: ProbabilityAdapterId,
    source?: ProbabilitySourceInput,
    candidatePool: readonly string[] = [],
  ): Promise<ProbabilityInspectResult> {
    if (adapter === undefined || source === undefined)
      return { adapters: probabilityAdapters(), artifacts: [], filesScanned: [] };
    const gameVersionVerification = await this.verifyGameVersion(context, adapter);
    const snapshot = await this.scan(context);
    const surface = discoverWeightedSurface(snapshot, adapter, source, candidatePool);
    const definitions = ClausewitzEvaluationDefinitions.build(snapshot);
    const inspectedCandidates = evaluateExactCandidates(
      surface,
      { id: 'inspection', state: {} },
      definitions,
    );
    const requiredInputs = [
      ...new Set(
        inspectedCandidates.flatMap(({ unresolved }) =>
          unresolved.flatMap(({ path }) => (path === undefined ? [] : [path])),
        ),
      ),
    ].sort();
    const report = {
      schemaVersion: 'probability-inspection.v1',
      workspaceId: context.workspaceId,
      surface: {
        id: surface.id,
        adapter: surface.adapter,
        poolComplete: surface.poolComplete,
        sourceRevision: surface.sourceRevision,
        sourceHash: surface.sourceHash,
        gameVersionVerification,
        candidateCount: surface.candidates.length,
        candidates: surface.candidates.map((candidate, index) => {
          const evaluated = inspectedCandidates[index]!;
          const candidateRequiredInputs = [
            ...new Set(
              evaluated.unresolved.flatMap(({ path }) => (path === undefined ? [] : [path])),
            ),
          ].sort();
          return {
            id: candidate.id,
            sourceKind: candidate.sourceKind,
            provenance: candidate.provenance,
            hasEligibility: candidate.eligibilityBlock !== undefined,
            hasWeightBlock:
              candidate.weightBlock !== undefined || candidate.valueExpression !== undefined,
            requiredInputs: candidateRequiredInputs,
            referencedProvenance: evaluated.provenance.filter(
              ({ path, symbol }) =>
                !candidate.provenance.some(
                  (source) => source.path === path && source.symbol === symbol,
                ),
            ),
            analysisSupport:
              candidateRequiredInputs.length > 0
                ? ('requires_scenario' as const)
                : surface.adapter.selectionRule === 'score_only'
                  ? ('score_only' as const)
                  : surface.adapter.completePoolRequired && !surface.poolComplete
                    ? ('requires_complete_pool' as const)
                    : ('exact' as const),
          };
        }),
        requiredInputs,
        unsupported: surface.unsupported,
      },
    };
    const workspace = this.engine.resolver.get(context.workspaceId, context.principal);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      `probability-inspect-${surface.sourceHash.slice(0, 12)}.json`,
      'application/json',
      `${canonicalJson(report)}\n`,
      {
        kind: 'probability-inspection',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'probability-inspection.v1',
        sourceHashes: { aggregate: surface.sourceHash },
      },
      'Discovered weighted surfaces and adapter capabilities',
      context.signal,
    );
    return {
      adapters: probabilityAdapters(),
      surface: report.surface,
      artifacts: [publicArtifactLink(artifact)],
      filesScanned: surface.filesScanned,
    };
  }

  private async analyzeUnstored(
    operation: 'evaluate' | 'sweep' | 'simulate',
    request: ProbabilityAnalysisRequest,
    extra: Record<string, unknown> = {},
  ): Promise<{
    result: ProbabilityAnalysisResult;
    surface: WeightedSurface;
    definitions: ClausewitzEvaluationDefinitions;
    snapshot: ScanSnapshot;
  }> {
    request.signal?.throwIfAborted();
    if (
      request.scenarioSet.workspaceId !== undefined &&
      request.scenarioSet.workspaceId !== request.workspaceId
    )
      throw new ServiceError(
        'PROBABILITY_SCENARIO_WORKSPACE_MISMATCH',
        'Scenario set belongs to a different workspace',
      );
    const gameVersionVerification = await this.verifyGameVersion(request, request.adapter);
    const snapshot = await this.scan(request);
    const surface = discoverWeightedSurface(
      snapshot,
      request.adapter,
      request.source,
      request.candidatePool ?? [],
    );
    const definitions = ClausewitzEvaluationDefinitions.build(snapshot);
    const metadata = this.metadata(
      request,
      snapshot,
      surface,
      request.scenarioSet,
      request.candidatePool ?? [],
      gameVersionVerification,
      {
        operation,
        horizonDays: request.horizonDays,
        requestedMetrics: request.metrics,
        acceptanceBands: request.acceptanceBands,
        diagnosticThresholds: request.diagnosticThresholds,
        ...extra,
      },
    );
    const cached = this.state.byCacheKey.get(metadata.cacheKey);
    if (cached !== undefined) return { result: cached, surface, definitions, snapshot };
    const scenarios = evaluateSurfaceScenarios(
      surface,
      request.scenarioSet.scenarios,
      definitions,
      request.horizonDays,
    );
    return {
      result: this.buildResult(operation, metadata, surface, scenarios, {
        ...(request.acceptanceBands === undefined
          ? {}
          : { acceptanceBands: request.acceptanceBands }),
        ...(request.diagnosticThresholds === undefined
          ? {}
          : { diagnosticThresholds: request.diagnosticThresholds }),
      }),
      surface,
      definitions,
      snapshot,
    };
  }

  public async evaluate(request: ProbabilityAnalysisRequest): Promise<ProbabilityAnalysisResult> {
    const analyzed = await this.analyzeUnstored('evaluate', request);
    return this.store(
      analyzed.result,
      request.outputs ?? ['json'],
      false,
      request.signal,
      request.principal,
    );
  }

  public async sweep(request: ProbabilitySweepRequest): Promise<ProbabilityAnalysisResult> {
    const analyzed = await this.analyzeUnstored('sweep', request, { sweep: request.sweep });
    if (analyzed.result.operation === 'sweep' && analyzed.result.sweep !== undefined)
      return this.store(
        analyzed.result,
        request.outputs ?? ['json', 'sensitivity'],
        false,
        request.signal,
        request.principal,
      );
    const sweep = sweepSurface(
      analyzed.surface,
      request.scenarioSet.scenarios,
      analyzed.definitions,
      request.sweep,
      request.signal,
    );
    const result = this.buildResult(
      'sweep',
      analyzed.result.metadata,
      analyzed.surface,
      analyzed.result.scenarios,
      {
        sweep,
        ...(request.acceptanceBands === undefined
          ? {}
          : { acceptanceBands: request.acceptanceBands }),
        ...(request.diagnosticThresholds === undefined
          ? {}
          : { diagnosticThresholds: request.diagnosticThresholds }),
      },
    );
    return this.store(
      result,
      request.outputs ?? ['json', 'sensitivity'],
      false,
      request.signal,
      request.principal,
    );
  }

  public async simulate(request: ProbabilitySimulationRequest): Promise<ProbabilityAnalysisResult> {
    const analyzed = await this.analyzeUnstored('simulate', request, {
      samples: request.samples,
      seed: request.seed,
      confidenceLevel: request.confidenceLevel,
      samplingMethod: request.samplingMethod ?? 'latin_hypercube',
    });
    if (analyzed.result.operation === 'simulate' && analyzed.result.simulation !== undefined)
      return this.store(
        analyzed.result,
        request.outputs ?? ['json', 'matrix'],
        false,
        request.signal,
        request.principal,
      );
    const simulation = simulateSurface(
      analyzed.surface,
      request.scenarioSet.scenarios,
      analyzed.definitions,
      request.samples,
      request.seed,
      request.confidenceLevel,
      request.samplingMethod ?? 'latin_hypercube',
      resolvedThresholds(request.diagnosticThresholds).rareOutcomeMinimumObservations,
      request.signal,
    );
    const scenarios = analyzed.result.scenarios.map((scenario, scenarioIndex) => {
      const summary = simulation.summaries.find(({ scenarioId }) => scenarioId === scenario.id);
      const sampledPaths = new Set(
        request.scenarioSet.scenarios[scenarioIndex]?.uncertainInputs?.map(({ path }) => path) ??
          [],
      );
      const unresolvedAfterSampling = (issue: ProbabilityUnresolved): boolean =>
        issue.path === undefined || !sampledPaths.has(issue.path);
      const candidates = scenario.candidates.map((candidate) => {
        const sampled = summary?.candidates.find(({ id }) => id === candidate.id);
        const remainingUnresolved = candidate.unresolved.filter(unresolvedAfterSampling);
        return sampled === undefined
          ? { ...candidate, unresolved: remainingUnresolved }
          : {
              ...candidate,
              supportLevel:
                remainingUnresolved.length === 0 &&
                (sampled.frequency !== undefined || sampled.timingSampleCount !== undefined)
                  ? ('sampled' as const)
                  : candidate.supportLevel,
              unresolved: remainingUnresolved,
              ...(sampled.frequency === undefined ? {} : { sampledFrequency: sampled.frequency }),
              ...(sampled.confidenceInterval === undefined
                ? {}
                : { confidenceInterval: sampled.confidenceInterval }),
              ...(sampled.timingQuantilesDays === undefined
                ? {}
                : { timingQuantilesDays: sampled.timingQuantilesDays }),
              ...(sampled.timingQuantileIntervals === undefined
                ? {}
                : { timingQuantileIntervals: sampled.timingQuantileIntervals }),
              ...(sampled.timingSampleCount === undefined
                ? {}
                : { timingSampleCount: sampled.timingSampleCount }),
              ...(sampled.timingEvaluations === undefined
                ? {}
                : { timingEvaluations: sampled.timingEvaluations }),
              ...(sampled.timingReservoirCapacity === undefined
                ? {}
                : { timingReservoirCapacity: sampled.timingReservoirCapacity }),
              ...(sampled.timingMethod === undefined ? {} : { timingMethod: sampled.timingMethod }),
              ...(sampled.timingConfidenceMethod === undefined
                ? {}
                : { timingConfidenceMethod: sampled.timingConfidenceMethod }),
            };
      });
      const supportLevel = candidates.some(({ supportLevel }) => supportLevel === 'unsupported')
        ? ('unsupported' as const)
        : candidates.some(({ supportLevel }) => supportLevel === 'external')
          ? ('external' as const)
          : candidates.some(({ supportLevel }) => supportLevel === 'bounded')
            ? ('bounded' as const)
            : candidates.some(({ supportLevel }) => supportLevel === 'sampled')
              ? ('sampled' as const)
              : scenario.supportLevel;
      return {
        ...scenario,
        supportLevel,
        candidates,
        unresolved: scenario.unresolved.filter(unresolvedAfterSampling),
      };
    });
    const result = this.buildResult(
      'simulate',
      analyzed.result.metadata,
      analyzed.surface,
      scenarios,
      {
        simulation: simulation.summaries,
        unresolved: simulation.unresolved,
        ...(request.acceptanceBands === undefined
          ? {}
          : { acceptanceBands: request.acceptanceBands }),
        ...(request.diagnosticThresholds === undefined
          ? {}
          : { diagnosticThresholds: request.diagnosticThresholds }),
      },
    );
    return this.store(
      result,
      request.outputs ?? ['json', 'matrix'],
      false,
      request.signal,
      request.principal,
    );
  }

  public async sequence(request: ProbabilitySequenceRequest): Promise<ProbabilityAnalysisResult> {
    request.signal?.throwIfAborted();
    const snapshot = await this.scan(request);
    const surface = customSurface(request.customPoolManifest, snapshot.revision);
    const gameVersionVerification = await this.verifyGameVersion(request, 'custom_weighted_pool');
    const metadata = this.metadata(
      request,
      snapshot,
      surface,
      request.scenarioSet,
      request.customPoolManifest.candidates.map(({ id }) => id),
      gameVersionVerification,
      {
        operation: 'sequence',
        manifest: request.customPoolManifest,
        horizonDays: request.horizonDays,
        maxSteps: request.maxSteps,
        samples: request.samples,
        seed: request.seed,
        confidenceLevel: request.confidenceLevel,
        acceptanceBands: request.acceptanceBands,
        diagnosticThresholds: request.diagnosticThresholds,
      },
    );
    const cached = this.state.byCacheKey.get(metadata.cacheKey);
    if (cached !== undefined) return cached;
    const [scenario] = request.scenarioSet.scenarios;
    if (scenario === undefined)
      throw new ServiceError(
        'PROBABILITY_SCENARIO_REQUIRED',
        'Sequence analysis requires one scenario',
      );
    const sequence = analyzeSequence(
      request.customPoolManifest,
      scenario,
      request.horizonDays,
      request.maxSteps,
      request.samples,
      request.seed,
      request.confidenceLevel,
      request.signal,
    );
    const scenarios = [
      {
        id: scenario.id,
        ...(scenario.label === undefined ? {} : { label: scenario.label }),
        ...(scenario.prevalence === undefined ? {} : { prevalence: scenario.prevalence }),
        poolComplete: true,
        supportLevel:
          sequence.summary.method === 'seeded_monte_carlo'
            ? ('sampled' as const)
            : sequence.summary.method === 'bounded_beam'
              ? ('bounded' as const)
              : ('exact' as const),
        candidates: request.customPoolManifest.candidates.map((candidate) => ({
          id: candidate.id,
          eligibility: 'true' as const,
          supportLevel:
            sequence.summary.method === 'seeded_monte_carlo'
              ? ('sampled' as const)
              : sequence.summary.method === 'bounded_beam'
                ? ('bounded' as const)
                : ('exact' as const),
          rawValue:
            typeof candidate.weight === 'number'
              ? {
                  numerator: String(candidate.weight),
                  denominator: '1',
                  decimal: String(candidate.weight),
                  value: candidate.weight,
                }
              : null,
          rank: null,
          trace: [],
          provenance: surface.candidates.find(({ id }) => id === candidate.id)!.provenance,
          unresolved: [],
        })),
        horizonDays: request.horizonDays,
        summary: {
          topOutcomes: sequence.summary.candidates
            .slice()
            .sort(
              (left, right) =>
                right.nextSelectionProbability - left.nextSelectionProbability ||
                left.id.localeCompare(right.id),
            )
            .slice(0, 3)
            .map(({ id }) => id),
          bottomEligibleOutcomes: sequence.summary.candidates
            .slice()
            .sort(
              (left, right) =>
                left.nextSelectionProbability - right.nextSelectionProbability ||
                left.id.localeCompare(right.id),
            )
            .slice(0, 3)
            .map(({ id }) => id),
          impossibleOutcomes: sequence.summary.candidates
            .filter(({ everSelectedProbability }) => everSelectedProbability === 0)
            .map(({ id }) => id),
          unresolvedOutcomes: [],
          dominantFactors: [],
        },
        unresolved: sequence.unresolved,
      },
    ];
    const result = this.buildResult('sequence', metadata, surface, scenarios, {
      sequence: sequence.summary,
      unresolved: sequence.unresolved,
      ...(request.acceptanceBands === undefined
        ? {}
        : { acceptanceBands: request.acceptanceBands }),
      ...(request.diagnosticThresholds === undefined
        ? {}
        : { diagnosticThresholds: request.diagnosticThresholds }),
    });
    return this.store(
      result,
      request.outputs ?? ['json', 'sequence'],
      false,
      request.signal,
      request.principal,
    );
  }

  public async compare(request: ProbabilityCompareRequest): Promise<ProbabilityAnalysisResult> {
    const before = await this.analyzeUnstored('evaluate', { ...request, source: request.before });
    const after = await this.analyzeUnstored('evaluate', {
      ...request,
      source: request.after,
      refresh: false,
    });
    const metadata = {
      ...after.result.metadata,
      cacheKey: hashCanonical({
        operation: 'compare',
        before: before.result.metadata.cacheKey,
        after: after.result.metadata.cacheKey,
      }),
    };
    const cached = this.state.byCacheKey.get(metadata.cacheKey);
    if (cached !== undefined) return cached;
    const comparison = compareProbabilityResults(
      before.result,
      after.result,
      request.acceptanceBands,
    );
    const result = this.buildResult('compare', metadata, after.surface, after.result.scenarios, {
      comparison,
      unresolved: [...before.result.unresolved, ...after.result.unresolved],
      ...(request.acceptanceBands === undefined
        ? {}
        : { acceptanceBands: request.acceptanceBands }),
      ...(request.diagnosticThresholds === undefined
        ? {}
        : { diagnosticThresholds: request.diagnosticThresholds }),
    });
    return this.store(
      result,
      request.outputs ?? ['json', 'comparison'],
      false,
      request.signal,
      request.principal,
    );
  }

  public async render(request: ProbabilityRenderRequest): Promise<ProbabilityAnalysisResult> {
    const result = this.state.byId.get(request.analysisId);
    if (result === undefined)
      throw new ServiceError(
        'PROBABILITY_ANALYSIS_NOT_CACHED',
        'Render requires an analysis ID produced by this server process',
        { analysisId: request.analysisId },
      );
    if (result.metadata.workspaceId !== request.workspaceId)
      throw new ServiceError(
        'PROBABILITY_ANALYSIS_WORKSPACE_MISMATCH',
        'Analysis belongs to a different workspace',
      );
    if (
      request.expectedScenarioHash !== undefined &&
      request.expectedScenarioHash !== result.metadata.scenarioHash
    ) {
      const stale: ProbabilityAnalysisResult = {
        ...result,
        status: 'stale',
        operation: 'render',
        diagnostics: [
          ...result.diagnostics,
          {
            code: 'PROBABILITY_SCENARIO_STALE',
            severity: 'warning',
            category: 'validation',
            message:
              'The expected scenario hash does not match this cached analysis; run analysis for the current scenario set before rendering',
            details: {
              expectedScenarioHash: request.expectedScenarioHash,
              analysisScenarioHash: result.metadata.scenarioHash,
            },
          },
        ],
      };
      return this.store(stale, ['json'], false, request.signal, request.principal);
    }
    await this.verifyGameVersion(request, result.adapter.id);
    const snapshot = await this.scan(request);
    if (snapshot.revision !== result.metadata.sourceRevision) {
      const stale: ProbabilityAnalysisResult = {
        ...result,
        status: 'stale',
        operation: 'render',
        diagnostics: [
          ...result.diagnostics,
          {
            code: 'PROBABILITY_ANALYSIS_STALE',
            severity: 'warning',
            category: 'validation',
            message:
              'Workspace sources changed after this analysis; run the analysis again before rendering',
            details: {
              analysisRevision: result.metadata.sourceRevision,
              currentRevision: snapshot.revision,
            },
          },
        ],
      };
      return this.store(stale, ['json'], false, request.signal, request.principal);
    }
    const scenarioIds = new Set(request.filter?.scenarioIds ?? []);
    const candidateIds = new Set(request.filter?.candidateIds ?? []);
    const sourcePaths = new Set(
      (request.filter?.sourcePaths ?? []).map((value) => value.replaceAll('\\', '/').toLowerCase()),
    );
    const metrics = new Set(request.filter?.metrics ?? []);
    const offset = request.filter?.offset ?? 0;
    const limit = request.filter?.limit ?? 10_000;
    const filteredScenarios = result.scenarios
      .filter(({ id }) => scenarioIds.size === 0 || scenarioIds.has(id))
      .map((scenario) => ({
        ...scenario,
        candidates: scenario.candidates
          .filter(
            (candidate) =>
              (candidateIds.size === 0 || candidateIds.has(candidate.id)) &&
              (sourcePaths.size === 0 ||
                candidate.provenance.some(({ path }) =>
                  sourcePaths.has(path.replaceAll('\\', '/').toLowerCase()),
                )),
          )
          .slice(offset, offset + limit)
          .map((candidate) => filterCandidateMetrics(candidate, metrics)),
      }));
    const severities = new Set(request.filter?.diagnosticSeverities ?? []);
    const filtered: ProbabilityAnalysisResult = {
      ...result,
      operation: 'render',
      scenarios: filteredScenarios,
      diagnostics: result.diagnostics.filter(
        ({ severity }) => severities.size === 0 || severities.has(severity),
      ),
    };
    return this.store(
      filtered,
      ['json', ...request.outputs],
      request.includeHtml,
      request.signal,
      request.principal,
    );
  }
}
