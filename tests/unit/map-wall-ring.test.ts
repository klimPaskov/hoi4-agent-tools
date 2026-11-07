import { describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import { generateWorld, type GeneratedWorld } from '../../src/hoi4_agent_tools/map/world.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';
import { adjacencyRows, landComponents, provinceMap } from '../helpers/gameplay-checks.js';
import { plainContext, syntheticRaster, worldSpec } from '../helpers/map-appearance-world.js';

/**
 * A project-owned world with a reference picture and a geography model: one continent with a
 * closed ring wall, wide enough that the synthesis draws a broad impassable band, with a single
 * pass. Regression for walls whose province borders fell at the edge of the band, off the range
 * line, so no impassable row was written and the ring leaked.
 */
const WIDTH = 1_024;
const HEIGHT = 512;
const CENTER = [0.5, 0.5] as const;
/** The ring's vertices: an irregular closed loop of about 110 by 90 pixels. */
const RING: Array<[number, number]> = [
  [0.5, 0.33],
  [0.545, 0.36],
  [0.56, 0.45],
  [0.555, 0.56],
  [0.52, 0.66],
  [0.47, 0.67],
  [0.44, 0.58],
  [0.445, 0.44],
  [0.46, 0.37],
];

function ringModel(): GeographyModelInput {
  return {
    version: 1,
    seas: [
      {
        id: 'ocean',
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
        id: 'main',
        polygons: [
          [
            [0.2, 0.15],
            [0.8, 0.15],
            [0.8, 0.85],
            [0.2, 0.85],
          ],
        ],
      },
    ],
    ranges: [
      {
        id: 'ring',
        name: 'Ring Wall',
        closed: true,
        profile: 'wall',
        barrier: 'impassable',
        peak: 0.85,
        halfWidth: 0.008,
        path: RING,
      },
    ],
    passes: [
      { id: 'ring_gap', range: 'ring', position: [0.52, 0.66], width: 0.006, depth: 0.5, fort: 3 },
    ],
  } as unknown as GeographyModelInput;
}

function ringWorld(): GeneratedWorld {
  const geography = resolveGeography(ringModel(), {
    frame: { width: WIDTH, height: HEIGHT },
    hasReference: true,
  });
  expect(geography.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  const surface = syntheticRaster(WIDTH, HEIGHT, {
    at: (x, y) =>
      x >= 0.2 * WIDTH && x < 0.8 * WIDTH && y >= 0.15 * HEIGHT && y < 0.85 * HEIGHT ? 1 : 0,
  });
  return generateWorld(
    worldSpec(surface, {
      seed: 7,
      landProvincePixels: 300,
      geography: geography.geography,
      partition: { mode: 'feature-aware' },
    }),
    plainContext,
  );
}

describe('a closed ring wall with one pass on a reference picture and a geography model', () => {
  const world = ringWorld();

  it('closes the ring outside its pass', () => {
    const notes = world.notes.filter(({ code }) => code === 'MAP_RANGE_NOT_CLOSED');
    expect(notes).toEqual([]);
  });

  it('joins the inside to the outside only through the pass', () => {
    const map = provinceMap(world);
    const rows = adjacencyRows(world);
    const blocked = new Set(
      rows
        .filter(({ type }) => type === 'impassable')
        .flatMap(({ from, to }) => [`${from}:${to}`, `${to}:${from}`]),
    );
    const gates = new Set(
      world.gameplay!.crossings.gates.flatMap(([a, b]) => [
        `${a + 1}:${b + 1}`,
        `${b + 1}:${a + 1}`,
      ]),
    );
    const at = (x: number, y: number): number =>
      map.ids[Math.round(y * HEIGHT) * WIDTH + Math.round(x * WIDTH)]!;
    const inside = at(CENTER[0], CENTER[1]);
    const outside = at(0.3, 0.5);
    const closed = landComponents(
      map,
      (a, b) => !blocked.has(`${a}:${b}`) && !gates.has(`${a}:${b}`),
    );
    const open = landComponents(map, (a, b) => !blocked.has(`${a}:${b}`));
    expect(closed.get(inside)).not.toBe(closed.get(outside));
    expect(open.get(inside)).toBe(open.get(outside));
  });
});
