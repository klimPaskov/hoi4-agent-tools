import {
  forEachPolylinePixel,
  rowStrips,
  scanAreaStrip,
  type ResolvedGeography,
} from './geography/index.js';
import { PARTITION_KIND, type PartitionFields, type PartitionRegion } from './partition-fields.js';

/**
 * Geography inputs of the partition (ADR 0058): the named regions and seas of the model become the
 * `regionId` plane and the region table (with the density each asks for), and every range that
 * declares itself a wall or an impassable barrier becomes a barrier line no province may straddle.
 * Relief, rivers, fertility and terrain classes stay as the caller computed them.
 */

/** Pixels written by one range path per side: three pixels wide, so no 4-connected path crosses. */
const WALL_HALF_WIDTH = 1;

export interface GeographyPartitionOptions {
  /** Rows per rasterisation strip. Default 256. */
  stripRows?: number;
}

/**
 * Return `fields` with `regionId`, `regions` and `barrier` taken from the resolved geography.
 * Land regions are written on land pixels and named seas on sea pixels, so a lake is never part
 * of a region by itself. Overlapping areas resolve in id order, later ids winning; ids are the
 * 1-based position in the sorted list of regions that have an area, followed by the seas.
 */
export function partitionFieldsFromGeography(
  fields: PartitionFields,
  geography: ResolvedGeography,
  options: GeographyPartitionOptions = {},
): PartitionFields {
  const { width, height, kind } = fields;
  const grid = { width, height };
  const regionId = new Uint16Array(fields.regionId);
  const barrier = new Uint8Array(fields.barrier);
  const table: PartitionRegion[] = [];
  const areas: Array<{
    id: number;
    area: NonNullable<(typeof geography.regions)[number]['area']>;
  }> = [];
  const seaAreas: typeof areas = [];
  let next = 1;
  for (const region of geography.regions) {
    if (region.area === undefined) continue;
    const entry: PartitionRegion = { id: next, kind: 'land' };
    if (region.name !== undefined) entry.name = region.name;
    if (region.provinceAreaPx !== undefined) entry.provinceAreaPx = region.provinceAreaPx;
    if (region.provincesPerState !== undefined) entry.provincesPerState = region.provincesPerState;
    table.push(entry);
    areas.push({ id: next, area: region.area });
    next += 1;
  }
  for (const sea of geography.seas) {
    if (next > 65_535) break;
    const entry: PartitionRegion = { id: next, kind: 'sea' };
    if (sea.name !== undefined) entry.name = sea.name;
    table.push(entry);
    seaAreas.push({ id: next, area: sea.area });
    next += 1;
  }
  for (const strip of rowStrips(grid, options.stripRows ?? 256)) {
    for (const { id, area } of areas)
      scanAreaStrip(area, grid, strip, (y, x0, x1) => {
        const row = y * width;
        for (let x = x0; x < x1; x++)
          if (kind[row + x] === PARTITION_KIND.land) regionId[row + x] = id;
      });
    for (const { id, area } of seaAreas)
      scanAreaStrip(area, grid, strip, (y, x0, x1) => {
        const row = y * width;
        for (let x = x0; x < x1; x++)
          if (kind[row + x] === PARTITION_KIND.sea) regionId[row + x] = id;
      });
  }
  const whole = { y0: 0, y1: height };
  for (const range of geography.ranges) {
    if (range.profile !== 'wall' && range.barrier !== 'impassable') continue;
    forEachPolylinePixel(range.path, grid, whole, (x, y) => {
      for (let dy = -WALL_HALF_WIDTH; dy <= WALL_HALF_WIDTH; dy++)
        for (let dx = -WALL_HALF_WIDTH; dx <= WALL_HALF_WIDTH; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > WALL_HALF_WIDTH) continue;
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          barrier[yy * width + ((x + dx + width) % width)] = 255;
        }
    });
  }
  return { ...fields, regionId, barrier, regions: table };
}
