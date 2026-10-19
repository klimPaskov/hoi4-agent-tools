import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  resolveGeography,
  sampleAlong,
  type ResolvedGeography,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  BARRIER_CREST,
  BARRIER_RIVER,
  BARRIER_WALL,
  rasterizeGeographyKind,
  synthesizeTerrain,
  type SynthesizedTerrain,
} from '../../src/hoi4_agent_tools/map/relief/index.js';
import { reliefGeography } from '../helpers/relief-fixture.js';
import {
  checkRiverBitmap,
  normalResponse,
  percentile,
  touchesWaterOrEdge,
} from '../helpers/relief-checks.js';

const WIDTH = 2048;
const HEIGHT = 1024;
const SEED = 7;

function build(
  geography: ResolvedGeography,
  options: Partial<Parameters<typeof synthesizeTerrain>[0]> = {},
): { terrain: SynthesizedTerrain; kind: Uint8Array } {
  const kind = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: SEED });
  return {
    terrain: synthesizeTerrain({
      geography,
      width: WIDTH,
      height: HEIGHT,
      seed: SEED,
      kind,
      ...options,
    }),
    kind,
  };
}

function resolved(model = reliefGeography()): ResolvedGeography {
  const resolution = resolveGeography(model, {
    frame: { width: WIDTH, height: HEIGHT },
    hasReference: false,
    edge: { mode: 'sea-band' },
  });
  expect(resolution.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  return resolution.geography;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('terrain synthesis from a geography model', () => {
  let geography: ResolvedGeography;
  let terrain: SynthesizedTerrain;
  let kind: Uint8Array;

  beforeAll(() => {
    geography = resolved();
    ({ terrain, kind } = build(geography));
  });

  it('is deterministic and depends on the seed', () => {
    const again = build(geography).terrain;
    expect(sha(again.heights)).toBe(sha(terrain.heights));
    expect(sha(again.riverBitmap)).toBe(sha(terrain.riverBitmap));
    expect(sha(again.normals)).toBe(sha(terrain.normals));
    const other = synthesizeTerrain({ geography, width: WIDTH, height: HEIGHT, seed: 8, kind });
    expect(sha(other.heights)).not.toBe(sha(terrain.heights));
  });

  it('writes land from 96, the sea at 89 and a bank of 93 and 91 beside land', () => {
    let seaInterior = 0;
    let seaOther = 0;
    for (let index = 0; index < kind.length; index += 1) {
      const value = terrain.heights[index]!;
      if (kind[index] === 1) expect(value).toBeGreaterThanOrEqual(96);
      else if (value === 89) seaInterior += 1;
      else {
        expect([89, 91, 93]).toContain(value);
        seaOther += 1;
      }
    }
    expect(seaInterior).toBeGreaterThan(seaOther * 10);
    // The middle of the lake is open water at 89.
    const lake = geography.get('lake', 'mirror')!;
    const centre =
      Math.floor(lake.area.interior.y * HEIGHT) * WIDTH + Math.floor(lake.area.interior.x * WIDTH);
    expect(kind[centre]).toBe(2);
    expect(terrain.heights[centre]).toBe(89);
  });

  it('ramps the coast from 96 inland, monotonically on average', () => {
    // Four-neighbour distance from water for land pixels, independent of the generator.
    const distance = new Uint8Array(kind.length);
    let frontier: number[] = [];
    for (let index = 0; index < kind.length; index += 1)
      if (kind[index] === 1) {
        const x = index % WIDTH;
        if (
          (x > 0 && kind[index - 1] !== 1) ||
          (x < WIDTH - 1 && kind[index + 1] !== 1) ||
          (index >= WIDTH && kind[index - WIDTH] !== 1) ||
          (index < kind.length - WIDTH && kind[index + WIDTH] !== 1)
        ) {
          distance[index] = 1;
          frontier.push(index);
        }
      }
    for (let step = 2; step <= 8; step += 1) {
      const next: number[] = [];
      for (const index of frontier) {
        const x = index % WIDTH;
        for (const other of [index - 1, index + 1, index - WIDTH, index + WIDTH]) {
          if (other < 0 || other >= kind.length || (other === index - 1 && x === 0)) continue;
          if (other === index + 1 && x === WIDTH - 1) continue;
          if (kind[other] === 1 && distance[other] === 0) {
            distance[other] = step;
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    const sums = new Float64Array(9);
    const counts = new Float64Array(9);
    for (let index = 0; index < kind.length; index += 1) {
      const d = distance[index]!;
      if (d === 0) continue;
      sums[d] = sums[d]! + terrain.heights[index]!;
      counts[d] = counts[d]! + 1;
    }
    const means = Array.from({ length: 9 }, (_, d) => (counts[d]! > 0 ? sums[d]! / counts[d]! : 0));
    expect(means[1]).toBeLessThan(97);
    for (let d = 2; d <= 7; d += 1) expect(means[d]!).toBeGreaterThanOrEqual(means[d - 1]! - 0.05);
    expect(means[7]! - means[1]!).toBeGreaterThan(5);
  });

  it('matches the base game height distribution', () => {
    const land: number[] = [];
    for (let index = 0; index < kind.length; index += 1)
      if (kind[index] === 1) land.push(terrain.heights[index]!);
    expect(percentile(land, 0.5)).toBeGreaterThanOrEqual(100);
    expect(percentile(land, 0.5)).toBeLessThanOrEqual(115);
    expect(percentile(land, 0.99)).toBeGreaterThanOrEqual(190);
    expect(percentile(land, 0.99)).toBeLessThanOrEqual(225);
    expect(terrain.relief.meanStep).toBeGreaterThanOrEqual(0.8);
    expect(terrain.relief.maximum).toBeGreaterThan(225);
    expect(terrain.relief.maximum).toBeLessThanOrEqual(252);
  });

  it('has no seam between strips of the full-resolution pass', () => {
    // The mean absolute vertical step across rows that are multiples of 64 matches the other rows.
    let boundary = 0;
    let boundaryCount = 0;
    let rest = 0;
    let restCount = 0;
    for (let y = 1; y < HEIGHT; y += 1)
      for (let x = 0; x < WIDTH; x += 1) {
        const index = y * WIDTH + x;
        if (kind[index] !== 1 || kind[index - WIDTH] !== 1) continue;
        const step = Math.abs(terrain.heights[index]! - terrain.heights[index - WIDTH]!);
        if (y % 64 === 0) {
          boundary += step;
          boundaryCount += 1;
        } else {
          rest += step;
          restCount += 1;
        }
      }
    expect(boundary / boundaryCount).toBeLessThan((rest / restCount) * 1.25);
    expect(boundary / boundaryCount).toBeGreaterThan((rest / restCount) * 0.75);
  });

  it('raises every range crest to at least 90% of its peak outside the pass gaps', () => {
    const maxAround = (cx: number, cy: number, radius: number): number => {
      let best = 0;
      for (let dy = -radius; dy <= radius; dy += 1)
        for (let dx = -radius; dx <= radius; dx += 1) {
          const index = (Math.round(cy) + dy) * WIDTH + Math.round(cx) + dx;
          if (dx * dx + dy * dy <= radius * radius && kind[index] === 1)
            best = Math.max(best, terrain.heights[index]!);
        }
      return best;
    };
    for (const range of geography.ranges) {
      const gates = geography.passes.filter((pass) => pass.rangeId === range.id);
      for (let k = 1; k < 24; k += 1) {
        const t = k / 24;
        if (gates.some((pass) => Math.abs(t - pass.at) < 0.08)) continue;
        const sample = sampleAlong(range.path, geography.frame, t);
        const peak = 100 + 148 * sample.peak;
        const radius = Math.ceil(0.4 * sample.halfWidth * WIDTH);
        expect(
          maxAround(sample.x * WIDTH, sample.y * HEIGHT, radius),
          `${range.id} at ${t}`,
        ).toBeGreaterThanOrEqual(0.9 * peak);
      }
    }
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_RANGE_CREST_LOW');
  });

  it('cuts every pass below the crest either side of it', () => {
    const wall = geography.get('range', 'great_wall')!;
    const along = (t: number): number => {
      const sample = sampleAlong(wall.path, geography.frame, t);
      let best = 0;
      for (let dy = -6; dy <= 6; dy += 1)
        for (let dx = -6; dx <= 6; dx += 1)
          best = Math.max(
            best,
            terrain.heights[
              (Math.round(sample.y * HEIGHT) + dy) * WIDTH + Math.round(sample.x * WIDTH) + dx
            ]!,
          );
      return best;
    };
    for (const pass of geography.passes.filter((item) => item.rangeId === 'great_wall')) {
      const gap = along(pass.at);
      const crest = Math.min(along(pass.at - 0.1), along(pass.at + 0.1));
      expect(gap, pass.id).toBeLessThan(crest - 25);
    }
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_PASS_NOT_LOWER');
  });

  it('shapes volcanoes as cones with a crater', () => {
    const ember = geography.get('volcano', 'ember')!;
    const cx = Math.round(ember.at.x * WIDTH);
    const cy = Math.round(ember.at.y * HEIGHT);
    const centre = terrain.heights[cy * WIDTH + cx]!;
    let rim = 0;
    const crater = ember.crater * WIDTH;
    for (let dy = -40; dy <= 40; dy += 1)
      for (let dx = -40; dx <= 40; dx += 1) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= crater * 0.8 && d <= crater * 1.6)
          rim = Math.max(rim, terrain.heights[(cy + dy) * WIDTH + cx + dx]!);
      }
    expect(rim).toBeGreaterThan(centre + 8);
    expect(rim).toBeGreaterThan(0.9 * (100 + 148 * 0.95));
    // The cone falls away: the foot is far lower than the rim.
    expect(terrain.heights[cy * WIDTH + cx + Math.round(ember.radius * WIDTH * 1.1)]!).toBeLessThan(
      rim - 80,
    );
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_VOLCANO_NO_CRATER');
  });

  it('writes plateaus and chasms with their edges', () => {
    const steppe = geography.get('plateau', 'high_steppe')!;
    const abyss = geography.get('plateau', 'abyss')!;
    const at = (area: typeof steppe.area): number =>
      terrain.heights[
        Math.round(area.interior.y * HEIGHT) * WIDTH + Math.round(area.interior.x * WIDTH)
      ]!;
    // Plateau of relief 0.25 is 96 + 148 * 0.25 = 133; the chasm bottom is the land floor.
    expect(Math.abs(at(steppe.area) - 133)).toBeLessThan(6);
    expect(at(abyss.area)).toBeLessThanOrEqual(98);
  });

  it('shades from the real height field at the base game response', () => {
    // About -2.6 per height step where the encoding is linear; the whole-map regression that the
    // appearance validator takes is lower because steep walls saturate.
    const moderate = normalResponse(terrain.normals, terrain.heights, WIDTH, HEIGHT, 10);
    expect(moderate).toBeGreaterThan(2.3);
    expect(moderate).toBeLessThan(3.0);
    const whole = normalResponse(terrain.normals, terrain.heights, WIDTH, HEIGHT);
    expect(whole).toBeGreaterThan(1.2);
    expect(whole).toBeLessThan(6);
    let unit = 0;
    let sampled = 0;
    for (let index = 0; index < terrain.normals.length; index += 3 * 7) {
      const nx = (terrain.normals[index]! - 127.5) / 127.5;
      const ny = (terrain.normals[index + 1]! - 127.5) / 127.5;
      const nz = (terrain.normals[index + 2]! - 127.5) / 127.5;
      sampled += 1;
      if (Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1) <= 0.02) unit += 1;
    }
    expect(unit / sampled).toBeGreaterThan(0.9);
    // Flat sea is (128, 128, 255).
    const sea = (200 * (WIDTH / 2) + 40) * 3;
    expect([...terrain.normals.slice(sea, sea + 3)]).toEqual([128, 128, 255]);
  });

  it('writes rivers that obey the river bitmap rules', () => {
    const report = checkRiverBitmap(terrain.riverBitmap, kind, WIDTH, HEIGHT);
    expect(report.invalid).toBe(0);
    expect(report.blocks).toBe(0);
    expect(report.isolated).toBe(0);
    expect(report.onWater).toBe(0);
    expect(report.badSources).toBe(0);
    expect(report.sources).toBe(report.components);
    expect(report.tributaryEnds).toBeGreaterThan(20);
    expect(report.distributaryStarts).toBeGreaterThanOrEqual(1);
    let land = 0;
    for (const value of kind) if (value === 1) land += 1;
    const share = report.riverPixels / land;
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.025);
    expect(report.riverPixels).toBeLessThanOrEqual(130_000);
    expect(terrain.riverBitmap.length).toBe(WIDTH * HEIGHT);
    for (let index = 0; index < kind.length; index += 1)
      if (kind[index] !== 1) expect(terrain.riverBitmap[index]).toBe(254);
  });

  it('ends every river in water, a lake, the edge or its parent, flowing downhill and never narrowing', () => {
    const byId = new Map(terrain.riverPaths.map((path) => [path.id, path.pixels]));
    const owner = new Map<number, string>();
    for (const path of terrain.riverPaths)
      for (const pixel of path.pixels) owner.set(pixel, path.id);
    for (const entry of terrain.rivers) {
      const pixels = byId.get(entry.id)!;
      expect(pixels.length).toBeGreaterThan(0);
      const last = pixels[pixels.length - 1]!;
      if (entry.mouth === 'river') {
        const parent = entry.parent!;
        const adjacent = [last - 1, last + 1, last - WIDTH, last + WIDTH].some(
          (other) => owner.get(other) === parent,
        );
        expect(adjacent, `${entry.id} ends beside ${parent}`).toBe(true);
      } else
        expect(
          touchesWaterOrEdge(kind, WIDTH, HEIGHT, last),
          `${entry.id} reaches ${entry.mouth}`,
        ).toBe(true);
      let level = Infinity;
      let width = 0;
      for (const pixel of pixels) {
        expect(terrain.heights[pixel]!, `${entry.id} flows downhill`).toBeLessThanOrEqual(level);
        level = terrain.heights[pixel]!;
        const index = terrain.riverBitmap[pixel]!;
        if (index >= 3) {
          expect(index, `${entry.id} never narrows`).toBeGreaterThanOrEqual(width);
          width = index;
        }
      }
    }
  });

  it('routes the named rivers from the model, with tributaries, a lake outlet and a delta', () => {
    const named = new Map(
      terrain.rivers.filter(({ named: isNamed }) => isNamed).map((entry) => [entry.id, entry]),
    );
    for (const id of ['longwater', 'delta_river', 'lake_out', 'tribute_a', 'tribute_b'])
      expect(named.get(id)?.complete, id).toBe(true);
    expect(named.get('longwater')?.mouth).toBe('sea');
    expect(named.get('tribute_a')?.parent).toBe('longwater');
    expect(named.get('tribute_b')?.parent).toBe('longwater');
    expect(named.get('delta_river~delta1')?.junction).toBe('distributary');
    expect(named.get('longwater')?.width).toBeGreaterThanOrEqual(9);
    // The lake's outlet starts on its shore.
    const outlet = terrain.riverPaths.find((path) => path.id === 'lake_out')!.pixels[0]!;
    expect(
      [
        outlet - 1,
        outlet + 1,
        outlet - WIDTH,
        outlet + WIDTH,
        outlet - WIDTH - 1,
        outlet + WIDTH + 1,
      ].some((p) => kind[p] === 2),
    ).toBe(true);
    expect(terrain.rivers.filter((entry) => !entry.named).length).toBeGreaterThan(50);
  });

  it('keeps rivers off the high mountains and bends them like the base game', () => {
    let high = 0;
    for (let index = 0; index < kind.length; index += 1)
      if (terrain.riverBitmap[index]! <= 11 && terrain.heights[index]! > 180) high += 1;
    expect(high).toBeLessThan(terrain.riverStatistics.pixels * 0.01);
    expect(terrain.riverStatistics.straightShare).toBeLessThan(0.03);
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_RIVER_STRAIGHT_RUN');
  });

  it('exposes barrier, valley, crest and mountain fields for the partition', () => {
    const { barrier, valley, crestDistance, mountain } = terrain.fields;
    expect(barrier.strength.length).toBe(WIDTH * HEIGHT);
    expect(valley.scale).toBe(2);
    expect(valley.data.length).toBe((WIDTH / 2) * (HEIGHT / 2));
    // A river pixel is a barrier; so is the wall except at its gates; the crest line is marked.
    const river = terrain.riverPaths[0]!.pixels[10]!;
    expect(barrier.sources[river]! & BARRIER_RIVER).toBe(BARRIER_RIVER);
    expect(barrier.strength[river]!).toBeGreaterThanOrEqual(100);
    const wall = geography.get('range', 'great_wall')!;
    const at = (t: number): number => {
      const sample = sampleAlong(wall.path, geography.frame, t);
      return Math.round(sample.y * HEIGHT) * WIDTH + Math.round(sample.x * WIDTH);
    };
    expect(barrier.sources[at(0.1)]! & BARRIER_WALL).toBe(BARRIER_WALL);
    expect(barrier.strength[at(0.1)]).toBe(255);
    expect(barrier.sources[at(0.5)]! & BARRIER_WALL).toBe(0);
    expect(barrier.sources[at(0.1)]! & BARRIER_CREST).toBe(BARRIER_CREST);
    let carved = 0;
    for (const value of valley.data) if (value > 20) carved += 1;
    expect(carved).toBeGreaterThan(50);
    const crest = (t: number): number => {
      const sample = sampleAlong(wall.path, geography.frame, t);
      return Math.round(sample.y * (HEIGHT / 2)) * (WIDTH / 2) + Math.round(sample.x * (WIDTH / 2));
    };
    expect(crestDistance.data[crest(0.1)]!).toBeLessThanOrEqual(3);
    expect(mountain.data[crest(0.1)]!).toBeGreaterThan(200);
    // Plains far from every range carry no mountain weight.
    expect(mountain.data[(100 * WIDTH) / 2 + 40]).toBe(0);
  });

  it('marks permanent snow only above a range snow line', () => {
    let snow = 0;
    for (let index = 0; index < kind.length; index += 1)
      if (terrain.snow[index] === 1) {
        snow += 1;
        // The Spine's snow line is 0.65 of the relief scale: 100 + 148 * 0.65 = 196.
        expect(terrain.heights[index]!).toBeGreaterThanOrEqual(196);
        expect(kind[index]).toBe(1);
      }
    expect(snow).toBeGreaterThan(200);
  });

  it('reports the relief and the rivers it made', () => {
    expect(terrain.relief.landPixels).toBeGreaterThan(900_000);
    expect(terrain.riverStatistics.count).toBe(terrain.rivers.length);
    expect(terrain.riverStatistics.named).toBe(5);
    const codes = terrain.notes.map(({ code }) => code);
    expect(codes).toContain('MAP_LAKE_ENDORHEIC');
  });
});
