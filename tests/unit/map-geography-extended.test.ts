import { describe, expect, it } from 'vitest';
import {
  nearestOnPolyline,
  resolveGeography,
  type GeographyResolveOptions,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import { geographyModelSchema } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { GEOGRAPHY_FIXTURE_FRAME, syntheticGeography } from '../helpers/geography-fixture.js';

type Mutable = Record<string, unknown>;

function resolve(model: unknown, options: Partial<GeographyResolveOptions> = {}) {
  return resolveGeography(geographyModelSchema.parse(model), {
    frame: GEOGRAPHY_FIXTURE_FRAME,
    ...options,
  });
}

function mutated(change: (model: Mutable) => void): Mutable {
  const model = structuredClone(syntheticGeography()) as Mutable;
  change(model);
  return model;
}

const codes = (model: unknown, options: Partial<GeographyResolveOptions> = {}) =>
  resolve(model, options).diagnostics.map(({ code }) => code);

describe('passes given by position', () => {
  it('finds the range and the position along it', () => {
    const model = mutated((m) => {
      m.passes = [{ id: 'by_point', position: [0.375, 0.47], fort: 3 }];
    });
    const result = resolve(model);
    expect(result.diagnostics).toEqual([]);
    const pass = result.geography.get('pass', 'by_point')!;
    expect(pass.rangeId).toBe('spine');
    expect(pass.positionSource).toBe('point');
    expect(pass.offset).toBeLessThan(0.01);
    expect(pass.at).toBeGreaterThan(0.3);
    expect(pass.at).toBeLessThan(0.7);
    const path = result.geography.get('range', 'spine')!.path;
    const onPath = nearestOnPolyline(
      path,
      GEOGRAPHY_FIXTURE_FRAME,
      pass.position.x,
      pass.position.y,
    );
    expect(onPath.distance).toBeLessThan(1e-12);
    expect(result.geography.get('range', 'spine')!.passIds).toEqual(['by_point']);
  });

  it('gives the same pass as the fraction form when the point lies on the crest', () => {
    const fraction = resolve(syntheticGeography()).geography.get('pass', 'spine_gap')!;
    const point = mutated((m) => {
      m.passes = [
        {
          id: 'spine_gap',
          name: 'Spine Gap',
          position: [fraction.position.x, fraction.position.y],
          fort: 2,
        },
      ];
    });
    const resolved = resolve(point).geography.get('pass', 'spine_gap')!;
    expect(resolved.at).toBeCloseTo(fraction.at, 9);
    expect(resolved.positionSource).toBe('point');
    expect(fraction.positionSource).toBe('range-fraction');
  });

  it('keeps a named range and rejects a point beyond its footprint', () => {
    const near = mutated((m) => {
      m.passes = [{ id: 'p', range: 'spine', position: [0.375, 0.47] }];
    });
    expect(codes(near)).toEqual([]);
    const far = mutated((m) => {
      m.passes = [{ id: 'p', range: 'spine', position: [0.55, 0.2] }];
    });
    expect(codes(far)).toContain('MAP_GEOGRAPHY_PASS_OFF_RANGE');
    const nowhere = mutated((m) => {
      m.passes = [{ id: 'p', position: [0.1, 0.8] }];
    });
    expect(codes(nowhere)).toContain('MAP_GEOGRAPHY_PASS_OFF_RANGE');
    const finding = resolve(far).diagnostics.find(
      ({ code }) => code === 'MAP_GEOGRAPHY_PASS_OFF_RANGE',
    );
    expect(finding?.details).toMatchObject({ featureId: 'p', range: 'spine' });
  });

  it('refuses a pass with no range at all', () => {
    const none = mutated((m) => {
      m.ranges = [];
      m.passes = [{ id: 'p', position: [0.375, 0.47] }];
    });
    expect(codes(none)).toContain('MAP_GEOGRAPHY_PASS_OFF_RANGE');
  });

  it.each([
    ['both at and position', { id: 'p', range: 'spine', at: 0.5, position: [0.3, 0.4] }],
    ['neither at nor position', { id: 'p', range: 'spine' }],
    ['at without a range', { id: 'p', at: 0.5 }],
  ])('refuses %s', (_label, pass) => {
    expect(codes(mutated((m) => (m.passes = [pass])))).toContain('MAP_GEOGRAPHY_PASS_SHAPE');
  });
});

describe('straits given by a path', () => {
  const channel = [
    [0.62, 0.45],
    [0.67, 0.4],
    [0.71, 0.37],
  ];

  it('derives the two shores from the ends of the path', () => {
    const model = mutated((m) => {
      m.straits = [{ id: 'channel', path: channel, rule: 'army-closed', width: 0.012 }];
    });
    const result = resolve(model);
    expect(result.diagnostics).toEqual([]);
    const strait = result.geography.get('strait', 'channel')!;
    expect(strait.ends).toBe('derived');
    expect(strait.between).toEqual([
      { type: 'land', id: 'aldoria' },
      { type: 'land', id: 'brim' },
    ]);
    expect(strait.path).toHaveLength(3);
    expect(strait.rule).toBe('army-closed');
    expect(strait.width).toBe(0.012);
  });

  it('keeps declared ends and the path together', () => {
    const model = mutated((m) => {
      m.straits = [
        { id: 'channel', between: [{ land: 'aldoria' }, { land: 'brim' }], path: channel },
      ];
    });
    const strait = resolve(model).geography.get('strait', 'channel')!;
    expect(strait.ends).toBe('declared');
    expect(strait.path).toHaveLength(3);
  });

  it('refuses a strait with neither ends nor path', () => {
    expect(codes(mutated((m) => (m.straits = [{ id: 'nothing' }])))).toContain(
      'MAP_GEOGRAPHY_STRAIT_SHAPE',
    );
  });

  it('reports a path whose ends find no land, one shore twice and a path over land', () => {
    const lost = mutated((m) => {
      m.straits = [
        {
          id: 'lost',
          path: [
            [0.62, 0.45],
            [0.95, 0.95],
          ],
        },
      ];
    });
    expect(codes(lost)).toContain('MAP_GEOGRAPHY_STRAIT_ENDPOINT');
    const same = mutated((m) => {
      m.straits = [
        {
          id: 'loop',
          path: [
            [0.62, 0.3],
            [0.62, 0.6],
          ],
        },
      ];
    });
    const finding = resolve(same).diagnostics.find(
      ({ code }) => code === 'MAP_GEOGRAPHY_STRAIT_SAME_LAND',
    );
    expect(finding).toMatchObject({ severity: 'warning', details: { derived: true } });
    const dry = mutated((m) => {
      m.straits = [
        {
          id: 'dry',
          path: [
            [0.3, 0.3],
            [0.35, 0.3],
            [0.4, 0.3],
            [0.7, 0.4],
          ],
        },
      ];
    });
    expect(codes(dry)).toContain('MAP_GEOGRAPHY_STRAIT_PATH_ON_LAND');
  });
});

describe('roads and places', () => {
  it('resolves roads with lengths and places with the surface under them', () => {
    const model = mutated((m) => {
      m.roads = [
        {
          id: 'salt_road',
          name: 'Salt Road',
          path: [
            [0.2, 0.3],
            [0.3, 0.32],
            [0.45, 0.5],
          ],
          importance: 3,
        },
      ];
      m.places = [
        { id: 'cape_wind', name: 'Cape Wind', kind: 'cape', at: [0.6, 0.5] },
        { id: 'bay_calm', kind: 'bay', at: [0.65, 0.3] },
        { id: 'high_place', kind: 'landmark', at: [0.3, 0.3] },
      ];
    });
    const result = resolve(model);
    expect(result.diagnostics).toEqual([]);
    const geography = result.geography;
    const road = geography.get('road', 'salt_road')!;
    expect(road.importance).toBe(3);
    expect(road.path.length).toBeGreaterThan(0.2);
    expect(geography.get('place', 'cape_wind')?.placeKind).toBe('cape');
    expect(geography.get('place', 'bay_calm')?.surface).toBe('sea');
    expect(geography.get('place', 'high_place')?.surface).toBe('land');
    expect(geography.list('road').map(({ id }) => id)).toEqual(['salt_road']);
    expect(geography.features().at(-1)?.kind).toBe('place');
    expect(geography.find('salt_road')?.kind).toBe('road');
    expect(geography.hash).not.toBe(resolve(syntheticGeography()).geography.hash);
    expect(geography.featureCount).toBe(16 + 4);
  });

  it('reports a degenerate road and a duplicate id with a place', () => {
    const model = mutated((m) => {
      m.roads = [
        {
          id: 'dot',
          path: [
            [0.3, 0.3],
            [0.3, 0.3],
          ],
        },
      ];
      m.places = [{ id: 'aldor', kind: 'other', at: [0.3, 0.3] }];
    });
    expect(codes(model)).toEqual(
      expect.arrayContaining(['MAP_GEOGRAPHY_PATH_DEGENERATE', 'MAP_GEOGRAPHY_ID_DUPLICATE']),
    );
  });
});

describe('regions with density and terrain shares', () => {
  it('keeps the declared targets', () => {
    const model = mutated((m) => {
      const region = (m.regions as Array<Record<string, unknown>>)[0]!;
      region.terrain = { plains: 0.5, forest: 0.2, hills: 0.25, urban: 0.05 };
      region.density = { provincesPerState: [2, 3, 4], provinceAreaPx: 500 };
    });
    const result = resolve(model);
    expect(result.diagnostics).toEqual([]);
    const region = result.geography.get('region', 'old_realm')!;
    expect(region.terrain).toEqual({ plains: 0.5, forest: 0.2, hills: 0.25, urban: 0.05 });
    expect(region.provincesPerState).toEqual([2, 3, 4]);
    expect(region.provinceAreaPx).toBe(500);
    expect(result.geography.hash).not.toBe(resolve(syntheticGeography()).geography.hash);
  });

  it('warns about shares above one and rejects unordered provinces per state', () => {
    const heavy = mutated((m) => {
      (m.regions as Array<Record<string, unknown>>)[0]!.terrain = {
        plains: 0.8,
        forest: 0.6,
      };
    });
    expect(codes(heavy)).toContain('MAP_GEOGRAPHY_REGION_TERRAIN_SUM');
    const unordered = mutated((m) => {
      (m.regions as Array<Record<string, unknown>>)[0]!.density = {
        provincesPerState: [5, 3, 4],
      };
    });
    expect(codes(unordered)).toContain('MAP_GEOGRAPHY_REGION_DENSITY_ORDER');
  });
});

describe('sites, volcanoes and rivers near coasts and lakes', () => {
  it('allows a site that stands in water when it says so', () => {
    const model = mutated((m) => {
      m.sites = [{ id: 'landing', kind: 'port', at: [0.65, 0.3], onWater: true }];
    });
    const result = resolve(model);
    expect(result.diagnostics).toEqual([]);
    expect(result.geography.get('site', 'landing')).toMatchObject({ onWater: true });
    expect(result.geography.get('site', 'landing')?.landId).toBeUndefined();
  });

  it('allows a lake port on the shore, and refuses one in another lake or a wrong kind', () => {
    const lakePort = mutated((m) => {
      m.sites = [{ id: 'quay', kind: 'port', at: [0.3, 0.55], lake: 'mirror' }];
    });
    const ok = resolve(lakePort);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.geography.get('site', 'quay')?.lakeId).toBe('mirror');
    const wrong = mutated((m) => {
      m.sites = [{ id: 'quay', kind: 'port', at: [0.3, 0.55], lake: 'aldoria' }];
    });
    expect(codes(wrong)).toContain('MAP_GEOGRAPHY_REF_KIND');
    const noLake = mutated((m) => {
      m.sites = [{ id: 'quay', kind: 'port', at: [0.3, 0.55] }];
    });
    expect(codes(noLake)).toContain('MAP_GEOGRAPHY_SITE_IN_WATER');
    const farAway = mutated((m) => {
      m.sites = [{ id: 'quay', kind: 'port', at: [0.65, 0.3], lake: 'mirror' }];
    });
    expect(codes(farAway)).toContain('MAP_GEOGRAPHY_SITE_IN_WATER');
  });

  it('counts a point just outside a coast as land, and one far outside as water', () => {
    const near = mutated((m) => {
      m.sites = [{ id: 'harbour', kind: 'port', at: [0.0985, 0.45] }];
    });
    const result = resolve(near);
    expect(result.diagnostics).toEqual([]);
    expect(result.geography.get('site', 'harbour')?.landId).toBe('aldoria');
    const far = mutated((m) => {
      m.sites = [{ id: 'harbour', kind: 'port', at: [0.09, 0.45] }];
    });
    expect(codes(far)).toContain('MAP_GEOGRAPHY_SITE_IN_WATER');
  });

  it('tells a converter how far inland a river mouth is', () => {
    const inland = mutated((m) => {
      (m.rivers as Array<Record<string, unknown>>)[0]!.mouth = [0.3, 0.65];
    });
    const finding = resolve(inland).diagnostics.find(
      ({ code }) => code === 'MAP_GEOGRAPHY_RIVER_MOUTH_NOT_WATER',
    );
    expect(finding?.details).toMatchObject({ featureId: 'silver', nearestLand: 'aldoria' });
    expect(finding?.details?.inlandDistance).toBeGreaterThan(0.02);
    const shore = mutated((m) => {
      (m.rivers as Array<Record<string, unknown>>)[0]!.mouth = [0.5995, 0.45];
    });
    expect(codes(shore)).not.toContain('MAP_GEOGRAPHY_RIVER_MOUTH_NOT_WATER');
  });

  it('gives a volcano a default radius and crater', () => {
    const model = mutated((m) => {
      m.volcanoes = [{ id: 'cone', at: [0.2, 0.7] }];
    });
    const volcano = resolve(model).geography.get('volcano', 'cone')!;
    expect(volcano.radius).toBe(0.01);
    expect(volcano.crater).toBeCloseTo(0.002, 12);
    expect(volcano.peak).toBe(0.85);
  });
});

describe('edge policy modes', () => {
  const coastal = () =>
    mutated((m) => {
      (m.lands as unknown[]).push({
        id: 'rim',
        polygons: [
          [
            [0.005, 0.3],
            [0.025, 0.3],
            [0.025, 0.32],
            [0.005, 0.32],
          ],
        ],
      });
    });

  it('does not check the band when the edge is a rim wall or opted out', () => {
    expect(codes(coastal(), { edge: { mode: 'rim' } })).not.toContain(
      'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND',
    );
    expect(codes(coastal(), { edge: { mode: 'none' } })).not.toContain(
      'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND',
    );
    expect(codes(coastal())).toContain('MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND');
    expect(
      resolve(coastal(), { edge: { mode: 'sea-band' } }).diagnostics.find(
        ({ code }) => code === 'MAP_GEOGRAPHY_FEATURE_IN_EDGE_BAND',
      )?.severity,
    ).toBe('error');
  });
});

describe('biomes and plateaus for hills and chasms', () => {
  it('accepts hills as a biome and a low plateau as a chasm', () => {
    const model = mutated((m) => {
      (m.biomes as unknown[]).push({
        id: 'downs',
        kind: 'hills',
        z: 6,
        polygons: [
          [
            [0.42, 0.25],
            [0.5, 0.27],
            [0.48, 0.32],
            [0.4, 0.3],
          ],
        ],
      });
      m.plateaus = [
        {
          id: 'abyss',
          height: 0,
          edge: 'cliff',
          polygons: [
            [
              [0.2, 0.6],
              [0.25, 0.6],
              [0.25, 0.65],
              [0.2, 0.65],
            ],
          ],
        },
      ];
    });
    const result = resolve(model);
    expect(result.diagnostics).toEqual([]);
    expect(result.geography.get('biome', 'downs')?.biome).toBe('hills');
    expect(result.geography.get('plateau', 'abyss')).toMatchObject({ height: 0, edge: 'cliff' });
  });
});

describe('nearest point on a path', () => {
  it('projects in map-width units and reports the arc fraction', () => {
    const line = resolveGeography(
      geographyModelSchema.parse({
        version: 1,
        ranges: [
          {
            id: 'r',
            path: [
              [0.2, 0.5],
              [0.6, 0.5],
              [0.6, 0.9],
            ],
          },
        ],
      }),
      { frame: GEOGRAPHY_FIXTURE_FRAME, hasReference: true },
    ).geography.get('range', 'r')!.path;
    const onFirst = nearestOnPolyline(line, GEOGRAPHY_FIXTURE_FRAME, 0.4, 0.4);
    expect(onFirst.segment).toBe(0);
    expect(onFirst.x).toBeCloseTo(0.4, 12);
    expect(onFirst.y).toBeCloseTo(0.5, 12);
    // 0.1 of the height is 0.05 of the width.
    expect(onFirst.distance).toBeCloseTo(0.05, 12);
    expect(onFirst.at).toBeCloseTo(0.2 / (0.4 + 0.2), 12);
    const onSecond = nearestOnPolyline(line, GEOGRAPHY_FIXTURE_FRAME, 0.7, 0.8);
    expect(onSecond.segment).toBe(1);
    expect(onSecond.distance).toBeCloseTo(0.1, 12);
    expect(onSecond.at).toBeGreaterThan(0.7);
  });
});
