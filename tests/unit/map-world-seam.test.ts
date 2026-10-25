import { describe, expect, it } from 'vitest';
import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';
import { repairSeamCorners } from '../../src/hoi4_agent_tools/map/partition-fields.js';
import type { ReferenceWorldRaster } from '../../src/hoi4_agent_tools/map/reference-world.js';
import { generateWorld, type WorldSpec } from '../../src/hoi4_agent_tools/map/world.js';

const context = {
  palettes: {},
  mapRoot: 'map',
  statesRoot: 'history/states',
  localisationRoot: 'localisation',
};

/**
 * Land below row 100 across the whole width, as a picture whose paper margin reaches both frame
 * edges produced in the map campaign (ZR-4 D2): the coast crosses the east-west seam.
 */
function spec(partition?: WorldSpec['partition'], width = 256, height = 256): WorldSpec {
  const surface: ReferenceWorldRaster = {
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    referenceBounds: { x: 0, y: 0, width, height },
    kind: new Uint8Array(width * height),
    terrain: new Uint8Array(width * height),
    elevation: new Float32Array(width * height).fill(-0.1),
    moisture: new Float32Array(width * height).fill(0.5),
    country: new Uint16Array(width * height),
    rivers: [],
    diagnostics: [],
    inferredCountries: [],
  };
  for (let y = 100; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      surface.kind[y * width + x] = 1;
      surface.elevation[y * width + x] = 0.1;
    }
  return {
    width,
    height,
    seed: 7,
    landCoverage: 0.6,
    continents: 1,
    landProvincePixels: 250,
    seaProvincePixels: 600,
    provincesPerState: 5,
    landProvincesPerRegion: 20,
    seaProvincesPerRegion: 10,
    rivers: 0,
    startDate: '1936.1.1',
    countries: [{ tag: 'AAA', name: 'Plain' }],
    referenceSurface: surface,
    ...(partition === undefined ? {} : { partition }),
  };
}

describe('coasts that cross the east-west seam', () => {
  it('repairs the four-province seam corner with one pixel per crossing', () => {
    const width = 16;
    const height = 8;
    const kind = new Uint8Array(width * height);
    for (let y = 4; y < height; y += 1) kind.fill(1, y * width, (y + 1) * width);
    const changed = repairSeamCorners(kind, width, height);
    expect(changed).toEqual([4 * width]);
    expect(kind[4 * width]).toBe(0);
    expect(kind[4 * width + width - 1]).toBe(1);
    expect(repairSeamCorners(kind, width, height)).toEqual([]);
  });

  it.each([
    ['legacy', undefined],
    ['feature-aware', { mode: 'feature-aware' as const }],
  ])('generates a %s world whose coast crosses the seam', (_name, partition) => {
    const world = generateWorld(spec(partition), context);
    expect(world.notes.map(({ code }) => code)).toContain('MAP_WORLD_SEAM_CORNER_REPAIRED');
    const provinces = BmpImage.decode(
      world.files.find(({ relativePath }) => relativePath === 'map/provinces.bmp')!.content,
    );
    // No 2 x 2 window across the seam holds four provinces.
    for (let y = 0; y + 1 < provinces.height; y += 1) {
      const colours = new Set(
        [
          provinces.rgbAt(provinces.width - 1, y),
          provinces.rgbAt(0, y),
          provinces.rgbAt(provinces.width - 1, y + 1),
          provinces.rgbAt(0, y + 1),
        ].map(({ r, g, b }) => (r << 16) | (g << 8) | b),
      );
      expect(colours.size).toBeLessThan(4);
    }
  });
});

describe('province budget before partitioning', () => {
  /** A world that is land everywhere except a sea border, which small sizes over-divide. */
  function landWorld(sizes: { land?: number; sea?: number }): WorldSpec {
    const base = spec(undefined, 1024, 512);
    const surface = base.referenceSurface!;
    surface.kind.fill(1);
    surface.elevation.fill(0.1);
    for (let x = 0; x < surface.width; x += 1) {
      surface.kind[x] = 0;
      surface.elevation[x] = -0.1;
    }
    return {
      ...base,
      landProvincePixels: sizes.land ?? 20,
      seaProvincePixels: sizes.sea ?? 40,
      provinceSizesDefaulted: sizes.land === undefined && sizes.sea === undefined,
    };
  }

  it('raises defaulted province sizes that would give far more provinces than the base game', () => {
    const world = generateWorld(landWorld({}), context);
    const note = world.notes.find(({ code }) => code === 'MAP_WORLD_PROVINCE_SIZE_RAISED');
    expect(note?.details).toMatchObject({ expectedProvinces: expect.any(Number) });
    expect(Number(note!.details!.landProvincePixels)).toBeGreaterThan(20);
    expect(world.notes.map(({ code }) => code)).not.toContain('MAP_PARTITION_PROVINCE_COUNT_HIGH');
  });

  it('refuses chosen sizes that give more provinces than the text tables allow, before any work', () => {
    expect(() => generateWorld(landWorld({ land: 20, sea: 40 }), context)).toThrowError(
      expect.objectContaining({ code: 'MAP_PARTITION_PROVINCE_COUNT_HIGH' }),
    );
  });
});
