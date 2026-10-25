import { ServiceError } from '../core/result.js';
import {
  forEachPolylinePixel,
  rowStrips,
  scanAreaStrip,
  type ResolvedGeography,
} from './geography/index.js';
import { PARTITION_KIND, type PartitionFields, type PartitionRegion } from './partition-fields.js';
import {
  BARRIER_CREST,
  BARRIER_FORT_LINE,
  BARRIER_WALL,
  type BarrierField,
} from './relief/fields.js';

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

/** Strength each model-drawn line of the terrain synthesis gives the partition's barrier plane. */
const TERRAIN_LINE_STRENGTH: ReadonlyArray<readonly [number, number]> = [
  [BARRIER_WALL, 255],
  [BARRIER_FORT_LINE, 180],
  [BARRIER_CREST, 150],
];

/**
 * Return `fields` with the lines the terrain synthesis drew from the model (ADR 0056) raised in
 * its `barrier` plane: a wall outside its pass gaps at 255 (a hard line no province straddles), a
 * fort line at 180 and a range crest at 150. Rivers and steep ground are left to the
 * `riverDistance`, `slope` and `ridge` planes, which already carry them, so they do not count
 * twice. A stronger value already in the plane is kept.
 */
export function partitionFieldsWithTerrainLines(
  fields: PartitionFields,
  lines: BarrierField,
): PartitionFields {
  const { width, height } = fields;
  if (lines.width !== width || lines.height !== height)
    throw new ServiceError(
      'MAP_PARTITION_FIELDS_INVALID',
      'The terrain barrier field does not match the partition dimensions',
      { width, height, barrier: { width: lines.width, height: lines.height } },
    );
  const barrier = new Uint8Array(fields.barrier);
  for (let p = 0; p < barrier.length; p++) {
    const sources = lines.sources[p]!;
    if (sources === 0) continue;
    for (const [flag, strength] of TERRAIN_LINE_STRENGTH)
      if ((sources & flag) !== 0 && strength > barrier[p]!) barrier[p] = strength;
  }
  return { ...fields, barrier };
}
