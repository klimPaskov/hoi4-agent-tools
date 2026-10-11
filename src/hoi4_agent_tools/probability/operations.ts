import { emptyServiceResult } from '../core/result.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import {
  probabilityCompareRequestSchema,
  probabilityEvaluateRequestSchema,
  probabilityInspectRequestSchema,
  probabilityRenderRequestSchema,
  probabilitySequenceRequestSchema,
  probabilitySimulateRequestSchema,
  probabilitySweepRequestSchema,
  probabilityAnalyzeRequestSchema,
  splitProbabilityAnalyzeRequest,
  type ProbabilityAnalyzeToolRequest,
  type ProbabilityCompareToolRequest,
  type ProbabilityEvaluateToolRequest,
  type ProbabilityInspectToolRequest,
  type ProbabilityRenderToolRequest,
  type ProbabilitySequenceToolRequest,
  type ProbabilitySimulateToolRequest,
  type ProbabilitySweepToolRequest,
} from '../schemas/probability-requests.js';
import type {
  ProbabilityAnalyzer,
  ProbabilityAnalysisRequest,
  ProbabilityCompareRequest,
  ProbabilityRenderRequest,
  ProbabilitySequenceRequest,
  ProbabilitySimulationRequest,
  ProbabilitySweepRequest,
} from './service.js';

export interface ProbabilityOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
}

function runtime(context: ProbabilityOperationContext, refresh?: boolean) {
  return {
    workspaceId: context.workspaceId,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(refresh === undefined ? {} : { refresh }),
  };
}

const INLINE_RANKING_SCENARIOS = 4;
const INLINE_RANKING_CANDIDATES = 12;
const INLINE_MISSING_INPUTS = 16;
const INLINE_COMPARISON_CHANGES = 12;

type AnalysisResult = Awaited<ReturnType<ProbabilityAnalyzer['evaluate']>>;

function rounded(value: number | null | undefined, digits = 6): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The answer itself, inline: the strongest candidates of the first scenarios. */
function inlineRanking(result: AnalysisResult) {
  return result.scenarios.slice(0, INLINE_RANKING_SCENARIOS).map((scenario) => {
    const ranked = [...scenario.candidates].sort(
      (left, right) =>
        (right.conditionalProbability ?? -1) - (left.conditionalProbability ?? -1) ||
        (right.rawValue?.value ?? Number.NEGATIVE_INFINITY) -
          (left.rawValue?.value ?? Number.NEGATIVE_INFINITY) ||
        compareIds(left.id, right.id),
    );
    return {
      scenarioId: scenario.id,
      poolComplete: scenario.poolComplete,
      candidates: ranked.slice(0, INLINE_RANKING_CANDIDATES).map((candidate) => ({
        id: candidate.id,
        eligible: candidate.eligibility,
        weight: rounded(candidate.rawValue?.value),
        ...((candidate.rawValue === undefined || candidate.rawValue === null) &&
        candidate.rawInterval !== undefined
          ? {
              weightRange: [rounded(candidate.rawInterval.min), rounded(candidate.rawInterval.max)],
            }
          : {}),
        probability: rounded(candidate.conditionalProbability),
        ...(candidate.effectiveMtthDays === undefined
          ? {}
          : { mtthDays: rounded(candidate.effectiveMtthDays, 2) }),
      })),
      ...(ranked.length > INLINE_RANKING_CANDIDATES
        ? { omittedCandidates: ranked.length - INLINE_RANKING_CANDIDATES }
        : {}),
    };
  });
}

/** Facts the scenarios did not declare but a condition or value needs. */
function missingInputs(result: AnalysisResult): string[] {
  const inputs = new Set<string>();
  for (const { code, path, details } of result.unresolved) {
    if (typeof details?.scenarioInput === 'string') inputs.add(details.scenarioInput);
    else if (code === 'VALUE_UNRESOLVED' && path !== undefined && !/^(?:@|constant:)/u.test(path))
      inputs.add(path);
  }
  return [...inputs].sort(compareIds).slice(0, INLINE_MISSING_INPUTS);
}

function inlineComparison(result: AnalysisResult) {
  if (result.comparison === undefined) return [];
  return [...result.comparison.scenarioChanges]
    .sort(
      (left, right) =>
        Math.abs(right.probabilityDelta ?? 0) - Math.abs(left.probabilityDelta ?? 0) ||
        Math.abs(right.rawDelta ?? 0) - Math.abs(left.rawDelta ?? 0) ||
        compareIds(left.candidateId, right.candidateId),
    )
    .slice(0, INLINE_COMPARISON_CHANGES)
    .map((change) => ({
      scenarioId: change.scenarioId,
      candidateId: change.candidateId,
      ...(change.rawDelta === undefined ? {} : { weightDelta: rounded(change.rawDelta) }),
      ...(change.probabilityDelta === undefined
        ? {}
        : { probabilityDelta: rounded(change.probabilityDelta) }),
      ...(change.eligibilityChange === undefined
        ? {}
        : {
            eligibility: `${change.eligibilityChange.before}->${change.eligibilityChange.after}`,
          }),
    }));
}

export function probabilityAnalysisData(
  result: Awaited<ReturnType<ProbabilityAnalyzer['evaluate']>>,
) {
  return {
    operation: result.operation,
    analysisId: result.analysisId,
    analysisStatus: result.status,
    adapterId: result.adapter.id,
    sourceRevision: result.metadata.sourceRevision,
    sourceHash: result.metadata.sourceHash,
    scenarioHash: result.metadata.scenarioHash,
    cacheKey: result.metadata.cacheKey,
    scenarios: result.scenarios.length,
    candidates: result.scenarios.reduce((sum, scenario) => sum + scenario.candidates.length, 0),
    eligibleCandidates: result.scenarios.reduce(
      (sum, scenario) =>
        sum + scenario.candidates.filter(({ eligibility }) => eligibility === 'true').length,
      0,
    ),
    excludedCandidates: result.scenarios.reduce(
      (sum, scenario) =>
        sum + scenario.candidates.filter(({ eligibility }) => eligibility === 'false').length,
      0,
    ),
    unresolvedCandidates: result.scenarios.reduce(
      (sum, scenario) =>
        sum + scenario.candidates.filter(({ eligibility }) => eligibility === 'unresolved').length,
      0,
    ),
    ...(result.scenarios.some(({ scopePools }) => (scopePools?.length ?? 0) > 0)
      ? {
          scopePools: result.scenarios.reduce(
            (sum, scenario) => sum + (scenario.scopePools?.length ?? 0),
            0,
          ),
          scopePoolCandidates: result.scenarios.reduce(
            (sum, scenario) =>
              sum +
              (scenario.scopePools?.reduce(
                (poolSum, pool) => poolSum + pool.candidates.length,
                0,
              ) ?? 0),
            0,
          ),
        }
      : {}),
    unresolved: result.unresolved.length,
    diagnostics: result.diagnostics.length,
    ...(result.sweep === undefined ? {} : { sweepPoints: result.sweep.points.length }),
    ...(result.metadata.samples === undefined ? {} : { samples: result.metadata.samples }),
    ...(result.sequence === undefined ? {} : { sequenceMethod: result.sequence.method }),
    ...(result.comparison === undefined
      ? {}
      : { comparisonChanges: result.comparison.scenarioChanges.length }),
    visualResources: result.resources.filter(({ mimeType }) => mimeType.startsWith('image/'))
      .length,
    ranking: inlineRanking(result),
    missingInputs: missingInputs(result),
    ...(result.comparison === undefined ? {} : { changes: inlineComparison(result) }),
  };
}

export function probabilityAnalysisServiceResult(
  workspaceId: string,
  result: Awaited<ReturnType<ProbabilityAnalyzer['evaluate']>>,
) {
  const output = emptyServiceResult(workspaceId, probabilityAnalysisData(result));
  output.code =
    result.status === 'complete'
      ? 'PROBABILITY_ANALYZED'
      : result.status === 'stale'
        ? result.diagnostics.some(({ code }) => code === 'PROBABILITY_SCENARIO_STALE')
          ? 'PROBABILITY_SCENARIO_STALE'
          : 'PROBABILITY_ANALYSIS_STALE'
        : 'PROBABILITY_ANALYZED_PARTIAL';
  output.artifacts = result.resources;
  output.diagnostics = result.diagnostics;
  output.validation = {
    passed: result.status !== 'blocked' && result.status !== 'cancelled',
    checks: [
      {
        id: 'uncertainty-visible',
        passed: true,
        message: `${result.unresolved.length} unresolved or bounded analysis item(s) are explicit`,
      },
    ],
  };
  return output;
}

export function normalizeProbabilityInspectRequest(input: unknown): ProbabilityInspectToolRequest {
  return probabilityInspectRequestSchema.parse(input);
}

export function normalizeProbabilityEvaluateRequest(
  input: unknown,
): ProbabilityEvaluateToolRequest {
  return probabilityEvaluateRequestSchema.parse(input);
}

export function normalizeProbabilitySweepRequest(input: unknown): ProbabilitySweepToolRequest {
  return probabilitySweepRequestSchema.parse(input);
}

export function normalizeProbabilitySimulateRequest(
  input: unknown,
): ProbabilitySimulateToolRequest {
  return probabilitySimulateRequestSchema.parse(input);
}

export function normalizeProbabilitySequenceRequest(
  input: unknown,
): ProbabilitySequenceToolRequest {
  return probabilitySequenceRequestSchema.parse(input);
}

export function normalizeProbabilityCompareRequest(input: unknown): ProbabilityCompareToolRequest {
  return probabilityCompareRequestSchema.parse(input);
}

export function normalizeProbabilityRenderRequest(input: unknown): ProbabilityRenderToolRequest {
  return probabilityRenderRequestSchema.parse(input);
}

const DEFAULT_SCENARIO_SET = {
  schemaVersion: '1.0' as const,
  id: 'source-defaults',
  description: 'One scenario with no declared facts; conditions that need facts stay unresolved.',
  scenarios: [{ id: 'no-facts', state: {} }],
};

/** Discover the weighted surface and, unless evaluate is false, evaluate it in the same call. */
export async function inspectProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilityInspectToolRequest,
  context: ProbabilityOperationContext,
) {
  let source = input.source as ProbabilityAnalysisRequest['source'] | undefined;
  const candidatePool = input.candidatePool ?? [];
  // A pool alone names what to inspect: its first ID finds the defining file.
  if (source === undefined && input.customPoolManifest === undefined && candidatePool.length > 0)
    source = { identifier: candidatePool[0]! };
  const customPoolManifest = input.customPoolManifest as
    ProbabilitySequenceRequest['customPoolManifest'] | undefined;
  let inspected = await analyzer.inspect(
    runtime(context, input.refresh),
    input.adapter,
    source,
    candidatePool,
    customPoolManifest,
  );
  // A wrong adapter guess, such as a mission named as a decision, should not cost another call.
  const suggested = inspected.discovery?.suggestedAdapter;
  if (
    input.evaluate !== false &&
    inspected.surface === undefined &&
    suggested !== undefined &&
    suggested !== input.adapter &&
    (inspected.discovery?.reason === 'candidate_pool_not_found' ||
      inspected.discovery?.reason === 'requested_adapter_empty' ||
      inspected.discovery?.reason === 'identifier_not_found')
  )
    inspected = await analyzer.inspect(
      runtime(context),
      suggested,
      source,
      candidatePool,
      customPoolManifest,
    );
  const surface = inspected.surface;
  if (
    input.evaluate !== false &&
    surface !== undefined &&
    (source !== undefined || customPoolManifest !== undefined)
  ) {
    const analyzed = await analyzer.evaluate({
      ...runtime(context),
      adapter: surface.adapter.id,
      ...(source === undefined ? {} : { source }),
      ...(customPoolManifest === undefined ? {} : { customPoolManifest }),
      ...(candidatePool.length === 0 ? {} : { candidatePool }),
      scenarioSet: (input.scenarioSet ??
        DEFAULT_SCENARIO_SET) as ProbabilityAnalysisRequest['scenarioSet'],
      ...(input.horizonDays === undefined ? {} : { horizonDays: input.horizonDays }),
      ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
      ...(input.acceptanceBands === undefined
        ? {}
        : {
            acceptanceBands: input.acceptanceBands as NonNullable<
              ProbabilityAnalysisRequest['acceptanceBands']
            >,
          }),
      ...(input.diagnosticThresholds === undefined
        ? {}
        : {
            diagnosticThresholds: input.diagnosticThresholds as NonNullable<
              ProbabilityAnalysisRequest['diagnosticThresholds']
            >,
          }),
      ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
    });
    const result = probabilityAnalysisServiceResult(context.workspaceId, analyzed);
    result.artifacts = [...result.artifacts, ...inspected.artifacts];
    if (input.scenarioSet === undefined)
      result.diagnostics = [
        {
          code: 'PROBABILITY_DEFAULT_SCENARIO',
          severity: 'info',
          category: 'configuration',
          message:
            'Evaluated without declared facts; pass scenarioSet with the facts in missingInputs to resolve the remaining conditions',
        },
        ...result.diagnostics,
      ];
    return result;
  }
  const sourceRequiredInputPaths = (surface?.requiredInputs ?? []).filter(
    (path) =>
      path !== 'focus.external_factors_complete' && path !== 'technology.external_factors_complete',
  );
  const adapterRequiredInputPaths = (surface?.requiredInputs ?? []).filter(
    (path) =>
      path === 'focus.external_factors_complete' || path === 'technology.external_factors_complete',
  );
  const result = emptyServiceResult(context.workspaceId, {
    adapters: inspected.adapters.length,
    ...(surface === undefined
      ? {}
      : {
          adapterId: surface.adapter.id,
          sourceRevision: surface.sourceRevision,
          sourceHash: surface.sourceHash,
          poolComplete: surface.poolComplete,
        }),
    ...(inspected.discovery === undefined
      ? {}
      : {
          ...(inspected.discovery.requestedAdapter === undefined
            ? {}
            : { requestedAdapter: inspected.discovery.requestedAdapter }),
          ...(inspected.discovery.suggestedAdapter === undefined
            ? {}
            : { suggestedAdapter: inspected.discovery.suggestedAdapter }),
          discoveryReason: inspected.discovery.reason,
          sourceRevision: inspected.discovery.sourceRevision,
          sourceHash: inspected.discovery.sourceHash,
        }),
    candidates: surface?.candidateCount ?? 0,
    availableCandidates:
      inspected.discovery?.availableAdapters.reduce(
        (sum, { candidateCount }) => sum + candidateCount,
        0,
      ) ?? 0,
    availableAdapters:
      inspected.discovery?.availableAdapters.map((available) => ({
        adapterId: available.adapterId,
        candidates: available.candidateCount,
        identifierMatches: available.identifierMatchCount,
        candidatePoolMatches: available.candidatePoolMatchCount,
      })) ?? [],
    candidateExamples: inspected.discovery?.exampleCandidateIds ?? [],
    requiredInputs: surface?.requiredInputs.length ?? 0,
    requiredInputPaths: sourceRequiredInputPaths.slice(0, 32),
    requiredInputPathsTruncated: sourceRequiredInputPaths.length > 32,
    adapterRequiredInputPaths,
    unresolved: surface?.unsupported.length ?? 0,
  });
  result.code =
    surface !== undefined
      ? 'PROBABILITY_SOURCE_INSPECTED'
      : inspected.discovery !== undefined
        ? 'PROBABILITY_SOURCE_DISCOVERED'
        : 'PROBABILITY_ADAPTERS_LISTED';
  result.artifacts = inspected.artifacts;
  setInlineFilesScanned(result, inspected.filesScanned);
  return result;
}

/** Compare, sweep, simulate, sequence, or render through one entry point. */
export async function analyzeProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilityAnalyzeToolRequest,
  context: ProbabilityOperationContext,
) {
  const split = splitProbabilityAnalyzeRequest(input);
  switch (split.analysis) {
    case 'compare':
      return compareProbabilities(analyzer, split.request, context);
    case 'sweep':
      return sweepProbabilities(analyzer, split.request, context);
    case 'simulate':
      return simulateProbabilities(analyzer, split.request, context);
    case 'sequence':
      return sequenceProbabilities(analyzer, split.request, context);
    case 'render':
      return renderProbabilities(analyzer, split.request, context);
  }
}

export function normalizeProbabilityAnalyzeRequest(input: unknown): ProbabilityAnalyzeToolRequest {
  return probabilityAnalyzeRequestSchema.parse(input);
}

export async function evaluateProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilityEvaluateToolRequest,
  context: ProbabilityOperationContext,
) {
  const analyzed = await analyzer.evaluate({
    ...runtime(context, input.refresh),
    ...input,
    workspaceId: context.workspaceId,
  } as ProbabilityAnalysisRequest);
  return probabilityAnalysisServiceResult(context.workspaceId, analyzed);
}

export async function sweepProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilitySweepToolRequest,
  context: ProbabilityOperationContext,
) {
  const analyzed = await analyzer.sweep({
    ...runtime(context, input.refresh),
    ...input,
    workspaceId: context.workspaceId,
  } as ProbabilitySweepRequest);
  return probabilityAnalysisServiceResult(context.workspaceId, analyzed);
}

export async function simulateProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilitySimulateToolRequest,
  context: ProbabilityOperationContext,
) {
  const analyzed = await analyzer.simulate({
    ...runtime(context, input.refresh),
    ...input,
    workspaceId: context.workspaceId,
  } as ProbabilitySimulationRequest);
  return probabilityAnalysisServiceResult(context.workspaceId, analyzed);
}

export async function sequenceProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilitySequenceToolRequest,
  context: ProbabilityOperationContext,
) {
  const analyzed = await analyzer.sequence({
    ...runtime(context),
    ...input,
    workspaceId: context.workspaceId,
  } as ProbabilitySequenceRequest);
  return probabilityAnalysisServiceResult(context.workspaceId, analyzed);
}

export async function compareProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilityCompareToolRequest,
  context: ProbabilityOperationContext,
) {
  const analyzed = await analyzer.compare({
    ...runtime(context, input.refresh),
    ...input,
    workspaceId: context.workspaceId,
  } as ProbabilityCompareRequest);
  return probabilityAnalysisServiceResult(context.workspaceId, analyzed);
}

export async function renderProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilityRenderToolRequest,
  context: ProbabilityOperationContext,
) {
  const analyzed = await analyzer.render({
    ...runtime(context),
    ...input,
    workspaceId: context.workspaceId,
    outputs: input.outputs.filter((output) => output !== 'json'),
  } as ProbabilityRenderRequest);
  return probabilityAnalysisServiceResult(context.workspaceId, analyzed);
}
