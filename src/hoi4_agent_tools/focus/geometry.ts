import type { FocusLayoutNode } from './model.js';

// Shared visual contract for the renderer and constraint solver. Coordinates
// remain ordinary HOI4 focus-grid units; connector geometry is converted to
// the same deterministic pixel-space cubic used in SVG review artifacts.
export const FOCUS_HORIZONTAL_GRID_PIXELS = 176;
export const FOCUS_VERTICAL_GRID_PIXELS = 116;
export const FOCUS_NODE_WIDTH_PIXELS = 144;
export const FOCUS_NODE_HEIGHT_PIXELS = 76;
export const FOCUS_CONNECTOR_FLATTEN_SEGMENTS = 24;

const GEOMETRY_EPSILON = 1e-7;

export interface FocusPoint {
  x: number;
  y: number;
}

export interface FocusRectangle {
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
}

export interface FocusConnectorCurve {
  start: FocusPoint;
  firstControl: FocusPoint;
  secondControl: FocusPoint;
  end: FocusPoint;
}

export interface FocusGeometryOptions {
  horizontalSpacing?: number;
  verticalSpacing?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  originX?: number;
  originY?: number;
}

interface ResolvedFocusGeometry {
  horizontalSpacing: number;
  verticalSpacing: number;
  nodeWidth: number;
  nodeHeight: number;
  originX: number;
  originY: number;
}

function resolvedGeometry(options: FocusGeometryOptions): ResolvedFocusGeometry {
  return {
    horizontalSpacing: options.horizontalSpacing ?? FOCUS_HORIZONTAL_GRID_PIXELS,
    verticalSpacing: options.verticalSpacing ?? FOCUS_VERTICAL_GRID_PIXELS,
    nodeWidth: options.nodeWidth ?? FOCUS_NODE_WIDTH_PIXELS,
    nodeHeight: options.nodeHeight ?? FOCUS_NODE_HEIGHT_PIXELS,
    originX: options.originX ?? 0,
    originY: options.originY ?? 0,
  };
}

export function focusNodesVisiblyOverlap(
  left: Pick<FocusLayoutNode, 'x' | 'y'>,
  right: Pick<FocusLayoutNode, 'x' | 'y'>,
): boolean {
  return (
    Math.abs(left.x - right.x) * FOCUS_HORIZONTAL_GRID_PIXELS < FOCUS_NODE_WIDTH_PIXELS &&
    Math.abs(left.y - right.y) * FOCUS_VERTICAL_GRID_PIXELS < FOCUS_NODE_HEIGHT_PIXELS
  );
}

export function focusNodeRectangle(
  node: Pick<FocusLayoutNode, 'x' | 'y'>,
  options: FocusGeometryOptions = {},
): FocusRectangle {
  const geometry = resolvedGeometry(options);
  const minimumX = geometry.originX + node.x * geometry.horizontalSpacing;
  const minimumY = geometry.originY + node.y * geometry.verticalSpacing;
  return {
    minimumX,
    minimumY,
    maximumX: minimumX + geometry.nodeWidth,
    maximumY: minimumY + geometry.nodeHeight,
  };
}

/** The exact cubic rendered for a prerequisite connector. */
export function focusConnectorCurve(
  parent: Pick<FocusLayoutNode, 'x' | 'y'>,
  child: Pick<FocusLayoutNode, 'x' | 'y'>,
  options: FocusGeometryOptions = {},
): FocusConnectorCurve {
  const geometry = resolvedGeometry(options);
  const parentRectangle = focusNodeRectangle(parent, geometry);
  const childRectangle = focusNodeRectangle(child, geometry);
  const start = {
    x: (parentRectangle.minimumX + parentRectangle.maximumX) / 2,
    y: parentRectangle.maximumY,
  };
  const end = {
    x: (childRectangle.minimumX + childRectangle.maximumX) / 2,
    y: childRectangle.minimumY,
  };
  const middleY = (start.y + end.y) / 2;
  return {
    start,
    firstControl: { x: start.x, y: middleY },
    secondControl: { x: end.x, y: middleY },
    end,
  };
}

/** Serialize the shared connector primitive without introducing renderer-only rounding. */
export function focusConnectorSvgPath(curve: FocusConnectorCurve): string {
  return `M ${curve.start.x} ${curve.start.y} C ${curve.firstControl.x} ${curve.firstControl.y}, ${curve.secondControl.x} ${curve.secondControl.y}, ${curve.end.x} ${curve.end.y}`;
}

function cubicCoordinate(
  start: number,
  firstControl: number,
  secondControl: number,
  end: number,
  progress: number,
): number {
  const remaining = 1 - progress;
  return (
    remaining * remaining * remaining * start +
    3 * remaining * remaining * progress * firstControl +
    3 * remaining * progress * progress * secondControl +
    progress * progress * progress * end
  );
}

/** Fixed-size flattening keeps intersection work deterministic and bounded. */
export function flattenFocusConnectorCurve(curve: FocusConnectorCurve): readonly FocusPoint[] {
  return Array.from({ length: FOCUS_CONNECTOR_FLATTEN_SEGMENTS + 1 }, (_unused, index) => {
    const progress = index / FOCUS_CONNECTOR_FLATTEN_SEGMENTS;
    return {
      x: cubicCoordinate(
        curve.start.x,
        curve.firstControl.x,
        curve.secondControl.x,
        curve.end.x,
        progress,
      ),
      y: cubicCoordinate(
        curve.start.y,
        curve.firstControl.y,
        curve.secondControl.y,
        curve.end.y,
        progress,
      ),
    };
  });
}

function pointBounds(points: readonly FocusPoint[]): FocusRectangle {
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  for (const point of points) {
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumX = Math.max(maximumX, point.x);
    maximumY = Math.max(maximumY, point.y);
  }
  return { minimumX, minimumY, maximumX, maximumY };
}

function rectanglesOverlap(left: FocusRectangle, right: FocusRectangle): boolean {
  return !(
    left.maximumX < right.minimumX - GEOMETRY_EPSILON ||
    right.maximumX < left.minimumX - GEOMETRY_EPSILON ||
    left.maximumY < right.minimumY - GEOMETRY_EPSILON ||
    right.maximumY < left.minimumY - GEOMETRY_EPSILON
  );
}

function orientation(first: FocusPoint, second: FocusPoint, third: FocusPoint): number {
  const crossProduct =
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  return Math.abs(crossProduct) <= GEOMETRY_EPSILON ? 0 : Math.sign(crossProduct);
}

function pointOnSegment(point: FocusPoint, start: FocusPoint, end: FocusPoint): boolean {
  return (
    orientation(start, end, point) === 0 &&
    point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON
  );
}

function segmentsIntersect(
  firstStart: FocusPoint,
  firstEnd: FocusPoint,
  secondStart: FocusPoint,
  secondEnd: FocusPoint,
): boolean {
  if (
    !rectanglesOverlap(
      {
        minimumX: Math.min(firstStart.x, firstEnd.x),
        minimumY: Math.min(firstStart.y, firstEnd.y),
        maximumX: Math.max(firstStart.x, firstEnd.x),
        maximumY: Math.max(firstStart.y, firstEnd.y),
      },
      {
        minimumX: Math.min(secondStart.x, secondEnd.x),
        minimumY: Math.min(secondStart.y, secondEnd.y),
        maximumX: Math.max(secondStart.x, secondEnd.x),
        maximumY: Math.max(secondStart.y, secondEnd.y),
      },
    )
  )
    return false;
  const firstStartOrientation = orientation(firstStart, firstEnd, secondStart);
  const firstEndOrientation = orientation(firstStart, firstEnd, secondEnd);
  const secondStartOrientation = orientation(secondStart, secondEnd, firstStart);
  const secondEndOrientation = orientation(secondStart, secondEnd, firstEnd);
  if (
    firstStartOrientation * firstEndOrientation < 0 &&
    secondStartOrientation * secondEndOrientation < 0
  )
    return true;
  return (
    (firstStartOrientation === 0 && pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (firstEndOrientation === 0 && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (secondStartOrientation === 0 && pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (secondEndOrientation === 0 && pointOnSegment(firstEnd, secondStart, secondEnd))
  );
}

interface FocusPolylineSegment {
  start: FocusPoint;
  end: FocusPoint;
  minimumY: number;
  maximumY: number;
}

function polylineSegments(points: readonly FocusPoint[]): FocusPolylineSegment[] {
  const segments: FocusPolylineSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    segments.push({
      start,
      end,
      minimumY: Math.min(start.y, end.y),
      maximumY: Math.max(start.y, end.y),
    });
  }
  return segments.sort(
    (left, right) =>
      left.minimumY - right.minimumY ||
      left.maximumY - right.maximumY ||
      left.start.x - right.start.x ||
      left.end.x - right.end.x,
  );
}

export function focusConnectorPolylinesIntersect(
  firstPoints: readonly FocusPoint[],
  secondPoints: readonly FocusPoint[],
): boolean {
  if (!rectanglesOverlap(pointBounds(firstPoints), pointBounds(secondPoints))) return false;
  const firstSegments = polylineSegments(firstPoints);
  const secondSegments = polylineSegments(secondPoints);
  let secondStartIndex = 0;
  for (const first of firstSegments) {
    while (
      secondStartIndex < secondSegments.length &&
      (secondSegments[secondStartIndex]?.maximumY ?? Infinity) < first.minimumY - GEOMETRY_EPSILON
    )
      secondStartIndex += 1;
    for (
      let secondIndex = secondStartIndex;
      secondIndex < secondSegments.length;
      secondIndex += 1
    ) {
      const second = secondSegments[secondIndex];
      if (second === undefined) continue;
      if (second.minimumY > first.maximumY + GEOMETRY_EPSILON) break;
      if (segmentsIntersect(first.start, first.end, second.start, second.end)) return true;
    }
  }
  return false;
}

export function focusConnectorCurvesIntersect(
  first: FocusConnectorCurve,
  second: FocusConnectorCurve,
): boolean {
  return focusConnectorPolylinesIntersect(
    flattenFocusConnectorCurve(first),
    flattenFocusConnectorCurve(second),
  );
}

export function focusConnectorsVisiblyIntersect(
  firstParent: Pick<FocusLayoutNode, 'x' | 'y'>,
  firstChild: Pick<FocusLayoutNode, 'x' | 'y'>,
  secondParent: Pick<FocusLayoutNode, 'x' | 'y'>,
  secondChild: Pick<FocusLayoutNode, 'x' | 'y'>,
  options: FocusGeometryOptions = {},
): boolean {
  return focusConnectorCurvesIntersect(
    focusConnectorCurve(firstParent, firstChild, options),
    focusConnectorCurve(secondParent, secondChild, options),
  );
}

function pointInsideRectangle(point: FocusPoint, rectangle: FocusRectangle): boolean {
  return (
    point.x >= rectangle.minimumX - GEOMETRY_EPSILON &&
    point.x <= rectangle.maximumX + GEOMETRY_EPSILON &&
    point.y >= rectangle.minimumY - GEOMETRY_EPSILON &&
    point.y <= rectangle.maximumY + GEOMETRY_EPSILON
  );
}

export function focusConnectorPolylineIntersectsRectangle(
  points: readonly FocusPoint[],
  rectangle: FocusRectangle,
): boolean {
  if (!rectanglesOverlap(pointBounds(points), rectangle)) return false;
  const topLeft = { x: rectangle.minimumX, y: rectangle.minimumY };
  const topRight = { x: rectangle.maximumX, y: rectangle.minimumY };
  const bottomRight = { x: rectangle.maximumX, y: rectangle.maximumY };
  const bottomLeft = { x: rectangle.minimumX, y: rectangle.maximumY };
  const sides = [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ] as const;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    if (pointInsideRectangle(start, rectangle) || pointInsideRectangle(end, rectangle)) return true;
    if (sides.some(([sideStart, sideEnd]) => segmentsIntersect(start, end, sideStart, sideEnd)))
      return true;
  }
  return false;
}

export function focusConnectorCurveIntersectsRectangle(
  curve: FocusConnectorCurve,
  rectangle: FocusRectangle,
): boolean {
  return focusConnectorPolylineIntersectsRectangle(flattenFocusConnectorCurve(curve), rectangle);
}

export function focusConnectorIntersectsNode(
  parent: Pick<FocusLayoutNode, 'x' | 'y'>,
  child: Pick<FocusLayoutNode, 'x' | 'y'>,
  node: Pick<FocusLayoutNode, 'x' | 'y'>,
  options: FocusGeometryOptions = {},
): boolean {
  return focusConnectorCurveIntersectsRectangle(
    focusConnectorCurve(parent, child, options),
    focusNodeRectangle(node, options),
  );
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
