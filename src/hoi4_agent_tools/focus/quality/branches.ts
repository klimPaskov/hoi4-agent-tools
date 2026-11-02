import { compareCodeUnits } from '../../core/canonical.js';
import type { QualityGraph } from './types.js';

export interface BranchSummary {
  /** Declared branch id, or the first focus of a derived branch. Empty: trunk and shared focuses. */
  id: string;
  declared: boolean;
  focusCount: number;
  focusIds: string[];
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
  centroidX: number;
  centroidY: number;
}

/** Groups focuses by their declared or derived branch; trunk and shared focuses form no branch. */
export function summarizeBranches(graph: QualityGraph): BranchSummary[] {
  const groups = new Map<string, string[]>();
  for (const { id } of graph.nodes) {
    const branch = graph.branchOf.get(id) ?? '';
    if (branch === '') continue;
    const members = groups.get(branch) ?? [];
    members.push(id);
    groups.set(branch, members);
  }
  return [...groups]
    .map(([branchId, focusIds]) => {
      const points = focusIds.map((focusId) => graph.position.get(focusId)!);
      const xs = points.map(({ x }) => x);
      const ys = points.map(({ y }) => y);
      return {
        id: branchId,
        declared: graph.branchesDeclared,
        focusCount: focusIds.length,
        focusIds,
        minimumX: Math.min(...xs),
        maximumX: Math.max(...xs),
        minimumY: Math.min(...ys),
        maximumY: Math.max(...ys),
        centroidX: xs.reduce((total, x) => total + x, 0) / xs.length,
        centroidY: ys.reduce((total, y) => total + y, 0) / ys.length,
      };
    })
    .sort((a, b) => a.minimumX - b.minimumX || compareCodeUnits(a.id, b.id));
}
