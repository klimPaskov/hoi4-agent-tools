/**
 * Generation-time findings of the climate and biome stage (ADR 0057), as stable diagnostic ids
 * for the world notes: what was made (`MAP_CLIMATE_SYNTHESIZED`, `MAP_BIOME_SYNTHESIZED`), what a
 * model declared that the result misses (`MAP_REGION_TERRAIN_SHARE_MISSED`), what the engine
 * cannot show (`MAP_SEA_ICE_OUTSIDE_NORTH`), and how well the colour solver reached its targets
 * (`MAP_COLORMAP_RESIDUAL`, `MAP_COLORMAP_ATLAS_FALLBACK`).
 */
import type { ResolvedGeography } from '../geography/index.js';
import type { ColourSolverStatistics } from '../colormap-solver.js';
import type { AtlasTiles } from '../atlas-tiles.js';
import { COVER_NAMES, NO_COVER, RELIEF, REGION_SHARE_NAMES, type RegionShareName } from './biome-table.js';
import type { ClimateFields } from './climate-field.js';
import type { Ecology, EcologyNote } from './ecology.js';

const LAND = 1;

export type ClimateNote = EcologyNote;

/** Percentiles of a float field over the cells selected by a mask. */
function summarize(values: Float32Array, mask: Uint8Array): { min: number; mean: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let cell = 0; cell < values.length; cell += 1) {
    if (mask[cell] !== LAND) continue;
    const value = values[cell]!;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    count += 1;
  }
  return count === 0
    ? { min: 0, mean: 0, max: 0 }
    : { min: round(min), mean: round(sum / count), max: round(max) };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function climateNote(climate: ClimateFields, ecology: Ecology): ClimateNote {
  const temperature = summarize(climate.temperature, ecology.kind);
  const rainfall = summarize(climate.rainfall, ecology.kind);
  return {
    code: 'MAP_CLIMATE_SYNTHESIZED',
    severity: 'info',
    message: `Computed the climate: land temperature ${temperature.min} to ${temperature.max} degrees (mean ${temperature.mean}), rainfall index ${rainfall.min} to ${rainfall.max} (mean ${rainfall.mean}), wind from ${climate.settings.windFrom} degrees${climate.settings.declared ? '' : ' (the model declares no climate; defaults apply)'}`,
    details: {
      declared: climate.settings.declared,
      windFrom: climate.settings.windFrom,
      temperature,
      rainfall,
    },
  };
}

export function biomeNote(
  ecology: Ecology,
  treeNonZeroShare: number,
  indicesUsed: number,
): ClimateNote {
  const counts = new Map<string, number>();
  let land = 0;
  let fertilitySum = 0;
  for (let cell = 0; cell < ecology.kind.length; cell += 1) {
    if (ecology.kind[cell] !== LAND) continue;
    land += 1;
    fertilitySum += ecology.fertility[cell]!;
    const relief = ecology.relief[cell]!;
    const key =
      relief === RELIEF.mountain
        ? 'mountain'
        : relief === RELIEF.hills
          ? 'hills'
          : ecology.cover[cell] === NO_COVER
            ? 'plains'
            : COVER_NAMES[ecology.cover[cell]!]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shares = Object.fromEntries(
    [...counts].sort().map(([key, count]) => [key, round(count / Math.max(1, land))]),
  );
  return {
    code: 'MAP_BIOME_SYNTHESIZED',
    severity: 'info',
    message: `Assigned biomes to ${land} macro cells of land: ${Object.entries(shares)
      .map(([key, share]) => `${key} ${Math.round(share * 100)}%`)
      .join(', ')}; mean fertility ${round(fertilitySum / Math.max(1, land) / 255)}, ${Math.round(treeNonZeroShare * 1000) / 10}% of the tree grid planted, ${indicesUsed} graphical terrain indices in use`,
    details: {
      shares,
      meanFertility: round(fertilitySum / Math.max(1, land) / 255),
      treeGridShare: Math.round(treeNonZeroShare * 10_000) / 10_000,
      graphicalIndices: indicesUsed,
    },
  };
}

/**
 * Province-level shares of the terrain in every region that declares shares: the land area of the
 * provinces, by the terrain they were given.
 */
export function provinceRegionShares(
  ecology: Ecology,
  width: number,
  height: number,
  provincePixels: ArrayLike<number>,
  terrainOf: (province: number) => string | undefined,
  kind: Uint8Array,
): Map<number, Record<string, number>> {
  const mw = ecology.width;
  const counts = new Map<number, Record<string, number>>();
  const totals = new Map<number, number>();
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (kind[pixel] !== LAND) continue;
      const region = ecology.regionOf[(y >> 1) * mw + (x >> 1)]!;
      if (region === 0) continue;
      const terrain = terrainOf(provincePixels[pixel]!);
      if (terrain === undefined) continue;
      let row = counts.get(region);
      if (row === undefined) counts.set(region, (row = {}));
      row[terrain] = (row[terrain] ?? 0) + 1;
      totals.set(region, (totals.get(region) ?? 0) + 1);
    }
  const shares = new Map<number, Record<string, number>>();
  for (const [region, row] of counts) {
    const total = totals.get(region)!;
    shares.set(
      region,
      Object.fromEntries(Object.entries(row).map(([key, count]) => [key, count / total])),
    );
  }
  return shares;
}

/** A region whose province terrain misses a declared share by more than this has a finding. */
export const REGION_SHARE_TOLERANCE = 0.12;

/**
 * Compare the declared terrain shares of each region with the terrain its provinces ended up
 * with. A mountain or hills share the relief cannot give is reported too.
 */
export function regionShareNotes(
  ecology: Ecology,
  provinceShares: ReadonlyMap<number, Record<string, number>>,
): ClimateNote[] {
  const notes: ClimateNote[] = [];
  ecology.regions.forEach((region, index) => {
    if (region.terrain === undefined) return;
    const found = provinceShares.get(index + 1);
    if (found === undefined) return;
    const targets: Record<string, number> = {};
    const result: Record<string, number> = {};
    const missed: string[] = [];
    for (const name of REGION_SHARE_NAMES as readonly RegionShareName[]) {
      const target = region.terrain[name];
      if (target === undefined || name === 'urban' || name === 'snow') continue;
      const achieved = found[name] ?? 0;
      targets[name] = target;
      result[name] = Math.round(achieved * 1000) / 1000;
      if (Math.abs(achieved - target) > REGION_SHARE_TOLERANCE) missed.push(name);
    }
    if (missed.length > 0)
      notes.push({
        code: 'MAP_REGION_TERRAIN_SHARE_MISSED',
        severity: 'warning',
        message: `Region ${region.id}: ${missed
          .map(
            (name) =>
              `${name} ${Math.round((result[name] ?? 0) * 100)}% against ${Math.round((targets[name] ?? 0) * 100)}% declared`,
          )
          .join(', ')} by province area; provinces take one terrain each${missed.some((name) => name === 'hills' || name === 'mountain') ? ', and hills and mountains come from the relief of the model, not from the climate' : ''}`,
        details: { regionId: region.id, targets, achieved: result },
      });
  });
  return notes;
}

/** The engine draws sea ice only in the north quarter of the map (`pdxwater.shader:246`). */
export function seaIceNotes(geography: ResolvedGeography): ClimateNote[] {
  const notes: ClimateNote[] = [];
  for (const sea of geography.seas) {
    if (sea.ice <= 0) continue;
    if (sea.area.interior.y > 0.26)
      notes.push({
        code: 'MAP_SEA_ICE_OUTSIDE_NORTH',
        severity: 'warning',
        message: `Sea ${sea.id} has ice ${sea.ice} but lies below the northern quarter of the map; the game draws sea ice only above 74% of the map height, so only its pale water colour and arctic weather are written`,
        details: { seaId: sea.id, ice: sea.ice, centreY: Math.round(sea.area.interior.y * 1000) / 1000 },
      });
  }
  return notes;
}

export function colourNotes(statistics: ColourSolverStatistics, tiles: AtlasTiles): ClimateNote[] {
  const notes: ClimateNote[] = [];
  const share = statistics.landCells === 0 ? 0 : statistics.residual / statistics.landCells;
  const clamped = statistics.landCells === 0 ? 0 : statistics.clamped / statistics.landCells;
  notes.push({
    code: 'MAP_COLORMAP_RESIDUAL',
    severity: share > 0.05 ? 'warning' : 'info',
    message: `The colour map solver reached its target colour within 6/255 on ${Math.round((1 - share) * 1000) / 10}% of ${statistics.landCells} land cells (${Math.round(clamped * 1000) / 10}% out of reach of the atlas tile); mean value ${Math.round(statistics.meanValue * 10) / 10}, ${statistics.distinct5BitColours} distinct 5-bit colours`,
    details: {
      landCells: statistics.landCells,
      residualShare: Math.round(share * 10_000) / 10_000,
      clampedShare: Math.round(clamped * 10_000) / 10_000,
      meanValue: Math.round(statistics.meanValue * 10) / 10,
      distinct5BitColours: statistics.distinct5BitColours,
    },
  });
  if (tiles.source === 'bundled-table')
    notes.push({
      code: 'MAP_COLORMAP_ATLAS_FALLBACK',
      severity: 'info',
      message: `The atlas tile colours come from the bundled table of the base game's atlas (${tiles.reason ?? 'the installed atlas is unavailable'}); a modified atlas will look different from this estimate`,
    });
  return notes;
}
