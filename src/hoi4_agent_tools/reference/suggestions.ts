/** Near-miss identifier suggestions shared by source lookup and script checks. */

const MAX_DISTANCE = 3;

/** Levenshtein distance, cut off above three edits because larger distances are not suggested. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + Number(a[i] !== b[j])));
    if (Math.min(...next) > MAX_DISTANCE) return MAX_DISTANCE + 1;
    row = next;
  }
  return row[b.length]!;
}

/**
 * The closest candidates within three edits, nearest first. `budget` bounds the number of
 * distance computations, so a very large index cannot make a missed lookup expensive.
 */
export function nearestNames(
  target: string,
  candidates: Iterable<string>,
  options: { limit?: number; budget?: number } = {},
): string[] {
  if (target.length > 128) return [];
  let budget = options.budget ?? 20_000;
  const scored: Array<{ candidate: string; distance: number }> = [];
  for (const candidate of candidates) {
    if (candidate === target || Math.abs(candidate.length - target.length) > MAX_DISTANCE) continue;
    if (budget-- <= 0) break;
    const distance = editDistance(target, candidate);
    if (distance <= MAX_DISTANCE) scored.push({ candidate, distance });
  }
  return scored
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate, 'en'))
    .slice(0, options.limit ?? 5)
    .map(({ candidate }) => candidate);
}
