import { analysisSourceEvidence } from '../core/analysis-evidence.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import type { ConditionScenario } from '../core/condition-model.js';
import type { CoreEngine } from '../core/engine.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { buildProposedSourceOverlay } from '../core/source-overlay.js';
import { nearestNames } from '../reference/suggestions.js';
import { PACKAGE_VERSION } from '../version.js';
import type { DecisionInspectRequest } from '../schemas/analysis.js';
import { inspectDecisionAi } from './ai.js';
import { compareDecisionScenarios, inspectDecisionScenario } from './comparison.js';
import {
  decisionSourceInventory,
  decisionTargetCatalog,
  type DecisionSourceInventory,
} from './source-inventory.js';

/**
 * An inventory narrowed to one category (its decisions) or one decision (#59). Any other id is
 * not-found with close names, never a whole-workspace inventory.
 */
function scopedInventory(
  inventory: DecisionSourceInventory,
  id: string,
  complete: boolean,
): DecisionSourceInventory {
  const ids = new Set([id]);
  const isCategory = inventory.categories.some((category) => category.id === id);
  const decisions = inventory.decisions.filter((source) =>
    isCategory ? source.category === id : source.id === id,
  );
  if (!isCategory && decisions.length === 0) {
    const suggestions = nearestNames(
      id,
      new Set([
        ...inventory.categories.map((category) => category.id),
        ...inventory.decisions.map((source) => source.id),
      ]),
    );
    throw new ServiceError(
      'DECISION_NOT_FOUND',
      `No decision or decision category ${id.slice(0, 256)} is defined${complete ? '' : ' in the scanned files (the scan is incomplete)'}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
      { id: id.slice(0, 256), suggestions, scanComplete: complete },
    );
  }
  for (const source of decisions) {
    ids.add(source.category);
    ids.add(source.id);
  }
  return {
    ...inventory,
    decisions,
    categories: inventory.categories.filter((category) => ids.has(category.id)),
    overrides: inventory.overrides.filter((override) => ids.has(override.id)),
    unresolvedDefinitions: inventory.unresolvedDefinitions.filter((entry) => ids.has(entry.id)),
  };
}

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
    const fullInventory = decisionSourceInventory(before);
    const inventory =
      input.mode === 'inventory' && input.id !== undefined
        ? scopedInventory(fullInventory, input.id, before.complete)
        : fullInventory;
    if (
      input.mode === 'inspect' &&
      input.id !== undefined &&
      !inventory.decisions.some((source) => source.id === input.id)
    ) {
      const suggestions = nearestNames(
        input.id,
        new Set(inventory.decisions.map((source) => source.id)),
      );
      throw new ServiceError(
        'DECISION_NOT_FOUND',
        `No decision ${input.id.slice(0, 256)} is defined${before.complete ? '' : ' in the scanned files (the scan is incomplete)'}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(', ')}?`}`,
        { id: input.id.slice(0, 256), suggestions, scanComplete: before.complete },
      );
    }
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
      // A scoped inventory answers inline: the decisions of that category or the one decision.
      ...(input.mode === 'inventory' && input.id !== undefined
        ? {
            decisionIds: inventory.decisions.slice(0, 64).map(({ id }) => id),
            decisionIdsTruncated: inventory.decisions.length > 64,
          }
        : {}),
      unresolvedDefinitions: inventory.unresolvedDefinitions.length,
      ...(inventory.unresolvedDefinitions.length === 0
        ? {}
        : {
            unresolvedSample: inventory.unresolvedDefinitions
              .slice(0, 8)
              .map(({ id, path, reason }) => ({ id, path, reason })),
          }),
      // The gate outcome of each scenario answers most inspections without the report.
      ...(input.mode === 'inspect' && Array.isArray(analysis)
        ? {
            outcomes: analysis.slice(0, 16).map(({ scenarioId, inspection }) =>
              inspection === null
                ? { scenarioId, found: false }
                : {
                    scenarioId,
                    found: true,
                    eligible: inspection.gates.eligible,
                    visible: inspection.gates.visible,
                    available: inspection.gates.available,
                    ...(inspection.gates.unresolved.length === 0
                      ? {}
                      : {
                          unresolved: inspection.gates.unresolved
                            .slice(0, 5)
                            .map(({ code, message }) => ({ code, message: message.slice(0, 300) })),
                        }),
                  },
            ),
          }
        : {}),
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
