/**
 * Reads the output of `npm pack --json` across npm versions.
 *
 * npm 11 and earlier print an array of pack results. npm 12 prints an object keyed by package
 * name. The release asset `npm-pack.json` keeps the array form; the workflows normalize to it.
 */
export function npmPackResults(output: string): unknown[] {
  const parsed = JSON.parse(output.replace(/^\uFEFF/u, '')) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const values = Object.values(parsed);
    if (
      values.length > 0 &&
      values.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))
    ) {
      return values;
    }
  }
  throw new Error('npm pack --json returned neither an array nor an object of pack results');
}
