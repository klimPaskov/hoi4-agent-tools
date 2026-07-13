import { compareCodeUnits } from '../core/canonical.js';

interface TraversalFrame {
  nodeId: string;
  neighbours: string[];
  cursor: number;
}

/**
 * Deterministic, non-recursive Tarjan traversal.
 *
 * The caller owns the work policy: `spend` is invoked for every discovered
 * node, inspected edge, and component member popped from the Tarjan stack.
 */
export function iterativeStronglyConnectedComponents(
  nodeIds: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
  spend: () => void,
): string[][] {
  const orderedNodeIds = [...new Set(nodeIds)].sort(compareCodeUnits);
  const retained = new Set(orderedNodeIds);
  const neighboursFor = (nodeId: string): string[] =>
    [...new Set(outgoing.get(nodeId) ?? [])]
      .filter((candidate) => retained.has(candidate))
      .sort(compareCodeUnits);

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const tarjanStack: string[] = [];
  const onTarjanStack = new Set<string>();
  const components: string[][] = [];

  const enter = (nodeId: string, frames: TraversalFrame[]): void => {
    spend();
    indexes.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    tarjanStack.push(nodeId);
    onTarjanStack.add(nodeId);
    frames.push({ nodeId, neighbours: neighboursFor(nodeId), cursor: 0 });
  };

  for (const rootId of orderedNodeIds) {
    if (indexes.has(rootId)) continue;
    const frames: TraversalFrame[] = [];
    enter(rootId, frames);

    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const target = frame.neighbours[frame.cursor];
      if (target !== undefined) {
        frame.cursor += 1;
        spend();
        if (!indexes.has(target)) {
          enter(target, frames);
          continue;
        }
        if (onTarjanStack.has(target)) {
          lowLinks.set(frame.nodeId, Math.min(lowLinks.get(frame.nodeId)!, indexes.get(target)!));
        }
        continue;
      }

      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        lowLinks.set(
          parent.nodeId,
          Math.min(lowLinks.get(parent.nodeId)!, lowLinks.get(frame.nodeId)!),
        );
      }
      if (lowLinks.get(frame.nodeId) !== indexes.get(frame.nodeId)) continue;

      const component: string[] = [];
      for (;;) {
        spend();
        const member = tarjanStack.pop();
        if (member === undefined) break;
        onTarjanStack.delete(member);
        component.push(member);
        if (member === frame.nodeId) break;
      }
      component.sort(compareCodeUnits);
      components.push(component);
    }
  }

  return components;
}
