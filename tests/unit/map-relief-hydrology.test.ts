import { describe, expect, it } from 'vitest';
import {
  resolveGeography,
  type ResolvedGeography,
} from '../../src/hoi4_agent_tools/map/geography/index.js';
import { countAreaStrip, scanAreaStrip } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  rasterizeGeographyKind,
  synthesizeTerrain,
  type SynthesizedTerrain,
} from '../../src/hoi4_agent_tools/map/relief/index.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { reliefGeography } from '../helpers/relief-fixture.js';
import { checkRiverBitmap, percentile } from '../helpers/relief-checks.js';

const WIDTH = 1024;
const HEIGHT = 512;
const SEED = 5;

function resolve(model: GeographyModelInput, width = WIDTH, height = HEIGHT): ResolvedGeography {
  const resolution = resolveGeography(model, {
    frame: { width, height },
    hasReference: false,
  });
  expect(resolution.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  return resolution.geography;
}

function synthesize(
  geography: ResolvedGeography,
  options: Partial<Parameters<typeof synthesizeTerrain>[0]> = {},
): { terrain: SynthesizedTerrain; kind: Uint8Array } {
  const width = geography.frame.width;
  const height = geography.frame.height;
  const kind = rasterizeGeographyKind(geography, { width, height, seed: SEED });
  return {
    terrain: synthesizeTerrain({ geography, width, height, seed: SEED, kind, ...options }),
    kind,
  };
}

const edit = (change: (model: GeographyModelInput) => void): GeographyModelInput => {
  const model = structuredClone(reliefGeography());
  change(model);
  return model;
};

function failure(run: () => unknown): {
  code?: string;
  details?: Record<string, unknown>;
  message: string;
} {
  try {
    run();
  } catch (error) {
    return error as { code?: string; details?: Record<string, unknown>; message: string };
  }
  throw new Error('expected the synthesis to fail');
}

describe('named rivers that cannot reach their mouth', () => {
  it('refuses a tributary that would have to climb over a range', () => {
    // A wall from sea to sea splits the land; a brook west of it joins a river east of it.
    const model: GeographyModelInput = {
      version: 1,
      seas: [
        {
          id: 'sea',
          polygons: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      ],
      lands: [
        {
          id: 'land',
          polygons: [
            [
              [0.15, 0.2],
              [0.85, 0.2],
              [0.85, 0.8],
              [0.15, 0.8],
            ],
          ],
        },
      ],
      ranges: [
        {
          id: 'divide',
          profile: 'wall',
          path: [
            [0.5, 0.1],
            [0.5, 0.9],
          ],
          halfWidth: 0.01,
          peak: 0.9,
        },
      ],
      rivers: [
        { id: 'east', source: [0.7, 0.5], mouth: { sea: 'sea' }, size: 3 },
        { id: 'west_brook', source: [0.3, 0.5], mouth: { river: 'east' }, size: 1 },
      ],
    };
    const error = failure(() => synthesize(resolve(model)));
    expect(error.code).toBe('MAP_RIVER_UNREACHABLE_MOUTH');
    expect(error.details?.riverId).toBe('west_brook');
    expect(error.details?.climb).toBeGreaterThan(22);
    expect(error.message).toContain('climb');
  });

  it('refuses a river whose mouth lies on another landmass', () => {
    const model = edit((m) => {
      m.rivers!.push({ id: 'island_river', source: [0.66, 0.91], mouth: { lake: 'mirror' } });
    });
    const error = failure(() => synthesize(resolve(model)));
    expect(error.code).toBe('MAP_RIVER_UNREACHABLE_MOUTH');
    expect(error.details?.riverId).toBe('island_river');
  });
});

describe('river network options', () => {
  const geography = resolve(reliefGeography());

  it('caps the pixels at 2.5% of the land however much density is asked for', () => {
    const { terrain, kind } = synthesize(geography, { rivers: { density: 0.04 } });
    let land = 0;
    for (const value of kind) if (value === 1) land += 1;
    expect(terrain.riverStatistics.pixels).toBeLessThanOrEqual(0.025 * land);
    expect(terrain.riverStatistics.pixels).toBeLessThanOrEqual(130_000);
    const report = checkRiverBitmap(terrain.riverBitmap, kind, WIDTH, HEIGHT);
    expect(report.riverPixels).toBe(terrain.riverStatistics.pixels);
    expect(report.blocks).toBe(0);
  });

  it('writes only the named rivers when the density is zero', () => {
    const { terrain } = synthesize(geography, { rivers: { density: 0 } });
    expect(terrain.rivers.length).toBeGreaterThan(0);
    expect(terrain.rivers.every((river) => river.named)).toBe(true);
    expect(terrain.riverStatistics.streams).toBe(0);
  });

  it('keeps at most the requested number of unnamed river systems', () => {
    const { terrain } = synthesize(geography, { rivers: { count: 3 } });
    const roots = terrain.rivers.filter((river) => {
      if (river.named) return false;
      const parent = terrain.rivers.find(({ id }) => id === river.parent);
      return parent === undefined || parent.named;
    });
    expect(roots.length).toBeLessThanOrEqual(3);
    expect(synthesize(geography, { rivers: { count: 0 } }).terrain.riverStatistics.streams).toBe(0);
  });

  it('concentrates the network where more rain falls', () => {
    const mw = WIDTH / 2;
    const mh = HEIGHT / 2;
    const rainfall = new Float32Array(mw * mh).fill(1);
    for (let y = 0; y < mh; y += 1) for (let x = 0; x < mw / 2; x += 1) rainfall[y * mw + x] = 3;
    const wet = synthesize(geography, { rainfall }).terrain;
    const even = synthesize(geography).terrain;
    const left = (terrain: SynthesizedTerrain): number => {
      let count = 0;
      for (let y = 0; y < HEIGHT; y += 1)
        for (let x = 0; x < WIDTH / 2; x += 1)
          if (terrain.riverBitmap[y * WIDTH + x]! <= 11) count += 1;
      return count / terrain.riverStatistics.pixels;
    };
    expect(left(wet)).toBeGreaterThan(left(even) + 0.03);
  });

  it('is cancellable', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => synthesize(geography, { signal: controller.signal })).toThrow();
  });
});

describe('relief options', () => {
  const geography = resolve(reliefGeography());

  it('scales everything above the lowland', () => {
    const p99 = (scale: 'low' | 'vanilla' | 'dramatic'): number => {
      const { terrain, kind } = synthesize(geography, { relief: { scale } });
      const land: number[] = [];
      for (let index = 0; index < kind.length; index += 1)
        if (kind[index] === 1) land.push(terrain.heights[index]!);
      return percentile(land, 0.99);
    };
    const low = p99('low');
    const vanilla = p99('vanilla');
    const dramatic = p99('dramatic');
    expect(low).toBeLessThan(vanilla - 10);
    expect(dramatic).toBeGreaterThan(vanilla + 5);
  });

  it('adds roughness with detail', () => {
    const smooth = synthesize(geography, { relief: { detail: 0 } }).terrain.relief.meanStep;
    const rough = synthesize(geography, { relief: { detail: 1 } }).terrain.relief.meanStep;
    expect(rough).toBeGreaterThan(smooth);
  });

  it('reports ranges that cannot reach 150 as flat relief', () => {
    const low = edit((m) => {
      for (const range of m.ranges!) range.peak = 0.12;
      m.volcanoes = [];
      m.plateaus = [];
    });
    const { terrain } = synthesize(resolve(low));
    expect(terrain.notes.map(({ code }) => code)).toContain('MAP_RELIEF_FLAT');
    expect(terrain.relief.p99).toBeLessThan(150);
  });

  it('applies a height adjustment before the hydrology, so rivers route around it', () => {
    const plain = synthesize(geography);
    const raised = synthesize(geography, {
      adjustHeight: (x, _y, height) => (x < WIDTH / 4 ? height + 40 : height),
    });
    let sumPlain = 0;
    let sumRaised = 0;
    let compared = 0;
    for (let y = 0; y < HEIGHT; y += 2)
      for (let x = 0; x < WIDTH / 4; x += 1) {
        const index = y * WIDTH + x;
        if (plain.kind[index] === 1 && raised.terrain.riverBitmap[index] === 255) {
          sumPlain += plain.terrain.heights[index]!;
          sumRaised += raised.terrain.heights[index]!;
          compared += 1;
        }
      }
    expect(compared).toBeGreaterThan(5_000);
    expect((sumRaised - sumPlain) / compared).toBeGreaterThan(25);
    // The raised ground is a barrier the network drains away from, and the rules still hold.
    const report = checkRiverBitmap(raised.terrain.riverBitmap, raised.kind, WIDTH, HEIGHT);
    expect(report.blocks).toBe(0);
    expect(report.badSources).toBe(0);
    let uphill = 0;
    for (const path of raised.terrain.riverPaths) {
      let level = Infinity;
      for (const pixel of path.pixels) {
        if (raised.terrain.heights[pixel]! > level) uphill += 1;
        level = raised.terrain.heights[pixel]!;
      }
    }
    expect(uphill).toBe(0);
  });
});

describe('flat ground', () => {
  it('does not give rivers ruler-straight runs on a plateau (regression for the black north)', () => {
    const model: GeographyModelInput = {
      version: 1,
      seas: [
        {
          id: 'sea',
          polygons: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      ],
      lands: [
        {
          id: 'tableland',
          elevationBase: 0.1,
          polygons: [
            [
              [0.15, 0.2],
              [0.85, 0.2],
              [0.85, 0.8],
              [0.15, 0.8],
            ],
          ],
        },
      ],
      plateaus: [
        {
          id: 'flat',
          height: 0.2,
          edge: 'ramp',
          polygons: [
            [
              [0.2, 0.25],
              [0.8, 0.25],
              [0.8, 0.75],
              [0.2, 0.75],
            ],
          ],
        },
      ],
      rivers: [{ id: 'trunk', source: [0.5, 0.5], mouth: { sea: 'sea' }, size: 3 }],
    };
    const { terrain } = synthesize(resolve(model, 2048, 1024));
    expect(terrain.riverStatistics.pixels).toBeGreaterThan(3_000);
    expect(terrain.riverStatistics.straightShare).toBeLessThan(0.03);
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_RIVER_STRAIGHT_RUN');
    // The plateau top really is flat: its relief is a few height units.
    const heights: number[] = [];
    for (let y = 400; y < 600; y += 3)
      for (let x = 700; x < 1300; x += 3) heights.push(terrain.heights[y * 2048 + x]!);
    expect(percentile(heights, 0.95) - percentile(heights, 0.05)).toBeLessThan(14);
  });
});

describe('a model without rivers, lakes or volcanoes', () => {
  it('still synthesises relief and an accumulation network', () => {
    const model = edit((m) => {
      delete m.rivers;
      delete m.lakes;
      delete m.volcanoes;
    });
    const { terrain } = synthesize(resolve(model));
    expect(terrain.riverStatistics.named).toBe(0);
    expect(terrain.riverStatistics.pixels).toBeGreaterThan(1_000);
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_LAKE_ENDORHEIC');
  });
});

describe('geography rasterisation', () => {
  it('equals the polygon scan without coast detail and stays close with it', () => {
    const model = edit((m) => {
      delete m.lakes;
      delete m.rivers;
      m.lands![0]!.coastDetail = 0;
      m.lands![1]!.coastDetail = 0;
    });
    const geography = resolve(model);
    const kind = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: 1 });
    let landPixels = 0;
    for (const value of kind) if (value === 1) landPixels += 1;
    let expected = 0;
    for (const land of geography.lands)
      expected += countAreaStrip(land.area, geography.frame, { y0: 0, y1: HEIGHT });
    expect(landPixels).toBe(expected);
    const rough = edit((m) => {
      delete m.lakes;
      delete m.rivers;
      m.lands![0]!.coastDetail = 1;
    });
    const roughKind = rasterizeGeographyKind(resolve(rough), {
      width: WIDTH,
      height: HEIGHT,
      seed: 1,
    });
    let roughPixels = 0;
    let differing = 0;
    for (let index = 0; index < kind.length; index += 1) {
      if (roughKind[index] === 1) roughPixels += 1;
      if (roughKind[index] !== kind[index]) differing += 1;
    }
    expect(Math.abs(roughPixels - landPixels) / landPixels).toBeLessThan(0.03);
    expect(differing).toBeGreaterThan(1_000);
  });

  it('carves lakes out of land and is deterministic', () => {
    const geography = resolve(reliefGeography());
    const a = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: 2 });
    const b = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: 2 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    let lake = 0;
    for (const value of a) if (value === 2) lake += 1;
    const mirror = geography.get('lake', 'mirror')!;
    const expected = countAreaStrip(mirror.area, geography.frame, { y0: 0, y1: HEIGHT });
    expect(lake).toBeGreaterThan(expected * 0.9);
    expect(lake).toBeLessThan(
      (expected +
        countAreaStrip(geography.get('lake', 'tarn')!.area, geography.frame, {
          y0: 0,
          y1: HEIGHT,
        })) *
        1.2,
    );
    let spans = 0;
    scanAreaStrip(mirror.area, geography.frame, { y0: 0, y1: HEIGHT }, () => (spans += 1));
    expect(spans).toBeGreaterThan(10);
  });

  it('sinks specks of land and fills specks of sea', () => {
    const model: GeographyModelInput = {
      version: 1,
      seas: [
        {
          id: 'sea',
          polygons: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      ],
      lands: [
        // A continent with a 4 x 4 pixel pond of sea inside it, and a 4 x 4 pixel islet beside it.
        {
          id: 'continent',
          coastDetail: 0,
          polygons: [
            [
              [0.2, 0.2],
              [0.6, 0.2],
              [0.6, 0.8],
              [0.2, 0.8],
            ],
          ],
          holes: [
            [
              [0.4, 0.5],
              [0.4039, 0.5],
              [0.4039, 0.5078],
              [0.4, 0.5078],
            ],
          ],
        },
        {
          id: 'islet',
          coastDetail: 0,
          polygons: [
            [
              [0.8, 0.5],
              [0.8039, 0.5],
              [0.8039, 0.5078],
              [0.8, 0.5078],
            ],
          ],
        },
      ],
    };
    const resolution = resolveGeography(model, {
      frame: { width: WIDTH, height: HEIGHT },
      hasReference: false,
    });
    const kind = rasterizeGeographyKind(resolution.geography, {
      width: WIDTH,
      height: HEIGHT,
      seed: 1,
    });
    expect(kind[Math.floor(0.504 * HEIGHT) * WIDTH + Math.floor(0.402 * WIDTH)]).toBe(1);
    expect(kind[Math.floor(0.504 * HEIGHT) * WIDTH + Math.floor(0.802 * WIDTH)]).toBe(0);
    expect(kind[Math.floor(0.5 * HEIGHT) * WIDTH + Math.floor(0.3 * WIDTH)]).toBe(1);
  });
});
