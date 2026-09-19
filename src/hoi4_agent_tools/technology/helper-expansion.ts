import { compareCodeUnits } from '../core/canonical.js';
import type { HelperExpansionInventory } from '../core/helper-expansion.js';
import type { TechnologyGraphSnapshot } from './model.js';

export function technologyHelperInventory(
  graph: TechnologyGraphSnapshot,
  sourceComplete: boolean,
): HelperExpansionInventory {
  return {
    domain: 'technology',
    sourceRevision: graph.revision,
    sourceComplete,
    sourceHashes: graph.sourceHashes,
    unresolved: graph.unresolved.filter(
      ({ id }) => id !== 'tech-unresolved-helper-expansion-deferred',
    ),
    edges: [
      ...graph.helperCalls.map((call) => ({
        id: call.id,
        from: `${call.sourceKind}:${call.sourceId}`,
        to: `scripted_effect:${call.helperId}`,
        evidence: { kind: 'helper_call', call },
      })),
      ...graph.externalReferences
        .filter(({ sourceKind }) => sourceKind === 'scripted_effect')
        .map((reference) => ({
          id: `reference:${reference.id}`,
          from: `scripted_effect:${reference.sourceId}`,
          to: `reference:${reference.id}`,
          evidence: { kind: 'technology_reference', reference },
        })),
    ].sort((left, right) => compareCodeUnits(left.id, right.id)),
    roots: graph.helperCalls
      .filter(({ sourceKind }) => sourceKind !== 'scripted_effect')
      .map(({ id }) => id)
      .sort(compareCodeUnits),
    branches: [
      ...new Set(graph.helperCalls.map(({ helperId }) => `scripted_effect:${helperId}`)),
    ].sort(compareCodeUnits),
  };
}
