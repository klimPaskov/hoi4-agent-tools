/**
 * Strategic region weather and naval terrain from the climate and depth fields (ADR 0057). The
 * legacy weather is a latitude formula; here a region's weather follows the mean temperature and
 * rainfall of the macro cells under its provinces, the hemisphere and strength of the seasons the
 * model's climate declares, the share of desert and mountains in the region, and the sea ice of
 * the seas it covers. Only `+ - * /` and the stable cosine are used.
 */
import { cosDeg } from '../stable-math.js';

export interface RegionClimate {
  /** Mean annual temperature in degrees Celsius over the region. */
  temperature: number;
  /** Mean annual precipitation index (1 is a wet temperate lowland). */
  rainfall: number;
  /** Normalised distance from the warm band to the pole, 0 to 1. */
  latitude: number;
  /** True north of the warm band: the warm month is July. */
  northern: boolean;
  /** Seasonal strength of the climate, 0 to 1. */
  seasonality: number;
  /** Share of the region's land provinces in desert terrain. */
  desertShare: number;
  /** Share in mountain terrain. */
  mountainShare: number;
  /** True for a sea region. */
  sea: boolean;
  /** Sea ice cover, 0 to 1 (sea regions). */
  ice: number;
}

const DAYS = [30, 27, 30, 29, 30, 29, 30, 30, 29, 30, 29, 30];

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Weather periods of the twelve months, in the base game's layout. */
export function climateWeatherBlock(region: RegionClimate): string {
  const periods: string[] = [];
  const amplitude =
    2 * region.seasonality * (1.5 + 12 * region.latitude) * (region.sea ? 0.6 : 1);
  const warmMonth = region.northern ? 6 : 0;
  const dry = region.rainfall < 0.3 && !region.sea;
  for (let month = 0; month < 12; month += 1) {
    const mean = region.temperature + amplitude * cosDeg(30 * (month - warmMonth));
    const spread = 4 + (dry ? 4 : 0);
    const low = mean - spread;
    const high = mean + spread;
    const wet = clamp(0.35 + 0.4 * region.rainfall, 0.2, 1);
    const snow = mean < 1 ? clamp((1 - mean) / 16, 0, 0.55) * wet : 0;
    const rain = mean > 0 ? clamp(0.12 + 0.35 * region.rainfall, 0, 0.9) * (mean < 3 ? 0.6 : 1) : 0.05;
    const mud = dry ? 0.05 : clamp((0.15 + 0.7 * region.rainfall) * (mean > 0 ? 1 : 0.4), 0.05, 1.3);
    const sandstorm = region.desertShare > 0.5 && mean > 12 ? 0.2 * region.desertShare : 0;
    const arctic = region.sea
      ? region.ice >= 0.5 || region.temperature < -8
        ? mean < 0
          ? 1
          : 0.4 * Math.max(region.ice, 0.5)
        : 0
      : 0;
    const snowLevel = region.mountainShare > 0.3 && region.temperature > 8 ? 0.1 : 0;
    periods.push(
      [
        '\t\tperiod={',
        `\t\t\tbetween={ 0.${month} ${DAYS[month]}.${month} }`,
        `\t\t\ttemperature={ ${low.toFixed(1)} ${high.toFixed(1)} }`,
        '\t\t\tno_phenomenon=0.500',
        `\t\t\train_light=${rain.toFixed(3)}`,
        `\t\t\train_heavy=${(rain * 0.15).toFixed(3)}`,
        `\t\t\tsnow=${snow.toFixed(3)}`,
        `\t\t\tblizzard=${(mean < -6 ? snow * 0.25 : 0).toFixed(3)}`,
        `\t\t\tarctic_water=${arctic.toFixed(3)}`,
        `\t\t\tmud=${mud.toFixed(3)}`,
        `\t\t\tsandstorm=${sandstorm.toFixed(3)}`,
        `\t\t\tmin_snow_level=${snowLevel.toFixed(3)}`,
        '\t\t}',
      ].join('\n'),
    );
  }
  return `\tweather={\n${periods.join('\n')}\n\t}`;
}

export type NavalTerrain = 'water_shallow_sea' | 'water_fjords' | 'water_deep_ocean';

/** How one sea province reads: the model's declared depth class and kind, and its distance from land. */
export interface SeaProvinceDepth {
  /** Pixels of the province. */
  pixels: number;
  /** Mean distance from land in pixels. */
  meanLandDistance: number;
  /** The sea feature at the province centre, when the model has one. */
  declared?: { depthClass: 'shelf' | 'open' | 'abyss'; kind: 'ocean' | 'sea' | 'gulf' | 'fjord' };
}

/** Naval terrain of one sea province. `shelfPixels` is the shelf width in pixels at this map size. */
export function navalTerrainOfProvince(sea: SeaProvinceDepth, shelfPixels: number): NavalTerrain {
  const declared = sea.declared;
  if (declared !== undefined) {
    if (declared.kind === 'fjord') return 'water_fjords';
    if (declared.depthClass === 'shelf') return 'water_shallow_sea';
    if (declared.depthClass === 'abyss') return 'water_deep_ocean';
    if (declared.kind === 'gulf') return 'water_shallow_sea';
  }
  return sea.meanLandDistance < shelfPixels ? 'water_shallow_sea' : 'water_deep_ocean';
}

/** Naval terrain of a sea region: the terrain covering most of its water. */
export function navalTerrainOfRegion(
  seas: ReadonlyArray<SeaProvinceDepth>,
  shelfPixels: number,
): NavalTerrain {
  const weight: Record<NavalTerrain, number> = {
    water_deep_ocean: 0,
    water_shallow_sea: 0,
    water_fjords: 0,
  };
  for (const sea of seas) weight[navalTerrainOfProvince(sea, shelfPixels)] += sea.pixels;
  let best: NavalTerrain = 'water_deep_ocean';
  for (const candidate of ['water_shallow_sea', 'water_fjords'] as const)
    if (weight[candidate] > weight[best]) best = candidate;
  return best;
}

export interface ProvinceClimateInput {
  /** The full map size. */
  width: number;
  height: number;
  /** Macro cells (half the map size) of temperature, rainfall and sea ice (0..255). */
  temperature: Float32Array;
  rainfall: Float32Array;
  ice: Uint8Array;
  /** Distance from land in pixels per full-resolution pixel (capped), for sea provinces. */
  landDistance: Uint8Array;
  /** Province index of every pixel and the pixel count of every province. */
  provincePixels: ArrayLike<number>;
  provinceSize: ArrayLike<number>;
  provinceCount: number;
}

export interface ProvinceClimate {
  readonly temperature: Float64Array;
  readonly rainfall: Float64Array;
  /** Mean sea ice cover 0..1. */
  readonly ice: Float64Array;
  readonly landDistance: Float64Array;
}

/** Mean climate of every province: one pass over the pixels. */
export function provinceClimate(input: ProvinceClimateInput): ProvinceClimate {
  const { width, height, provinceCount } = input;
  const mw = width / 2;
  const temperature = new Float64Array(provinceCount);
  const rainfall = new Float64Array(provinceCount);
  const ice = new Float64Array(provinceCount);
  const distance = new Float64Array(provinceCount);
  for (let y = 0; y < height; y += 1) {
    const rowCell = (y >> 1) * mw;
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const id = input.provincePixels[pixel]!;
      const cell = rowCell + (x >> 1);
      temperature[id]! += input.temperature[cell]!;
      rainfall[id]! += input.rainfall[cell]!;
      ice[id]! += input.ice[cell]!;
      distance[id]! += input.landDistance[pixel]!;
    }
  }
  for (let id = 0; id < provinceCount; id += 1) {
    const size = input.provinceSize[id]!;
    if (size <= 0) continue;
    temperature[id]! /= size;
    rainfall[id]! /= size;
    ice[id]! /= size * 255;
    distance[id]! /= size;
  }
  return { temperature, rainfall, ice, landDistance: distance };
}
