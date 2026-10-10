import { createHash, randomUUID } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Locale-independent total ordering over JavaScript UTF-16 code units. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    // Filling the copy directly avoids an entry array per member; a plain object lists integer
    // keys first and the rest in insertion (here code unit) order, the same as before.
    const copy: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(object).sort(compareCodeUnits)) {
      const member = object[key];
      if (member === undefined) continue;
      if (key === '__proto__')
        Object.defineProperty(copy, key, {
          value: canonicalize(member),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else copy[key] = canonicalize(member);
    }
    return copy;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}_${hashCanonical(value).slice(0, 24)}`;
}

export function secureId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
