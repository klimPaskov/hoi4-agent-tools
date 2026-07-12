import { describe, expect, it } from 'vitest';
import { MAP_SELECTED_PIXEL_LIMIT } from '../../src/hoi4_agent_tools/map/limits.js';
import type { ProvinceGeometry } from '../../src/hoi4_agent_tools/map/model.js';
import {
  exportProvinceGeometryRowRuns,
  type ProvinceGeometryExportSource,
} from '../../src/hoi4_agent_tools/map/service.js';

function geometry(
  id: number,
  pixelCount: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): ProvinceGeometry {
  return {
    id,
    pixelCount,
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

describe('province geometry row-run export', () => {
  it('deduplicates and sorts selectors, reports missing IDs, and emits exact maximal runs', async () => {
    const source: ProvinceGeometryExportSource = {
      definitionsById: new Map([
        [1, true],
        [2, true],
        [3, true],
      ]),
      raster: {
        width: 6,
        height: 3,
        provinceIds: Int32Array.from([1, 1, 2, 1, 1, -1, 2, 2, 2, 1, -1, -1, 1, 1, 1, 1, 1, 1]),
        geometry: new Map([
          [1, geometry(1, 11, 0, 0, 5, 2)],
          [2, geometry(2, 4, 0, 0, 2, 1)],
        ]),
      },
    };

    const exported = await exportProvinceGeometryRowRuns(source, [2, 99, 1, 3, 1]);

    expect(exported).toEqual({
      width: 6,
      height: 3,
      requestedProvinceIds: [1, 2, 3, 99],
      unknownProvinceIds: [99],
      missingGeometryProvinceIds: [3],
      pixelCount: 15,
      rowRunCount: 6,
      provinces: [
        {
          provinceId: 1,
          pixelCount: 11,
          bounds: { minX: 0, minY: 0, maxXExclusive: 6, maxYExclusive: 3 },
          rowRunCount: 4,
          rowRuns: [
            [0, 0, 2],
            [0, 3, 5],
            [1, 3, 4],
            [2, 0, 6],
          ],
        },
        {
          provinceId: 2,
          pixelCount: 4,
          bounds: { minX: 0, minY: 0, maxXExclusive: 3, maxYExclusive: 2 },
          rowRunCount: 2,
          rowRuns: [
            [0, 2, 3],
            [1, 0, 3],
          ],
        },
      ],
    });
  });

  it('enforces the shared selected-pixel budget before allocating row-run payloads', async () => {
    const source: ProvinceGeometryExportSource = {
      definitionsById: new Map([[1, true]]),
      raster: {
        width: 1,
        height: 1,
        provinceIds: Int32Array.from([1]),
        geometry: new Map([[1, geometry(1, MAP_SELECTED_PIXEL_LIMIT + 1, 0, 0, 0, 0)]]),
      },
    };

    await expect(exportProvinceGeometryRowRuns(source, [1])).rejects.toMatchObject({
      code: 'MAP_SELECTED_PIXEL_BUDGET_BLOCKED',
      details: {
        selectedPixels: MAP_SELECTED_PIXEL_LIMIT + 1,
        maximumSelectedPixels: MAP_SELECTED_PIXEL_LIMIT,
      },
    });
  });

  it('rejects selectors above the fixed province limit in the map service', async () => {
    const source: ProvinceGeometryExportSource = {
      definitionsById: new Map(),
      raster: {
        width: 1,
        height: 1,
        provinceIds: Int32Array.from([-1]),
        geometry: new Map(),
      },
    };

    await expect(
      exportProvinceGeometryRowRuns(
        source,
        Array.from({ length: 33 }, (_unused, provinceId) => provinceId),
      ),
    ).rejects.toMatchObject({
      code: 'MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT',
      details: { requestedProvinceCount: 33, maximumProvinceCount: 32 },
    });
  });
});
