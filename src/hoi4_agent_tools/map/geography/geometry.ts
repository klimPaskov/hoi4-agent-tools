/**
 * Planar geometry for the geography model, in normalised frame coordinates. Only `+ - * /` and
 * `sqrt` are used so results are identical on every platform.
 */

export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Distance under which a point counts as lying on a boundary. */
export const BOUNDARY_EPSILON = 1e-9;

export function boundsOf(xs: ArrayLike<number>, ys: ArrayLike<number>): Bounds {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let index = 0; index < xs.length; index++) {
    const x = xs[index]!,
      y = ys[index]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function unionBounds(items: readonly Bounds[]): Bounds {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const item of items) {
    if (item.x0 < x0) x0 = item.x0;
    if (item.y0 < y0) y0 = item.y0;
    if (item.x1 > x1) x1 = item.x1;
    if (item.y1 > y1) y1 = item.y1;
  }
  return { x0, y0, x1, y1 };
}

export function boundsContain(bounds: Bounds, x: number, y: number): boolean {
  return (
    x >= bounds.x0 - BOUNDARY_EPSILON &&
    x <= bounds.x1 + BOUNDARY_EPSILON &&
    y >= bounds.y0 - BOUNDARY_EPSILON &&
    y <= bounds.y1 + BOUNDARY_EPSILON
  );
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** Shoelace area in frame units; positive for a counter-clockwise ring with y pointing up. */
export function signedArea(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  let sum = 0;
  const n = xs.length;
  for (let index = 0, previous = n - 1; index < n; previous = index++)
    sum += xs[previous]! * ys[index]! - xs[index]! * ys[previous]!;
  return sum / 2;
}

function orientation(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const value = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function onSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): boolean {
  return (
    px >= Math.min(ax, bx) &&
    px <= Math.max(ax, bx) &&
    py >= Math.min(ay, by) &&
    py <= Math.max(ay, by)
  );
}

/** Closed segments `ab` and `cd` share at least one point (touching and overlapping count). */
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orientation(ax, ay, bx, by, cx, cy);
  const o2 = orientation(ax, ay, bx, by, dx, dy);
  const o3 = orientation(cx, cy, dx, dy, ax, ay);
  const o4 = orientation(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

/** Distance from a point to the closed segment `ab`, and the position along it (0 to 1). */
export function pointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; t: number } {
  const dx = bx - ax,
    dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx - px,
    qy = ay + t * dy - py;
  return { distance: Math.sqrt(qx * qx + qy * qy), t };
}

/** Even-odd containment; a point within `BOUNDARY_EPSILON` of the ring counts as inside. */
export function ringContains(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  px: number,
  py: number,
): boolean {
  let inside = false;
  const n = xs.length;
  for (let index = 0, previous = n - 1; index < n; previous = index++) {
    const ax = xs[previous]!,
      ay = ys[previous]!,
      bx = xs[index]!,
      by = ys[index]!;
    if (pointSegment(px, py, ax, ay, bx, by).distance <= BOUNDARY_EPSILON) return true;
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** Uniform grid over segments, so intersection tests stay near-linear on long rings. */
export class SegmentGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly size: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;

  constructor(
    private readonly xs: ArrayLike<number>,
    private readonly ys: ArrayLike<number>,
    private readonly closed: boolean,
    bounds: Bounds,
  ) {
    const segments = closed ? xs.length : xs.length - 1;
    this.size = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(segments))));
    this.minX = bounds.x0;
    this.minY = bounds.y0;
    this.cellWidth = Math.max((bounds.x1 - bounds.x0) / this.size, 1e-12);
    this.cellHeight = Math.max((bounds.y1 - bounds.y0) / this.size, 1e-12);
    for (let segment = 0; segment < segments; segment++) {
      const [ax, ay, bx, by] = this.endpoints(segment);
      const [cx0, cx1] = this.span(Math.min(ax, bx), Math.max(ax, bx), this.minX, this.cellWidth);
      const [cy0, cy1] = this.span(Math.min(ay, by), Math.max(ay, by), this.minY, this.cellHeight);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cy * this.size + cx;
          const list = this.cells.get(key);
          if (list === undefined) this.cells.set(key, [segment]);
          else list.push(segment);
        }
    }
  }

  get segmentCount(): number {
    return this.closed ? this.xs.length : this.xs.length - 1;
  }

  endpoints(segment: number): [number, number, number, number] {
    const next = (segment + 1) % this.xs.length;
    return [this.xs[segment]!, this.ys[segment]!, this.xs[next]!, this.ys[next]!];
  }

  private span(low: number, high: number, origin: number, cell: number): [number, number] {
    const clamp = (value: number) => Math.max(0, Math.min(this.size - 1, value));
    return [clamp(Math.floor((low - origin) / cell)), clamp(Math.floor((high - origin) / cell))];
  }

  /** Visit candidate segments that share a grid cell with the box; stop when `visit` returns true. */
  candidates(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (segment: number) => boolean,
  ): boolean {
    const [cx0, cx1] = this.span(x0, x1, this.minX, this.cellWidth);
    const [cy0, cy1] = this.span(y0, y1, this.minY, this.cellHeight);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(cy * this.size + cx);
        if (list === undefined) continue;
        for (const segment of list) if (visit(segment)) return true;
      }
    return false;
  }
}

/**
 * First pair of segments that cross, touch or overlap, ignoring neighbours that only share their
 * common vertex. A spike (a segment that doubles back on its neighbour) counts as an overlap.
 */
export function findSelfIntersection(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  closed: boolean,
): readonly [number, number] | undefined {
  const n = xs.length;
  const segments = closed ? n : n - 1;
  if (segments < 2) return undefined;
  const grid = new SegmentGrid(xs, ys, closed, boundsOf(xs, ys));
  for (let i = 0; i < segments; i++) {
    const [ax, ay, bx, by] = grid.endpoints(i);
    let found: readonly [number, number] | undefined;
    grid.candidates(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (j) => {
      if (j <= i) return false;
      const adjacent = j === i + 1 || (closed && i === 0 && j === segments - 1);
      const [cx, cy, dx, dy] = grid.endpoints(j);
      if (adjacent) {
        // Neighbours legitimately meet at one vertex; they overlap when they double back.
        const shared = j === i + 1 ? [bx, by, ax, ay, dx, dy] : [ax, ay, bx, by, cx, cy];
        const [sx, sy, ux, uy, vx, vy] = shared as [number, number, number, number, number, number];
        const cross = (ux - sx) * (vy - sy) - (uy - sy) * (vx - sx);
        const dot = (ux - sx) * (vx - sx) + (uy - sy) * (vy - sy);
        if (cross === 0 && dot > 0) {
          found = [i, j];
          return true;
        }
        return false;
      }
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
        found = [i, j];
        return true;
      }
      return false;
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

/** True when any segment of ring `a` meets any segment of ring `b`. */
export function ringsIntersect(
  axs: ArrayLike<number>,
  ays: ArrayLike<number>,
  bxs: ArrayLike<number>,
  bys: ArrayLike<number>,
): boolean {
  const boundsA = boundsOf(axs, ays),
    boundsB = boundsOf(bxs, bys);
  if (!boundsOverlap(boundsA, boundsB)) return false;
  const grid = new SegmentGrid(axs, ays, true, boundsA);
  const n = bxs.length;
  for (let index = 0; index < n; index++) {
    const next = (index + 1) % n;
    const cx = bxs[index]!,
      cy = bys[index]!,
      dx = bxs[next]!,
      dy = bys[next]!;
    const hit = grid.candidates(
      Math.min(cx, dx),
      Math.min(cy, dy),
      Math.max(cx, dx),
      Math.max(cy, dy),
      (segment) => {
        const [ax, ay, bx, by] = grid.endpoints(segment);
        return segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy);
      },
    );
    if (hit) return true;
  }
  return false;
}

/** Area centroid of a simple ring (the vertex mean for a zero-area ring). */
export function ringCentroid(xs: ArrayLike<number>, ys: ArrayLike<number>): [number, number] {
  const area = signedArea(xs, ys);
  const n = xs.length;
  if (Math.abs(area) < 1e-15) {
    let sx = 0,
      sy = 0;
    for (let index = 0; index < n; index++) {
      sx += xs[index]!;
      sy += ys[index]!;
    }
    return [sx / n, sy / n];
  }
  let cx = 0,
    cy = 0;
  for (let index = 0, previous = n - 1; index < n; previous = index++) {
    const cross = xs[previous]! * ys[index]! - xs[index]! * ys[previous]!;
    cx += (xs[previous]! + xs[index]!) * cross;
    cy += (ys[previous]! + ys[index]!) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/**
 * The midpoint of the longest horizontal span of the shape through its centroid height, which
 * lies inside the shape even when the shape is concave. Deterministic and cheap.
 */
export function interiorPoint(
  rings: ReadonlyArray<{ xs: ArrayLike<number>; ys: ArrayLike<number> }>,
  centroidY: number,
  bounds: Bounds,
): [number, number] {
  const candidates = [
    centroidY,
    ...[0.5, 0.25, 0.75, 0.375, 0.625].map((f) => bounds.y0 + (bounds.y1 - bounds.y0) * f),
  ];
  let best: [number, number] | undefined;
  let bestLength = -1;
  for (const y of candidates) {
    const crossings: number[] = [];
    for (const ring of rings) {
      const n = ring.xs.length;
      for (let index = 0, previous = n - 1; index < n; previous = index++) {
        const ay = ring.ys[previous]!,
          by = ring.ys[index]!;
        if (ay > y !== by > y) {
          const ax = ring.xs[previous]!,
            bx = ring.xs[index]!;
          crossings.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
        }
      }
    }
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const length = crossings[index + 1]! - crossings[index]!;
      if (length > bestLength) {
        bestLength = length;
        best = [(crossings[index]! + crossings[index + 1]!) / 2, y];
      }
    }
    if (best !== undefined && y === centroidY && bestLength > 0) break;
  }
  return best ?? [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2];
}
