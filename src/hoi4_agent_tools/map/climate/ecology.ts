/**
 * Ecology (ADR 0057, plan section C8): from the climate, the relief and the rivers of a geography
 * world to the ground cover, relief class, fertility and tree density of every macro cell (half
 * the map size). The model's declarations win in a fixed order: a biome polygon (higher `z` over
 * lower), then the land's own default biome and fertility, then the terrain shares of the region
 * (met by moving the boundaries between covers where the climate changes most, see
 * `allocateShares`), then the climate itself. Relief is separate from cover: mountains and hills
 * come from the height field, the ruggedness and the model's `hills` biomes, and a forest can
 * cover a hill.
 */
import type { ResolvedArea, ResolvedGeography, ResolvedRegion } from '../geography/index.js';
import { scanAreaStrip } from '../geography/index.js';
import { chamferDistance } from '../relief/grid.js';
import type { TerrainFields } from '../relief/fields.js';
import { clamp01 } from '../stable-math.js';
import { allocateShares } from './allocation.js';
import type { ClimateFields } from './climate-field.js';
import {
  COVER,
  COVER_COUNT,
  COVER_NAMES,
  COVER_TABLE,
  DECLARED_BIOME,
  GROUP_COVERS,
  NO_COVER,
  REGION_SHARE_NAMES,
  RELIEF,
  SHARE_GROUPS,
  type RegionShareName,
  type ShareGroup,
} from './biome-table.js';

const SEA = 0;
const LAND = 1;
const LAKE = 2;
const NONE = 255;

export interface EcologyNote {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface EcologyInput {
  geography: ResolvedGeography;
  /** The full map size. */
  width: number;
  height: number;
  seed: number;
  /** Full-resolution surface: 0 sea, 1 land, 2 lake. */
  kind: Uint8Array;
  /** Full-resolution `heightmap.bmp` values. */
  heights: Uint8Array;
  /** `rivers.bmp` indices: 0 to 11 are river pixels. */
  riverBitmap: Uint8Array;
  fields: TerrainFields;
  climate: ClimateFields;
  signal?: AbortSignal | undefined;
}

/** The share a region declared for each terrain, and what the result came to, in macro cells. */
export interface RegionShareReport {
  readonly id: string;
  readonly name?: string;
  readonly cells: number;
  readonly targets: Readonly<Partial<Record<RegionShareName, number>>>;
  readonly achieved: Readonly<Partial<Record<RegionShareName, number>>>;
}

export interface Ecology {
  /** The macro grid. */
  readonly width: number;
  readonly height: number;
  /** 0 sea, 1 land, 2 lake per macro cell. */
  readonly kind: Uint8Array;
  /** `COVER` code on land cells, `NO_COVER` elsewhere. */
  readonly cover: Uint8Array;
  /** `RELIEF` code on land cells. */
  readonly relief: Uint8Array;
  /** Fertility 0..255. */
  readonly fertility: Uint8Array;
  /** Tree density 0..255 (forests and jungles; a little on savanna and marsh). */
  readonly density: Uint8Array;
  /** Mean height of the macro cell in map values (94 on water). */
  readonly heights: Float32Array;
  /** Ruggedness: height change per macro cell. */
  readonly slope: Float32Array;
  /** Soil moisture index: rainfall over evaporation plus rivers, valleys and lakes. */
  readonly moisture: Float32Array;
  readonly temperature: Float32Array;
  readonly rainfall: Float32Array;
  /** 0..255 closeness to a river and to a lake. */
  readonly riverProximity: Uint8Array;
  readonly lakeProximity: Uint8Array;
  /** 1 where a declaration (biome polygon or land default) chose the cover. */
  readonly declared: Uint8Array;
  /** Index into `regions` plus one, 0 outside every region. */
  readonly regionOf: Int16Array;
  readonly regions: readonly ResolvedRegion[];
  readonly shares: readonly RegionShareReport[];
  readonly notes: readonly EcologyNote[];
}

// ---------------------------------------------------------------------------------------------
// Natural cover from the climate

function tent(x: number, centre: number, width: number): number {
  return 1 - Math.abs(x - centre) / width;
}

/** Score of every cover for a cell; the highest score is the natural cover. */
export function coverScores(
  temperature: number,
  moisture: number,
  flat: number,
  wetFlat: number,
  out: Float32Array,
  offset = 0,
): void {
  out[offset + COVER.plains] = tent(moisture, 0.78, 0.45);
  out[offset + COVER.farmland] = -9;
  out[offset + COVER.steppe] = 0.95 * tent(moisture, 0.42, 0.22);
  const boreal = temperature < 6 ? 0.3 * clamp01((6 - temperature) / 9) : 0;
  out[offset + COVER.forest] = tent(moisture, 1.2, 0.6) + (moisture > 0.55 ? boreal : 0);
  out[offset + COVER.jungle] =
    temperature < 19
      ? -2
      : tent(moisture, 1.8, 0.6) + 0.1 * clamp01((temperature - 24) / 6);
  out[offset + COVER.desert] =
    1 - 3.6 * moisture - (temperature < -2 ? 0.05 * (-2 - temperature) : 0);
  out[offset + COVER.marsh] = tent(moisture, 1.95, 0.5) - 2 * (1 - wetFlat);
  out[offset + COVER.tundra] = temperature > 3 ? -2 : 0.95 - 0.13 * Math.abs(temperature + 6);
  out[offset + COVER.ice] = temperature > -4 ? -3 : (-temperature - 9) / 4 - 0.2;
  void flat;
}

function bestCover(scores: Float32Array, offset = 0): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let cover = 0; cover < COVER_COUNT; cover += 1) {
    const value = scores[offset + cover]!;
    if (value > bestScore) {
      bestScore = value;
      best = cover;
    }
  }
  return best;
}

/** Potential evapotranspiration: cold ground loses little. */
function evaporation(temperature: number): number {
  return 0.45 + 0.55 * clamp01((temperature + 5) / 30);
}

function fertilityOf(
  cover: number,
  temperature: number,
  moisture: number,
  slope: number,
  valley: number,
  river: number,
): number {
  const base = COVER_TABLE[COVER_NAMES[cover]!].fertility;
  const moistureSuit = clamp01(1 - Math.abs(moisture - 0.9) / 1.0);
  const temperatureSuit = clamp01(1 - Math.abs(temperature - 17) / 22);
  const slopeSuit = 1 - clamp01(slope / 2.5);
  const suit = (0.35 + 0.65 * moistureSuit) * (0.4 + 0.6 * temperatureSuit) * (0.35 + 0.65 * slopeSuit);
  const value = base * suit + (base > 0.15 ? 0.25 * valley + 0.12 * river : 0);
  return value > 1 ? 1 : value < 0 ? 0 : value;
}

// ---------------------------------------------------------------------------------------------
// Rasters of the model's declarations

function paint(
  area: ResolvedArea,
  width: number,
  height: number,
  write: (index: number) => void,
): void {
  scanAreaStrip(area, { width, height }, { y0: 0, y1: height }, (y, x0, x1) => {
    for (let x = x0; x < x1; x += 1) write(y * width + x);
  });
}

function regionAreas(
  region: ResolvedRegion,
  geography: ResolvedGeography,
): readonly ResolvedArea[] {
  if (region.area !== undefined) return [region.area];
  const areas: ResolvedArea[] = [];
  for (const id of region.landIds) {
    const land = geography.get('land', id);
    if (land !== undefined) areas.push(land.area);
  }
  return areas;
}

function macroKind(kind: Uint8Array, width: number, height: number): Uint8Array {
  const mw = width / 2;
  const mh = height / 2;
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y += 1)
    for (let x = 0; x < mw; x += 1) {
      const base = 2 * y * width + 2 * x;
      let lakes = 0;
      let lands = 0;
      for (const pixel of [base, base + 1, base + width, base + width + 1]) {
        if (kind[pixel] === LAKE) lakes += 1;
        else if (kind[pixel] === LAND) lands += 1;
      }
      out[y * mw + x] = lakes >= 2 ? LAKE : lands >= 2 ? LAND : lakes + lands >= 2 ? LAND : SEA;
    }
  return out;
}

const shareNames = new Set<string>(REGION_SHARE_NAMES);

/** Compute the ecology of a geography world. */
export function computeEcology(input: EcologyInput): Ecology {
  const { geography, width, height, climate } = input;
  const mw = width / 2;
  const mh = height / 2;
  if (climate.width !== mw || climate.height !== mh)
    throw new RangeError('The climate grid is not half the map size');
  const total = mw * mh;
  const notes: EcologyNote[] = [];
  const kind = macroKind(input.kind, width, height);

  // Macro heights, ruggedness and the river and lake closeness.
  const heights = new Float32Array(total);
  const riverSeed = new Uint8Array(total);
  for (let y = 0; y < mh; y += 1) {
    if (y % 64 === 0) input.signal?.throwIfAborted();
    for (let x = 0; x < mw; x += 1) {
      const base = 2 * y * width + 2 * x;
      let sum = 0;
      let lands = 0;
      for (const pixel of [base, base + 1, base + width, base + width + 1]) {
        if (input.kind[pixel] === LAND) {
          sum += input.heights[pixel]!;
          lands += 1;
          if (input.riverBitmap[pixel]! <= 11) riverSeed[y * mw + x] = 1;
        }
      }
      heights[y * mw + x] = lands === 0 ? 94 : sum / lands;
    }
  }
  const slope = new Float32Array(total);
  for (let y = 0; y < mh; y += 1)
    for (let x = 0; x < mw; x += 1) {
      const cell = y * mw + x;
      if (kind[cell] !== LAND) continue;
      const here = heights[cell]!;
      const at = (cx: number, cy: number): number => {
        const other = Math.min(mh - 1, Math.max(0, cy)) * mw + Math.min(mw - 1, Math.max(0, cx));
        return kind[other] === LAND ? heights[other]! : here;
      };
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      slope[cell] = Math.sqrt(dx * dx + dy * dy) / 2;
    }
  const lakeSeed = new Uint8Array(total);
  for (let cell = 0; cell < total; cell += 1) if (kind[cell] === LAKE) lakeSeed[cell] = 1;
  const riverDistance = chamferDistance(riverSeed, mw, mh, 60);
  const lakeDistance = chamferDistance(lakeSeed, mw, mh, 60);
  const riverProximity = new Uint8Array(total);
  const lakeProximity = new Uint8Array(total);
  for (let cell = 0; cell < total; cell += 1) {
    const river = Math.max(0, 1 - riverDistance[cell]! / 7);
    riverProximity[cell] = Math.round(river * river * 255);
    const lake = Math.max(0, 1 - lakeDistance[cell]! / 9);
    lakeProximity[cell] = Math.round(lake * lake * 255);
  }

  // Soil moisture, then the natural cover and relief of every land cell.
  const moisture = new Float32Array(total);
  const natural = new Uint8Array(total).fill(NO_COVER);
  const relief = new Uint8Array(total);
  const scores = new Float32Array(COVER_COUNT);
  const valley = input.fields.valley.data;
  const mountain = input.fields.mountain.data;
  for (let cell = 0; cell < total; cell += 1) {
    if (kind[cell] !== LAND) continue;
    const t = climate.temperature[cell]!;
    const m = Math.min(
      2.5,
      climate.rainfall[cell]! / evaporation(t) +
        0.45 * (riverProximity[cell]! / 255) +
        0.3 * (valley[cell]! / 255) +
        0.35 * (lakeProximity[cell]! / 255),
    );
    moisture[cell] = m;
    const h = heights[cell]!;
    const s = slope[cell]!;
    const footprint = mountain[cell]! / 255;
    const flat = 1 - clamp01(s / 1.2);
    const wetFlat = flat * (1 - clamp01((h - 112) / 20));
    coverScores(t, m, flat, wetFlat, scores);
    natural[cell] = bestCover(scores);
    relief[cell] =
      (h >= 150 && (footprint >= 0.2 || s >= 1.5)) || h >= 185
        ? RELIEF.mountain
        : (h >= 118 && (footprint >= 0.1 || s >= 0.9)) || (h >= 135 && s >= 0.5)
          ? RELIEF.hills
          : RELIEF.flat;
  }

  // The model's declarations, painted in precedence order.
  const declCover = new Uint8Array(total).fill(NONE);
  const declFertility = new Uint8Array(total).fill(NONE);
  const declDensity = new Uint8Array(total).fill(NONE);
  const encode = (value: number): number => Math.round(clamp01(value) * 254);
  for (const land of geography.lands) {
    if (land.biome === undefined && land.fertility === undefined) continue;
    const declared = land.biome === undefined ? undefined : DECLARED_BIOME[land.biome];
    paint(land.area, mw, mh, (cell) => {
      if (kind[cell] !== LAND) return;
      if (declared !== undefined) {
        if ('cover' in declared) declCover[cell] = declared.cover;
        else relief[cell] = Math.max(relief[cell]!, declared.relief);
      }
      if (land.fertility !== undefined) declFertility[cell] = encode(land.fertility);
    });
  }
  for (const biome of geography.biomes) {
    const declared = DECLARED_BIOME[biome.biome];
    paint(biome.area, mw, mh, (cell) => {
      if (kind[cell] !== LAND) return;
      if ('cover' in declared) declCover[cell] = declared.cover;
      else if (relief[cell] === RELIEF.flat) relief[cell] = declared.relief;
      if (biome.fertility !== undefined) declFertility[cell] = encode(biome.fertility);
      declDensity[cell] = encode(biome.density);
    });
  }

  // Regions and their terrain shares.
  const regions = geography.regions.filter(
    (region) => region.area !== undefined || region.landIds.length > 0,
  );
  const regionOf = new Int16Array(total);
  regions.forEach((region, index) => {
    for (const area of regionAreas(region, geography))
      paint(area, mw, mh, (cell) => {
        if (kind[cell] === LAND) regionOf[cell] = index + 1;
      });
  });

  const cover = new Uint8Array(total).fill(NO_COVER);
  const declared = new Uint8Array(total);
  for (let cell = 0; cell < total; cell += 1) {
    if (kind[cell] !== LAND) continue;
    if (declCover[cell] !== NONE) {
      cover[cell] = declCover[cell]!;
      declared[cell] = 1;
    } else cover[cell] = natural[cell]!;
  }

  const tempLookup = climate.temperature;
  regions.forEach((region, index) => {
    const targets = shareTargets(region, notes);
    if (targets === undefined) return;
    input.signal?.throwIfAborted();
    const members: number[] = [];
    for (let cell = 0; cell < total; cell += 1) if (regionOf[cell] === index + 1) members.push(cell);
    if (members.length === 0) return;
    let mountains = 0;
    let hills = 0;
    const forced = new Float64Array(SHARE_GROUPS.length);
    const free: number[] = [];
    for (const cell of members) {
      if (relief[cell] === RELIEF.mountain) mountains += 1;
      else if (relief[cell] === RELIEF.hills) hills += 1;
      else if (declared[cell] === 1) {
        const group = shareGroupIndex(cover[cell]!);
        forced[group]! += 1;
      } else free.push(cell);
    }
    const flatCells = members.length - mountains - hills;
    let coverSum = 0;
    for (const name of SHARE_GROUPS) coverSum += targets[name] ?? 0;
    if (coverSum <= 0 || free.length === 0) return;
    // How many free cells each group needs once the cells a declaration forced are counted.
    const need = new Float64Array(SHARE_GROUPS.length);
    let needSum = 0;
    SHARE_GROUPS.forEach((name, group) => {
      const wanted = ((targets[name] ?? 0) / coverSum) * flatCells;
      need[group] = Math.max(0, wanted - forced[group]!);
      needSum += need[group]!;
    });
    const proportions =
      needSum > 0
        ? need
        : Float64Array.from(SHARE_GROUPS.map((name) => targets[name] ?? 0));
    const allocationScores = new Float32Array(free.length * SHARE_GROUPS.length);
    const coverScore = new Float32Array(COVER_COUNT);
    free.forEach((cell, position) => {
      const t = tempLookup[cell]!;
      const m = moisture[cell]!;
      const flat = 1 - clamp01(slope[cell]! / 1.2);
      const wetFlat = flat * (1 - clamp01((heights[cell]! - 112) / 20));
      coverScores(t, m, flat, wetFlat, coverScore);
      SHARE_GROUPS.forEach((name, group) => {
        let best = -Infinity;
        for (const member of GROUP_COVERS[name]) if (coverScore[member]! > best) best = coverScore[member]!;
        allocationScores[position * SHARE_GROUPS.length + group] = best;
      });
    });
    const result = allocateShares({
      count: free.length,
      categories: SHARE_GROUPS.length,
      scores: allocationScores,
      targets: proportions,
    });
    free.forEach((cell, position) => {
      const group = SHARE_GROUPS[result.assignment[position]!]!;
      const t = tempLookup[cell]!;
      const m = moisture[cell]!;
      const flat = 1 - clamp01(slope[cell]! / 1.2);
      const wetFlat = flat * (1 - clamp01((heights[cell]! - 112) / 20));
      coverScores(t, m, flat, wetFlat, coverScore);
      let best = GROUP_COVERS[group][0]!;
      for (const member of GROUP_COVERS[group]) if (coverScore[member]! > coverScore[best]!) best = member;
      cover[cell] = best;
    });
  });

  // Fertility, the farmland upgrade and tree density.
  const fertility = new Uint8Array(total);
  const density = new Uint8Array(total);
  for (let cell = 0; cell < total; cell += 1) {
    if (kind[cell] !== LAND) continue;
    const t = climate.temperature[cell]!;
    const m = moisture[cell]!;
    const s = slope[cell]!;
    const valleyN = valley[cell]! / 255;
    const riverN = riverProximity[cell]! / 255;
    let current = cover[cell]!;
    let value = fertilityOf(current, t, m, s, valleyN, riverN);
    if (declFertility[cell] !== NONE) value = declFertility[cell]! / 254;
    if (current === COVER.plains && relief[cell] === RELIEF.flat && value >= 0.6) {
      current = COVER.farmland;
      cover[cell] = current;
      if (declFertility[cell] === NONE) value = fertilityOf(current, t, m, s, valleyN, riverN);
    }
    if (relief[cell] === RELIEF.mountain) value = Math.min(value, 0.15);
    else if (relief[cell] === RELIEF.hills) value = Math.min(value, 0.55);
    fertility[cell] = Math.round(clamp01(value) * 255);
    density[cell] = Math.round(
      clamp01(treeDensity(current, relief[cell]!, t, m, value, declDensity[cell]!)) * 255,
    );
  }

  const shares = reportShares(regions, regionOf, cover, relief);
  reportFertileDeserts(geography, kind, cover, mw, mh, notes);
  return {
    width: mw,
    height: mh,
    kind,
    cover,
    relief,
    fertility,
    density,
    heights,
    slope,
    moisture,
    temperature: climate.temperature,
    rainfall: climate.rainfall,
    riverProximity,
    lakeProximity,
    declared,
    regionOf,
    regions,
    shares,
    notes,
  };
}

function shareGroupIndex(cover: number): number {
  return SHARE_GROUPS.indexOf(COVER_TABLE[COVER_NAMES[cover]!].shareGroup);
}

/** The declared cover shares of a region, with notes for names the allocation cannot meet. */
function shareTargets(
  region: ResolvedRegion,
  notes: EcologyNote[],
): Partial<Record<ShareGroup, number>> | undefined {
  if (region.terrain === undefined) return undefined;
  const targets: Partial<Record<ShareGroup, number>> = {};
  for (const [name, share] of Object.entries(region.terrain)) {
    if (!shareNames.has(name) || share <= 0) continue;
    if (name === 'urban') {
      notes.push({
        code: 'MAP_REGION_TERRAIN_URBAN_IGNORED',
        severity: 'info',
        message: `Region ${region.id} declares an urban share of ${share}; urban terrain comes from cities and victory points, so the share is not allocated`,
        details: { regionId: region.id, share },
      });
      continue;
    }
    if (name === 'hills' || name === 'mountain') continue;
    targets[name as ShareGroup] = share;
  }
  return targets;
}

function reportShares(
  regions: readonly ResolvedRegion[],
  regionOf: Int16Array,
  cover: Uint8Array,
  relief: Uint8Array,
): RegionShareReport[] {
  const reports: RegionShareReport[] = [];
  regions.forEach((region, index) => {
    if (region.terrain === undefined) return;
    const counts: Record<string, number> = {};
    let cells = 0;
    for (let cell = 0; cell < regionOf.length; cell += 1) {
      if (regionOf[cell] !== index + 1) continue;
      cells += 1;
      const key =
        relief[cell] === RELIEF.mountain
          ? 'mountain'
          : relief[cell] === RELIEF.hills
            ? 'hills'
            : COVER_TABLE[COVER_NAMES[cover[cell]!]!].shareGroup;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (cells === 0) return;
    const targets: Partial<Record<RegionShareName, number>> = {};
    const achieved: Partial<Record<RegionShareName, number>> = {};
    for (const name of REGION_SHARE_NAMES) {
      const target = region.terrain[name];
      if (target !== undefined) targets[name] = target;
      if (target !== undefined || (counts[name] ?? 0) > 0)
        achieved[name] = Math.round(((counts[name] ?? 0) / cells) * 1000) / 1000;
    }
    reports.push({
      id: region.id,
      ...(region.name === undefined ? {} : { name: region.name }),
      cells,
      targets,
      achieved,
    });
  });
  return reports;
}

/** A land or biome declared fertile with more than a tenth of its cells in desert is a model defect. */
function reportFertileDeserts(
  geography: ResolvedGeography,
  kind: Uint8Array,
  cover: Uint8Array,
  mw: number,
  mh: number,
  notes: EcologyNote[],
): void {
  const check = (id: string, label: string, area: ResolvedArea): void => {
    let cells = 0;
    let desert = 0;
    paint(area, mw, mh, (cell) => {
      if (kind[cell] !== LAND) return;
      cells += 1;
      if (cover[cell] === COVER.desert) desert += 1;
    });
    if (cells > 0 && desert / cells > 0.1)
      notes.push({
        code: 'MAP_FERTILE_AREA_DESERT',
        severity: 'warning',
        message: `${label} ${id} is declared fertile but ${Math.round((desert / cells) * 100)}% of its land came out desert; a declared biome or a wetter climate elsewhere in the model overrides it`,
        details: { featureId: id, desertShare: Math.round((desert / cells) * 1000) / 1000 },
      });
  };
  for (const land of geography.lands)
    if ((land.fertility ?? 0) >= 0.6) check(land.id, 'Land', land.area);
  for (const biome of geography.biomes)
    if (biome.biome !== 'desert' && ((biome.fertility ?? 0) >= 0.6 || biome.biome === 'farmland'))
      check(biome.id, 'Biome', biome.area);
}

/** Tree density 0..1 of a cell from its cover, relief, climate and a declared density. */
function treeDensity(
  cover: number,
  relief: number,
  temperature: number,
  moisture: number,
  fertility: number,
  declared: number,
): number {
  let value: number;
  const wet = clamp01((moisture - 0.8) / 1.0);
  if (cover === COVER.forest)
    value = declared !== NONE ? declared / 254 : 0.35 + 0.45 * wet + 0.1 * fertility;
  else if (cover === COVER.jungle) value = declared !== NONE ? declared / 254 : 0.82;
  else if (cover === COVER.marsh) value = 0.22;
  else if (cover === COVER.steppe || cover === COVER.plains || cover === COVER.farmland)
    value = moisture > 0.7 && temperature > 12 ? 0.05 : 0.02;
  else if (cover === COVER.tundra) value = 0.03;
  else value = 0;
  if (relief === RELIEF.hills) value *= 0.75;
  else if (relief === RELIEF.mountain) value *= 0.3;
  return value;
}

export { SEA as ECOLOGY_SEA, LAND as ECOLOGY_LAND, LAKE as ECOLOGY_LAKE };

/**
 * True when the model says anything about climate, biomes, fertility, terrain shares or sea ice.
 * A world built from a picture and a model that declares none of it keeps the picture's terrain
 * classes (ADR 0056); every other geography world gets the climate and biome stage.
 */
export function geographyDeclaresEcology(geography: ResolvedGeography): boolean {
  return (
    geography.biomes.length > 0 ||
    geography.climate.declared ||
    geography.lands.some((land) => land.biome !== undefined || land.fertility !== undefined) ||
    geography.regions.some((region) => region.terrain !== undefined) ||
    geography.seas.some((sea) => sea.ice > 0)
  );
}

/** Wetness for the colour solver: soil moisture around the temperate 0.8, from -1 (dry) to 1 (wet). */
export function ecologyWetness(ecology: Ecology): Float32Array {
  const wetness = new Float32Array(ecology.moisture.length);
  for (let cell = 0; cell < wetness.length; cell += 1) {
    if (ecology.kind[cell] !== LAND) continue;
    const value = (ecology.moisture[cell]! - 0.8) / 0.8;
    wetness[cell] = value < -1 ? -1 : value > 1 ? 1 : value;
  }
  return wetness;
}
