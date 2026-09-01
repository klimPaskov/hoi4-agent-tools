import { describe, expect, it } from 'vitest';
import { compactManagedHeap } from '../../src/hoi4_agent_tools/core/managed-heap.js';

describe('managed heap maintenance', () => {
  it('performs a best-effort collection without requiring launcher flags', () => {
    expect(() => compactManagedHeap()).not.toThrow();
    expect(compactManagedHeap()).toBe(true);
  });
});
