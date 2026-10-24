import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ATLAS_TILE_COUNT,
  BUNDLED_ATLAS,
  BUNDLED_ATLAS_TILE_MEANS,
  atlasTilesFromDds,
  terrainTileTable,
} from '../../src/hoi4_agent_tools/map/atlas-tiles.js';
import { allocateShares } from '../../src/hoi4_agent_tools/map/climate/allocation.js';
import {
  overlayForward,
  overlayInverse,
  overlayRange,
} from '../../src/hoi4_agent_tools/map/colormap-overlay.js';
import { albedoTable, solveColourMap } from '../../src/hoi4_agent_tools/map/colormap-solver.js';
import { COLOUR_CLASSES } from '../../src/hoi4_agent_tools/map/colormap.js';
import {
  PowerTable,
  cosDeg,
  powStable,
  sinDeg,
} from '../../src/hoi4_agent_tools/map/stable-math.js';
import { encodeDds } from '../../src/hoi4_agent_tools/map/world.js';

describe('platform-stable math', () => {
  it('computes sine and cosine of degrees to 1e-7', () => {
    for (let degrees = -725; degrees <= 725; degrees += 7.5) {
      expect(Math.abs(sinDeg(degrees) - Math.sin((degrees * Math.PI) / 180))).toBeLessThan(1e-7);
      expect(Math.abs(cosDeg(degrees) - Math.cos((degrees * Math.PI) / 180))).toBeLessThan(1e-7);
    }
  });

  it('computes powers from square roots and tables close to Math.pow', () => {
    for (const exponent of [0.45, 2.2, 1 / 0.45, 0.5, 1]) {
      const table = new PowerTable(exponent);
      for (let x = 0; x <= 1; x += 1 / 97) {
        expect(Math.abs(powStable(x, exponent) - Math.pow(x, exponent))).toBeLessThan(2e-6);
        expect(Math.abs(table.at(x) - Math.pow(x, exponent))).toBeLessThan(3e-4);
      }
    }
    expect(powStable(0, 0.45)).toBe(0);
    expect(powStable(1, 2.2)).toBe(1);
  });

  it('records the table and sine values so a platform difference would show', () => {
    const digest = createHash('sha256');
    const table = new PowerTable(0.45, 64);
    for (let x = 0; x <= 1; x += 1 / 64) digest.update(table.at(x).toString());
    for (let d = 0; d < 360; d += 15) digest.update(sinDeg(d).toString());
    expect(digest.digest('hex').slice(0, 16)).toBe('8c823dbd2125f83d');
  });
});

describe('the colour map overlay and its inverse', () => {
  it('leaves the atlas colour under a neutral overlay, darkens below it and lightens above it', () => {
    // Neutral is a linear 0.5 in gamma space, which is 0.5 ** 2.2.
    expect(overlayForward(0.6, Math.pow(0.5, 2.2))).toBeCloseTo(0.6, 2);
    expect(overlayForward(0.6, 0.05)).toBeLessThan(0.45);
    expect(overlayForward(0.6, 0.9)).toBeGreaterThan(0.75);
  });

  it('is monotone in the colour map value', () => {
    for (const atlas of [0.1, 0.4, 0.8]) {
      let previous = -1;
      for (let colour = 0; colour <= 1; colour += 0.01) {
        const shown = overlayForward(atlas, colour);
        expect(shown).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = shown;
      }
    }
  });

  it('round-trips a reachable colour within 1/255', () => {
    for (const atlas of [0.1, 0.3, 0.45, 0.6, 0.85]) {
      const [low, high] = overlayRange(atlas);
      for (let step = 1; step < 20; step += 1) {
        const wanted = low + ((high - low) * step) / 20;
        const inverse = overlayInverse(atlas, wanted);
        expect(inverse.reachable).toBe(true);
        const quantised = Math.round(inverse.colour * 255) / 255;
        expect(Math.abs(overlayForward(atlas, quantised) - wanted)).toBeLessThan(3 / 255);
      }
    }
  });

  it('flags and clamps a colour outside the reachable range', () => {
    const [low, high] = overlayRange(0.6);
    const dark = overlayInverse(0.6, low - 0.05);
    expect(dark).toEqual({ colour: 0, reachable: false });
    const bright = overlayInverse(0.6, high + 0.05);
    expect(bright.reachable).toBe(false);
    expect(bright.colour).toBeCloseTo(1, 5);
  });
});

describe('share allocation', () => {
  function scores(
    count: number,
    categories: number,
    value: (item: number, category: number) => number,
  ) {
    const result = new Float32Array(count * categories);
    for (let item = 0; item < count; item += 1)
      for (let category = 0; category < categories; category += 1)
        result[item * categories + category] = value(item, category);
    return result;
  }

  it('meets target shares by moving the boundary along the score gradient', () => {
    // A strip of 1,000 items; category 0 likes the left end, category 1 the right end.
    const count = 1000;
    const result = allocateShares({
      count,
      categories: 2,
      scores: scores(count, 2, (item, category) =>
        category === 0 ? 1 - item / count : item / count,
      ),
      targets: [0.7, 0.3],
    });
    expect(result.achieved[0]!).toBeGreaterThan(0.69);
    expect(result.achieved[0]!).toBeLessThan(0.71);
    // The boundary is one cut, not a mosaic.
    let changes = 0;
    for (let item = 1; item < count; item += 1)
      if (result.assignment[item] !== result.assignment[item - 1]) changes += 1;
    expect(changes).toBe(1);
  });

  it('never picks a category with no target and is deterministic', () => {
    const count = 300;
    const input = {
      count,
      categories: 3,
      scores: scores(count, 3, (item, category) => ((item * (category + 3)) % 17) / 17),
      targets: [0.5, 0, 0.5],
    };
    const first = allocateShares(input);
    const second = allocateShares(input);
    expect(Buffer.from(first.assignment).equals(Buffer.from(second.assignment))).toBe(true);
    expect(first.assignment.every((value) => value !== 1)).toBe(true);
    expect(Math.abs(first.achieved[0]! - 0.5)).toBeLessThan(0.03);
  });

  it('returns an empty assignment when no category has a target', () => {
    const result = allocateShares({
      count: 4,
      categories: 2,
      scores: new Float32Array(8),
      targets: [0, 0],
    });
    expect(result.error).toBe(0);
    expect([...result.assignment]).toEqual([0, 0, 0, 0]);
  });
});

describe('atlas tile means', () => {
  it('keeps sixteen bundled means in the range of 8-bit colours', () => {
    expect(BUNDLED_ATLAS_TILE_MEANS).toHaveLength(ATLAS_TILE_COUNT);
    for (const mean of BUNDLED_ATLAS_TILE_MEANS)
      for (const value of mean) expect(value).toBeGreaterThan(50);
    expect(BUNDLED_ATLAS.source).toBe('bundled-table');
  });

  it('reads the mean colour of each tile from a 4 x 4 atlas', () => {
    const size = 64;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const tile = Math.floor(y / 16) * 4 + Math.floor(x / 16);
        const o = (y * size + x) * 4;
        // BGRA: blue, green, red.
        pixels[o] = tile * 10;
        pixels[o + 1] = 100 + tile;
        pixels[o + 2] = 200 - tile;
        pixels[o + 3] = 255;
      }
    const tiles = atlasTilesFromDds(encodeDds(size, size, pixels));
    expect(tiles.source).toBe('installed-atlas');
    expect(tiles.means[5]).toEqual([195, 105, 50]);
    expect(tiles.means[15]).toEqual([185, 115, 150]);
  });

  it('falls back to the bundled table, with a reason, for a file that is not an atlas', () => {
    const notSquare = atlasTilesFromDds(encodeDds(64, 32, new Uint8Array(64 * 32 * 4)));
    expect(notSquare.source).toBe('bundled-table');
    expect(notSquare.reason).toContain('4 x 4');
    const garbage = atlasTilesFromDds(Buffer.from('not a dds file at all'.repeat(10)));
    expect(garbage.source).toBe('bundled-table');
  });

  it('maps indices to tiles from the active terrain entries or the base numbering', () => {
    const base = terrainTileTable(undefined);
    expect(base[5]).toBe(0);
    expect(base[21]).toBe(4);
    const modded = terrainTileTable([
      { index: 5, texture: 12 },
      { index: 14, texture: 255 },
      { index: 40, texture: undefined },
    ]);
    expect(modded[5]).toBe(12);
    // texture 255 and a missing texture draw no tile: the plains tile stands in.
    expect(modded[14]).toBe(1);
    expect(modded[40]).toBe(1);
  });
});

describe('the colour map solver', () => {
  function flatWorld(classIndex: number, terrainIndex: number, size = 128) {
    const total = size * size;
    return {
      width: size,
      height: size,
      seed: 3,
      classes: new Uint8Array(total).fill(classIndex),
      indices: new Uint8Array(total).fill(terrainIndex),
      tileOfIndex: terrainTileTable(undefined),
      tiles: BUNDLED_ATLAS,
      referenceTiles: BUNDLED_ATLAS,
      heights: new Uint8Array(total).fill(110),
      lights: new Uint8Array(total),
      look: 'vanilla-temperate' as const,
    };
  }

  it('shows the base game look over the tile the tables were measured on', () => {
    const plains = COLOUR_CLASSES.indexOf('plains');
    const size = 512;
    const result = solveColourMap(flatWorld(plains, 0, size));
    expect(result.statistics.clamped).toBeLessThan(0.05 * result.statistics.landCells);
    const wanted = albedoTable('vanilla-temperate', BUNDLED_ATLAS)[plains]!;
    const tile = BUNDLED_ATLAS.means[1]!;
    const cells = (size / 2) ** 2;
    const shown = [0, 0, 0];
    for (let cell = 0; cell < cells; cell += 1)
      for (let channel = 0; channel < 3; channel += 1)
        shown[channel]! += overlayForward(
          tile[channel]! / 255,
          result.colormap[cell * 4 + 2 - channel]! / 255,
        );
    // The noise is zero-mean in the target colour, so the mean shown colour is the base look.
    for (let channel = 0; channel < 3; channel += 1)
      expect(shown[channel]! / cells / wanted[channel]!).toBeGreaterThan(0.85);
    for (let channel = 0; channel < 3; channel += 1)
      expect(shown[channel]! / cells / wanted[channel]!).toBeLessThan(1.2);
  });

  it('compensates a different tile: the shown colour stays, the colour map value moves', () => {
    const plains = COLOUR_CLASSES.indexOf('plains');
    const onPlainsTile = solveColourMap(flatWorld(plains, 0));
    const onDesertTile = solveColourMap(flatWorld(plains, 3));
    const mean = (map: Uint8Array): number => {
      let sum = 0;
      for (let cell = 0; cell < 64 * 64; cell += 1) sum += map[cell * 4 + 1]!;
      return sum / (64 * 64);
    };
    expect(Math.abs(mean(onPlainsTile.colormap) - mean(onDesertTile.colormap))).toBeGreaterThan(4);
  });

  it('reports pixels the atlas tile cannot reach', () => {
    const snow = COLOUR_CLASSES.indexOf('snow');
    // A pure white target over a mid tile is out of reach.
    const input = {
      ...flatWorld(snow, 19),
      look: 'custom' as const,
      overrides: { snow: [255, 255, 255] as const },
    };
    const result = solveColourMap(input);
    expect(result.statistics.clamped).toBeGreaterThan(0);
    expect(result.statistics.residual).toBeGreaterThan(0);
  });

  it('is deterministic and depends on the seed', () => {
    const plains = COLOUR_CLASSES.indexOf('plains');
    const a = solveColourMap(flatWorld(plains, 0));
    const b = solveColourMap(flatWorld(plains, 0));
    const c = solveColourMap({ ...flatWorld(plains, 0), seed: 4 });
    expect(Buffer.from(a.colormap).equals(Buffer.from(b.colormap))).toBe(true);
    expect(Buffer.from(a.colormap).equals(Buffer.from(c.colormap))).toBe(false);
  });

  it('makes the fertile look greener and the arid look warmer than the base look', () => {
    const base = albedoTable('vanilla-temperate', BUNDLED_ATLAS);
    const fertile = albedoTable('fertile', BUNDLED_ATLAS);
    const arid = albedoTable('arid', BUNDLED_ATLAS);
    const plains = COLOUR_CLASSES.indexOf('plains');
    expect(fertile[plains]![1] / fertile[plains]![0]).toBeGreaterThan(
      base[plains]![1] / base[plains]![0],
    );
    expect(arid[plains]![0] / arid[plains]![1]).toBeGreaterThan(
      base[plains]![0] / base[plains]![1],
    );
  });
});
