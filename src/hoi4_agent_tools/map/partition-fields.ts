import { ServiceError } from '../core/result.js';

/**
 * Inputs of the feature-aware partition (ADR 0058): one byte (or two) per pixel describing the
 * natural lines and the character of the land, in one typed contract. The contract exists so the
 * partition does not care where the numbers come from. `partitionFieldsFromBitmaps` computes a
 * basic version from the height, terrain and river bitmaps a map already has; the relief,
 * hydrology and climate stages (C6, C7, C8) fill the same fields from their float rasters and the
 * geography model (`partitionFieldsFromGeography` adds regions and wall ranges). Only `+ - * /` and
 * `sqrt` are used, so every field is identical on every platform.
 */

/** Terrain classes the partition distinguishes; `water` marks pixels that are not land. */
export const PARTITION_TERRAIN = {
  plains: 0,
  farmland: 1,
  forest: 2,
  hills: 3,
  mountain: 4,
  desert: 5,
  marsh: 6,
  jungle: 7,
  snow: 8,
  urban: 9,
  water: 255,
} as const;

export type PartitionTerrainName = keyof typeof PARTITION_TERRAIN;

/** Pixel kinds, as the province generator already uses them. */
export const PARTITION_KIND = { sea: 0, land: 1, lake: 2 } as const;

/** A named region (or sea) of the geography model, with the density it asks for. */
export interface PartitionRegion {
  /** The value of `regionId` for its pixels, from 1. */
  id: number;
  name?: string;
  kind: 'land' | 'sea';
  /** Typical land province area in pixels inside the region. */
  provinceAreaPx?: number;
  /** `[smallest, usual, largest]` provinces per state inside the region. */
  provincesPerState?: readonly [number, number, number];
}

/**
 * Per-pixel inputs of the partition. Every plane has `width * height` entries in row-major order
 * from the top left. Scalars are quantised to bytes so a 13-million pixel map needs about 100 MB.
 */
export interface PartitionFields {
  readonly width: number;
  readonly height: number;
  /** 0 = sea, 1 = land, 2 = lake. The partition preserves this mask exactly. */
  readonly kind: Uint8Array;
  /**
   * Distance in pixels to the nearest river pixel (0 on the river), 255 when the nearest river is
   * 255 pixels or more away or there is none. Only land pixels are read.
   */
  readonly riverDistance: Uint8Array;
  /** Ridge-crest strength, 0 (not a crest) to 255 (a sharp, high crest). */
  readonly ridge: Uint8Array;
  /**
   * Height gradient magnitude per pixel times 16, clamped to 255. The border metric calls a
   * gradient of 2 per pixel steep, which is 32 here.
   */
  readonly slope: Uint8Array;
  /** `PARTITION_TERRAIN` class of each land pixel (255 elsewhere). */
  readonly terrainClass: Uint8Array;
  /** Id of the geography region (land) or sea the pixel lies in; 0 for none. */
  readonly regionId: Uint16Array;
  /** Fertility, 0 (barren) to 255 (rich valley). */
  readonly fertility: Uint8Array;
  /**
   * Barrier strength drawn by the model itself (a wall range, a declared natural boundary): 0 for
   * none, up to 255 for a line that no province may straddle.
   */
  readonly barrier: Uint8Array;
  readonly regions?: readonly PartitionRegion[];
}

const MAP_PIXEL_LIMIT = 13_238_272;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ServiceError('MAP_PARTITION_FIELDS_INVALID', message, details);
}

/** Check the sizes, kinds and region table of a set of fields; throws `MAP_PARTITION_FIELDS_INVALID`. */
export function assertPartitionFields(fields: PartitionFields): void {
  const { width, height } = fields;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16)
    invalid('Partition dimensions must be integers of at least 16 pixels', { width, height });
  const total = width * height;
  if (!Number.isSafeInteger(total) || total > MAP_PIXEL_LIMIT)
    invalid('Partition dimensions exceed the 13,238,272-pixel map limit', { width, height });
  const planes: [string, { length: number }, unknown][] = [
    ['kind', fields.kind, Uint8Array],
    ['riverDistance', fields.riverDistance, Uint8Array],
    ['ridge', fields.ridge, Uint8Array],
    ['slope', fields.slope, Uint8Array],
    ['terrainClass', fields.terrainClass, Uint8Array],
    ['regionId', fields.regionId, Uint16Array],
    ['fertility', fields.fertility, Uint8Array],
    ['barrier', fields.barrier, Uint8Array],
  ];
  for (const [name, plane, type] of planes) {
    if (!(plane instanceof (type as typeof Uint8Array)))
      invalid(`Partition field ${name} must be a ${(type as { name: string }).name}`, {
        field: name,
      });
    if (plane.length !== total)
      invalid(`Partition field ${name} does not match the map dimensions`, {
        field: name,
        length: plane.length,
        expected: total,
      });
  }
  for (let p = 0; p < total; p++)
    if (fields.kind[p]! > 2)
      invalid('Partition kind contains a value other than sea (0), land (1) or lake (2)', {
        pixel: p,
        value: fields.kind[p],
      });
  const ids = new Set<number>();
  for (const region of fields.regions ?? []) {
    if (!Number.isInteger(region.id) || region.id < 1 || region.id > 65_535 || ids.has(region.id))
      invalid('Partition region ids must be unique integers from 1 to 65,535', { id: region.id });
    ids.add(region.id);
    if (
      region.provinceAreaPx !== undefined &&
      (!Number.isFinite(region.provinceAreaPx) || region.provinceAreaPx < 20)
    )
      invalid('A region province area must be at least 20 pixels', { id: region.id });
    const per = region.provincesPerState;
    if (
      per !== undefined &&
      (per.some((value) => !Number.isInteger(value) || value < 1) ||
        per[0] > per[1] ||
        per[1] > per[2])
    )
      invalid('A region provincesPerState must be three increasing positive integers', {
        id: region.id,
      });
  }
  if (ids.size > 0)
    for (let p = 0; p < total; p++) {
      const id = fields.regionId[p]!;
      if (id !== 0 && !ids.has(id))
        invalid('A pixel names a region that the region table does not list', { pixel: p, id });
    }
}

// ---------------------------------------------------------------------------------------------
// Diagonal contacts

/**
 * Remove the one mask pattern no partition can represent: a 2 x 2 block whose diagonals are two
 * kinds (land and sea, say) so that each kind touches itself only at a corner. Four provinces
 * would meet there ("X crossing"), and neither pair can be merged because the pieces are not
 * four-connected. One pixel of the non-land kind becomes the other kind (land beats sea and lake, sea
 * beats lake: the pixel of the weaker kind on the north-east or north-west corner changes),
 * repeating until no block is left. Returns the changed pixel indices; `kind` is modified in
 * place. The east-west seam wraps.
 */
export function smoothDiagonalContacts(
  kind: Uint8Array,
  width: number,
  height: number,
  maxPasses = 8,
): number[] {
  const changed: number[] = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    let found = false;
    for (let y = 0; y + 1 < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const next = x + 1 < width ? x + 1 : 0;
        const nw = row + x;
        const ne = row + next;
        const sw = nw + width;
        const se = ne + width;
        const a = kind[nw]!;
        const b = kind[ne]!;
        if (a === b || kind[se] !== a || kind[sw] !== b) continue;
        // The kind that survives: land over lake over sea; the other diagonal gives way.
        const rank = (value: number): number =>
          value === PARTITION_KIND.land ? 2 : value === PARTITION_KIND.lake ? 0 : 1;
        const keep = rank(a) >= rank(b) ? a : b;
        const target = keep === a ? ne : nw;
        kind[target] = keep;
        changed.push(target);
        found = true;
      }
    }
    if (!found) break;
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Adapter from bitmaps

/**
 * Terrain class of each graphical terrain index of the base game's `terrain.bmp`: 0 plains,
 * 1 forest, 2 and 17 hills, 3 desert, 4 sparse forest, 5 farmland, 6, 16 and 20 mountain, 9 marsh,
 * 13 urban, 15 ocean, 19 permanent snow, 21 and 22 jungle. Others are plains. A mod with other
 * indices passes its own table (the border metric derives one from `common/terrain`).
 */
export function defaultTerrainClassTable(): Uint8Array {
  const table = new Uint8Array(256).fill(PARTITION_TERRAIN.plains);
  const set = (name: PartitionTerrainName, ...indices: number[]): void => {
    for (const index of indices) table[index] = PARTITION_TERRAIN[name];
  };
  set('forest', 1, 4);
  set('hills', 2, 17);
  set('desert', 3);
  set('farmland', 5);
  set('mountain', 6, 16, 20);
  set('marsh', 9);
  set('urban', 13);
  set('water', 15, 14);
  set('snow', 19);
  set('jungle', 21, 22);
  return table;
}

export interface PartitionBitmapInput {
  width: number;
  height: number;
  /** 0 = sea, 1 = land, 2 = lake. */
  kind: Uint8Array;
  /** `heightmap.bmp` indices; land is 96 and up. Without it slope and ridge are zero. */
  heights?: Uint8Array;
  /** `rivers.bmp` indices; 0 to `riverMaxIndex` are river pixels. Without it there are no rivers. */
  rivers?: Uint8Array;
  riverMaxIndex?: number;
  /** `terrain.bmp` indices. Without it every land pixel is plains. */
  terrain?: Uint8Array;
  /** Class per terrain index (256 entries); defaults to `defaultTerrainClassTable()`. */
  terrainClasses?: Uint8Array;
  /** Optional moisture, 0 to 255, that raises fertility. */
  moisture?: Uint8Array;
  /** Optional model-drawn planes and the region table. */
  regionId?: Uint16Array;
  regions?: readonly PartitionRegion[];
  barrier?: Uint8Array;
}

/** Three-four chamfer distance in pixels (capped at 255) to the nearest pixel of `source`. */
export function chamferDistance(
  source: (pixel: number) => boolean,
  width: number,
  height: number,
): Uint8Array {
  const cap = 255 * 3;
  const distance = new Uint16Array(width * height);
  let any = false;
  for (let p = 0; p < distance.length; p++) {
    if (source(p)) {
      distance[p] = 0;
      any = true;
    } else distance[p] = cap;
  }
  const output = new Uint8Array(width * height);
  if (!any) {
    output.fill(255);
    return output;
  }
  // The east-west seam wraps, so two sweeps of both directions reach every pixel.
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const left = x === 0 ? width - 1 : x - 1;
        const right = x === width - 1 ? 0 : x + 1;
        let best = distance[row + x]!;
        const west = distance[row + left]! + 3;
        if (west < best) best = west;
        if (y > 0) {
          const above = row - width;
          const n = distance[above + x]! + 3;
          const nw = distance[above + left]! + 4;
          const ne = distance[above + right]! + 4;
          if (n < best) best = n;
          if (nw < best) best = nw;
          if (ne < best) best = ne;
        }
        distance[row + x] = best > cap ? cap : best;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      const row = y * width;
      for (let x = width - 1; x >= 0; x--) {
        const left = x === 0 ? width - 1 : x - 1;
        const right = x === width - 1 ? 0 : x + 1;
        let best = distance[row + x]!;
        const east = distance[row + right]! + 3;
        if (east < best) best = east;
        if (y < height - 1) {
          const below = row + width;
          const s = distance[below + x]! + 3;
          const sw = distance[below + left]! + 4;
          const se = distance[below + right]! + 4;
          if (s < best) best = s;
          if (sw < best) best = sw;
          if (se < best) best = se;
        }
        distance[row + x] = best > cap ? cap : best;
      }
    }
  }
  for (let p = 0; p < output.length; p++) {
    const value = distance[p]!;
    output[p] = value >= cap ? 255 : Math.min(254, Math.floor((value + 1) / 3));
  }
  return output;
}

/** Central-difference gradient magnitude times 16, clamped to 255; zero off land. */
export function slopeField(
  heights: Uint8Array,
  kind: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const above = (y > 0 ? y - 1 : y) * width;
    const below = (y < height - 1 ? y + 1 : y) * width;
    for (let x = 0; x < width; x++) {
      if (kind[row + x] !== PARTITION_KIND.land) continue;
      const left = x === 0 ? width - 1 : x - 1;
      const right = x === width - 1 ? 0 : x + 1;
      // The step down to the water is not a slope: a neighbour that is not land counts as level.
      const here = heights[row + x]!;
      const hl = kind[row + left] === PARTITION_KIND.land ? heights[row + left]! : here;
      const hr = kind[row + right] === PARTITION_KIND.land ? heights[row + right]! : here;
      const ha = kind[above + x] === PARTITION_KIND.land ? heights[above + x]! : here;
      const hb = kind[below + x] === PARTITION_KIND.land ? heights[below + x]! : here;
      const dx = hr - hl;
      const dy = hb - ha;
      // |gradient| = sqrt(dx^2 + dy^2) / 2 per pixel; times 16.
      const value = Math.sqrt(dx * dx + dy * dy) * 8;
      output[row + x] = value > 255 ? 255 : Math.round(value);
    }
  }
  return output;
}

/**
 * Ridge strength: how far a land pixel stands above the mean of its two neighbours three pixels
 * away along the best of four axes, times 10. A crest line is a band a few pixels wide.
 */
export function ridgeField(
  heights: Uint8Array,
  kind: Uint8Array,
  width: number,
  height: number,
  reach = 3,
): Uint8Array {
  const output = new Uint8Array(width * height);
  const axes: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      if (kind[p] !== PARTITION_KIND.land) continue;
      const here = heights[p]!;
      let best = 0;
      for (const [ax, ay] of axes) {
        const y0 = y - ay * reach;
        const y1 = y + ay * reach;
        if (y0 < 0 || y1 >= height || y0 >= height || y1 < 0) continue;
        const x0 = (((x - ax * reach) % width) + width) % width;
        const x1 = (x + ax * reach) % width;
        const p0 = y0 * width + x0;
        const p1 = y1 * width + x1;
        // Water at either end is no valley: it counts as level ground.
        const h0 = kind[p0] === PARTITION_KIND.land ? heights[p0]! : here;
        const h1 = kind[p1] === PARTITION_KIND.land ? heights[p1]! : here;
        const lift = here - (h0 + h1) / 2;
        if (lift > best) best = lift;
      }
      const value = best * 10;
      output[p] = value > 255 ? 255 : Math.round(value);
    }
  }
  return output;
}

const FERTILITY_BASE: Record<number, number> = {
  [PARTITION_TERRAIN.plains]: 150,
  [PARTITION_TERRAIN.farmland]: 225,
  [PARTITION_TERRAIN.forest]: 110,
  [PARTITION_TERRAIN.hills]: 85,
  [PARTITION_TERRAIN.mountain]: 20,
  [PARTITION_TERRAIN.desert]: 25,
  [PARTITION_TERRAIN.marsh]: 70,
  [PARTITION_TERRAIN.jungle]: 95,
  [PARTITION_TERRAIN.snow]: 5,
  [PARTITION_TERRAIN.urban]: 140,
};

/**
 * Fertility from terrain class, river proximity (valleys are rich), slope and optional moisture.
 * The relief and climate stages replace it with their own field; the partition only reads bytes.
 */
export function fertilityField(
  kind: Uint8Array,
  terrainClass: Uint8Array,
  riverDistance: Uint8Array,
  slope: Uint8Array,
  moisture: Uint8Array | undefined,
): Uint8Array {
  const output = new Uint8Array(kind.length);
  for (let p = 0; p < kind.length; p++) {
    if (kind[p] !== PARTITION_KIND.land) continue;
    let value = FERTILITY_BASE[terrainClass[p]!] ?? 100;
    const river = riverDistance[p]!;
    if (river <= 14) value += (14 - river) * 4;
    value -= slope[p]! * 0.5;
    if (moisture !== undefined) value += (moisture[p]! - 128) * 0.25;
    output[p] = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  }
  return output;
}

/** Compute the partition fields from the bitmaps a map already has. */
export function partitionFieldsFromBitmaps(input: PartitionBitmapInput): PartitionFields {
  const { width, height, kind } = input;
  const total = width * height;
  const riverMax = input.riverMaxIndex ?? 11;
  const rivers = input.rivers;
  const riverDistance =
    rivers === undefined
      ? new Uint8Array(total).fill(255)
      : chamferDistance(
          (p) => rivers[p]! <= riverMax && kind[p] === PARTITION_KIND.land,
          width,
          height,
        );
  const slope =
    input.heights === undefined
      ? new Uint8Array(total)
      : slopeField(input.heights, kind, width, height);
  const ridge =
    input.heights === undefined
      ? new Uint8Array(total)
      : ridgeField(input.heights, kind, width, height);
  const terrainClass = new Uint8Array(total).fill(PARTITION_TERRAIN.water);
  const table = input.terrainClasses ?? defaultTerrainClassTable();
  for (let p = 0; p < total; p++)
    if (kind[p] === PARTITION_KIND.land)
      terrainClass[p] =
        input.terrain === undefined ? PARTITION_TERRAIN.plains : table[input.terrain[p]!]!;
  for (let p = 0; p < total; p++)
    if (kind[p] === PARTITION_KIND.land && terrainClass[p] === PARTITION_TERRAIN.water)
      terrainClass[p] = PARTITION_TERRAIN.plains;
  return {
    width,
    height,
    kind,
    riverDistance,
    ridge,
    slope,
    terrainClass,
    regionId: input.regionId ?? new Uint16Array(total),
    fertility: fertilityField(kind, terrainClass, riverDistance, slope, input.moisture),
    barrier: input.barrier ?? new Uint8Array(total),
    ...(input.regions === undefined ? {} : { regions: input.regions }),
  };
}
