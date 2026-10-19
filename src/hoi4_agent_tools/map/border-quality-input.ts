import { compareCodeUnits } from '../core/canonical.js';
import { ServiceError } from '../core/result.js';
import { assignments, childBlocks, firstScalar, parseClausewitz } from '../core/source/index.js';
import { BmpImage } from './bmp.js';
import {
  BORDER_PROVINCE_KIND,
  borderPlaneFromBmp,
  measureBorderNaturalness,
  type BorderFeaturePlanes,
  type BorderLayerInput,
  type BorderPlane,
  type BorderQualityInput,
  type BorderQualityOptions,
  type BorderQualityReport,
  type BorderQualityResult,
  type BorderTerrainPlane,
} from './border-quality.js';
import type { MapWorkspaceIndex } from './model.js';

/** Terrain types whose boundaries count as natural lines when the terrain bitmap changes class. */
export const BORDER_OBSTACLE_TERRAIN_TYPES = ['mountain', 'forest', 'jungle', 'marsh'] as const;

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

export interface BorderQualityIndexInput {
  input: BorderQualityInput;
  /** Inputs that could not be used, with the reason, for example a bitmap of the wrong size. */
  skipped: { input: string; reason: string }[];
}

function planeFromFile(
  index: MapWorkspaceIndex,
  name: string,
  file: { bytes: Buffer } | undefined,
  skipped: BorderQualityIndexInput['skipped'],
): BorderPlane | undefined {
  if (file === undefined) return undefined;
  const raster = index.raster!;
  let image: BmpImage;
  try {
    image = BmpImage.decode(file.bytes);
  } catch {
    skipped.push({ input: name, reason: 'The bitmap is malformed or unsupported' });
    return undefined;
  }
  if (image.bitsPerPixel !== 8) {
    skipped.push({ input: name, reason: 'The bitmap is not 8-bit indexed' });
    return undefined;
  }
  if (image.width !== raster.width || image.height !== raster.height) {
    skipped.push({
      input: name,
      reason: `The bitmap is ${image.width}x${image.height}, not the province map size`,
    });
    return undefined;
  }
  return borderPlaneFromBmp(image);
}

/**
 * Class of each terrain bitmap index from the active `common/terrain` graphical entries: an
 * obstacle terrain type gets its own class, water is ignored, everything else is open ground.
 */
export function terrainClassTable(index: MapWorkspaceIndex): Uint8Array {
  const classes = new Uint8Array(256);
  const files = index.activeFiles.all
    .filter((file) => /^common\/terrain\/[^/]+\.txt$/u.test(normalized(file.relativePath)))
    .sort((a, b) => compareCodeUnits(normalized(a.relativePath), normalized(b.relativePath)));
  const typeOfIndex = new Map<number, string>();
  for (const file of files) {
    const document = parseClausewitz(file.bytes, file.displayPath);
    for (const section of assignments(document.root, 'terrain')) {
      if (section.value.type !== 'block') continue;
      for (const entry of assignments(section.value)) {
        if (entry.value.type !== 'block') continue;
        const type = firstScalar(entry.value, 'type')?.value;
        if (type === undefined) continue;
        for (const color of childBlocks(entry.value, 'color'))
          for (const value of color.entries)
            if (value.type === 'scalar' && /^\d+$/u.test(value.value)) {
              const paletteIndex = Number(value.value);
              if (paletteIndex < 256) typeOfIndex.set(paletteIndex, type);
            }
      }
    }
  }
  for (const [paletteIndex, type] of typeOfIndex) {
    const obstacle = (BORDER_OBSTACLE_TERRAIN_TYPES as readonly string[]).indexOf(type);
    classes[paletteIndex] =
      obstacle >= 0 ? obstacle + 1 : index.terrainCategories?.get(type)?.water === true ? 255 : 0;
  }
  return classes;
}

function labelsFor(
  index: MapWorkspaceIndex,
  kinds: Uint8Array,
  label: (provinceId: number) => number,
): Int32Array {
  const labels = new Int32Array(kinds.length).fill(-1);
  for (let id = 0; id < kinds.length; id += 1)
    if (kinds[id] === BORDER_PROVINCE_KIND.land) labels[id] = label(id);
  void index;
  return labels;
}

/**
 * Build the border quality input from a scanned map: the province raster, province kinds, the
 * province, state, strategic-region and country groupings the workspace defines, and the height,
 * river and terrain bitmaps when they are present and the size of the province map.
 */
export function borderQualityInputFromIndex(index: MapWorkspaceIndex): BorderQualityIndexInput {
  const raster = index.raster;
  if (raster === undefined)
    throw new ServiceError(
      'MAP_BORDER_QUALITY_RASTER_MISSING',
      'Border naturalness needs a valid province bitmap and definitions',
    );
  const skipped: BorderQualityIndexInput['skipped'] = [];
  let highest = 0;
  for (const definition of index.definitions) highest = Math.max(highest, definition.id);
  const kinds = new Uint8Array(highest + 1);
  for (const definition of index.definitions) {
    if (!Number.isInteger(definition.id) || definition.id < 0) continue;
    kinds[definition.id] =
      definition.type === 'land'
        ? BORDER_PROVINCE_KIND.land
        : definition.type === 'sea'
          ? BORDER_PROVINCE_KIND.sea
          : definition.type === 'lake'
            ? BORDER_PROVINCE_KIND.lake
            : BORDER_PROVINCE_KIND.unknown;
  }
  kinds[0] = BORDER_PROVINCE_KIND.unknown;
  const layers: BorderLayerInput[] = [
    { name: 'province', labels: labelsFor(index, kinds, (id) => id) },
  ];
  const stateLabels = labelsFor(index, kinds, (id) => {
    const states = index.stateForProvince(id);
    return states.length === 1 ? states[0]!.id : -1;
  });
  if (stateLabels.some((label) => label >= 0)) layers.push({ name: 'state', labels: stateLabels });
  const regionLabels = labelsFor(index, kinds, (id) => {
    const regions = index.regionForProvince(id);
    return regions.length === 1 ? regions[0]!.id : -1;
  });
  if (regionLabels.some((label) => label >= 0))
    layers.push({ name: 'region', labels: regionLabels });
  const owners = [
    ...new Set(index.states.flatMap(({ owner }) => (owner === undefined ? [] : [owner]))),
  ].sort(compareCodeUnits);
  const ownerIndex = new Map(owners.map((tag, position) => [tag, position]));
  const countryLabels = labelsFor(index, kinds, (id) => {
    const states = index.stateForProvince(id);
    const owner = states.length === 1 ? states[0]!.owner : undefined;
    return owner === undefined ? -1 : (ownerIndex.get(owner) ?? -1);
  });
  if (countryLabels.some((label) => label >= 0))
    layers.push({
      name: 'country',
      labels: countryLabels,
      describe: (label) => owners[label] ?? String(label),
    });
  const features: BorderFeaturePlanes = {};
  const heights = planeFromFile(index, 'heightmap', index.heightmapFile, skipped);
  if (heights !== undefined) features.heights = heights;
  else if (index.heightmapFile === undefined)
    skipped.push({ input: 'heightmap', reason: 'No heightmap was scanned' });
  const rivers = planeFromFile(index, 'rivers', index.riversFile, skipped);
  if (rivers !== undefined) features.rivers = rivers;
  else if (index.riversFile === undefined)
    skipped.push({ input: 'rivers', reason: 'No rivers bitmap was scanned' });
  const terrainPlane = planeFromFile(index, 'terrain', index.terrainBitmapFile, skipped);
  if (terrainPlane !== undefined) {
    const terrain: BorderTerrainPlane = {
      plane: terrainPlane,
      classes: terrainClassTable(index),
    };
    features.terrain = terrain;
  } else if (index.terrainBitmapFile === undefined)
    skipped.push({ input: 'terrain', reason: 'No terrain bitmap was scanned' });
  return {
    input: {
      width: raster.width,
      height: raster.height,
      provinceIds: raster.provinceIds,
      provinceKinds: kinds,
      layers,
      features,
    },
    skipped,
  };
}

/** Measure the borders of a scanned map workspace. */
export async function measureIndexBorderNaturalness(
  index: MapWorkspaceIndex,
  options: BorderQualityOptions = {},
): Promise<BorderQualityResult & { skipped: BorderQualityIndexInput['skipped'] }> {
  const { input, skipped } = borderQualityInputFromIndex(index);
  const result = await measureBorderNaturalness(input, options);
  return { ...result, skipped };
}

/** Compact, schema-stable summary of a border quality report for inline tool results. */
export interface BorderQualitySummary {
  inputs: BorderQualityReport['inputs'];
  skippedInputs: { input: string; reason: string }[];
  layers: {
    layer: string;
    status: string;
    groups: number;
    borderEdges: number;
    coastEdges: number;
    alignment: number | null;
    baseRate: number;
    enrichment: number | null;
    naturalShare: number | null;
    naturalShareWithCoast: number | null;
    straightFraction: number | null;
    longRunShare: number | null;
    artificialRuns: number;
    longestArtificialRunEdges: number;
    worstRuns: {
      sides: [string, string];
      from: { x: number; y: number };
      to: { x: number; y: number };
      edges: number;
      chord: number;
    }[];
  }[];
}

export const BORDER_QUALITY_INLINE_RUNS = 3;

export function summarizeBorderQuality(
  report: BorderQualityReport,
  skipped: BorderQualityIndexInput['skipped'],
): BorderQualitySummary {
  return {
    inputs: report.inputs,
    skippedInputs: skipped,
    layers: report.layers.map((layer) => ({
      layer: layer.layer,
      status: layer.status,
      groups: layer.groups,
      borderEdges: layer.borderEdges,
      coastEdges: layer.coastEdges,
      alignment: layer.barrier.alignment,
      baseRate: layer.barrier.baseRate,
      enrichment: layer.barrier.enrichment,
      naturalShare: layer.natural.share,
      naturalShareWithCoast: layer.natural.shareWithCoast,
      straightFraction: layer.straightness.fraction,
      longRunShare: layer.longRuns.share,
      artificialRuns: layer.artificialRuns.count,
      longestArtificialRunEdges: layer.artificialRuns.longestEdges,
      worstRuns: layer.worstRuns
        .slice(0, BORDER_QUALITY_INLINE_RUNS)
        .map(({ sides, from, to, edges, chord }) => ({
          sides: [sides[0].slice(0, 64), sides[1].slice(0, 64)] as [string, string],
          from,
          to,
          edges,
          chord,
        })),
    })),
  };
}
