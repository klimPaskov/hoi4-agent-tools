/**
 * Land, sea and lake raster from the resolved geography model (ADR 0056). Lands and lakes are
 * rasterised from their polygons with a seeded fractal displacement bounded by the land's
 * `coastDetail`, so a coast gets bays and headlands the model's few vertices cannot hold. Land
 * beats sea and a lake carves land, as `ResolvedGeography.surfaceAt` defines.
 */
import { scanAreaStrip, type ResolvedArea, type ResolvedGeography } from '../geography/index.js';
import { LAKE, LAND, SEA, labelComponents } from './grid.js';
import { clamp, fractal2 } from './math.js';

export interface KindRasterOptions {
  width: number;
  height: number;
  seed: number;
  signal?: AbortSignal | undefined;
}

/** Displacement of a full-detail coast in map widths; scaled by the land's `coastDetail`. */
export const COAST_DISPLACEMENT = 0.005;
/** Lakes follow their outline closely: they use this share of the default displacement. */
const LAKE_DISPLACEMENT_SHARE = 0.3;
/** Land fragments below this size sink; enclosed sea below it fills (pixels). */
export const SPECK_PIXELS = 24;

interface AreaMask {
  x0: number;
  y0: number;
  width: number;
  height: number;
  mask: Uint8Array;
}

function areaMask(area: ResolvedArea, grid: { width: number; height: number }): AreaMask {
  const x0 = Math.max(0, Math.floor(area.bounds.x0 * grid.width) - 1);
  const y0 = Math.max(0, Math.floor(area.bounds.y0 * grid.height) - 1);
  const x1 = Math.min(grid.width, Math.ceil(area.bounds.x1 * grid.width) + 1);
  const y1 = Math.min(grid.height, Math.ceil(area.bounds.y1 * grid.height) + 1);
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const mask = new Uint8Array(width * height);
  if (width > 0 && height > 0)
    scanAreaStrip(area, grid, { y0, y1 }, (y, xa, xb) => {
      const row = (y - y0) * width - x0;
      mask.fill(1, row + Math.max(xa, x0), row + Math.min(xb, x1));
    });
  return { x0, y0, width, height, mask };
}

/** Stamp `value` where the displaced sample of the area is inside it. */
function stamp(
  target: Uint8Array,
  area: ResolvedArea,
  grid: { width: number; height: number },
  value: number,
  amplitude: number,
  seed: number,
): void {
  const raster = areaMask(area, grid);
  if (raster.width === 0 || raster.height === 0) return;
  const reach = Math.ceil(amplitude);
  const xa = Math.max(0, raster.x0 - reach);
  const ya = Math.max(0, raster.y0 - reach);
  const xb = Math.min(grid.width, raster.x0 + raster.width + reach);
  const yb = Math.min(grid.height, raster.y0 + raster.height + reach);
  const wavelength = Math.max(24, 0.04 * grid.width);
  for (let y = ya; y < yb; y += 1)
    for (let x = xa; x < xb; x += 1) {
      let sx = x;
      let sy = y;
      if (amplitude > 0) {
        const dx = clamp((fractal2(seed + 501, x, y, wavelength, 5) - 0.5) * 2.6, -1, 1);
        const dy = clamp((fractal2(seed + 503, x, y, wavelength, 5) - 0.5) * 2.6, -1, 1);
        sx = Math.floor(x + 0.5 + dx * amplitude);
        sy = Math.floor(y + 0.5 + dy * amplitude);
      }
      const mx = sx - raster.x0;
      const my = sy - raster.y0;
      if (mx < 0 || my < 0 || mx >= raster.width || my >= raster.height) continue;
      if (raster.mask[my * raster.width + mx] === 0) continue;
      const cell = y * grid.width + x;
      target[cell] = value;
    }
}

/** Sink land fragments and fill enclosed sea below `SPECK_PIXELS`; lakes are untouched. */
export function removeSpecks(kind: Uint8Array, width: number, height: number): void {
  const lands = labelComponents(width, height, (index) => kind[index] === LAND);
  for (let index = 0; index < kind.length; index += 1) {
    const id = lands.label[index]!;
    if (id >= 0 && lands.sizes[id]! < SPECK_PIXELS) kind[index] = SEA;
  }
  const seas = labelComponents(width, height, (index) => kind[index] === SEA);
  const open = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    open.add(seas.label[x]!);
    open.add(seas.label[(height - 1) * width + x]!);
  }
  for (let y = 0; y < height; y += 1) {
    open.add(seas.label[y * width]!);
    open.add(seas.label[y * width + width - 1]!);
  }
  for (let index = 0; index < kind.length; index += 1) {
    const id = seas.label[index]!;
    if (id >= 0 && !open.has(id) && seas.sizes[id]! < SPECK_PIXELS) kind[index] = LAND;
  }
}

/**
 * Rasterise lands and lakes of the model: 0 sea, 1 land, 2 lake. Seas need no raster: water is
 * what no land claims.
 */
export function rasterizeGeographyKind(
  geography: ResolvedGeography,
  options: KindRasterOptions,
): Uint8Array {
  const grid = { width: options.width, height: options.height };
  const kind = new Uint8Array(grid.width * grid.height);
  for (const land of geography.lands) {
    options.signal?.throwIfAborted();
    const amplitude = land.coastDetail * COAST_DISPLACEMENT * grid.width;
    stamp(kind, land.area, grid, LAND, amplitude, options.seed);
  }
  removeSpecks(kind, grid.width, grid.height);
  overlayGeographyLakes(kind, geography, options);
  return kind;
}

/** Lakes of the model carve whatever surface lies under them (a reference picture's land too). */
export function overlayGeographyLakes(
  kind: Uint8Array,
  geography: ResolvedGeography,
  options: KindRasterOptions,
): void {
  const grid = { width: options.width, height: options.height };
  const amplitude = 0.5 * COAST_DISPLACEMENT * LAKE_DISPLACEMENT_SHARE * grid.width;
  for (const lake of geography.lakes) {
    options.signal?.throwIfAborted();
    stamp(kind, lake.area, grid, LAKE, amplitude, options.seed + 17);
  }
}
