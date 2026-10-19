import { describe, expect, it } from 'vitest';
import {
  COLOUR_CLASSES,
  calibratedColourMap,
  colourTable,
} from '../../src/hoi4_agent_tools/map/colormap.js';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import {
  encodeDds,
  generateWorld,
  type WorldContext,
} from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import {
  measureAppearance,
  readDds32,
  readTerrainIndices,
} from '../helpers/map-appearance-metrics.js';
import {
  APPEARANCE_CODE,
  appearanceDiagnostics,
  filesOf,
  indexOfFiles,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';

const classCode = (name: (typeof COLOUR_CLASSES)[number]) => COLOUR_CLASSES.indexOf(name);

describe('colour tables', () => {
  it('start from the base game’s measured class means and darken, not brighten', () => {
    const table = colourTable('vanilla-temperate');
    expect(table.plains).toEqual([68, 68, 41]);
    expect(table.forest).toEqual([47, 55, 24]);
    expect(table.desert).toEqual([118, 98, 64]);
    expect(table.snow).toEqual([55, 58, 35]);
    for (const name of [
      'plains',
      'forest',
      'hills',
      'mountain',
      'marsh',
      'jungle',
      'snow',
    ] as const)
      expect(Math.max(...table[name])).toBeLessThan(80);
  });

  it('shifts the fertile palette greener and the arid palette warmer', () => {
    const base = colourTable('vanilla-temperate').plains;
    const fertile = colourTable('fertile').plains;
    const arid = colourTable('arid').plains;
    expect(fertile[1] / fertile[0]).toBeGreaterThan(base[1] / base[0]);
    expect(arid[0] / arid[1]).toBeGreaterThan(base[0] / base[1]);
  });

  it('applies custom colours over the base table', () => {
    expect(colourTable('custom', { plains: [10, 20, 30] }).plains).toEqual([10, 20, 30]);
    expect(colourTable('custom', { plains: [10, 20, 30] }).forest).toEqual([47, 55, 24]);
  });
});

describe('the calibrated land colour map', () => {
  const width = 256;
  const height = 128;
  function input(overrides: Partial<Parameters<typeof calibratedColourMap>[0]> = {}) {
    const classes = new Uint8Array(width * height);
    const names = ['plains', 'forest', 'hills', 'desert', 'mountain', 'snow'] as const;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        classes[y * width + x] = classCode(names[Math.floor((x / width) * names.length)]!);
    const heights = new Uint8Array(width * height).fill(100);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) heights[y * width + x] = 100 + ((x * 3 + y * 5) % 40);
    return {
      width,
      height,
      seed: 5,
      classes,
      moisture: new Float32Array(width * height).fill(0.5),
      heights,
      lights: new Uint8Array(width * height),
      look: 'vanilla-temperate' as const,
      ...overrides,
    };
  }

  it('lands in the base game’s range with varied colours inside every class', () => {
    const output = calibratedColourMap(input());
    expect(output).toHaveLength((width / 2) * (height / 2) * 4);
    let valueSum = 0;
    const distinct = new Set<number>();
    const plains = new Set<number>();
    for (let pixel = 0; pixel < output.length / 4; pixel += 1) {
      const b = output[pixel * 4]!;
      const g = output[pixel * 4 + 1]!;
      const r = output[pixel * 4 + 2]!;
      valueSum += Math.max(r, g, b);
      distinct.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      if (pixel % (width / 2) < 8) plains.add((r << 16) | (g << 8) | b);
    }
    const mean = valueSum / (output.length / 4);
    expect(mean).toBeGreaterThan(50);
    expect(mean).toBeLessThan(100);
    expect(distinct.size).toBeGreaterThan(150);
    expect(plains.size).toBeGreaterThan(20);
  });

  it('is deterministic and changes with the seed', () => {
    expect(
      Buffer.from(calibratedColourMap(input())).equals(Buffer.from(calibratedColourMap(input()))),
    ).toBe(true);
    expect(
      Buffer.from(calibratedColourMap(input({ seed: 6 }))).equals(
        Buffer.from(calibratedColourMap(input())),
      ),
    ).toBe(false);
  });

  it('carries the city-light mask in the alpha channel and keeps water nearly uniform', () => {
    const lights = new Uint8Array(width * height);
    lights[2 * width + 2] = 200;
    const classes = input().classes.fill(classCode('ocean'));
    const output = calibratedColourMap(input({ lights, classes }));
    expect(output[(1 * (width / 2) + 1) * 4 + 3]).toBe(200);
    const blues = new Set<number>();
    for (let pixel = 0; pixel < output.length / 4; pixel += 1) blues.add(output[pixel * 4]!);
    expect(Math.max(...blues) - Math.min(...blues)).toBeLessThan(0.15 * 141);
  });

  it('shades slopes: the light side is brighter than the dark side', () => {
    const heights = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        heights[y * width + x] = x < 128 ? 100 + (x >> 1) : 164 - ((x - 128) >> 1);
    const output = calibratedColourMap(
      input({ heights, classes: input().classes.fill(classCode('mountain')), seed: 1 }),
    );
    const mean = (from: number, to: number) => {
      let total = 0;
      let count = 0;
      for (let y = 4; y < height / 2 - 4; y += 1)
        for (let x = from; x < to; x += 1) {
          total += output[(y * (width / 2) + x) * 4 + 1]!;
          count += 1;
        }
      return total / count;
    };
    // The west slope rises toward the east and faces the north-west light.
    expect(mean(20, 56)).toBeGreaterThan(mean(72, 108));
  });
});

describe('the colour map profiles in a generated world', () => {
  // Two continents holding every terrain class, with the wet flat ground that gets farmland.
  const width = 512;
  const height = 256;
  const surface = syntheticRaster(width, height, {
    at: (x, y) => (x > 40 && x < 470 && y > 30 && y < 226 ? 1 : 0),
    terrain: (x, y) => [0, 1, 2, 3, 4, 6, 7, 8][(Math.floor(x / 60) + Math.floor(y / 70)) % 8]!,
  });
  for (let pixel = 0; pixel < surface.moisture.length; pixel += 1) surface.moisture[pixel] = 0.7;
  const vanillaTerrain: WorldContext = {
    ...plainContext,
    terrainEntries: [
      { name: 'terrain_0', index: 0, type: 'plains', texture: 1, permSnow: false },
      { name: 'terrain_4', index: 4, type: 'forest', texture: 5, permSnow: false },
      { name: 'terrain_5', index: 5, type: 'plains', texture: 0, permSnow: false },
      { name: 'terrain_20', index: 20, type: 'mountain', texture: 7, permSnow: false },
    ],
  };
  const legacyDefault = generateWorld(worldSpec(surface), plainContext);
  const legacy = generateWorld(worldSpec(surface, { colormapProfile: 'legacy' }), plainContext);
  const calibrated = generateWorld(
    worldSpec(surface, { colormapProfile: 'calibrated', look: 'vanilla-temperate' }),
    vanillaTerrain,
  );

  it('keeps the legacy bytes when no profile is chosen', () => {
    expect(legacy.files.map((file) => file.content.toString('base64'))).toEqual(
      legacyDefault.files.map((file) => file.content.toString('base64')),
    );
    const metrics = measureAppearance(filesOf(legacy));
    expect(metrics.landColourMap.meanValue).toBeGreaterThan(100);
    expect(metrics.landColourMap.distinct5Bit).toBeLessThan(30);
  });

  it('writes a dark, varied colour map in the base game’s range', () => {
    const metrics = measureAppearance(filesOf(calibrated));
    expect(metrics.landColourMap.meanValue).toBeGreaterThan(50);
    expect(metrics.landColourMap.meanValue).toBeLessThan(100);
    expect(metrics.landColourMap.distinct5Bit).toBeGreaterThan(400);
    expect(metrics.landColourMap.valueDeviation).toBeGreaterThan(15);
  });

  it('gives permanent-snow terrain its own tint instead of the plains tint', () => {
    const files = filesOf(calibrated);
    const terrain = readTerrainIndices(files);
    const colours = readDds32(files.get('map/terrain/colormap_rgb_cityemissivemask_a.dds')!);
    let snow = 0;
    let snowValue = 0;
    for (let y = 0; y < colours.height; y += 1)
      for (let x = 0; x < colours.width; x += 1) {
        if (terrain[y * 2 * width + x * 2] !== 19) continue;
        const offset = (y * colours.width + x) * 4;
        snow += 1;
        snowValue += Math.max(
          colours.rgba[offset]!,
          colours.rgba[offset + 1]!,
          colours.rgba[offset + 2]!,
        );
      }
    expect(snow).toBeGreaterThan(500);
    expect(snowValue / snow).toBeLessThan(75);
  });

  it('uses farmland, sparse forest and grassy mountains only when the terrain files declare them', () => {
    const used = (files: Map<string, Buffer>) => new Set(readTerrainIndices(files));
    const withEntries = used(filesOf(calibrated));
    expect(withEntries.has(5)).toBe(true);
    expect(withEntries.has(4)).toBe(true);
    expect(withEntries.has(20)).toBe(true);
    const without = used(
      filesOf(
        generateWorld(worldSpec(surface, { colormapProfile: 'calibrated' }), {
          ...plainContext,
          terrainEntries: [
            { name: 'terrain_0', index: 0, type: 'plains', texture: 1, permSnow: false },
          ],
        }),
      ),
    );
    expect(without.has(5)).toBe(false);
    expect(without.has(4)).toBe(false);
    expect(without.has(20)).toBe(false);
  });

  it('applies the fertile palette to the same land', () => {
    const fertile = generateWorld(
      worldSpec(surface, { colormapProfile: 'calibrated', look: 'fertile' }),
      vanillaTerrain,
    );
    const a = measureAppearance(filesOf(calibrated)).landColourMap.meanRgb;
    const b = measureAppearance(filesOf(fertile)).landColourMap.meanRgb;
    expect(b[1] / b[0]).toBeGreaterThan(a[1] / a[0]);
  });
});

describe('colour map validation', () => {
  const surface = syntheticRaster(512, 256, {
    at: (x, y) => (x > 40 && x < 470 && y > 30 && y < 226 ? 1 : 0),
    terrain: (x) => [0, 1, 2, 3][Math.floor(x / 120) % 4]!,
  });
  const calibrated = filesOf(
    generateWorld(worldSpec(surface, { colormapProfile: 'calibrated' }), plainContext),
  );
  const legacy = filesOf(generateWorld(worldSpec(surface), plainContext));

  it('passes the calibrated colour map', () => {
    expect(
      appearanceDiagnostics(calibrated).filter(({ code }) => code.startsWith('MAP_COLORMAP')),
    ).toEqual([]);
  });

  it('warns that a flat, bright colour map is washed out, with the measured numbers', () => {
    const range = appearanceDiagnostics(legacy).find(({ code }) => code === 'MAP_COLORMAP_RANGE');
    expect(range?.severity).toBe('warning');
    expect(range?.message).toContain('mean value');
    expect(range?.details).toMatchObject({ distinct5BitColours: expect.any(Number) });
    expect((range?.details?.meanValue as number) > 100).toBe(true);
  });

  it('warns about a flat water colour map', () => {
    const flat = new Map(calibrated);
    const water = Buffer.from(flat.get('map/terrain/colormap_water_0.dds')!);
    water.fill(90, 128);
    water.fill(255, 128, 129);
    flat.set('map/terrain/colormap_water_0.dds', water);
    expect(appearanceDiagnostics(flat).map(({ code }) => code)).toContain(
      'MAP_WATER_COLORMAP_FLAT',
    );
  });

  it('blocks a colour map that is not half the province map', () => {
    const wrong = new Map(calibrated);
    wrong.set(
      'map/terrain/colormap_rgb_cityemissivemask_a.dds',
      encodeDds(100, 100, new Uint8Array(100 * 100 * 4)),
    );
    const result = validateMap(indexOfFiles(wrong));
    expect(result.passed).toBe(false);
    const size = result.diagnostics.find(({ code }) => code === 'MAP_COLORMAP_SIZE');
    expect(size).toMatchObject({ severity: 'error', details: { width: 100, expectedWidth: 256 } });
    const level = new Map(calibrated);
    level.set('map/terrain/colormap_water_1.dds', encodeDds(64, 64, new Uint8Array(64 * 64 * 4)));
    expect(
      validateMap(indexOfFiles(level)).diagnostics.filter(({ code }) => APPEARANCE_CODE.test(code)),
    ).toEqual([expect.objectContaining({ code: 'MAP_COLORMAP_SIZE', severity: 'error' })]);
  });

  it('reports city lights over water as information', () => {
    const lit = new Map(calibrated);
    const colours = Buffer.from(lit.get('map/terrain/colormap_rgb_cityemissivemask_a.dds')!);
    colours[128 + 3] = 255;
    lit.set('map/terrain/colormap_rgb_cityemissivemask_a.dds', colours);
    expect(
      appearanceDiagnostics(lit).find(({ code }) => code === 'MAP_COLORMAP_ALPHA_CITY'),
    ).toMatchObject({
      severity: 'info',
    });
  });
});

describe('look and colormap options in the operation schema', () => {
  const base = { kind: 'create_world' } as const;
  it('accepts the documented values', () => {
    for (const look of ['vanilla-temperate', 'fertile', 'arid', 'custom'])
      expect(mapOperationSchema.safeParse({ ...base, look }).success).toBe(true);
    expect(
      mapOperationSchema.safeParse({
        ...base,
        look: 'custom',
        colormap: { profile: 'calibrated', palette: { plains: { r: 70, g: 70, b: 40 } } },
      }).success,
    ).toBe(true);
    expect(mapOperationSchema.safeParse({ ...base, colormap: { profile: 'legacy' } }).success).toBe(
      true,
    );
  });

  it('rejects unknown looks, profiles, classes, colours and extra keys', () => {
    expect(mapOperationSchema.safeParse({ ...base, look: 'neon' }).success).toBe(false);
    expect(mapOperationSchema.safeParse({ ...base, colormap: { profile: 'bright' } }).success).toBe(
      false,
    );
    expect(
      mapOperationSchema.safeParse({
        ...base,
        colormap: { palette: { lava: { r: 1, g: 1, b: 1 } } },
      }).success,
    ).toBe(false);
    expect(
      mapOperationSchema.safeParse({
        ...base,
        colormap: { palette: { plains: { r: 300, g: 1, b: 1 } } },
      }).success,
    ).toBe(false);
    expect(mapOperationSchema.safeParse({ ...base, colormap: { gamma: 2 } }).success).toBe(false);
  });
});
