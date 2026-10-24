import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';

/**
 * A project-owned, invented world shaped like a large fantasy map for relief and hydrology tests: one
 * continent with a wall range that has gates, a long ridge with spurs and a snow line, a ring
 * massif, an escarpment, two volcanoes, a lake with an outflow, a river with two tributaries, a
 * delta river, a plateau and a chasm. It carries no biome or climate, which later stages own.
 * The frame is 2:1; it resolves without errors at 2,048 by 1,024 pixels and larger.
 */
export function reliefGeography(): GeographyModelInput {
  return {
    version: 1,
    name: 'Relief test world',
    seas: [
      {
        id: 'main_sea',
        name: 'Main Sea',
        polygons: [
          [
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 1.0],
            [0.0, 1.0],
          ],
        ],
      },
    ],
    lands: [
      {
        id: 'mainland',
        name: 'Mainland',
        kind: 'continent',
        elevationBase: 0.15,
        coastDetail: 0.6,
        polygons: [
          [
            [0.12, 0.3],
            [0.18, 0.2],
            [0.3, 0.14],
            [0.42, 0.12],
            [0.52, 0.17],
            [0.6, 0.13],
            [0.72, 0.18],
            [0.83, 0.26],
            [0.88, 0.38],
            [0.84, 0.5],
            [0.88, 0.62],
            [0.8, 0.74],
            [0.68, 0.82],
            [0.56, 0.86],
            [0.44, 0.8],
            [0.34, 0.86],
            [0.22, 0.8],
            [0.14, 0.68],
            [0.1, 0.52],
            [0.14, 0.4],
          ],
        ],
      },
      {
        id: 'southern_isle',
        name: 'Southern Isle',
        kind: 'island',
        polygons: [
          [
            [0.62, 0.9],
            [0.7, 0.89],
            [0.71, 0.925],
            [0.64, 0.93],
          ],
        ],
      },
    ],
    ranges: [
      {
        id: 'great_wall',
        name: 'The Great Wall',
        profile: 'wall',
        barrier: 'impassable',
        path: [
          [0.5, 0.2],
          [0.52, 0.35],
          [0.5, 0.5],
          [0.48, 0.65],
          [0.5, 0.78],
        ],
        halfWidth: 0.008,
        peak: 0.9,
      },
      {
        id: 'spine',
        name: 'The Spine',
        profile: 'ridge',
        path: [
          [0.22, 0.3],
          [0.28, 0.42],
          [0.26, 0.56],
          [0.32, 0.68],
        ],
        halfWidth: 0.02,
        peak: 0.8,
        asymmetry: 0.4,
        snowline: 0.65,
        spurs: 0.7,
      },
      {
        id: 'ring',
        name: 'The Ring',
        profile: 'massif',
        closed: true,
        path: [
          [0.77, 0.5],
          [0.749, 0.599],
          [0.7, 0.64],
          [0.651, 0.599],
          [0.63, 0.5],
          [0.651, 0.401],
          [0.7, 0.36],
          [0.749, 0.401],
        ],
        halfWidth: 0.015,
        peak: 0.55,
      },
      {
        id: 'scarp',
        name: 'The Scarp',
        profile: 'escarpment',
        path: [
          [0.62, 0.22],
          [0.71, 0.25],
          [0.8, 0.3],
        ],
        halfWidth: 0.018,
        peak: 0.5,
        asymmetry: 0.6,
      },
      {
        id: 'north_range',
        name: 'North Range',
        path: [
          [0.3, 0.2],
          [0.38, 0.19],
          [0.46, 0.18],
        ],
        halfWidth: 0.014,
        peak: 0.45,
      },
    ],
    passes: [
      { id: 'gate_north', range: 'great_wall', at: 0.25, width: 0.006, depth: 0.85, fort: 5 },
      { id: 'gate_middle', range: 'great_wall', at: 0.5, width: 0.006, depth: 0.85, fort: 5 },
      { id: 'gate_south', range: 'great_wall', at: 0.75, width: 0.006, depth: 0.85, fort: 5 },
      { id: 'spine_gap', range: 'spine', at: 0.55, width: 0.01, depth: 0.6 },
    ],
    volcanoes: [
      {
        id: 'ember',
        name: 'Mount Ember',
        at: [0.38, 0.52],
        radius: 0.03,
        crater: 0.006,
        peak: 0.95,
        active: true,
      },
      { id: 'cinder', name: 'Cinder Cone', at: [0.66, 0.72], radius: 0.015, peak: 0.7 },
    ],
    plateaus: [
      {
        id: 'high_steppe',
        name: 'High Steppe',
        height: 0.25,
        edge: 'ramp',
        polygons: [
          [
            [0.12, 0.42],
            [0.19, 0.4],
            [0.2, 0.55],
            [0.13, 0.58],
          ],
        ],
      },
      {
        id: 'abyss',
        name: 'The Abyss',
        height: 0,
        edge: 'cliff',
        polygons: [
          [
            [0.74, 0.66],
            [0.8, 0.67],
            [0.79, 0.73],
            [0.73, 0.72],
          ],
        ],
      },
    ],
    lakes: [
      {
        id: 'mirror',
        name: 'Lake Mirror',
        center: [0.4, 0.72],
        radius: 0.025,
        outflow: 'lake_out',
      },
      { id: 'tarn', name: 'The Tarn', center: [0.3, 0.33], radius: 0.008 },
    ],
    rivers: [
      {
        id: 'longwater',
        name: 'Longwater',
        source: [0.3, 0.45],
        via: [
          [0.34, 0.6],
          [0.42, 0.62],
        ],
        mouth: { sea: 'main_sea' },
        size: 5,
      },
      {
        id: 'tribute_a',
        name: 'Northern Brook',
        source: [0.4, 0.4],
        mouth: { river: 'longwater' },
        size: 2,
      },
      {
        id: 'tribute_b',
        name: 'Eastern Brook',
        source: [0.47, 0.52],
        mouth: { river: 'longwater' },
        size: 2,
      },
      {
        id: 'delta_river',
        name: 'Delta River',
        source: [0.58, 0.3],
        via: [[0.58, 0.5]],
        mouth: { sea: 'main_sea' },
        size: 4,
        delta: true,
      },
      {
        id: 'lake_out',
        name: 'Mirror Outflow',
        source: { lake: 'mirror' },
        mouth: { sea: 'main_sea' },
        size: 3,
      },
    ],
  };
}
