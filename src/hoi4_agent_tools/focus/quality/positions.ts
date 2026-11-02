import type { FocusTreePlan } from '../model.js';
import type { QualityNode } from './types.js';

/**
 * Resolves the grid coordinates of a plan whose focuses all carry a fixed or relative position,
 * the way the game reads them: a relative offset is added to the anchor's own resolved position.
 * Returns `undefined` when a focus is placed by the solver or an anchor is missing or circular, so
 * the caller falls back to the layout engine.
 */
export function resolveStaticPositions(
  plan: Pick<FocusTreePlan, 'focuses'>,
): QualityNode[] | undefined {
  const byId = new Map(plan.focuses.map((focus) => [focus.id, focus]));
  const resolved = new Map<string, QualityNode>();
  const resolving = new Set<string>();
  const resolve = (id: string): QualityNode | undefined => {
    const known = resolved.get(id);
    if (known !== undefined) return known;
    const focus = byId.get(id);
    if (focus === undefined || resolving.has(id)) return undefined;
    resolving.add(id);
    let node: QualityNode | undefined;
    if (focus.position.mode === 'fixed') {
      node = { id, x: focus.position.x, y: focus.position.y };
    } else if (focus.position.mode === 'relative') {
      const anchor = resolve(focus.position.relativeTo);
      if (anchor !== undefined)
        node = { id, x: anchor.x + focus.position.x, y: anchor.y + focus.position.y };
    }
    resolving.delete(id);
    if (node !== undefined) resolved.set(id, node);
    return node;
  };
  const nodes: QualityNode[] = [];
  for (const focus of plan.focuses) {
    const node = resolve(focus.id);
    if (node === undefined) return undefined;
    nodes.push(node);
  }
  return nodes;
}
