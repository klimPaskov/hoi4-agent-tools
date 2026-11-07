import { describe, expect, it } from 'vitest';
import { resolveGeography } from '../../src/hoi4_agent_tools/map/geography/index.js';
import { rasterizeGeographyKind } from '../../src/hoi4_agent_tools/map/relief/index.js';
import { checkTerrainRivers } from '../../src/hoi4_agent_tools/map/relief/terrain-synthesis.js';
import type { GeographyModelInput } from '../../src/hoi4_agent_tools/schemas/geography.js';

const WIDTH = 512;
const HEIGHT = 256;
/** One half-resolution cell in map widths and heights. */
const CELL_X = 2 / WIDTH;
const CELL_Y = 2 / HEIGHT;
const MOUTH: [number, number] = [0.6, 0.205];

/**
 * A river that runs west along a coast to a mouth drawn on the shore, with its last via point
 * just beyond the mouth: the course passes through the mouth's cell on its way to the via point.
 */
function model(via: [number, number]): GeographyModelInput {
  return {
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
    rivers: [{ id: 'coastal', source: [0.7, 0.205], via: [via], mouth: MOUTH, size: 2 }],
  };
}

describe('a point mouth within a cell of the last via point', () => {
  for (const dy of [-1, 0, 1])
    it(`ends the river at its mouth (via ${dy} cell(s) off the coast line)`, () => {
      const resolution = resolveGeography(model([MOUTH[0] - CELL_X, MOUTH[1] + dy * CELL_Y]), {
        frame: { width: WIDTH, height: HEIGHT },
        hasReference: false,
      });
      expect(resolution.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
      const geography = resolution.geography;
      const kind = rasterizeGeographyKind(geography, { width: WIDTH, height: HEIGHT, seed: 5 });
      const notes = checkTerrainRivers({ geography, width: WIDTH, height: HEIGHT, seed: 5, kind });
      expect(notes.filter(({ severity }) => severity === 'error')).toEqual([]);
    });
});
