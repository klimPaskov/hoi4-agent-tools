/**
 * Climate field (ADR 0057, plan section C8): annual mean temperature from a latitude profile and
 * a lapse rate with height, and annual rainfall from moist air carried by the prevailing wind. The
 * air picks up moisture over water, loses it as rain at a small land rate and a large orographic
 * rate where it climbs (the integrated height gain along the wind), so the windward side of a
 * range is wet and its lee dry, and a continent dries toward its interior. Everything runs on the
 * macro grid (half the map size) with `+ - * /` and `sqrt` only.
 */
import type { ResolvedClimate } from '../geography/index.js';
import { fractal } from '../world-noise.js';
import { bump, clamp01, cosDeg, sinDeg, smoothstep01 } from '../stable-math.js';

const SEA = 0;
const LAND = 1;

/** Degrees Celsius lost per height unit above `LAPSE_START` (about 6.5 degrees per kilometre). */
export const LAPSE_PER_UNIT = 0.1;
export const LAPSE_START = 100;
/** Height written for water cells in the height array the advection reads. */
const WATER_LEVEL = 94;

/** Air moisture a cell can hold, 0.2 (cold) to 1 (hot). */
export function airCapacity(temperature: number): number {
  return 0.2 + 0.8 * smoothstep01((temperature + 8) / 38);
}

export interface ClimateInput {
  settings: ResolvedClimate;
  /** The macro grid: half the map size. */
  width: number;
  height: number;
  seed: number;
  /** 0 sea, 1 land, 2 lake per macro cell. */
  kind: Uint8Array;
  /** Land height per macro cell in map values; water cells are ignored. */
  heights: Float32Array;
  signal?: AbortSignal | undefined;
}

export interface ClimateFields {
  readonly width: number;
  readonly height: number;
  readonly settings: ResolvedClimate;
  /** Unit vector the wind travels along, x east and y south. */
  readonly wind: { readonly x: number; readonly y: number };
  /** Annual mean temperature in degrees Celsius, with the lapse rate on land. */
  readonly temperature: Float32Array;
  /** Annual precipitation index: 1 is a wet temperate lowland, 0.25 a steppe, 0.1 a desert. */
  readonly rainfall: Float32Array;
  /** Rainfall relative to the mean over land, 0.25 to 3: the weight for flow accumulation. */
  readonly rainMultiplier: Float32Array;
  /** Normalised distance from the warmest band to the pole on that side, 0 to 1, per macro row. */
  readonly latitude: Float32Array;
}

/** Distance from the warmest band as a fraction of the way to the nearer-side pole (0 to 1). */
export function latitudeDistance(y01: number, warmBandY: number): number {
  const d =
    y01 < warmBandY
      ? warmBandY <= 0
        ? 0
        : (warmBandY - y01) / warmBandY
      : warmBandY >= 1
        ? 0
        : (y01 - warmBandY) / (1 - warmBandY);
  return d < 0 ? 0 : d > 1 ? 1 : d;
}

/** Annual mean sea-level temperature at a normalised latitude distance. */
export function latitudeTemperature(distance: number, warm: number, cold: number): number {
  return cold + (warm - cold) * (1 - distance * (0.35 + 0.65 * distance));
}

/** Rain rate multiplier by latitude: wet near the warm band, dry in the subtropics, wet again in the storm tracks. */
export function latitudeRain(distance: number): number {
  const value =
    1 +
    0.45 * bump(distance, 0, 0.16) -
    0.6 * bump(distance, 0.36, 0.1) +
    0.2 * bump(distance, 0.68, 0.14) -
    0.5 * smoothstep01((distance - 0.8) / 0.2);
  return value < 0.2 ? 0.2 : value > 1.8 ? 1.8 : value;
}

const EVAPORATION_SEA = 0.07;
const EVAPORATION_LAKE = 0.03;
const RECYCLING_LAND = 0.012;
const RECYCLING_TARGET = 0.75;
const RAIN_SEA = 0.004;
const RAIN_LAND = 0.007;
const OROGRAPHIC_PER_UNIT = 0.04;
const OROGRAPHIC_THRESHOLD = 0.35;
const OROGRAPHIC_LIMIT = 0.6;
const BOUNDARY_AIR = 0.85;
const RAIN_REFERENCE = 0.004;

const OROGRAPHIC_SMOOTHING = 3;

/** A separable moving average of a field, `passes` times (a triangular kernel for two). */
export function smoothField(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
  passes: number,
): Float32Array {
  let current = source;
  const span = 2 * radius + 1;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(current.length);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1)
        sum += current[row + (x < 0 ? 0 : x >= width ? width - 1 : x)]!;
      for (let x = 0; x < width; x += 1) {
        horizontal[row + x] = sum / span;
        const add = x + radius + 1;
        const drop = x - radius;
        sum +=
          current[row + (add >= width ? width - 1 : add)]! -
          current[row + (drop < 0 ? 0 : drop)]!;
      }
    }
    const vertical = new Float32Array(current.length);
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -radius; y <= radius; y += 1)
        sum += horizontal[(y < 0 ? 0 : y >= height ? height - 1 : y) * width + x]!;
      for (let y = 0; y < height; y += 1) {
        vertical[y * width + x] = sum / span;
        const add = y + radius + 1;
        const drop = y - radius;
        sum +=
          horizontal[(add >= height ? height - 1 : add) * width + x]! -
          horizontal[(drop < 0 ? 0 : drop) * width + x]!;
      }
    }
    current = vertical;
  }
  return current;
}

/** The unit vector the wind travels along for a compass bearing it blows from. */
export function windVector(windFrom: number): { x: number; y: number } {
  return { x: -sinDeg(windFrom), y: cosDeg(windFrom) };
}

/** Compute the climate of a macro grid. */
export function computeClimate(input: ClimateInput): ClimateFields {
  const { settings, width, height, seed, kind, heights } = input;
  const total = width * height;
  const wind = windVector(settings.windFrom);
  const latitude = new Float32Array(height);
  for (let y = 0; y < height; y += 1)
    latitude[y] = latitudeDistance((y + 0.5) / height, settings.warmBandY);

  // Temperature: latitude profile, a slow regional wobble, the lapse rate on land.
  const temperature = new Float32Array(total);
  const wobble = Math.max(8, width / 5);
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) input.signal?.throwIfAborted();
    const base = latitudeTemperature(latitude[y]!, settings.temperature.warm, settings.temperature.cold);
    for (let x = 0; x < width; x += 1) {
      const cell = y * width + x;
      let value = base + (fractal(seed + 9011, x, y, wobble, 3) - 0.5) * 8;
      if (kind[cell] === LAND) {
        const above = heights[cell]! - LAPSE_START;
        if (above > 0) value -= above * LAPSE_PER_UNIT;
      }
      temperature[cell] = value;
    }
  }

  // Moist air carried along the wind, one macro cell per step along the dominant axis.
  const moisture = new Float32Array(total);
  const rain = new Float32Array(total);
  const raw = new Float32Array(total);
  for (let cell = 0; cell < total; cell += 1)
    raw[cell] = kind[cell] === LAND ? heights[cell]! : WATER_LEVEL;
  // The air lifts over ranges, not over every hill: the orographic term reads a smoothed height.
  const level = smoothField(raw, width, height, OROGRAPHIC_SMOOTHING, 2);
  const alongX = Math.abs(wind.x) >= Math.abs(wind.y);
  const major = alongX ? width : height;
  const minor = alongX ? height : width;
  const direction = (alongX ? wind.x : wind.y) >= 0 ? 1 : -1;
  const lean = alongX ? wind.y / Math.abs(wind.x) : wind.x / Math.abs(wind.y);
  const step = Math.sqrt(1 + lean * lean);
  const indexOf = (m: number, n: number): number => (alongX ? n * width + m : m * width + n);

  for (let k = 0; k < major; k += 1) {
    if (k % 64 === 0) input.signal?.throwIfAborted();
    const m = direction > 0 ? k : major - 1 - k;
    const previous = m - direction;
    for (let n = 0; n < minor; n += 1) {
      const cell = indexOf(m, n);
      const row = alongX ? n : m;
      const capacity = airCapacity(temperature[cell]!);
      let air: number;
      let upLevel: number;
      if (previous < 0 || previous >= major) {
        air = BOUNDARY_AIR * capacity;
        upLevel = level[cell]!;
      } else {
        const source = n - lean;
        const clamped = source < 0 ? 0 : source > minor - 1 ? minor - 1 : source;
        const n0 = Math.floor(clamped);
        const n1 = n0 + 1 < minor ? n0 + 1 : n0;
        const t = clamped - n0;
        const a = indexOf(previous, n0);
        const b = indexOf(previous, n1);
        air = moisture[a]! + (moisture[b]! - moisture[a]!) * t;
        upLevel = level[a]! + (level[b]! - level[a]!) * t;
      }
      const wet = latitudeRain(latitude[row]!);
      let fall: number;
      if (kind[cell] === LAND) {
        const climb = level[cell]! - upLevel;
        let rate = RAIN_LAND * wet;
        if (climb > OROGRAPHIC_THRESHOLD) {
          const lift = OROGRAPHIC_PER_UNIT * (climb - OROGRAPHIC_THRESHOLD);
          rate += lift < OROGRAPHIC_LIMIT ? lift : OROGRAPHIC_LIMIT;
        }
        rate *= step;
        if (rate > 0.95) rate = 0.95;
        fall = air * rate;
        air -= fall;
        // Vegetation and wet ground give some moisture back; the dry belts give little.
        const target = RECYCLING_TARGET * capacity * (wet < 0.4 ? 0.4 : wet > 1.2 ? 1.2 : wet);
        if (air < target) air += (target - air) * RECYCLING_LAND * step;
      } else {
        const evaporation = kind[cell] === SEA ? EVAPORATION_SEA : EVAPORATION_LAKE;
        air += (capacity - air) * evaporation * step;
        fall = air * RAIN_SEA * wet * step;
        air -= fall;
      }
      moisture[cell] = air;
      rain[cell] = fall;
    }
  }

  const rainfall = new Float32Array(total);
  let landSum = 0;
  let landCount = 0;
  const wobbleRain = Math.max(8, width / 6);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const cell = y * width + x;
      const noisy = 0.85 + 0.3 * fractal(seed + 9109, x, y, wobbleRain, 3);
      const value = Math.min(4, (settings.rainScale * rain[cell]! * noisy) / RAIN_REFERENCE);
      rainfall[cell] = value;
      if (kind[cell] === LAND) {
        landSum += value;
        landCount += 1;
      }
    }
  const mean = landCount === 0 || landSum <= 0 ? 1 : landSum / landCount;
  const rainMultiplier = new Float32Array(total);
  for (let cell = 0; cell < total; cell += 1) {
    const value = rainfall[cell]! / mean;
    rainMultiplier[cell] = value < 0.25 ? 0.25 : value > 3 ? 3 : value;
  }
  void clamp01;
  return { width, height, settings, wind, temperature, rainfall, rainMultiplier, latitude };
}
