import { describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  applyPaintedRelief,
  DEFAULT_PAINTED_RELIEF,
  paintedSnowHeight,
  PAINTED_HILLS,
  PAINTED_MOUNTAIN,
  resolvePaintedRelief,
  type PaintedReliefTarget,
} from '../../src/hoi4_agent_tools/map/relief/painted-relief.js';
import { generateWorld, type WorldSpec } from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { plainContext, syntheticRaster } from '../helpers/map-appearance-world.js';
import { reliefGeography } from '../helpers/relief-fixture.js';

const MW = 160;
const MH = 120;

function target(base = 100): PaintedReliefTarget {
  return {
    width: MW,
    height: MH,
    kind: new Uint8Array(MW * MH).fill(1),
    heights: new Float32Array(MW * MH).fill(base),
    footprint: new Float32Array(MW * MH),
    snowLine: new Uint8Array(MW * MH).fill(255),
    scale: 1,
  };
}

/** Full-resolution classes with `code` inside the given full-resolution rectangle. */
function painted(code: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const classes = new Uint8Array(MW * 2 * MH * 2);
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) classes[y * MW * 2 + x] = code;
  return classes;
}

describe('painted relief on the macro grid', () => {
  const settings = DEFAULT_PAINTED_RELIEF;

  it('lifts a painted massif toward the mountain peak with slopes, not cliffs', () => {
    const relief = target();
    const summary = applyPaintedRelief(relief, {
      classes: painted(PAINTED_MOUNTAIN, 80, 60, 240, 180),
      settings,
      seed: 3,
    });
    expect(summary.raisedCells).toBeGreaterThan(0);
    const at = (x: number, y: number) => relief.heights[y * MW + x]!;
    // The interior stands far above the lowland and its edge falls off gradually.
    expect(at(80, 60)).toBeGreaterThan(160);
    expect(at(2, 2)).toBe(100);
    let steepest = 0;
    for (let y = 0; y < MH; y += 1)
      for (let x = 1; x < MW; x += 1)
        steepest = Math.max(steepest, Math.abs(at(x, y) - at(x - 1, y)));
    // At the default falloff the steepest step is near the base game's mountain flanks.
    expect(steepest).toBeLessThan(16);
    expect(relief.footprint[60 * MW + 80]).toBeGreaterThan(0.9);
    expect(relief.snowLine[60 * MW + 80]).toBe(paintedSnowHeight(60, MH));
  });

  it('lifts nothing worth a spike for a single painted pixel', () => {
    const relief = target();
    applyPaintedRelief(relief, {
      classes: painted(PAINTED_MOUNTAIN, 160, 120, 161, 121),
      settings,
      seed: 3,
    });
    expect(Math.max(...relief.heights)).toBeLessThan(103);
    expect(Math.max(...relief.snowLine)).toBe(255);
    expect(Math.min(...relief.snowLine)).toBe(255);
  });

  it('keeps hills low, keeps higher model ground and leaves water alone', () => {
    const relief = target();
    applyPaintedRelief(relief, {
      classes: painted(PAINTED_HILLS, 0, 0, 320, 240),
      settings,
      seed: 3,
    });
    expect(Math.max(...relief.heights)).toBeLessThanOrEqual(141);
    expect(Math.max(...relief.heights)).toBeGreaterThan(125);
    expect(Math.min(...relief.snowLine)).toBe(255);
    const high = target(230);
    high.kind[0] = 0;
    high.heights[0] = 0;
    applyPaintedRelief(high, {
      classes: painted(PAINTED_MOUNTAIN, 0, 0, 320, 240),
      settings,
      seed: 3,
    });
    expect(high.heights[0]).toBe(0);
    expect(high.heights[60 * MW + 80]).toBeGreaterThanOrEqual(230);
  });

  it('is deterministic and puts the snow line lower toward the poles', () => {
    const run = () => {
      const relief = target();
      applyPaintedRelief(relief, {
        classes: painted(PAINTED_MOUNTAIN, 40, 20, 200, 160),
        settings,
        seed: 9,
      });
      return Buffer.from(relief.heights.buffer);
    };
    expect(run().equals(run())).toBe(true);
    expect(paintedSnowHeight(0, 100)).toBeLessThan(paintedSnowHeight(50, 100));
    expect(paintedSnowHeight(50, 100)).toBe(232);
  });

  it('keeps the snow line at or above snowFloor, and puts none from 255', () => {
    const line = (snowFloor?: number) => {
      const relief = target();
      applyPaintedRelief(relief, {
        classes: painted(PAINTED_MOUNTAIN, 0, 0, 320, 240),
        settings,
        seed: 3,
        snowFloor,
      });
      return relief.snowLine;
    };
    const polar = 2 * MW + 80;
    const equator = 60 * MW + 80;
    expect(line()[polar]).toBe(paintedSnowHeight(2, MH));
    // The floor lifts the polar line and leaves the higher equatorial line alone.
    expect(line(200)[polar]).toBe(200);
    expect(line(200)[equator]).toBe(paintedSnowHeight(60, MH));
    expect(Math.min(...line(256))).toBe(255);
    expect(Math.min(...line(255))).toBe(255);
  });

  it('resolves the option with defaults', () => {
    expect(resolvePaintedRelief(true)).toEqual(DEFAULT_PAINTED_RELIEF);
    expect(resolvePaintedRelief({ falloffPx: 40 })).toEqual({
      ...DEFAULT_PAINTED_RELIEF,
      falloffPx: 40,
    });
  });
});

describe('painted relief in a world from a reference picture and a model', () => {
  const width = 1024;
  const height = 512;
  // Land inside a frame, with a painted mountain block where the model has no range.
  const block = (x: number, y: number) => x >= 200 && x < 330 && y >= 300 && y < 400;
  const raster = syntheticRaster(width, height, {
    at: (x, y) => (x > 120 && x < 900 && y > 70 && y < 440 ? 1 : 0),
    terrain: (x, y) => (block(x, y) ? PAINTED_MOUNTAIN : 0),
  });
  const model = reliefGeography();
  delete model.rivers;
  delete model.lakes;
  const geography = resolveGeography(model, {
    frame: { width, height },
    hasReference: true,
  }).geography;
  const spec = (overrides: Partial<WorldSpec>): WorldSpec => ({
    width,
    height,
    seed: 7,
    landCoverage: 0.4,
    continents: 1,
    landProvincePixels: 3_000,
    seaProvincePixels: 12_000,
    provincesPerState: 6,
    landProvincesPerRegion: 30,
    seaProvincesPerRegion: 10,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [{ tag: 'AAA', name: 'Alpha' }],
    geography,
    referenceSurface: raster,
    ...overrides,
  });

  it('raises the painted block above the same world without it and reports it', () => {
    const plain = generateWorld(spec({}), plainContext);
    const raised = generateWorld(spec({ paintedRelief: DEFAULT_PAINTED_RELIEF }), plainContext);
    const centre = 350 * width + 265;
    expect(raised.terrain!.heights[centre]!).toBeGreaterThan(plain.terrain!.heights[centre]! + 40);
    expect(raised.terrain!.heights[centre]!).toBeGreaterThan(170);
    expect(raised.notes.map(({ code }) => code)).toContain('MAP_RELIEF_PAINTED');
    expect(plain.notes.map(({ code }) => code)).not.toContain('MAP_RELIEF_PAINTED');
    const summary = raised.notes.find(({ code }) => code === 'MAP_RELIEF_SYNTHESIZED');
    expect(summary?.details?.vanilla).toMatchObject({ median: 107, p99: 213, maximum: 239 });
  });

  it('refuses painted relief without a reference picture', () => {
    const { referenceSurface: _picture, ...withoutPicture } = spec({
      paintedRelief: DEFAULT_PAINTED_RELIEF,
    });
    expect(() => generateWorld(withoutPicture, plainContext)).toThrow(
      expect.objectContaining({ code: 'MAP_RELIEF_PAINTED_INPUTS' }),
    );
  });
});

describe('the relief.painted option', () => {
  const base = { kind: 'create_world', id: 'w' };
  it('accepts true or overrides and rejects anything else', () => {
    const parse = (painted: unknown) =>
      mapOperationSchema.safeParse({ ...base, relief: { painted } }).success;
    expect(parse(true)).toBe(true);
    expect(parse({ falloffPx: 32, mountainPeak: 0.9 })).toBe(true);
    expect(parse({ falloffPx: 1 })).toBe(false);
    expect(parse({ mountainPeak: 1.5 })).toBe(false);
    expect(parse({ ridges: true })).toBe(false);
    expect(parse('yes')).toBe(false);
  });
});
