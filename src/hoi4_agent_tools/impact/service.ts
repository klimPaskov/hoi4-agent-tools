import { analysisSourceEvidence } from '../core/analysis-evidence.js';
import { publicArtifactLink } from '../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import type { CoreEngine } from '../core/engine.js';
import { compareImpactGraphs } from '../core/impact-comparison.js';
import { inspectImpactGraph, type ImpactQuery } from '../core/impact-graph.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { buildProposedSourceOverlay } from '../core/source-overlay.js';
import { nearestNames } from '../reference/suggestions.js';
import { PACKAGE_VERSION } from '../version.js';
import type { ImpactInspectRequest } from '../schemas/analysis.js';
import { inspectImpactScenarioSuites } from './scenario-suites.js';

export interface ImpactServiceInput extends ImpactInspectRequest {
  principal?: string;
  signal?: AbortSignal;
}

/** Authorized, read-only impact operation shared by ordinary calls and persistent jobs. */
export class ImpactAnalyzer {
  constructor(private readonly engine: CoreEngine) {}

  async inspect(input: ImpactServiceInput) {
    const workspace = this.engine.resolver.get(input.workspaceId, input.principal);
    if (input.refresh) this.engine.invalidate(input.workspaceId);
    const before = await this.engine.scan(input.workspaceId, {}, input.principal, input.signal);
    if (input.expectedRevision !== undefined && before.revision !== input.expectedRevision)
      throw new ServiceError(
        'IMPACT_SOURCE_STALE',
        'Impact source revision changed since selection',
        {
          expectedRevision: input.expectedRevision,
          observedRevision: before.revision,
        },
      );
    const overlay =
      input.proposedSources === undefined
        ? undefined
        : buildProposedSourceOverlay(before, workspace, input.proposedSources);
    const availablePaths = new Set([
      ...before.files.map(({ displayPath }) => displayPath),
      ...(overlay?.snapshot.files.map(({ displayPath }) => displayPath) ?? []),
      ...(overlay?.changes.map(({ path }) => path) ?? []),
    ]);
    for (const file of input.changedFiles)
      if (!availablePaths.has(file))
        throw new ServiceError(
          'IMPACT_SOURCE_UNKNOWN',
          'Changed file is not in the authorized source inventory or proposed overlay',
          { file },
        );
    // A symbol that nothing defines or names would answer an empty graph; say so instead (#59).
    const indexes = [before.index, ...(overlay === undefined ? [] : [overlay.snapshot.index])];
    const unknown = input.symbols.filter(
      ({ kind, id }) =>
        !indexes.some(
          (index) =>
            index.find(kind, id) !== undefined ||
            index.references.some((reference) => reference.toKind === kind && reference.to === id),
        ),
    );
    if (unknown.length > 0) {
      const symbols = unknown.map(({ kind, id }) => ({
        kind,
        id: id.slice(0, 256),
        suggestions: nearestNames(
          id,
          new Set(before.index.findAll(kind).map((symbol) => symbol.id)),
        ),
      }));
      throw new ServiceError(
        'IMPACT_SYMBOL_NOT_FOUND',
        `Nothing defines or uses ${symbols
          .map(
            ({ kind, id, suggestions }) =>
              `${kind} ${id}${suggestions.length === 0 ? '' : ` (did you mean ${suggestions.join(', ')}?)`}`,
          )
          .join('; ')}${before.complete ? '' : ' in the scanned files (the scan is incomplete)'}`,
        { symbols, scanComplete: before.complete },
      );
    }
    const query: ImpactQuery = {
      symbols: input.symbols,
      changedFiles:
        input.changedFiles.length > 0
          ? input.changedFiles
          : (overlay?.changes.map(({ path }) => path) ?? []),
      ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
      ...(input.maxEdges === undefined ? {} : { maxEdges: input.maxEdges }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    };
    const comparison =
      overlay === undefined ? undefined : compareImpactGraphs(before, overlay.snapshot, query);
    const graph = comparison?.after ?? inspectImpactGraph(before, query);
    const analysis = comparison ?? graph;
    const suiteGraph =
      comparison === undefined
        ? graph
        : {
            ...graph,
            directConsumers: [...comparison.before.directConsumers, ...graph.directConsumers],
            transitiveConsumers: [
              ...comparison.before.transitiveConsumers,
              ...graph.transitiveConsumers,
            ],
            affectedFiles: [
              ...new Set([...comparison.before.affectedFiles, ...graph.affectedFiles]),
            ],
          };
    const scenarioSuites = await inspectImpactScenarioSuites(
      workspace,
      input.scenarioSuites,
      suiteGraph,
      input.symbols,
      input.signal,
    );
    const complete = analysis.complete && scenarioSuites.complete;
    const report = {
      schemaVersion: 'impact-analysis.v1',
      mode: overlay === undefined ? 'inspect' : 'compare',
      query,
      ...(overlay === undefined ? {} : { proposedChanges: overlay.changes }),
      analysis,
      scenarioSuites,
    };
    const reportHash = hashCanonical(report);
    const artifactName = `impact-${reportHash.slice(0, 24)}.json`;
    const provenanceSources = analysisSourceEvidence(
      before,
      overlay?.snapshot,
      scenarioSuites.sourceHashes,
    );
    const artifact = await this.engine.artifacts.putChunked(
      workspace,
      artifactName,
      'application/json',
      `${canonicalJson(report)}\n`,
      {
        kind: 'impact-analysis',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'impact-analysis.v1',
        sourceHashes: provenanceSources.sourceHashes,
        metadata: {
          beforeRevision: before.revision,
          ...(overlay === undefined ? {} : { afterRevision: overlay.snapshot.revision }),
          sourceInventory: provenanceSources.inventory,
        },
      },
      'Revision-pinned cross-system impact graph and source evidence',
      input.signal,
    );
    const result = emptyServiceResult(input.workspaceId, {
      mode: overlay === undefined ? 'inspect' : 'compare',
      sourceRevision: before.revision,
      ...(overlay === undefined ? {} : { proposedRevision: overlay.snapshot.revision }),
      reportHash,
      complete,
      definitions: graph.definitions.length,
      directConsumers: graph.directConsumers.length,
      transitiveConsumers: graph.transitiveConsumers.length,
      affectedFiles: graph.affectedFiles.length,
      // Affected files are evidence, not writes: this read-only analysis never changes a file.
      affectedFilePaths: graph.affectedFiles.slice(0, 64),
      cycles: graph.cycles.length,
      scenarioSuites: scenarioSuites.scannedSuites,
      affectedCases: scenarioSuites.matches.length,
      unresolved:
        graph.unresolved.length + graph.dynamicReferences.length + scenarioSuites.unresolved.length,
      ...(comparison === undefined
        ? {}
        : {
            addedConsumers: comparison.addedConsumers.length,
            removedConsumers: comparison.removedConsumers.length,
          }),
    });
    result.code = complete ? 'IMPACT_ANALYZED' : 'IMPACT_ANALYZED_PARTIAL';
    result.artifacts = [publicArtifactLink(artifact)];
    result.proposedFiles = overlay?.changes.map(({ path }) => path).slice(0, 64) ?? [];
    // The seed files and the files of the consumers, not the first files of the workspace (#66).
    setInlineFilesScanned(result, [
      ...new Set([...(query.changedFiles ?? []), ...suiteGraph.affectedFiles]),
    ]);
    result.validation = {
      passed: complete,
      checks: [
        {
          id: 'impact-coverage',
          passed: complete,
          message: complete
            ? 'Selected impact graph is complete under the declared bounds'
            : 'Impact graph has source, dynamic-reference, or traversal boundaries; inspect the linked report',
        },
      ],
    };
    return result;
  }
}
