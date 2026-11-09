import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateWorld,
  VANILLA_PERMANENT_SNOW,
  type GeneratedWorld,
  type WorldNote,
} from '../../src/hoi4_agent_tools/map/world.js';
import {
  filesOf,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';
import { indexedPixels } from '../helpers/relief-checks.js';

const WIDTH = 256;
const HEIGHT = 256;
/** Graphical terrain indices the base game marks `perm_snow = yes`. */
const PERMANENT = new Set([16, 19]);

/** Land from `top` to `bottom` (rows), drawn as snow where `snow(y)` says so and plains elsewhere. */
function drawnWorld(top: number, bottom: number, snow: (y: number) => boolean): GeneratedWorld {
  const surface = syntheticRaster(WIDTH, HEIGHT, {
    at: (x, y) => (x >= 26 && x < 230 && y >= top && y < bottom ? 1 : 0),
    terrain: (_x, y) => (snow(y) ? 4 : 0),
  });
  return generateWorld(worldSpec(surface), plainContext);
}

function snowNote(world: GeneratedWorld): WorldNote | undefined {
  return world.notes.find(({ code }) => code === 'MAP_PERMANENT_SNOW_SHARE');
}

/** Each land strategic region's highest monthly snow chance. */
function regionSnow(world: GeneratedWorld): number[] {
  return [...filesOf(world)]
    .filter(([path]) => path.startsWith('map/strategicregions/'))
    .map(([, content]) => content.toString())
    .filter((text) => !text.includes('naval_terrain'))
    .map((text) => Math.max(...[...text.matchAll(/\bsnow=([\d.]+)/gu)].map((m) => Number(m[1]))));
}

describe('drawn snow in a reference world', () => {
  // Snow from the north pole to just above the equator, plains below it.
  let world: GeneratedWorld;
  let terrain: Uint8Array;

  beforeAll(() => {
    world = drawnWorld(4, 180, (y) => y < 110);
    terrain = indexedPixels(filesOf(world).get('map/terrain.bmp')!);
  });

  it('keeps permanent snow to the ice cap and makes the rest ordinary land', () => {
    // The ZIN Cold Lands, 9 November 2026: every drawn snow pixel was permanent snow (index 19),
    // about a hundred times the base game's share, and the game drew it as bright blue ice.
    const at = (x: number, y: number) => terrain[y * WIDTH + x]!;
    for (const x of [40, 128, 200]) {
      expect(at(x, 8), `ice cap at ${x},8`).toBe(19);
      expect(PERMANENT.has(at(x, 60)), `seasonal snow at ${x},60`).toBe(false);
      expect(PERMANENT.has(at(x, 100)), `seasonal snow at ${x},100`).toBe(false);
    }
    const capRows = Math.ceil(HEIGHT * 0.1);
    let outsideCap = 0;
    for (let y = capRows; y < HEIGHT; y += 1)
      for (let x = 0; x < WIDTH; x += 1) if (PERMANENT.has(at(x, y))) outsideCap += 1;
    expect(outsideCap).toBe(0);
  });

  it('reports the permanent-snow share against the base game', () => {
    const note = snowNote(world);
    expect(note).toBeDefined();
    const details = note!.details as {
      permanentPixels: number;
      landPixels: number;
      share: number;
      ratio: number;
      drawnSnowPixels: number;
      seasonalSnowPixels: number;
      vanilla: typeof VANILLA_PERMANENT_SNOW;
    };
    let permanent = 0;
    for (const index of terrain) if (PERMANENT.has(index)) permanent += 1;
    expect(details.permanentPixels).toBe(permanent);
    expect(details.vanilla).toEqual(VANILLA_PERMANENT_SNOW);
    expect(details.seasonalSnowPixels).toBeGreaterThan(details.permanentPixels);
    expect(details.drawnSnowPixels).toBe(details.permanentPixels + details.seasonalSnowPixels);
    // A cap over a tenth of the land is far above the base game's 0.76%.
    expect(details.ratio).toBeGreaterThan(4);
    expect(note!.severity).toBe('warning');
    expect(note!.message).toContain("times the base game's 0.76%");
  });

  it('gives regions drawn as snow winters with snow', () => {
    expect(Math.min(...regionSnow(world).filter((snow) => snow > 0))).toBeGreaterThanOrEqual(0.3);
  });
});

describe('drawn snow away from the poles', () => {
  it('writes no permanent snow and only an informational note', () => {
    const world = drawnWorld(90, 166, () => true);
    const terrain = indexedPixels(filesOf(world).get('map/terrain.bmp')!);
    expect([...terrain].filter((index) => PERMANENT.has(index))).toEqual([]);
    const note = snowNote(world)!;
    expect(note.severity).toBe('info');
    expect(note.details).toMatchObject({ permanentPixels: 0, share: 0 });
    // Equatorial land drawn as snow still gets snowy winters; the same land drawn as plains does not.
    expect(regionSnow(world).every((snow) => snow >= 0.3)).toBe(true);
    const plains = drawnWorld(90, 166, () => false);
    expect(regionSnow(plains).every((snow) => snow === 0)).toBe(true);
    expect(snowNote(plains)).toBeUndefined();
  });
});
