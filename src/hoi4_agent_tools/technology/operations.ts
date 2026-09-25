import { publicArtifactLink } from '../core/artifacts.js';
import { helperExpansionValidation } from '../core/helper-expansion.js';
import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import { emptyServiceResult } from '../core/result.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import {
  technologyCompareRequestSchema,
  technologyInspectRequestSchema,
  technologyRenderRequestSchema,
} from '../schemas/technology.js';
import type { TechnologyGraphSnapshot } from './model.js';
import type { TechnologyRenderBundle } from './render.js';
import { technologyDiagnostics } from './service.js';
import type {
  TechnologyTreeViewer,
  TechnologyAnalysisInput,
  TechnologyCompareInput,
  TechnologyRenderServiceInput,
} from './service.js';

export function normalizeTechnologyInspectionRequest(input: unknown): TechnologyAnalysisInput {
  return JSON.parse(
    JSON.stringify(technologyInspectRequestSchema.parse(input)),
  ) as TechnologyAnalysisInput;
}

export function normalizeTechnologyRenderRequest(input: unknown): TechnologyRenderServiceInput {
  return JSON.parse(
    JSON.stringify(technologyRenderRequestSchema.parse(input)),
  ) as TechnologyRenderServiceInput;
}

export function normalizeTechnologyCompareRequest(input: unknown): TechnologyCompareInput {
  return JSON.parse(
    JSON.stringify(technologyCompareRequestSchema.parse(input)),
  ) as TechnologyCompareInput;
}

export function technologyGraphHash(graph: TechnologyGraphSnapshot): string {
  return hashCanonical({
    schemaVersion: graph.schemaVersion,
    analysisMode: graph.analysisMode ?? 'full',
    workspaceIdentity: graph.workspaceIdentity,
    revision: graph.revision,
    statistics: graph.statistics,
    sourceHashes: graph.sourceHashes,
  });
}

export function technologyCounts(graph: TechnologyGraphSnapshot, artifacts: number) {
  return {
    technologies: graph.statistics.technologyCount,
    legacyDoctrines: graph.statistics.legacyDoctrineCount,
    folders: graph.statistics.folderCount,
    placements: graph.statistics.placementCount,
    edges: graph.edges.length,
    unlocks: graph.statistics.unlockCount,
    references: graph.statistics.externalReferenceCount,
    issues: graph.statistics.issueCount,
    unresolved: graph.statistics.unresolvedCount,
    artifacts,
  };
}

export function technologyValidation(graph: TechnologyGraphSnapshot) {
  const blocking = technologyDiagnostics(graph).filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  ).length;
  return {
    passed: graph.complete && blocking === 0,
    checks: [
      {
        id: 'technology-analysis',
        passed: graph.complete && blocking === 0,
        message: graph.complete
          ? `${blocking} blocking technology diagnostics; full evidence is linked`
          : graph.analysisMode === 'focused'
            ? 'Helper projections were deferred for this large workspace; direct evidence is linked'
            : graph.unresolved.some(({ blockers }) =>
                  blockers.some(
                    ({ code }) =>
                      code === 'TECH_HELPER_DEPTH_BLOCKED' ||
                      code === 'TECH_HELPER_PROJECTION_LIMIT',
                  ),
                )
              ? 'Helper expansion reached a depth or materialization boundary; helper_expansion mode provides bounded source-linked continuation'
              : `${graph.skippedSourceCount} source(s) were skipped; full evidence is linked`,
      },
    ],
  };
}

export function technologyRenderValidation(
  graph: TechnologyGraphSnapshot,
  render: TechnologyRenderBundle,
) {
  const omitted = render.omittedNodeCount;
  const unresolvedSprites = render.unresolvedIconSprites.length;
  const sourcePlacementPassed = render.view !== 'folder' || render.sourceAccurate;
  const analysisBoundaryPassed =
    graph.complete || (graph.analysisMode === 'focused' && graph.skippedSourceCount === 0);
  const renderPassed = sourcePlacementPassed && omitted === 0 && unresolvedSprites === 0;
  return {
    passed: renderPassed && analysisBoundaryPassed,
    checks: [
      {
        id: 'technology-render',
        passed: renderPassed,
        message: renderPassed
          ? 'The requested technology view rendered with complete node and sprite coverage'
          : `${sourcePlacementPassed ? 0 : 1} source-placement failure(s), ${omitted} omitted node(s), and ${unresolvedSprites} unresolved sprite(s) affect the requested technology view`,
      },
      {
        id: 'technology-analysis-boundary',
        passed: analysisBoundaryPassed,
        message: graph.complete
          ? 'The supporting technology analysis is complete'
          : analysisBoundaryPassed
            ? 'Whole-workspace helper projections were deferred; the requested render retains direct source evidence'
            : `${graph.skippedSourceCount} technology source(s) were skipped; linked evidence records the partial analysis boundary`,
      },
    ],
  };
}

export async function inspectTechnologies(
  viewer: TechnologyTreeViewer,
  input: TechnologyAnalysisInput,
) {
  const output = await viewer.analyze(input);
  const result = emptyServiceResult(input.workspaceId, {
    mode: input.mode,
    revision: output.graph.revision,
    graphHash: technologyGraphHash(output.graph),
    counts: technologyCounts(output.graph, output.artifacts.length),
    ...(output.helperExpansion === undefined ? {} : { helperExpansion: output.helperExpansion }),
  });
  result.code =
    (output.helperExpansion?.complete ?? output.graph.complete)
      ? 'TECH_INSPECTED'
      : 'TECH_INSPECTED_PARTIAL';
  setInlineFilesScanned(result, output.graph.filesScanned);
  result.artifacts = output.artifacts.map(publicArtifactLink);
  result.validation = technologyValidation(output.graph);
  if (output.helperExpansion !== undefined)
    result.validation = helperExpansionValidation(output.helperExpansion);
  return result;
}

export async function renderTechnologies(
  viewer: TechnologyTreeViewer,
  input: TechnologyRenderServiceInput,
) {
  const output = await viewer.renderAndStore(input);
  const result = emptyServiceResult(input.workspaceId, {
    view: output.render.view,
    revision: output.graph.revision,
    graphHash: technologyGraphHash(output.graph),
    hashes: output.render.hashes,
    selectedNodes: output.render.selectedIds.length,
    omittedNodes: output.render.omittedNodeCount,
    focusedRenders: output.focused.length,
    sourceAccurate: output.render.sourceAccurate,
  });
  result.code = output.graph.complete ? 'TECH_RENDERED' : 'TECH_RENDERED_PARTIAL';
  setInlineFilesScanned(result, output.graph.filesScanned);
  result.artifacts = output.artifacts.map(publicArtifactLink);
  result.validation = technologyRenderValidation(output.graph, output.render);
  return result;
}

export async function compareTechnologies(
  viewer: TechnologyTreeViewer,
  input: TechnologyCompareInput,
) {
  const output = await viewer.compareAndStore(input);
  const comparison = output.comparison;
  const result = emptyServiceResult(input.workspaceId, {
    beforeRevision: comparison.beforeRevision,
    afterRevision: comparison.afterRevision,
    added: comparison.technologies.added.length,
    removed: comparison.technologies.removed.length,
    renamed: comparison.technologies.renamed.length,
    moved: comparison.technologies.moved.length,
    regressions: comparison.regressions.length,
    artifacts: output.artifacts.length,
    ...(output.render === undefined ? {} : { renderHashes: output.render.hashes }),
  });
  result.code =
    output.before.complete && output.after.complete ? 'TECH_COMPARED' : 'TECH_COMPARED_PARTIAL';
  setInlineFilesScanned(
    result,
    [...new Set([...output.before.filesScanned, ...output.after.filesScanned])].sort(
      compareCodeUnits,
    ),
  );
  result.artifacts = output.artifacts.map(publicArtifactLink);
  result.validation = {
    passed: technologyValidation(output.before).passed && technologyValidation(output.after).passed,
    checks: [
      ...technologyValidation(output.before).checks,
      ...technologyValidation(output.after).checks,
    ],
  };
  return result;
}
