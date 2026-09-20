import { compareCodeUnits, hashCanonical } from './canonical.js';
import type { ScanSnapshot } from './engine.js';
import {
  inspectImpactGraph,
  type ImpactEdge,
  type ImpactGraphResult,
  type ImpactQuery,
} from './impact-graph.js';

export interface ImpactGraphComparison {
  beforeRevision: string;
  afterRevision: string;
  complete: boolean;
  before: ImpactGraphResult;
  after: ImpactGraphResult;
  addedConsumers: ImpactEdge[];
  removedConsumers: ImpactEdge[];
  newlyAffectedFiles: string[];
  noLongerAffectedFiles: string[];
}

function edgeIdentity(edge: ImpactEdge): string {
  const targetDefinition = edge.targetDefinition;
  return hashCanonical({
    source: edge.source,
    target: edge.target,
    targetDefinition:
      targetDefinition === undefined
        ? null
        : {
            path: targetDefinition.path,
            rootKind: targetDefinition.rootKind,
            loadOrder: targetDefinition.loadOrder,
          },
    referenceKind: edge.referenceKind,
    accessRole: edge.accessRole,
  });
}

function consumers(result: ImpactGraphResult): ImpactEdge[] {
  return [...result.directConsumers, ...result.transitiveConsumers];
}

/** Compare typed dependency consumers under the same selection and bounds. */
export function compareImpactGraphs(
  beforeSnapshot: ScanSnapshot,
  afterSnapshot: ScanSnapshot,
  query: ImpactQuery,
): ImpactGraphComparison {
  if (beforeSnapshot.workspaceId !== afterSnapshot.workspaceId)
    throw new Error('Impact comparison crosses workspace boundaries');
  const before = inspectImpactGraph(beforeSnapshot, query);
  const after = inspectImpactGraph(afterSnapshot, query);
  const beforeEdges = consumers(before);
  const afterEdges = consumers(after);
  const beforeKeys = new Set(beforeEdges.map(edgeIdentity));
  const afterKeys = new Set(afterEdges.map(edgeIdentity));
  const beforeFiles = new Set(before.affectedFiles);
  const afterFiles = new Set(after.affectedFiles);
  return {
    beforeRevision: before.sourceRevision,
    afterRevision: after.sourceRevision,
    complete: before.complete && after.complete,
    before,
    after,
    addedConsumers: afterEdges.filter((edge) => !beforeKeys.has(edgeIdentity(edge))),
    removedConsumers: beforeEdges.filter((edge) => !afterKeys.has(edgeIdentity(edge))),
    newlyAffectedFiles: after.affectedFiles
      .filter((file) => !beforeFiles.has(file))
      .sort(compareCodeUnits),
    noLongerAffectedFiles: before.affectedFiles
      .filter((file) => !afterFiles.has(file))
      .sort(compareCodeUnits),
  };
}
