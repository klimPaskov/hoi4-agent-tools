import { compareCodeUnits } from '../core/canonical.js';
import type { HelperExpansionInventory } from '../core/helper-expansion.js';
import type { EventGraphSnapshot } from './model.js';

export function eventHelperInventory(graph: EventGraphSnapshot): HelperExpansionInventory {
  const helpers = new Set(graph.nodes.filter(({ kind }) => kind === 'helper').map(({ id }) => id));
  const structural = graph.edges.filter(({ derived }) => !derived);
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
  };
}
