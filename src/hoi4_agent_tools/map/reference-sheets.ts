/**
 * Registration of a picture made of drawn sheets onto the world frame (ADR 0067, step 2).
 *
 * Every sheet becomes one affine map from normalised picture coordinates to normalised world
 * coordinates. Each world pixel is mapped back by the inverse of the highest-order sheet whose box
 * (and clip) holds it and sampled from the working picture, so the result is one frame-aligned
 * picture from which every map layer is derived. Only `+ - * /` are used, so results are the same
 * on every platform.
 */
import { ServiceError } from '../core/result.js';
import type { ReferenceSheetInput, ReferenceSheetsDocument } from '../schemas/reference-sheets.js';

/** `x' = a x + b y + c`, `y' = d x + e y + f`. */
export type Affine = readonly [number, number, number, number, number, number];

export interface RegisteredSheet {
  id: string;
  order: number;
  /** Position in the document, the tie-break after order. */
  index: number;
  forward: Affine;
  inverse: Affine;
  box: readonly [number, number, number, number];
  /** Clip polygon in picture coordinates as x, y pairs; undefined means the box. */
  clip?: Float64Array;
  /** World pixel rectangle the sheet can reach, clipped to the frame; empty when maxX < minX. */
  pixels: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SheetCoverage {
  id: string;
  order: number;
  /** World pixels taken from this sheet. */
  pixels: number;
  /** World pixels this sheet could also supply but a higher-order sheet supplied. */
  hidden: number;
  /** World bounds of the sheet's box, normalised. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface WarpedSheets {
  width: number;
  height: number;
  /** Frame-sized RGB picture. */
  rgb: Buffer;
  /** Index of the sheet each world pixel came from; 255 where none covers it. */
  owner: Uint8Array;
  coverage: SheetCoverage[];
  uncovered: number;
}

const NONE = 255;
const UNCOVERED_COLOUR = [0x24, 0x5b, 0x82] as const;

export function sheetAffine(sheet: ReferenceSheetInput): Affine {
  if (sheet.affine !== undefined) return sheet.affine;
  const [anchorX, anchorY] = sheet.anchor!;
  const [targetX, targetY] = sheet.target!;
  const [scaleX, scaleY] = sheet.scale!;
  return [scaleX, 0, targetX - scaleX * anchorX, 0, scaleY, targetY - scaleY * anchorY];
}

export function invertAffine(affine: Affine): Affine | undefined {
  const [a, b, c, d, e, f] = affine;
  const determinant = a * e - b * d;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  const ia = e / determinant;
  const ib = -b / determinant;
  const id = -d / determinant;
  const ie = a / determinant;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

export function applyAffine(affine: Affine, x: number, y: number): [number, number] {
  return [affine[0] * x + affine[1] * y + affine[2], affine[3] * x + affine[4] * y + affine[5]];
}

/**
 * Check a document against the picture and the frame and build each sheet's maps. Throws for a
 * picture the registrations were not made for, a degenerate map or a sheet entirely outside the
 * frame.
 */
export function registerSheets(
  document: ReferenceSheetsDocument,
  frame: { width: number; height: number },
  picture: { width: number; height: number; sha256: string },
): RegisteredSheet[] {
  if (
    document.source !== undefined &&
    (document.source.width !== picture.width || document.source.height !== picture.height)
  )
    throw new ServiceError(
      'MAP_REFERENCE_SHEETS_SOURCE_MISMATCH',
      `The sheet registrations were made for a ${document.source.width} x ${document.source.height} picture, but the reference is ${picture.width} x ${picture.height}`,
      {
        expectedWidth: document.source.width,
        expectedHeight: document.source.height,
        width: picture.width,
        height: picture.height,
      },
    );
  if (document.source?.sha256 !== undefined && document.source.sha256 !== picture.sha256)
    throw new ServiceError(
      'MAP_REFERENCE_SHEETS_SOURCE_MISMATCH',
      'The sheet registrations were made for a picture with another SHA-256',
      { expectedSha256: document.source.sha256, sha256: picture.sha256 },
    );
  return document.sheets.map((sheet, index) => {
    const forward = sheetAffine(sheet);
    const inverse = invertAffine(forward);
    if (inverse === undefined)
      throw new ServiceError(
        'MAP_REFERENCE_SHEET_DEGENERATE',
        `Sheet ${sheet.id} maps its box onto a line or a point`,
        { sheetId: sheet.id },
      );
    const [left, top, right, bottom] = sheet.box;
    const corners = [
      applyAffine(forward, left, top),
      applyAffine(forward, right, top),
      applyAffine(forward, left, bottom),
      applyAffine(forward, right, bottom),
    ];
    const minX = Math.min(...corners.map(([x]) => x));
    const maxX = Math.max(...corners.map(([x]) => x));
    const minY = Math.min(...corners.map(([, y]) => y));
    const maxY = Math.max(...corners.map(([, y]) => y));
    if (maxX <= 0 || minX >= 1 || maxY <= 0 || minY >= 1)
      throw new ServiceError(
        'MAP_REFERENCE_SHEET_OUTSIDE',
        `Sheet ${sheet.id} lies entirely outside the world frame`,
        { sheetId: sheet.id, bounds: { left: minX, top: minY, right: maxX, bottom: maxY } },
      );
    const clip =
      sheet.clip === undefined
        ? undefined
        : Float64Array.from(sheet.clip.flatMap(([x, y]) => [x, y]));
    return {
      id: sheet.id,
      order: sheet.order,
      index,
      forward,
      inverse,
      box: sheet.box,
      ...(clip === undefined ? {} : { clip }),
      pixels: {
        minX: Math.max(0, Math.floor(minX * frame.width)),
        minY: Math.max(0, Math.floor(minY * frame.height)),
        maxX: Math.min(frame.width - 1, Math.ceil(maxX * frame.width) - 1),
        maxY: Math.min(frame.height - 1, Math.ceil(maxY * frame.height) - 1),
      },
    };
  });
}

/**
 * Working picture size at which every sheet still has at least one working pixel per world
 * pixel: the longest world distance one picture unit travels along each picture axis.
 */
export function sheetWorkingSize(
  forwards: readonly Affine[],
  frame: { width: number; height: number },
): { width: number; height: number } {
  let width = 1;
  let height = 1;
  for (const forward of forwards) {
    const [a, b, , d, e] = forward;
    width = Math.max(width, Math.sqrt((a * frame.width) ** 2 + (d * frame.height) ** 2));
    height = Math.max(height, Math.sqrt((b * frame.width) ** 2 + (e * frame.height) ** 2));
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

function insideSheet(sheet: RegisteredSheet, x: number, y: number): boolean {
  const [left, top, right, bottom] = sheet.box;
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const clip = sheet.clip;
  if (clip === undefined) return true;
  let inside = false;
  for (
    let index = 0, previous = clip.length - 2;
    index < clip.length;
    previous = index, index += 2
  ) {
    const ax = clip[index]!;
    const ay = clip[index + 1]!;
    const bx = clip[previous]!;
    const by = clip[previous + 1]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/**
 * Warp the working picture (raw RGB) into the frame. `nearest` sampling keeps the colours of an
 * indexed picture; `bilinear` blends neighbours for drawings. Throws when two sheets of equal
 * order both cover a world pixel, and when `fill` is `error` and a world pixel has no sheet.
 */
export function warpSheets(
  picture: { data: Buffer; width: number; height: number },
  sheets: readonly RegisteredSheet[],
  frame: { width: number; height: number },
  options: {
    fill: ReferenceSheetsDocument['fill'];
    sampling: 'nearest' | 'bilinear';
    signal?: AbortSignal;
  },
): WarpedSheets {
  const { width, height } = frame;
  if (sheets.length > NONE) throw new ServiceError('MAP_REFERENCE_SHEETS_LIMIT', 'Too many sheets');
  const rgb = Buffer.alloc(width * height * 3);
  const owner = new Uint8Array(width * height).fill(NONE);
  const ordered = [...sheets].sort(
    (left, right) => right.order - left.order || left.index - right.index,
  );
  const taken = new Float64Array(sheets.length);
  const hidden = new Float64Array(sheets.length);
  let ties = 0;
  let tieSample: { x: number; y: number; sheets: [string, string] } | undefined;
  const pictureWidth = picture.width;
  const pictureHeight = picture.height;
  const data = picture.data;
  for (let y = 0; y < height; y += 1) {
    if ((y & 63) === 0) options.signal?.throwIfAborted();
    const worldY = (y + 0.5) / height;
    for (const sheet of ordered) {
      const { minX, maxX, minY, maxY } = sheet.pixels;
      if (y < minY || y > maxY) continue;
      const [ia, ib, ic, id, ie, iff] = sheet.inverse;
      for (let x = minX; x <= maxX; x += 1) {
        const worldX = (x + 0.5) / width;
        const pictureX = ia * worldX + ib * worldY + ic;
        const pictureY = id * worldX + ie * worldY + iff;
        if (!insideSheet(sheet, pictureX, pictureY)) continue;
        const pixel = y * width + x;
        const current = owner[pixel]!;
        if (current !== NONE) {
          hidden[sheet.index] = hidden[sheet.index]! + 1;
          if (sheets[current]!.order === sheet.order) {
            ties += 1;
            tieSample ??= { x, y, sheets: [sheets[current]!.id, sheet.id] };
          }
          continue;
        }
        owner[pixel] = sheet.index;
        taken[sheet.index] = taken[sheet.index]! + 1;
        const sourceX = pictureX * pictureWidth - 0.5;
        const sourceY = pictureY * pictureHeight - 0.5;
        const target = pixel * 3;
        if (options.sampling === 'nearest') {
          const column = Math.min(pictureWidth - 1, Math.max(0, Math.round(sourceX)));
          const row = Math.min(pictureHeight - 1, Math.max(0, Math.round(sourceY)));
          const source = (row * pictureWidth + column) * 3;
          rgb[target] = data[source]!;
          rgb[target + 1] = data[source + 1]!;
          rgb[target + 2] = data[source + 2]!;
        } else {
          const left = Math.min(pictureWidth - 1, Math.max(0, Math.floor(sourceX)));
          const top = Math.min(pictureHeight - 1, Math.max(0, Math.floor(sourceY)));
          const right = Math.min(pictureWidth - 1, left + 1);
          const bottom = Math.min(pictureHeight - 1, top + 1);
          const fx = Math.min(1, Math.max(0, sourceX - left));
          const fy = Math.min(1, Math.max(0, sourceY - top));
          const p00 = (top * pictureWidth + left) * 3;
          const p10 = (top * pictureWidth + right) * 3;
          const p01 = (bottom * pictureWidth + left) * 3;
          const p11 = (bottom * pictureWidth + right) * 3;
          for (let channel = 0; channel < 3; channel += 1) {
            const upper = data[p00 + channel]! + (data[p10 + channel]! - data[p00 + channel]!) * fx;
            const lower = data[p01 + channel]! + (data[p11 + channel]! - data[p01 + channel]!) * fx;
            rgb[target + channel] = Math.round(upper + (lower - upper) * fy);
          }
        }
      }
    }
  }
  if (ties > 0)
    throw new ServiceError(
      'MAP_REFERENCE_SHEETS_OVERLAP_ORDER',
      `${ties} world pixels are covered by two sheets of the same order (first at ${tieSample!.x}, ${tieSample!.y}: ${tieSample!.sheets.join(' and ')}); give one of them a higher order or clip it`,
      { pixels: ties, sample: tieSample },
    );
  let uncovered = 0;
  let uncoveredSample: { x: number; y: number } | undefined;
  for (let pixel = 0; pixel < owner.length; pixel += 1)
    if (owner[pixel] === NONE) {
      uncovered += 1;
      uncoveredSample ??= { x: pixel % width, y: Math.floor(pixel / width) };
      // The open-sea colour every heuristic mode reads as water, so no ink appears at sheet edges.
      rgb.set(UNCOVERED_COLOUR, pixel * 3);
    }
  if (uncovered > 0 && options.fill === 'error')
    throw new ServiceError(
      'MAP_REFERENCE_SHEETS_UNCOVERED',
      `${uncovered} world pixels lie outside every sheet (first at ${uncoveredSample!.x}, ${uncoveredSample!.y}); add a sheet or set fill to "sea"`,
      { pixels: uncovered, sample: uncoveredSample },
    );
  const coverage = sheets.map((sheet) => {
    const [left, top, right, bottom] = sheet.box;
    const corners = [
      applyAffine(sheet.forward, left, top),
      applyAffine(sheet.forward, right, bottom),
    ];
    return {
      id: sheet.id,
      order: sheet.order,
      pixels: taken[sheet.index]!,
      hidden: hidden[sheet.index]!,
      bounds: {
        left: Math.min(corners[0]![0], corners[1]![0]),
        top: Math.min(corners[0]![1], corners[1]![1]),
        right: Math.max(corners[0]![0], corners[1]![0]),
        bottom: Math.max(corners[0]![1], corners[1]![1]),
      },
    };
  });
  return { width, height, rgb, owner, coverage, uncovered };
}
