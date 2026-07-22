export interface RationalJson {
  numerator: string;
  denominator: string;
  decimal: string;
  value: number;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Exact rational arithmetic for Clausewitz decimal literals and modifier chains. */
export class Rational {
  public readonly numerator: bigint;
  public readonly denominator: bigint;

  public constructor(numerator: bigint, denominator = 1n) {
    if (denominator === 0n) throw new RangeError('Rational denominator cannot be zero');
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator);
    this.numerator = (numerator / divisor) * sign;
    this.denominator = (denominator / divisor) * sign;
  }

  public static readonly zero = new Rational(0n);
  public static readonly one = new Rational(1n);

  public static parse(value: string | number | bigint): Rational | undefined {
    if (typeof value === 'bigint') return new Rational(value);
    const source = typeof value === 'number' ? String(value) : value.trim();
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
    if (match === null) return undefined;
    const digits = `${match[2] ?? '0'}${match[3] ?? ''}`;
    const sign = match[1] === '-' ? -1n : 1n;
    const exponent = Number(match[4] ?? '0') - (match[3]?.length ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) return undefined;
    const integer = BigInt(digits) * sign;
    return exponent >= 0
      ? new Rational(integer * powerOfTen(exponent))
      : new Rational(integer, powerOfTen(-exponent));
  }

  public add(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  public subtract(other: Rational): Rational {
    return this.add(other.negate());
  }

  public multiply(other: Rational): Rational {
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  public divide(other: Rational): Rational {
    if (other.numerator === 0n) throw new RangeError('Cannot divide by zero');
    return new Rational(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  public pow(exponent: number): Rational {
    if (!Number.isSafeInteger(exponent) || exponent < 0)
      throw new RangeError('Rational exponent must be a non-negative safe integer');
    return new Rational(this.numerator ** BigInt(exponent), this.denominator ** BigInt(exponent));
  }

  public negate(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }

  public compare(other: Rational): number {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  public min(other: Rational): Rational {
    return this.compare(other) <= 0 ? this : other;
  }

  public max(other: Rational): Rational {
    return this.compare(other) >= 0 ? this : other;
  }

  public isZero(): boolean {
    return this.numerator === 0n;
  }

  public toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  public toDecimal(maximumPlaces = 18): string {
    const sign = this.numerator < 0n ? '-' : '';
    const numerator = this.numerator < 0n ? -this.numerator : this.numerator;
    const integer = numerator / this.denominator;
    let remainder = numerator % this.denominator;
    if (remainder === 0n) return `${sign}${integer}`;
    let decimals = '';
    for (let index = 0; index < maximumPlaces && remainder !== 0n; index += 1) {
      remainder *= 10n;
      decimals += String(remainder / this.denominator);
      remainder %= this.denominator;
    }
    return `${sign}${integer}.${decimals}`;
  }

  public toJSON(): RationalJson {
    return {
      numerator: String(this.numerator),
      denominator: String(this.denominator),
      decimal: this.toDecimal(),
      value: this.toNumber(),
    };
  }
}

export function sumRationals(values: readonly Rational[]): Rational {
  return values.reduce((sum, value) => sum.add(value), Rational.zero);
}

/**
 * Exact probability that each independent U(0, weight) score wins the maximum race.
 * This is the selection rule documented for focus and technology AI scoring.
 */
export function uniformRaceProbabilities(weights: readonly Rational[]): Rational[] {
  const positive = weights.map((weight) => weight.max(Rational.zero));
  if (positive.every((weight) => weight.isZero())) return weights.map(() => Rational.zero);
  const ordered = positive
    .filter((weight) => !weight.isZero())
    .sort((left, right) => left.compare(right));
  const groups: Array<{ weight: Rational; count: number }> = [];
  for (const weight of ordered) {
    const last = groups.at(-1);
    if (last?.weight.compare(weight) === 0) last.count += 1;
    else groups.push({ weight, count: 1 });
  }
  let activeProduct = ordered.reduce((product, weight) => product.multiply(weight), Rational.one);
  let activeCount = ordered.length;
  let low = Rational.zero;
  let cumulative = Rational.zero;
  const probabilityByWeight = new Map<string, Rational>();
  for (const group of groups) {
    const contribution = group.weight
      .pow(activeCount)
      .subtract(low.pow(activeCount))
      .divide(new Rational(BigInt(activeCount)))
      .divide(activeProduct);
    cumulative = cumulative.add(contribution);
    probabilityByWeight.set(`${group.weight.numerator}/${group.weight.denominator}`, cumulative);
    for (let index = 0; index < group.count; index += 1)
      activeProduct = activeProduct.divide(group.weight);
    activeCount -= group.count;
    low = group.weight;
  }
  return positive.map(
    (weight) =>
      probabilityByWeight.get(`${weight.numerator}/${weight.denominator}`) ?? Rational.zero,
  );
}
