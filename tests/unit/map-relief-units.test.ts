import { describe, expect, it } from 'vitest';
import {
  MinHeap,
  bilinear,
  chamferDistance,
  labelComponents,
} from '../../src/hoi4_agent_tools/map/relief/grid.js';
import {
  Rng,
  log2Approx,
  pow125,
  pow15,
  ridged2,
  seedFromString,
  smoothstep,
} from '../../src/hoi4_agent_tools/map/relief/math.js';
import {
  reliefStatistics,
  straightRiverShare,
} from '../../src/hoi4_agent_tools/map/relief/checks.js';
import type { MacroRiver } from '../../src/hoi4_agent_tools/map/relief/hydrology.js';
import { rasterizeRivers } from '../../src/hoi4_agent_tools/map/relief/river-raster.js';
import { checkRiverBitmap } from '../helpers/relief-checks.js';

describe('grid helpers', () => {
  it('pops a heap in key order, ties by id, and grows past its capacity', () => {
    const heap = new MinHeap(2);
    const entries: Array<[number, number]> = [];
    let state = 17;
    for (let id = 0; id < 200; id += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const key = state % 20;
      entries.push([key, id]);
      heap.push(key, id);
    }
    entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [key, id] of entries) {
      expect(heap.pop()).toBe(id);
      expect(heap.popKey).toBe(key);
    }
    expect(heap.length).toBe(0);
    heap.push(1, 1);
    heap.clear();
    expect(heap.length).toBe(0);
  });

  it('measures chamfer distances along axes and diagonals, clipped at the limit', () => {
    const source = new Uint8Array(21 * 21);
    source[10 * 21 + 10] = 1;
    const distance = chamferDistance(source, 21, 21, 8);
    expect(distance[10 * 21 + 10]).toBe(0);
    expect(distance[10 * 21 + 17]).toBe(7);
    expect(distance[13 * 21 + 13]).toBeCloseTo(3 * Math.SQRT2, 5);
    expect(distance[0]).toBe(8);
  });

  it('labels four-connected components and keeps diagonal neighbours apart', () => {
    // Two blocks touching only at a corner are two components.
    const grid = Uint8Array.from([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
    const parts = labelComponents(4, 4, (index) => grid[index] === 1);
    expect(parts.sizes).toEqual([4, 4]);
    expect(parts.label[0]).toBe(0);
    expect(parts.label[15]).toBe(1);
    expect(parts.label[3]).toBe(-1);
  });

  it('interpolates bilinearly with cell centres on integers and clamps at the border', () => {
    const field = Float32Array.from([0, 10, 20, 30]);
    expect(bilinear(field, 2, 2, 0, 0)).toBe(0);
    expect(bilinear(field, 2, 2, 0.5, 0.5)).toBe(15);
    expect(bilinear(field, 2, 2, -3, 9)).toBe(20);
  });
});

describe('platform-stable maths', () => {
  it('computes powers and logarithms from sqrt and arithmetic', () => {
    expect(pow15(4)).toBe(8);
    expect(pow125(16)).toBe(32);
    expect(log2Approx(8)).toBe(3);
    expect(log2Approx(12)).toBe(3.5);
    expect(log2Approx(0.5)).toBe(0);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
  });

  it('seeds streams by name and repeats exactly', () => {
    expect(seedFromString(7, 'spine')).toBe(seedFromString(7, 'spine'));
    expect(seedFromString(7, 'spine')).not.toBe(seedFromString(7, 'ring'));
    expect(seedFromString(7, 'spine')).not.toBe(seedFromString(8, 'spine'));
    const a = new Rng(5);
    const b = new Rng(5);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
    const value = ridged2(3, 12.5, 40.25, 20, 3);
    expect(value).toBe(ridged2(3, 12.5, 40.25, 20, 3));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('river checks', () => {
  const paint = (path: Array<[number, number]>, width: number, height: number): Uint8Array => {
    const bitmap = new Uint8Array(width * height).fill(255);
    for (const [x, y] of path) bitmap[y * width + x] = 5;
    return bitmap;
  };

  it('counts a ruler-straight river as straight and a meandering one as not', () => {
    const straight = Array.from({ length: 150 }, (_, x): [number, number] => [x + 5, 30]);
    const wavy: Array<[number, number]> = [];
    let y = 30;
    for (let x = 5; x < 155; x += 1) {
      const target = Math.round(30 + 6 * Math.sin(x / 5));
      while (y !== target) {
        wavy.push([x, y]);
        y += y < target ? 1 : -1;
      }
      wavy.push([x, y]);
    }
    const flat = straightRiverShare(paint(straight, 170, 60), 170, 60);
    expect(flat.river).toBe(150);
    expect(flat.straight / flat.river).toBeGreaterThan(0.6);
    const bent = straightRiverShare(paint(wavy, 170, 60), 170, 60);
    expect(bent.straight).toBe(0);
  });

  it('ignores confluences and short rivers', () => {
    const cross: Array<[number, number]> = [];
    for (let k = 0; k < 60; k += 1) cross.push([30, k], [k, 30]);
    const share = straightRiverShare(paint(cross, 80, 80), 80, 80);
    expect(share.straight).toBeLessThan(share.river);
    expect(
      straightRiverShare(
        paint(
          [
            [3, 3],
            [4, 3],
          ],
          10,
          10,
        ),
        10,
        10,
      ).straight,
    ).toBe(0);
  });

  it('measures the land height distribution and the central step', () => {
    const width = 16;
    const height = 16;
    const kind = new Uint8Array(width * height).fill(1);
    const heights = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) heights[y * width + x] = 100 + x * 2;
    const stats = reliefStatistics({ width, height, kind, heights });
    expect(stats.landPixels).toBe(256);
    expect(stats.median).toBe(114);
    expect(stats.maximum).toBe(130);
    // A height rising two per pixel changes by 8 over four pixels; half of that per axis pair.
    expect(stats.meanStep).toBeCloseTo(4, 5);
  });
});

describe('river pixels from macro rivers', () => {
  // A 64 x 64 map of land with a sea strip at the east edge; the macro grid is 32 x 32.
  const width = 64;
  const height = 64;
  const kind = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y += 1) for (let x = 60; x < width; x += 1) kind[y * width + x] = 0;
  const macroWidth = 32;
  const cell = (x: number, y: number): number => y * macroWidth + x;

  function river(
    id: string,
    cells: number[],
    extra: Partial<MacroRiver> & Pick<MacroRiver, 'parent' | 'joinCell' | 'junction' | 'endsIn'>,
  ): MacroRiver {
    return {
      id,
      named: false,
      cells: Int32Array.from(cells),
      size: 0,
      catchment: new Float32Array(cells.length).fill(10),
      width: new Uint8Array(cells.length).fill(4),
      order: 1,
      climb: 0,
      ...extra,
    };
  }

  it('writes a green source, a red tributary end and a yellow distributary start without blocks', () => {
    const main = Array.from({ length: 28 }, (_, i) => cell(2 + i, 16));
    const tributary = Array.from({ length: 13 }, (_, i) => cell(8, 2 + i));
    const distributary = Array.from({ length: 8 }, (_, i) => cell(20 + i, 18 + (i >> 2)));
    const rivers = [
      river('main', main, {
        named: true,
        parent: -1,
        joinCell: -1,
        junction: 'none',
        endsIn: 'sea',
      }),
      river('brook', tributary, {
        parent: 0,
        joinCell: cell(8, 16),
        junction: 'tributary',
        endsIn: 'river',
      }),
      river('branch', distributary, {
        named: true,
        parent: 0,
        joinCell: cell(20, 16),
        junction: 'distributary',
        endsIn: 'sea',
      }),
    ];
    const heights = new Float32Array(width * height).fill(110);
    const result = rasterizeRivers({
      rivers,
      macroWidth,
      macroHeight: 32,
      kind,
      width,
      height,
      heights,
      seed: 3,
    });
    expect(result.rivers.map(({ complete }) => complete)).toEqual([true, true, true]);
    const report = checkRiverBitmap(result.bitmap, kind, width, height);
    expect(report).toMatchObject({
      blocks: 0,
      isolated: 0,
      onWater: 0,
      invalid: 0,
      badSources: 0,
      components: 1,
      sources: 1,
      tributaryEnds: 1,
      distributaryStarts: 1,
    });
    // The main river starts with the green pixel and ends beside the sea.
    const path = result.rivers[0]!.pixels;
    expect(result.bitmap[path[0]!]).toBe(0);
    const last = path[path.length - 1]!;
    expect(kind[last + 1]).toBe(0);
    // Orders and heights: the river bed never rises downstream.
    expect(result.order[path[0]!]).toBe(1);
    let level = Infinity;
    for (const pixel of path) {
      expect(heights[pixel]!).toBeLessThanOrEqual(level);
      level = heights[pixel]!;
    }
  });

  it('keeps two rivers apart and never lets a river run over water', () => {
    const a = Array.from({ length: 20 }, (_, i) => cell(2 + i, 10));
    const b = Array.from({ length: 20 }, (_, i) => cell(2 + i, 11));
    const lost = Array.from({ length: 6 }, (_, i) => cell(30, 4 + i));
    const rivers = [
      river('a', a, { parent: -1, joinCell: -1, junction: 'none', endsIn: 'sea' }),
      river('b', b, { parent: -1, joinCell: -1, junction: 'none', endsIn: 'sea' }),
      river('over-water', lost, { parent: -1, joinCell: -1, junction: 'none', endsIn: 'sea' }),
    ];
    const result = rasterizeRivers({
      rivers,
      macroWidth,
      macroHeight: 32,
      kind,
      width,
      height,
      heights: new Float32Array(width * height).fill(110),
      seed: 4,
    });
    const report = checkRiverBitmap(result.bitmap, kind, width, height);
    expect(report.blocks).toBe(0);
    expect(report.onWater).toBe(0);
    expect(report.badSources).toBe(0);
    // Two rivers drawn on neighbouring macro rows are separate components, each with its own source.
    expect(report.components).toBe(report.sources);
    // The river whose cells are all water is dropped instead of drawn on the sea.
    expect(result.rivers[2]!.pixels.length).toBe(0);
  });

  it('drops unnamed headwaters beyond the pixel cap and reports it', () => {
    const rivers = [2, 8, 14, 20].map((y) =>
      river(
        `stream:${y}`,
        Array.from({ length: 25 }, (_, i) => cell(2 + i, y)),
        { parent: -1, joinCell: -1, junction: 'none', endsIn: 'sea' },
      ),
    );
    const result = rasterizeRivers({
      rivers,
      macroWidth,
      macroHeight: 32,
      kind,
      width,
      height,
      heights: new Float32Array(width * height).fill(110),
      seed: 5,
      pixelCap: 150,
    });
    expect(result.pixels).toBeLessThanOrEqual(150);
    expect(result.pixels).toBeGreaterThan(40);
    expect(result.notes.map(({ code }) => code)).toContain('MAP_RIVER_DENSITY');
    expect(checkRiverBitmap(result.bitmap, kind, width, height).badSources).toBe(0);
  });
});
