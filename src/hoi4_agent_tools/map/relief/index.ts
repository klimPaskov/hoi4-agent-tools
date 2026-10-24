import type { ResolvedGeography } from '../geography/index.js';

export * from './fields.js';
export * from './land.js';
export {
  DEFAULT_RELIEF,
  HEIGHT_CEILING,
  LAND_FLOOR,
  PEAK_BASE,
  PEAK_SPAN,
  RELIEF_SCALE_FACTOR,
  peakHeight,
  plateauHeight,
  synthesizeMacroRelief,
  type MacroRelief,
  type RangeTable,
  type ReliefScaleName,
  type ReliefSettings,
} from './macro-relief.js';
export {
  DEFAULT_RIVER_DENSITY,
  MAXIMUM_RIVER_CLIMB,
  RIVER_PIXEL_CAP,
  synthesizeHydrology,
  type HydrologyResult,
  type MacroRiver,
} from './hydrology.js';
export {
  RIVER_DISTRIBUTARY_START_INDEX,
  RIVER_LAND_INDEX,
  RIVER_SOURCE_INDEX,
  RIVER_TRIBUTARY_END_INDEX,
  RIVER_WATER_INDEX,
  rasterizeRivers,
} from './river-raster.js';
export {
  NORMAL_RESPONSE,
  synthesizeTerrain,
  type RiverPath,
  type SynthesizedTerrain,
  type TerrainSynthesisInput,
} from './terrain-synthesis.js';
export { reliefStatistics, straightRiverShare, type ReliefNote } from './checks.js';


/**
 * Parts of a geography model the synthesis cannot honour. Relief, rivers and lakes (ADR 0056) and
 * climate, biomes, fertility, region terrain shares, sea ice and city styles (ADR 0057) are all
 * synthesised, so a valid model has none; a part added to the schema later that the synthesis does
 * not yet use is listed here, and a model that declares it is refused with a message naming it
 * instead of being generated with it silently ignored.
 */
export function unsupportedGeographyParts(geography: ResolvedGeography): string[] {
  void geography;
  return [];
}
