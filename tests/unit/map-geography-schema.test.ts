import { describe, expect, it } from 'vitest';
import {
  GEOGRAPHY_MAX_PATH_VERTICES,
  GEOGRAPHY_MAX_RING_VERTICES,
  geographyModelSchema,
  geographyPathSchema,
} from '../../src/hoi4_agent_tools/schemas/geography.js';
import { mapRewriteRequestSchema } from '../../src/hoi4_agent_tools/schemas/map-requests.js';
import { syntheticGeography } from '../helpers/geography-fixture.js';

function square(offset = 0.1): Array<[number, number]> {
  return [
    [offset, offset],
    [offset + 0.2, offset],
    [offset + 0.2, offset + 0.2],
    [offset, offset + 0.2],
  ];
}

function parse(model: unknown) {
  return geographyModelSchema.safeParse(model);
}

describe('geography model schema (version 1)', () => {
  it('accepts the synthetic world and minimal models', () => {
    expect(parse(syntheticGeography()).success).toBe(true);
    expect(parse({ version: 1 }).success).toBe(true);
    expect(parse({ version: 1, lands: [{ id: 'a', polygons: [square()] }] }).success).toBe(true);
  });

  it('accepts roads, places, passes by position, straits by path and the richer sites and regions', () => {
    const result = parse({
      version: 1,
      roads: [
        {
          id: 'road',
          path: [
            [0.1, 0.1],
            [0.2, 0.2],
          ],
          importance: 3,
        },
      ],
      places: [{ id: 'cape', kind: 'cape', at: [0.1, 0.1] }],
      passes: [{ id: 'gap', position: [0.3, 0.3], fort: 5 }],
      straits: [
        {
          id: 'channel',
          path: [
            [0.1, 0.1],
            [0.2, 0.2],
          ],
          rule: 'navy-closed',
        },
      ],
      sites: [{ id: 'quay', kind: 'landmark', at: [0.2, 0.2], onWater: true, lake: 'mirror' }],
      volcanoes: [{ id: 'cone', at: [0.4, 0.4] }],
      biomes: [{ id: 'downs', kind: 'hills', polygons: [square()] }],
      regions: [
        {
          id: 'region',
          polygons: [square()],
          terrain: { plains: 0.5, snow: 0.1 },
          density: { provincesPerState: [2, 3, 4], provinceAreaPx: 500 },
        },
      ],
      plateaus: [{ id: 'chasm', height: 0, polygons: [square()] }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a road of one point', { version: 1, roads: [{ id: 'r', path: [[0.1, 0.1]] }] }],
    [
      'a road importance of 4',
      {
        version: 1,
        roads: [
          {
            id: 'r',
            path: [
              [0.1, 0.1],
              [0.2, 0.2],
            ],
            importance: 4,
          },
        ],
      },
    ],
    [
      'an unknown place kind',
      { version: 1, places: [{ id: 'p', kind: 'mountain', at: [0.1, 0.1] }] },
    ],
    ['a place without a point', { version: 1, places: [{ id: 'p', kind: 'cape' }] }],
    ['a strait path of one point', { version: 1, straits: [{ id: 's', path: [[0.1, 0.1]] }] }],
    ['a pass fort of 6', { version: 1, passes: [{ id: 'p', position: [0.1, 0.1], fort: 6 }] }],
    [
      'a two-part provincesPerState',
      { version: 1, regions: [{ id: 'r', density: { provincesPerState: [2, 3] } }] },
    ],
    ['an unknown terrain share', { version: 1, regions: [{ id: 'r', terrain: { lava: 0.1 } }] }],
    ['a share above one', { version: 1, regions: [{ id: 'r', terrain: { plains: 1.5 } }] }],
    [
      'a province area of 5 pixels',
      { version: 1, regions: [{ id: 'r', density: { provinceAreaPx: 5 } }] },
    ],
    [
      'an unknown biome kind',
      { version: 1, biomes: [{ id: 'b', kind: 'glacier', polygons: [square()] }] },
    ],
    [
      'a note of 2,001 characters',
      { version: 1, sites: [{ id: 's', kind: 'city', at: [0.1, 0.1], note: 'x'.repeat(2_001) }] },
    ],
    [
      'a river via of 513 points',
      {
        version: 1,
        rivers: [
          {
            id: 'r',
            source: [0.1, 0.1],
            mouth: [0.2, 0.2],
            via: Array.from({ length: 513 }, () => [0.15, 0.15]),
          },
        ],
      },
    ],
  ])('rejects %s', (_label, model) => {
    expect(parse(model).success).toBe(false);
  });

  it('accepts points as objects and as pairs, and path vertices with overrides', () => {
    const result = parse({
      version: 1,
      lands: [
        {
          id: 'a',
          polygons: [[{ x: 0.1, y: 0.1 }, [0.3, 0.1], { x: 0.2, y: 0.3 }]],
        },
      ],
      ranges: [
        {
          id: 'r',
          path: [{ x: 0.1, y: 0.1, halfWidth: 0.02, peak: 0.5 }, [0.2, 0.2]],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a missing version', { lands: [] }],
    ['a different version', { version: 2 }],
    ['an unknown top-level key', { version: 1, mountains: [] }],
    ['an unknown feature key', { version: 1, lands: [{ id: 'a', polygons: [square()], moss: 1 }] }],
    ['a missing id', { version: 1, lands: [{ polygons: [square()] }] }],
    ['a bad id', { version: 1, lands: [{ id: '1bad id', polygons: [square()] }] }],
    ['an overlong id', { version: 1, lands: [{ id: `a${'b'.repeat(64)}`, polygons: [square()] }] }],
    [
      'x outside 0..1',
      {
        version: 1,
        lands: [
          {
            id: 'a',
            polygons: [
              [
                [0, 0],
                [1.1, 0],
                [0, 1],
              ],
            ],
          },
        ],
      },
    ],
    [
      'negative y',
      {
        version: 1,
        lands: [
          {
            id: 'a',
            polygons: [
              [
                [0, -0.1],
                [1, 0],
                [0, 1],
              ],
            ],
          },
        ],
      },
    ],
    [
      'NaN',
      {
        version: 1,
        lands: [
          {
            id: 'a',
            polygons: [
              [
                [0, 0],
                [Number.NaN, 0],
                [0, 1],
              ],
            ],
          },
        ],
      },
    ],
    [
      'Infinity',
      { version: 1, volcanoes: [{ id: 'v', at: [0.5, 0.5], radius: Number.POSITIVE_INFINITY }] },
    ],
    [
      'a ring of two points',
      {
        version: 1,
        lands: [
          {
            id: 'a',
            polygons: [
              [
                [0, 0],
                [1, 0],
              ],
            ],
          },
        ],
      },
    ],
    ['no polygons', { version: 1, lands: [{ id: 'a', polygons: [] }] }],
    [
      'a point object with extras',
      { version: 1, sites: [{ id: 's', kind: 'city', at: { x: 0.1, y: 0.1, z: 1 } }] },
    ],
    [
      'a three-element point pair',
      { version: 1, sites: [{ id: 's', kind: 'city', at: [0.1, 0.1, 0.3] }] },
    ],
    ['an unknown site kind', { version: 1, sites: [{ id: 's', kind: 'castle', at: [0.1, 0.1] }] }],
    [
      'importance 6',
      { version: 1, sites: [{ id: 's', kind: 'city', at: [0.1, 0.1], importance: 6 }] },
    ],
    [
      'a river size of 0',
      { version: 1, rivers: [{ id: 'r', source: [0.1, 0.1], mouth: [0.2, 0.2], size: 0 }] },
    ],
    ['a zero radius', { version: 1, volcanoes: [{ id: 'v', at: [0.5, 0.5], radius: 0 }] }],
    ['a one-point range', { version: 1, ranges: [{ id: 'r', path: [[0.1, 0.1]] }] }],
    [
      'a river source that is a sea',
      { version: 1, rivers: [{ id: 'r', source: { sea: 's' }, mouth: [0.2, 0.2] }] },
    ],
    [
      'a strait with three ends',
      {
        version: 1,
        straits: [
          {
            id: 's',
            between: [
              [0.1, 0.1],
              [0.2, 0.2],
              [0.3, 0.3],
            ],
          },
        ],
      },
    ],
    ['a climate wind of 360', { version: 1, climate: { windFrom: 360 } }],
    ['a rain scale of 0', { version: 1, climate: { rainScale: 0 } }],
    [
      'control characters in a name',
      { version: 1, lands: [{ id: 'a', name: 'bad\u0007', polygons: [square()] }] },
    ],
    [
      'a country tag in lowercase',
      { version: 1, sites: [{ id: 's', kind: 'city', at: [0.1, 0.1], country: 'abc' }] },
    ],
  ])('rejects %s', (_label, model) => {
    expect(parse(model).success).toBe(false);
  });

  it('bounds rings, paths and feature arrays', () => {
    const ring = (count: number) =>
      Array.from(
        { length: count },
        (_value, index) => [index / count, (index % 2) / 2] as [number, number],
      );
    expect(
      parse({ version: 1, lands: [{ id: 'a', polygons: [ring(GEOGRAPHY_MAX_RING_VERTICES)] }] })
        .success,
    ).toBe(true);
    expect(
      parse({ version: 1, lands: [{ id: 'a', polygons: [ring(GEOGRAPHY_MAX_RING_VERTICES + 1)] }] })
        .success,
    ).toBe(false);
    expect(
      parse({ version: 1, ranges: [{ id: 'r', path: ring(GEOGRAPHY_MAX_PATH_VERTICES) }] }).success,
    ).toBe(true);
    expect(
      parse({ version: 1, ranges: [{ id: 'r', path: ring(GEOGRAPHY_MAX_PATH_VERTICES + 1) }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 4_001 }, (_value, index) => ({
      id: `s${index}`,
      kind: 'city' as const,
      at: [0.5, 0.5] as [number, number],
    }));
    expect(parse({ version: 1, sites: many }).success).toBe(false);
    expect(parse({ version: 1, sites: many.slice(0, 4_000) }).success).toBe(true);
    expect(
      parse({
        version: 1,
        lands: [{ id: 'a', polygons: Array.from({ length: 65 }, () => square()) }],
      }).success,
    ).toBe(false);
  });

  it('accepts a model inline or by path in create_world, never both', () => {
    const inline = mapRewriteRequestSchema.safeParse({
      preview: true,
      operations: [{ kind: 'create_world', geography: syntheticGeography() }],
    });
    expect(inline.success).toBe(true);
    const byPath = mapRewriteRequestSchema.safeParse({
      preview: true,
      operations: [{ kind: 'create_world', geographyPath: 'geography/world.json' }],
    });
    expect(byPath.success).toBe(true);
    const both = mapRewriteRequestSchema.safeParse({
      operations: [
        {
          kind: 'create_world',
          geography: syntheticGeography(),
          geographyPath: 'geography/world.json',
        },
      ],
    });
    expect(both.success).toBe(false);
    const alongsideImage = mapRewriteRequestSchema.safeParse({
      operations: [
        { kind: 'create_world', geographyPath: 'g.json', reference: { imagePath: 'ref.png' } },
      ],
    });
    expect(alongsideImage.success).toBe(true);
  });

  it.each([
    '../geography.json',
    'geography/../../world.json',
    'C:\\world.json',
    '/etc/world.json',
    '\\\\server\\share\\world.json',
    'world.png',
    'world.json:stream',
    'world.jsonl',
    'geography\u0000.json',
  ])('rejects the unsafe geography path %s', (value) => {
    expect(geographyPathSchema.safeParse(value).success).toBe(false);
  });

  it.each(['geography/world.json', 'world.JSON', 'a/b/c/model.json'])(
    'accepts the geography path %s',
    (value) => {
      expect(geographyPathSchema.safeParse(value).success).toBe(true);
    },
  );
});
