import { describe, expect, it } from 'vitest';
import { BmpImage, createBmp, rgbKey, type RgbColor } from '../../src/hoi4_agent_tools/map/bmp.js';
import { engineProvinceRaster } from '../../src/hoi4_agent_tools/map/engine-raster.js';
import {
  buildProvinceRaster,
  type ProvinceDefinition,
  type ProvinceRaster,
} from '../../src/hoi4_agent_tools/map/model.js';
import { typeScriptProvinceTopology } from '../../src/hoi4_agent_tools/map/validation.js';

/**
 * The engine's province raster (ADR 0084) against the TypeScript reference: every pixel, every
 * map and set in its iteration order, and the geometry checks. `scripts/map-raster-parity.ts`
 * runs the same comparison on the installed game's and the benchmark mods' maps.
 */

function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

interface World {
  bitmap: BmpImage;
  byColor: Map<string, ProvinceDefinition>;
  byId: Map<number, ProvinceDefinition>;
}

/** Blobby provinces around random seeds, stray pixels, a thin line and undefined colours. */
function world(
  width: number,
  height: number,
  provinces: number,
  seed: number,
  format: 'top-down' | 'bottom-up' | 'palette',
): World {
  const next = random(seed);
  const seeds = Array.from({ length: provinces }, () => ({
    x: Math.floor(next() * width),
    y: Math.floor(next() * height),
  }));
  const colors: RgbColor[] = Array.from({ length: provinces }, (_unused, index) => ({
    r: (index * 37) % 251,
    g: (index * 91) % 241,
    b: 10 + index,
  }));
  const owner = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let best = 0;
      let bestDistance = Infinity;
      for (const [index, point] of seeds.entries()) {
        const dx = Math.min(Math.abs(point.x - x), width - Math.abs(point.x - x));
        const distance = dx * dx + (point.y - y) ** 2 + next() * 6;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      owner[y * width + x] = next() < 0.01 ? Math.floor(next() * provinces) : best;
    }
  for (let x = 2; x < width - 2; x += 1) owner[Math.floor(height / 2) * width + x] = provinces - 1;
  const undefinedColor = { r: 250, g: 1, b: 2 };
  const pixels: RgbColor[] = [...owner].map((index, pixel) =>
    pixel % 97 === 5 ? undefinedColor : colors[index]!,
  );
  const definitions = colors.slice(0, provinces - 1).map(
    (color, index) =>
      ({
        id: index === 0 ? 0 : index,
        color,
        type: index % 3 === 0 ? 'sea' : index % 7 === 0 ? 'lake' : 'land',
        coastal: false,
        terrain: 'plains',
        continent: 1,
        line: index + 1,
      }) as unknown as ProvinceDefinition,
  );
  // The last colour (the thin line) is defined too; the undefined colour is not.
  definitions.push({
    id: provinces - 1,
    color: colors[provinces - 1]!,
    type: 'land',
  } as unknown as ProvinceDefinition);
  const palette = [...colors, undefinedColor];
  const bytes =
    format === 'palette'
      ? createBmp({
          width,
          height,
          bitsPerPixel: 8,
          palette,
          indexedPixels: Uint8Array.from(pixels, (color) => palette.indexOf(color)),
        })
      : createBmp({
          width,
          height,
          bitsPerPixel: 24,
          dibSize: 124,
          topDown: format === 'top-down',
          rgbPixels: pixels,
        });
  return {
    bitmap: BmpImage.decode(bytes),
    byColor: new Map(definitions.map((definition) => [rgbKey(definition.color), definition])),
    byId: new Map(definitions.map((definition) => [definition.id, definition])),
  };
}

function ordered(raster: ProvinceRaster) {
  return {
    width: raster.width,
    height: raster.height,
    provinceIds: [...raster.provinceIds],
    adjacency: [...raster.adjacency].map(([id, others]) => [id, [...others]]),
    seamOnlyPairs: [...(raster.seamOnlyPairs ?? [])],
    geometry: [...raster.geometry],
    unknownColors: raster.unknownColors,
    unknownColorCount: raster.unknownColorCount,
    coastal: [...raster.coastalProvinceIds],
  };
}

describe('engine province raster', () => {
  for (const [label, width, height, provinces, seed, format] of [
    ['a bottom-up map', 96, 48, 40, 3, 'bottom-up'],
    ['a top-down map', 64, 64, 25, 11, 'top-down'],
    ['a palette map', 50, 30, 18, 29, 'palette'],
  ] as const)
    it(`matches the TypeScript raster and geometry checks on ${label}`, () => {
      const { bitmap, byColor, byId } = world(width, height, provinces, seed, format);
      const reference = buildProvinceRaster(bitmap, byColor, byId);
      const engine = engineProvinceRaster(bitmap, byColor, byId);
      expect(ordered(engine)).toEqual(ordered(reference));
      expect(engine.unknownColorCount).toBeGreaterThan(0);
      expect(engine.seamOnlyPairs?.size ?? 0).toBeGreaterThanOrEqual(0);
      const topology = typeScriptProvinceTopology(reference);
      expect([...engine.topology!.components]).toEqual([...topology.components]);
      expect([...engine.topology!.holes]).toEqual([...topology.holes]);
      expect([...engine.topology!.thin]).toEqual([...topology.thin]);
      expect(engine.topology!.thin.size).toBeGreaterThan(0);
    });

  it('names a palette index outside the palette as BmpImage does', () => {
    const bytes = createBmp({
      width: 4,
      height: 2,
      bitsPerPixel: 8,
      palette: [{ r: 1, g: 2, b: 3 }],
      indexedPixels: new Uint8Array(8),
    });
    // The first stored pixel row is the bottom row; break its third pixel.
    const bitmap = BmpImage.decode(bytes);
    bitmap.bytes[bitmap.pixelOffset + 2] = 9;
    const definitions = new Map<string, ProvinceDefinition>();
    expect(() => buildProvinceRaster(bitmap, definitions, new Map())).toThrowError(
      expect.objectContaining({ code: 'MAP_BMP_PALETTE_INDEX_INVALID' }),
    );
    expect(() => engineProvinceRaster(bitmap, definitions, new Map())).toThrowError(
      expect.objectContaining({
        code: 'MAP_BMP_PALETTE_INDEX_INVALID',
        details: { x: 2, y: 1, index: 9 },
      }),
    );
  });
});
