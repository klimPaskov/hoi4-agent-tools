import { describe, expect, it } from 'vitest';
import {
  LAKE_BANK_HEIGHTS,
  LAKE_MINIMUM_PIXELS,
  WATER_INTERIOR_HEIGHT,
  landDistanceField,
  lakeHeight,
  normalizeLakes,
  waterAlpha,
  waterColourLevel,
} from '../../src/hoi4_agent_tools/map/water.js';
import { generateWorld } from '../../src/hoi4_agent_tools/map/world.js';
import {
  engineWaterAlpha,
  measureAppearance,
  readHeights,
  readProvinceTypes,
  readTerrainIndices,
} from '../helpers/map-appearance-metrics.js';
import {
  filesOf,
  lakeWorld,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';

describe('water alpha and lake heights', () => {
  it('follows the engine formula: opaque to 91.3, translucent at 93, gone from 95.1', () => {
    expect(waterAlpha(89)).toBe(1);
    expect(waterAlpha(91)).toBe(1);
    expect(waterAlpha(93)).toBeCloseTo(0.555, 2);
    expect(waterAlpha(95.2)).toBe(0);
    expect(waterAlpha(96)).toBe(0);
    for (let height = 80; height < 100; height += 1)
      expect(waterAlpha(height)).toBeCloseTo(engineWaterAlpha(height), 12);
    for (let height = 80; height < 110; height += 1)
      expect(waterAlpha(height + 1)).toBeLessThanOrEqual(waterAlpha(height));
  });

  it('writes the interior at the sea height and only a short translucent bank', () => {
    expect(lakeHeight(1)).toBe(LAKE_BANK_HEIGHTS[0]);
    expect(lakeHeight(2)).toBe(LAKE_BANK_HEIGHTS[1]);
    expect(lakeHeight(3)).toBe(WATER_INTERIOR_HEIGHT);
    expect(lakeHeight(50)).toBe(WATER_INTERIOR_HEIGHT);
    expect(WATER_INTERIOR_HEIGHT).toBe(89);
    // Beyond the bank every pixel draws as fully opaque water.
    expect(waterAlpha(lakeHeight(3))).toBe(1);
  });

  it('measures distance from land through water', () => {
    const kind = new Uint8Array(9 * 3).fill(2);
    for (let y = 0; y < 3; y += 1) kind[y * 9] = 1;
    const distance = landDistanceField(kind, 9, 3);
    expect([...distance.subarray(0, 9)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('lake normalisation', () => {
  function disc(width: number, height: number, cx: number, cy: number, radius: number) {
    const kind = new Uint8Array(width * height).fill(1);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        if (Math.hypot(x - cx, y - cy) <= radius) kind[y * width + x] = 2;
    return kind;
  }

  it('turns enclosed water below the pixel floor into land and reports it', () => {
    const kind = disc(64, 64, 32, 32, 3);
    const elevation = new Float32Array(kind.length).fill(0.1);
    const notes = normalizeLakes(kind, elevation, 64, 64);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ code: 'MAP_LAKE_TOO_SMALL' });
    expect(notes[0]!.pixels).toBeLessThan(LAKE_MINIMUM_PIXELS);
    expect(kind.includes(2)).toBe(false);
    expect(elevation[32 * 64 + 32]).toBeGreaterThanOrEqual(0);
  });

  it('keeps a lake at or above the floor', () => {
    const kind = disc(64, 64, 32, 32, 5);
    const elevation = new Float32Array(kind.length).fill(-0.02);
    expect(normalizeLakes(kind, elevation, 64, 64)).toEqual([]);
    expect(kind[32 * 64 + 32]).toBe(2);
  });

  it('refuses a lake that touches the open sea and writes the water as sea', () => {
    const kind = disc(64, 64, 32, 32, 12);
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 20; x += 1) kind[y * 64 + x] = 0;
    const elevation = new Float32Array(kind.length).fill(-0.02);
    const notes = normalizeLakes(kind, elevation, 64, 64);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ code: 'MAP_LAKE_CONNECTED_TO_SEA' });
    expect(kind.includes(2)).toBe(false);
    expect(kind[32 * 64 + 32]).toBe(0);
    expect(elevation[32 * 64 + 32]).toBeLessThan(0);
  });
});

describe('water colour map', () => {
  function raster() {
    const width = 256;
    const height = 256;
    const kind = new Uint8Array(width * height);
    for (let y = 100; y < 156; y += 1) for (let x = 100; x < 156; x += 1) kind[y * width + x] = 1;
    for (let y = 40; y < 60; y += 1) for (let x = 40; x < 80; x += 1) kind[y * width + x] = 2;
    return { width, height, kind, landDistance: landDistanceField(kind, width, height) };
  }

  it('is brighter over the shelf than in the deep, with a lake tint of its own', () => {
    const input = raster();
    const level = waterColourLevel({ ...input, seed: 3 }, 0);
    const at = (x: number, y: number) => {
      const offset = ((y >> 1) * (input.width >> 1) + (x >> 1)) * 4;
      return {
        r: level[offset + 2]!,
        g: level[offset + 1]!,
        b: level[offset]!,
        a: level[offset + 3]!,
      };
    };
    const shelf = at(98, 128);
    const deep = at(10, 230);
    expect(shelf.b).toBeGreaterThan(deep.b);
    expect(shelf.a).toBe(255);
    const lake = at(60, 50);
    expect(lake.b).toBeGreaterThan(lake.r + 40);
    expect(lake.r).toBeGreaterThan(deep.r);
  });

  it('is deterministic, platform-stable arithmetic and has the three required sizes', () => {
    const input = raster();
    const first = waterColourLevel({ ...input, seed: 3 }, 1);
    const second = waterColourLevel({ ...input, seed: 3 }, 1);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(first).toHaveLength((input.width / 4) * (input.height / 4) * 4);
    expect(Buffer.from(waterColourLevel({ ...input, seed: 4 }, 1)).equals(Buffer.from(first))).toBe(
      false,
    );
  });

  it('darkens toward the deepest tint where the edge policy asks', () => {
    const input = raster();
    const plain = waterColourLevel({ ...input, seed: 3 }, 0);
    const dark = waterColourLevel({ ...input, seed: 3, darken: () => 1 }, 0);
    const sum = (bytes: Uint8Array) =>
      bytes.reduce((total, value, index) => total + (index % 4 === 3 ? 0 : value), 0);
    expect(sum(dark)).toBeLessThan(sum(plain));
  });
});

describe('lakes in a generated world', () => {
  const world = lakeWorld();
  const files = filesOf(world);

  it('writes every lake pixel opaque: interior at 89, bank at most 93, ocean terrain index', () => {
    const types = readProvinceTypes(files);
    const heights = readHeights(files);
    const terrain = readTerrainIndices(files);
    let lake = 0;
    let bank = 0;
    for (let pixel = 0; pixel < types.type.length; pixel += 1) {
      if (types.type[pixel] !== 2) continue;
      lake += 1;
      expect(heights[pixel]).toBeLessThanOrEqual(93);
      if (heights[pixel]! > 91) bank += 1;
      expect(terrain[pixel]).toBe(15);
    }
    expect(lake).toBeGreaterThan(1500);
    expect(bank / lake).toBeLessThan(0.1);
    const metrics = measureAppearance(files);
    expect(metrics.lake.meanAlpha).toBeGreaterThanOrEqual(0.95);
    expect(metrics.lake.heightHistogram['89']).toBeGreaterThan(lake * 0.85);
    expect(metrics.lake.indexHistogram).toEqual({ '15': lake });
  });

  it('never writes the engine-unrendered lake index even when a context declares one', () => {
    const surface = syntheticRaster(256, 256, {
      at: (x, y) =>
        Math.hypot(x - 128, y - 128) <= 24 ? 2 : x > 40 && x < 216 && y > 40 && y < 216 ? 1 : 0,
    });
    const created = generateWorld(worldSpec(surface), {
      ...plainContext,
      terrainIndex: new Map([
        ['ocean', 15],
        ['plains', 0],
      ]),
      unrenderedTerrain: [
        {
          name: 'forest_14',
          index: 14,
          type: 'lakes',
          reason: 'texture = 255 selects no atlas tile',
        },
      ],
    });
    const terrain = readTerrainIndices(filesOf(created));
    expect(terrain.includes(14)).toBe(false);
  });

  it('is deterministic for a seed', () => {
    const again = lakeWorld();
    expect(again.files.map((file) => file.content.toString('base64'))).toEqual(
      world.files.map((file) => file.content.toString('base64')),
    );
  });

  it('writes ocean-coloured lakes and a water colour map that is not flat', () => {
    const metrics = measureAppearance(files);
    expect(metrics.waterColourMap.deviationRgb[2]).toBeGreaterThan(8);
  });

  it('turns a 20 pixel pond into land and reports it with its code', () => {
    const surface = syntheticRaster(256, 256, {
      at: (x, y) =>
        Math.hypot(x - 128, y - 128) <= 2.5 ? 2 : x > 40 && x < 216 && y > 40 && y < 216 ? 1 : 0,
    });
    const created = generateWorld(worldSpec(surface), plainContext);
    expect(created.summary.lakeProvinces).toBe(0);
    expect(created.notes.map(({ code }) => code)).toContain('MAP_LAKE_TOO_SMALL');
  });

  it('writes a lake that touches the sea as sea and reports the refusal', () => {
    const surface = syntheticRaster(256, 256, {
      at: (x, y) => {
        if (Math.hypot(x - 216, y - 128) <= 22) return 2;
        return x > 40 && x < 216 && y > 40 && y < 216 ? 1 : 0;
      },
    });
    const created = generateWorld(worldSpec(surface), plainContext);
    expect(created.notes.map(({ code }) => code)).toContain('MAP_LAKE_CONNECTED_TO_SEA');
    expect(created.summary.lakeProvinces).toBe(0);
  });
});
