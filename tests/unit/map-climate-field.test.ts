import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  airCapacity,
  computeClimate,
  latitudeDistance,
  latitudeRain,
  latitudeTemperature,
  smoothField,
  windVector,
  LAPSE_PER_UNIT,
} from '../../src/hoi4_agent_tools/map/climate/climate-field.js';
import { GEOGRAPHY_DEFAULTS } from '../../src/hoi4_agent_tools/map/geography/index.js';
import type { ResolvedClimate } from '../../src/hoi4_agent_tools/map/geography/index.js';

const WIDTH = 256;
const HEIGHT = 128;

function climate(overrides: Partial<ResolvedClimate> = {}): ResolvedClimate {
  return {
    ...GEOGRAPHY_DEFAULTS.climate,
    temperature: { ...GEOGRAPHY_DEFAULTS.climate.temperature },
    declared: true,
    ...overrides,
  };
}

/** Sea in the west third, a land of flat ground with an optional north-south ridge. */
function world(ridgeAt?: number, ridgeHeight = 200) {
  const kind = new Uint8Array(WIDTH * HEIGHT);
  const heights = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const cell = y * WIDTH + x;
      if (x < 60) continue;
      kind[cell] = 1;
      heights[cell] = 100;
      if (ridgeAt !== undefined) {
        const d = Math.abs(x - ridgeAt);
        if (d < 12) heights[cell] = 100 + (ridgeHeight - 100) * (1 - d / 12);
      }
    }
  return { kind, heights };
}

function compute(
  ridgeAt: number | undefined,
  settings: Partial<ResolvedClimate> = {},
  ridgeHeight?: number,
) {
  const { kind, heights } = world(ridgeAt, ridgeHeight);
  return computeClimate({
    settings: climate(settings),
    width: WIDTH,
    height: HEIGHT,
    seed: 5,
    kind,
    heights,
  });
}

function band(field: Float32Array, x0: number, x1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = 40; y < 88; y += 1)
    for (let x = x0; x < x1; x += 1) {
      sum += field[y * WIDTH + x]!;
      count += 1;
    }
  return sum / count;
}

describe('latitude profiles', () => {
  it('are warmest at the warm band and coldest at the poles, on either side of it', () => {
    expect(latitudeTemperature(0, 27, -18)).toBe(27);
    expect(latitudeTemperature(1, 27, -18)).toBe(-18);
    expect(latitudeDistance(0.2, 0.2)).toBe(0);
    expect(latitudeDistance(0, 0.2)).toBe(1);
    expect(latitudeDistance(1, 0.2)).toBe(1);
    expect(latitudeDistance(0.6, 0.2)).toBeCloseTo(0.5, 6);
    // Dry subtropics, wet warm band.
    expect(latitudeRain(0.36)).toBeLessThan(0.5);
    expect(latitudeRain(0)).toBeGreaterThan(1.3);
  });

  it('holds more moisture in warm air', () => {
    expect(airCapacity(30)).toBeGreaterThan(airCapacity(10));
    expect(airCapacity(10)).toBeGreaterThan(airCapacity(-10));
    expect(airCapacity(-30)).toBeCloseTo(0.2, 6);
  });

  it('turns a compass bearing into the direction the wind travels', () => {
    const west = windVector(270);
    expect(west.x).toBeCloseTo(1, 6);
    expect(west.y).toBeCloseTo(0, 6);
    const north = windVector(0);
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(1, 6);
    const east = windVector(90);
    expect(east.x).toBeCloseTo(-1, 6);
  });

  it('smooths a field without changing a constant one', () => {
    const flat = new Float32Array(16 * 16).fill(7);
    expect(smoothField(flat, 16, 16, 2, 2).every((value) => Math.abs(value - 7) < 1e-5)).toBe(true);
  });
});

describe('the climate field', () => {
  it('is wet on the windward side of a range and dry in its lee', () => {
    const fields = compute(150);
    const windward = band(fields.rainfall, 130, 142);
    const lee = band(fields.rainfall, 160, 176);
    expect(windward).toBeGreaterThan(lee * 2);
    // Without the range the same two bands are alike.
    const open = compute(undefined);
    expect(band(open.rainfall, 160, 176) / band(open.rainfall, 130, 142)).toBeGreaterThan(0.5);
    expect(lee).toBeLessThan(band(open.rainfall, 160, 176));
  });

  it('flips the shadow with the wind', () => {
    const easterly = compute(150, { windFrom: 90 });
    const windward = band(easterly.rainfall, 160, 176);
    const lee = band(easterly.rainfall, 124, 140);
    expect(windward).toBeGreaterThan(lee * 1.5);
  });

  it('dries toward the interior of an open continent and wets the coast', () => {
    const fields = compute(undefined);
    expect(band(fields.rainfall, 64, 90)).toBeGreaterThan(band(fields.rainfall, 215, 245));
  });

  it('cools with height by the lapse rate and with latitude', () => {
    const high = compute(150);
    const low = compute(undefined);
    const row = 64 * WIDTH;
    const drop = low.temperature[row + 150]! - high.temperature[row + 150]!;
    expect(drop).toBeGreaterThan(80 * LAPSE_PER_UNIT);
    const mid = low.temperature[64 * WIDTH + 100]!;
    const north = low.temperature[4 * WIDTH + 100]!;
    expect(mid).toBeGreaterThan(north + 15);
  });

  it('scales rainfall with the declared rain scale and keeps multipliers in range', () => {
    const dry = compute(150, { rainScale: 0.5 });
    const wet = compute(150, { rainScale: 2 });
    expect(band(wet.rainfall, 160, 176) / band(dry.rainfall, 160, 176)).toBeCloseTo(4, 0);
    for (const value of wet.rainMultiplier) {
      expect(value).toBeGreaterThanOrEqual(0.25);
      expect(value).toBeLessThanOrEqual(3);
    }
  });

  it('is deterministic and records its output', () => {
    const a = compute(150);
    const b = compute(150);
    expect(Buffer.from(a.rainfall.buffer).equals(Buffer.from(b.rainfall.buffer))).toBe(true);
    const c = compute(150, {}, 220);
    expect(Buffer.from(a.rainfall.buffer).equals(Buffer.from(c.rainfall.buffer))).toBe(false);
    // Only + - * /, sqrt and integer hashes enter the field, so these hold on every platform.
    const sha = (array: Float32Array): string =>
      createHash('sha256').update(Buffer.from(array.buffer)).digest('hex').slice(0, 16);
    expect(sha(a.rainfall)).toBe('a8ad56765e518503');
    expect(sha(a.temperature)).toBe('20641a3ac029ca61');
  });

  it('handles a north-south wind and a wind along the seam without NaN', () => {
    for (const windFrom of [0, 45, 135, 180, 225, 315]) {
      const fields = compute(150, { windFrom });
      expect(fields.rainfall.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    }
  });
});
