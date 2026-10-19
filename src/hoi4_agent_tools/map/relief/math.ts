/**
 * Platform-stable numeric helpers for relief and hydrology synthesis (ADR 0056). Only `+ - * /`,
 * `sqrt`, `floor` and integer arithmetic are used: `Math.exp`, `Math.pow` and `Math.sin` may differ
 * between Node builds, which would change the world a seed produces.
 */
import { fractal, lattice, valueNoise } from '../world-noise.js';

export const SQRT2 = 1.4142135623730951;

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cubic smoothstep of `t` clamped to 0..1. */
export function smoothstep(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

/** `u ** 1.5` for `u >= 0`. */
export function pow15(u: number): number {
  return u * Math.sqrt(u);
}

/** `u ** 1.25` for `u >= 0`. */
export function pow125(u: number): number {
  return u * Math.sqrt(Math.sqrt(u));
}

/** Piecewise-linear base two logarithm for `x >= 1`: exact at powers of two. */
export function log2Approx(x: number): number {
  if (x <= 1) return 0;
  let mantissa = x;
  let exponent = 0;
  while (mantissa >= 2) {
    mantissa /= 2;
    exponent += 1;
  }
  return exponent + (mantissa - 1);
}

/** Integer hash to 0..1 for pairs of integers. */
export function hash01(seed: number, a: number, b = 0): number {
  return lattice(seed, a, b);
}

/** Smooth value noise in 0..1. */
export function noise2(seed: number, x: number, y: number): number {
  return valueNoise(seed, x, y);
}

/** Fractal value noise in about 0.2..0.8; `scale` is the wavelength of the first octave. */
export function fractal2(seed: number, x: number, y: number, scale: number, octaves = 4): number {
  return fractal(seed, x, y, scale, octaves);
}

/**
 * Ridged multifractal noise in 0..1: sharp crests where the underlying noise crosses its middle,
 * squared per octave so the crests stand out from broad flanks.
 */
export function ridged2(seed: number, x: number, y: number, scale: number, octaves = 3): number {
  let total = 0;
  let amplitude = 1;
  let weight = 0;
  let frequency = 1 / scale;
  for (let octave = 0; octave < octaves; octave += 1) {
    const n = valueNoise(seed + octave * 131, x * frequency, y * frequency) * 2 - 1;
    const ridge = 1 - (n < 0 ? -n : n);
    total += ridge * ridge * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return total / weight;
}

/** A deterministic generator for sequences (mulberry32). */
export class Rng {
  #state: number;
  constructor(seed: number) {
    this.#state = (seed ^ 0x9e3779b9) >>> 0;
  }
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
}

/** Mix a string into a seed so every feature gets its own stable stream. */
export function seedFromString(base: number, text: string): number {
  let hash = Math.imul(base ^ 0x811c9dc5, 0x01000193);
  for (let index = 0; index < text.length; index += 1)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash ^ (hash >>> 15)) >>> 0;
}
