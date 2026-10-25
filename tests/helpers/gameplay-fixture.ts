import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  generateWorld,
  type GeneratedWorld,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { plainContext } from './map-appearance-world.js';

export const GAMEPLAY_WIDTH = 1_024;
export const GAMEPLAY_HEIGHT = 512;

/**
 * A project-owned, invented world for the gates, straits, ports, development and names: one
 * continent cut by an impassable wall with three gates, a narrow strait to an island, a wider one
 * to a southern isle, an inland sea behind a thin isthmus with a lake port, a fortified ridge, a
 * fertile plain, a mine, named regions, seas, a river and a bay. Everything has a name except a
 * few unnamed corners, so the placeholder count is exercised.
 */
export function gameplayGeography(): GeographyModelInput {
  return {
    version: 1,
    name: 'Gameplay test world',
    seas: [
      {
        id: 'north_sea',
        name: 'Northern Reach',
        depthClass: 'shelf',
        polygons: [
          [
            [0, 0],
            [1, 0],
            [1, 0.5],
            [0, 0.5],
          ],
        ],
      },
      {
        id: 'south_sea',
        name: 'Southern Deep',
        depthClass: 'abyss',
        polygons: [
          [
            [0, 0.5],
            [1, 0.5],
            [1, 1],
            [0, 1],
          ],
        ],
      },
    ],
    lands: [
      {
        id: 'westmark',
        name: 'Westmark',
        kind: 'continent',
        elevationBase: 0.12,
        coastDetail: 0.3,
        polygons: [
          [
            [0.12, 0.2],
            [0.3, 0.14],
            [0.48, 0.2],
            [0.48, 0.45],
            [0.44, 0.6],
            [0.48, 0.78],
            [0.4, 0.85],
            [0.3, 0.74],
            [0.22, 0.86],
            [0.12, 0.76],
            [0.08, 0.5],
          ],
        ],
      },
      {
        id: 'cinder_isle',
        name: 'Cinder Isle',
        kind: 'island',
        coastDetail: 0.3,
        polygons: [
          [
            [0.5, 0.3],
            [0.64, 0.27],
            [0.74, 0.34],
            [0.72, 0.52],
            [0.6, 0.58],
            [0.5, 0.5],
          ],
        ],
      },
      {
        id: 'south_isle',
        name: 'South Isle',
        kind: 'island',
        coastDetail: 0.3,
        polygons: [
          [
            [0.56, 0.8],
            [0.7, 0.78],
            [0.74, 0.9],
            [0.6, 0.94],
          ],
        ],
      },
    ],
    regions: [
      {
        id: 'west_marches',
        name: 'West Marches',
        polygons: [
          [
            [0.05, 0.1],
            [0.3, 0.1],
            [0.3, 0.9],
            [0.05, 0.9],
          ],
        ],
      },
      {
        id: 'east_reach',
        name: 'East Reach',
        polygons: [
          [
            [0.3, 0.1],
            [0.8, 0.1],
            [0.8, 0.62],
            [0.3, 0.62],
          ],
        ],
      },
    ],
    ranges: [
      {
        id: 'great_wall',
        name: 'Great Wall of Westmark',
        profile: 'wall',
        barrier: 'impassable',
        path: [
          [0.3, 0.14],
          [0.3, 0.3],
          [0.3, 0.5],
          [0.3, 0.7],
          [0.3, 0.76],
        ],
        halfWidth: 0.006,
        peak: 0.8,
      },
      {
        id: 'iron_ridge',
        name: 'Iron Ridge',
        profile: 'ridge',
        barrier: 'fort-line',
        path: [
          [0.36, 0.62],
          [0.42, 0.66],
          [0.46, 0.72],
        ],
        halfWidth: 0.014,
        peak: 0.7,
      },
    ],
    passes: [
      {
        id: 'north_gate',
        name: 'North Gate',
        range: 'great_wall',
        at: 0.22,
        width: 0.012,
        depth: 0.9,
        fort: 5,
      },
      {
        id: 'middle_gate',
        name: 'Middle Gate',
        range: 'great_wall',
        at: 0.55,
        width: 0.012,
        depth: 0.9,
        fort: 5,
      },
      {
        id: 'south_gate',
        name: 'South Gate',
        range: 'great_wall',
        at: 0.85,
        width: 0.012,
        depth: 0.9,
        fort: 4,
      },
      {
        id: 'ridge_gap',
        name: 'Ridge Gap',
        range: 'iron_ridge',
        at: 0.5,
        width: 0.012,
        depth: 0.6,
        fort: 2,
      },
    ],
    lakes: [
      {
        id: 'inner_sea',
        name: 'Inner Sea',
        center: [0.425, 0.36],
        radius: 0.045,
        gameplay: 'inland-sea',
        outflow: 'lake_outflow',
      },
      { id: 'tarn', name: 'The Tarn', center: [0.18, 0.4], radius: 0.014 },
    ],
    straits: [
      {
        id: 'bright_strait',
        name: 'Bright Strait',
        path: [
          [0.45, 0.4],
          [0.52, 0.4],
        ],
        rule: 'army-closed',
        width: 0.02,
      },
      {
        id: 'long_channel',
        name: 'Long Channel',
        between: [{ land: 'westmark' }, { land: 'south_isle' }],
        width: 0.01,
      },
    ],
    rivers: [
      {
        id: 'westwater',
        name: 'Westwater',
        source: [0.2, 0.3],
        mouth: { sea: 'south_sea' },
        via: [
          [0.16, 0.5],
          [0.2, 0.72],
        ],
        size: 4,
      },
      {
        id: 'lake_outflow',
        name: 'Lake Outflow',
        source: { lake: 'inner_sea' },
        mouth: { sea: 'north_sea' },
        size: 2,
      },
    ],
    sites: [
      {
        id: 'westmark_city',
        name: 'Westhold',
        kind: 'capital',
        at: [0.2, 0.55],
        importance: 5,
        country: 'AAA',
      },
      {
        id: 'lake_haven',
        name: 'Lakehaven',
        kind: 'port',
        at: [0.41, 0.455],
        importance: 3,
        lake: 'inner_sea',
      },
      { id: 'bay_town', name: 'Baytown', kind: 'port', at: [0.145, 0.75], importance: 3 },
      { id: 'iron_hill', name: 'Iron Hill', kind: 'mine', at: [0.4, 0.68], importance: 3 },
      { id: 'cinder_keep', name: 'Cinder Keep', kind: 'fortress', at: [0.62, 0.42], importance: 2 },
      { id: 'east_city', name: 'Eastgate', kind: 'city', at: [0.34, 0.2], importance: 3 },
    ],
    places: [{ id: 'bay_of_gulls', name: 'Bay of Gulls', kind: 'bay', at: [0.15, 0.79] }],
  } as unknown as GeographyModelInput;
}

export function gameplaySpec(overrides: Partial<WorldSpec> = {}): WorldSpec {
  const resolution = resolveGeography(gameplayGeography(), {
    frame: { width: GAMEPLAY_WIDTH, height: GAMEPLAY_HEIGHT },
    hasReference: false,
  });
  return {
    width: GAMEPLAY_WIDTH,
    height: GAMEPLAY_HEIGHT,
    seed: 5,
    landCoverage: 0.4,
    continents: 1,
    landProvincePixels: 520,
    seaProvincePixels: 2_400,
    provincesPerState: 5,
    landProvincesPerRegion: 30,
    seaProvincesPerRegion: 6,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [
      { tag: 'AAA', name: 'Westmarkland' },
      { tag: 'BBB', name: 'Beta' },
    ],
    geography: resolution.geography,
    colormapProfile: 'calibrated',
    partition: { mode: 'feature-aware' },
    ...overrides,
  };
}

const cache = new Map<string, GeneratedWorld>();

/** One generated world per spec key; the fixture world takes a few seconds to build. */
export function gameplayWorld(key = 'default', overrides: Partial<WorldSpec> = {}): GeneratedWorld {
  let world = cache.get(key);
  if (world === undefined) {
    world = generateWorld(gameplaySpec(overrides), plainContext);
    cache.set(key, world);
  }
  return world;
}
