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

export async function inspectProbabilities(
  analyzer: ProbabilityAnalyzer,
  input: ProbabilityInspectToolRequest,
  context: ProbabilityOperationContext,
) {
  const inspected = await analyzer.inspect(
    runtime(context, input.refresh),
    input.adapter,
    input.source as ProbabilityAnalysisRequest['source'] | undefined,
    input.candidatePool,
    input.customPoolManifest as ProbabilitySequenceRequest['customPoolManifest'] | undefined,
  );
  const result = emptyServiceResult(context.workspaceId, {
    adapters: inspected.adapters.length,
    ...(inspected.surface === undefined
      ? {}
      : {
          adapterId: inspected.surface.adapter.id,
          sourceRevision: inspected.surface.sourceRevision,
          sourceHash: inspected.surface.sourceHash,
          poolComplete: inspected.surface.poolComplete,
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
    candidates: inspected.surface?.candidateCount ?? 0,
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
    requiredInputs: inspected.surface?.requiredInputs.length ?? 0,
    unresolved: inspected.surface?.unsupported.length ?? 0,
  });
  result.code =
    inspected.surface !== undefined
      ? 'PROBABILITY_SOURCE_INSPECTED'
      : inspected.discovery !== undefined
        ? 'PROBABILITY_SOURCE_DISCOVERED'
        : 'PROBABILITY_ADAPTERS_LISTED';
  result.artifacts = inspected.artifacts;
  setInlineFilesScanned(result, inspected.filesScanned);
  return result;
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
