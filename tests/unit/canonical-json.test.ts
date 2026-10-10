import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, compareCodeUnits } from '../../src/hoi4_agent_tools/core/canonical.js';

/** The canonical copy as it was built from entry arrays: the reference the loop must equal. */
function reference(value: unknown): string {
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item))
        throw new TypeError('Canonical JSON cannot contain non-finite numbers');
      return Object.is(item, -0) ? 0 : item;
    }
    if (Array.isArray(item)) return item.map(copy);
    if (typeof item === 'object') {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort(compareCodeUnits)
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, copy(object[key])]),
      );
    }
    throw new TypeError(`Canonical JSON cannot contain ${typeof item}`);
  };
  return JSON.stringify(copy(value));
}

function outcome(action: () => string): { text: string } | { error: string } {
  try {
    return { text: action() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Keys that sort differently by code unit and by locale, that collide with prototype names,
// and that need escaping.
const keys = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom('__proto__', 'constructor', 'é', 'é', 'Z', 'a', '10', '9', '"', '\\', ' '),
);

const values = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.string({ maxLength: 12 }),
    fc.double({ noNaN: false }),
    fc.integer(),
    fc.constantFrom(-0, 0, 1e21, 1e-7, Number.MAX_VALUE, Number.MIN_VALUE),
    fc.constant(undefined),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(keys, tie('value'), { maxKeys: 5 }),
  ),
}));

describe('canonical JSON serialization', () => {
  it('matches the canonical copy it replaces for arbitrary values, including every error', () => {
    fc.assert(
      fc.property(values.value, (value) => {
        expect(outcome(() => canonicalJson(value))).toEqual(outcome(() => reference(value)));
      }),
      { numRuns: 4000 },
    );
  });

  it('orders keys by code unit, drops undefined members and writes negative zero as zero', () => {
    expect(canonicalJson({ b: 1, a: [true, -0], é: 'x', Z: null, c: undefined })).toBe(
      '{"Z":null,"a":[true,0],"b":1,"é":"x"}',
    );
  });

  it('lists integer keys first in numeric order, as hashes recorded earlier assume', () => {
    const value = { b: 1, '10': 2, a: 3, '9': 4, '': 5, '4294967295': 6, '01': 7 };
    expect(canonicalJson(value)).toBe(reference(value));
    expect(canonicalJson(value)).toBe('{"9":4,"10":2,"":5,"01":7,"4294967295":6,"a":3,"b":1}');
  });

  it('serializes array holes as null like JSON does and rejects values JSON cannot hold', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([1, , 3])).toBe(reference([1, , 3]));
    expect(() => canonicalJson([undefined])).toThrowError(/undefined/u);
    expect(() => canonicalJson({ nested: { value: Number.NaN } })).toThrowError(/non-finite/u);
    expect(() => canonicalJson(() => 1)).toThrowError(/function/u);
    expect(() => canonicalJson(BigInt(1))).toThrowError(/bigint/u);
  });
});
