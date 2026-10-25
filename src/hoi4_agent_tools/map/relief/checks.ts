/**
 * Self-checks of the synthesised terrain (ADR 0056). They read only the finished rasters and the
 * resolved model, so they would also catch a regression in the generator. Findings are notes with
 * `MAP_RELIEF_*`, `MAP_RANGE_*`, `MAP_PASS_*`, `MAP_VOLCANO_*` and `MAP_RIVER_*` codes.
 */
import { sampleAlong, type ResolvedGeography } from '../geography/index.js';
import { LAND } from './grid.js';
import { CREST_WANDER_SHARE, type RangeTable } from './macro-relief.js';
import type { ReliefStatistics } from './fields.js';

export interface ReliefNote {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

interface HeightRaster {
  width: number;
  height: number;
  kind: Uint8Array;
  heights: Uint8Array;
}

/** Highest quantised height within `radius` pixels of a point; -1 when the point is not land. */
function maxAround(raster: HeightRaster, cx: number, cy: number, radius: number): number {
  const { width, height, kind, heights } = raster;
  const px = Math.min(width - 1, Math.max(0, Math.floor(cx)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(cy)));
  if (kind[py * width + px] !== LAND) return -1;
  let best = 0;
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy += 1) {
    const y = py + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -r; dx <= r; dx += 1) {
      const x = px + dx;
      if (x < 0 || x >= width || dx * dx + dy * dy > radius * radius) continue;
      const index = y * width + x;
      if (kind[index] !== LAND) continue;
      if (heights[index]! > best) best = heights[index]!;
    }
  }
  return best;
}

/** True where a pass saddle lies within `margin` of arc fraction `t`. */
function inPassWindow(table: RangeTable, t: number, margin: number): boolean {
  return table.passes.some(
    (pass) => Math.abs(t - pass.at) * table.length <= pass.halfLength * margin,
  );
}

/**
 * Crest, pass and volcano checks against the quantised heights. `MAP_PASS_NOT_LOWER` is an error:
 * a gate that is not a gap would block a route the model declares.
 */
export function checkRangesAndFeatures(
  geography: ResolvedGeography,
  tables: readonly RangeTable[],
  raster: HeightRaster,
  peakOf: (peak: number) => number,
  volcanoPeak: (peak: number) => number,
): ReliefNote[] {
  const notes: ReliefNote[] = [];
  const frame = { width: raster.width, height: raster.height };
  for (const range of geography.ranges) {
    const table = tables.find((candidate) => candidate.id === range.id);
    if (table === undefined) continue;
    const samples = Math.max(8, Math.min(64, Math.floor(table.count / 8)));
    let measured = 0;
    let low = 0;
    let worst = 1;
    let worstAt = 0;
    for (let k = 0; k < samples; k += 1) {
      const t = 0.04 + (0.92 * k) / (samples - 1);
      if (inPassWindow(table, t, 1.5)) continue;
      const sample = sampleAlong(range.path, geography.frame, t);
      const radius = Math.max(3, CREST_WANDER_SHARE * 1.2 * sample.halfWidth * raster.width);
      const found = maxAround(raster, sample.x * raster.width, sample.y * raster.height, radius);
      if (found < 0) continue;
      const target = peakOf(sample.peak);
      measured += 1;
      const ratio = found / target;
      if (ratio < 0.9) low += 1;
      if (ratio < worst) {
        worst = ratio;
        worstAt = t;
      }
    }
    if (measured >= 4 && low / measured > 0.2)
      notes.push({
        code: 'MAP_RANGE_CREST_LOW',
        severity: 'warning',
        message: `Range ${range.id} reaches less than 90% of its requested crest height along ${low} of ${measured} sampled points (worst ${Math.round(worst * 100)}% at ${Math.round(worstAt * 100)}% of its length); a plateau, lake or the coast may overlap it`,
        details: {
          rangeId: range.id,
          sampled: measured,
          low,
          worstRatio: Math.round(worst * 100) / 100,
        },
      });
  }
  for (const pass of geography.passes) {
    const range = geography.get('range', pass.rangeId);
    const table = tables.find((candidate) => candidate.id === pass.rangeId);
    if (range === undefined || table === undefined || pass.depth < 0.15) continue;
    const entry = table.passes.find((candidate) => candidate.id === pass.id);
    if (entry === undefined) continue;
    const reach = (entry.halfLength * 1.5) / table.length;
    const at = pass.at;
    const probe = (t: number): number => {
      const sample = sampleAlong(range.path, frame, t);
      const radius = Math.max(3, CREST_WANDER_SHARE * 1.2 * sample.halfWidth * raster.width);
      return maxAround(raster, sample.x * raster.width, sample.y * raster.height, radius);
    };
    if (at - reach < 0 || at + reach > 1) continue;
    const center = probe(at);
    const before = probe(at - reach);
    const after = probe(at + reach);
    if (center < 0 || before < 0 || after < 0) continue;
    const kmid = Math.min(table.count - 1, Math.round(at * (table.count - 1)));
    const expected = Math.max(0, table.crest[kmid]! - table.base[kmid]!) * pass.depth;
    if (center >= Math.min(before, after) - 0.25 * expected)
      notes.push({
        code: 'MAP_PASS_NOT_LOWER',
        severity: 'error',
        message: `Pass ${pass.id} through range ${pass.rangeId} is not lower than the crest either side of it (${center} against ${before} and ${after})`,
        details: {
          passId: pass.id,
          rangeId: pass.rangeId,
          passHeight: center,
          flanks: [before, after],
        },
      });
  }
  for (const volcano of geography.volcanoes) {
    const cx = volcano.at.x * raster.width;
    const cy = volcano.at.y * raster.height;
    const centre = raster.heights[Math.floor(cy) * raster.width + Math.floor(cx)]!;
    const crater = volcano.crater * raster.width;
    let ring = 0;
    const r = Math.ceil(crater * 1.6);
    for (let dy = -r; dy <= r; dy += 1)
      for (let dx = -r; dx <= r; dx += 1) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < crater * 0.8 || d > crater * 1.6) continue;
        const x = Math.floor(cx) + dx;
        const y = Math.floor(cy) + dy;
        if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
        const value = raster.heights[y * raster.width + x]!;
        if (value > ring) ring = value;
      }
    void volcanoPeak;
    if (raster.kind[Math.floor(cy) * raster.width + Math.floor(cx)] === LAND && ring - centre < 3)
      notes.push({
        code: 'MAP_VOLCANO_NO_CRATER',
        severity: 'warning',
        message: `Volcano ${volcano.id} has no crater at its centre (${centre} against a rim of ${ring}); widen its crater or its radius`,
        details: { volcanoId: volcano.id, centre, rim: ring },
      });
  }
  return notes;
}

/** Percentiles and the mean central step of the land heights. */
export function reliefStatistics(raster: HeightRaster): ReliefStatistics {
  const { width, height, kind, heights } = raster;
  const histogram = new Float64Array(256);
  let landPixels = 0;
  let maximum = 0;
  let stepSum = 0;
  let stepCount = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (kind[index] !== LAND) continue;
      landPixels += 1;
      const value = heights[index]!;
      histogram[value] = histogram[value]! + 1;
      if (value > maximum) maximum = value;
      // Central height step of the half-resolution map: four full-resolution pixels apart.
      if ((x & 1) === 0 && (y & 1) === 0 && x >= 2 && x < width - 2 && y >= 2 && y < height - 2) {
        const gx = heights[index + 2]! - heights[index - 2]!;
        const gy = heights[index + 2 * width]! - heights[index - 2 * width]!;
        stepSum += (Math.abs(gx) + Math.abs(gy)) / 2;
        stepCount += 1;
      }
    }
  const percentile = (share: number): number => {
    const target = landPixels * share;
    let seen = 0;
    for (let value = 0; value < 256; value += 1) {
      seen += histogram[value]!;
      if (seen >= target) return value;
    }
    return 255;
  };
  return {
    landPixels,
    median: landPixels === 0 ? 0 : percentile(0.5),
    p99: landPixels === 0 ? 0 : percentile(0.99),
    maximum,
    meanStep: stepCount === 0 ? 0 : stepSum / stepCount,
  };
}

/**
 * Share of river pixels whose neighbourhood of 20 pixels either way along the river lies within
 * `tolerance` pixels of one straight line: the measure of rivers that run as if drawn with a ruler.
 * The base game measures 1.1% (staircase diagonals count as straight, as they look it). Only pixels
 * with exactly two river neighbours are walked, so confluences and mouths are never counted.
 */
export function straightRiverShare(
  bitmap: Uint8Array,
  width: number,
  height: number,
  tolerance = 1.5,
  half = 20,
): { river: number; straight: number } {
  const isRiver = (x: number, y: number): boolean => bitmap[y * width + x]! <= 11;
  const neighbours = (x: number, y: number, out: number[]): number => {
    let count = 0;
    if (x + 1 < width && isRiver(x + 1, y)) out[count++] = y * width + x + 1;
    if (x > 0 && isRiver(x - 1, y)) out[count++] = y * width + x - 1;
    if (y + 1 < height && isRiver(x, y + 1)) out[count++] = (y + 1) * width + x;
    if (y > 0 && isRiver(x, y - 1)) out[count++] = (y - 1) * width + x;
    return count;
  };
  let river = 0;
  let straight = 0;
  const around: number[] = [0, 0, 0, 0];
  const ahead: number[] = [0, 0, 0, 0];
  const points = new Int32Array(2 * half + 1);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (!isRiver(x, y)) continue;
      river += 1;
      if (neighbours(x, y, around) !== 2) continue;
      points[half] = y * width + x;
      let complete = true;
      for (let side = 0; side < 2 && complete; side += 1) {
        let previous = y * width + x;
        let current = around[side]!;
        for (let step = 1; step <= half; step += 1) {
          points[side === 0 ? half - step : half + step] = current;
          if (step === half) break;
          const cx = current % width;
          const cy = (current - cx) / width;
          const found = neighbours(cx, cy, ahead);
          let next = -1;
          let others = 0;
          for (let k = 0; k < found; k += 1)
            if (ahead[k] !== previous) {
              next = ahead[k]!;
              others += 1;
            }
          if (others !== 1) {
            complete = false;
            break;
          }
          previous = current;
          current = next;
        }
      }
      if (!complete) continue;
      const a = points[0]!;
      const b = points[2 * half]!;
      const ax = a % width;
      const ay = (a - ax) / width;
      const dx = (b % width) - ax;
      const dy = Math.floor(b / width) - ay;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length < half * 1.2) continue;
      let line = true;
      for (let k = 1; k < 2 * half && line; k += 1) {
        const p = points[k]!;
        const px = p % width;
        const py = (p - px) / width;
        if (Math.abs((px - ax) * dy - (py - ay) * dx) / length > tolerance) line = false;
      }
      if (line) straight += 1;
    }
  return { river, straight };
}
