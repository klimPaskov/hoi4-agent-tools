/**
 * World edge and seam policy (ADR 0061). The engine wraps the map horizontally and draws it as a
 * sphere for day and night, so land that touches column 0 or the last column is cut by a straight
 * line where the world repeats. This module keeps land away from the seam and the poles, or ends
 * it in an impassable rim, and writes the north and south frame borders the base map has.
 */
import { ServiceError } from '../core/result.js';
import { valueNoise } from './world-noise.js';

const SEA = 0;
const LAND = 1;

export type EdgeMode = 'sea-band' | 'rim' | 'none';

export interface EdgeSpec {
  mode: EdgeMode;
  /** Width of the open-sea band at the east and west edge, in pixels. */
  bandPx: number;
  /** Height of the open-sea band at the north and south edge, in pixels. */
  polarPx: number;
  /** Width of the rim range at the east and west edge when `mode` is `rim`, in pixels. */
  rimPx: number;
}

export interface EdgeInput {
  mode?: EdgeMode | undefined;
  bandPx?: number | undefined;
  polarPx?: number | undefined;
  rimPx?: number | undefined;
}

/** Lowest height of the rim range at its inner foot, and its height at the seam. */
export const RIM_FOOT_HEIGHT = 150;
export const RIM_SEAM_HEIGHT = 230;
/** The darkest rim colour multiplier, at the seam. */
export const RIM_COLOUR_FACTOR = 0.55;

export interface EdgeNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Resolve the optional `edge` input against the world size. Omitting it keeps the previous
 * behaviour (`none`); an `edge` object without a mode asks for the open-sea band.
 */
export function resolveEdge(input: EdgeInput | undefined, width: number, height: number): EdgeSpec {
  if (input === undefined) return { mode: 'none', bandPx: 0, polarPx: 0, rimPx: 0 };
  const mode = input.mode ?? 'sea-band';
  const quarter = Math.floor(width / 4);
  const polarLimit = Math.floor(height / 4);
  const bandPx = input.bandPx ?? Math.min(Math.max(192, Math.round(0.04 * width)), quarter);
  const polarPx = input.polarPx ?? Math.min(64, Math.floor(height / 8));
  const rimPx = input.rimPx ?? Math.min(160, quarter);
  if (bandPx > quarter || rimPx > quarter || polarPx > polarLimit)
    throw new ServiceError(
      'MAP_EDGE_BAND_TOO_WIDE',
      'The edge band and rim may not exceed a quarter of the world width, nor the polar band a quarter of its height',
      { width, height, bandPx, rimPx, polarPx, maximumWidth: quarter, maximumHeight: polarLimit },
    );
  if (mode === 'none') return { mode, bandPx: 0, polarPx: 0, rimPx: 0 };
  return {
    mode,
    bandPx: mode === 'sea-band' ? bandPx : 0,
    polarPx,
    rimPx: mode === 'rim' ? rimPx : 0,
  };
}

export interface EdgeFeature {
  name: string;
  x: number;
  y: number;
  kind: string;
}

/** Cities and named land features may not stand where the policy clears land. */
export function assertFeaturesOutsideBand(
  edge: EdgeSpec,
  width: number,
  height: number,
  features: readonly EdgeFeature[],
): void {
  if (edge.mode === 'none') return;
  const offenders = features.filter((feature) => {
    if (feature.kind === 'sea') return false;
    const northSouth = feature.y < edge.polarPx || feature.y >= height - edge.polarPx;
    const eastWest =
      edge.mode === 'sea-band' && (feature.x < edge.bandPx || feature.x >= width - edge.bandPx);
    return northSouth || eastWest;
  });
  if (offenders.length === 0) return;
  throw new ServiceError(
    'MAP_EDGE_FEATURE_IN_BAND',
    `${offenders.length} named feature(s) stand inside the world edge band, where land is cleared: ${offenders
      .slice(0, 5)
      .map((feature) => `${feature.name} (${Math.round(feature.x)}, ${Math.round(feature.y)})`)
      .join('; ')}. Move them inland or choose edge.mode "none" or "rim".`,
    {
      mode: edge.mode,
      bandPx: edge.bandPx,
      polarPx: edge.polarPx,
      features: offenders.slice(0, 20),
    },
  );
}

/** Per-row (east-west) and per-column (north-south) clearing limits with a ragged outline. */
function limits(
  edge: EdgeSpec,
  width: number,
  height: number,
  seed: number,
): { rows: Int32Array; columns: Int32Array } {
  const rows = new Int32Array(height);
  const columns = new Int32Array(width);
  const scaleY = Math.max(8, edge.bandPx / 3);
  const scaleX = Math.max(8, edge.polarPx / 1.5);
  for (let y = 0; y < height; y += 1)
    rows[y] =
      edge.mode === 'sea-band'
        ? edge.bandPx + Math.round(valueNoise(seed + 9187, y / scaleY, 0.5) * edge.bandPx * 0.5)
        : 0;
  for (let x = 0; x < width; x += 1)
    columns[x] =
      edge.polarPx > 0
        ? edge.polarPx + Math.round(valueNoise(seed + 9293, x / scaleX, 0.5) * edge.polarPx * 0.5)
        : 0;
  return { rows, columns };
}

function landComponents(kind: Uint8Array, width: number): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(kind.length).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(kind.length);
  const total = kind.length;
  for (let start = 0; start < total; start += 1) {
    if (kind[start] !== LAND || label[start] !== -1) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % width;
      const visit = (other: number): void => {
        if (kind[other] === LAND && label[other] === -1) {
          label[other] = id;
          queue[tail++] = other;
        }
      };
      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (pixel >= width) visit(pixel - width);
      if (pixel < total - width) visit(pixel + width);
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

export interface EdgeApplication {
  notes: EdgeNote[];
  clearedLandPixels: number;
}

/**
 * Clear land and lakes from the east, west, north and south bands (modifying `kind` and
 * `elevation` in place). The outline is ragged so the cleared coast does not read as a ruled
 * line; land fragments the clearing detached sink when smaller than `minimumIsland`.
 */
export function applyEdgePolicy(
  kind: Uint8Array,
  elevation: Float32Array,
  width: number,
  height: number,
  edge: EdgeSpec,
  seed: number,
  minimumIsland: number,
): EdgeApplication {
  if (edge.mode === 'none') return { notes: [], clearedLandPixels: 0 };
  const before = landComponents(kind, width);
  const { rows, columns } = limits(edge, width, height, seed);
  const cleared = new Uint8Array(kind.length);
  let clearedLand = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const limitX = rows[y]!;
      const clear =
        x < limitX || x >= width - limitX || y < columns[x]! || y >= height - columns[x]!;
      if (!clear) continue;
      const pixel = y * width + x;
      cleared[pixel] = 1;
      if (kind[pixel] === LAND) clearedLand += 1;
      if (kind[pixel] !== SEA) kind[pixel] = SEA;
    }
  const after = landComponents(kind, width);
  let sunk = 0;
  for (let pixel = 0; pixel < kind.length; pixel += 1) {
    if (kind[pixel] !== LAND) continue;
    const size = after.sizes[after.label[pixel]!]!;
    if (size < before.sizes[before.label[pixel]!]! && size < minimumIsland) {
      kind[pixel] = SEA;
      cleared[pixel] = 1;
      sunk += 1;
    }
  }
  reshapeClearedCoast(kind, elevation, cleared, width, height);
  const notes: EdgeNote[] = [];
  if (clearedLand + sunk > 0)
    notes.push({
      code: 'MAP_EDGE_LAND_CLEARED',
      severity: 'warning',
      message: `The ${edge.mode} edge policy cleared ${clearedLand} land pixels to open sea${sunk > 0 ? ` and sank ${sunk} pixels of fragments it detached` : ''}; land that must reach the edge needs edge.mode "rim"`,
      details: { mode: edge.mode, clearedLandPixels: clearedLand, sunkFragmentPixels: sunk },
    });
  return { notes, clearedLandPixels: clearedLand + sunk };
}

/**
 * Give the new coast a shelf and a coastal land ramp, as the reference interpretation does for
 * its own coast: cleared sea deepens from the shore, and land next to the cut rises from sea
 * level. Cleared pixels away from any coast become the deep sea value.
 */
function reshapeClearedCoast(
  kind: Uint8Array,
  elevation: Float32Array,
  cleared: Uint8Array,
  width: number,
  height: number,
): void {
  const total = kind.length;
  const ramp = Math.max(4, Math.round(Math.min(width, height) / 120));
  const distance = new Uint16Array(total).fill(65535);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (cleared[pixel]) elevation[pixel] = -0.15;
    if (kind[pixel] !== LAND) continue;
    const x = pixel % width;
    const touchesCleared =
      (x > 0 && cleared[pixel - 1] === 1 && kind[pixel - 1] === SEA) ||
      (x < width - 1 && cleared[pixel + 1] === 1 && kind[pixel + 1] === SEA) ||
      (pixel >= width && cleared[pixel - width] === 1 && kind[pixel - width] === SEA) ||
      (pixel < total - width && cleared[pixel + width] === 1 && kind[pixel + width] === SEA);
    if (touchesCleared) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  }
  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    if (next > ramp) continue;
    const x = pixel % width;
    const visit = (other: number): void => {
      if (distance[other] !== 65535) return;
      // Land spreads inland; the shelf spreads only over cleared water.
      if (kind[other] === LAND || (kind[other] === SEA && cleared[other] === 1)) {
        distance[other] = next;
        queue[tail++] = other;
      }
    };
    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < total - width) visit(pixel + width);
  }
  for (let pixel = 0; pixel < total; pixel += 1) {
    const d = distance[pixel]!;
    if (d === 65535) continue;
    const t = Math.min(1, d / ramp);
    const factor = t * t * (3 - 2 * t);
    if (kind[pixel] === LAND) elevation[pixel] = elevation[pixel]! * factor;
    else elevation[pixel] = -0.15 * factor;
  }
}

function smooth(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Rim strength 0 to 1 at a column: 0 at the inner foot, 1 at the seam. Zero outside `rim` mode.
 */
export function rimStrength(edge: EdgeSpec, width: number, x: number): number {
  if (edge.mode !== 'rim') return 0;
  const distance = Math.min(x, width - 1 - x);
  return distance >= edge.rimPx ? 0 : smooth(1 - distance / edge.rimPx);
}

/** The rim height for an existing land height at the given strength. */
export function rimHeight(existing: number, strength: number): number {
  if (strength <= 0) return existing;
  const target = RIM_FOOT_HEIGHT + (RIM_SEAM_HEIGHT - RIM_FOOT_HEIGHT) * strength;
  return Math.min(255, Math.round(existing + (target - existing) * strength));
}

/**
 * Darkening of the water colour map toward the deepest tint, 0 to 1: full at the seam, none at
 * the inner edge of the band, and a shorter fade at the poles.
 */
export function edgeWaterDarkness(
  edge: EdgeSpec,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (edge.mode === 'none') return 0;
  const sideDistance = Math.min(x, width - 1 - x);
  const side = edge.mode === 'sea-band' ? smooth(1 - sideDistance / (edge.bandPx * 1.2)) : 0;
  const poleDistance = Math.min(y, height - 1 - y);
  const pole = edge.polarPx > 0 ? smooth(1 - poleDistance / (edge.polarPx * 1.2)) * 0.8 : 0;
  return Math.max(side, pole);
}

export interface RimAdjacencyInput {
  /** Province index (zero-based) of each pixel. */
  provincePixels: ArrayLike<number>;
  /** Province kind per index: 0 sea, 1 land, 2 lake. */
  provinceKinds: ArrayLike<number>;
  width: number;
  height: number;
}

/**
 * Impassable rows for every pair of distinct land provinces that meet across the seam, in
 * `adjacencies.csv` order (rows are sorted by the lower then the higher province ID).
 */
export function rimAdjacencyRows(input: RimAdjacencyInput): string[] {
  const { provincePixels, provinceKinds, width, height } = input;
  const pairs = new Set<string>();
  for (let y = 0; y < height; y += 1) {
    const left = provincePixels[y * width]!;
    const right = provincePixels[y * width + width - 1]!;
    if (left === right || provinceKinds[left] !== LAND || provinceKinds[right] !== LAND) continue;
    const low = Math.min(left, right) + 1;
    const high = Math.max(left, right) + 1;
    pairs.add(`${low};${high}`);
  }
  return [...pairs]
    .sort((a, b) => {
      const [al, ah] = a.split(';').map(Number) as [number, number];
      const [bl, bh] = b.split(';').map(Number) as [number, number];
      return al - bl || ah - bh;
    })
    .map((pair) => `${pair};impassable;-1;-1;-1;-1;-1;;World rim`);
}

/** Heights and positions of the base map's frame meshes, scaled to the world size. */
export function frameBorderPositions(
  width: number,
  height: number,
): { top: number; bottom: number; logoX: number; logoZ: number } {
  return {
    top: height + 142,
    bottom: -140,
    logoX: Math.round(0.5327 * width),
    logoZ: height + 82,
  };
}

/**
 * `ambient_object.txt` with the wind entity and the north, south and logo frame borders. Ambient
 * water objects and the DLC wall mesh of the base map are left out: their positions belong to
 * the base map's geography.
 */
export function ambientObjectText(width: number, height: number): string {
  const frame = frameBorderPositions(width, height);
  const block = (
    type: string,
    options: { scale?: number; name: string; position: [number, number, number] },
  ): string =>
    [
      'type={',
      `\ttype="${type}"`,
      '\tuse_animation=no',
      ...(options.scale === undefined ? [] : [`\tscale=${options.scale.toFixed(6)}`]),
      '\talways_visible=yes',
      '\tobject={',
      `\t\tname="${options.name}"`,
      '\t\tposition={',
      `\t\t\t${options.position.join(' ')} `,
      '\t\t}',
      '\t\trotation={',
      '\t\t\t0 0 0 ',
      '\t\t}',
      '\t}',
      '}',
    ].join('\n');
  return `${[
    block('ambient_wind_entity', { name: 'ambient_wind', position: [0, 0, 0] }),
    block('frame_border_entity', {
      scale: 100,
      name: 'frame_border_entity_top',
      position: [0, 0, frame.top],
    }),
    block('frame_border_bottom_entity', {
      scale: 100,
      name: 'frame_border_bottom_entity_bottom',
      position: [0, 0, frame.bottom],
    }),
    block('frame_border_logo_entity', {
      scale: 300,
      name: 'frame_border_logo_entity_top',
      position: [frame.logoX, -1, frame.logoZ],
    }),
  ].join('\n')}\n`;
}
