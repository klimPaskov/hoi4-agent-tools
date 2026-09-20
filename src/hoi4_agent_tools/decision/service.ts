import { analysisSourceEvidence } from '../core/analysis-evidence.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import type { ConditionScenario } from '../core/condition-model.js';
import type { CoreEngine } from '../core/engine.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { buildProposedSourceOverlay } from '../core/source-overlay.js';
import { PACKAGE_VERSION } from '../version.js';
import type { DecisionInspectRequest } from '../schemas/analysis.js';
import { inspectDecisionAi } from './ai.js';
import { compareDecisionScenarios, inspectDecisionScenario } from './comparison.js';
import { decisionSourceInventory, decisionTargetCatalog } from './source-inventory.js';

export interface DecisionServiceInput extends DecisionInspectRequest {
  principal?: string;
  signal?: AbortSignal;
}

/** Authorized, read-only decision operation over the shared source scanner. */
export class DecisionAnalyzer {
  constructor(private readonly engine: CoreEngine) {}

  async inspect(input: DecisionServiceInput) {
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    if (input.refresh) this.engine.invalidate(input.workspaceId);
    const before = await this.engine.scan(input.workspaceId, {}, input.principal, input.signal);
    if (input.expectedRevision !== undefined && before.revision !== input.expectedRevision)
      throw new ServiceError(
        'DECISION_SOURCE_STALE',
        'Decision source revision changed since selection',
        {
          expectedRevision: input.expectedRevision,
          observedRevision: before.revision,
        },
      );
    if (input.mode !== 'inventory' && input.id === undefined)
      throw new ServiceError('DECISION_ID_REQUIRED', 'Decision analysis requires an identifier');
    if (input.mode !== 'inventory' && input.scenarios.length === 0)
      throw new ServiceError('DECISION_SCENARIOS_REQUIRED', 'Decision analysis requires scenarios');
    if (input.mode === 'compare' && input.proposedSources === undefined)
      throw new ServiceError(
        'DECISION_PROPOSAL_REQUIRED',
        'Decision comparison requires proposed sources',
      );
    if (input.mode !== 'compare' && input.proposedSources !== undefined)
      throw new ServiceError('DECISION_PROPOSAL_MODE', 'Proposed sources require compare mode');
    const inventory = decisionSourceInventory(before);
    const overlay =
      input.proposedSources === undefined
        ? undefined
        : buildProposedSourceOverlay(before, workspace, input.proposedSources);
    const scenarios: ConditionScenario[] = input.scenarios.map((scenario) => ({
      id: scenario.id,
      state: scenario.state,
      ...(scenario.actor === undefined ? {} : { actor: scenario.actor }),
      ...(scenario.date === undefined ? {} : { date: scenario.date }),
      ...(scenario.flags === undefined ? {} : { flags: scenario.flags }),
      ...(scenario.eventTargets === undefined ? {} : { eventTargets: scenario.eventTargets }),
      ...(scenario.candidateOverrides === undefined
        ? {}
        : { candidateOverrides: scenario.candidateOverrides }),
      ...(scenario.closedFlags === undefined ? {} : { closedFlags: scenario.closedFlags }),
      ...(scenario.scopes === undefined
        ? {}
        : {
            scopes: Object.fromEntries(
              Object.entries(scenario.scopes).map(([key, binding]) => [
                key,
                {
                  id: binding.id,
                  state: binding.state,
                  ...(binding.type === undefined ? {} : { type: binding.type }),
                  ...(binding.actor === undefined ? {} : { actor: binding.actor }),
                  ...(binding.flags === undefined ? {} : { flags: binding.flags }),
                  ...(binding.eventTargets === undefined
                    ? {}
                    : { eventTargets: binding.eventTargets }),
                  ...(binding.weight === undefined ? {} : { weight: binding.weight }),
                },
              ]),
            ),
          }),
    }));
    const analysis =
      input.mode === 'inventory'
        ? {
            decisions: inventory.decisions.map((source) => ({
              id: source.id,
              category: source.category,
              kind: source.kind,
              path: source.path,
              rootKind: source.rootKind,
              loadOrder: source.loadOrder,
              ...(source.location === undefined ? {} : { location: source.location }),
              targeting: decisionTargetCatalog(source),
              fields: Object.fromEntries(
                Object.entries(source.fields)
                  .filter(([, occurrences]) => occurrences.length > 0)
                  .map(([field, occurrences]) => [field, occurrences.length]),
              ),
            })),
            categories: inventory.categories.map(({ id, path, rootKind, loadOrder, location }) => ({
              id,
              path,
              rootKind,
              loadOrder,
              ...(location === undefined ? {} : { location }),
            })),
            overrides: inventory.overrides,
            unresolvedDefinitions: inventory.unresolvedDefinitions,
          }
        : input.mode === 'compare' && overlay !== undefined
          ? compareDecisionScenarios(before, overlay.snapshot, input.id!, scenarios)
          : scenarios.map((scenario) => ({
              scenarioId: scenario.id,
              inspection: inspectDecisionScenario(before, input.id!, scenario),
            }));
    const ai =
      input.mode === 'inventory'
        ? undefined
        : await inspectDecisionAi(
            this.engine,
            before,
            input.id!,
            scenarios,
            overlay,
            input.principal,
            input.signal,
          );
    const sourceComplete =
      input.mode === 'inventory'
        ? inventory.complete
        : input.mode === 'compare'
          ? 'complete' in analysis && analysis.complete
          : inventory.complete &&
            Array.isArray(analysis) &&
            analysis.every(
              ({ inspection }) =>
                inspection !== null &&
                inspection.gates.complete &&
                inspection.cost.unresolved.length === 0 &&
                inspection.lifecycle.unresolved.length === 0,
            );
    const complete =
      sourceComplete &&
      (ai === undefined ||
        ('status' in ai &&
          ai.status === 'complete' &&
          !('proposedUnresolved' in ai) &&
          !('baselineUnresolved' in ai)));
    const report = {
      schemaVersion: 'decision-analysis.v1',
      mode: input.mode,
      sourceRevision: before.revision,
      ...(overlay === undefined ? {} : { proposedRevision: overlay.snapshot.revision }),
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(overlay === undefined ? {} : { proposedChanges: overlay.changes }),
      analysis,
      ...(ai === undefined ? {} : { ai }),
    };
    const reportHash = hashCanonical(report);
    const provenanceSources = analysisSourceEvidence(before, overlay?.snapshot);
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      `decision-${reportHash.slice(0, 24)}.json`,
      'application/json',
      `${canonicalJson(report)}\n`,
      {
        kind: 'decision-analysis',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'decision-analysis.v1',
        sourceHashes: provenanceSources.sourceHashes,
        metadata: {
          beforeRevision: before.revision,
          ...(overlay === undefined ? {} : { afterRevision: overlay.snapshot.revision }),
          sourceInventory: provenanceSources.inventory,
        },
      },
      'Revision-pinned decision inventory or declared-scenario evidence',
      input.signal,
    );
    const result = emptyServiceResult(input.workspaceId, {
      mode: input.mode,
      sourceRevision: before.revision,
      ...(overlay === undefined ? {} : { proposedRevision: overlay.snapshot.revision }),
      reportHash,
      complete,
      decisions: inventory.decisions.length,
      categories: inventory.categories.length,
      overrides: inventory.overrides.length,
      scenarios: input.mode === 'inventory' ? 0 : input.scenarios.length,
      unresolvedDefinitions: inventory.unresolvedDefinitions.length,
    });
    result.code = complete ? 'DECISION_ANALYZED' : 'DECISION_ANALYZED_PARTIAL';
    result.artifacts = [publicArtifactLink(artifact)];
    result.proposedFiles = overlay?.changes.map(({ path }) => path).slice(0, 64) ?? [];
    setInlineFilesScanned(
      result,
      before.files.map(({ displayPath }) => displayPath),
    );
    result.validation = {
      passed: complete,
      checks: [
        {
          id: 'decision-coverage',
          passed: complete,
          message: complete
            ? 'Decision evidence is complete under the declared scenarios'
            : 'Decision evidence contains a missing definition, unbound scenario input, or unsupported source path; inspect the linked report',
        },
      ],
    };
    return result;
  }
}
