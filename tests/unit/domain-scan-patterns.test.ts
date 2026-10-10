import { describe, expect, it } from 'vitest';
import {
  exactChangedFilePatterns,
  mapChangeScanPatterns,
} from '../../src/hoi4_agent_tools/core/domain-scan-patterns.js';

describe('post-write scan patterns', () => {
  it('scans exactly the changed files for an ordinary rewrite', () => {
    expect(exactChangedFilePatterns(['events/a.txt', './common\\b.txt'])).toEqual([
      'common/b.txt',
      'events/a.txt',
    ]);
  });

  it('adds the province definitions to a map rewrite so listed provinces resolve', () => {
    const patterns = mapChangeScanPatterns(['history/states/21-STATE_21.txt']);
    // A state file lists provinces that map/definition.csv, usually the base game's, defines.
    expect(patterns).toEqual(
      expect.arrayContaining(['history/states/21-STATE_21.txt', 'map/default.map', 'map/*.csv']),
    );
  });
});
