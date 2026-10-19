import { pointSegment } from './geometry.js';
import type { GeoPoint, ResolvedArea, ResolvedPolyline } from './model.js';

/**
 * Rasterisation of the resolved geography on the map grid, in horizontal strips so a 13-million
 * pixel map never needs a full-size scratch buffer. Pixel `(i, j)` covers
 * `[i / width, (i + 1) / width) x [j / height, (j + 1) / height)` of the frame and is sampled at
 * its centre. All helpers use `+ - * /` and `sqrt` only, so results are identical on every
 * platform.
 */

export interface RasterGrid {
  readonly width: number;
  readonly height: number;
}

/** Rows `[y0, y1)` of the grid. */
export interface RowStrip {
  readonly y0: number;
  readonly y1: number;
}

export function stripRows(strip: RowStrip): number {
  return strip.y1 - strip.y0;
}

/** Split the grid into strips of at most `rows` rows, top to bottom. */
export function rowStrips(grid: RasterGrid, rows = 64): RowStrip[] {
  const strips: RowStrip[] = [];
  for (let y0 = 0; y0 < grid.height; y0 += rows)
    strips.push({ y0, y1: Math.min(grid.height, y0 + rows) });
  return strips;
}

/** The pixel containing a frame point, clamped to the grid. */
export function pointToPixel(grid: RasterGrid, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(grid.width - 1, Math.floor(x * grid.width))),
    y: Math.max(0, Math.min(grid.height - 1, Math.floor(y * grid.height))),
  };
}

/** Area covered by a shape in pixels (analytic, not counted). */
export function areaPixels(area: ResolvedArea, grid: RasterGrid): number {
  return area.areaFraction * grid.width * grid.height;
}

/**
 * Visit the horizontal spans `[x0, x1)` of row `y` covered by the area, for every row of the
 * strip. Even-odd filling over all outer rings and holes; spans of one row are ordered and do not
 * overlap.
 */
export function scanAreaStrip(
  area: ResolvedArea,
  grid: RasterGrid,
  strip: RowStrip,
  visit: (y: number, x0: number, x1: number) => void,
): void {
  const rows = stripRows(strip);
  if (rows <= 0) return;
  const lo = Math.max(strip.y0, Math.ceil(area.bounds.y0 * grid.height - 0.5));
  const hi = Math.min(strip.y1, Math.ceil(area.bounds.y1 * grid.height - 0.5) + 1);
  if (hi <= lo) return;
  const crossings: number[][] = Array.from({ length: hi - lo }, () => []);
  for (const ring of [...area.outers, ...area.holes]) {
    const n = ring.xs.length;
    for (let index = 0, previous = n - 1; index < n; previous = index++) {
      const ay = ring.ys[previous]!,
        by = ring.ys[index]!;
      if (ay === by) continue;
      const ymin = Math.min(ay, by),
        ymax = Math.max(ay, by);
      const first = Math.max(lo, Math.ceil(ymin * grid.height - 0.5));
      const last = Math.min(hi, Math.ceil(ymax * grid.height - 0.5));
      if (last <= first) continue;
      const ax = ring.xs[previous]!,
        bx = ring.xs[index]!;
      for (let row = first; row < last; row++) {
        const yc = (row + 0.5) / grid.height;
        crossings[row - lo]!.push((ax + ((yc - ay) * (bx - ax)) / (by - ay)) * grid.width);
      }
    }
  }
  for (let offset = 0; offset < crossings.length; offset++) {
    const list = crossings[offset]!;
    if (list.length < 2) continue;
    list.sort((a, b) => a - b);
    for (let index = 0; index + 1 < list.length; index += 2) {
      const x0 = Math.max(0, Math.ceil(list[index]! - 0.5));
      const x1 = Math.min(grid.width, Math.ceil(list[index + 1]! - 0.5));
      if (x1 > x0) visit(lo + offset, x0, x1);
    }
  }
}

/** Write `value` into a strip-sized buffer (`width * rows` cells) for every pixel the area covers. */
export function fillAreaStrip(
  area: ResolvedArea,
  grid: RasterGrid,
  strip: RowStrip,
  target: { fill(value: number, start?: number, end?: number): unknown },
  value: number,
): void {
  scanAreaStrip(area, grid, strip, (y, x0, x1) => {
    const base = (y - strip.y0) * grid.width;
    target.fill(value, base + x0, base + x1);
  });
}

/** Number of pixels of the area inside a strip; summed over strips this is the exact pixel area. */
export function countAreaStrip(area: ResolvedArea, grid: RasterGrid, strip: RowStrip): number {
  let count = 0;
  scanAreaStrip(area, grid, strip, (_y, x0, x1) => {
    count += x1 - x0;
  });
  return count;
}

export interface PolylineSample {
  readonly x: number;
  readonly y: number;
  /** Unit tangent in pixel space (x east, y south). */
  readonly tangentX: number;
  readonly tangentY: number;
  readonly halfWidth: number;
  readonly peak: number;
}

/** Number of segments in a path, counting the closing edge of a closed path. */
export function segmentCount(line: ResolvedPolyline): number {
  return line.closed ? line.xs.length : line.xs.length - 1;
}

/** The point at arc fraction `t` (0..1) with interpolated half-width and crest height. */
export function sampleAlong(line: ResolvedPolyline, frame: RasterGrid, t: number): PolylineSample {
  const clamped = Math.max(0, Math.min(1, t));
  const target = clamped * line.length;
  const segments = segmentCount(line);
  let low = 0,
    high = segments - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (line.arc[middle + 1]! < target) low = middle + 1;
    else high = middle;
  }
  const next = (low + 1) % line.xs.length;
  const start = line.arc[low]!,
    end = line.arc[low + 1]!;
  const local = end > start ? Math.max(0, Math.min(1, (target - start) / (end - start))) : 0;
  const dx = (line.xs[next]! - line.xs[low]!) * frame.width;
  const dy = (line.ys[next]! - line.ys[low]!) * frame.height;
  const length = Math.sqrt(dx * dx + dy * dy);
  return {
    x: line.xs[low]! + (line.xs[next]! - line.xs[low]!) * local,
    y: line.ys[low]! + (line.ys[next]! - line.ys[low]!) * local,
    tangentX: length === 0 ? 1 : dx / length,
    tangentY: length === 0 ? 0 : dy / length,
    halfWidth: line.halfWidth[low]! + (line.halfWidth[next]! - line.halfWidth[low]!) * local,
    peak: line.peak[low]! + (line.peak[next]! - line.peak[low]!) * local,
  };
}

export interface PolylineProjection {
  /** The nearest point on the path, in frame coordinates. */
  readonly x: number;
  readonly y: number;
  /** Arc fraction (0..1) of that point. */
  readonly at: number;
  /** Distance to it in map-width units. */
  readonly distance: number;
  /** Index of the segment holding it. */
  readonly segment: number;
  /** Interpolated half-width there, a fraction of the map width. */
  readonly halfWidth: number;
}

/**
 * The point of a path nearest to a frame point, measured in map-width units so a unit step east and
 * a unit step south are the same distance. The first of equally near segments wins.
 */
export function nearestOnPolyline(
  line: ResolvedPolyline,
  frame: RasterGrid,
  x: number,
  y: number,
): PolylineProjection {
  const aspect = frame.height / frame.width;
  const segments = segmentCount(line);
  let best = { distance: Infinity, t: 0, segment: 0 };
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % line.xs.length;
    const found = pointSegment(
      x,
      y * aspect,
      line.xs[segment]!,
      line.ys[segment]! * aspect,
      line.xs[next]!,
      line.ys[next]! * aspect,
    );
    if (found.distance < best.distance) best = { ...found, segment };
  }
  const next = (best.segment + 1) % line.xs.length;
  const start = line.arc[best.segment]!,
    end = line.arc[best.segment + 1]!;
  return {
    x: line.xs[best.segment]! + (line.xs[next]! - line.xs[best.segment]!) * best.t,
    y: line.ys[best.segment]! + (line.ys[next]! - line.ys[best.segment]!) * best.t,
    at: line.length === 0 ? 0 : (start + (end - start) * best.t) / line.length,
    distance: best.distance,
    segment: best.segment,
    halfWidth:
      line.halfWidth[best.segment]! +
      (line.halfWidth[next]! - line.halfWidth[best.segment]!) * best.t,
  };
}

/**
 * Visit every pixel a path touches, in path order, once per run (8-connected Bresenham between the
 * pixels of consecutive vertices). `t` is the arc fraction at the visited pixel.
 */
export function forEachPolylinePixel(
  line: ResolvedPolyline,
  grid: RasterGrid,
  strip: RowStrip,
  visit: (x: number, y: number, t: number) => void,
): void {
  const segments = segmentCount(line);
  let lastKey = -1;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % line.xs.length;
    const a = pointToPixel(grid, line.xs[segment]!, line.ys[segment]!);
    const b = pointToPixel(grid, line.xs[next]!, line.ys[next]!);
    const dx = Math.abs(b.x - a.x),
      dy = Math.abs(b.y - a.y);
    const steps = Math.max(dx, dy);
    const startArc = line.arc[segment]!,
      endArc = line.arc[segment + 1]!;
    for (let step = 0; step <= steps; step++) {
      const f = steps === 0 ? 0 : step / steps;
      // Rounding at .5 goes up, deterministically.
      const x = Math.floor(a.x + (b.x - a.x) * f + 0.5);
      const y = Math.floor(a.y + (b.y - a.y) * f + 0.5);
      const key = y * grid.width + x;
      if (key === lastKey) continue;
      lastKey = key;
      if (y < strip.y0 || y >= strip.y1) continue;
      visit(x, y, line.length === 0 ? 0 : (startArc + (endArc - startArc) * f) / line.length);
    }
  }
}

/** Nearest-segment distance field for one strip; the input to ridge and valley profiles. */
export interface BandStrip {
  readonly strip: RowStrip;
  readonly width: number;
  /** Distance in pixels to the nearest path point, `Infinity` outside the searched band. */
  readonly distance: Float32Array;
  /** Arc fraction (0..1) of the nearest path point. */
  readonly t: Float32Array;
  /** +1 on the right of travel as drawn on screen (x east, y south), -1 on the left, 0 on the path. */
  readonly side: Int8Array;
}

export function createBandStrip(grid: RasterGrid, strip: RowStrip): BandStrip {
  const cells = grid.width * stripRows(strip);
  return {
    strip,
    width: grid.width,
    distance: new Float32Array(cells).fill(Infinity),
    t: new Float32Array(cells),
    side: new Int8Array(cells),
  };
}

/** Reset a band so the buffer can be reused for the next path or strip. */
export function clearBandStrip(band: BandStrip): void {
  band.distance.fill(Infinity);
  band.t.fill(0);
  band.side.fill(0);
}

/**
 * For every pixel of the strip within `maxDistancePx` of the path, store the distance to the
 * nearest segment, the arc fraction there and the side. The first of equally near segments wins.
 */
export function rasterizeBandStrip(
  line: ResolvedPolyline,
  grid: RasterGrid,
  strip: RowStrip,
  maxDistancePx: number,
  band: BandStrip,
): void {
  const segments = segmentCount(line);
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % line.xs.length;
    const ax = line.xs[segment]! * grid.width,
      ay = line.ys[segment]! * grid.height,
      bx = line.xs[next]! * grid.width,
      by = line.ys[next]! * grid.height;
    const sx = bx - ax,
      sy = by - ay;
    const lengthSquared = sx * sx + sy * sy;
    const length = Math.sqrt(lengthSquared);
    const tx = length === 0 ? 1 : sx / length,
      ty = length === 0 ? 0 : sy / length;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - maxDistancePx - 1));
    const maxX = Math.min(grid.width - 1, Math.ceil(Math.max(ax, bx) + maxDistancePx));
    const minY = Math.max(strip.y0, Math.floor(Math.min(ay, by) - maxDistancePx - 1));
    const maxY = Math.min(strip.y1 - 1, Math.ceil(Math.max(ay, by) + maxDistancePx));
    const startArc = line.arc[segment]!,
      endArc = line.arc[segment + 1]!;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let along = lengthSquared === 0 ? 0 : ((px - ax) * sx + (py - ay) * sy) / lengthSquared;
        if (along < 0) along = 0;
        else if (along > 1) along = 1;
        const qx = ax + along * sx,
          qy = ay + along * sy;
        const ox = px - qx,
          oy = py - qy;
        const distance = Math.sqrt(ox * ox + oy * oy);
        if (distance > maxDistancePx) continue;
        const cell = (y - strip.y0) * grid.width + x;
        if (distance >= band.distance[cell]!) continue;
        band.distance[cell] = distance;
        band.t[cell] =
          line.length === 0 ? 0 : (startArc + (endArc - startArc) * along) / line.length;
        const cross = tx * oy - ty * ox;
        band.side[cell] = cross > 1e-9 ? 1 : cross < -1e-9 ? -1 : 0;
      }
    }
  }
}

/** Visit every pixel whose centre lies within `radiusFraction` (of the map width) of the point. */
export function forEachDiscPixel(
  center: GeoPoint,
  radiusFraction: number,
  grid: RasterGrid,
  strip: RowStrip,
  visit: (x: number, y: number, distancePx: number) => void,
): void {
  const cx = center.x * grid.width,
    cy = center.y * grid.height;
  const radius = radiusFraction * grid.width;
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(grid.width - 1, Math.ceil(cx + radius));
  const minY = Math.max(strip.y0, Math.floor(cy - radius - 1));
  const maxY = Math.min(strip.y1 - 1, Math.ceil(cy + radius));
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx,
        dy = y + 0.5 - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= radius) visit(x, y, distance);
    }
}

/** A coarse grid for validation and previews: at most `maxWidth` pixels wide, same aspect ratio. */
export function analysisGrid(frame: RasterGrid, maxWidth = 512): RasterGrid {
  const scale = Math.min(1, maxWidth / frame.width);
  return {
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
  };
}
