import { isDeepStrictEqual } from 'node:util';
import type { Assertion } from './schema.js';

/** What a case's assertions read: the structured content plus the call's own facts. */
export interface ObservedCall {
  structured: unknown;
  text: string;
  isError: boolean;
  structuredBytes: number;
  milliseconds: number;
}

type Segment = { key: string } | { index: number } | { every: true } | { deep: true };

function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  for (const part of path.split('.')) {
    if (part === '**') {
      segments.push({ deep: true });
      continue;
    }
    const match = /^([^[\]]*)((?:\[(?:\*|[0-9]+)\])*)$/u.exec(part);
    if (match === null) throw new Error(`Unreadable path segment "${part}" in ${path}`);
    if (match[1] !== '') segments.push({ key: match[1]! });
    for (const bracket of match[2]!.matchAll(/\[(\*|[0-9]+)\]/gu))
      segments.push(bracket[1] === '*' ? { every: true } : { index: Number(bracket[1]) });
  }
  return segments;
}

function descendants(value: unknown): unknown[] {
  const found: unknown[] = [value];
  if (Array.isArray(value)) for (const item of value) found.push(...descendants(item));
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) found.push(...descendants(item));
  return found;
}

/**
 * Every value a path reaches. A path without `[*]` or `**` reaches at most one value; a missing
 * key reaches none, which `exists: false` and `excludes` read as success.
 */
export function resolvePath(root: unknown, path: string): { values: unknown[]; many: boolean } {
  const segments = parsePath(path);
  let current: unknown[] = [root];
  let many = false;
  for (const segment of segments) {
    const next: unknown[] = [];
    if ('deep' in segment) {
      many = true;
      for (const value of current) next.push(...descendants(value));
    } else if ('every' in segment) {
      many = true;
      for (const value of current) if (Array.isArray(value)) next.push(...(value as unknown[]));
    } else if ('index' in segment) {
      for (const value of current)
        if (Array.isArray(value) && segment.index < value.length) next.push(value[segment.index]);
    } else {
      for (const value of current)
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (Object.hasOwn(record, segment.key)) next.push(record[segment.key]);
        }
    }
    current = next;
  }
  return { values: current, many };
}

function contains(container: unknown, expected: unknown): boolean {
  if (typeof container === 'string' && typeof expected === 'string')
    return container.includes(expected);
  if (Array.isArray(container)) return container.some((item) => isDeepStrictEqual(item, expected));
  return isDeepStrictEqual(container, expected);
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Null when the assertion holds, otherwise why it does not. */
export function checkAssertion(assertion: Assertion, call: ObservedCall): string | null {
  const special: Record<string, unknown> = {
    $text: call.text,
    $bytes: call.structuredBytes,
    $isError: call.isError,
    $ms: call.milliseconds,
  };
  const { values, many } = Object.hasOwn(special, assertion.path)
    ? { values: [special[assertion.path]], many: false }
    : resolvePath(call.structured, assertion.path);
  const where = assertion.path;
  if (assertion.exists !== undefined) {
    const present = values.length > 0 && values.some((value) => value !== undefined);
    return present === assertion.exists
      ? null
      : `${where} ${assertion.exists ? 'is missing' : `is present (${describe(values[0])})`}`;
  }
  if ('excludes' in assertion)
    return values.some((value) => contains(value, assertion.excludes))
      ? `${where} contains ${describe(assertion.excludes)}`
      : null;
  if ('includes' in assertion)
    return values.some((value) => contains(value, assertion.includes))
      ? null
      : `${where} does not contain ${describe(assertion.includes)} (got ${describe(many ? values.slice(0, 8) : values[0])})`;
  if (values.length === 0) return `${where} is missing`;
  const value = many ? values : values[0];
  if ('equals' in assertion)
    return isDeepStrictEqual(value, assertion.equals)
      ? null
      : `${where} is ${describe(value)}, expected ${describe(assertion.equals)}`;
  if ('notEquals' in assertion)
    return isDeepStrictEqual(value, assertion.notEquals) ? `${where} is ${describe(value)}` : null;
  if (assertion.matches !== undefined) {
    const pattern = new RegExp(assertion.matches, 'u');
    return typeof value === 'string' && pattern.test(value)
      ? null
      : `${where} is ${describe(value)}, which does not match /${assertion.matches}/`;
  }
  const measured = many ? values.length : Array.isArray(value) ? value.length : value;
  if (typeof measured !== 'number') return `${where} is ${describe(value)}, not a number`;
  if (assertion.atLeast !== undefined && measured < assertion.atLeast)
    return `${where} is ${measured}, expected at least ${assertion.atLeast}`;
  if (assertion.atMost !== undefined && measured > assertion.atMost)
    return `${where} is ${measured}, expected at most ${assertion.atMost}`;
  return null;
}

/** The items under `path` whose fields all equal `where`: a sweep's false positives. */
export function matchingItems(
  root: unknown,
  path: string,
  where: Record<string, string | number | boolean | null>,
): Array<Record<string, unknown>> {
  return resolvePath(root, path)
    .values.filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
    )
    .filter((item) => Object.entries(where).every(([key, expected]) => item[key] === expected));
}
