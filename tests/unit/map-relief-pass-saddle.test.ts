import { describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import {
  rasterizeGeographyKind,
  synthesizeTerrain,
} from '../../src/hoi4_agent_tools/map/relief/index.js';
import { checkTerrainRivers } from '../../src/hoi4_agent_tools/map/relief/terrain-synthesis.js';
import {
  geographyModelSchema,
  type GeographyModelInput,
} from '../../src/hoi4_agent_tools/schemas/geography.js';

const WIDTH = 2048;
const HEIGHT = 1024;

const square = (left: number, top: number, right: number, bottom: number) => [
  [left, top],
  [right, top],
  [right, bottom],
  [left, bottom],
];

/** A short range with a pass on its spine and a volcano whose cone covers the pass. */
function model(extra: Record<string, unknown> = {}): GeographyModelInput {
  return geographyModelSchema.parse({
    version: 1,
    seas: [{ id: 'sea', polygons: [square(0, 0, 1, 1)] }],
    lands: [{ id: 'land', polygons: [square(0.5, 0.82, 0.72, 0.99)] }],
    ranges: [
      {
        id: 'spine',
        path: [
          [0.58, 0.9405],
          [0.596, 0.9355],
          [0.611, 0.9315],
          [0.626, 0.93],
        ],
        halfWidth: 0.006,
        peak: 0.9,
      },
    ],
    passes: [{ id: 'gate', range: 'spine', position: [0.6029, 0.93366] }],
    volcanoes: [{ id: 'cone', at: [0.6, 0.94], peak: 0.9 }],
    ...extra,
  });
}

function resolve(input: GeographyModelInput) {
  const resolution = resolveGeography(input, {
    frame: { width: WIDTH, height: HEIGHT },
    hasReference: false,
  });
  expect(resolution.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  return resolution.geography;
}

function synthesize(input: GeographyModelInput) {
  const geography = resolve(input);
  const kind = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: 3 });
  return {
    geography,
    kind,
    terrain: synthesizeTerrain({ geography, width: WIDTH, height: HEIGHT, seed: 3, kind }),
  };
}

describe('declared passes are saddles whatever else stands there', () => {
  it('keeps a pass lower than the crest on both sides when a volcano cone covers it', () => {
    const { terrain } = synthesize(model());
    expect(terrain.notes.map(({ code }) => code)).not.toContain('MAP_PASS_NOT_LOWER');
    const at = (x: number, y: number): number =>
      terrain.heights[Math.round(y * HEIGHT) * WIDTH + Math.round(x * WIDTH)]!;
    const centre = at(0.6029, 0.93366);
    const before = at(0.588, 0.938);
    const after = at(0.619, 0.9308);
    // A margin of several height units, not a tie.
    expect(centre).toBeLessThan(Math.min(before, after) - 4);
  });

  it('checks the pass in the river preview, without building the full relief', () => {
    const geography = resolve(model());
    const kind = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: 3 });
    const notes = checkTerrainRivers({ geography, width: WIDTH, height: HEIGHT, seed: 3, kind });
    expect(notes.map(({ code }) => code)).not.toContain('MAP_PASS_NOT_LOWER');
  });

  it('leaves the crest of a neighbouring range alone', () => {
    const neighbour = {
      ranges: [
        {
          id: 'spine',
          path: [
            [0.58, 0.9405],
            [0.596, 0.9355],
            [0.611, 0.9315],
            [0.626, 0.93],
          ],
          halfWidth: 0.006,
          peak: 0.9,
        },
        {
          id: 'neighbour',
          path: [
            [0.595, 0.918],
            [0.607, 0.9205],
            [0.62, 0.919],
          ],
          halfWidth: 0.006,
          peak: 0.9,
        },
      ],
      volcanoes: [],
    };
    const withPass = synthesize(model(neighbour));
    const withoutPass = synthesize(model({ ...neighbour, passes: [] }));
    expect(withPass.terrain.notes.map(({ code }) => code)).not.toContain('MAP_RANGE_CREST_LOW');
    // Along the neighbouring crest the heights are the same with and without the pass.
    let different = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      const x = Math.round((0.595 + 0.025 * t) * WIDTH);
      const y = Math.round((0.9195 + 0.0005 * Math.sin(t * 3)) * HEIGHT);
      if (withPass.terrain.heights[y * WIDTH + x] !== withoutPass.terrain.heights[y * WIDTH + x])
        different += 1;
    }
    expect(different).toBe(0);
  });

  it('is deterministic', () => {
    const a = synthesize(model()).terrain.heights;
    const b = synthesize(model()).terrain.heights;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
