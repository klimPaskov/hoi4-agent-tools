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
    const copy: Record<string, JsonValue> = {};
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

/**
 * UTF-8 byte length of `canonicalJson(value)`, or `undefined` as soon as it would exceed
 * `limit`. The value is measured without building the string, so a caller can decline output
 * that would exceed a JavaScript string or an artifact ceiling before allocating it.
 */
export function canonicalJsonByteLength(value: unknown, limit: number): number | undefined {
  let total = 0;
  const add = (bytes: number): boolean => (total += bytes) <= limit;
  const visit = (current: unknown): boolean => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return add(Buffer.byteLength(JSON.stringify(current)));
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current))
        throw new TypeError('Canonical JSON cannot contain non-finite numbers');
      return add(Buffer.byteLength(JSON.stringify(Object.is(current, -0) ? 0 : current)));
    }
    if (Array.isArray(current)) {
      if (!add(2 + Math.max(0, current.length - 1))) return false;
      for (let index = 0; index < current.length; index += 1) {
        // A hole stays a hole in the canonical copy, which JSON writes as null.
        if (!(index in current) ? !add(4) : !visit(current[index])) return false;
      }
      return true;
    }
    if (typeof current === 'object') {
      const object = current as Record<string, unknown>;
      const keys = Object.keys(object).filter((key) => object[key] !== undefined);
      if (!add(2 + Math.max(0, keys.length - 1))) return false;
      for (const key of keys) {
        if (!add(Buffer.byteLength(JSON.stringify(key)) + 1) || !visit(object[key])) return false;
      }
      return true;
    }
    throw new TypeError(`Canonical JSON cannot contain ${typeof current}`);
  };
  return visit(value) ? total : undefined;
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
