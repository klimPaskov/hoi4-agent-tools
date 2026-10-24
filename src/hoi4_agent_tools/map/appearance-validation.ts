/**
 * Validators for the files that decide how a map looks: the heightmap, terrain, river and tree
 * bitmaps, the colour maps, the normal map and the city map (ADR 0053, 0054, 0061). Structural
 * validation alone passes maps whose lakes are translucent, whose colour map is washed out and
 * whose coasts are cut by the wrapping seam. Files are examined only when they are in the
 * scanned set; every pass reads the bitmaps in row strips and yields between strips so the
 * validation stays cancellable.
 *
 * Severities are calibrated against the installed base game, which must raise no error: a
 * handful of stray pixels is a warning, a defect that covers a whole lake or river is an error.
 */
import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import { RenderBudget } from '../core/render-budget.js';
import type { ScannedFile } from '../core/scanner.js';
import { assignments, firstScalar, parseClausewitz } from '../core/source/index.js';
import { decodeDds } from '../gui/dds.js';
import { BUNDLED_ATLAS_TILE_MEANS, terrainTileTable } from './atlas-tiles.js';
import { overlayForward } from './colormap-overlay.js';
import { BmpImage } from './bmp.js';
import { MAP_PROVINCE_ENGINE_MAX_PIXELS, defaultMapSelectorValue } from './model.js';
import type { MapWorkspaceIndex } from './model.js';
import {
  LAKE_BANK_ALLOWANCE_PX,
  LAKE_BANK_MAXIMUM_HEIGHT,
  LAKE_MINIMUM_PIXELS,
  WATER_OPAQUE_HEIGHT,
  landDistanceField,
} from './water.js';
import type { EdgeMode } from './world-edge.js';

export type AppearanceSteps = Generator<void, void, void>;

export interface AppearanceOptions {
  signal?: AbortSignal | undefined;
  /** The edge policy the world was generated with, when known; it sets seam severities. */
  edgeMode?: EdgeMode | undefined;
}

export type AppearanceReport = (diagnostic: Omit<Diagnostic, 'category'>) => void;
type Report = AppearanceReport;

const SEA = 0;
const LAND = 1;
const LAKE = 2;
const UNKNOWN = 3;
const STRIP_ROWS = 64;
const SAMPLE_LIMIT = 8;

/** Performance guard for river networks, and the colour-map and water ranges of ADR 0054. */
export const RIVER_PIXEL_LIMIT = 130_000;
export const RIVER_LAND_SHARE_LIMIT = 0.025;
export const COLORMAP_MEAN_VALUE_RANGE = [50, 100] as const;
export const COLORMAP_DISTINCT_MINIMUM = 400;
export const COLORMAP_DEVIATION_MINIMUM = 15;
export const WATER_COLORMAP_DEVIATION_MINIMUM = 8;
/** Mean luminance (0..1) the overlay model predicts for land; the base game's is 0.525 (ADR 0057). */
export const ALBEDO_LUMINANCE_RANGE = [0.4, 0.65] as const;
/** One graphical terrain index on more than this share of the land is a monotone terrain bitmap. */
export const TERRAIN_DOMINANCE_LIMIT = 0.7;

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function locate(file: ScannedFile): SourceLocation {
  return {
    path: file.displayPath,
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
}

function mapFile(index: MapWorkspaceIndex, name: string): ScannedFile | undefined {
  for (const root of index.sourceRoots.map) {
    const found = index.activeFiles.byRelativePath.get(normalized(`${root}/${name}`));
    if (found !== undefined) return found;
  }
  return undefined;
}

function selectedFile(
  index: MapWorkspaceIndex,
  selector: string,
  fallback: string,
): ScannedFile | undefined {
  try {
    return mapFile(index, defaultMapSelectorValue(index.defaultMapFile, selector, fallback));
  } catch {
    return undefined;
  }
}

function decodeBitmap(file: ScannedFile, report: Report, code: string): BmpImage | undefined {
  try {
    return BmpImage.decode(file.bytes);
  } catch (error) {
    report({
      code,
      severity: 'error',
      message: `${file.relativePath} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      location: locate(file),
    });
    return undefined;
  }
}

/** Zero-copy access to the rows of a bitmap in top-left order. */
function rowOf(image: BmpImage, y: number): Uint8Array {
  const row = image.topDown ? y : image.height - 1 - y;
  const start = image.pixelOffset + row * image.rowStride;
  return image.bytes.subarray(start, start + image.width * (image.bitsPerPixel === 24 ? 3 : 1));
}

interface Raster {
  width: number;
  height: number;
  /** Province type per pixel: 0 sea, 1 land, 2 lake, 3 unknown. */
  kind: Uint8Array;
  landPixels: number;
  seaPixels: number;
}

function buildRaster(index: MapWorkspaceIndex): Raster | undefined {
  const raster = index.raster;
  if (raster === undefined) return undefined;
  const typeById = new Map<number, number>();
  for (const definition of index.definitions)
    if (!typeById.has(definition.id))
      typeById.set(
        definition.id,
        definition.type === 'land' ? LAND : definition.type === 'lake' ? LAKE : SEA,
      );
  const kind = new Uint8Array(raster.width * raster.height);
  let landPixels = 0;
  let seaPixels = 0;
  for (let pixel = 0; pixel < kind.length; pixel += 1) {
    const type = typeById.get(raster.provinceIds[pixel]!) ?? UNKNOWN;
    kind[pixel] = type;
    if (type === LAND) landPixels += 1;
    else if (type === SEA) seaPixels += 1;
  }
  return { width: raster.width, height: raster.height, kind, landPixels, seaPixels };
}

interface TerrainEntry {
  name: string;
  index: number;
  type: string;
  texture?: number;
}

function graphicalTerrain(index: MapWorkspaceIndex): TerrainEntry[] | undefined {
  const files = index.activeFiles.all.filter((file) =>
    /^common\/terrain\/[^/]+\.txt$/u.test(normalized(file.relativePath)),
  );
  if (files.length === 0) return undefined;
  const entries: TerrainEntry[] = [];
  try {
    for (const file of files) {
      const document = parseClausewitz(file.bytes, file.displayPath);
      for (const section of assignments(document.root, 'terrain'))
        if (section.value.type === 'block')
          for (const entry of assignments(section.value)) {
            if (entry.value.type !== 'block') continue;
            const type = firstScalar(entry.value, 'type')?.value;
            const texture = firstScalar(entry.value, 'texture')?.value;
            const colors = assignments(entry.value, 'color')[0]?.value;
            if (type === undefined || colors?.type !== 'block') continue;
            for (const color of colors.entries)
              if (color.type === 'scalar' && /^\d+$/u.test(color.value))
                entries.push({
                  name: entry.key.value,
                  index: Number(color.value),
                  type,
                  ...(texture !== undefined && /^\d+$/u.test(texture)
                    ? { texture: Number(texture) }
                    : {}),
                });
          }
    }
  } catch {
    return undefined;
  }
  return entries.length === 0 ? undefined : entries;
}

function* checkProvinceMapSize(
  file: ScannedFile,
  image: BmpImage,
  raster: Raster,
  report: Report,
  code: string,
  expectedWidth: number,
  expectedHeight: number,
): AppearanceSteps {
  yield;
  if (image.width !== expectedWidth || image.height !== expectedHeight)
    report({
      code,
      severity: 'error',
      message: `${file.relativePath} is ${image.width}x${image.height}; the province map is ${raster.width}x${raster.height}, so this file must be ${expectedWidth}x${expectedHeight}`,
      location: locate(file),
      details: {
        width: image.width,
        height: image.height,
        expectedWidth,
        expectedHeight,
      },
    });
}

// ---------------------------------------------------------------------------------------------
// Heightmap and lake surfaces

function* validateHeightmap(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const file = index.heightmapFile;
  if (file === undefined) return;
  const image = decodeBitmap(file, report, 'MAP_HEIGHT_UNREADABLE');
  if (image === undefined) return;
  if (image.bitsPerPixel !== 8) {
    report({
      code: 'MAP_HEIGHT_FORMAT',
      severity: 'error',
      message: `${file.relativePath} must be an 8-bit greyscale bitmap`,
      location: locate(file),
      details: { bitsPerPixel: image.bitsPerPixel },
    });
    return;
  }
  if (image.width !== raster.width || image.height !== raster.height) {
    yield* checkProvinceMapSize(
      file,
      image,
      raster,
      report,
      'MAP_HEIGHT_SIZE',
      raster.width,
      raster.height,
    );
    return;
  }
  const { width, height, kind } = raster;
  const hasLake = kind.includes(LAKE);
  const distance = hasLake ? landDistanceField(kind, width, height) : undefined;
  let lakePixels = 0;
  let landBelow = 0;
  let seaAbove = 0;
  let tooHigh = 0;
  let unrendered = 0;
  const highSamples: Array<{ x: number; y: number; height: number }> = [];
  let seamSteps = 0;
  const palette = image.palette;
  const value = (raw: number): number => palette[raw]?.r ?? raw;
  for (let y = 0; y < height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y);
    for (let x = 0; x < width; x += 1) {
      const pixelKind = kind[y * width + x]!;
      const h = value(row[x]!);
      if (pixelKind === LAND) {
        if (h < 94) landBelow += 1;
      } else if (pixelKind === SEA) {
        if (h > 94) seaAbove += 1;
      } else if (pixelKind === LAKE) {
        lakePixels += 1;
        if (h > LAKE_BANK_MAXIMUM_HEIGHT) unrendered += 1;
        if (h > WATER_OPAQUE_HEIGHT && (distance?.[y * width + x] ?? 0) > LAKE_BANK_ALLOWANCE_PX) {
          tooHigh += 1;
          if (highSamples.length < SAMPLE_LIMIT) highSamples.push({ x, y, height: h });
        }
      }
    }
    if (Math.abs(value(row[0]!) - value(row[width - 1]!)) > 4) seamSteps += 1;
  }
  // The base game has a handful of translucent lake pixels (about 0.1%); a whole lake at the
  // wrong height is the defect.
  if (tooHigh > 0)
    report({
      code: 'MAP_LAKE_SURFACE_TOO_HIGH',
      severity: tooHigh / Math.max(1, lakePixels) > 0.05 ? 'error' : 'warning',
      message: `${tooHigh} lake pixels lie above height ${WATER_OPAQUE_HEIGHT} away from the shore; the water layer draws them translucent, so the lake shows the ground through it. Write lake interiors at 89`,
      location: locate(file),
      details: {
        pixels: tooHigh,
        opaqueUpTo: WATER_OPAQUE_HEIGHT,
        bankPx: LAKE_BANK_ALLOWANCE_PX,
        samples: highSamples,
      },
    });
  if (unrendered > 0 && unrendered / Math.max(1, lakePixels) > 0.01)
    report({
      code: 'MAP_HEIGHT_LAKE_ABOVE_SURFACE',
      severity: 'warning',
      message: `${unrendered} lake pixels are at or above the water surface (height 95), so no water is drawn there`,
      location: locate(file),
      details: { pixels: unrendered },
    });
  if (landBelow / Math.max(1, raster.landPixels) > 0.005)
    report({
      code: 'MAP_HEIGHT_LAND_BELOW_COAST',
      severity: 'warning',
      message: `${landBelow} land pixels lie below height 94, where the water layer covers them`,
      location: locate(file),
      details: { pixels: landBelow },
    });
  if (seaAbove / Math.max(1, raster.seaPixels) > 0.005)
    report({
      code: 'MAP_HEIGHT_SEA_ABOVE_SURFACE',
      severity: 'warning',
      message: `${seaAbove} sea pixels lie above height 94 and draw as shallow or dry ground`,
      location: locate(file),
      details: { pixels: seaAbove },
    });
  if (seamSteps > 0)
    report({
      code: 'MAP_HEIGHT_SEAM_STEP',
      severity: 'warning',
      message: `${seamSteps} rows differ by more than 4 between the first and last column; the terrain steps where the world wraps`,
      location: locate(file),
      details: { rows: seamSteps },
    });
}

// ---------------------------------------------------------------------------------------------
// terrain.bmp

function* validateTerrainBitmap(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const file = selectedFile(index, 'terrain', 'terrain.bmp');
  if (file === undefined) return;
  const image = decodeBitmap(file, report, 'MAP_TERRAIN_BITMAP_UNREADABLE');
  if (image === undefined) return;
  if (image.bitsPerPixel !== 8) {
    report({
      code: 'MAP_TERRAIN_BITMAP_FORMAT',
      severity: 'error',
      message: `${file.relativePath} must be an 8-bit indexed bitmap`,
      location: locate(file),
      details: { bitsPerPixel: image.bitsPerPixel },
    });
    return;
  }
  if (image.width !== raster.width || image.height !== raster.height) {
    yield* checkProvinceMapSize(
      file,
      image,
      raster,
      report,
      'MAP_TERRAIN_BITMAP_SIZE',
      raster.width,
      raster.height,
    );
    return;
  }
  const entries = graphicalTerrain(index);
  const byIndex = new Map<number, TerrainEntry>();
  for (const entry of entries ?? []) if (!byIndex.has(entry.index)) byIndex.set(entry.index, entry);
  const counts = new Uint32Array(256);
  const waterCounts = new Uint32Array(256);
  const landCounts = new Uint32Array(256);
  const { width, height, kind } = raster;
  for (let y = 0; y < height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y);
    for (let x = 0; x < width; x += 1) {
      const value = row[x]!;
      counts[value]! += 1;
      if (kind[y * width + x] === LAKE) waterCounts[value]! += 1;
      else if (kind[y * width + x] === LAND) landCounts[value]! += 1;
    }
  }
  if (raster.landPixels >= 4_000) {
    let top = 0;
    for (let value = 1; value < 256; value += 1)
      if (landCounts[value]! > landCounts[top]!) top = value;
    const share = landCounts[top]! / raster.landPixels;
    if (share > TERRAIN_DOMINANCE_LIMIT)
      report({
        code: 'MAP_TERRAIN_BITMAP_DOMINATED',
        severity: 'info',
        message: `${file.relativePath} draws graphical terrain index ${top} on ${Math.round(share * 100)}% of the land; the base game's most common index covers 21%, so the map will look uniform`,
        location: locate(file),
        details: { index: top, share: Math.round(share * 1000) / 1000 },
      });
  }
  if (entries === undefined) return;
  const undefinedIndices: Array<{ index: number; pixels: number }> = [];
  const unrendered: Array<{ index: number; name: string; pixels: number; lakePixels: number }> = [];
  for (let value = 0; value < 256; value += 1) {
    if (counts[value] === 0) continue;
    const entry = byIndex.get(value);
    if (entry === undefined) undefinedIndices.push({ index: value, pixels: counts[value]! });
    else if (entry.texture === 255)
      unrendered.push({
        index: value,
        name: entry.name,
        pixels: counts[value]!,
        lakePixels: waterCounts[value]!,
      });
  }
  const undefinedPixels = undefinedIndices.reduce((sum, item) => sum + item.pixels, 0);
  if (undefinedIndices.length > 0)
    report({
      code: 'MAP_TERRAIN_BITMAP_INDEX_UNDEFINED',
      severity: undefinedPixels > width * height * 0.001 ? 'error' : 'warning',
      message: `${file.relativePath} uses ${undefinedIndices.length} palette index(es) that no graphical terrain in common/terrain defines`,
      location: locate(file),
      details: { indices: undefinedIndices.slice(0, 32) },
    });
  if (unrendered.length > 0)
    report({
      code: 'MAP_LAKE_TEXTURE_UNRENDERED',
      severity: 'error',
      message: `${file.relativePath} uses graphical terrain index ${unrendered.map((item) => item.index).join(', ')}, which selects no atlas tile (texture = 255); the engine draws nothing useful there. Use the ocean index for lakes`,
      location: locate(file),
      details: { indices: unrendered },
    });
}

// ---------------------------------------------------------------------------------------------
// rivers.bmp

function* validateRivers(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const file = selectedFile(index, 'rivers', 'rivers.bmp');
  if (file === undefined) return;
  const image = decodeBitmap(file, report, 'MAP_RIVER_UNREADABLE');
  if (image === undefined) return;
  if (image.bitsPerPixel !== 8) {
    report({
      code: 'MAP_RIVER_FORMAT',
      severity: 'error',
      message: `${file.relativePath} must be an 8-bit indexed bitmap (the engine refuses other depths)`,
      location: locate(file),
      details: { bitsPerPixel: image.bitsPerPixel },
    });
    return;
  }
  const colorsUsed = file.bytes.readUInt32LE(46);
  if (colorsUsed !== 0)
    report({
      code: 'MAP_RIVER_PALETTE_COUNT',
      severity: 'warning',
      message: `${file.relativePath} declares ${colorsUsed} palette colours; the engine logs "Palette in rivers.bmp is probably not correct" unless the header count is 0`,
      location: locate(file),
      details: { colorsUsed },
    });
  if (image.width !== raster.width || image.height !== raster.height) {
    yield* checkProvinceMapSize(
      file,
      image,
      raster,
      report,
      'MAP_RIVER_SIZE',
      raster.width,
      raster.height,
    );
    return;
  }
  const { width, height, kind } = raster;
  let riverPixels = 0;
  const badIndex: Array<{ x: number; y: number; value: number }> = [];
  let badIndexCount = 0;
  let blocks = 0;
  const blockSamples: Array<{ x: number; y: number }> = [];
  let notOrthogonal = 0;
  const orthogonalSamples: Array<{ x: number; y: number }> = [];
  let onSea = 0;
  const seaSamples: Array<{ x: number; y: number }> = [];
  const isRiver = (value: number): boolean => value <= 11;
  let previous: Uint8Array | undefined;
  let current: Uint8Array = rowOf(image, 0);
  for (let y = 0; y < height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const next = y + 1 < height ? rowOf(image, y + 1) : undefined;
    for (let x = 0; x < width; x += 1) {
      const value = current[x]!;
      if (!isRiver(value)) {
        if (value < 254) {
          badIndexCount += 1;
          if (badIndex.length < SAMPLE_LIMIT) badIndex.push({ x, y, value });
        }
        continue;
      }
      riverPixels += 1;
      if (kind[y * width + x] === SEA) {
        onSea += 1;
        if (seaSamples.length < SAMPLE_LIMIT) seaSamples.push({ x, y });
      }
      const east = x + 1 < width && isRiver(current[x + 1]!);
      const west = x > 0 && isRiver(current[x - 1]!);
      const south = next !== undefined && isRiver(next[x]!);
      const north = previous !== undefined && isRiver(previous[x]!);
      const southEast = next !== undefined && x + 1 < width && isRiver(next[x + 1]!);
      if (east && south && southEast) {
        blocks += 1;
        if (blockSamples.length < SAMPLE_LIMIT) blockSamples.push({ x, y });
      }
      if (!east && !west && !south && !north) {
        notOrthogonal += 1;
        if (orthogonalSamples.length < SAMPLE_LIMIT) orthogonalSamples.push({ x, y });
      }
    }
    previous = current;
    current = next ?? current;
  }
  if (badIndexCount > 0)
    report({
      code: 'MAP_RIVER_INDEX_INVALID',
      severity: 'error',
      message: `${badIndexCount} river pixels use an index other than 0 to 11, 254 or 255`,
      location: locate(file),
      details: { pixels: badIndexCount, samples: badIndex },
    });
  if (blocks > 0)
    report({
      code: 'MAP_RIVER_BLOCK',
      severity: blocks > riverPixels * 0.005 ? 'error' : 'warning',
      message: `${blocks} places hold a 2 x 2 block of river pixels; rivers are one pixel thick`,
      location: locate(file),
      details: { blocks, samples: blockSamples },
    });
  if (notOrthogonal > 0)
    report({
      code: 'MAP_RIVER_NOT_ORTHOGONAL',
      severity: 'warning',
      message: `${notOrthogonal} river pixels touch no other river pixel orthogonally (isolated or diagonal-only), which breaks the river path`,
      location: locate(file),
      details: { pixels: notOrthogonal, samples: orthogonalSamples },
    });
  if (onSea > 0)
    report({
      code: 'MAP_RIVER_ON_WATER',
      severity: 'warning',
      message: `${onSea} river pixels lie on sea provinces`,
      location: locate(file),
      details: { pixels: onSea, samples: seaSamples },
    });
  if (
    riverPixels > RIVER_PIXEL_LIMIT ||
    (raster.landPixels > 0 && riverPixels / raster.landPixels > RIVER_LAND_SHARE_LIMIT)
  )
    report({
      code: 'MAP_RIVER_DENSITY',
      severity: 'warning',
      message: `${riverPixels} river pixels (${((100 * riverPixels) / Math.max(1, raster.landPixels)).toFixed(2)}% of land) exceed the guard of ${RIVER_PIXEL_LIMIT} pixels or 2.5% of land; long river networks slow the game`,
      location: locate(file),
      details: { pixels: riverPixels, landPixels: raster.landPixels },
    });
  yield* validateRiverSources(file, image, report, options);
}

/** Every connected river should have exactly one green source (index 0). */
function* validateRiverSources(
  file: ScannedFile,
  image: BmpImage,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const { width, height } = image;
  const rows = (y: number): Uint8Array => rowOf(image, y);
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    const row = rows(y);
    for (let x = 0; x < width; x += 1) if (row[x]! <= 11) count += 1;
    if (y % (STRIP_ROWS * 4) === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
  }
  if (count === 0) return;
  // Component labelling over only the river pixels, keyed by pixel offset.
  const offsets = new Uint32Array(count);
  let fill = 0;
  for (let y = 0; y < height; y += 1) {
    const row = rows(y);
    for (let x = 0; x < width; x += 1) if (row[x]! <= 11) offsets[fill++] = y * width + x;
  }
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i += 1) parent[i] = i;
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== root) {
      const next = parent[value]!;
      parent[value] = root;
      value = next;
    }
    return root;
  };
  // offsets are sorted, so the neighbour's slot is found by binary search.
  const slotOf = (offset: number): number => {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const at = offsets[mid]!;
      if (at === offset) return mid;
      if (at < offset) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  };
  for (let i = 0; i < count; i += 1) {
    if (i % 65_536 === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const offset = offsets[i]!;
    const x = offset % width;
    if (x + 1 < width) {
      const east = slotOf(offset + 1);
      if (east >= 0) parent[find(i)] = find(east);
    }
    const south = slotOf(offset + width);
    if (south >= 0) parent[find(i)] = find(south);
  }
  const sources = new Map<number, number>();
  const firstOf = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const root = find(i);
    if (!firstOf.has(root)) firstOf.set(root, offsets[i]!);
    const y = Math.floor(offsets[i]! / width);
    if (rows(y)[offsets[i]! % width] === 0) sources.set(root, (sources.get(root) ?? 0) + 1);
    else if (!sources.has(root)) sources.set(root, 0);
  }
  let none = 0;
  let several = 0;
  const sampleOf: Array<{ x: number; y: number; sources: number }> = [];
  for (const [root, total] of sources) {
    if (total === 1) continue;
    if (total === 0) none += 1;
    else several += 1;
    if (sampleOf.length < SAMPLE_LIMIT) {
      const offset = firstOf.get(root)!;
      sampleOf.push({ x: offset % width, y: Math.floor(offset / width), sources: total });
    }
  }
  if (none + several > 0)
    report({
      code: 'MAP_RIVER_SOURCE_COUNT',
      severity: 'warning',
      message: `${none} connected river(s) have no green source (index 0) and ${several} have several; each river wants exactly one source on its main branch`,
      location: locate(file),
      details: { withoutSource: none, withSeveralSources: several, samples: sampleOf },
    });
}

// ---------------------------------------------------------------------------------------------
// trees.bmp

function* validateTrees(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const file = selectedFile(index, 'tree_definition', 'trees.bmp');
  if (file === undefined) return;
  const image = decodeBitmap(file, report, 'MAP_TREES_UNREADABLE');
  if (image === undefined) return;
  if (image.bitsPerPixel !== 8) {
    report({
      code: 'MAP_TREES_FORMAT',
      severity: 'error',
      message: `${file.relativePath} must be an 8-bit indexed bitmap`,
      location: locate(file),
      details: { bitsPerPixel: image.bitsPerPixel },
    });
    return;
  }
  const expectedWidth = Math.round((raster.width * 75) / 256);
  const expectedHeight = Math.round((raster.height * 75) / 256);
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    yield* checkProvinceMapSize(
      file,
      image,
      raster,
      report,
      'MAP_TREES_SIZE',
      expectedWidth,
      expectedHeight,
    );
    return;
  }
  let invalid = 0;
  let onWater = 0;
  let nonZero = 0;
  const samplesOnWater: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < image.height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y);
    for (let x = 0; x < image.width; x += 1) {
      const value = row[x]!;
      if (value === 0) continue;
      nonZero += 1;
      if (value >= image.palette.length) invalid += 1;
      // A tree cell stands over water only when every sample of its footprint is water.
      let allWater = true;
      for (const [fx, fy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [0.5, 0.5],
      ] as const) {
        const sourceX = Math.min(
          raster.width - 1,
          Math.floor(((x + fx * 0.999) * raster.width) / image.width),
        );
        const sourceY = Math.min(
          raster.height - 1,
          Math.floor(((y + fy * 0.999) * raster.height) / image.height),
        );
        const kind = raster.kind[sourceY * raster.width + sourceX]!;
        if (kind !== SEA && kind !== LAKE) {
          allWater = false;
          break;
        }
      }
      if (allWater) {
        onWater += 1;
        if (samplesOnWater.length < SAMPLE_LIMIT) samplesOnWater.push({ x, y });
      }
    }
  }
  if (invalid > 0)
    report({
      code: 'MAP_TREES_INDEX_INVALID',
      severity: 'error',
      message: `${invalid} tree cells use a palette index beyond the ${image.palette.length} entries of ${file.relativePath}`,
      location: locate(file),
      details: { cells: invalid },
    });
  if (nonZero > 0 && onWater / nonZero > 0.02)
    report({
      code: 'MAP_TREES_ON_WATER',
      severity: 'warning',
      message: `${onWater} tree cells (${((100 * onWater) / nonZero).toFixed(1)}%) stand over sea or lake provinces`,
      location: locate(file),
      details: { cells: onWater, samples: samplesOnWater },
    });
}

// ---------------------------------------------------------------------------------------------
// Colour maps

interface Pixels {
  width: number;
  height: number;
  /** RGBA, top row first. */
  data: Buffer;
}

function readDds(file: ScannedFile, report: Report): Pixels | undefined {
  if (file.bytes.length < 128 || file.bytes.readUInt32LE(0) !== 0x2053_4444) {
    report({
      code: 'MAP_COLORMAP_UNREADABLE',
      severity: 'error',
      message: `${file.relativePath} is not a DDS texture`,
      location: locate(file),
    });
    return undefined;
  }
  try {
    const decoded = decodeDds(file.bytes, new RenderBudget());
    if ('unsupported' in decoded) {
      report({
        code: 'MAP_COLORMAP_UNREADABLE',
        severity: 'info',
        message: `${file.relativePath} is in a DDS format this tool does not examine (${decoded.format})`,
        location: locate(file),
        details: { format: decoded.format, reason: decoded.reason },
      });
      return undefined;
    }
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  } catch {
    report({
      code: 'MAP_COLORMAP_UNREADABLE',
      severity: 'info',
      message: `${file.relativePath} could not be decoded within the raster limits and was not examined`,
      location: locate(file),
    });
    return undefined;
  }
}

function* validateColourMaps(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const land = mapFile(index, 'terrain/colormap_rgb_cityemissivemask_a.dds');
  if (land !== undefined && land.bytes.length >= 128) {
    const headerHeight = land.bytes.readUInt32LE(12);
    const headerWidth = land.bytes.readUInt32LE(16);
    const expectedWidth = raster.width / 2;
    const expectedHeight = raster.height / 2;
    if (headerWidth !== expectedWidth || headerHeight !== expectedHeight)
      report({
        code: 'MAP_COLORMAP_SIZE',
        severity: 'error',
        message: `${land.relativePath} is ${headerWidth}x${headerHeight}; the colour map must be half the province map, ${expectedWidth}x${expectedHeight}`,
        location: locate(land),
        details: { width: headerWidth, height: headerHeight, expectedWidth, expectedHeight },
      });
    else {
      yield;
      const pixels = readDds(land, report);
      if (pixels !== undefined) yield* landColourStatistics(land, pixels, raster, report, options);
    }
  }
  for (const level of [0, 1, 2]) {
    const water = mapFile(index, `terrain/colormap_water_${level}.dds`);
    if (water === undefined || water.bytes.length < 128) continue;
    const factor = 2 ** (level + 1);
    const headerHeight = water.bytes.readUInt32LE(12);
    const headerWidth = water.bytes.readUInt32LE(16);
    const expectedWidth = raster.width / factor;
    const expectedHeight = raster.height / factor;
    if (headerWidth !== expectedWidth || headerHeight !== expectedHeight) {
      report({
        code: 'MAP_COLORMAP_SIZE',
        severity: 'error',
        message: `${water.relativePath} is ${headerWidth}x${headerHeight}; level ${level} must be 1/${factor} of the province map, ${expectedWidth}x${expectedHeight}`,
        location: locate(water),
        details: { width: headerWidth, height: headerHeight, expectedWidth, expectedHeight },
      });
      continue;
    }
    if (level !== 0) continue;
    yield;
    const pixels = readDds(water, report);
    if (pixels === undefined) continue;
    let count = 0;
    const sums = [0, 0, 0];
    const squares = [0, 0, 0];
    for (let y = 0; y < pixels.height; y += 1) {
      if (y % STRIP_ROWS === 0) {
        options.signal?.throwIfAborted();
        yield;
      }
      for (let x = 0; x < pixels.width; x += 1) {
        if (raster.kind[y * factor * raster.width + x * factor] !== SEA) continue;
        const offset = (y * pixels.width + x) * 4;
        count += 1;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = pixels.data[offset + channel]!;
          sums[channel]! += value;
          squares[channel]! += value * value;
        }
      }
    }
    if (count > 1000) {
      const deviation = sums.map((sum, channel) =>
        Math.sqrt(Math.max(0, squares[channel]! / count - (sum / count) ** 2)),
      );
      const mean = (deviation[0]! + deviation[1]! + deviation[2]!) / 3;
      if (mean < WATER_COLORMAP_DEVIATION_MINIMUM)
        report({
          code: 'MAP_WATER_COLORMAP_FLAT',
          severity: 'warning',
          message: `${water.relativePath} is almost one colour over the sea (deviation ${mean.toFixed(1)}); the base game's varies by about 40 and shows the shelf as a lighter band`,
          location: locate(water),
          details: { deviation: deviation.map((value) => Math.round(value * 10) / 10) },
        });
    }
  }
}

function* landColourStatistics(
  file: ScannedFile,
  pixels: Pixels,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  let landCount = 0;
  let valueSum = 0;
  let valueSquares = 0;
  const distinct = new Set<number>();
  let lightsOnWater = 0;
  for (let y = 0; y < pixels.height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    for (let x = 0; x < pixels.width; x += 1) {
      const kind = raster.kind[y * 2 * raster.width + x * 2]!;
      const offset = (y * pixels.width + x) * 4;
      if (kind === LAND) {
        const r = pixels.data[offset]!;
        const g = pixels.data[offset + 1]!;
        const b = pixels.data[offset + 2]!;
        const value = Math.max(r, g, b);
        landCount += 1;
        valueSum += value;
        valueSquares += value * value;
        distinct.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      } else if ((kind === SEA || kind === LAKE) && pixels.data[offset + 3]! > 0)
        lightsOnWater += 1;
    }
  }
  if (lightsOnWater > 0)
    report({
      code: 'MAP_COLORMAP_ALPHA_CITY',
      severity: 'info',
      message: `${lightsOnWater} colour map pixels over water carry city-light alpha`,
      location: locate(file),
      details: { pixels: lightsOnWater },
    });
  if (landCount < 100) return;
  const mean = valueSum / landCount;
  const deviation = Math.sqrt(Math.max(0, valueSquares / landCount - mean * mean));
  // Small maps cannot hold hundreds of colours, so the floor scales with the land area.
  const distinctMinimum = Math.min(COLORMAP_DISTINCT_MINIMUM, Math.floor(landCount / 100));
  const problems: string[] = [];
  if (mean < COLORMAP_MEAN_VALUE_RANGE[0] || mean > COLORMAP_MEAN_VALUE_RANGE[1])
    problems.push(
      `mean value ${mean.toFixed(0)} is outside ${COLORMAP_MEAN_VALUE_RANGE[0]} to ${COLORMAP_MEAN_VALUE_RANGE[1]} (the base game's is 74; a brighter colour map leaves the atlas pale)`,
    );
  if (distinct.size < distinctMinimum)
    problems.push(`${distinct.size} distinct 5-bit colours is below ${distinctMinimum}`);
  if (deviation < COLORMAP_DEVIATION_MINIMUM)
    problems.push(`value deviation ${deviation.toFixed(0)} is below ${COLORMAP_DEVIATION_MINIMUM}`);
  if (problems.length > 0)
    report({
      code: 'MAP_COLORMAP_RANGE',
      severity: 'warning',
      message: `The land colour map looks flat or washed out: ${problems.join('; ')}`,
      location: locate(file),
      details: {
        meanValue: Math.round(mean * 10) / 10,
        valueDeviation: Math.round(deviation * 10) / 10,
        distinct5BitColours: distinct.size,
        landPixels: landCount,
      },
    });
}

/**
 * The colour the terrain shader would show over the atlas, from the terrain bitmap and the colour
 * map (the overlay model of ADR 0057, with the bundled tile means). A mean luminance far from the
 * base game's means the map will render paler or darker than the base game, whatever the colour
 * map's own value statistics say.
 */
function* validateAlbedo(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const terrainFile = selectedFile(index, 'terrain', 'terrain.bmp');
  const colourFile = mapFile(index, 'terrain/colormap_rgb_cityemissivemask_a.dds');
  if (terrainFile === undefined || colourFile === undefined || colourFile.bytes.length < 128)
    return;
  if (
    colourFile.bytes.readUInt32LE(16) !== raster.width / 2 ||
    colourFile.bytes.readUInt32LE(12) !== raster.height / 2
  )
    return;
  let image: BmpImage;
  try {
    image = BmpImage.decode(terrainFile.bytes);
  } catch {
    return;
  }
  if (image.bitsPerPixel !== 8 || image.width !== raster.width || image.height !== raster.height)
    return;
  const colours = readDds(colourFile, () => undefined);
  if (colours === undefined) return;
  const tiles = terrainTileTable(
    graphicalTerrain(index)?.map(({ index: value, texture }) => ({ index: value, texture })),
  );
  let sum = 0;
  let cells = 0;
  for (let y = 0; y < colours.height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y * 2);
    for (let x = 0; x < colours.width; x += 1) {
      if (raster.kind[y * 2 * raster.width + x * 2] !== LAND) continue;
      const mean = BUNDLED_ATLAS_TILE_MEANS[tiles[row[x * 2]!]!]!;
      const offset = (y * colours.width + x) * 4;
      const r = overlayForward(mean[0] / 255, colours.data[offset]! / 255);
      const g = overlayForward(mean[1] / 255, colours.data[offset + 1]! / 255);
      const b = overlayForward(mean[2] / 255, colours.data[offset + 2]! / 255);
      sum += 0.3 * r + 0.59 * g + 0.11 * b;
      cells += 1;
    }
  }
  if (cells < 100) return;
  const luminance = sum / cells;
  if (luminance < ALBEDO_LUMINANCE_RANGE[0] || luminance > ALBEDO_LUMINANCE_RANGE[1])
    report({
      code: 'MAP_COLORMAP_ALBEDO_RANGE',
      severity: 'warning',
      message: `The terrain shader would show this land with a mean luminance of ${luminance.toFixed(2)} over the atlas, outside ${ALBEDO_LUMINANCE_RANGE[0]} to ${ALBEDO_LUMINANCE_RANGE[1]} (the base game's is 0.53): the map will render ${luminance > ALBEDO_LUMINANCE_RANGE[1] ? 'pale and washed out' : 'dark'}. Offline estimate from the overlay model, not a game screenshot`,
      location: locate(colourFile),
      details: { meanLuminance: Math.round(luminance * 1000) / 1000, landCells: cells },
    });
}

// ---------------------------------------------------------------------------------------------
// world_normal.bmp

function* validateNormals(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const file = mapFile(index, 'world_normal.bmp');
  if (file === undefined) return;
  const image = decodeBitmap(file, report, 'MAP_NORMAL_UNREADABLE');
  if (image === undefined) return;
  if (image.bitsPerPixel !== 24) {
    report({
      code: 'MAP_NORMAL_FORMAT',
      severity: 'error',
      message: `${file.relativePath} must be a 24-bit bitmap`,
      location: locate(file),
      details: { bitsPerPixel: image.bitsPerPixel },
    });
    return;
  }
  if (image.width !== raster.width / 2 || image.height !== raster.height / 2) {
    yield* checkProvinceMapSize(
      file,
      image,
      raster,
      report,
      'MAP_NORMAL_SIZE',
      raster.width / 2,
      raster.height / 2,
    );
    return;
  }
  let sampled = 0;
  let notUnit = 0;
  for (let y = 0; y < image.height; y += 4) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y);
    for (let x = 0; x < image.width; x += 4) {
      const nx = (row[x * 3 + 2]! - 127.5) / 127.5;
      const ny = (row[x * 3 + 1]! - 127.5) / 127.5;
      const nz = (row[x * 3]! - 127.5) / 127.5;
      sampled += 1;
      if (Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1) > 0.02) notUnit += 1;
    }
  }
  // The base game has about 10% of normals off unit length (hand detail); mostly-wrong is a defect.
  if (sampled > 0 && notUnit / sampled > 0.25)
    report({
      code: 'MAP_NORMAL_NOT_UNIT',
      severity: 'warning',
      message: `${((100 * notUnit) / sampled).toFixed(1)}% of sampled normals are not unit length within 2%`,
      location: locate(file),
      details: { sampled, notUnit },
    });
  // Response of the red channel to the east-west height step, against the base game's -2.6.
  const heightFile = index.heightmapFile;
  if (heightFile === undefined) return;
  const heights = decodeBitmap(heightFile, () => undefined, 'MAP_HEIGHT_UNREADABLE');
  if (
    heights?.bitsPerPixel !== 8 ||
    heights.width !== raster.width ||
    heights.height !== raster.height
  )
    return;
  const palette = heights.palette;
  const value = (raw: number): number => palette[raw]?.r ?? raw;
  let covariance = 0;
  let variance = 0;
  for (let y = 0; y < image.height; y += 2) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y);
    const heightRow = rowOf(heights, y * 2);
    for (let x = 1; x < image.width - 1; x += 2) {
      const step = value(heightRow[x * 2 + 2]!) - value(heightRow[x * 2 - 2]!);
      covariance += (row[x * 3 + 2]! - 128) * step;
      variance += step * step;
    }
  }
  if (variance < 2_000) return;
  const response = -covariance / variance;
  if (response < 0.5 || response > 6)
    report({
      code: 'MAP_NORMAL_RESPONSE',
      severity: 'warning',
      message: `The normal map responds ${response.toFixed(2)} per height step; the base game's is about 2.6, so shading will look ${response < 0.5 ? 'flat' : 'harsh'}`,
      location: locate(file),
      details: { response: Math.round(response * 100) / 100, expected: [0.5, 6] },
    });
}

// ---------------------------------------------------------------------------------------------
// cities.bmp

function* validateCities(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const file = mapFile(index, 'cities.bmp');
  if (file === undefined) return;
  const image = decodeBitmap(file, report, 'MAP_CITIES_UNREADABLE');
  if (image === undefined) return;
  if (image.bitsPerPixel !== 8) {
    report({
      code: 'MAP_CITIES_FORMAT',
      severity: 'error',
      message: `${file.relativePath} must be an 8-bit indexed bitmap`,
      location: locate(file),
      details: { bitsPerPixel: image.bitsPerPixel },
    });
    return;
  }
  if (image.width !== raster.width || image.height !== raster.height) {
    yield* checkProvinceMapSize(
      file,
      image,
      raster,
      report,
      'MAP_CITIES_SIZE',
      raster.width,
      raster.height,
    );
    return;
  }
  const counts = new Uint32Array(256);
  for (let y = 0; y < image.height; y += 1) {
    if (y % STRIP_ROWS === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const row = rowOf(image, y);
    for (let x = 0; x < image.width; x += 1) counts[row[x]!]! += 1;
  }
  const definitions = mapFile(index, 'cities.txt');
  if (definitions === undefined) return;
  const defined = new Set<number>();
  for (const match of definitions.bytes.toString('utf8').matchAll(/color_index\s*=\s*(\d+)/gu))
    defined.add(Number(match[1]));
  if (defined.size === 0) return;
  const undefinedIndices = [...counts.keys()].filter(
    (value) => counts[value]! > 0 && !defined.has(value),
  );
  if (undefinedIndices.length > 0)
    report({
      code: 'MAP_CITIES_INDEX_UNDEFINED',
      severity: 'warning',
      message: `${file.relativePath} uses palette index(es) ${undefinedIndices.slice(0, 10).join(', ')} that no city_group in cities.txt defines`,
      location: locate(file),
      details: { indices: undefinedIndices.slice(0, 32) },
    });
}

// ---------------------------------------------------------------------------------------------
// Lakes and the world edge, from the province map

function* validateLakesAndEdge(
  index: MapWorkspaceIndex,
  raster: Raster,
  report: Report,
  options: AppearanceOptions,
): AppearanceSteps {
  const provincesFile = index.provinceBitmapFile;
  const provinceRaster = index.raster;
  if (provincesFile === undefined || provinceRaster === undefined) return;
  const location = locate(provincesFile);
  const typeById = new Map(index.definitions.map((definition) => [definition.id, definition.type]));
  // A lake body is a set of adjacent lake provinces; its size decides whether it reads as water.
  const bodyOf = new Map<number, number>();
  const lakeProvinces = [...provinceRaster.geometry.keys()]
    .filter((id) => typeById.get(id) === 'lake')
    .sort((a, b) => a - b);
  for (const start of lakeProvinces) {
    if (bodyOf.has(start)) continue;
    const queue = [start];
    bodyOf.set(start, start);
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const other of provinceRaster.adjacency.get(current) ?? [])
        if (typeById.get(other) === 'lake' && !bodyOf.has(other)) {
          bodyOf.set(other, start);
          queue.push(other);
        }
    }
  }
  const bodyPixels = new Map<number, number>();
  for (const id of lakeProvinces)
    bodyPixels.set(
      bodyOf.get(id)!,
      (bodyPixels.get(bodyOf.get(id)!) ?? 0) + provinceRaster.geometry.get(id)!.pixelCount,
    );
  for (const [body, pixels] of bodyPixels)
    if (pixels < LAKE_MINIMUM_PIXELS)
      report({
        code: 'MAP_LAKE_TOO_SMALL',
        severity: 'warning',
        message: `Lake province ${body} holds a lake of only ${pixels} pixels; water below ${LAKE_MINIMUM_PIXELS} pixels is too small to read as a lake`,
        location,
        details: { provinceId: body, pixels },
      });
  for (const id of lakeProvinces)
    for (const other of provinceRaster.adjacency.get(id) ?? [])
      if (typeById.get(other) === 'sea')
        report({
          code: 'MAP_LAKE_CONNECTED_TO_SEA',
          severity: 'warning',
          message: `Lake province ${id} borders sea province ${other}; water that joins the sea is sea, not a lake`,
          location,
          details: { lakeProvinceId: id, seaProvinceId: other },
        });
  yield;
  const { width, height, kind } = raster;
  let left = 0;
  let right = 0;
  let rows = 0;
  const rowSamples: number[] = [];
  const pairs = new Set<string>();
  for (let y = 0; y < height; y += 1) {
    if (y % 256 === 0) {
      options.signal?.throwIfAborted();
      yield;
    }
    const start = kind[y * width] === LAND;
    const end = kind[y * width + width - 1] === LAND;
    if (start) left += 1;
    if (end) right += 1;
    if (start || end) {
      rows += 1;
      if (rowSamples.length < SAMPLE_LIMIT) rowSamples.push(y);
    }
    if (start && end) {
      const a = provinceRaster.provinceIds[y * width]!;
      const b = provinceRaster.provinceIds[y * width + width - 1]!;
      if (a !== b) pairs.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }
  }
  if (rows > 0)
    report({
      code: 'MAP_EDGE_LAND_CUT',
      severity: options.edgeMode === 'sea-band' ? 'error' : 'warning',
      message: `Land touches the first or last column on ${rows} rows (${left} on the west edge, ${right} on the east); where the world wraps, the coast is cut by a straight vertical line. Use edge.mode "sea-band" or "rim"`,
      location,
      details: { rows, west: left, east: right, firstRows: rowSamples },
    });
  if (pairs.size > 0) {
    const covered = new Set<string>();
    for (const adjacency of index.adjacencies)
      if (adjacency.type === 'impassable')
        covered.add(
          `${Math.min(adjacency.from, adjacency.to)}:${Math.max(adjacency.from, adjacency.to)}`,
        );
    const open = [...pairs].filter((pair) => !covered.has(pair)).length;
    report({
      code: 'MAP_SEAM_LAND_ADJACENCY',
      severity: 'info',
      message: `${pairs.size} pairs of land provinces meet across the wrapping seam; ${pairs.size - open} are blocked by an impassable adjacency`,
      location,
      details: { pairs: pairs.size, impassable: pairs.size - open },
    });
  }
  let top = 0;
  let bottom = 0;
  for (let x = 0; x < width; x += 1) {
    if (kind[x] === LAND) top += 1;
    if (kind[(height - 1) * width + x] === LAND) bottom += 1;
  }
  if (top + bottom > 0)
    report({
      code: 'MAP_POLAR_LAND',
      severity: 'info',
      message: `Land touches the top row on ${top} columns and the bottom row on ${bottom}; the north and south frame borders cover the map edge there`,
      location,
      details: { top, bottom },
    });
}

/**
 * Run every appearance check for the files present in the scanned set. The rasters are built
 * once; each check reads its bitmap in strips.
 */
export function* validateAppearance(
  index: MapWorkspaceIndex,
  report: Report,
  options: AppearanceOptions = {},
): AppearanceSteps {
  const provinceRaster = index.raster;
  if (provinceRaster === undefined) return;
  if (provinceRaster.width * provinceRaster.height > MAP_PROVINCE_ENGINE_MAX_PIXELS) return;
  const raster = buildRaster(index);
  if (raster === undefined) return;
  yield;
  yield* validateLakesAndEdge(index, raster, report, options);
  yield* validateHeightmap(index, raster, report, options);
  yield* validateTerrainBitmap(index, raster, report, options);
  yield* validateRivers(index, raster, report, options);
  yield* validateTrees(index, raster, report, options);
  yield* validateColourMaps(index, raster, report, options);
  yield* validateAlbedo(index, raster, report, options);
  yield* validateNormals(index, raster, report, options);
  yield* validateCities(index, raster, report, options);
}
