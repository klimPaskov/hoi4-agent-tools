import { compareCodeUnits } from '../core/canonical.js';
import type { HelperExpansionInventory } from '../core/helper-expansion.js';
import type { EventGraphSnapshot, EventScopeKind } from './model.js';

export function eventHelperInventory(graph: EventGraphSnapshot): HelperExpansionInventory {
  const helpers = new Set(graph.nodes.filter(({ kind }) => kind === 'helper').map(({ id }) => id));
  const structural = graph.edges.filter(({ derived }) => !derived);
  const structuralById = new Map(structural.map((edge) => [edge.id, edge]));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const optionParents = new Map(
    graph.edges
      .filter(({ reason }) => reason === 'option_branch')
      .map(({ from, to }) => [to, from]),
  );
  const accessById = new Map(
    graph.stateAccesses
      .filter(({ ownerId }) => helpers.has(ownerId))
      .map((access) => [`state-access:${access.id}`, access]),
  );
  return {
    domain: 'event',
    sourceRevision: graph.revision,
    sourceComplete: graph.complete,
    sourceHashes: graph.sourceHashes,
    unresolved: graph.unresolved,
    edges: [
      ...structural.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        evidence: { kind: 'event_edge', edge },
      })),
      ...graph.stateAccesses
        .filter(({ ownerId }) => helpers.has(ownerId))
        .map((access) => ({
          id: `state-access:${access.id}`,
          from: access.ownerId,
          to: `state-access:${access.id}`,
          evidence: { kind: 'state_access', access },
        })),
    ].sort((left, right) => compareCodeUnits(left.id, right.id)),
    roots: structural
      .filter(({ from, to }) => !helpers.has(from) && helpers.has(to))
      .map(({ id }) => id)
      .sort(compareCodeUnits),
    branches: [...helpers].sort(compareCodeUnits),
    recordDetails: (path) => {
      let current: EventScopeKind = 'unknown';
      const root = structuralById.get(path[0]?.id ?? '');
      if (root !== undefined) {
        const caller = nodesById.get(optionParents.get(root.from) ?? root.from);
        const candidate =
          root.scope?.source ?? caller?.metadata.expectedScope ?? caller?.metadata.scope;
        if (
          candidate === 'country' ||
          candidate === 'state' ||
          candidate === 'province' ||
          candidate === 'unit_leader' ||
          candidate === 'operative' ||
          candidate === 'character' ||
          candidate === 'global'
        )
          current = candidate;
      }
      const transitions: Array<{
        edgeId: string;
        source: EventScopeKind;
        destination: EventScopeKind;
        confidence: string;
      }> = [];
      for (const { id } of path) {
        const edge = structuralById.get(id);
        if (edge?.scope !== undefined) {
          const { source, destination, confidence } = edge.scope;
          current =
            current !== 'unknown' && source !== 'unknown' && current !== source
              ? 'unknown'
              : destination;
          transitions.push({ edgeId: id, source, destination: current, confidence });
        }
        const access = accessById.get(id);
        if (access !== undefined) {
          return {
            scopeEvidence: {
              stateAccessId: access.id,
              declaredScope: access.scope,
              resolvedScope: access.scope === 'unknown' ? current : access.scope,
              transitions,
            },
          };
        }
      }
      return { scopeEvidence: { resolvedScope: current, transitions } };
    },
  };
}
