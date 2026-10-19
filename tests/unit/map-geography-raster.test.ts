import { describe, expect, it } from 'vitest';
import {
  analysisGrid,
  areaPixels,
  clearBandStrip,
  countAreaStrip,
  createBandStrip,
  fillAreaStrip,
  forEachDiscPixel,
  forEachPolylinePixel,
  pointToPixel,
  rasterizeBandStrip,
  resolveGeography,
  rowStrips,
  sampleAlong,
  scanAreaStrip,
  segmentCount,
  type RasterGrid,
  type ResolvedArea,
  type ResolvedPolyline,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  geographyModelSchema,
  type GeographyModelInput,
} from '../../src/hoi4_agent_tools/schemas/geography.js';

const grid: RasterGrid = { width: 256, height: 128 };

function resolved(model: Omit<GeographyModelInput, 'version'>, frame: RasterGrid = grid) {
  return resolveGeography(geographyModelSchema.parse({ version: 1, ...model }), {
    frame,
    hasReference: true,
    edge: { mode: 'none' },
  }).geography;
}

function landArea(
  polygons: Array<Array<[number, number]>>,
  holes: Array<Array<[number, number]>> = [],
  frame: RasterGrid = grid,
): ResolvedArea {
  return resolved({ lands: [{ id: 'shape', polygons, holes }] }, frame).lands[0]!.area;
}

function rangePath(
  points: Array<[number, number]>,
  closed = false,
  frame: RasterGrid = grid,
): ResolvedPolyline {
  return resolved({ ranges: [{ id: 'line', path: points, closed, halfWidth: 0.02 }] }, frame)
    .ranges[0]!.path;
}

function coverage(area: ResolvedArea, frame: RasterGrid = grid, rows = 16): Uint8Array {
  const mask = new Uint8Array(frame.width * frame.height);
  for (const strip of rowStrips(frame, rows)) {
    const buffer = new Uint8Array(frame.width * (strip.y1 - strip.y0));
    fillAreaStrip(area, frame, strip, buffer, 1);
    mask.set(buffer, strip.y0 * frame.width);
  }
  return mask;
}

describe('area rasterisation', () => {
  it('covers exactly the pixels whose centres lie inside an aligned rectangle', () => {
    const area = landArea([
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ],
    ]);
    const mask = coverage(area);
    let count = 0;
    for (const value of mask) count += value;
    expect(count).toBe(128 * 64);
    expect(areaPixels(area, grid)).toBeCloseTo(128 * 64, 6);
    expect(mask[32 * 256 + 64]).toBe(1);
    expect(mask[32 * 256 + 63]).toBe(0);
    expect(mask[31 * 256 + 64]).toBe(0);
    expect(mask[95 * 256 + 191]).toBe(1);
    expect(mask[96 * 256 + 191]).toBe(0);
  });

  it('is independent of the strip height', () => {
    const area = landArea([
      [
        [0.1, 0.1],
        [0.9, 0.2],
        [0.7, 0.9],
        [0.4, 0.5],
        [0.15, 0.8],
      ],
    ]);
    const reference = coverage(area, grid, 128);
    for (const rows of [1, 7, 16, 33, 64])
      expect(Buffer.from(coverage(area, grid, rows)).equals(Buffer.from(reference))).toBe(true);
  });

  it('counts the same pixels per strip as the buffer fill', () => {
    const area = landArea([
      [
        [0.2, 0.1],
        [0.8, 0.3],
        [0.5, 0.9],
      ],
    ]);
    let counted = 0;
    for (const strip of rowStrips(grid, 10)) counted += countAreaStrip(area, grid, strip);
    let filled = 0;
    for (const value of coverage(area)) filled += value;
    expect(counted).toBe(filled);
    // The analytic area agrees with the count to within the boundary pixels.
    expect(Math.abs(counted - areaPixels(area, grid))).toBeLessThan(0.02 * counted);
  });

  it('subtracts holes and keeps multiple polygons apart', () => {
    // Edges sit on pixel boundaries (multiples of 1/8 of 256 by 128), so the count is exact.
    const area = landArea(
      [
        [
          [0.125, 0.125],
          [0.5, 0.125],
          [0.5, 0.875],
          [0.125, 0.875],
        ],
        [
          [0.625, 0.125],
          [0.875, 0.125],
          [0.875, 0.875],
          [0.625, 0.875],
        ],
      ],
      [
        [
          [0.25, 0.375],
          [0.375, 0.375],
          [0.375, 0.625],
          [0.25, 0.625],
        ],
      ],
    );
    const mask = coverage(area);
    let count = 0;
    for (const value of mask) count += value;
    expect(count).toBe(96 * 96 + 64 * 96 - 32 * 32);
    expect(mask[64 * 256 + 80]).toBe(0);
    expect(mask[64 * 256 + 50]).toBe(1);
    expect(mask[64 * 256 + 140]).toBe(0);
    expect(mask[64 * 256 + 200]).toBe(1);
  });

  it('reports ordered, non-overlapping spans per row', () => {
    const area = landArea([
      [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.6, 0.9],
        [0.6, 0.4],
        [0.4, 0.4],
        [0.4, 0.9],
        [0.1, 0.9],
      ],
    ]);
    const spans = new Map<number, Array<[number, number]>>();
    scanAreaStrip(area, grid, { y0: 0, y1: grid.height }, (y, x0, x1) => {
      spans.set(y, [...(spans.get(y) ?? []), [x0, x1]]);
    });
    expect(spans.get(30)).toHaveLength(1);
    expect(spans.get(80)).toHaveLength(2);
    for (const list of spans.values())
      for (let index = 1; index < list.length; index++)
        expect(list[index]![0]).toBeGreaterThanOrEqual(list[index - 1]![1]);
  });

  it('clips to the strip and writes nothing outside it', () => {
    const area = landArea([
      [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    ]);
    const rows: number[] = [];
    scanAreaStrip(area, grid, { y0: 20, y1: 30 }, (y) => rows.push(y));
    expect(Math.min(...rows)).toBe(20);
    expect(Math.max(...rows)).toBe(29);
    scanAreaStrip(area, grid, { y0: 0, y1: 5 }, () => {
      throw new Error('outside the shape');
    });
    expect(() =>
      scanAreaStrip(area, grid, { y0: 10, y1: 10 }, () => {
        throw new Error('empty strip');
      }),
    ).not.toThrow();
  });

  it('rasterises a thin shape at a large frame without gaps between strips', () => {
    const big: RasterGrid = { width: 2048, height: 1024 };
    const area = landArea(
      [
        [
          [0.05, 0.05],
          [0.95, 0.5],
          [0.05, 0.52],
        ],
      ],
      [],
      big,
    );
    const whole = coverage(area, big, 1024);
    expect(Buffer.from(coverage(area, big, 31)).equals(Buffer.from(whole))).toBe(true);
  });
});

describe('path rasterisation', () => {
  it('visits an 8-connected run in path order with rising arc fractions', () => {
    const line = rangePath([
      [0.1, 0.2],
      [0.5, 0.6],
      [0.9, 0.3],
    ]);
    const visited: Array<[number, number, number]> = [];
    forEachPolylinePixel(line, grid, { y0: 0, y1: grid.height }, (x, y, t) =>
      visited.push([x, y, t]),
    );
    expect(visited.length).toBeGreaterThan(100);
    for (let index = 1; index < visited.length; index++) {
      expect(Math.abs(visited[index]![0] - visited[index - 1]![0])).toBeLessThanOrEqual(1);
      expect(Math.abs(visited[index]![1] - visited[index - 1]![1])).toBeLessThanOrEqual(1);
      expect(visited[index]![2]).toBeGreaterThanOrEqual(visited[index - 1]![2]);
    }
    expect(visited[0]![2]).toBe(0);
    expect(visited.at(-1)![2]).toBeCloseTo(1, 1);
    expect(new Set(visited.map(([x, y]) => `${x},${y}`)).size).toBe(visited.length);
  });

  it('splits into strips without losing or repeating pixels', () => {
    const line = rangePath([
      [0.1, 0.1],
      [0.8, 0.9],
      [0.2, 0.7],
    ]);
    const whole: string[] = [];
    forEachPolylinePixel(line, grid, { y0: 0, y1: grid.height }, (x, y) => whole.push(`${x},${y}`));
    const pieces: string[] = [];
    for (const strip of rowStrips(grid, 13))
      forEachPolylinePixel(line, grid, strip, (x, y) => pieces.push(`${x},${y}`));
    expect(pieces.sort()).toEqual([...whole].sort());
  });

  it('measures distance, arc fraction and side to the nearest segment', () => {
    const line = rangePath([
      [0.25, 0.5],
      [0.75, 0.5],
    ]);
    const strip = { y0: 0, y1: grid.height };
    const band = createBandStrip(grid, strip);
    rasterizeBandStrip(line, grid, strip, 10, band);
    const at = (x: number, y: number) => y * grid.width + x;
    // y = 64 is the line; pixel centres are half a pixel off it.
    expect(band.distance[at(128, 63)]).toBeCloseTo(0.5, 5);
    expect(band.distance[at(128, 60)]).toBeCloseTo(3.5, 5);
    expect(band.distance[at(128, 70)]).toBeCloseTo(6.5, 5);
    expect(band.distance[at(128, 20)]).toBe(Infinity);
    expect(band.t[at(128, 63)]).toBeCloseTo(0.5, 2);
    expect(band.t[at(70, 63)]).toBeCloseTo((70.5 - 64) / 128, 2);
    // Walking east along the line, south (y larger) is on the right as drawn.
    expect(band.side[at(128, 70)]).toBe(1);
    expect(band.side[at(128, 60)]).toBe(-1);
    // Beyond the end the nearest point is the end vertex.
    expect(band.distance[at(200, 64)]).toBeCloseTo(Math.hypot(200.5 - 192, 0.5), 5);
    clearBandStrip(band);
    expect(band.distance[at(128, 63)]).toBe(Infinity);
  });

  it('gives the same band in strips as over the whole map', () => {
    const line = rangePath([
      [0.1, 0.8],
      [0.4, 0.2],
      [0.9, 0.6],
    ]);
    const whole = createBandStrip(grid, { y0: 0, y1: grid.height });
    rasterizeBandStrip(line, grid, { y0: 0, y1: grid.height }, 12, whole);
    for (const strip of rowStrips(grid, 17)) {
      const band = createBandStrip(grid, strip);
      rasterizeBandStrip(line, grid, strip, 12, band);
      for (let y = strip.y0; y < strip.y1; y++)
        for (let x = 0; x < grid.width; x++) {
          const a = band.distance[(y - strip.y0) * grid.width + x]!;
          const b = whole.distance[y * grid.width + x]!;
          expect(a).toBe(b);
          if (Number.isFinite(a)) {
            expect(band.t[(y - strip.y0) * grid.width + x]).toBe(whole.t[y * grid.width + x]);
            expect(band.side[(y - strip.y0) * grid.width + x]).toBe(whole.side[y * grid.width + x]);
          }
        }
    }
  });

  it('includes the closing edge of a closed path', () => {
    const ring = rangePath(
      [
        [0.2, 0.2],
        [0.8, 0.2],
        [0.8, 0.8],
        [0.2, 0.8],
      ],
      true,
    );
    expect(segmentCount(ring)).toBe(4);
    expect(ring.arc).toHaveLength(5);
    const band = createBandStrip(grid, { y0: 0, y1: grid.height });
    rasterizeBandStrip(ring, grid, { y0: 0, y1: grid.height }, 4, band);
    // The left edge, from the last vertex back to the first, is part of the path.
    expect(band.distance[64 * 256 + 51]).toBeLessThan(1);
    const open = rangePath([
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ]);
    const openBand = createBandStrip(grid, { y0: 0, y1: grid.height });
    rasterizeBandStrip(open, grid, { y0: 0, y1: grid.height }, 4, openBand);
    expect(openBand.distance[64 * 256 + 51]).toBe(Infinity);
  });

  it('measures length in map-width units whatever the aspect ratio', () => {
    const wide = rangePath(
      [
        [0.1, 0.5],
        [0.6, 0.5],
      ],
      false,
      { width: 4096, height: 2048 },
    );
    expect(wide.length).toBeCloseTo(0.5, 12);
    const vertical = rangePath(
      [
        [0.5, 0.1],
        [0.5, 0.6],
      ],
      false,
      { width: 4096, height: 2048 },
    );
    expect(vertical.length).toBeCloseTo(0.25, 12);
  });

  it('interpolates along the path by arc length', () => {
    const line = resolved({
      ranges: [
        {
          id: 'line',
          path: [
            { x: 0.2, y: 0.5, halfWidth: 0.01, peak: 0.2 },
            { x: 0.8, y: 0.5, halfWidth: 0.03, peak: 1 },
          ],
        },
      ],
    }).ranges[0]!.path;
    const middle = sampleAlong(line, grid, 0.5);
    expect(middle.x).toBeCloseTo(0.5, 12);
    expect(middle.halfWidth).toBeCloseTo(0.02, 12);
    expect(middle.peak).toBeCloseTo(0.6, 12);
    expect(middle.tangentX).toBe(1);
    expect(sampleAlong(line, grid, -1).x).toBeCloseTo(0.2, 12);
    expect(sampleAlong(line, grid, 2).x).toBeCloseTo(0.8, 12);
  });
});

describe('points', () => {
  it('maps points to pixels and clamps the frame edge', () => {
    expect(pointToPixel(grid, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(pointToPixel(grid, 0.5, 0.5)).toEqual({ x: 128, y: 64 });
    expect(pointToPixel(grid, 1, 1)).toEqual({ x: 255, y: 127 });
  });

  it('visits a disc of the requested radius in strips', () => {
    const big: RasterGrid = { width: 1024, height: 512 };
    const radius = 0.05;
    const visited: string[] = [];
    for (const strip of rowStrips(big, 40))
      forEachDiscPixel({ x: 0.5, y: 0.5 }, radius, big, strip, (x, y, distance) => {
        expect(distance).toBeLessThanOrEqual(radius * big.width);
        visited.push(`${x},${y}`);
      });
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited.length / (Math.PI * (radius * big.width) ** 2)).toBeGreaterThan(0.99);
    expect(visited.length / (Math.PI * (radius * big.width) ** 2)).toBeLessThan(1.01);
  });

  it('builds coarse analysis grids that keep the aspect ratio', () => {
    expect(analysisGrid({ width: 5120, height: 2560 })).toEqual({ width: 512, height: 256 });
    expect(analysisGrid({ width: 256, height: 256 })).toEqual({ width: 256, height: 256 });
  });
});
