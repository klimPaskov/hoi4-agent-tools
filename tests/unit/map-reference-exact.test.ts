import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { readReferenceImageSource } from '../../src/hoi4_agent_tools/core/bounded-source.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { prepareReferenceWorld } from '../../src/hoi4_agent_tools/map/reference-preparation.js';
import {
  extractReferenceWorld,
  REFERENCE_TERRAIN,
  type ReferencePaletteEntry,
} from '../../src/hoi4_agent_tools/map/reference-world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';

type Color = readonly [number, number, number];
const SEA: Color = [20, 60, 200];
const PLAINS: Color = [130, 205, 60];
const FOREST: Color = [20, 120, 40];
const LAKE: Color = [40, 170, 240];
const palette: ReferencePaletteEntry[] = [
  { kind: 'sea', color: { r: 20, g: 60, b: 200 } },
  { kind: 'plains', color: { r: 130, g: 205, b: 60 } },
  { kind: 'forest', color: { r: 20, g: 120, b: 40 } },
  { kind: 'lake', color: { r: 40, g: 170, b: 240 } },
];

async function picture(
  width: number,
  height: number,
  color: (x: number, y: number) => Color,
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const value = color(x, y);
      data.set(value, (y * width + x) * 3);
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** A continent of plains and forest with a lake and a one-pixel sea channel, in a 2:1 frame. */
function layout(width: number, _height: number): (x: number, y: number) => Color {
  const unit = width / 64;
  return (x, y) => {
    const u = x / unit;
    const v = y / unit;
    if (u < 8 || u >= 56 || v < 4 || v >= 28) return SEA;
    if (x >= 32 * unit && x < 32 * unit + 2 && v >= 6 && v < 22) return SEA;
    if (u >= 20 && u < 26 && v >= 10 && v < 16) return LAKE;
    return u < 32 ? PLAINS : FOREST;
  };
}

describe('exact palette references', () => {
  it('keeps every class as painted and keeps thin painted water as water', async () => {
    const width = 128;
    const height = 64;
    const raster = await extractReferenceWorld(
      await picture(width, height, layout(width, height)),
      {
        width,
        height,
        seed: 1,
        fit: 'stretch',
        palette,
        paletteMatch: 'exact',
      },
    );
    const at = (x: number, y: number) => y * width + x;
    expect(raster.kind[at(2, 2)]).toBe(0);
    expect(raster.kind[at(30, 40)]).toBe(1);
    expect(raster.terrain[at(30, 40)]).toBe(REFERENCE_TERRAIN.plains);
    expect(raster.terrain[at(90, 40)]).toBe(REFERENCE_TERRAIN.forest);
    expect(raster.kind[at(46, 26)]).toBe(2);
    // The enclosed two-pixel channel is painted water: it stays water (a lake), never a river.
    expect(raster.kind[at(64, 20)]).not.toBe(1);
    expect(raster.inferredCountries).toEqual([]);
    expect(raster.diagnostics[0]).toContain('exact palette');
  });

  it('names every colour outside the palette with its count and source pixels', async () => {
    const width = 128;
    const height = 64;
    const base = layout(width, height);
    const bytes = await picture(width, height, (x, y) =>
      x >= 40 && x < 43 && y >= 30 && y < 32
        ? [255, 0, 255]
        : x === 100 && y === 50
          ? [1, 2, 3]
          : base(x, y),
    );
    const failure = await extractReferenceWorld(bytes, {
      width,
      height,
      seed: 1,
      fit: 'stretch',
      palette,
      paletteMatch: 'exact',
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'MAP_REFERENCE_PALETTE_UNKNOWN_COLOR',
      details: {
        unknownPixels: 7,
        unknownColors: 2,
        colors: [
          { color: [255, 0, 255], count: 6, samples: expect.arrayContaining([{ x: 40, y: 30 }]) },
          { color: [1, 2, 3], count: 1, samples: [{ x: 100, y: 50 }] },
        ],
      },
    });
  });

  it('refuses an exact match without a palette or with a colour given two kinds', async () => {
    const bytes = await picture(16, 8, () => SEA);
    await expect(
      extractReferenceWorld(bytes, { width: 16, height: 8, seed: 1, paletteMatch: 'exact' }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_PALETTE_REQUIRED' });
    await expect(
      extractReferenceWorld(bytes, {
        width: 16,
        height: 8,
        seed: 1,
        paletteMatch: 'exact',
        palette: [palette[0]!, { kind: 'lake', color: palette[0]!.color }],
      }),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_PALETTE_CONFLICT' });
  });

  it('leaves nearest matching unchanged when paletteMatch is omitted', async () => {
    const width = 128;
    const height = 64;
    const base = layout(width, height);
    const bytes = await picture(width, height, (x, y) =>
      x === 100 && y === 50 ? [22, 118, 44] : base(x, y),
    );
    const options = { width, height, seed: 1, fit: 'stretch' as const, palette };
    const nearest = await extractReferenceWorld(bytes, options);
    const explicit = await extractReferenceWorld(bytes, { ...options, paletteMatch: 'nearest' });
    expect(Buffer.from(explicit.kind)).toEqual(Buffer.from(nearest.kind));
    expect(Buffer.from(explicit.terrain)).toEqual(Buffer.from(nearest.terrain));
  });
});

async function workspace(files: Record<string, Buffer>) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-frame-'));
  const mod = path.join(base, 'mod');
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(mod, relative)), { recursive: true });
    await writeFile(path.join(mod, relative), bytes);
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'reference', name: 'Reference', root: mod }],
    }),
  );
  return resolver;
}

describe('frame-fitted references', () => {
  it('reads a picture larger than 3,072 pixels at the frame resolution without new colours', async () => {
    const width = 4_096;
    const height = 2_048;
    const resolver = await workspace({
      'reference/layout.png': await picture(width, height, layout(width, height)),
    });
    const exact = await readReferenceImageSource(
      resolver,
      'reference',
      'reference/layout.png',
      undefined,
      undefined,
      {
        size: () => ({ width, height }),
        kernel: 'nearest',
      },
    );
    expect([exact.workingWidth, exact.workingHeight]).toEqual([width, height]);
    const legacy = await readReferenceImageSource(resolver, 'reference', 'reference/layout.png');
    expect([legacy.workingWidth, legacy.workingHeight]).toEqual([3_072, 1_536]);

    const reduced = await readReferenceImageSource(
      resolver,
      'reference',
      'reference/layout.png',
      undefined,
      undefined,
      {
        size: () => ({ width: 1_024, height: 512 }),
        kernel: 'nearest',
      },
    );
    const { data } = await sharp(reduced.bytes).raw().toBuffer({ resolveWithObject: true });
    const colours = new Set<number>();
    for (let index = 0; index < data.length; index += 3)
      colours.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!);
    expect(colours.size).toBe(4);
  });

  it('refuses a working copy over the frame pixel ceiling', async () => {
    const resolver = await workspace({ 'reference/small.png': await picture(64, 32, () => SEA) });
    await expect(
      readReferenceImageSource(resolver, 'reference', 'reference/small.png', undefined, undefined, {
        size: () => ({ width: 0, height: 32 }),
        kernel: 'nearest',
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_WORKING_PIXEL_LIMIT' });
  });

  it('imports an exact layout at the frame size and refuses a picture of another shape', async () => {
    const resolver = await workspace({
      'reference/layout.png': await picture(512, 256, layout(512, 256)),
      'reference/square.png': await picture(256, 256, () => SEA),
    });
    const operation = (imagePath: string) =>
      mapOperationSchema.parse({
        id: 'world',
        kind: 'create_world',
        width: 512,
        height: 256,
        reference: { imagePath, palette, paletteMatch: 'exact', fit: 'frame' },
      });
    const loaded = await prepareReferenceWorld(
      resolver,
      'reference',
      operation('reference/layout.png') as never,
    );
    const surface = loaded.prepared.surface;
    expect([surface.width, surface.height]).toEqual([512, 256]);
    expect(surface.referenceBounds).toEqual({ x: 0, y: 0, width: 512, height: 256 });
    expect(surface.kind[40 * 512 + 120]).toBe(1);
    await expect(
      prepareReferenceWorld(resolver, 'reference', operation('reference/square.png') as never),
    ).rejects.toMatchObject({ code: 'MAP_REFERENCE_FRAME_ASPECT' });
  });

  it('rejects frame fitting without a size and exact matching without a palette in the schema', () => {
    expect(
      mapOperationSchema.safeParse({
        id: 'world',
        kind: 'create_world',
        reference: { imagePath: 'reference/layout.png', fit: 'frame' },
      }).success,
    ).toBe(false);
    expect(
      mapOperationSchema.safeParse({
        id: 'world',
        kind: 'create_world',
        width: 512,
        height: 256,
        reference: { imagePath: 'reference/layout.png', paletteMatch: 'exact' },
      }).success,
    ).toBe(false);
  });
});
