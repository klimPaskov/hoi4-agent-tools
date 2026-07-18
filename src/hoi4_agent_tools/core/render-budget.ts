import { ServiceError } from './result.js';

/**
 * Fixed process-safety ceilings for decoded rasters and offline render artifacts.
 *
 * The per-artifact ceiling permits the vanilla 5632x2048 map at scale 2 and the
 * committed 255-focus benchmark. Aggregate reservations account for every
 * variant in one service request and cap their combined RGBA-equivalent area.
 */
export const RENDER_MAX_DIMENSION = 16_384;
// 48 Mi pixels preserves the committed 13,152x3,600 focus benchmark.
export const RENDER_MAX_PIXELS = 50_331_648;
// Decoded source textures use a lower ceiling; vanilla's largest audited GUI asset is 4096x4000.
export const RENDER_MAX_DECODED_PIXELS = 16_777_216;
export const RENDER_MAX_ENCODED_IMAGE_BYTES = 33_554_432;
// 64 Mi pixels preserves one vanilla scale-1 before/proposed/diff map request.
export const RENDER_MAX_AGGREGATE_PIXELS = 67_108_864;
// Large focus and GUI surfaces can legitimately contain hundreds of distinct textures and frames.
// The aggregate pixel budget remains the primary memory bound while this ceiling prevents runaway
// decoder fan-out from malformed graphs.
export const RENDER_MAX_DISTINCT_RASTER_OPERATIONS = 4_096;

export interface RenderDimensions {
  width: number;
  height: number;
  pixels: number;
}

export interface RenderBudgetViolation {
  code: 'RENDER_DIMENSIONS_BLOCKED' | 'RENDER_PIXELS_BLOCKED';
  message: string;
  details: Record<string, unknown>;
}

export interface RenderDimensionLimits {
  /** Callers may impose a stricter domain ceiling, but cannot raise the hard ceiling. */
  maximumDimension?: number;
  /** Callers may impose a stricter domain ceiling, but cannot raise the hard ceiling. */
  maximumPixels?: number;
}

export interface RenderBudgetOptions {
  /** Tests and narrow callers may lower, but never raise, the process hard ceiling. */
  maximumDistinctRasterOperations?: number;
}

/** Return a deterministic violation without allocating or throwing. */
export function renderDimensionViolation(
  width: number,
  height: number,
  label = 'render artifact',
  limits: RenderDimensionLimits = {},
): RenderBudgetViolation | undefined {
  const maximumDimension = Math.min(
    RENDER_MAX_DIMENSION,
    limits.maximumDimension ?? RENDER_MAX_DIMENSION,
  );
  const maximumPixels = Math.min(RENDER_MAX_PIXELS, limits.maximumPixels ?? RENDER_MAX_PIXELS);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return {
      code: 'RENDER_DIMENSIONS_BLOCKED',
      message: `${label} dimensions must be positive safe integers`,
      details: { label, width, height, maximumDimension },
    };
  }
  if (width > maximumDimension || height > maximumDimension) {
    return {
      code: 'RENDER_DIMENSIONS_BLOCKED',
      message: `${label} dimensions ${width}x${height} exceed the fixed dimension ceiling`,
      details: { label, width, height, maximumDimension },
    };
  }
  if (
    !Number.isSafeInteger(maximumPixels) ||
    maximumPixels <= 0 ||
    height > Math.floor(maximumPixels / width)
  ) {
    const pixels = width * height;
    return {
      code: 'RENDER_PIXELS_BLOCKED',
      message: `${label} area ${width}x${height} exceeds the fixed per-artifact pixel ceiling`,
      details: { label, width, height, pixels, maximumPixels },
    };
  }
  return undefined;
}

/** Validate dimensions before any Sharp, Buffer, or typed-array pixel allocation. */
export function assertRenderDimensions(
  width: number,
  height: number,
  label = 'render artifact',
  limits: RenderDimensionLimits = {},
): RenderDimensions {
  const violation = renderDimensionViolation(width, height, label, limits);
  if (violation !== undefined) {
    throw new ServiceError(violation.code, violation.message, violation.details);
  }
  return { width, height, pixels: width * height };
}

/**
 * Accumulates RGBA-equivalent pixel planes for one logical service request.
 * Callers share an instance across variants, comparisons, and gallery canvases.
 */
export class RenderBudget {
  #reservedPixels = 0;
  readonly #rasterOperations = new Set<string>();
  readonly #maximumDistinctRasterOperations: number;

  public constructor(options: RenderBudgetOptions = {}) {
    const requested = options.maximumDistinctRasterOperations;
    this.#maximumDistinctRasterOperations = Math.min(
      RENDER_MAX_DISTINCT_RASTER_OPERATIONS,
      requested === undefined || !Number.isSafeInteger(requested) || requested < 0
        ? RENDER_MAX_DISTINCT_RASTER_OPERATIONS
        : requested,
    );
  }

  public get reservedPixels(): number {
    return this.#reservedPixels;
  }

  public get distinctRasterOperations(): number {
    return this.#rasterOperations.size;
  }

  /** Admit one distinct decoder/rasterizer payload before invoking native image code. */
  public reserveRasterOperation(key: string, label = 'raster operation'): void {
    if (this.#rasterOperations.has(key)) return;
    if (this.#rasterOperations.size >= this.#maximumDistinctRasterOperations) {
      throw new ServiceError(
        'RENDER_RASTER_OPERATION_BUDGET_BLOCKED',
        `${label} exceeds the fixed distinct raster-operation ceiling for one request`,
        {
          label,
          operations: this.#rasterOperations.size + 1,
          maximumDistinctRasterOperations: this.#maximumDistinctRasterOperations,
        },
      );
    }
    this.#rasterOperations.add(key);
  }

  public reserve(
    width: number,
    height: number,
    label = 'render artifact',
    limits: RenderDimensionLimits = {},
  ): RenderDimensions {
    const dimensions = assertRenderDimensions(width, height, label, limits);
    if (dimensions.pixels > RENDER_MAX_AGGREGATE_PIXELS - this.#reservedPixels) {
      const next = this.#reservedPixels + dimensions.pixels;
      throw new ServiceError(
        'RENDER_AGGREGATE_BLOCKED',
        `${label} exceeds the fixed aggregate render budget for one request`,
        {
          label,
          width,
          height,
          pixels: dimensions.pixels,
          reservedPixels: this.#reservedPixels,
          requestedPixels: next,
          maximumAggregatePixels: RENDER_MAX_AGGREGATE_PIXELS,
        },
      );
    }
    const next = this.#reservedPixels + dimensions.pixels;
    this.#reservedPixels = next;
    return dimensions;
  }
}
