import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';

/** Frame used by the fixture: wide enough that the default 192 pixel edge band stays narrow. */
export const GEOGRAPHY_FIXTURE_FRAME: { width: number; height: number } = {
  width: 4096,
  height: 2048,
};

/**
 * A project-owned, invented world of one continent, one island, a sea, a range with a pass, a
 * volcano, a lake, two rivers, biomes, a strait, sites and a climate. It resolves without any
 * diagnostic on `GEOGRAPHY_FIXTURE_FRAME`, so tests can break one thing at a time.
 */
export function syntheticGeography(): GeographyModelInput {
  return {
    version: 1,
    name: 'Synthetic test world',
    seas: [
      {
        id: 'azure_sea',
        name: 'Azure Sea',
        depthClass: 'open',
        polygons: [
          [
            [0.6, 0.1],
            [0.95, 0.1],
            [0.95, 0.9],
            [0.6, 0.9],
          ],
        ],
        holes: [
          [
            [0.7, 0.33],
            [0.87, 0.28],
            [0.92, 0.5],
            [0.76, 0.6],
          ],
        ],
      },
    ],
    lands: [
      {
        id: 'aldoria',
        name: 'Aldoria',
        kind: 'continent',
        polygons: [
          [
            [0.15, 0.2],
            [0.55, 0.15],
            [0.6, 0.5],
            [0.5, 0.8],
            [0.2, 0.75],
            [0.1, 0.45],
          ],
        ],
      },
      {
        id: 'brim',
        name: 'Brim',
        kind: 'island',
        polygons: [
          [
            [0.72, 0.35],
            [0.85, 0.3],
            [0.9, 0.5],
            [0.78, 0.58],
          ],
        ],
      },
    ],
    regions: [
      {
        id: 'old_realm',
        name: 'Old Realm',
        polygons: [
          [
            [0.05, 0.1],
            [0.65, 0.1],
            [0.65, 0.85],
            [0.05, 0.85],
          ],
        ],
      },
    ],
    ranges: [
      {
        id: 'spine',
        name: 'The Spine',
        path: [
          [0.25, 0.3],
          [0.35, 0.4],
          [0.4, 0.55],
          [0.35, 0.68],
        ],
        halfWidth: 0.02,
        peak: 0.9,
        barrier: 'impassable',
      },
    ],
    passes: [{ id: 'spine_gap', name: 'Spine Gap', range: 'spine', at: 0.5, fort: 2 }],
    volcanoes: [
      {
        id: 'ember',
        name: 'Mount Ember',
        at: [0.45, 0.35],
        radius: 0.03,
        peak: 0.95,
        active: true,
      },
    ],
    lakes: [
      {
        id: 'mirror',
        name: 'Lake Mirror',
        center: [0.3, 0.55],
        radius: 0.02,
        outflow: 'silver',
      },
    ],
    rivers: [
      {
        id: 'silver',
        name: 'Silver River',
        source: { lake: 'mirror' },
        via: [[0.45, 0.5]],
        mouth: [0.62, 0.45],
        size: 4,
      },
      { id: 'tribute', source: [0.4, 0.25], mouth: { river: 'silver' }, size: 2 },
    ],
    biomes: [
      {
        id: 'old_forest',
        kind: 'forest',
        density: 0.8,
        polygons: [
          [
            [0.15, 0.25],
            [0.3, 0.22],
            [0.3, 0.4],
            [0.16, 0.42],
          ],
        ],
      },
      {
        id: 'red_waste',
        kind: 'desert',
        polygons: [
          [
            [0.4, 0.6],
            [0.5, 0.62],
            [0.48, 0.74],
            [0.38, 0.72],
          ],
        ],
      },
      {
        id: 'golden_fields',
        kind: 'farmland',
        fertility: 0.9,
        z: 1,
        polygons: [
          [
            [0.2, 0.3],
            [0.28, 0.28],
            [0.28, 0.38],
            [0.2, 0.4],
          ],
        ],
      },
    ],
    straits: [
      { id: 'brim_strait', name: 'Brim Strait', between: [{ land: 'aldoria' }, { land: 'brim' }] },
    ],
    sites: [
      {
        id: 'aldor',
        name: 'Aldor',
        kind: 'capital',
        at: [0.3, 0.35],
        importance: 5,
        country: 'ALD',
      },
      { id: 'brim_port', name: 'Brim Port', kind: 'port', at: [0.74, 0.42], importance: 2 },
    ],
    climate: { windFrom: 270, rainScale: 1.2 },
  };
}
