import { ServiceError } from '../core/result.js';

/**
 * Size bands and strengths of the feature-aware partition (ADR 0058). Every value is optional;
 * the defaults follow the base land and sea province areas of the request, so a request that
 * only sets `landProvincePixels` and `seaProvincePixels` still gets a sensible spread.
 */
export interface PartitionTuning {
  /** Typical land province area in pixels by character of the ground. */
  landArea?: { fertile?: number; hills?: number; mountain?: number; waste?: number };
  /** Sea province area in pixels near a coast and on the open sea. */
  seaArea?: { coastal?: number; open?: number };
  /** `[smallest, largest]` land provinces in a state; the preferred size is their geometric mean. */
  provincesPerState?: readonly [number, number];
  /** `[smallest, largest]` land provinces in a strategic region. */
  regionSize?: readonly [number, number];
  /** How strongly a province border is pulled onto a natural line: 0 (not at all) to 60. */
  barrierStrength?: number;
  /** No province is planned smaller than this many pixels. The engine's own floor is 8. */
  minProvincePixels?: number;
  /** A sea channel at most this wide (in pixels) gets two sea provinces across it. */
  narrowStraitPx?: number;
}

export interface ResolvedPartitionTuning {
  landArea: { fertile: number; plains: number; hills: number; mountain: number; waste: number };
  seaArea: { coastal: number; open: number };
  lakeArea: number;
  states: { min: number; target: number; max: number };
  regions: { min: number; target: number; max: number };
  seaRegions: { min: number; target: number; max: number };
  barrierStrength: number;
  minProvincePixels: number;
  narrowStraitPx: number;
  /** Largest area any province may be planned at; keeps provinces inside an eighth of the map. */
  maxProvincePixels: number;
  /**
   * When the land (or sea) bands were derived from the request's base area rather than given, the
   * plan is scaled so the mean planned area equals that base area: the request still means "about
   * this many pixels per province".
   */
  normalizeLand: boolean;
  normalizeSea: boolean;
  landBase: number;
  seaBase: number;
}

export interface PartitionBase {
  width: number;
  height: number;
  landProvincePixels: number;
  seaProvincePixels: number;
  provincesPerState: number;
  landProvincesPerRegion: number;
  seaProvincesPerRegion: number;
}

/** Defaults relative to the base land area, from the vanilla spread (median 160, p10 77, p90 846). */
export const PARTITION_DEFAULTS = {
  fertile: 0.35,
  hills: 1,
  mountain: 2.2,
  waste: 3.4,
  seaCoastal: 0.5,
  seaOpen: 2.4,
  lake: 6_000,
  barrierStrength: 20,
  minProvincePixels: 40,
  narrowStraitPx: 24,
} as const;

/** The province count above which the wiki and the text-table limit advise against a map. */
export const PARTITION_PROVINCE_WARNING = 14_000;
export const PARTITION_PROVINCE_ERROR = 21_000;

function refuse(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ServiceError(code, message, details);
}

function checkPixels(name: string, value: number | undefined, minimum: number): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum)
    refuse(
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
      `partition ${name} must be a finite number of at least ${minimum} pixels`,
      { field: name, value, minimum },
    );
}

/**
 * Resolve and check the tuning against the request. Contradictory size bands, a map too small for
 * the minimum province, or an ordering that cannot be met are refused before any pixel is
 * touched, with `MAP_PARTITION_*` codes.
 */
export function resolvePartitionTuning(
  tuning: PartitionTuning | undefined,
  base: PartitionBase,
): ResolvedPartitionTuning {
  const minProvincePixels = tuning?.minProvincePixels ?? PARTITION_DEFAULTS.minProvincePixels;
  checkPixels('minProvincePixels', minProvincePixels, 20);
  const cellLimit = Math.floor(Math.min(base.width, base.height) / 14) ** 2;
  if (minProvincePixels > cellLimit)
    refuse(
      'MAP_PARTITION_MAP_TOO_SMALL',
      `The map is too small for provinces of at least ${minProvincePixels} pixels: a province may span at most an eighth of the map, about ${cellLimit} pixels here`,
      { minProvincePixels, maximum: cellLimit, width: base.width, height: base.height },
    );
  const clamp = (value: number): number =>
    Math.max(minProvincePixels, Math.min(cellLimit, Math.round(value)));
  const land = base.landProvincePixels;
  const bands = tuning?.landArea;
  for (const [name, value] of Object.entries(bands ?? {}))
    checkPixels(`landArea.${name}`, value, minProvincePixels);
  const fertile = clamp(bands?.fertile ?? land * PARTITION_DEFAULTS.fertile);
  const hills = clamp(bands?.hills ?? land * PARTITION_DEFAULTS.hills);
  const mountain = clamp(bands?.mountain ?? land * PARTITION_DEFAULTS.mountain);
  const waste = clamp(bands?.waste ?? land * PARTITION_DEFAULTS.waste);
  if (fertile > hills || hills > mountain)
    refuse(
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
      'partition landArea must grow from fertile to hills to mountain (fertile <= hills <= mountain)',
      { fertile, hills, mountain, waste },
    );
  const sea = tuning?.seaArea;
  for (const [name, value] of Object.entries(sea ?? {}))
    checkPixels(`seaArea.${name}`, value, minProvincePixels);
  const coastal = clamp(sea?.coastal ?? base.seaProvincePixels * PARTITION_DEFAULTS.seaCoastal);
  const open = clamp(sea?.open ?? base.seaProvincePixels * PARTITION_DEFAULTS.seaOpen);
  if (coastal > open)
    refuse(
      'MAP_PARTITION_AREA_BANDS_CONTRADICTORY',
      'partition seaArea.coastal may not exceed seaArea.open',
      { coastal, open },
    );
  const perState = tuning?.provincesPerState;
  if (perState !== undefined && perState[0] > perState[1])
    refuse(
      'MAP_PARTITION_STATE_SIZE_CONTRADICTORY',
      'partition provincesPerState must be [smallest, largest] with smallest <= largest',
      { provincesPerState: perState },
    );
  const regionSize = tuning?.regionSize;
  if (regionSize !== undefined && regionSize[0] > regionSize[1])
    refuse(
      'MAP_PARTITION_REGION_SIZE_CONTRADICTORY',
      'partition regionSize must be [smallest, largest] with smallest <= largest',
      { regionSize },
    );
  const group = (
    range: readonly [number, number] | undefined,
    target: number,
    low: number,
    high: number,
  ): { min: number; target: number; max: number } => {
    if (range !== undefined)
      return {
        min: range[0],
        target: Math.max(range[0], Math.min(range[1], Math.round(Math.sqrt(range[0] * range[1])))),
        max: range[1],
      };
    return {
      min: Math.max(1, Math.round(target * low)),
      target,
      max: Math.max(target, Math.round(target * high)) + (target > 1 ? 1 : 0),
    };
  };
  const strength = tuning?.barrierStrength ?? PARTITION_DEFAULTS.barrierStrength;
  if (!Number.isFinite(strength) || strength < 0 || strength > 60)
    refuse('MAP_PARTITION_STRENGTH_INVALID', 'partition barrierStrength must be from 0 to 60', {
      barrierStrength: strength,
    });
  const strait = tuning?.narrowStraitPx ?? PARTITION_DEFAULTS.narrowStraitPx;
  if (!Number.isInteger(strait) || strait < 4 || strait > 64)
    refuse('MAP_PARTITION_STRENGTH_INVALID', 'partition narrowStraitPx must be from 4 to 64', {
      narrowStraitPx: strait,
    });
  return {
    landArea: { fertile, plains: clamp(Math.sqrt(fertile * hills)), hills, mountain, waste },
    seaArea: { coastal, open },
    lakeArea: clamp(PARTITION_DEFAULTS.lake),
    states: group(perState, base.provincesPerState, 0.5, 1.6),
    regions: group(regionSize, base.landProvincesPerRegion, 0.6, 1.5),
    seaRegions: group(undefined, base.seaProvincesPerRegion, 0.5, 1.6),
    barrierStrength: strength,
    minProvincePixels,
    narrowStraitPx: strait,
    maxProvincePixels: cellLimit,
    normalizeLand: bands === undefined || Object.keys(bands).length === 0,
    normalizeSea: sea === undefined || Object.keys(sea).length === 0,
    landBase: land,
    seaBase: base.seaProvincePixels,
  };
}
