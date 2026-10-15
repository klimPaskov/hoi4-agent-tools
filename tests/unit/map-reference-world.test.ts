import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  extractReferenceWorld,
  REFERENCE_TERRAIN,
  type ReferenceWorldOptions,
} from '../../src/hoi4_agent_tools/map/reference-world.js';

type Color = readonly [number, number, number];
const sea: Color = [55, 115, 205];
const land: Color = [180, 210, 145];

async function raster(
  width: number,
  height: number,
  color: (x: number, y: number) => Color,
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const value = color(x, y);
      const pixel = (y * width + x) * 3;
      data[pixel] = value[0];
      data[pixel + 1] = value[1];
      data[pixel + 2] = value[2];
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

const options: ReferenceWorldOptions = {
  width: 40,
  height: 32,
  seed: 19,
  fit: 'stretch',
  mode: 'illustrated',
};
const at = (x: number, y: number) => y * 40 + x;

describe('bounded offline reference-world extraction', () => {
  it('cleans water flecks detached by diagonal coast repairs without changing broad water', async () => {
    const image = await raster(1024, 1024, (x, y) => {
      if (x < 150 || x > 850 || y < 150 || y > 850) return sea;
      if ((x === 500 && y === 500) || (x === 501 && y === 501)) return sea;
      if (x > 600 && x < 640 && y > 600 && y < 640 && !(x === 620 && y === 620)) return sea;
      return land;
    });
    const result = await extractReferenceWorld(image, {
      width: 1024,
      height: 1024,
      seed: 1,
      mode: 'illustrated',
    });
    expect(result.kind[500 * 1024 + 500]).toBe(1);
    expect(result.kind[501 * 1024 + 501]).toBe(1);
    expect(result.kind[100 * 1024 + 100]).toBe(0);
    // Removing a speck within a lake must restore lake pixels, not create an ocean pocket.
    expect(result.kind[620 * 1024 + 620]).toBe(2);
  });
  it('masks aligned gray pencil lettering over water but retains a filled gray island', async () => {
    const image = await raster(160, 80, (x, y) => {
      if (x >= 100 && x <= 125 && y >= 20 && y <= 40) return [110, 110, 110];
      for (const left of [10, 27, 44])
        if (
          x >= left &&
          x <= left + 10 &&
          y >= 20 &&
          y <= 34 &&
          (x <= left + 1 || x >= left + 9 || y >= 33)
        )
          return [110, 110, 110];
      return sea;
    });
    const result = await extractReferenceWorld(image, {
      width: 160,
      height: 80,
      seed: 1,
      fit: 'stretch',
      mode: 'illustrated',
    });
    expect(result.kind[25 * 160 + 10]).toBe(0);
    expect(result.kind[25 * 160 + 27]).toBe(0);
    expect(result.kind[25 * 160 + 44]).toBe(0);
    expect(result.kind[25 * 160 + 110]).toBe(1);
  });

  it('removes isolated paper speckles from illustrated biomes without changing coastlines or explicit terrain', async () => {
    const image = await raster(40, 32, (x, y) => {
      if (x < 5 || x > 34 || y < 5 || y > 26) return sea;
      return (x === 15 || x === 25) && y === 15 ? [250, 250, 250] : [40, 115, 50];
    });
    const result = await extractReferenceWorld(image, {
      ...options,
      annotations: [
        {
          kind: 'snow',
          polygon: [
            { x: 24 / 40, y: 14 / 32 },
            { x: 26 / 40, y: 14 / 32 },
            { x: 26 / 40, y: 16 / 32 },
            { x: 24 / 40, y: 16 / 32 },
          ],
        },
      ],
    });
    expect(result.terrain[at(15, 15)]).toBe(REFERENCE_TERRAIN.forest);
    expect(result.terrain[at(25, 15)]).toBe(REFERENCE_TERRAIN.snow);
    expect(result.kind[at(4, 15)]).toBe(0);
    expect(result.kind[at(5, 15)]).toBe(1);
    expect(
      result.diagnostics.some((message) =>
        message.includes('coastlines and explicit semantic masks were preserved'),
      ),
    ).toBe(true);
  });

  it('treats transparent PNG borders as ocean and preserves opaque snow land', async () => {
    const data = Buffer.alloc(40 * 32 * 4, 255);
    for (let y = 0; y < 32; y += 1)
      for (let x = 0; x < 40; x += 1)
        if (x < 8 || x > 31 || y < 7 || y > 24) data[(y * 40 + x) * 4 + 3] = 0;
    const image = await sharp(data, { raw: { width: 40, height: 32, channels: 4 } })
      .png()
      .toBuffer();
    const result = await extractReferenceWorld(image, options);
    expect(result.kind[at(0, 0)]).toBe(0);
    expect(result.kind[at(5, 16)]).toBe(0);
    expect(result.kind[at(20, 16)]).toBe(1);
    expect(result.terrain[at(20, 16)]).toBe(REFERENCE_TERRAIN.snow);
    expect(result.country[at(0, 0)]).toBe(0);
  });

  it('extracts biome semantics and enclosed lakes without polygonizing the coast', async () => {
    const colors: Color[] = [
      [180, 210, 145],
      [40, 115, 50],
      [225, 190, 80],
      [120, 125, 125],
      [245, 245, 245],
      [20, 20, 20],
      [140, 95, 65],
      [25, 70, 35],
    ];
    const image = await raster(40, 32, (x, y) => {
      if (x < 3 || x > 36 || y < 3 || y > 28) return sea;
      if (x >= 28 && x <= 31 && y >= 22 && y <= 25) return sea;
      if (y > 17) return land;
      return colors[Math.min(7, Math.floor((x - 3) / 4))]!;
    });
    const result = await extractReferenceWorld(image, { ...options, mode: 'satellite' });
    expect(result.kind[at(0, 0)]).toBe(0);
    expect(result.kind[at(30, 24)]).toBe(2);
    expect(result.terrain[at(5, 10)]).toBe(REFERENCE_TERRAIN.plains);
    expect(result.terrain[at(8, 10)]).toBe(REFERENCE_TERRAIN.forest);
    expect(result.terrain[at(12, 10)]).toBe(REFERENCE_TERRAIN.desert);
    expect(result.terrain[at(16, 10)]).toBe(REFERENCE_TERRAIN.mountain);
    expect(result.terrain[at(20, 10)]).toBe(REFERENCE_TERRAIN.snow);
    expect(result.terrain[at(24, 10)]).toBe(REFERENCE_TERRAIN.volcano);
    expect(result.terrain[at(28, 10)]).toBe(REFERENCE_TERRAIN.hills);
    expect(result.terrain[at(32, 10)]).toBe(REFERENCE_TERRAIN.jungle);
    expect(result.elevation[at(16, 10)]).toBeGreaterThan(result.elevation[at(5, 10)]!);
    expect(result.elevation[at(0, 0)]).toBeLessThan(0);
    expect(result.diagnostics.join(' ')).toContain('heuristics');
  });

  it('infers provisional political countries from one flat-color image', async () => {
    const image = await raster(40, 32, (x, y) =>
      x < 3 || x > 36 || y < 3 || y > 28 ? sea : x < 20 ? [230, 155, 70] : [170, 75, 175],
    );
    const result = await extractReferenceWorld(image, { ...options, mode: 'auto' });
    expect(result.inferredCountries).toHaveLength(2);
    expect(result.country[at(10, 10)]).not.toBe(result.country[at(25, 10)]);
    expect(result.country[at(0, 0)]).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('provisional');
  });

  it('floods the paper outside an enclosed sketch coast and warns about visual inference', async () => {
    const image = await raster(40, 32, (x, y) =>
      ((x === 8 || x === 31) && y >= 7 && y <= 24) || ((y === 7 || y === 24) && x >= 8 && x <= 31)
        ? [0, 0, 0]
        : [255, 255, 255],
    );
    const result = await extractReferenceWorld(image, { ...options, mode: 'auto' });
    expect(result.kind[at(1, 1)]).toBe(0);
    expect(result.kind[at(18, 16)]).toBe(1);
    expect(result.diagnostics[0]).toContain('sketch');
  });

  it('uses boundary grayscale as the ocean without assuming a fixed luminance polarity', async () => {
    for (const background of [40, 175]) {
      const image = await raster(40, 32, (x, y) => {
        const value = x > 6 && x < 33 && y > 5 && y < 26 ? 240 - background : background;
        return [value, value, value];
      });
      const result = await extractReferenceWorld(image, { ...options, mode: 'auto' });
      expect(result.kind[at(0, 0)]).toBe(0);
      expect(result.kind[at(18, 16)]).toBe(1);
      expect(result.diagnostics[0]).toContain('grayscale');
    }
  });

  it('traces a visible winding river that joins the sea while preserving a narrow strait', async () => {
    const image = await raster(40, 32, (x, y) => {
      if (x < 4 || x > 35 || y < 3 || y > 28) return sea;
      if ((y === 12 && x >= 4 && x <= 20) || (x === 20 && y >= 12 && y <= 21)) return sea;
      if (y === 25) return sea;
      return land;
    });
    const result = await extractReferenceWorld(image, options);
    expect(result.rivers.length).toBeGreaterThanOrEqual(1);
    expect(result.kind[at(15, 12)]).toBe(1);
    expect(result.kind[at(20, 18)]).toBe(1);
    expect(result.kind[at(19, 25)]).toBe(0);
    const path = result.rivers[0]!;
    for (let index = 1; index < path.length; index += 1)
      expect(
        Math.abs(path[index]!.x - path[index - 1]!.x) +
          Math.abs(path[index]!.y - path[index - 1]!.y),
      ).toBe(1);
  });

  it('normalizes pale pencil hatching surrounded by ocean and preserves broad snow', async () => {
    const image = await raster(40, 32, (x, y) => {
      if (x > 22 && x < 35 && y > 7 && y < 24) return [245, 245, 245];
      if (x === 10) return [225, 230, 230];
      return sea;
    });
    const result = await extractReferenceWorld(image, options);
    expect(result.kind[at(10, 15)]).toBe(0);
    expect(result.kind[at(29, 15)]).toBe(1);
    expect(result.terrain[at(29, 15)]).toBe(REFERENCE_TERRAIN.snow);
    expect(result.diagnostics.join(' ')).toContain('paper-seam');
  });

  it('retains a small island and inlet, repairs only diagonal crossings, and is deterministic', async () => {
    const image = await raster(40, 32, (x, y) =>
      (x >= 10 && x <= 25 && y >= 7 && y <= 25 && !(x === 15 && y <= 14)) || (x === 5 && y === 12)
        ? land
        : sea,
    );
    const first = await extractReferenceWorld(image, options);
    const second = await extractReferenceWorld(image, options);
    expect(first).toEqual(second);
    expect(first.kind[at(5, 12)]).toBe(1);
    expect(first.kind[at(15, 10)]).toBe(0);
    expect(first.kind[at(16, 10)]).toBe(1);
  });

  it('fits without distortion and maps controls from full source coordinates through a crop', async () => {
    const image = await raster(40, 32, () => land);
    const result = await extractReferenceWorld(image, {
      width: 40,
      height: 32,
      seed: 1,
      crop: { x: 10, y: 0, width: 20, height: 32 },
      annotations: [
        {
          kind: 'marsh',
          polygon: [
            { x: 0.3, y: 0.2 },
            { x: 0.5, y: 0.2 },
            { x: 0.5, y: 0.6 },
            { x: 0.3, y: 0.6 },
          ],
        },
      ],
      riverAnnotations: [
        [
          { x: 0.4, y: 0.3 },
          { x: 0.4, y: 0.5 },
        ],
      ],
    });
    expect(result.referenceBounds).toEqual({ x: 10, y: 0, width: 20, height: 32 });
    expect(result.kind[at(0, 15)]).toBe(0);
    expect(result.terrain[at(16, 12)]).toBe(REFERENCE_TERRAIN.marsh);
    expect(result.rivers[0]![0]!.x).toBe(16);
  });

  it('fills explicit annotation masks deterministically and respects semantic palette controls', async () => {
    const image = await raster(40, 32, (x, y) => (x === 15 && y === 15 ? [0, 0, 0] : sea));
    const result = await extractReferenceWorld(image, {
      ...options,
      palette: [
        { kind: 'sea', color: { r: 55, g: 115, b: 205 } },
        { kind: 'volcano', color: { r: 0, g: 0, b: 0 } },
      ],
      ignoreMasks: [
        [
          { x: 0.35, y: 0.4 },
          { x: 0.45, y: 0.4 },
          { x: 0.45, y: 0.6 },
          { x: 0.35, y: 0.6 },
        ],
      ],
    });
    expect(result.kind[at(15, 15)]).toBe(0);
  });

  it('clips supplied rivers to a crop and repairs diagonal crossings including the wrapping seam', async () => {
    const image = await raster(40, 32, (x, y) => ((x + y) % 2 === 0 ? land : sea));
    const result = await extractReferenceWorld(image, {
      ...options,
      riverAnnotations: [
        [
          { x: 0, y: 0.5 },
          { x: 1, y: 0.5 },
        ],
      ],
    });
    expect(result.rivers[0]![0]!.x).toBe(0);
    expect(result.rivers[0]!.at(-1)!.x).toBe(39);
    for (let y = 0; y < 31; y += 1)
      for (let x = 0; x < 40; x += 1) {
        const a = result.kind[at(x, y)];
        const b = result.kind[at((x + 1) % 40, y)];
        const c = result.kind[at(x, y + 1)];
        const d = result.kind[at((x + 1) % 40, y + 1)];
        expect(a === b || a === c || d === b || d === c).toBe(true);
      }
    expect(result.diagnostics.join(' ')).toContain('diagonal');
    const cropped = await extractReferenceWorld(image, {
      ...options,
      crop: { x: 10, y: 0, width: 20, height: 32 },
      riverAnnotations: [
        [
          { x: 0, y: 0.5 },
          { x: 1, y: 0.5 },
        ],
      ],
    });
    expect(cropped.rivers[0]![0]!.x).toBe(0);
    expect(cropped.rivers[0]!.at(-1)!.x).toBe(39);
  });

  it('applies aligned terrain, height, and political layers and refuses misalignment', async () => {
    const image = await raster(40, 32, () => land);
    const terrain = await raster(40, 32, () => [225, 190, 80]);
    const heights = await raster(40, 32, () => [128, 128, 128]);
    const political = await raster(40, 32, (x) => (x < 20 ? [230, 155, 70] : [170, 75, 175]));
    const result = await extractReferenceWorld(image, {
      ...options,
      terrainImageBytes: terrain,
      heightImageBytes: heights,
      politicalImageBytes: political,
    });
    expect(result.terrain[at(10, 10)]).toBe(REFERENCE_TERRAIN.desert);
    expect(result.elevation[at(10, 10)]).toBeCloseTo(128 / 255);
    expect(result.inferredCountries).toHaveLength(2);
    const wrong = await raster(8, 8, () => land);
    await expect(
      extractReferenceWorld(image, { ...options, terrainImageBytes: wrong }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_LAYER_ALIGNMENT' });
  });

  it('creates coherent subtle relief, low snow plains, and continuous land/sea coastal gradients', async () => {
    const width = 128;
    const height = 96;
    const image = await raster(width, height, (x, y) => {
      if (x < 10 || x > 117 || y < 10 || y > 85) return sea;
      if (x >= 50 && x <= 78 && y >= 28 && y <= 70) return [120, 125, 125];
      return [245, 245, 245];
    });
    const result = await extractReferenceWorld(image, {
      width,
      height,
      seed: 13,
      fit: 'stretch',
      mode: 'illustrated',
    });
    const pixel = (x: number, y: number) => y * width + x;
    expect(result.elevation[pixel(24, 40)]).toBeLessThan(0.06);
    expect(result.elevation[pixel(64, 48)]).toBeGreaterThan(0.3);
    expect(result.elevation[pixel(10, 40)]).toBe(0);
    expect(result.elevation[pixel(9, 40)]).toBeCloseTo(0);
    for (let x = 11; x < 16; x += 1)
      expect(result.elevation[pixel(x, 40)]).toBeGreaterThanOrEqual(
        result.elevation[pixel(x - 1, 40)]!,
      );
    let largestDifference = 0;
    for (let y = 15; y < 80; y += 1)
      for (let x = 15; x < 112; x += 1) {
        largestDifference = Math.max(
          largestDifference,
          Math.abs(result.elevation[pixel(x + 1, y)]! - result.elevation[pixel(x, y)]!),
          Math.abs(result.elevation[pixel(x, y + 1)]! - result.elevation[pixel(x, y)]!),
        );
      }
    expect(largestDifference).toBeLessThan(0.065);
    // Broad low plains have no alternating per-pixel height jitter.
    const slopes = Array.from(
      { length: 12 },
      (_, index) =>
        result.elevation[pixel(24 + index, 40)]! - result.elevation[pixel(23 + index, 40)]!,
    );
    expect(Math.max(...slopes) - Math.min(...slopes)).toBeLessThan(0.001);
  });

  it('distinguishes magenta woodland from blue-violet ocean before water classification', async () => {
    const image = await raster(40, 32, (x, y) =>
      x >= 10 && x <= 29 && y >= 7 && y <= 24 ? [190, 85, 220] : [120, 90, 190],
    );
    const result = await extractReferenceWorld(image, options);
    expect(result.kind[at(20, 16)]).toBe(1);
    expect(result.terrain[at(20, 16)]).toBe(REFERENCE_TERRAIN.forest);
    expect(result.kind[at(0, 0)]).toBe(0);
  });

  it('removes sub-province water and land speckles while retaining explicit lake annotations', async () => {
    const width = 2048;
    const height = 512;
    const image = await raster(width, height, (x, y) => {
      if (x === 100 && y === 100) return land;
      if (x === 1000 && y === 200) return sea;
      return x >= 800 && x <= 1200 && y >= 100 && y <= 400 ? land : sea;
    });
    const controls = {
      width,
      height,
      seed: 1,
      fit: 'stretch' as const,
      mode: 'illustrated' as const,
    };
    const cleaned = await extractReferenceWorld(image, controls);
    expect(cleaned.kind[100 * width + 100]).toBe(0);
    expect(cleaned.kind[200 * width + 1000]).toBe(1);
    expect(cleaned.diagnostics.join(' ')).toContain('speckles below 2 target pixels');
    const explicit = await extractReferenceWorld(image, {
      ...controls,
      annotations: [
        {
          kind: 'lake',
          polygon: [
            { x: 1000 / width, y: 200 / height },
            { x: 1001 / width, y: 200 / height },
            { x: 1001 / width, y: 201 / height },
            { x: 1000 / width, y: 201 / height },
          ],
        },
      ],
    });
    expect(explicit.kind[200 * width + 1000]).toBe(2);
  });

  it('preserves explicit interior heights and reports shoreline-only normalization', async () => {
    const width = 80;
    const height = 64;
    const image = await raster(width, height, (x, y) =>
      x < 6 || x > 73 || y < 6 || y > 57 ? sea : land,
    );
    const heightLayer = await raster(width, height, () => [192, 192, 192]);
    const result = await extractReferenceWorld(image, {
      width,
      height,
      seed: 1,
      fit: 'stretch',
      mode: 'illustrated',
      heightImageBytes: heightLayer,
    });
    expect(result.elevation[32 * width + 40]).toBeCloseTo(192 / 255);
    expect(result.elevation[32 * width + 6]).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('interior heights are preserved');
    expect(result.kind[32 * width + 6]).toBe(1);
  });

  it('suppresses aligned hollow ocean lettering and explicit text masks while retaining a solid dark island', async () => {
    const width = 100;
    const height = 48;
    const image = await raster(width, height, (x, y) => {
      if (x >= 78 && x <= 88 && y >= 28 && y <= 37) return [15, 15, 15];
      for (const left of [12, 27, 42, 57])
        if (
          x >= left &&
          x <= left + 8 &&
          y >= 14 &&
          y <= 25 &&
          (x <= left + 1 || x >= left + 7 || y <= 15 || y >= 24)
        )
          return [15, 15, 15];
      return sea;
    });
    const result = await extractReferenceWorld(image, {
      width,
      height,
      seed: 1,
      fit: 'stretch',
      mode: 'illustrated',
    });
    expect(result.kind[14 * width + 12]).toBe(0);
    expect(result.kind[30 * width + 82]).toBe(1);
    expect(result.diagnostics.join(' ')).toContain('lettering-like');
    const rectangle = await raster(40, 32, (x, y) =>
      x >= 10 && x <= 20 && y >= 10 && y <= 15 ? [0, 0, 0] : sea,
    );
    const masked = await extractReferenceWorld(rectangle, {
      ...options,
      ignoreMasks: [
        [
          { x: 0.2, y: 0.25 },
          { x: 0.6, y: 0.25 },
          { x: 0.6, y: 0.6 },
          { x: 0.2, y: 0.6 },
        ],
      ],
    });
    expect(masked.kind[at(15, 12)]).toBe(0);
  });

  it('refuses malformed input, unsafe controls, empty masks, excessive bytes and decoded dimensions', async () => {
    const image = await raster(40, 32, () => land);
    await expect(extractReferenceWorld(Buffer.from('<svg/>'), options)).rejects.toMatchObject({
      code: 'MAP_REFERENCE_IMAGE_BLOCKED',
    });
    await expect(
      extractReferenceWorld(image, { ...options, width: 8192, height: 4096 }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_PIXELS_BLOCKED' });
    await expect(extractReferenceWorld(image, { ...options, seed: -1 })).rejects.toMatchObject({
      code: 'MAP_REFERENCE_OPTIONS_INVALID',
    });
    await expect(
      extractReferenceWorld(image, { ...options, crop: { x: 35, y: 0, width: 10, height: 8 } }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_CROP_INVALID' });
    await expect(
      extractReferenceWorld(image, {
        ...options,
        ignoreMasks: [
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        ],
      }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_EMPTY' });
    await expect(
      extractReferenceWorld(new Uint8Array(64 * 1024 * 1024 + 1), options),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_IMAGE_BLOCKED' });
    const oversized = Buffer.from(image);
    oversized.writeUInt32BE(100_000, 16);
    oversized.writeUInt32BE(100_000, 20);
    await expect(extractReferenceWorld(oversized, options)).rejects.toMatchObject({
      code: 'MAP_REFERENCE_IMAGE_BLOCKED',
    });
  });
});
