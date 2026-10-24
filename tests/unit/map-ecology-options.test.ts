import { describe, expect, it } from 'vitest';
import { createBmp } from '../../src/hoi4_agent_tools/map/bmp.js';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import { geographyModelSchema } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { climateGeography } from '../helpers/climate-fixture.js';
import { appearanceDiagnostics, filesOf, lakeWorld } from '../helpers/map-appearance-world.js';
import { reliefGeography } from '../helpers/relief-fixture.js';

describe('request schema', () => {
  const operation = (extra: Record<string, unknown>) =>
    mapOperationSchema.safeParse({ id: 'w', kind: 'create_world', ...extra });

  it('accepts the solved colour map profile, generated seasons and the new palette classes', () => {
    expect(operation({ colormap: { profile: 'solved' } }).success).toBe(true);
    expect(operation({ seasons: 'generated' }).success).toBe(true);
    expect(operation({ seasons: 'vanilla' }).success).toBe(true);
    expect(
      operation({
        look: 'custom',
        colormap: {
          profile: 'solved',
          palette: { steppe: { r: 160, g: 150, b: 90 }, tundra: { r: 110, g: 112, b: 100 } },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown profile, an unknown season mode and an unknown palette class', () => {
    expect(operation({ colormap: { profile: 'exact' } }).success).toBe(false);
    expect(operation({ seasons: 'always' }).success).toBe(false);
    expect(operation({ colormap: { palette: { savanna: { r: 1, g: 2, b: 3 } } } }).success).toBe(
      false,
    );
  });

  it('accepts a city style on a region from 0 to 255 and rejects anything else', () => {
    const model = (cityStyle: unknown) =>
      geographyModelSchema.safeParse({ version: 1, regions: [{ id: 'r', cityStyle }] });
    expect(model(0).success).toBe(true);
    expect(model(255).success).toBe(true);
    expect(model(256).success).toBe(false);
    expect(model(-1).success).toBe(false);
    expect(model(1.5).success).toBe(false);
    expect(model('1').success).toBe(false);
  });

  it('puts a region city style into the canonical hash of the resolved model', () => {
    const frame = { width: 2048, height: 1024 };
    const base = resolveGeography(climateGeography(), { frame, hasReference: false }).geography;
    const changed = climateGeography();
    changed.regions![0]!.cityStyle = 2;
    const other = resolveGeography(changed, { frame, hasReference: false }).geography;
    expect(other.hash).not.toBe(base.hash);
    expect(other.get('region', 'heartland')!.cityStyle).toBe(2);
    // The same style spelled the same way hashes the same, whatever the feature order.
    const reordered = climateGeography();
    reordered.biomes!.reverse();
    expect(resolveGeography(reordered, { frame, hasReference: false }).geography.hash).toBe(
      base.hash,
    );
  });
});

describe('inspection of the colour the shader would show', () => {
  it('warns when a flat bright colour map would render the land pale', () => {
    const legacy = filesOf(lakeWorld(256, 256, { colormapProfile: 'legacy' }));
    const findings = appearanceDiagnostics(legacy);
    const albedo = findings.find(({ code }) => code === 'MAP_COLORMAP_ALBEDO_RANGE')!;
    expect(albedo).toBeDefined();
    expect(albedo.severity).toBe('warning');
    expect(albedo.message).toContain('not a game screenshot');
  });

  it('is quiet about a calibrated and about a solved colour map', () => {
    for (const colormapProfile of ['calibrated', 'solved'] as const) {
      const findings = appearanceDiagnostics(filesOf(lakeWorld(256, 256, { colormapProfile })));
      expect(findings.map(({ code }) => code)).not.toContain('MAP_COLORMAP_ALBEDO_RANGE');
    }
  });

  it('notes a terrain bitmap that draws one index on nearly all the land', () => {
    const files = filesOf(lakeWorld(256, 256, { colormapProfile: 'solved' }));
    const flat = createBmp({
      width: 256,
      height: 256,
      bitsPerPixel: 8,
      palette: Array.from({ length: 256 }, (_, index) => ({ r: index, g: 128, b: 255 - index })),
      indexedPixels: new Uint8Array(256 * 256).fill(0),
    });
    files.set('map/terrain.bmp', flat);
    const note = appearanceDiagnostics(files).find(
      ({ code }) => code === 'MAP_TERRAIN_BITMAP_DOMINATED',
    )!;
    expect(note).toBeDefined();
    expect(note.severity).toBe('info');
    // The generated terrain bitmap itself varies.
    const varied = appearanceDiagnostics(
      filesOf(lakeWorld(256, 256, { colormapProfile: 'solved' })),
    );
    expect(varied.map(({ code }) => code)).not.toContain('MAP_TERRAIN_BITMAP_DOMINATED');
  });
});

describe('a geography without ecology declarations', () => {
  it('still gets the climate stage with default values and says so', async () => {
    const { generateWorld } = await import('../../src/hoi4_agent_tools/map/world.js');
    const { plainContext } = await import('../helpers/map-appearance-world.js');
    const geography = resolveGeography(reliefGeography(), {
      frame: { width: 1024, height: 512 },
      hasReference: false,
    }).geography;
    const world = generateWorld(
      {
        width: 1024,
        height: 512,
        seed: 7,
        landCoverage: 0.4,
        continents: 1,
        landProvincePixels: 3_000,
        seaProvincePixels: 12_000,
        provincesPerState: 6,
        landProvincesPerRegion: 30,
        seaProvincesPerRegion: 10,
        rivers: 0,
        startDate: '1936.1.1',
        countries: [{ tag: 'AAA', name: 'Alpha' }],
        geography,
      },
      plainContext,
    );
    const climate = world.notes.find(({ code }) => code === 'MAP_CLIMATE_SYNTHESIZED')!;
    expect(climate.message).toContain('defaults apply');
    expect(world.ecology).toBeDefined();
    // No colour profile was asked for: legacy, so no solver statistics and no seasons file.
    expect(world.ecology!.colour).toBeUndefined();
    expect(filesOf(world).has('map/seasons.txt')).toBe(false);
  }, 120_000);
});
