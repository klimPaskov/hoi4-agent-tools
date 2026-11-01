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

  it('leaves the large binary files of a world out of the scan after a map rewrite', () => {
    const patterns = mapChangeScanPatterns([
      'map/provinces.bmp',
      'map/heightmap.bmp',
      'map/terrain/colormap_rgb_cityemissivemask_a.dds',
      'gfx/flags/AAA.TGA',
      'history/states/21-STATE_21.txt',
      'map/definition.csv',
    ]);
    expect(patterns).toEqual(
      expect.arrayContaining(['history/states/21-STATE_21.txt', 'map/definition.csv']),
    );
    expect(patterns.filter((pattern) => /\.(?:bmp|dds|tga)$/iu.test(pattern))).toEqual([]);
  });

  it('adds the province definitions to a map rewrite so listed provinces resolve', () => {
    const patterns = mapChangeScanPatterns(['history/states/21-STATE_21.txt']);
    // A state file lists provinces that map/definition.csv, usually the base game's, defines.
    expect(patterns).toEqual(
      expect.arrayContaining(['history/states/21-STATE_21.txt', 'map/default.map', 'map/*.csv']),
    );
  });
});
