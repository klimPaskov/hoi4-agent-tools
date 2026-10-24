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
 * Parts of a geography model the synthesis cannot use yet: biomes, climate, fertility, ice and the
 * terrain shares of regions belong to the climate and biome stage (plan section C8). Relief, rivers
 * and lakes are synthesised; a model that declares anything listed here is blocked rather than
 * generated with those parts silently ignored.
 */
export function unsupportedGeographyParts(geography: ResolvedGeography): string[] {
  const parts: string[] = [];
  if (geography.biomes.length > 0) parts.push(`${geography.biomes.length} biome feature(s)`);
  if (geography.climate.declared) parts.push('the climate');
  if (geography.lands.some((land) => land.biome !== undefined || land.fertility !== undefined))
    parts.push('land biome and fertility defaults');
  if (geography.regions.some((region) => region.terrain !== undefined))
    parts.push('region terrain shares');
  if (geography.seas.some((sea) => sea.ice > 0)) parts.push('sea ice');
  return parts;
}
