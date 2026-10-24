/**
 * Platform-stable numeric helpers for the climate, biome and colour stages (ADR 0057). Only
 * `+ - * /` and `sqrt` enter the results, never `Math.pow`, `Math.exp`, `Math.sin` or `Math.cos`,
 * whose last digit may differ between Node builds and would change the world a seed produces.
 */

const DEGREES_TO_RADIANS = 0.017453292519943295;

/** Sine of an angle in degrees: range reduction plus a Taylor polynomial (error below 1e-7). */
export function sinDeg(degrees: number): number {
  let d = degrees % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  if (d > 90) d = 180 - d;
  else if (d < -90) d = -180 - d;
  const r = d * DEGREES_TO_RADIANS;
  const r2 = r * r;
  return (
    r *
    (1 -
      (r2 / 6) *
        (1 - (r2 / 20) * (1 - (r2 / 42) * (1 - (r2 / 72) * (1 - (r2 / 110) * (1 - r2 / 156))))))
  );
}

/** Cosine of an angle in degrees. */
export function cosDeg(degrees: number): number {
  return sinDeg(90 - degrees);
}

const ROOT_BITS = 22;

/**
 * `x ** exponent` for `x` in 0..1 and `exponent` in 0..4, by multiplying the repeated square
 * roots of `x` that the binary digits of the exponent select. Exact to about 1e-6 relative.
 */
export function powStable(x: number, exponent: number): number {
  if (x <= 0) return exponent === 0 ? 1 : 0;
  let whole = Math.floor(exponent);
  let fraction = exponent - whole;
  let result = 1;
  while (whole > 0) {
    result *= x;
    whole -= 1;
  }
  let root = x;
  for (let bit = 0; bit < ROOT_BITS && fraction > 0; bit += 1) {
    root = Math.sqrt(root);
    fraction *= 2;
    if (fraction >= 1) {
      result *= root;
      fraction -= 1;
    }
  }
  return result;
}

/** A power curve on 0..1 sampled into a table, with direct evaluation near zero where it is steep. */
export class PowerTable {
  readonly exponent: number;
  readonly #table: Float64Array;
  readonly #size: number;

  constructor(exponent: number, size = 4096) {
    this.exponent = exponent;
    this.#size = size;
    this.#table = new Float64Array(size + 1);
    for (let index = 0; index <= size; index += 1)
      this.#table[index] = powStable(index / size, exponent);
  }

  at(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const position = x * this.#size;
    const index = Math.floor(position);
    if (index < 2 && this.exponent < 1) return powStable(x, this.exponent);
    const t = position - index;
    const low = this.#table[index]!;
    return low + (this.#table[index + 1]! - low) * t;
  }
}

/** `1 / (1 + u^2)^2` with `u = (x - centre) / width`: a bump with a long, smooth tail. */
export function bump(x: number, centre: number, width: number): number {
  const u = (x - centre) / width;
  const d = 1 + u * u;
  return 1 / (d * d);
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}
