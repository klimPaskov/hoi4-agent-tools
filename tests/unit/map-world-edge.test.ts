import { describe, expect, it } from 'vitest';
import { hasBlockingDiagnostics } from '../../src/hoi4_agent_tools/core/diagnostics.js';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import { BmpImage } from '../../src/hoi4_agent_tools/map/bmp.js';
import {
  ambientObjectText,
  applyEdgePolicy,
  assertFeaturesOutsideBand,
  edgeWaterDarkness,
  frameBorderPositions,
  resolveEdge,
  rimAdjacencyRows,
  rimHeight,
  rimStrength,
} from '../../src/hoi4_agent_tools/map/world-edge.js';
import { generateWorld } from '../../src/hoi4_agent_tools/map/world.js';
import {
  measureAppearance,
  readDds32,
  readHeights,
  readTerrainIndices,
} from '../helpers/map-appearance-metrics.js';
import {
  appearanceDiagnostics,
  filesOf,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';

describe('resolving the edge policy', () => {
  it('keeps today’s behaviour without an edge object and defaults to the sea band with one', () => {
    expect(resolveEdge(undefined, 1_024, 512)).toMatchObject({ mode: 'none' });
    expect(resolveEdge({}, 5_120, 2_560)).toEqual({
      mode: 'sea-band',
      bandPx: 205,
      polarPx: 64,
      rimPx: 0,
    });
    expect(resolveEdge({}, 1_024, 512)).toMatchObject({ bandPx: 192, polarPx: 64 });
    expect(resolveEdge({ mode: 'rim' }, 5_120, 2_560)).toMatchObject({
      mode: 'rim',
      rimPx: 160,
      bandPx: 0,
    });
    expect(resolveEdge({ mode: 'none', bandPx: 99 }, 1_024, 512)).toMatchObject({
      mode: 'none',
      bandPx: 0,
    });
  });

  it('scales defaults down on small worlds and rejects a band wider than a quarter', () => {
    expect(resolveEdge({}, 256, 256)).toMatchObject({ bandPx: 64, polarPx: 32 });
    expect(() => resolveEdge({ bandPx: 257 }, 1_024, 512)).toThrow('quarter');
    expect(() => resolveEdge({ mode: 'rim', rimPx: 300 }, 1_024, 512)).toThrow('quarter');
    expect(() => resolveEdge({ polarPx: 200 }, 1_024, 512)).toThrow('quarter');
    try {
      resolveEdge({ bandPx: 2_000 }, 1_024, 512);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'MAP_EDGE_BAND_TOO_WIDE' });
    }
  });
});

describe('clearing land from the edge band', () => {
  const width = 256;
  const height = 128;
  const edge = resolveEdge({ bandPx: 32, polarPx: 12 }, width, height);

  function fullLand() {
    const kind = new Uint8Array(width * height).fill(1);
    const elevation = new Float32Array(width * height).fill(0.2);
    return { kind, elevation };
  }

  it('leaves no land closer to the seam or poles than the band, with a ragged outline', () => {
    const { kind, elevation } = fullLand();
    const result = applyEdgePolicy(kind, elevation, width, height, edge, 7, 40);
    expect(result.clearedLandPixels).toBeGreaterThan(0);
    const firstLand: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < edge.bandPx; x += 1) expect(kind[y * width + x]).toBe(0);
      for (let x = width - edge.bandPx; x < width; x += 1) expect(kind[y * width + x]).toBe(0);
      firstLand.push(kind.subarray(y * width, y * width + width).indexOf(1));
    }
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < edge.polarPx; y += 1) expect(kind[y * width + x]).toBe(0);
      for (let y = height - edge.polarPx; y < height; y += 1) expect(kind[y * width + x]).toBe(0);
    }
    // The outline is not a ruled line: the cleared depth varies between rows.
    const inland = firstLand.filter((x) => x >= 0);
    expect(new Set(inland).size).toBeGreaterThan(3);
    expect(Math.min(...inland)).toBeGreaterThanOrEqual(edge.bandPx);
  });

  it('reports what it cleared and sinks fragments it detached', () => {
    const { kind, elevation } = fullLand();
    // A thin land bridge inside the band joins a small island to the main land.
    kind.fill(0);
    for (let y = 40; y < 90; y += 1) for (let x = 100; x < 200; x += 1) kind[y * width + x] = 1;
    for (let y = 60; y < 64; y += 1) for (let x = 2; x < 100; x += 1) kind[y * width + x] = 1;
    for (let y = 55; y < 70; y += 1) for (let x = 2; x < 12; x += 1) kind[y * width + x] = 1;
    elevation.fill(0.1);
    const result = applyEdgePolicy(kind, elevation, width, height, edge, 7, 4_000);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({ code: 'MAP_EDGE_LAND_CLEARED', severity: 'warning' });
    expect(result.notes[0]!.details).toMatchObject({ mode: 'sea-band' });
    expect(kind[62 * width + 5]).toBe(0);
    // Land that was never connected to the edge is untouched.
    expect(kind[60 * width + 150]).toBe(1);
  });

  it('gives the new coast a shelf and ramps land up from sea level', () => {
    const { kind, elevation } = fullLand();
    applyEdgePolicy(kind, elevation, width, height, edge, 7, 40);
    for (let y = 0; y < height; y += 1) expect(elevation[y * width]).toBeCloseTo(-0.15, 5);
    // A land pixel next to the cut sits at sea level; inland it recovers.
    const row = 64;
    const coast = kind.subarray(row * width, row * width + width).indexOf(1);
    expect(elevation[row * width + coast]).toBeLessThan(0.02);
    expect(elevation[row * width + coast + 40]).toBeGreaterThan(0.15);
  });

  it('is deterministic and a no-op for mode none', () => {
    const a = fullLand();
    const b = fullLand();
    applyEdgePolicy(a.kind, a.elevation, width, height, edge, 7, 40);
    applyEdgePolicy(b.kind, b.elevation, width, height, edge, 7, 40);
    expect(Buffer.from(a.kind).equals(Buffer.from(b.kind))).toBe(true);
    const untouched = fullLand();
    const none = applyEdgePolicy(
      untouched.kind,
      untouched.elevation,
      width,
      height,
      resolveEdge(undefined, width, height),
      7,
      40,
    );
    expect(none).toEqual({ notes: [], clearedLandPixels: 0 });
    expect(untouched.kind.every((value) => value === 1)).toBe(true);
  });
});

describe('features in the band', () => {
  const edge = resolveEdge({ bandPx: 32, polarPx: 12 }, 256, 128);
  it('refuses a city in the band and names it', () => {
    expect(() =>
      assertFeaturesOutsideBand(edge, 256, 128, [
        { name: 'Westhaven', x: 10, y: 60, kind: 'city' },
        { name: 'Inland', x: 120, y: 60, kind: 'city' },
      ]),
    ).toThrow('Westhaven');
    try {
      assertFeaturesOutsideBand(edge, 256, 128, [
        { name: 'Polarport', x: 100, y: 3, kind: 'city' },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'MAP_EDGE_FEATURE_IN_BAND' });
    }
  });

  it('allows sea names in the band and everything for mode none', () => {
    expect(() =>
      assertFeaturesOutsideBand(edge, 256, 128, [{ name: 'Edge Sea', x: 4, y: 4, kind: 'sea' }]),
    ).not.toThrow();
    expect(() =>
      assertFeaturesOutsideBand(resolveEdge(undefined, 256, 128), 256, 128, [
        { name: 'Anywhere', x: 0, y: 0, kind: 'city' },
      ]),
    ).not.toThrow();
  });

  it('is enforced by world generation', () => {
    const surface = syntheticRaster(256, 256, { at: () => 1 });
    expect(() =>
      generateWorld(
        worldSpec(surface, {
          edge: resolveEdge({}, 256, 256),
          referenceCities: [{ name: 'Edgeville', x: 3, y: 100 }],
        }),
        plainContext,
      ),
    ).toThrow('Edgeville');
  });
});

describe('the sea band in a generated world', () => {
  // Land that fills the picture and so touches every edge.
  const surface = syntheticRaster(256, 256, {
    at: (x, y) => (Math.hypot(x - 128, y - 128) <= 20 ? 2 : 1),
  });
  const plain = filesOf(generateWorld(worldSpec(surface), plainContext));
  const banded = generateWorld(
    worldSpec(surface, { edge: resolveEdge({}, 256, 256) }),
    plainContext,
  );

  it('touches the seam without a policy and not with one', () => {
    const before = measureAppearance(plain);
    expect(before.seam.landRowsTouchingSeam).toBe(256);
    const after = measureAppearance(filesOf(banded));
    expect(after.seam.landRowsTouchingSeam).toBe(0);
    expect(after.polar).toEqual({ topColumns: 0, bottomColumns: 0 });
    expect(banded.notes.map(({ code }) => code)).toContain('MAP_EDGE_LAND_CLEARED');
  });

  it('draws the seam as the deepest water and keeps the heights continuous across it', () => {
    const files = filesOf(banded);
    const heights = readHeights(files);
    for (let y = 0; y < 256; y += 1) expect(heights[y * 256]).toBe(heights[y * 256 + 255]);
    const water = readDds32(files.get('map/terrain/colormap_water_0.dds')!);
    const at = (x: number, y: number) => water.rgba[(y * water.width + x) * 4 + 2]!;
    expect(at(0, 64)).toBeLessThanOrEqual(at(20, 64));
  });

  it('writes no frame borders unless asked and the vanilla positions when asked', () => {
    expect(measureAppearance(plain).frameBorders).toEqual([]);
    expect(plain.get('map/ambient_object.txt')!.toString()).toMatch(/^#/u);
    const framed = filesOf(
      generateWorld(
        worldSpec(surface, { ambientFrame: true, edge: resolveEdge({}, 256, 256) }),
        plainContext,
      ),
    );
    expect(measureAppearance(framed).frameBorders).toEqual([
      { type: 'frame_border_entity', z: 256 + 142 },
      { type: 'frame_border_bottom_entity', z: -140 },
      { type: 'frame_border_logo_entity', z: 256 + 82 },
    ]);
  });
});

describe('the frame borders', () => {
  it('scales the base map’s positions to the world size and parses as Clausewitz script', () => {
    expect(frameBorderPositions(5_632, 2_048)).toEqual({
      top: 2_190,
      bottom: -140,
      logoX: 3_000,
      logoZ: 2_130,
    });
    expect(frameBorderPositions(5_120, 2_560)).toMatchObject({
      top: 2_702,
      bottom: -140,
      logoZ: 2_642,
    });
    const text = ambientObjectText(5_120, 2_560);
    const document = parseClausewitz(Buffer.from(text), 'ambient_object.txt');
    expect(hasBlockingDiagnostics(document.diagnostics)).toBe(false);
    expect(document.diagnostics).toEqual([]);
    expect(text).toContain('0 0 2702');
    expect(text).toContain('0 0 -140');
    expect(text.match(/^type=\{/gmu)).toHaveLength(4);
    expect(text).not.toContain('ambient_water');
    expect(ambientObjectText(5_120, 2_560)).toBe(text);
  });
});

describe('the rim wall', () => {
  const width = 256;
  const height = 256;
  const surface = syntheticRaster(width, height, {
    at: (x, y) => (y > 24 && y < 232 ? 1 : 0),
  });
  const spec = worldSpec(surface, { edge: resolveEdge({ mode: 'rim', rimPx: 48 }, width, height) });
  const world = generateWorld(spec, plainContext);
  const files = filesOf(world);

  it('raises snowy mountains toward the seam and darkens the colour map there', () => {
    const heights = readHeights(files);
    const terrain = readTerrainIndices(files);
    const row = 128;
    expect(heights[row * width + 0]).toBeGreaterThanOrEqual(225);
    expect(heights[row * width + width - 1]).toBeGreaterThanOrEqual(225);
    expect(heights[row * width + 100]).toBeLessThan(120);
    expect(terrain[row * width + 4]).toBe(16);
    expect(terrain[row * width + 100]).not.toBe(16);
    const colours = readDds32(files.get('map/terrain/colormap_rgb_cityemissivemask_a.dds')!);
    const value = (x: number) => {
      const offset = (64 * colours.width + x) * 4;
      return Math.max(colours.rgba[offset]!, colours.rgba[offset + 1]!, colours.rgba[offset + 2]!);
    };
    expect(value(1)).toBeLessThan(value(60) * 0.7);
  });

  it('writes exactly one impassable row for every pair of land provinces across the seam', () => {
    const adjacency = files.get('map/adjacencies.csv')!.toString().split('\r\n');
    const rows = adjacency.filter((line) => line.includes(';impassable;'));
    expect(rows.length).toBeGreaterThan(0);
    expect(adjacency.at(-2)).toBe('-1;-1;;-1;-1;-1;-1;-1;-1');
    const provinces = BmpImage.decode(files.get('map/provinces.bmp')!);
    const ids = new Map<string, number>();
    const types = new Map<number, string>();
    for (const line of files.get('map/definition.csv')!.toString().trim().split(/\r?\n/u)) {
      const cells = line.split(';');
      ids.set(`${cells[1]},${cells[2]},${cells[3]}`, Number(cells[0]));
      types.set(Number(cells[0]), cells[4]!);
    }
    const expected = new Set<string>();
    for (let y = 0; y < height; y += 1) {
      const a = provinces.rgbAt(0, y);
      const b = provinces.rgbAt(width - 1, y);
      const left = ids.get(`${a.r},${a.g},${a.b}`)!;
      const right = ids.get(`${b.r},${b.g},${b.b}`)!;
      if (left !== right && types.get(left) === 'land' && types.get(right) === 'land')
        expected.add(`${Math.min(left, right)};${Math.max(left, right)}`);
    }
    expect(new Set(rows.map((row) => row.split(';').slice(0, 2).join(';')))).toEqual(expected);
    expect(rows.every((row) => row.endsWith(';;World rim') || row.endsWith(';World rim'))).toBe(
      true,
    );
    for (const row of rows)
      expect(row.split(';').slice(2, 8)).toEqual(['impassable', '-1', '-1', '-1', '-1', '-1']);
  });

  it('passes the appearance and adjacency validators with the seam pairs reported as blocked', () => {
    const diagnostics = appearanceDiagnostics(files, 'rim');
    expect(diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    const seam = diagnostics.find(({ code }) => code === 'MAP_SEAM_LAND_ADJACENCY');
    expect(seam?.details).toMatchObject({ impassable: seam?.details?.pairs });
    expect(world.notes.map(({ code }) => code)).toContain('MAP_EDGE_RIM_ADJACENCIES');
  });

  it('builds sorted rows from a tiny province raster', () => {
    expect(
      rimAdjacencyRows({
        provincePixels: [2, 0, 0, 1, 3, 0, 0, 1],
        provinceKinds: [1, 1, 1, 0],
        width: 4,
        height: 2,
      }),
    ).toEqual(['2;3;impassable;-1;-1;-1;-1;-1;;World rim']);
  });

  it('shapes the strength and height curves', () => {
    const edge = resolveEdge({ mode: 'rim', rimPx: 48 }, 256, 256);
    expect(rimStrength(edge, 256, 0)).toBe(1);
    expect(rimStrength(edge, 256, 48)).toBe(0);
    expect(rimStrength(edge, 256, 128)).toBe(0);
    expect(rimStrength(resolveEdge({}, 256, 256), 256, 0)).toBe(0);
    expect(rimHeight(100, 0)).toBe(100);
    expect(rimHeight(100, 1)).toBe(230);
    expect(edgeWaterDarkness(resolveEdge(undefined, 256, 256), 256, 256, 0, 0)).toBe(0);
  });
});

describe('seam validators', () => {
  const size = 256;
  function filesWith(
    land: (x: number, y: number) => boolean,
    edge?: Parameters<typeof resolveEdge>[0],
  ) {
    const surface = syntheticRaster(size, size, { at: (x, y) => (land(x, y) ? 1 : 0) });
    return filesOf(
      generateWorld(
        worldSpec(surface, edge === undefined ? {} : { edge: resolveEdge(edge, size, size) }),
        plainContext,
      ),
    );
  }

  it('reports nothing for a world with sea at the seam', () => {
    const files = filesWith((x, y) => x > 60 && x < 190 && y > 40 && y < 200);
    expect(
      appearanceDiagnostics(files).filter(({ code }) => /EDGE|SEAM|POLAR/u.test(code)),
    ).toEqual([]);
  });

  it.each([
    ['one side (west)', (x: number, y: number) => x < 150 && y > 40 && y < 200, 159],
    ['one side (east)', (x: number, y: number) => x > 100 && y > 40 && y < 200, 159],
    [
      'both sides (on different rows)',
      (x: number, y: number) => (x < 90 && y > 40 && y < 110) || (x > 170 && y > 130 && y < 200),
      138,
    ],
  ])('warns about land cut by the seam on %s', (_name, land, rows) => {
    const diagnostics = appearanceDiagnostics(filesWith(land));
    const cut = diagnostics.find(({ code }) => code === 'MAP_EDGE_LAND_CUT');
    expect(cut?.severity).toBe('warning');
    expect(cut?.details).toMatchObject({ rows });
    expect(
      appearanceDiagnostics(filesWith(land), 'sea-band').find(
        ({ code }) => code === 'MAP_EDGE_LAND_CUT',
      )?.severity,
    ).toBe('error');
  });

  it('reports land provinces that meet across the seam and land at the poles as information', () => {
    const files = filesWith(() => true);
    const codes = appearanceDiagnostics(files);
    expect(codes.find(({ code }) => code === 'MAP_SEAM_LAND_ADJACENCY')).toMatchObject({
      severity: 'info',
      details: { impassable: 0 },
    });
    expect(codes.find(({ code }) => code === 'MAP_POLAR_LAND')).toMatchObject({
      severity: 'info',
      details: { top: size, bottom: size },
    });
  });

  it('turns the cut into a clear world when the sea band is requested', () => {
    const files = filesWith(() => true, {});
    expect(
      appearanceDiagnostics(files, 'sea-band').filter(({ code }) => code.includes('EDGE_LAND_CUT')),
    ).toEqual([]);
  });
});
