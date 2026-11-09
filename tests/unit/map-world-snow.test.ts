import { beforeAll, describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  generateWorld,
  VANILLA_PERMANENT_SNOW,
  type GeneratedWorld,
  type WorldNote,
  type WorldSpec,
} from '../../src/hoi4_agent_tools/map/world.js';
import { mapOperationSchema } from '../../src/hoi4_agent_tools/schemas/map.js';
import {
  filesOf,
  plainContext,
  syntheticRaster,
  worldSpec,
} from '../helpers/map-appearance-world.js';
import { indexedPixels } from '../helpers/relief-checks.js';
import { reliefGeography } from '../helpers/relief-fixture.js';

const WIDTH = 256;
const HEIGHT = 256;
/** Graphical terrain indices the base game marks `perm_snow = yes`. */
const PERMANENT = new Set([16, 19]);

/** Land from `top` to `bottom` (rows), drawn as snow where `snow(y)` says so and plains elsewhere. */
function drawnWorld(
  top: number,
  bottom: number,
  snow: (y: number) => boolean,
  overrides: Partial<WorldSpec> = {},
): GeneratedWorld {
  const surface = syntheticRaster(WIDTH, HEIGHT, {
    at: (x, y) => (x >= 26 && x < 230 && y >= top && y < bottom ? 1 : 0),
    terrain: (_x, y) => (snow(y) ? 4 : 0),
  });
  return generateWorld(worldSpec(surface, overrides), plainContext);
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

describe('the permanentSnow option', () => {
  const permanent = (world: GeneratedWorld) =>
    [...indexedPixels(filesOf(world).get('map/terrain.bmp')!)].filter((index) =>
      PERMANENT.has(index),
    );

  it('narrows the ice cap to the rows nearest the edge', () => {
    // ZIN's inhabited north reaches the top rows; a cap at 0.97 keeps only the outer 3% of rows.
    const world = drawnWorld(4, 180, (y) => y < 110, { permanentSnow: { iceCapLatitude: 0.97 } });
    expect(permanent(world)).toEqual([]);
    expect(snowNote(world)!.details).toMatchObject({
      permanentPixels: 0,
      permanentSnow: { iceCapLatitude: 0.97, peakHeight: 150 },
    });
  });

  it('keeps drawn snow on high ground permanent from peakHeight up', () => {
    // The synthetic land stands at height 107, so a peak height of 100 keeps all of it.
    const world = drawnWorld(90, 166, () => true, { permanentSnow: { peakHeight: 100 } });
    const indices = permanent(world);
    expect(indices.length).toBe(snowNote(world)!.details!.drawnSnowPixels);
    expect(new Set(indices)).toEqual(new Set([16]));
  });

  it('keeps permanent snow off drawn land with snowlines', () => {
    const world = drawnWorld(4, 180, (y) => y < 110, { permanentSnow: 'snowlines' });
    expect(permanent(world)).toEqual([]);
    expect(snowNote(world)!.details).toMatchObject({ permanentSnow: 'snowlines' });
  });

  it('accepts only the documented forms', () => {
    const parse = (permanentSnow: unknown) =>
      mapOperationSchema.safeParse({ kind: 'create_world', id: 'w', permanentSnow }).success;
    expect(parse('snowlines')).toBe(true);
    expect(parse({ iceCapLatitude: 0.97, peakHeight: 200 })).toBe(true);
    expect(parse({})).toBe(true);
    expect(parse('none')).toBe(false);
    expect(parse({ iceCapLatitude: 1.5 })).toBe(false);
    expect(parse({ peakHeight: 95 })).toBe(false);
    expect(parse({ peakHeight: 150.5 })).toBe(false);
    expect(parse({ iceCap: 0.9 })).toBe(false);
  });
});

describe('the permanent-snow estimate of the synthesis check', () => {
  // A geography world with its northern land drawn as snow, so the check has relief to read.
  const width = 1024;
  const height = 512;
  const raster = syntheticRaster(width, height, {
    at: (x, y) => (x > 120 && x < 900 && y > 40 && y < 440 ? 1 : 0),
    terrain: (_x, y) => (y < 200 ? 4 : 0),
  });
  const model = reliefGeography();
  delete model.rivers;
  delete model.lakes;
  const geography = resolveGeography(model, {
    frame: { width, height },
    hasReference: true,
  }).geography;
  const spec = (overrides: Partial<WorldSpec>): WorldSpec => ({
    width,
    height,
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
    referenceSurface: raster,
    ...overrides,
  });
  interface SnowDetails {
    permanentPixels: number;
    landPixels: number;
    share: number;
    drawnSnowPixels: number;
    estimate?: boolean;
  }
  const details = (world: GeneratedWorld, code: string) =>
    world.notes.find((note) => note.code === code)?.details as SnowDetails | undefined;

  it.each([
    ['an ice cap', { iceCapLatitude: 0.6 }],
    ['high ground', { iceCapLatitude: 1, peakHeight: 112 }],
  ] as const)('estimates the share the write reports for %s', (_name, permanentSnow) => {
    // ZIN tuned its thresholds by 28-minute writes, 9 November 2026: the preview gave no figure.
    const checked = generateWorld(spec({ permanentSnow }), plainContext, { riverCheck: true });
    expect(checked.files).toEqual([]);
    expect(details(checked, 'MAP_PERMANENT_SNOW_SHARE')).toBeUndefined();
    const estimate = details(checked, 'MAP_PERMANENT_SNOW_ESTIMATE')!;
    expect(estimate.estimate).toBe(true);
    const written = details(
      generateWorld(spec({ permanentSnow }), plainContext),
      'MAP_PERMANENT_SNOW_SHARE',
    )!;
    expect(written.permanentPixels).toBeGreaterThan(0);
    expect(estimate.landPixels).toBe(written.landPixels);
    expect(estimate.drawnSnowPixels).toBe(written.drawnSnowPixels);
    // Only the full-resolution detail of the heights separates the two.
    expect(Math.abs(estimate.share - written.share)).toBeLessThanOrEqual(0.05 * written.share);
  });

  it('warns in the check when the share is far above the base game', () => {
    const checked = generateWorld(spec({ permanentSnow: { iceCapLatitude: 0.2 } }), plainContext, {
      riverCheck: true,
    });
    const note = checked.notes.find(({ code }) => code === 'MAP_PERMANENT_SNOW_ESTIMATE')!;
    expect(note.severity).toBe('warning');
    expect(note.message).toMatch(/^Estimated from the half-resolution relief/u);
  });
});
