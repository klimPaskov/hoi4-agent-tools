import type { FocusLayoutNode } from './model.js';

// Shared visual contract for the renderer and constraint solver. Coordinates
// remain ordinary HOI4 focus-grid units; the pixel conversion proves whether
// two rendered node rectangles intersect.
export const FOCUS_HORIZONTAL_GRID_PIXELS = 176;
export const FOCUS_VERTICAL_GRID_PIXELS = 116;
export const FOCUS_NODE_WIDTH_PIXELS = 144;
export const FOCUS_NODE_HEIGHT_PIXELS = 76;

export function focusNodesVisiblyOverlap(
  left: Pick<FocusLayoutNode, 'x' | 'y'>,
  right: Pick<FocusLayoutNode, 'x' | 'y'>,
): boolean {
  return (
    Math.abs(left.x - right.x) * FOCUS_HORIZONTAL_GRID_PIXELS < FOCUS_NODE_WIDTH_PIXELS &&
    Math.abs(left.y - right.y) * FOCUS_VERTICAL_GRID_PIXELS < FOCUS_NODE_HEIGHT_PIXELS
  );
}

function orientation(
  first: Pick<FocusLayoutNode, 'x' | 'y'>,
  second: Pick<FocusLayoutNode, 'x' | 'y'>,
  third: Pick<FocusLayoutNode, 'x' | 'y'>,
): number {
  return Math.sign(
    (second.y - first.y) * (third.x - second.x) - (second.x - first.x) * (third.y - second.y),
  );
}

/**
 * Returns true only for a proper interior intersection. Connector pairs that
 * merely touch, overlap collinearly, or share a focus endpoint are handled by
 * their callers and do not count as a crossing.
 */
export function focusConnectorSegmentsProperlyCross(
  firstStart: Pick<FocusLayoutNode, 'x' | 'y'>,
  firstEnd: Pick<FocusLayoutNode, 'x' | 'y'>,
  secondStart: Pick<FocusLayoutNode, 'x' | 'y'>,
  secondEnd: Pick<FocusLayoutNode, 'x' | 'y'>,
): boolean {
  const values = [
    orientation(firstStart, firstEnd, secondStart),
    orientation(firstStart, firstEnd, secondEnd),
    orientation(secondStart, secondEnd, firstStart),
    orientation(secondStart, secondEnd, firstEnd),
  ];
  return values.every((value) => value !== 0) && values[0] !== values[1] && values[2] !== values[3];
}

export function focusNodeOrigin(
  node: Pick<FocusLayoutNode, 'x' | 'y'>,
  minimumX: number,
  minimumY: number,
  padding: number,
  horizontalSpacing = FOCUS_HORIZONTAL_GRID_PIXELS,
  verticalSpacing = FOCUS_VERTICAL_GRID_PIXELS,
): { x: number; y: number } {
  return {
    x: padding + (node.x - minimumX) * horizontalSpacing,
    y: padding + (node.y - minimumY) * verticalSpacing,
  };
}
