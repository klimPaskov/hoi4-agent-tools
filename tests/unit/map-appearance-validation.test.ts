import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import {
  BmpImage,
  createBmp,
  type IndexedPixelChange,
} from '../../src/hoi4_agent_tools/map/bmp.js';
import { validateMap } from '../../src/hoi4_agent_tools/map/validation.js';
import { readHeights, readProvinceTypes } from '../helpers/map-appearance-metrics.js';
import {
  APPEARANCE_CODE,
  appearanceDiagnostics,
  filesOf,
  indexOfFiles,
  lakeWorld,
} from '../helpers/map-appearance-world.js';

type Files = Map<string, Buffer>;

/** Every graphical index the generator can write, with the lake entry that has no tile. */
const TERRAIN_FILE = `terrain = {
${Array.from({ length: 32 }, (_, index) =>
  index === 14
    ? '  forest_14 = { type = lakes color = { 14 } texture = 255 }'
    : index === 15
      ? '  ocean_15 = { type = ocean color = { 15 } texture = 9 }'
      : `  terrain_${index} = { type = plains color = { ${index} } texture = 1 }`,
).join('\n')}
}
`;

/** A clean generated world with one hand-drawn river on land and the terrain definitions. */
function cleanWorld(): Files {
  const files = filesOf(lakeWorld(256, 256, { colormapProfile: 'calibrated' }, 30));
  files.set('common/terrain/00_terrain.txt', Buffer.from(TERRAIN_FILE));
  const rivers = BmpImage.decode(files.get('map/rivers.bmp')!);
  const changes: IndexedPixelChange[] = [{ x: 60, y: 60, index: 0 }];
  for (let y = 61; y < 90; y += 1) changes.push({ x: 60, y, index: 4 });
  files.set('map/rivers.bmp', rivers.withIndexedChanges(changes).encode());
  return files;
}

function patch(files: Files, name: string, changes: IndexedPixelChange[]): Files {
  const next = new Map(files);
  next.set(name, BmpImage.decode(files.get(name)!).withIndexedChanges(changes).encode());
  return next;
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(({ code }) => code);
}

function find(files: Files, code: string, edgeMode?: 'sea-band' | 'rim' | 'none') {
  return appearanceDiagnostics(files, edgeMode).find((diagnostic) => diagnostic.code === code);
}

describe('a clean generated world', () => {
  it('reports nothing from the appearance validators and passes validation', () => {
    const files = cleanWorld();
    expect(appearanceDiagnostics(files)).toEqual([]);
    const result = validateMap(indexOfFiles(files));
    expect(result.diagnostics.filter(({ code }) => APPEARANCE_CODE.test(code))).toEqual([]);
    expect(result.checks.find(({ id }) => id === 'map-appearance-files')?.passed).toBe(true);
  });

  it('does nothing when the appearance files are absent', () => {
    const files = new Map(cleanWorld());
    for (const name of [...files.keys()])
      if (!/provinces\.bmp|definition\.csv|default\.map/u.test(name)) files.delete(name);
    expect(appearanceDiagnostics(files)).toEqual([]);
  });
});

describe('rivers.bmp', () => {
  const clean = cleanWorld();

  it('blocks a 2 x 2 block of river pixels', () => {
    const files = patch(clean, 'map/rivers.bmp', [
      { x: 61, y: 70, index: 4 },
      { x: 61, y: 71, index: 4 },
    ]);
    expect(find(files, 'MAP_RIVER_BLOCK')).toMatchObject({
      severity: 'error',
      details: { blocks: 1, samples: [{ x: 60, y: 70 }] },
    });
    expect(validateMap(indexOfFiles(files)).passed).toBe(false);
  });

  it('warns about a second source, a missing source, and a stray pixel', () => {
    const two = patch(clean, 'map/rivers.bmp', [{ x: 60, y: 75, index: 0 }]);
    expect(find(two, 'MAP_RIVER_SOURCE_COUNT')?.details).toMatchObject({ withSeveralSources: 1 });
    const none = patch(clean, 'map/rivers.bmp', [{ x: 60, y: 60, index: 4 }]);
    expect(find(none, 'MAP_RIVER_SOURCE_COUNT')?.details).toMatchObject({ withoutSource: 1 });
    const stray = patch(clean, 'map/rivers.bmp', [{ x: 120, y: 120, index: 5 }]);
    expect(find(stray, 'MAP_RIVER_NOT_ORTHOGONAL')).toMatchObject({
      severity: 'warning',
      details: { pixels: 1 },
    });
  });

  it('rejects indices outside 0 to 11, 254 and 255', () => {
    const files = patch(clean, 'map/rivers.bmp', [{ x: 60, y: 80, index: 100 }]);
    expect(find(files, 'MAP_RIVER_INDEX_INVALID')).toMatchObject({
      severity: 'error',
      details: { pixels: 1, samples: [{ x: 60, y: 80, value: 100 }] },
    });
  });

  it('warns when the header declares a palette count the engine distrusts', () => {
    const files = new Map(clean);
    const rivers = Buffer.from(files.get('map/rivers.bmp')!);
    rivers.writeUInt32LE(256, 46);
    files.set('map/rivers.bmp', rivers);
    expect(find(files, 'MAP_RIVER_PALETTE_COUNT')).toMatchObject({
      severity: 'warning',
      details: { colorsUsed: 256 },
    });
  });

  it('refuses a wrong size or depth', () => {
    const small = new Map(clean);
    small.set(
      'map/rivers.bmp',
      createBmp({
        width: 64,
        height: 64,
        bitsPerPixel: 8,
        palette: Array.from({ length: 256 }, (_, index) => ({ r: index, g: index, b: index })),
        indexedPixels: new Uint8Array(64 * 64).fill(255),
        colorsUsed: 0,
      }),
    );
    expect(find(small, 'MAP_RIVER_SIZE')).toMatchObject({
      severity: 'error',
      details: { width: 64, expectedWidth: 256 },
    });
    const rgb = new Map(clean);
    rgb.set(
      'map/rivers.bmp',
      createBmp({
        width: 256,
        height: 256,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: 256 * 256 }, () => ({ r: 0, g: 0, b: 0 })),
      }),
    );
    expect(find(rgb, 'MAP_RIVER_FORMAT')).toMatchObject({ severity: 'error' });
  });

  it('warns about a river pixel on the sea and about a river network that is too dense', () => {
    const types = readProvinceTypes(clean);
    const sea = types.type.indexOf(0);
    const onSea = patch(clean, 'map/rivers.bmp', [
      { x: sea % 256, y: Math.floor(sea / 256), index: 6 },
    ]);
    expect(find(onSea, 'MAP_RIVER_ON_WATER')).toMatchObject({ severity: 'warning' });
    const dense: IndexedPixelChange[] = [];
    for (let y = 0; y < 256; y += 3)
      for (let x = 0; x < 256; x += 1) dense.push({ x, y, index: 5 });
    const files = patch(clean, 'map/rivers.bmp', dense);
    expect(find(files, 'MAP_RIVER_DENSITY')).toMatchObject({ severity: 'warning' });
  });
});

describe('terrain.bmp', () => {
  const clean = cleanWorld();

  it('blocks the index the engine draws nothing for, anywhere', () => {
    const files = patch(clean, 'map/terrain.bmp', [{ x: 100, y: 100, index: 14 }]);
    expect(find(files, 'MAP_LAKE_TEXTURE_UNRENDERED')).toMatchObject({
      severity: 'error',
      details: { indices: [{ index: 14, name: 'forest_14', pixels: 1 }] },
    });
    expect(validateMap(indexOfFiles(files)).passed).toBe(false);
  });

  it('flags indices that no graphical terrain defines, hard only when widespread', () => {
    const few = patch(clean, 'map/terrain.bmp', [{ x: 100, y: 100, index: 200 }]);
    expect(find(few, 'MAP_TERRAIN_BITMAP_INDEX_UNDEFINED')?.severity).toBe('warning');
    const changes: IndexedPixelChange[] = [];
    for (let x = 0; x < 128; x += 1) changes.push({ x, y: 128, index: 200 });
    expect(
      find(patch(clean, 'map/terrain.bmp', changes), 'MAP_TERRAIN_BITMAP_INDEX_UNDEFINED')
        ?.severity,
    ).toBe('error');
  });

  it('refuses a wrong size', () => {
    const files = new Map(clean);
    files.set(
      'map/terrain.bmp',
      createBmp({
        width: 128,
        height: 128,
        bitsPerPixel: 8,
        palette: Array.from({ length: 256 }, (_, index) => ({ r: index, g: 0, b: 0 })),
        indexedPixels: new Uint8Array(128 * 128),
      }),
    );
    expect(find(files, 'MAP_TERRAIN_BITMAP_SIZE')).toMatchObject({ severity: 'error' });
  });
});

describe('heightmap.bmp and lakes', () => {
  const clean = cleanWorld();
  const types = readProvinceTypes(clean);

  it('blocks a lake written at the old translucent height', () => {
    const changes: IndexedPixelChange[] = [];
    for (let pixel = 0; pixel < types.type.length; pixel += 1)
      if (types.type[pixel] === 2)
        changes.push({ x: pixel % 256, y: Math.floor(pixel / 256), index: 93 });
    const files = patch(clean, 'map/heightmap.bmp', changes);
    const error = find(files, 'MAP_LAKE_SURFACE_TOO_HIGH');
    expect(error).toMatchObject({ severity: 'error' });
    expect(error?.details?.pixels).toBeGreaterThan(1000);
    expect(validateMap(indexOfFiles(files)).passed).toBe(false);
  });

  it('only warns about a few translucent lake pixels away from the shore', () => {
    const middle = types.type.indexOf(2) + 40 * 256;
    const files = patch(clean, 'map/heightmap.bmp', [
      { x: 128, y: 128, index: 93 },
      { x: middle % 256, y: Math.floor(middle / 256), index: 90 },
    ]);
    expect(find(files, 'MAP_LAKE_SURFACE_TOO_HIGH')).toMatchObject({ severity: 'warning' });
  });

  it('warns about land below the coast, sea above the surface and a step at the seam', () => {
    const heights = readHeights(clean);
    const landChanges: IndexedPixelChange[] = [];
    const seaChanges: IndexedPixelChange[] = [];
    for (let pixel = 0; pixel < types.type.length; pixel += 1) {
      if (types.type[pixel] === 1 && landChanges.length < 2000)
        landChanges.push({ x: pixel % 256, y: Math.floor(pixel / 256), index: 90 });
      if (types.type[pixel] === 0 && seaChanges.length < 2000)
        seaChanges.push({ x: pixel % 256, y: Math.floor(pixel / 256), index: 100 });
    }
    expect(
      find(patch(clean, 'map/heightmap.bmp', landChanges), 'MAP_HEIGHT_LAND_BELOW_COAST'),
    ).toBeDefined();
    expect(
      find(patch(clean, 'map/heightmap.bmp', seaChanges), 'MAP_HEIGHT_SEA_ABOVE_SURFACE'),
    ).toBeDefined();
    const seam = patch(
      clean,
      'map/heightmap.bmp',
      Array.from({ length: 40 }, (_, y) => ({ x: 0, y, index: heights[y * 256 + 255]! + 12 })),
    );
    expect(find(seam, 'MAP_HEIGHT_SEAM_STEP')).toMatchObject({ details: { rows: 40 } });
  });

  it('refuses a heightmap of the wrong size', () => {
    const files = new Map(clean);
    files.set(
      'map/heightmap.bmp',
      createBmp({
        width: 128,
        height: 128,
        bitsPerPixel: 8,
        palette: Array.from({ length: 256 }, (_, index) => ({ r: index, g: index, b: index })),
        indexedPixels: new Uint8Array(128 * 128).fill(89),
      }),
    );
    expect(find(files, 'MAP_HEIGHT_SIZE')).toMatchObject({ severity: 'error' });
  });
});

describe('lake provinces', () => {
  /** A 128 x 128 map: sea, a land block, and lakes of chosen sizes. */
  function lakeMap(
    lakes: ReadonlyArray<{ x: number; y: number; size: number; touchesSea?: boolean }>,
  ): Files {
    const sea = { r: 0, g: 0, b: 200 };
    const land = { r: 0, g: 160, b: 0 };
    const lake = (index: number) => ({ r: 90 + index, g: 90, b: 250 });
    const pixels = Array.from({ length: 256 * 256 }, () => sea);
    for (let y = 60; y < 200; y += 1) for (let x = 60; x < 200; x += 1) pixels[y * 256 + x] = land;
    for (const [index, item] of lakes.entries())
      for (let dy = 0; dy < item.size; dy += 1)
        for (let dx = 0; dx < item.size; dx += 1)
          pixels[(item.y + dy) * 256 + item.x + dx] = lake(index);
    const rows = [
      '0;0;0;0;land;false;unknown;0',
      '1;0;0;200;sea;false;ocean;0',
      '2;0;160;0;land;false;plains;1',
      ...lakes.map((_, index) => `${3 + index};${90 + index};90;250;lake;false;lakes;0`),
    ];
    return new Map([
      [
        'map/provinces.bmp',
        createBmp({ width: 256, height: 256, bitsPerPixel: 24, rgbPixels: pixels }),
      ],
      ['map/definition.csv', Buffer.from(`${rows.join('\r\n')}\r\n`)],
    ]);
  }

  it('warns about a lake below 60 pixels, naming its province', () => {
    const files = lakeMap([{ x: 100, y: 100, size: 7 }]);
    expect(find(files, 'MAP_LAKE_TOO_SMALL')).toMatchObject({
      severity: 'warning',
      details: { provinceId: 3, pixels: 49 },
    });
  });

  it('accepts a lake of 60 pixels or more, counting adjacent lake provinces together', () => {
    expect(codes(appearanceDiagnostics(lakeMap([{ x: 100, y: 100, size: 8 }])))).not.toContain(
      'MAP_LAKE_TOO_SMALL',
    );
    // Two touching 6 x 6 lake provinces make one lake body of 72 pixels.
    const files = lakeMap([{ x: 100, y: 100, size: 6 }]);
    const pixels = BmpImage.decode(files.get('map/provinces.bmp')!);
    const two = pixels.withRgbChanges(
      Array.from({ length: 36 }, (_, index) => ({
        x: 106 + (index % 6),
        y: 100 + Math.floor(index / 6),
        color: { r: 91, g: 90, b: 250 },
      })),
    );
    files.set('map/provinces.bmp', two.encode());
    files.set(
      'map/definition.csv',
      Buffer.from(
        `${[
          '0;0;0;0;land;false;unknown;0',
          '1;0;0;200;sea;false;ocean;0',
          '2;0;160;0;land;false;plains;1',
          '3;90;90;250;lake;false;lakes;0',
          '4;91;90;250;lake;false;lakes;0',
        ].join('\r\n')}\r\n`,
      ),
    );
    expect(codes(appearanceDiagnostics(files))).not.toContain('MAP_LAKE_TOO_SMALL');
  });

  it('reports a lake that touches the sea', () => {
    const files = lakeMap([{ x: 50, y: 100, size: 20 }]);
    expect(find(files, 'MAP_LAKE_CONNECTED_TO_SEA')).toMatchObject({
      details: { lakeProvinceId: 3, seaProvinceId: 1 },
    });
    const enclosed = lakeMap([{ x: 100, y: 100, size: 20 }]);
    expect(codes(appearanceDiagnostics(enclosed))).not.toContain('MAP_LAKE_CONNECTED_TO_SEA');
  });
});

describe('trees.bmp, normals and cities', () => {
  const clean = cleanWorld();
  const treeSize = Math.round((256 * 75) / 256);

  it('refuses a tree bitmap of the wrong size and indices beyond its palette', () => {
    const wrong = new Map(clean);
    wrong.set(
      'map/trees.bmp',
      createBmp({
        width: 32,
        height: 32,
        bitsPerPixel: 8,
        palette: Array.from({ length: 40 }, (_, index) => ({ r: index, g: 0, b: 0 })),
        indexedPixels: new Uint8Array(32 * 32),
      }),
    );
    expect(find(wrong, 'MAP_TREES_SIZE')).toMatchObject({
      severity: 'error',
      details: { width: 32, expectedWidth: treeSize },
    });
    const bad = new Map(clean);
    const trees = createBmp({
      width: treeSize,
      height: treeSize,
      bitsPerPixel: 8,
      palette: Array.from({ length: 256 }, (_, index) => ({ r: index, g: 0, b: 0 })),
      indexedPixels: new Uint8Array(treeSize * treeSize).map((_, i) => (i === 5 ? 200 : 0)),
    });
    // Declare only 40 palette colours; index 200 then names no tree mesh.
    trees.writeUInt32LE(40, 46);
    bad.set('map/trees.bmp', trees);
    expect(find(bad, 'MAP_TREES_INDEX_INVALID')).toMatchObject({
      severity: 'error',
      details: { cells: 1 },
    });
  });

  it('warns about trees standing over open water', () => {
    const files = new Map(clean);
    const trees = BmpImage.decode(files.get('map/trees.bmp')!);
    const changes: IndexedPixelChange[] = [];
    for (let y = 0; y < 14; y += 1)
      for (let x = 0; x < treeSize; x += 1) changes.push({ x, y, index: 5 });
    files.set('map/trees.bmp', trees.withIndexedChanges(changes).encode());
    expect(find(files, 'MAP_TREES_ON_WATER')).toMatchObject({ severity: 'warning' });
  });

  it('refuses a wrong normal map size, warns about non-unit normals and a missing response', () => {
    const wrong = new Map(clean);
    wrong.set(
      'map/world_normal.bmp',
      createBmp({
        width: 256,
        height: 256,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: 256 * 256 }, () => ({ r: 128, g: 128, b: 255 })),
      }),
    );
    expect(find(wrong, 'MAP_NORMAL_SIZE')).toMatchObject({ severity: 'error' });
    const dark = new Map(clean);
    dark.set(
      'map/world_normal.bmp',
      createBmp({
        width: 128,
        height: 128,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: 128 * 128 }, () => ({ r: 0, g: 0, b: 0 })),
      }),
    );
    expect(find(dark, 'MAP_NORMAL_NOT_UNIT')).toMatchObject({ severity: 'warning' });
    // Strong relief with a flat normal map.
    const ramp = patch(
      clean,
      'map/heightmap.bmp',
      Array.from({ length: 256 * 256 }, (_, pixel) => ({
        x: pixel % 256,
        y: Math.floor(pixel / 256),
        index: 96 + ((pixel % 256) >> 1),
      })),
    );
    ramp.set(
      'map/world_normal.bmp',
      createBmp({
        width: 128,
        height: 128,
        bitsPerPixel: 24,
        rgbPixels: Array.from({ length: 128 * 128 }, () => ({ r: 128, g: 128, b: 255 })),
      }),
    );
    expect(find(ramp, 'MAP_NORMAL_RESPONSE')).toMatchObject({ severity: 'warning' });
  });

  it('refuses a city bitmap of the wrong size and flags undefined city styles', () => {
    const wrong = new Map(clean);
    wrong.set(
      'map/cities.bmp',
      createBmp({
        width: 64,
        height: 64,
        bitsPerPixel: 8,
        palette: Array.from({ length: 256 }, (_, index) => ({ r: index, g: index, b: index })),
        indexedPixels: new Uint8Array(64 * 64),
      }),
    );
    expect(find(wrong, 'MAP_CITIES_SIZE')).toMatchObject({ severity: 'error' });
    const styled = patch(clean, 'map/cities.bmp', [{ x: 100, y: 100, index: 3 }]);
    styled.set(
      'map/cities.txt',
      Buffer.from('city_group = { color_index = 15 }\ncity_group = { color_index = 0 }\n'),
    );
    expect(find(styled, 'MAP_CITIES_INDEX_UNDEFINED')).toMatchObject({
      severity: 'warning',
      details: { indices: [3] },
    });
  });
});

describe('bounded work on a large map', () => {
  /** A raw uncompressed BMP written without per-pixel objects. */
  function rawBmp(width: number, height: number, bits: 8 | 24, fill: number): Buffer {
    const stride = Math.ceil((width * bits) / 32) * 4;
    const paletteBytes = bits === 8 ? 256 * 4 : 0;
    const header = Buffer.alloc(54 + paletteBytes);
    header.write('BM', 0, 'ascii');
    header.writeUInt32LE(54 + paletteBytes + stride * height, 2);
    header.writeUInt32LE(54 + paletteBytes, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(width, 18);
    header.writeInt32LE(-height, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(bits, 28);
    header.writeUInt32LE(0, 46);
    for (let index = 0; bits === 8 && index < 256; index += 1) {
      header[54 + index * 4] = index;
      header[55 + index * 4] = index;
      header[56 + index * 4] = index;
    }
    return Buffer.concat([header, Buffer.alloc(stride * height, fill)]);
  }

  it('validates a 4,096 by 2,048 map in row strips without holding per-pixel objects', () => {
    const width = 4_096;
    const height = 2_048;
    const files: Files = new Map([
      ['map/provinces.bmp', rawBmp(width, height, 24, 200)],
      [
        'map/definition.csv',
        Buffer.from('0;0;0;0;land;false;unknown;0\r\n1;200;200;200;sea;false;ocean;0\r\n'),
      ],
      ['map/heightmap.bmp', rawBmp(width, height, 8, 89)],
      ['map/rivers.bmp', rawBmp(width, height, 8, 254)],
      ['map/terrain.bmp', rawBmp(width, height, 8, 15)],
    ]);
    const index = indexOfFiles(files);
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const result = validateMap(index);
    const heapGrowth = process.memoryUsage().heapUsed - before;
    expect(result.diagnostics.filter(({ code }) => APPEARANCE_CODE.test(code))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(120_000);
    // Typed arrays live outside the JS heap; per-pixel objects would grow it by gigabytes.
    expect(heapGrowth).toBeLessThan(400 * 1024 * 1024);
  }, 240_000);
});
