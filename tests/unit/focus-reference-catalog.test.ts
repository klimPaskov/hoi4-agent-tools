import { describe, expect, it } from 'vitest';
import { referenceCatalogSet } from '../../src/hoi4_agent_tools/focus/model.js';

describe('focus reference catalog sets', () => {
  it('converts a catalog array once and hands back the same set afterwards', () => {
    const identifiers = ['one', 'two', 'three'];
    const first = referenceCatalogSet(identifiers);
    expect(first).toEqual(new Set(identifiers));
    expect(referenceCatalogSet(identifiers)).toBe(first);
    // Another array with the same content is another catalog.
    expect(referenceCatalogSet([...identifiers])).not.toBe(first);
  });

  it('passes a set through and leaves a missing kind missing', () => {
    const set = new Set(['one']);
    expect(referenceCatalogSet(set)).toBe(set);
    expect(referenceCatalogSet(undefined)).toBeUndefined();
  });
});
