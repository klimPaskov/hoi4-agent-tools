import type { ConditionScenario } from '../core/condition-model.js';
import type { CoreEngine, ScanSnapshot } from '../core/engine.js';
import type { ProposedOverlayResult } from '../core/source-overlay.js';
import { ProbabilityAnalyzer } from '../probability/service.js';
import type {
  ProbabilityAdapterId,
  ProbabilityAnalysisResult,
  ProbabilityScenarioSet,
  ProbabilitySourceInput,
} from '../probability/model.js';
import { decisionSourceInventory, type DecisionSource } from './source-inventory.js';

function selected(snapshot: ScanSnapshot, id: string): DecisionSource | undefined {
  return decisionSourceInventory(snapshot).decisions.find(({ id: candidate }) => candidate === id);
}

function summary(result: ProbabilityAnalysisResult) {
  return {
    analysisId: result.analysisId,
    status: result.status,
    adapter: result.adapter.id,
    sourceHash: result.metadata.sourceHash,
    scenarios: result.scenarios.map((scenario) => ({
      id: scenario.id,
      candidates: scenario.candidates.map((candidate) => ({
        id: candidate.id,
        eligibility: candidate.eligibility,
        supportLevel: candidate.supportLevel,
        ...(candidate.rawValue === undefined ? {} : { rawValue: candidate.rawValue }),
        unresolved: candidate.unresolved,
      })),
      unresolved: scenario.unresolved,
    })),
    unresolved: result.unresolved,
    ...(result.comparison === undefined ? {} : { comparison: result.comparison }),
    resources: result.resources,
  };
}

/** Uses the existing score-only probability adapters; never invents decision selection odds. */
export async function inspectDecisionAi(
  engine: CoreEngine,
  before: ScanSnapshot,
  id: string,
  scenarios: readonly ConditionScenario[],
  overlay?: ProposedOverlayResult,
  principal?: string,
  signal?: AbortSignal,
) {
  const source = selected(before, id);
  const proposed = overlay === undefined ? undefined : selected(overlay.snapshot, id);
  const baselineWeighted = (source?.fields.ai_will_do.length ?? 0) > 0;
  const proposedWeighted = (proposed?.fields.ai_will_do.length ?? 0) > 0;
  if (!baselineWeighted && !proposedWeighted) return undefined;
  const subject = source ?? proposed!;
  const adapter: ProbabilityAdapterId =
    subject.kind === 'mission' ? 'mission_ai_will_do' : 'decision_ai_will_do';
  const scenarioSet: ProbabilityScenarioSet = {
    schemaVersion: '1.0',
    id: `decision-${id}`,
    scenarios: scenarios.map(({ closedFlags: _closedFlags, ...scenario }) => scenario),
  };
  const analyzer = new ProbabilityAnalyzer(engine);
  const workspaceId = before.workspaceId;
  const context = {
    workspaceId,
    adapter,
    scenarioSet,
    outputs: ['json'] as Array<'json'>,
    ...(principal === undefined ? {} : { principal }),
    ...(signal === undefined ? {} : { signal }),
  };
  const sourceFile =
    source === undefined
      ? undefined
      : before.files.find(({ displayPath }) => displayPath === source.path);
  const baselineSelector: ProbabilitySourceInput | undefined =
    sourceFile === undefined
      ? undefined
      : { path: sourceFile.relativePath, identifier: id, expectedSourceHash: sourceFile.sha256 };
  const proposedFile =
    proposed === undefined
      ? undefined
      : overlay?.snapshot.files.find(({ displayPath }) => displayPath === proposed.path);
  const proposedSelector: ProbabilitySourceInput | undefined =
    proposedFile === undefined
      ? undefined
      : { virtualPatch: proposedFile.bytes.toString('utf8'), identifier: id };
  const isolatedProposal =
    overlay?.changes.length === 1 &&
    proposedFile !== undefined &&
    overlay.changes[0]?.path === proposedFile.displayPath;
  if (
    baselineWeighted &&
    proposedWeighted &&
    isolatedProposal &&
    baselineSelector &&
    proposedSelector
  ) {
    const compared = await analyzer.compare({
      ...context,
      before: baselineSelector,
      after: proposedSelector,
    });
    return { mode: 'compare' as const, ...summary(compared) };
  }
  if (baselineWeighted && baselineSelector) {
    const evaluated = await analyzer.evaluate({ ...context, source: baselineSelector });
    return {
      mode: 'baseline' as const,
      ...summary(evaluated),
      ...(overlay === undefined
        ? {}
        : {
            proposedUnresolved:
              'The proposal changes multiple sources or adds/removes the weighted decision; use probability_compare with explicit source selectors',
          }),
    };
  }
  if (proposedWeighted && proposedSelector) {
    const evaluated = await analyzer.evaluate({ ...context, source: proposedSelector });
    return {
      mode: 'proposed' as const,
      ...summary(evaluated),
      baselineUnresolved: 'The baseline has no matching weighted decision',
    };
  }
  return {
    mode: 'unresolved' as const,
    reason: 'Weighted decision source could not be selected for probability analysis',
  };
}
