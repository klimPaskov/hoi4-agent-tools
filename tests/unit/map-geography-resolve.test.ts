import { describe, expect, it } from 'vitest';
import {
  GEOGRAPHY_DIAGNOSTIC_LIMIT,
  resolveGeography,
  type GeographyResolveOptions,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  geographyModelSchema,
  type GeographyModelInput,
} from '../../src/hoi4_agent_tools/schemas/geography.js';
import { GEOGRAPHY_FIXTURE_FRAME, syntheticGeography } from '../helpers/geography-fixture.js';

type Mutable = Record<string, unknown[]> & GeographyModelInput;

function resolve(model: GeographyModelInput, options: Partial<GeographyResolveOptions> = {}) {
  return resolveGeography(geographyModelSchema.parse(model), {
    frame: GEOGRAPHY_FIXTURE_FRAME,
    ...options,
  });
}

function mutated(change: (model: Mutable) => void): GeographyModelInput {
  const model = structuredClone(syntheticGeography()) as Mutable;
  change(model);
  return model;
}

function codes(model: GeographyModelInput, options: Partial<GeographyResolveOptions> = {}) {
  return resolve(model, options).diagnostics.map(({ code }) => code);
}

function find(
  model: GeographyModelInput,
  code: string,
  options: Partial<GeographyResolveOptions> = {},
) {
  return resolve(model, options).diagnostics.find((diagnostic) => diagnostic.code === code);
}

const square = (x: number, y: number, size: number): Array<[number, number]> => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

describe('geography resolution', () => {
  it('resolves the synthetic world without a single diagnostic', () => {
    const result = resolve(syntheticGeography());
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.geography.featureCount).toBe(16);
    expect(result.geography.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('sorts features by id and groups them by kind', () => {
    const geography = resolve(syntheticGeography()).geography;
    expect(geography.features().map(({ kind }) => kind)).toEqual([
      'sea',
      'land',
      'land',
      'region',
      'range',
      'pass',
      'volcano',
      'river',
      'river',
      'lake',
      'biome',
      'biome',
      'biome',
      'strait',
      'site',
      'site',
    ]);
    expect(geography.features().map(({ id }) => id)).toEqual([
      'azure_sea',
      'aldoria',
      'brim',
      'old_realm',
      'spine',
      'spine_gap',
      'ember',
      'silver',
      'tribute',
      'mirror',
      'golden_fields',
      'old_forest',
      'red_waste',
      'brim_strait',
      'aldor',
      'brim_port',
    ]);
    expect(geography.lands.map(({ id }) => id)).toEqual(['aldoria', 'brim']);
    expect(geography.rivers.map(({ id }) => id)).toEqual(['silver', 'tribute']);
    expect(geography.sites.map(({ id }) => id)).toEqual(['aldor', 'brim_port']);
    // Biomes are listed by ascending priority so a consumer paints them in order.
    expect(geography.biomes.map(({ id, z }) => [id, z])).toEqual([
      ['old_forest', 0],
      ['red_waste', 0],
      ['golden_fields', 1],
    ]);
  });

  it('finds features by id and kind and refuses a kind mismatch', () => {
    const geography = resolve(syntheticGeography()).geography;
    expect(geography.find('aldoria')?.kind).toBe('land');
    expect(geography.get('land', 'aldoria')?.name).toBe('Aldoria');
    expect(geography.get('sea', 'aldoria')).toBeUndefined();
    expect(geography.find('nowhere')).toBeUndefined();
    expect(geography.list('pass').map(({ id }) => id)).toEqual(['spine_gap']);
  });

  it('derives areas in frame units and pixels', () => {
    const rectangle = resolve({
      version: 1,
      lands: [{ id: 'block', polygons: [square(0.25, 0.25, 0.5)], holes: [square(0.4, 0.4, 0.1)] }],
    });
    const land = rectangle.geography.lands[0]!;
    expect(land.area.areaFraction).toBeCloseTo(0.25 - 0.01, 12);
    expect(land.area.outers[0]!.signedArea).toBeCloseTo(0.25, 12);
    expect(land.area.holes[0]!.signedArea).toBeCloseTo(-0.01, 12);
    expect(land.area.interior.x).toBeGreaterThan(0.25);
    expect(land.area.interior.x).toBeLessThan(0.75);
    expect(rectangle.geography.surfaceAt(land.area.interior.x, land.area.interior.y).surface).toBe(
      'land',
    );
    // The hole is water: a point inside it is not land.
    expect(rectangle.geography.surfaceAt(0.45, 0.45).surface).toBe('open-water');
  });

  it('orients rings whatever order the input listed them in', () => {
    const forward = resolve({
      version: 1,
      lands: [{ id: 'a', polygons: [square(0.2, 0.2, 0.3)] }],
    });
    const reversed = resolve({
      version: 1,
      lands: [{ id: 'a', polygons: [[...square(0.2, 0.2, 0.3)].reverse()] }],
    });
    expect(forward.geography.hash).toBe(reversed.geography.hash);
    expect(reversed.geography.lands[0]!.area.outers[0]!.signedArea).toBeGreaterThan(0);
  });

  it('gives one hash for the same model in any order, with points as objects or pairs', () => {
    const base = resolve(syntheticGeography()).geography.hash;
    const shuffled = mutated((model) => {
      for (const key of ['lands', 'sites', 'biomes', 'rivers'] as const) model[key]!.reverse();
    });
    expect(resolve(shuffled).geography.hash).toBe(base);
    const objects = mutated((model) => {
      model.sites = [
        {
          id: 'aldor',
          name: 'Aldor',
          kind: 'capital',
          at: { x: 0.3, y: 0.35 },
          importance: 5,
          country: 'ALD',
        },
        {
          id: 'brim_port',
          name: 'Brim Port',
          kind: 'port',
          at: { x: 0.74, y: 0.42 },
          importance: 2,
        },
      ];
    });
    expect(resolve(objects).geography.hash).toBe(base);
    // Spelling a default out does not change the model.
    const explicit = mutated((model) => {
      (model.seas as Array<Record<string, unknown>>)[0]!.ice = 0;
      (model.volcanoes as Array<Record<string, unknown>>)[0]!.crater = 0.03 * 0.2;
    });
    expect(resolve(explicit).geography.hash).toBe(base);
  });

  it('changes the hash with the content, the frame and the climate', () => {
    const base = resolve(syntheticGeography()).geography.hash;
    const moved = mutated((model) => {
      (model.sites as Array<{ at: [number, number] }>)[0]!.at = [0.31, 0.35];
    });
    expect(resolve(moved).geography.hash).not.toBe(base);
    expect(
      resolve(syntheticGeography(), { frame: { width: 4096, height: 1024 } }).geography.hash,
    ).not.toBe(base);
    const drier = mutated((model) => {
      model.climate = { windFrom: 270, rainScale: 0.5 };
    });
    expect(resolve(drier).geography.hash).not.toBe(base);
  });

  it('returns identical diagnostics on every run', () => {
    const model = mutated((value) => {
      (value.sites as Array<{ at: [number, number] }>)[0]!.at = [0.8, 0.2];
      value.volcanoes = [{ id: 'bad', at: [0.8, 0.2], radius: 0.02 }];
    });
    expect(JSON.stringify(resolve(model).diagnostics)).toBe(
      JSON.stringify(resolve(model).diagnostics),
    );
    expect(resolve(model).diagnostics.length).toBeGreaterThan(0);
  });

  it('resolves cross-references', () => {
    const geography = resolve(syntheticGeography()).geography;
    expect(geography.get('range', 'spine')?.passIds).toEqual(['spine_gap']);
    const pass = geography.get('pass', 'spine_gap')!;
    expect(pass.rangeId).toBe('spine');
    expect(pass.width).toBe(0.006);
    expect(pass.depth).toBe(0.6);
    expect(pass.fort).toBe(2);
    // The pass sits halfway along the path by arc length, on the path itself.
    const path = geography.get('range', 'spine')!.path;
    expect(path.length).toBeGreaterThan(0);
    let nearest = Infinity;
    for (let index = 0; index + 1 < path.xs.length; index++) {
      const ax = path.xs[index]!,
        ay = path.ys[index]!,
        bx = path.xs[index + 1]!,
        by = path.ys[index + 1]!;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((pass.position.x - ax) * (bx - ax) + (pass.position.y - ay) * (by - ay)) /
            ((bx - ax) ** 2 + (by - ay) ** 2),
        ),
      );
      nearest = Math.min(
        nearest,
        Math.hypot(ax + t * (bx - ax) - pass.position.x, ay + t * (by - ay) - pass.position.y),
      );
    }
    expect(nearest).toBeLessThan(1e-9);
    expect(geography.get('river', 'silver')?.tributaryIds).toEqual(['tribute']);
    expect(geography.get('river', 'silver')?.source).toMatchObject({ type: 'lake', id: 'mirror' });
    expect(geography.get('river', 'tribute')?.mouth).toEqual({ type: 'river', id: 'silver' });
    expect(geography.get('land', 'aldoria')).toMatchObject({
      regionId: 'old_realm',
      regionSource: 'containment',
    });
    expect(geography.get('land', 'brim')?.regionId).toBeUndefined();
    expect(geography.get('region', 'old_realm')?.landIds).toEqual(['aldoria']);
    expect(geography.get('lake', 'mirror')).toMatchObject({
      landId: 'aldoria',
      outflowId: 'silver',
    });
    expect(geography.get('volcano', 'ember')?.landId).toBe('aldoria');
    expect(geography.get('site', 'aldor')).toMatchObject({
      landId: 'aldoria',
      regionId: 'old_realm',
    });
    expect(geography.get('site', 'brim_port')).toMatchObject({ landId: 'brim' });
    expect(geography.get('strait', 'brim_strait')?.between).toEqual([
      { type: 'land', id: 'aldoria' },
      { type: 'land', id: 'brim' },
    ]);
  });

  it('lets a declared region win over containment', () => {
    const geography = resolve(
      mutated((model) => {
        (model.regions as unknown[]).push({ id: 'far_east', name: 'Far East' });
        (model.lands as Array<Record<string, unknown>>)[0]!.region = 'far_east';
      }),
    ).geography;
    expect(geography.get('land', 'aldoria')).toMatchObject({
      regionId: 'far_east',
      regionSource: 'explicit',
    });
    expect(geography.get('region', 'far_east')?.landIds).toEqual(['aldoria']);
  });

  it('fills documented defaults', () => {
    const geography = resolve(syntheticGeography()).geography;
    expect(geography.get('sea', 'azure_sea')).toMatchObject({
      depthClass: 'open',
      ice: 0,
      seaKind: 'sea',
    });
    expect(geography.get('land', 'aldoria')).toMatchObject({
      elevationBase: 0.15,
      coastDetail: 0.5,
    });
    expect(geography.get('range', 'spine')).toMatchObject({
      profile: 'ridge',
      asymmetry: 0,
      spurs: 0.5,
      barrier: 'impassable',
    });
    expect(geography.get('volcano', 'ember')?.crater).toBeCloseTo(0.006, 12);
    expect(geography.get('river', 'tribute')).toMatchObject({ size: 2, delta: false });
    expect(geography.climate).toEqual({
      windFrom: 270,
      temperature: { warm: 24, cold: -10 },
      warmBandY: 0.5,
      rainScale: 1.2,
      seasonality: 0.5,
      declared: true,
    });
    expect(
      resolve({ version: 1, lands: [{ id: 'a', polygons: [square(0.2, 0.2, 0.3)] }] }).geography
        .climate.declared,
    ).toBe(false);
  });

  it('answers what lies at a point', () => {
    const geography = resolve(syntheticGeography()).geography;
    expect(geography.surfaceAt(0.3, 0.3)).toEqual({ surface: 'land', id: 'aldoria' });
    expect(geography.surfaceAt(0.3, 0.55)).toEqual({ surface: 'lake', id: 'mirror' });
    expect(geography.surfaceAt(0.65, 0.3)).toEqual({ surface: 'sea', id: 'azure_sea' });
    expect(geography.surfaceAt(0.8, 0.45)).toEqual({ surface: 'land', id: 'brim' });
    expect(geography.surfaceAt(0.02, 0.02)).toEqual({ surface: 'open-water' });
    expect(geography.landIdAt(0.8, 0.45)).toBe('brim');
    expect(geography.isLandAt(0.65, 0.3)).toBe(false);
  });

  it('sizes a disc lake as a circle on the map, whatever the aspect ratio', () => {
    for (const frame of [
      { width: 4096, height: 2048 },
      { width: 4096, height: 1024 },
    ]) {
      const lake = resolve(syntheticGeography(), { frame }).geography.get('lake', 'mirror')!;
      const pixels = lake.area.areaFraction * frame.width * frame.height;
      const radiusPixels = 0.02 * frame.width;
      expect(pixels / (Math.PI * radiusPixels ** 2)).toBeGreaterThan(0.99);
      expect(pixels / (Math.PI * radiusPixels ** 2)).toBeLessThanOrEqual(1);
    }
  });
});

describe('geography validation', () => {
  it.each([
    [
      'a duplicate id within a kind',
      mutated((m) => (m.sites as unknown[]).push({ id: 'aldor', kind: 'city', at: [0.3, 0.36] })),
      'MAP_GEOGRAPHY_ID_DUPLICATE',
    ],
    [
      'an id used by two kinds',
      mutated((m) => (m.sites as unknown[]).push({ id: 'ember', kind: 'city', at: [0.3, 0.36] })),
      'MAP_GEOGRAPHY_ID_DUPLICATE',
    ],
    [
      'a bowtie ring',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'knot',
          polygons: [
            [
              [0.7, 0.7],
              [0.8, 0.8],
              [0.8, 0.7],
              [0.7, 0.8],
            ],
          ],
        }),
      ),
      'MAP_GEOGRAPHY_RING_SELF_INTERSECTION',
    ],
    [
      'a ring with no area',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'line',
          polygons: [
            [
              [0.7, 0.7],
              [0.8, 0.7],
              [0.9, 0.7],
            ],
          ],
        }),
      ),
      'MAP_GEOGRAPHY_RING_DEGENERATE',
    ],
    [
      'overlapping polygons in one feature',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'twin',
          polygons: [square(0.7, 0.7, 0.1), square(0.75, 0.75, 0.1)],
        }),
      ),
      'MAP_GEOGRAPHY_POLYGONS_OVERLAP',
    ],
    [
      'one polygon nested in another',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'nest',
          polygons: [square(0.7, 0.7, 0.2), square(0.75, 0.75, 0.05)],
        }),
      ),
      'MAP_GEOGRAPHY_POLYGONS_OVERLAP',
    ],
    [
      'a hole outside its polygon',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'ring',
          polygons: [square(0.7, 0.7, 0.1)],
          holes: [square(0.85, 0.85, 0.05)],
        }),
      ),
      'MAP_GEOGRAPHY_HOLE_OUTSIDE',
    ],
    [
      'a hole crossing the border',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'ring',
          polygons: [square(0.7, 0.7, 0.1)],
          holes: [square(0.75, 0.75, 0.1)],
        }),
      ),
      'MAP_GEOGRAPHY_HOLE_OUTSIDE',
    ],
    [
      'a pass naming a missing range',
      mutated((m) => ((m.passes as Array<Record<string, unknown>>)[0]!.range = 'nowhere')),
      'MAP_GEOGRAPHY_REF_UNKNOWN',
    ],
    [
      'a pass naming a land as its range',
      mutated((m) => ((m.passes as Array<Record<string, unknown>>)[0]!.range = 'aldoria')),
      'MAP_GEOGRAPHY_REF_KIND',
    ],
    [
      'a land naming a missing region',
      mutated((m) => ((m.lands as Array<Record<string, unknown>>)[0]!.region = 'nowhere')),
      'MAP_GEOGRAPHY_REF_UNKNOWN',
    ],
    [
      'a river mouth naming a land as its sea',
      mutated((m) => ((m.rivers as Array<Record<string, unknown>>)[0]!.mouth = { sea: 'aldoria' })),
      'MAP_GEOGRAPHY_REF_KIND',
    ],
    [
      'a lake outflow naming a land',
      mutated((m) => ((m.lakes as Array<Record<string, unknown>>)[0]!.outflow = 'aldoria')),
      'MAP_GEOGRAPHY_REF_KIND',
    ],
    [
      'a river starting in the sea',
      mutated((m) => ((m.rivers as Array<Record<string, unknown>>)[1]!.source = [0.65, 0.3])),
      'MAP_GEOGRAPHY_RIVER_SOURCE_NOT_LAND',
    ],
    [
      'a river ending on land',
      mutated((m) => ((m.rivers as Array<Record<string, unknown>>)[0]!.mouth = [0.3, 0.65])),
      'MAP_GEOGRAPHY_RIVER_MOUTH_NOT_WATER',
    ],
    [
      'a river flowing into itself',
      mutated(
        (m) => ((m.rivers as Array<Record<string, unknown>>)[1]!.mouth = { river: 'tribute' }),
      ),
      'MAP_GEOGRAPHY_RIVER_CYCLE',
    ],
    [
      'two rivers flowing into each other',
      mutated(
        (m) => ((m.rivers as Array<Record<string, unknown>>)[0]!.mouth = { river: 'tribute' }),
      ),
      'MAP_GEOGRAPHY_RIVER_CYCLE',
    ],
    [
      'a lake with no shape',
      mutated((m) => (m.lakes as unknown[]).push({ id: 'void' })),
      'MAP_GEOGRAPHY_LAKE_SHAPE',
    ],
    [
      'a lake with both shapes',
      mutated((m) =>
        (m.lakes as unknown[]).push({
          id: 'both',
          center: [0.3, 0.3],
          radius: 0.01,
          polygons: [square(0.3, 0.3, 0.02)],
        }),
      ),
      'MAP_GEOGRAPHY_LAKE_SHAPE',
    ],
    [
      'a lake with a centre but no radius',
      mutated((m) => (m.lakes as unknown[]).push({ id: 'half', center: [0.3, 0.3] })),
      'MAP_GEOGRAPHY_LAKE_SHAPE',
    ],
    [
      'a lake in the sea',
      mutated((m) => (m.lakes as unknown[]).push({ id: 'wet', center: [0.65, 0.3], radius: 0.02 })),
      'MAP_GEOGRAPHY_LAKE_NOT_IN_LAND',
    ],
    [
      'a lake across the frame',
      mutated((m) =>
        (m.lakes as unknown[]).push({ id: 'wide', center: [0.01, 0.5], radius: 0.05 }),
      ),
      'MAP_GEOGRAPHY_LAKE_OUT_OF_FRAME',
    ],
    [
      'a lake under 60 pixels',
      mutated((m) =>
        (m.lakes as unknown[]).push({ id: 'pond', center: [0.3, 0.3], radius: 0.0003 }),
      ),
      'MAP_GEOGRAPHY_LAKE_TOO_SMALL',
    ],
    [
      'a lake whose outflow does not start at it',
      mutated((m) => ((m.lakes as Array<Record<string, unknown>>)[0]!.outflow = 'tribute')),
      'MAP_GEOGRAPHY_LAKE_OUTFLOW_MISMATCH',
    ],
    [
      'a volcano in the sea',
      mutated((m) =>
        (m.volcanoes as unknown[]).push({ id: 'drowned', at: [0.65, 0.3], radius: 0.02 }),
      ),
      'MAP_GEOGRAPHY_VOLCANO_NOT_ON_LAND',
    ],
    [
      'a crater wider than its cone',
      mutated((m) =>
        (m.volcanoes as unknown[]).push({
          id: 'wide',
          at: [0.2, 0.7],
          radius: 0.01,
          crater: 0.02,
        }),
      ),
      'MAP_GEOGRAPHY_VOLCANO_CRATER_RADIUS',
    ],
    [
      'volcanoes closer than their radius',
      mutated((m) =>
        (m.volcanoes as unknown[]).push({ id: 'twin', at: [0.46, 0.35], radius: 0.03 }),
      ),
      'MAP_GEOGRAPHY_VOLCANO_OVERLAP',
    ],
    [
      'a strait ending in the sea',
      mutated(
        (m) =>
          ((m.straits as Array<Record<string, unknown>>)[0]!.between = [
            [0.3, 0.3],
            [0.65, 0.3],
          ]),
      ),
      'MAP_GEOGRAPHY_STRAIT_ENDPOINT',
    ],
    [
      'a strait inside one land',
      mutated(
        (m) =>
          ((m.straits as Array<Record<string, unknown>>)[0]!.between = [
            [0.2, 0.3],
            [0.4, 0.3],
          ]),
      ),
      'MAP_GEOGRAPHY_STRAIT_SAME_LAND',
    ],
    [
      'a strait naming a missing land',
      mutated(
        (m) =>
          ((m.straits as Array<Record<string, unknown>>)[0]!.between = [
            { land: 'nowhere' },
            { land: 'brim' },
          ]),
      ),
      'MAP_GEOGRAPHY_REF_UNKNOWN',
    ],
    [
      'a site in the sea',
      mutated((m) => (m.sites as unknown[]).push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] })),
      'MAP_GEOGRAPHY_SITE_IN_WATER',
    ],
    [
      'a mine in a lake',
      mutated((m) => (m.sites as unknown[]).push({ id: 'pit', kind: 'mine', at: [0.3, 0.55] })),
      'MAP_GEOGRAPHY_SITE_IN_WATER',
    ],
    [
      'two sites at one position',
      mutated((m) => (m.sites as unknown[]).push({ id: 'twin', kind: 'city', at: [0.3, 0.35] })),
      'MAP_GEOGRAPHY_SITE_DUPLICATE_POSITION',
    ],
    [
      'overlapping biomes with equal priority',
      mutated((m) =>
        (m.biomes as unknown[]).push({
          id: 'dunes',
          kind: 'desert',
          polygons: [square(0.2, 0.26, 0.08)],
        }),
      ),
      'MAP_GEOGRAPHY_BIOME_CONFLICT',
    ],
    [
      'a forest in the sea',
      mutated((m) =>
        (m.biomes as unknown[]).push({
          id: 'kelp',
          kind: 'forest',
          polygons: [square(0.7, 0.15, 0.1)],
        }),
      ),
      'MAP_GEOGRAPHY_BIOME_OVER_WATER',
    ],
    [
      'a climate warmer at the cold end',
      mutated((m) => (m.climate = { temperature: { warm: 5, cold: 10 } })),
      'MAP_GEOGRAPHY_CLIMATE_TEMPERATURE_ORDER',
    ],
    [
      'an empty region',
      mutated((m) => (m.regions as unknown[]).push({ id: 'ghost' })),
      'MAP_GEOGRAPHY_REGION_EMPTY',
    ],
    [
      'overlapping lands',
      mutated((m) =>
        (m.lands as unknown[]).push({ id: 'shadow', polygons: [square(0.2, 0.3, 0.2)] }),
      ),
      'MAP_GEOGRAPHY_LAND_OVERLAP',
    ],
    [
      'a sea over land',
      mutated((m) =>
        (m.seas as unknown[]).push({ id: 'flood', polygons: [square(0.15, 0.25, 0.3)] }),
      ),
      'MAP_GEOGRAPHY_SEA_OVER_LAND',
    ],
    [
      'a repeated name',
      mutated((m) =>
        (m.sites as unknown[]).push({
          id: 'aldor_two',
          name: 'Aldor',
          kind: 'city',
          at: [0.4, 0.3],
        }),
      ),
      'MAP_GEOGRAPHY_NAME_DUPLICATE',
    ],
    [
      'two passes in one place',
      mutated((m) => (m.passes as unknown[]).push({ id: 'twin_gap', range: 'spine', at: 0.5 })),
      'MAP_GEOGRAPHY_PASS_OVERLAP',
    ],
    [
      'a range lying in the sea',
      mutated((m) =>
        (m.ranges as unknown[]).push({
          id: 'reef',
          path: [
            [0.7, 0.15],
            [0.8, 0.2],
            [0.9, 0.15],
          ],
        }),
      ),
      'MAP_GEOGRAPHY_RANGE_ON_WATER',
    ],
    [
      'a range crossing itself',
      mutated((m) =>
        (m.ranges as unknown[]).push({
          id: 'knot',
          path: [
            [0.2, 0.2],
            [0.4, 0.4],
            [0.4, 0.2],
            [0.2, 0.4],
          ],
        }),
      ),
      'MAP_GEOGRAPHY_PATH_SELF_INTERSECTION',
    ],
    [
      'a range with a single distinct vertex',
      mutated((m) =>
        (m.ranges as unknown[]).push({
          id: 'dot',
          path: [
            [0.3, 0.3],
            [0.3, 0.3],
          ],
        }),
      ),
      'MAP_GEOGRAPHY_PATH_DEGENERATE',
    ],
    [
      'a closing vertex repeated',
      mutated((m) =>
        (m.lands as unknown[]).push({
          id: 'closed',
          polygons: [[...square(0.7, 0.7, 0.1), [0.7, 0.7]]],
        }),
      ),
      'MAP_GEOGRAPHY_RING_DUPLICATE_VERTEX',
    ],
    [
      'holes without polygons in a region',
      mutated((m) =>
        (m.regions as unknown[]).push({ id: 'holey', holes: [square(0.7, 0.7, 0.1)] }),
      ),
      'MAP_GEOGRAPHY_HOLES_WITHOUT_POLYGONS',
    ],
  ])('reports %s', (_label, model, code) => {
    expect(codes(model)).toContain(code);
  });

  it('marks errors as errors and the rest as warnings', () => {
    const severityOf = (model: GeographyModelInput, code: string) => find(model, code)?.severity;
    expect(
      severityOf(
        mutated((m) => (m.sites as unknown[]).push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] })),
        'MAP_GEOGRAPHY_SITE_IN_WATER',
      ),
    ).toBe('error');
    expect(
      severityOf(
        mutated((m) => (m.regions as unknown[]).push({ id: 'ghost' })),
        'MAP_GEOGRAPHY_REGION_EMPTY',
      ),
    ).toBe('warning');
    expect(
      resolve(
        mutated((m) => (m.sites as unknown[]).push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] })),
      ).valid,
    ).toBe(false);
    expect(resolve(mutated((m) => (m.regions as unknown[]).push({ id: 'ghost' }))).valid).toBe(
      true,
    );
  });

  it('names the feature at fault in every diagnostic', () => {
    const result = resolve(
      mutated((m) => {
        (m.sites as unknown[]).push({ id: 'buoy', kind: 'port', at: [0.65, 0.3] });
        (m.volcanoes as unknown[]).push({ id: 'drowned', at: [0.65, 0.3], radius: 0.02 });
      }),
    );
    const named = result.diagnostics.filter(({ severity }) => severity === 'error');
    expect(named.map(({ details }) => details?.featureId)).toEqual(['buoy', 'drowned']);
    expect(result.diagnostics.every(({ category }) => category === 'map')).toBe(true);
  });

  it('allows ice and marsh over water but not other biomes', () => {
    const ice = mutated((m) =>
      (m.biomes as unknown[]).push({
        id: 'pack',
        kind: 'ice',
        polygons: [square(0.7, 0.15, 0.1)],
      }),
    );
    expect(codes(ice)).not.toContain('MAP_GEOGRAPHY_BIOME_OVER_WATER');
  });

  it('accepts biomes that overlap with different priority or the same kind', () => {
    const layered = mutated((m) =>
      (m.biomes as unknown[]).push({
        id: 'glade',
        kind: 'plains',
        z: 2,
        polygons: [square(0.2, 0.3, 0.05)],
      }),
    );
    expect(codes(layered)).not.toContain('MAP_GEOGRAPHY_BIOME_CONFLICT');
    const same = mutated((m) =>
      (m.biomes as unknown[]).push({
        id: 'more_forest',
        kind: 'forest',
        polygons: [square(0.2, 0.26, 0.08)],
      }),
    );
    expect(codes(same)).not.toContain('MAP_GEOGRAPHY_BIOME_CONFLICT');
  });

  it('keeps a river mouth on the frame edge legal', () => {
    const edge = mutated(
      (m) => ((m.rivers as Array<Record<string, unknown>>)[1]!.mouth = [0.1, 0]),
    );
    expect(codes(edge)).not.toContain('MAP_GEOGRAPHY_RIVER_MOUTH_NOT_WATER');
  });

  it('requires land unless a reference image supplies the coast', () => {
    const noLand = {
      version: 1 as const,
      seas: [{ id: 'all', polygons: [square(0.2, 0.2, 0.5)] }],
    };
    expect(codes(noLand)).toContain('MAP_GEOGRAPHY_NO_LAND');
    expect(codes(noLand, { hasReference: true })).not.toContain('MAP_GEOGRAPHY_NO_LAND');
    expect(resolve({ version: 1 }).valid).toBe(false);
  });

  describe('edge band', () => {
    const coastal = () =>
      mutated((m) =>
        (m.lands as unknown[]).push({ id: 'rim', polygons: [square(0.005, 0.3, 0.02)] }),
      );

    it('warns by default, names the feature and reports the band', () => {
      const result = resolve(coastal());
      const finding = result.diagnostics.find(
        ({ code }) => code === 'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND',
      );
      expect(finding).toMatchObject({
        severity: 'warning',
        details: { featureId: 'rim', bandPx: 192, polarPx: 64 },
      });
      expect(result.edgeBand).toEqual({ westEastPx: 192, northSouthPx: 64 });
      expect(result.valid).toBe(true);
    });

    it('is an error under a sea band and silent when the edge policy is none', () => {
      expect(
        find(coastal(), 'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND', { edge: { mode: 'sea-band' } })
          ?.severity,
      ).toBe('error');
      expect(codes(coastal(), { edge: { mode: 'none' } })).not.toContain(
        'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND',
      );
    });

    it('follows an explicit band width and covers points, paths and rivers', () => {
      const wide = resolve(syntheticGeography(), { edge: { bandPx: 1_200 } });
      const ids = wide.diagnostics
        .filter(({ code }) => code === 'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND')
        .map(({ details }) => details?.featureId);
      expect(ids).toContain('aldoria');
      expect(ids).toContain('brim');
      expect(ids).toContain('brim_port');
    });

    it('catches a pass or a volcano standing in the polar band', () => {
      const polar = mutated((m) => {
        (m.lands as unknown[]).push({ id: 'north', polygons: [square(0.3, 0.001, 0.05)] });
        (m.volcanoes as unknown[]).push({ id: 'cap', at: [0.32, 0.02], radius: 0.005 });
      });
      const ids = resolve(polar)
        .diagnostics.filter(({ code }) => code === 'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND')
        .map(({ details }) => details?.featureId);
      expect(ids).toEqual(expect.arrayContaining(['north', 'cap']));
    });
  });

  describe('limits', () => {
    it('refuses more than 4,000 features and builds nothing', () => {
      const sites = Array.from({ length: 4_000 }, (_value, index) => ({
        id: `site${index}`,
        kind: 'city' as const,
        at: [0.5, 0.5] as [number, number],
      }));
      const result = resolve({
        version: 1,
        sites,
        volcanoes: [{ id: 'one_too_many', at: [0.5, 0.5], radius: 0.01 }],
      });
      expect(result.diagnostics.map(({ code }) => code)).toContain('MAP_GEOGRAPHY_LIMIT_FEATURES');
      expect(result.valid).toBe(false);
      expect(result.geography.featureCount).toBe(0);
    });

    it('refuses more than 200,000 vertices and builds nothing', () => {
      const ring = Array.from({ length: 1_100 }, (_value, index) => [
        0.1 + 0.001 * (index % 100),
        0.1 + 0.0001 * Math.floor(index / 100) + (index % 2 === 0 ? 0 : 0.00001),
      ]) as Array<[number, number]>;
      const lands = Array.from({ length: 3 }, (_value, index) => ({
        id: `heavy${index}`,
        polygons: Array.from({ length: 64 }, () => ring),
      }));
      const result = resolve({ version: 1, lands });
      expect(result.diagnostics.map(({ code }) => code)).toContain('MAP_GEOGRAPHY_LIMIT_POINTS');
      expect(result.geography.featureCount).toBe(0);
    });

    it('keeps every error when diagnostics exceed the bound, and says so', () => {
      const sites = Array.from({ length: GEOGRAPHY_DIAGNOSTIC_LIMIT + 200 }, () => ({
        id: 'same',
        kind: 'city' as const,
        at: [0.3, 0.35] as [number, number],
      }));
      const result = resolve({ ...syntheticGeography(), sites });
      expect(result.diagnostics.length).toBe(GEOGRAPHY_DIAGNOSTIC_LIMIT);
      const last = result.diagnostics.at(-1)!;
      expect(last.code).toBe('MAP_GEOGRAPHY_DIAGNOSTICS_TRUNCATED');
      expect(last.severity).toBe('error');
      expect(result.valid).toBe(false);
    });
  });

  it('copes with a worst-case ring of 2,000 vertices quickly', () => {
    const ring = Array.from({ length: 2_000 }, (_value, index) => {
      const radiusX = 0.3 + 0.02 * (index % 2);
      const turn = (index / 2_000) * 2 * Math.PI;
      return [0.5 + radiusX * Math.cos(turn), 0.5 + radiusX * Math.sin(turn) * 0.8] as [
        number,
        number,
      ];
    });
    const started = Date.now();
    const result = resolve(
      { version: 1, lands: [{ id: 'spiky', polygons: [ring] }] },
      { edge: { mode: 'none' } },
    );
    expect(result.diagnostics).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
