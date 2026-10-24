import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { reliefGeography } from './relief-fixture.js';

/**
 * A project-owned, invented world for the climate and biome stage: the relief fixture (a wall
 * with gates, a spine, a ring, a scarp, two volcanoes, lakes, rivers) with a westerly climate, a
 * fertile heartland east of the wall with declared terrain shares and a city style, a forest, a
 * desert in the lee of the spine, a marsh at the delta, a frozen bay in the north quarter, a shelf
 * sea and a fjord. Its geometry stays inside the relief fixture's coast, so it resolves without
 * errors at 2,048 by 1,024 pixels and larger.
 */
export function climateGeography(): GeographyModelInput {
  const model = reliefGeography();
  model.name = 'Climate test world';
  model.climate = {
    windFrom: 270,
    temperature: { warm: 27, cold: -18 },
    warmBandY: 0.62,
    rainScale: 1.1,
    seasonality: 0.55,
  };
  model.seas = [
    {
      id: 'main_sea',
      name: 'Main Sea',
      polygons: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    },
    {
      id: 'frozen_bay',
      name: 'Frozen Bay',
      ice: 0.85,
      polygons: [
        [
          [0.3, 0.02],
          [0.62, 0.02],
          [0.62, 0.11],
          [0.3, 0.11],
        ],
      ],
    },
    {
      id: 'southern_shelf',
      name: 'Southern Shelf',
      depthClass: 'shelf',
      polygons: [
        [
          [0.3, 0.9],
          [0.58, 0.9],
          [0.58, 0.99],
          [0.3, 0.99],
        ],
      ],
    },
    {
      id: 'deep_trench',
      name: 'Deep Trench',
      depthClass: 'abyss',
      polygons: [
        [
          [0.02, 0.4],
          [0.07, 0.4],
          [0.07, 0.6],
          [0.02, 0.6],
        ],
      ],
    },
  ];
  model.regions = [
    {
      id: 'heartland',
      name: 'Heartland',
      cityStyle: 1,
      terrain: { plains: 0.55, forest: 0.3, hills: 0.1, desert: 0 },
      polygons: [
        [
          [0.53, 0.38],
          [0.625, 0.36],
          [0.625, 0.68],
          [0.53, 0.7],
        ],
      ],
    },
  ];
  model.biomes = [
    {
      id: 'heartland_fields',
      kind: 'plains',
      fertility: 0.9,
      z: 1,
      polygons: [
        [
          [0.54, 0.42],
          [0.6, 0.41],
          [0.6, 0.55],
          [0.54, 0.56],
        ],
      ],
    },
    {
      id: 'old_wood',
      kind: 'forest',
      density: 0.85,
      polygons: [
        [
          [0.14, 0.62],
          [0.22, 0.6],
          [0.24, 0.74],
          [0.16, 0.76],
        ],
      ],
    },
    {
      id: 'red_waste',
      kind: 'desert',
      polygons: [
        [
          [0.36, 0.7],
          [0.46, 0.7],
          [0.46, 0.8],
          [0.36, 0.8],
        ],
      ],
    },
    {
      id: 'delta_marsh',
      kind: 'marsh',
      polygons: [
        [
          [0.56, 0.74],
          [0.64, 0.74],
          [0.64, 0.8],
          [0.56, 0.8],
        ],
      ],
    },
    {
      id: 'cold_lands',
      kind: 'ice',
      polygons: [
        [
          [0.34, 0.15],
          [0.5, 0.14],
          [0.5, 0.2],
          [0.34, 0.2],
        ],
      ],
    },
  ];
  return model;
}
