/**
 * Share allocation (ADR 0057): give each item (a map cell) one of K categories so that the
 * categories' shares of the total weight match a target, while following each item's own scores
 * as closely as possible. This is how a region's declared terrain shares are met without painting
 * them in blobs: the boundary between two categories runs where the climate changes most, and a
 * category moves outward or inward only as far as its share needs. A bias per category is moved
 * toward the missing share for a bounded number of rounds (deterministic, ties to the lower
 * category).
 */
export interface AllocationInput {
  /** Number of items. */
  readonly count: number;
  /** Number of categories. */
  readonly categories: number;
  /** `count * categories` scores; higher wins. */
  readonly scores: Float32Array;
  /** Target share of the weight per category; zero excludes the category. Need not sum to one. */
  readonly targets: Readonly<ArrayLike<number>>;
  /** Weight of each item; one when absent. */
  readonly weights?: Float32Array | undefined;
  readonly rounds?: number;
}

export interface AllocationResult {
  readonly assignment: Uint8Array;
  /** Achieved share of the weight per category. */
  readonly achieved: Float64Array;
  /** Largest absolute difference between a target share (normalised) and the achieved share. */
  readonly error: number;
}

const BIAS_LIMIT = 4;

function assign(
  input: AllocationInput,
  allowed: readonly number[],
  bias: Float64Array,
  assignment: Uint8Array,
  shares: Float64Array,
): void {
  const { count, categories, scores, weights } = input;
  shares.fill(0);
  let total = 0;
  for (let item = 0; item < count; item += 1) {
    let best = allowed[0]!;
    let bestScore = -Infinity;
    const base = item * categories;
    for (const category of allowed) {
      const value = scores[base + category]! + bias[category]!;
      if (value > bestScore) {
        bestScore = value;
        best = category;
      }
    }
    assignment[item] = best;
    const weight = weights === undefined ? 1 : weights[item]!;
    shares[best]! += weight;
    total += weight;
  }
  if (total > 0) for (const category of allowed) shares[category]! /= total;
}

/** Allocate; categories with a target of zero (or less) are never chosen. */
export function allocateShares(input: AllocationInput): AllocationResult {
  const { categories, targets } = input;
  const allowed: number[] = [];
  let targetSum = 0;
  for (let category = 0; category < categories; category += 1)
    if ((targets[category] ?? 0) > 0) {
      allowed.push(category);
      targetSum += targets[category]!;
    }
  const assignment = new Uint8Array(input.count);
  const shares = new Float64Array(categories);
  if (allowed.length === 0 || input.count === 0 || targetSum <= 0)
    return { assignment, achieved: shares, error: 0 };
  const wanted = new Float64Array(categories);
  for (const category of allowed) wanted[category] = targets[category]! / targetSum;
  const bias = new Float64Array(categories);
  let bestBias = new Float64Array(categories);
  let bestError = Infinity;
  const rounds = input.rounds ?? 28;
  let gain = 2.5;
  for (let round = 0; round <= rounds; round += 1) {
    assign(input, allowed, bias, assignment, shares);
    let error = 0;
    for (const category of allowed) {
      const miss = Math.abs(wanted[category]! - shares[category]!);
      if (miss > error) error = miss;
    }
    if (error < bestError) {
      bestError = error;
      bestBias = Float64Array.from(bias);
    }
    if (error < 0.002) break;
    for (const category of allowed) {
      const next = bias[category]! + gain * (wanted[category]! - shares[category]!);
      bias[category] = next < -BIAS_LIMIT ? -BIAS_LIMIT : next > BIAS_LIMIT ? BIAS_LIMIT : next;
    }
    gain *= 0.93;
  }
  assign(input, allowed, bestBias, assignment, shares);
  return { assignment, achieved: shares, error: bestError };
}
