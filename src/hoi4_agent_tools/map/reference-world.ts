/** Bounded, offline reference-image interpretation. These are visual heuristics, not OCR. */
import sharp from 'sharp';
import { z } from 'zod';
import { ServiceError } from '../core/result.js';
import type { RgbColor } from './bmp.js';

export const REFERENCE_WORLD_PIXEL_LIMIT = 13_238_272;
export const REFERENCE_IMAGE_PIXEL_LIMIT = 32_000_000;
export const REFERENCE_IMAGE_BYTE_LIMIT = 64 * 1024 * 1024;
export const REFERENCE_TERRAIN = {
  plains: 0,
  forest: 1,
  desert: 2,
  mountain: 3,
  snow: 4,
  volcano: 5,
  hills: 6,
  marsh: 7,
  jungle: 8,
} as const;
const TERRAIN_ELEVATION = [0.045, 0.055, 0.035, 0.44, 0.045, 0.35, 0.18, 0.025, 0.06] as const;
const TERRAIN_MOISTURE = [0.45, 0.8, 0.06, 0.35, 0.25, 0.05, 0.4, 0.96, 0.92] as const;
export type ReferenceTerrain = keyof typeof REFERENCE_TERRAIN;
export type ReferenceSemantic = 'sea' | 'land' | 'lake' | ReferenceTerrain;
export interface ReferencePoint {
  x: number;
  y: number;
}
export interface ReferenceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ReferencePaletteEntry {
  kind: ReferenceSemantic;
  color: RgbColor;
}
export interface ReferenceAnnotation {
  kind: ReferenceSemantic;
  polygon: readonly ReferencePoint[];
}
export type ReferenceMode =
  'auto' | 'illustrated' | 'satellite' | 'sketch' | 'political' | 'grayscale';
export interface ReferenceWorldOptions {
  width?: number;
  height?: number;
  seed: number;
  mode?: ReferenceMode;
  /** Crop in decoded source pixels. Normalized annotations remain relative to the full source. */
  crop?: ReferenceBounds;
  ignoreMasks?: readonly (readonly ReferencePoint[])[];
  annotations?: readonly ReferenceAnnotation[];
  riverAnnotations?: readonly (readonly ReferencePoint[])[];
  palette?: readonly ReferencePaletteEntry[];
  /** Lower values broaden pale water-texture cleanup; the coastline remains raster-based. */
  coastDetail?: number;
  fit?: 'contain' | 'stretch';
  politicalImageBytes?: Uint8Array;
  terrainImageBytes?: Uint8Array;
  heightImageBytes?: Uint8Array;
}
export interface ReferenceWorldRaster {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Target-pixel rectangle occupied by the cropped reference; the rest is sea. */
  referenceBounds: ReferenceBounds;
  /** 0 sea, 1 land, 2 lake. */
  kind: Uint8Array;
  terrain: Uint8Array;
  elevation: Float32Array;
  moisture: Float32Array;
  /** Paths in target pixel coordinates, ordered deterministically. */
  rivers: ReferencePoint[][];
  /** 0 water; inferred land countries are numbered from 1. */
  country: Uint16Array;
  inferredCountries: { id: number; name: string; color: RgbColor }[];
  diagnostics: string[];
}

const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
const polygonSchema = z.array(pointSchema).min(3).max(2048);
const semanticSchema = z.enum([
  'sea',
  'land',
  'lake',
  'plains',
  'forest',
  'desert',
  'mountain',
  'snow',
  'volcano',
  'hills',
  'marsh',
  'jungle',
]);
const bytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
export const referenceWorldOptionsSchema = z
  .object({
    width: z.number().int().min(1).max(8192).optional(),
    height: z.number().int().min(1).max(4096).optional(),
    seed: z.number().int().min(0).max(0xffffffff),
    mode: z
      .enum(['auto', 'illustrated', 'satellite', 'sketch', 'political', 'grayscale'])
      .optional(),
    crop: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
    ignoreMasks: z.array(polygonSchema).max(256).optional(),
    annotations: z
      .array(z.object({ kind: semanticSchema, polygon: polygonSchema }).strict())
      .max(512)
      .optional(),
    riverAnnotations: z.array(z.array(pointSchema).min(2).max(8192)).max(512).optional(),
    palette: z
      .array(
        z
          .object({
            kind: semanticSchema,
            color: z
              .object({
                r: z.number().int().min(0).max(255),
                g: z.number().int().min(0).max(255),
                b: z.number().int().min(0).max(255),
              })
              .strict(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    coastDetail: z.number().min(0).max(1).optional(),
    fit: z.enum(['contain', 'stretch']).optional(),
    politicalImageBytes: bytesSchema.optional(),
    terrainImageBytes: bytesSchema.optional(),
    heightImageBytes: bytesSchema.optional(),
  })
  .strict();

interface DecodedImage {
  data: Buffer;
  width: number;
  height: number;
}

async function decode(bytes: Uint8Array): Promise<DecodedImage> {
  if (bytes.byteLength === 0 || bytes.byteLength > REFERENCE_IMAGE_BYTE_LIMIT)
    throw new ServiceError(
      'MAP_REFERENCE_IMAGE_BLOCKED',
      'Reference image bytes exceed the bounded decode limit',
    );
  try {
    const image = sharp(Buffer.from(bytes), {
      limitInputPixels: REFERENCE_IMAGE_PIXEL_LIMIT,
      animated: false,
      failOn: 'error',
    });
    const metadata = await image.metadata();
    if (
      !['png', 'jpeg', 'webp', 'tiff', 'bmp', 'gif'].includes(metadata.format) ||
      (metadata.pages ?? 1) !== 1
    )
      throw new ServiceError(
        'MAP_REFERENCE_IMAGE_BLOCKED',
        'Use a single-frame local raster image',
      );
    const output = await image
      .flatten({ background: '#245b82' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: output.data, width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'MAP_REFERENCE_IMAGE_BLOCKED',
      'Reference image cannot be decoded within the raster limits',
    );
  }
}

function neighbors(
  pixel: number,
  width: number,
  height: number,
  visit: (next: number) => void,
): void {
  const x = pixel % width;
  if (x > 0) visit(pixel - 1);
  if (x + 1 < width) visit(pixel + 1);
  if (pixel >= width) visit(pixel - width);
  if (pixel + width < width * height) visit(pixel + width);
}

function semanticCode(kind: ReferenceSemantic): number {
  return kind === 'sea'
    ? 0
    : kind === 'lake'
      ? 2
      : kind === 'land'
        ? 3
        : REFERENCE_TERRAIN[kind] + 3;
}

function pixelColor(data: Buffer, pixel: number): RgbColor {
  return { r: data[pixel * 3]!, g: data[pixel * 3 + 1]!, b: data[pixel * 3 + 2]! };
}

function distance(a: RgbColor, b: RgbColor): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

function classify(
  color: RgbColor,
  mode: ReferenceMode,
  palette: readonly ReferencePaletteEntry[],
): number {
  if (palette.length > 0) {
    let best = palette[0]!;
    let nearest = distance(color, best.color);
    for (const entry of palette) {
      const score = distance(color, entry.color);
      if (score < nearest) {
        nearest = score;
        best = entry;
      }
    }
    return semanticCode(best.kind);
  }
  const { r, g, b } = color;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  if (mode !== 'political' && r > g + 25 && b > g + 25 && r - g > (b - g) * 0.42)
    return semanticCode('forest');
  if (b > r + 12 && b > g - 28 && b > 70) return 0;
  if (mode === 'political') return 3;
  // Pencil illustrations often use black dead lands, purple woods and red volcanic terrain.
  if (maximum < 38 || (r > 120 && r > g * 1.8 && r > b * 1.4)) return semanticCode('volcano');
  if (minimum > 211 && maximum - minimum < 30) return semanticCode('snow');
  if (g > r + 12 && g > b + 7) {
    if (g < 105 && mode === 'satellite') return semanticCode('jungle');
    return semanticCode(g < 170 || r < 105 ? 'forest' : 'plains');
  }
  if (r > 158 && g > 120 && b < g * 0.83) return semanticCode('desert');
  if (maximum - minimum < 34 && maximum < 175) return semanticCode('mountain');
  if (r > b + 20 && g < 150) return semanticCode('hills');
  return 3;
}

function fillUnknown(codes: Uint8Array, width: number, height: number): void {
  if (!codes.includes(255)) return;
  const queue = new Int32Array(codes.length);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < codes.length; pixel += 1)
    if (codes[pixel] !== 255) queue[tail++] = pixel;
  if (tail === 0)
    throw new ServiceError(
      'MAP_REFERENCE_EMPTY',
      'Reference masks exclude every usable image pixel',
    );
  while (head < tail) {
    const pixel = queue[head++]!;
    neighbors(pixel, width, height, (next) => {
      if (codes[next] === 255) {
        codes[next] = codes[pixel]!;
        queue[tail++] = next;
      }
    });
  }
}

/** Scanline rasterization bounds work to image rows and polygon edges. */
function polygon(
  codes: Uint8Array,
  width: number,
  height: number,
  points: readonly ReferencePoint[],
  value: number,
): void {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
  for (let y = minY; y <= maxY; y += 1) {
    const intersections: number[] = [];
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const a = points[index]!;
      const b = points[previous]!;
      if (a.y > y + 0.5 !== b.y > y + 0.5)
        intersections.push(a.x + ((y + 0.5 - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const first = Math.max(0, Math.ceil(intersections[index]! - 0.5));
      const last = Math.min(width - 1, Math.ceil(intersections[index + 1]! - 0.5) - 1);
      if (first <= last) codes.fill(value, y * width + first, y * width + last + 1);
    }
  }
}

function modeFor(data: Buffer): ReferenceMode {
  let colorful = 0;
  let ink = 0;
  let white = 0;
  let samples = 0;
  const histogram = new Map<number, number>();
  const stride = Math.max(1, Math.floor(data.length / 3 / 100_000));
  for (let pixel = 0; pixel < data.length / 3; pixel += stride) {
    const { r, g, b } = pixelColor(data, pixel);
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    if (maximum - minimum > 35) colorful += 1;
    if (maximum < 80) ink += 1;
    if (minimum > 225) white += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    samples += 1;
  }
  if (colorful / samples < 0.04)
    return white / samples > 0.65 && ink / samples < 0.25 ? 'sketch' : 'grayscale';
  const largest = [...histogram.values()]
    .sort((a, b) => b - a)
    .slice(0, 8)
    .reduce((sum, value) => sum + value, 0);
  // Flat maps are the only source from which political colors can be inferred by default.
  return largest / samples > 0.83 && histogram.size > 2 ? 'political' : 'illustrated';
}

function grayscaleCodes(
  data: Buffer,
  width: number,
  height: number,
  mode: ReferenceMode,
): Uint8Array {
  const codes = new Uint8Array(width * height);
  if (mode === 'sketch') {
    const open = new Uint8Array(codes.length);
    for (let pixel = 0; pixel < open.length; pixel += 1)
      open[pixel] = data[pixel * 3]! > 115 ? 1 : 0;
    const queue = new Int32Array(codes.length);
    let head = 0;
    let tail = 0;
    const add = (pixel: number) => {
      if (open[pixel] === 1) {
        open[pixel] = 2;
        queue[tail++] = pixel;
      }
    };
    for (let x = 0; x < width; x += 1) {
      add(x);
      add((height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
      add(y * width);
      add(y * width + width - 1);
    }
    while (head < tail) neighbors(queue[head++]!, width, height, add);
    for (let pixel = 0; pixel < codes.length; pixel += 1) codes[pixel] = open[pixel] === 2 ? 0 : 3;
    return codes;
  }
  let border = 0;
  let borderCount = 0;
  let minimum = 255;
  let maximum = 0;
  for (let pixel = 0; pixel < codes.length; pixel += 1) {
    const value = data[pixel * 3]!;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      border += value;
      borderCount += 1;
    }
  }
  const background = border / borderCount;
  const threshold = Math.max(18, (maximum - minimum) * 0.18);
  for (let pixel = 0; pixel < codes.length; pixel += 1)
    codes[pixel] = Math.abs(data[pixel * 3]! - background) < threshold ? 0 : 3;
  return codes;
}

function latticeNoise(seed: number, x: number, y: number): number {
  let hash = Math.imul(Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed, 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff;
}

function coherentNoise(seed: number, x: number, y: number, scale: number): number {
  const px = x / scale;
  const py = y / scale;
  const left = Math.floor(px);
  const top = Math.floor(py);
  const fx = px - left;
  const fy = py - top;
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  const a = latticeNoise(seed, left, top);
  const b = latticeNoise(seed, left + 1, top);
  const c = latticeNoise(seed, left, top + 1);
  const d = latticeNoise(seed, left + 1, top + 1);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** The returned mask remains a raster; coastlines never go through lossy polygon tracing. */
export async function extractReferenceWorld(
  imageBytes: Uint8Array,
  input: ReferenceWorldOptions,
): Promise<ReferenceWorldRaster> {
  const parsed = referenceWorldOptionsSchema.safeParse(input);
  if (!parsed.success)
    throw new ServiceError('MAP_REFERENCE_OPTIONS_INVALID', 'Reference image options are invalid');
  const options = parsed.data;
  const source = await decode(imageBytes);
  const crop = options.crop ?? { x: 0, y: 0, width: source.width, height: source.height };
  if (crop.x + crop.width > source.width || crop.y + crop.height > source.height)
    throw new ServiceError('MAP_REFERENCE_CROP_INVALID', 'Reference crop lies outside the image');
  const width = options.width ?? 5632;
  const height = options.height ?? 2048;
  if (width * height > REFERENCE_WORLD_PIXEL_LIMIT)
    throw new ServiceError(
      'MAP_REFERENCE_PIXELS_BLOCKED',
      'Reference output exceeds the pixel budget',
    );
  const scale = options.fit === 'stretch' ? 1 : Math.min(width / crop.width, height / crop.height);
  const bounds =
    options.fit === 'stretch'
      ? { x: 0, y: 0, width, height }
      : {
          x: Math.floor((width - Math.round(crop.width * scale)) / 2),
          y: Math.floor((height - Math.round(crop.height * scale)) / 2),
          width: Math.max(1, Math.round(crop.width * scale)),
          height: Math.max(1, Math.round(crop.height * scale)),
        };
  const resized = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 3 },
  })
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .resize(bounds.width, bounds.height, { kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer();
  const mode =
    options.mode === undefined || options.mode === 'auto' ? modeFor(resized) : options.mode;
  const diagnostics = [
    `Reference interpretation uses ${mode} visual heuristics; illustrated labels and ambiguous biomes may need semantic overrides.`,
  ];
  const codes = new Uint8Array(width * height);
  const localCodes =
    mode === 'sketch' || mode === 'grayscale'
      ? grayscaleCodes(resized, bounds.width, bounds.height, mode)
      : undefined;
  for (let y = 0; y < bounds.height; y += 1)
    for (let x = 0; x < bounds.width; x += 1) {
      const local = y * bounds.width + x;
      const target = (y + bounds.y) * width + x + bounds.x;
      codes[target] =
        localCodes?.[local] ?? classify(pixelColor(resized, local), mode, options.palette ?? []);
    }
  if (mode === 'illustrated' || mode === 'satellite')
    cleanWaterTexture(codes, resized, width, bounds, options.coastDetail ?? 1, diagnostics);
  if (mode !== 'sketch' && mode !== 'grayscale')
    maskOceanText(codes, resized, width, bounds, diagnostics);
  const transform = (point: ReferencePoint): ReferencePoint => ({
    x: bounds.x + ((point.x * source.width - crop.x) / crop.width) * bounds.width,
    y: bounds.y + ((point.y * source.height - crop.y) / crop.height) * bounds.height,
  });
  const polygonEdges = [
    ...(options.ignoreMasks ?? []),
    ...(options.annotations ?? []).map((annotation) => annotation.polygon),
  ].reduce((sum, points) => sum + points.length, 0);
  if (polygonEdges * height > 50_000_000)
    throw new ServiceError(
      'MAP_REFERENCE_MASK_WORK_BLOCKED',
      'Reference polygon controls exceed the bounded scanline work budget',
    );
  for (const mask of options.ignoreMasks ?? [])
    polygon(codes, width, height, mask.map(transform), 255);
  fillUnknown(codes, width, height);
  const protectedFeatures =
    (options.annotations?.length ?? 0) > 0 ? new Uint8Array(codes.length) : undefined;
  for (const annotation of options.annotations ?? []) {
    polygon(codes, width, height, annotation.polygon.map(transform), semanticCode(annotation.kind));
    if (protectedFeatures)
      polygon(protectedFeatures, width, height, annotation.polygon.map(transform), 1);
  }
  const kind = new Uint8Array(codes.length);
  const terrain = new Uint8Array(codes.length);
  for (let pixel = 0; pixel < codes.length; pixel += 1) {
    kind[pixel] = codes[pixel]! < 3 ? codes[pixel]! : 1;
    terrain[pixel] = codes[pixel]! < 3 ? 0 : codes[pixel]! - 3;
  }
  const riverPoints = (options.riverAnnotations ?? []).reduce(
    (total, path) => total + path.length,
    0,
  );
  if (riverPoints > 131072)
    throw new ServiceError(
      'MAP_REFERENCE_RIVER_COMPLEXITY',
      'Annotated rivers exceed the bounded point budget',
    );
  const rivers = (options.riverAnnotations ?? []).flatMap((points) =>
    clipRiver(
      points.map(transform).map((point) => ({ x: point.x - bounds.x, y: point.y - bounds.y })),
      bounds.width,
      bounds.height,
    ).map((path) => path.map((point) => ({ x: point.x + bounds.x, y: point.y + bounds.y }))),
  );
  traceCoastalRivers(kind, width, height, rivers, diagnostics);
  normalizeWater(kind, width, height, rivers, diagnostics);
  cleanSmallComponents(kind, width, height, protectedFeatures, diagnostics);
  repairCorners(kind, width, height, diagnostics);
  // Corner repairs can detach an inlet from the ocean. Recheck sea fragments as well as
  // islands/lakes, otherwise a harmless subpixel correction becomes a one-pixel province.
  for (let pass = 0; pass < 4; pass++) {
    if (!cleanSmallComponents(kind, width, height, protectedFeatures, diagnostics)) break;
    repairCorners(kind, width, height, diagnostics);
  }
  if (mode === 'illustrated')
    smoothIllustratedTerrain(terrain, kind, width, height, protectedFeatures, diagnostics);
  const elevation = new Float32Array(codes.length);
  const moisture = new Float32Array(codes.length);
  for (let pixel = 0; pixel < codes.length; pixel += 1) {
    elevation[pixel] =
      kind[pixel] === 1 ? TERRAIN_ELEVATION[terrain[pixel]!]! : kind[pixel] === 2 ? -0.02 : -0.15;
    moisture[pixel] = kind[pixel] === 1 ? TERRAIN_MOISTURE[terrain[pixel]!]! : 1;
  }
  const result: ReferenceWorldRaster = {
    width,
    height,
    sourceWidth: source.width,
    sourceHeight: source.height,
    referenceBounds: bounds,
    kind,
    terrain,
    elevation,
    moisture,
    rivers,
    country: new Uint16Array(kind.length),
    inferredCountries: [],
    diagnostics,
  };
  inferCountries(result, resized, mode);
  await applyLayers(result, input, crop);
  normalizeElevation(result, options.seed, options.heightImageBytes !== undefined);
  return result;
}

/** Remove isolated pencil/paper biome noise without changing any land/water cell or reviewed mask. */
function smoothIllustratedTerrain(
  terrain: Uint8Array,
  kind: Uint8Array,
  width: number,
  height: number,
  protectedFeatures: Uint8Array | undefined,
  diagnostics: string[],
): void {
  const votes = new Uint8Array(Object.keys(REFERENCE_TERRAIN).length);
  let changed = 0;
  for (let pass = 0; pass < 2; pass++) {
    const before = terrain.slice();
    for (let y = 1; y + 1 < height; y++)
      for (let x = 1; x + 1 < width; x++) {
        const p = y * width + x;
        if (kind[p] !== 1 || protectedFeatures?.[p]) continue;
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const q = p + dy * width + dx;
            if (kind[q] === 1) votes[before[q]!]!++;
          }
        for (let candidate = 0; candidate < votes.length; candidate++) {
          if (votes[candidate]! >= 6 && candidate !== before[p]) {
            terrain[p] = candidate;
            changed++;
            break;
          }
        }
      }
  }
  if (changed)
    diagnostics.push(
      `Smoothed ${changed} isolated illustrated biome samples; coastlines and explicit semantic masks were preserved.`,
    );
}

/** Discard unannotated speckles smaller than a playable province at the target resolution. */
function cleanSmallComponents(
  kind: Uint8Array,
  width: number,
  height: number,
  protectedFeatures: Uint8Array | undefined,
  diagnostics: string[],
): number {
  const minimum = Math.max(1, Math.round(32 * (Math.min(width, height) / 2048) ** 2));
  if (minimum <= 1) return 0;
  const visited = new Uint8Array(kind.length);
  const queue = new Int32Array(kind.length);
  let islands = 0;
  let lakes = 0;
  let changed = 0;
  for (let start = 0; start < kind.length; start += 1) {
    const value = kind[start]!;
    if (visited[start]) continue;
    let head = 0;
    let tail = 0;
    let protectedComponent = false;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++]!;
      if (protectedFeatures?.[pixel]) protectedComponent = true;
      neighbors(pixel, width, height, (next) => {
        if (kind[next] === value && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      });
    }
    if (tail >= minimum || protectedComponent) continue;
    const boundary = [0, 0, 0];
    for (let index = 0; index < tail; index += 1)
      neighbors(queue[index]!, width, height, (next) => {
        if (kind[next] !== value) boundary[kind[next]!]!++;
      });
    const replacement = boundary.indexOf(Math.max(...boundary));
    for (let index = 0; index < tail; index += 1) kind[queue[index]!] = replacement;
    changed += tail;
    if (value === 1) islands += 1;
    else lakes += 1;
  }
  if (changed)
    diagnostics.push(
      `Removed ${islands} unannotated land speckles and filled ${lakes} enclosed water speckles below ${minimum} target pixels (${changed} pixels total); explicit semantic features are retained.`,
    );
  return changed;
}

/** Conservative lettering heuristic: aligned hollow dark components surrounded by ocean. */
function maskOceanText(
  codes: Uint8Array,
  data: Buffer,
  width: number,
  bounds: ReferenceBounds,
  diagnostics: string[],
): void {
  const visited = new Uint8Array(bounds.width * bounds.height);
  const queue = new Int32Array(visited.length);
  const candidates: {
    pixels: Int32Array;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }[] = [];
  const dark = (pixel: number) => {
    const r = data[pixel * 3]!,
      g = data[pixel * 3 + 1]!,
      b = data[pixel * 3 + 2]!;
    const maximum = Math.max(r, g, b);
    return maximum < 85 || (maximum < 150 && maximum - Math.min(r, g, b) < 35);
  };
  for (let start = 0; start < visited.length; start += 1) {
    if (visited[start] || !dark(start)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = bounds.width;
    let minY = bounds.height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % bounds.width;
      const y = Math.floor(pixel / bounds.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      neighbors(pixel, bounds.width, bounds.height, (next) => {
        if (!visited[next] && dark(next)) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      });
    }
    const height = maxY - minY + 1;
    const boxArea = (maxX - minX + 1) * height;
    if (
      tail < 5 ||
      tail > Math.max(256, visited.length * 0.005) ||
      tail / boxArea > 0.72 ||
      height < 4
    )
      continue;
    const padding = Math.max(1, Math.round(height / 5));
    let sea = 0;
    let samples = 0;
    for (
      let y = Math.max(0, minY - padding);
      y <= Math.min(bounds.height - 1, maxY + padding);
      y += Math.max(1, Math.floor(height / 8))
    )
      for (const x of [minX - padding, maxX + padding]) {
        if (x < 0 || x >= bounds.width) continue;
        samples += 1;
        if (codes[(y + bounds.y) * width + x + bounds.x] === 0) sea += 1;
      }
    if (samples > 0 && sea / samples >= 0.9)
      candidates.push({ pixels: Int32Array.from(queue.subarray(0, tail)), minX, minY, maxX, maxY });
    if (candidates.length > 1024) break;
  }
  let removed = 0;
  for (const candidate of candidates) {
    const height = candidate.maxY - candidate.minY + 1;
    const center = (candidate.minY + candidate.maxY) / 2;
    const aligned = candidates.filter((other) => {
      const otherHeight = other.maxY - other.minY + 1;
      const gap = Math.max(0, candidate.minX - other.maxX, other.minX - candidate.maxX);
      return (
        Math.abs((other.minY + other.maxY) / 2 - center) <= height * 0.3 &&
        otherHeight >= height * 0.6 &&
        otherHeight <= height * 1.6 &&
        gap <= height * 4
      );
    });
    if (aligned.length < 3) continue;
    for (const pixel of candidate.pixels)
      codes[
        (Math.floor(pixel / bounds.width) + bounds.y) * width + (pixel % bounds.width) + bounds.x
      ] = 255;
    removed += 1;
  }
  if (removed)
    diagnostics.push(
      `Masked ${removed} aligned dark lettering-like components surrounded by ocean; isolated dark islands are retained.`,
    );
}

/** Smooth inferred relief at world scale, then join each shoreline at the land/sea thresholds. */
function normalizeElevation(result: ReferenceWorldRaster, seed: number, explicit: boolean): void {
  const { width, height, kind, terrain, elevation } = result;
  const shortSide = Math.min(width, height);
  if (!explicit) {
    const scale = Math.max(16, shortSide / 6);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        if (kind[pixel] !== 1) continue;
        const noise = coherentNoise(seed, x, y, scale);
        const base = TERRAIN_ELEVATION[terrain[pixel]!]!;
        elevation[pixel] = base * (0.82 + noise * 0.18) + noise * 0.009;
      }
    const temporary = new Float32Array(elevation.length);
    const radius = Math.max(2, Math.round(shortSide / 180));
    for (let pass = 0; pass < 3; pass += 1) {
      blurElevation(elevation, temporary, kind, width, height, radius, false);
      blurElevation(temporary, elevation, kind, width, height, radius, true);
    }
  }
  const distance = new Uint16Array(kind.length).fill(65535);
  const queue = new Int32Array(kind.length);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < kind.length; pixel += 1) {
    const land = kind[pixel] === 1;
    const x = pixel % width;
    const coastal =
      (x > 0 && (kind[pixel - 1] === 1) !== land) ||
      (x + 1 < width && (kind[pixel + 1] === 1) !== land) ||
      (pixel >= width && (kind[pixel - width] === 1) !== land) ||
      (pixel + width < kind.length && (kind[pixel + width] === 1) !== land);
    if (coastal) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  }
  while (head < tail) {
    const pixel = queue[head++]!;
    const land = kind[pixel] === 1;
    neighbors(pixel, width, height, (next) => {
      if (distance[next] === 65535 && (kind[next] === 1) === land) {
        distance[next] = distance[pixel]! + 1;
        queue[tail++] = next;
      }
    });
  }
  const rampWidth = Math.max(4, Math.round(shortSide / 120));
  let normalized = 0;
  for (let pixel = 0; pixel < kind.length; pixel += 1) {
    const t = Math.min(1, distance[pixel]! / rampWidth);
    const factor = t * t * (3 - 2 * t);
    if (kind[pixel] === 1) {
      if (explicit && factor < 1 && elevation[pixel] !== 0) normalized += 1;
      elevation[pixel] = Math.max(0, Math.min(1, elevation[pixel]!)) * factor;
    } else if (kind[pixel] === 0) elevation[pixel] = -0.15 * factor;
    // Explicit lakes retain their fixed below-land surface rather than becoming relief noise.
    else elevation[pixel] = -0.02;
  }
  if (explicit && normalized > 0)
    result.diagnostics.push(
      `Normalized ${normalized} explicit height-layer shoreline pixels through a ${rampWidth}-pixel coastal ramp; interior heights are preserved.`,
    );
}

/** Sliding-window, land-only separable blur: water cannot darken adjacent terrestrial relief. */
function blurElevation(
  source: Float32Array,
  target: Float32Array,
  kind: Uint8Array,
  width: number,
  height: number,
  radius: number,
  vertical: boolean,
): void {
  const lines = vertical ? width : height;
  const length = vertical ? height : width;
  const stride = vertical ? width : 1;
  for (let line = 0; line < lines; line += 1) {
    const start = vertical ? line : line * width;
    let sum = 0;
    let count = 0;
    for (let coordinate = 0; coordinate <= Math.min(radius, length - 1); coordinate += 1) {
      const pixel = start + coordinate * stride;
      if (kind[pixel] === 1) {
        sum += source[pixel]!;
        count += 1;
      }
    }
    for (let coordinate = 0; coordinate < length; coordinate += 1) {
      const pixel = start + coordinate * stride;
      target[pixel] = kind[pixel] === 1 && count > 0 ? sum / count : source[pixel]!;
      const remove = coordinate - radius;
      if (remove >= 0) {
        const previous = start + remove * stride;
        if (kind[previous] === 1) {
          sum -= source[previous]!;
          count -= 1;
        }
      }
      const add = coordinate + radius + 1;
      if (add < length) {
        const next = start + add * stride;
        if (kind[next] === 1) {
          sum += source[next]!;
          count += 1;
        }
      }
    }
  }
}

/** Clip annotation segments so cropped-away coordinates never reach the world generator. */
function clipRiver(
  points: readonly ReferencePoint[],
  width: number,
  height: number,
): ReferencePoint[][] {
  const paths: ReferencePoint[][] = [];
  let current: ReferencePoint[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let minimum = 0;
    let maximum = 1;
    let visible = true;
    for (const [p, q] of [
      [-dx, a.x],
      [dx, width - 1 - a.x],
      [-dy, a.y],
      [dy, height - 1 - a.y],
    ]) {
      if (p === 0) {
        if (q! < 0) visible = false;
        continue;
      }
      const ratio = q! / p!;
      if (p! < 0) minimum = Math.max(minimum, ratio);
      else maximum = Math.min(maximum, ratio);
    }
    if (!visible || minimum > maximum) {
      if (current.length >= 2) paths.push(current);
      current = [];
      continue;
    }
    const start = { x: a.x + minimum * dx, y: a.y + minimum * dy };
    const end = { x: a.x + maximum * dx, y: a.y + maximum * dy };
    const previous = current.at(-1);
    if (previous && (previous.x !== start.x || previous.y !== start.y)) {
      if (current.length >= 2) paths.push(current);
      current = [];
    }
    if (current.length === 0) current.push(start);
    current.push(end);
  }
  if (current.length >= 2) paths.push(current);
  return paths;
}

/** Remove light paper hatching surrounded by blue water; broad white snow remains land. */
function cleanWaterTexture(
  codes: Uint8Array,
  data: Buffer,
  width: number,
  bounds: ReferenceBounds,
  detail: number,
  diagnostics: string[],
): void {
  let cleaned = 0;
  const radius = Math.max(
    2,
    Math.min(24, Math.round((Math.min(bounds.width, bounds.height) / 240) * (2 - detail))),
  );
  const replacements: number[] = [];
  for (let y = 0; y < bounds.height; y += 1)
    for (let x = 0; x < bounds.width; x += 1) {
      const pixel = (y + bounds.y) * width + x + bounds.x;
      if (codes[pixel] === 0) continue;
      const color = pixelColor(data, y * bounds.width + x);
      if (
        Math.min(color.r, color.g, color.b) < 160 ||
        Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 65
      )
        continue;
      let surrounding = 0;
      let samples = 0;
      for (const [dx, dy] of [
        [-radius, 0],
        [radius, 0],
        [0, -radius],
        [0, radius],
        [-radius, -radius],
        [radius, -radius],
        [-radius, radius],
        [radius, radius],
      ]) {
        if (x + dx! < 0 || x + dx! >= bounds.width || y + dy! < 0 || y + dy! >= bounds.height)
          continue;
        samples += 1;
        if (codes[pixel + dy! * width + dx!] === 0) surrounding += 1;
      }
      if (samples >= 3 && surrounding >= Math.ceil(samples * 0.75)) replacements.push(pixel);
    }
  for (const pixel of replacements) {
    codes[pixel] = 0;
    cleaned += 1;
  }
  if (cleaned)
    diagnostics.push(
      `Normalized ${cleaned} pale water-texture or paper-seam pixels surrounded by ocean color.`,
    );
}

/** Water farther from any broad water interior than its own stroke width is a river candidate. */
function traceCoastalRivers(
  kind: Uint8Array,
  width: number,
  height: number,
  rivers: ReferencePoint[][],
  diagnostics: string[],
): void {
  const distanceToLand = new Uint16Array(kind.length).fill(65535);
  const queue = new Int32Array(kind.length);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < kind.length; pixel += 1)
    if (kind[pixel] === 1) {
      distanceToLand[pixel] = 0;
      queue[tail++] = pixel;
    }
  if (tail === 0) return;
  while (head < tail) {
    const pixel = queue[head++]!;
    neighbors(pixel, width, height, (next) => {
      if (distanceToLand[next] === 65535) {
        distanceToLand[next] = distanceToLand[pixel]! + 1;
        queue[tail++] = next;
      }
    });
  }
  const stroke = Math.max(1, Math.min(6, Math.round(Math.min(width, height) / 450)));
  const coreDistance = new Uint16Array(kind.length).fill(65535);
  head = 0;
  tail = 0;
  for (let pixel = 0; pixel < kind.length; pixel += 1)
    if (kind[pixel] === 0 && distanceToLand[pixel]! > stroke) {
      coreDistance[pixel] = 0;
      queue[tail++] = pixel;
    }
  while (head < tail) {
    const pixel = queue[head++]!;
    neighbors(pixel, width, height, (next) => {
      if (kind[next] === 0 && coreDistance[next] === 65535) {
        coreDistance[next] = coreDistance[pixel]! + 1;
        queue[tail++] = next;
      }
    });
  }
  const candidates = new Uint8Array(kind.length);
  for (let pixel = 0; pixel < kind.length; pixel += 1)
    if (
      kind[pixel] === 0 &&
      coreDistance[pixel] !== 65535 &&
      coreDistance[pixel]! > stroke * 3 &&
      distanceToLand[pixel]! <= stroke
    )
      candidates[pixel] = 1;
  let traced = 0;
  for (let start = 0; start < candidates.length; start += 1) {
    if (candidates[start] !== 1) continue;
    head = 0;
    tail = 0;
    queue[tail++] = start;
    candidates[start] = 2;
    while (head < tail)
      neighbors(queue[head++]!, width, height, (next) => {
        if (candidates[next] === 1) {
          candidates[next] = 2;
          queue[tail++] = next;
        }
      });
    if (tail < Math.max(12, stroke * 8)) continue;
    // A passage with water at both ends is a strait. Only terminal thin channels are rivers.
    let terminal = false;
    for (let index = 0; index < tail; index += 1) {
      let waterNeighbors = 0;
      neighbors(queue[index]!, width, height, (next) => {
        if (kind[next] === 0) waterNeighbors += 1;
      });
      if (waterNeighbors <= 1) {
        terminal = true;
        break;
      }
    }
    if (!terminal) continue;
    if (rivers.length < 512) {
      const path = connectedPath(queue.subarray(0, tail), width, height);
      if (path.length >= 2) {
        rivers.push(path);
        traced += 1;
      }
    }
    for (let index = 0; index < tail; index += 1) kind[queue[index]!] = 1;
  }
  if (traced)
    diagnostics.push(`Traced ${traced} narrow visible river channels adjoining broad water.`);
}

/** Geodesic ordering follows bends rather than sorting river pixels by a coordinate. */
function connectedPath(pixels: Int32Array, width: number, height: number): ReferencePoint[] {
  if (pixels.length > 262144)
    throw new ServiceError(
      'MAP_REFERENCE_RIVER_COMPLEXITY',
      'Visible river component exceeds the bounded trace budget',
    );
  const available = new Set(pixels);
  const parents = new Map<number, number>();
  let farthest = pixels[0]!;
  for (let pass = 0; pass < 2; pass += 1) {
    parents.clear();
    parents.set(farthest, -1);
    const queue: number[] = [farthest];
    for (const pixel of queue) {
      farthest = pixel;
      neighbors(pixel, width, height, (next) => {
        if (available.has(next) && !parents.has(next)) {
          parents.set(next, pixel);
          queue.push(next);
        }
      });
    }
  }
  const path: ReferencePoint[] = [];
  let pixel = farthest;
  while (pixel !== -1) {
    path.push({ x: pixel % width, y: Math.floor(pixel / width) });
    pixel = parents.get(pixel) ?? -1;
  }
  if (path.length > 16384)
    throw new ServiceError(
      'MAP_REFERENCE_RIVER_COMPLEXITY',
      'Visible river path exceeds the bounded trace length; use a smaller reference output',
    );
  return path;
}

function normalizeWater(
  kind: Uint8Array,
  width: number,
  height: number,
  rivers: ReferencePoint[][],
  diagnostics: string[],
): void {
  const visited = new Uint8Array(kind.length);
  const queue = new Int32Array(kind.length);
  let lakeCount = 0;
  for (let start = 0; start < kind.length; start += 1) {
    if (kind[start] !== 0 || visited[start]) continue;
    let head = 0;
    let tail = 0;
    let border = false;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) border = true;
      neighbors(pixel, width, height, (next) => {
        if (kind[next] === 0 && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      });
    }
    if (border) continue;
    const spanX = maxX - minX + 1;
    const spanY = maxY - minY + 1;
    const thin = tail / Math.max(spanX, spanY) <= Math.max(2, Math.min(width, height) / 350);
    if (thin && Math.max(spanX, spanY) >= Math.max(5, Math.min(width, height) / 100)) {
      const points = connectedPath(queue.subarray(0, tail), width, height);
      for (let index = 0; index < tail; index += 1) kind[queue[index]!] = 1;
      if (rivers.length < 512) rivers.push(points);
    } else {
      for (let index = 0; index < tail; index += 1) kind[queue[index]!] = 2;
      lakeCount += 1;
    }
  }
  diagnostics.push(
    `Detected ${lakeCount} enclosed water bodies and ${rivers.length} visible or annotated river paths.`,
  );
}

function repairCorners(
  kind: Uint8Array,
  width: number,
  height: number,
  diagnostics: string[],
): void {
  let repaired = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = 0;
    for (let y = 0; y + 1 < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const a = y * width + x;
        const b = y * width + ((x + 1) % width);
        const c = a + width;
        const d = b + width;
        if (
          kind[a] !== kind[b] &&
          kind[a] !== kind[c] &&
          kind[d] !== kind[b] &&
          kind[d] !== kind[c]
        ) {
          kind[d] = kind[c]!;
          changed += 1;
        }
      }
    repaired += changed;
    if (changed === 0) break;
  }
  if (repaired)
    diagnostics.push(
      `Repaired ${repaired} subpixel diagonal water/land crossings for connected province geometry.`,
    );
}

function inferCountries(result: ReferenceWorldRaster, data: Buffer, mode: ReferenceMode): void {
  const { referenceBounds: bounds, kind, width, country } = result;
  const bins = new Map<number, { color: RgbColor; count: number }>();
  let land = 0;
  if (mode === 'political')
    for (let y = 0; y < bounds.height; y += 1)
      for (let x = 0; x < bounds.width; x += 1) {
        if (kind[(y + bounds.y) * width + x + bounds.x] !== 1) continue;
        const color = pixelColor(data, y * bounds.width + x);
        if (Math.max(color.r, color.g, color.b) < 65) continue;
        const key = ((color.r >> 4) << 8) | ((color.g >> 4) << 4) | (color.b >> 4);
        const entry = bins.get(key);
        if (entry) entry.count += 1;
        else bins.set(key, { color, count: 1 });
        land += 1;
      }
  const colors = [...bins.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
    .filter((entry) => entry[1].count >= Math.max(4, land * 0.015))
    .map((entry) => entry[1].color);
  const distinct: RgbColor[] = [];
  for (const color of colors)
    if (distinct.every((known) => distance(color, known) > 40 ** 2) && distinct.length < 32)
      distinct.push(color);
  if (distinct.length < 2) {
    distinct.splice(0, distinct.length, { r: 90, g: 145, b: 95 });
    result.diagnostics.push(
      'Political borders could not be inferred confidently; land uses one provisional country.',
    );
  } else
    result.diagnostics.push(
      `Inferred ${distinct.length} provisional countries from flat political colors; names require labels or supplied countries.`,
    );
  result.inferredCountries = distinct.map((color, index) => ({
    id: index + 1,
    name: `Reference country ${index + 1}`,
    color,
  }));
  for (let y = 0; y < result.height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (kind[pixel] !== 1) continue;
      let best = 0;
      if (
        distinct.length > 1 &&
        x >= bounds.x &&
        y >= bounds.y &&
        x < bounds.x + bounds.width &&
        y < bounds.y + bounds.height
      ) {
        const color = pixelColor(data, (y - bounds.y) * bounds.width + x - bounds.x);
        let nearest = Infinity;
        distinct.forEach((entry, index) => {
          const score = distance(color, entry);
          if (score < nearest) {
            nearest = score;
            best = index;
          }
        });
      }
      country[pixel] = best + 1;
    }
}

async function applyLayers(
  result: ReferenceWorldRaster,
  options: ReferenceWorldOptions,
  crop: ReferenceBounds,
): Promise<void> {
  for (const name of ['terrainImageBytes', 'heightImageBytes', 'politicalImageBytes'] as const) {
    const bytes = options[name];
    if (!bytes) continue;
    const source = await decode(bytes);
    if (source.width !== result.sourceWidth || source.height !== result.sourceHeight)
      throw new ServiceError(
        'MAP_REFERENCE_LAYER_ALIGNMENT',
        'Reference layers must have the same decoded dimensions',
      );
    const bounds = result.referenceBounds;
    const data = await sharp(source.data, {
      raw: { width: source.width, height: source.height, channels: 3 },
    })
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
      .resize(bounds.width, bounds.height, { kernel: sharp.kernel.nearest })
      .raw()
      .toBuffer();
    if (name === 'politicalImageBytes') {
      inferCountries(result, data, 'political');
      continue;
    }
    for (let y = 0; y < bounds.height; y += 1)
      for (let x = 0; x < bounds.width; x += 1) {
        const pixel = (y + bounds.y) * result.width + x + bounds.x;
        if (result.kind[pixel] !== 1) continue;
        const color = pixelColor(data, y * bounds.width + x);
        if (name === 'heightImageBytes')
          result.elevation[pixel] = (color.r + color.g + color.b) / 765;
        else {
          const code = classify(color, 'illustrated', options.palette ?? []);
          if (code >= 3) {
            result.terrain[pixel] = code - 3;
            result.elevation[pixel] = TERRAIN_ELEVATION[code - 3]!;
            result.moisture[pixel] = TERRAIN_MOISTURE[code - 3]!;
          }
        }
      }
  }
}
