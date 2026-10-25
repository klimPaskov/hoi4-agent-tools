import { compareCodeUnits } from '../core/canonical.js';
import { hasBlockingDiagnostics } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import type { ScannedFile } from '../core/scanner.js';
import { assignments, childBlocks, firstScalar, parseClausewitz } from '../core/source/index.js';
import { BmpImage } from './bmp.js';
import type { MapWorkspaceIndex } from './model.js';
import type { WorldContext } from './world.js';

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function invalid(file: ScannedFile, message: string): never {
  throw new ServiceError('MAP_WORLD_CONTEXT_INVALID', message, { file: file.displayPath });
}

function documentFor(file: ScannedFile) {
  const document = parseClausewitz(file.bytes, file.displayPath);
  if (hasBlockingDiagnostics(document.diagnostics))
    invalid(file, 'Installed world conventions contain malformed Clausewitz syntax.');
  return document;
}

/**
 * Build conventions exclusively from authorized, already-scanned active sources. Missing
 * conventions retain the generator's defaults; present but invalid conventions are refused.
 * Source bitmap bytes and script files are never modified or copied into generated mod files.
 */
export function buildWorldContext(base: MapWorkspaceIndex): WorldContext {
  const context: WorldContext = {
    palettes: {},
    mapRoot: base.sourceRoots.map[0] ?? 'map',
    statesRoot: base.sourceRoots.states[0] ?? 'history/states',
    localisationRoot: base.sourceRoots.localisation[0] ?? 'localisation',
  };
  const continentKeys = new Set<string>();
  for (const file of base.sourceFiles.filter((file) =>
    base.sourceRoots.map.some(
      (root) => normalized(file.relativePath) === normalized(`${root}/continent.txt`),
    ),
  )) {
    for (const block of childBlocks(documentFor(file).root, 'continents')) {
      for (const entry of block.entries) {
        if (entry.type !== 'scalar' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(entry.value))
          invalid(file, 'Continent identifiers must be simple scalar keys.');
        continentKeys.add(entry.value);
      }
    }
  }
  if (continentKeys.size) context.continentKeys = [...continentKeys].sort(compareCodeUnits);
  const inheritedCountryTags = new Set<string>();
  for (const file of base.activeFiles.all.filter((file) =>
    /^common\/country_tags\/[^/]+\.txt$/u.test(normalized(file.relativePath)),
  ))
    for (const entry of assignments(documentFor(file).root))
      if (/^[A-Z][A-Z0-9]{2}$/u.test(entry.key.value) && entry.value.type === 'scalar')
        inheritedCountryTags.add(entry.key.value);
  if (inheritedCountryTags.size)
    context.inheritedCountryTags = [...inheritedCountryTags].sort(compareCodeUnits);
  for (const name of ['terrain', 'rivers', 'trees', 'cities'] as const) {
    const file = base.sourceRoots.map
      .map((root) => base.activeFiles.byRelativePath.get(normalized(`${root}/${name}.bmp`)))
      .find((entry) => entry !== undefined);
    if (file === undefined) continue;
    let bitmap: BmpImage;
    try {
      bitmap = BmpImage.decode(file.bytes);
    } catch {
      invalid(file, `The installed ${name} bitmap is malformed or unsupported.`);
    }
    const minimumEntries = { terrain: 22, rivers: 256, trees: 30, cities: 16 }[name];
    if (bitmap.bitsPerPixel !== 8 || bitmap.palette.length < minimumEntries)
      invalid(
        file,
        `The installed ${name} bitmap requires an 8-bit palette with at least ${minimumEntries} entries.`,
      );
    context.palettes[name] = bitmap.palette.map((color) => ({ ...color }));
  }

  const terrainFiles = base.activeFiles.all
    .filter((file) => /^common\/terrain\/[^/]+\.txt$/u.test(normalized(file.relativePath)))
    .sort((a, b) => compareCodeUnits(normalized(a.relativePath), normalized(b.relativePath)));
  const terrainIndex = new Map<string, number>();
  const unrendered: Array<{ name: string; index: number; type: string; reason: string }> = [];
  const entries: Array<{
    name: string;
    index: number;
    type: string;
    texture?: number;
    permSnow: boolean;
  }> = [];
  for (const file of terrainFiles) {
    const candidates = new Map<string, { index: number; rank: number }>();
    const terrain = assignments(documentFor(file).root, 'terrain');
    for (const section of terrain)
      if (section.value.type !== 'block')
        invalid(file, 'Graphical terrain sections must be blocks.');
    for (const { value: block } of terrain) {
      if (block.type !== 'block') continue;
      if (block.entries.some((entry) => entry.type !== 'assignment'))
        invalid(file, 'Graphical terrain sections require named entries.');
      for (const entry of assignments(block)) {
        if (entry.value.type !== 'block')
          invalid(file, 'Graphical terrain entries must be blocks.');
        const type = firstScalar(entry.value, 'type')?.value;
        const colors = childBlocks(entry.value, 'color');
        if (
          type === undefined ||
          type.length === 0 ||
          assignments(entry.value, 'type').length !== 1 ||
          assignments(entry.value, 'color').length !== 1 ||
          colors.length !== 1 ||
          colors[0]!.entries.length === 0
        )
          invalid(file, 'Graphical terrain requires a type and a nonempty color-index block.');
        let index = 256;
        for (const color of colors[0]!.entries) {
          if (color.type !== 'scalar' || !/^\d+$/u.test(color.value))
            invalid(file, 'Graphical terrain colors must be integer palette indices.');
          const value = Number(color.value);
          if (!Number.isSafeInteger(value) || value > 255)
            invalid(file, 'Graphical terrain palette indices must be between 0 and 255.');
          if (context.palettes.terrain !== undefined && value >= context.palettes.terrain.length)
            invalid(file, 'Graphical terrain refers to a missing terrain palette entry.');
          index = Math.min(index, value);
        }
        const name = entry.key.value;
        const textureValue = firstScalar(entry.value, 'texture')?.value;
        entries.push({
          name,
          index,
          type,
          ...(textureValue !== undefined && /^\d+$/u.test(textureValue)
            ? { texture: Number(textureValue) }
            : {}),
          permSnow: firstScalar(entry.value, 'perm_snow')?.value === 'yes',
        });
        // Texture 255 names no atlas tile: the engine draws nothing useful for that index, so it
        // is never chosen to represent a category (the base game's `lakes` entry is one).
        if (firstScalar(entry.value, 'texture')?.value === '255') {
          unrendered.push({ name, index, type, reason: 'texture = 255 selects no atlas tile' });
          continue;
        }
        // Prefer ordinary category variants over cross-category names or permanent snow.
        // Within an equal rank, the lowest declared index is the stable representative.
        let rank =
          name === type ? 0 : name.startsWith(`${type}_`) || /^terrain_\d+$/u.test(name) ? 1 : 2;
        if (firstScalar(entry.value, 'perm_snow')?.value === 'yes') rank += 4;
        const previous = candidates.get(type);
        if (
          previous === undefined ||
          rank < previous.rank ||
          (rank === previous.rank && index < previous.index)
        )
          candidates.set(type, { index, rank });
      }
    }
    // Later active filenames replace an earlier file's representative for that category.
    for (const [type, candidate] of candidates) terrainIndex.set(type, candidate.index);
  }
  if (entries.length > 0)
    context.terrainEntries = entries.sort(
      (a, b) => a.index - b.index || compareCodeUnits(a.name, b.name),
    );
  const gaps = unrendered.filter(({ type }) => !terrainIndex.has(type));
  if (gaps.length > 0) context.unrenderedTerrain = gaps;
  if (terrainIndex.size > 0)
    context.terrainIndex = new Map([...terrainIndex].sort(([a], [b]) => compareCodeUnits(a, b)));

  const categoryFiles = base.activeFiles.all
    .filter((file) => /^common\/state_category\/[^/]+\.txt$/u.test(normalized(file.relativePath)))
    .sort((a, b) => compareCodeUnits(normalized(a.relativePath), normalized(b.relativePath)));
  if (categoryFiles.length > 0) {
    const categories = new Set<string>();
    for (const file of categoryFiles) {
      const blocks = childBlocks(documentFor(file).root, 'state_categories');
      if (blocks.length === 0)
        invalid(file, 'State category conventions require a state_categories block.');
      for (const block of blocks) {
        if (block.entries.some((entry) => entry.type !== 'assignment'))
          invalid(file, 'State category conventions require named entries.');
        for (const entry of assignments(block)) {
          if (entry.value.type !== 'block')
            invalid(file, 'State category definitions must be blocks.');
          categories.add(entry.key.value);
        }
      }
    }
    if (categories.size === 0)
      invalid(categoryFiles[0]!, 'Installed state category conventions define no categories.');
    context.stateCategories = new Set([...categories].sort(compareCodeUnits));
  }
  return context;
}

/** The tag file a generated world writes for the countries it creates. */
export const WORLD_COUNTRY_TAG_FILE = 'common/country_tags/zz_world_countries.txt';

export interface CountryTagCatalog {
  /** Tags declared by active tag files other than the world's own, sorted. */
  static: string[];
  /** Tags declared by active tag files marked `dynamic_tags = yes`, sorted. */
  dynamic: string[];
}

/** Country tags the active sources declare, apart from those of a previously generated world. */
export function countryTagCatalog(base: MapWorkspaceIndex): CountryTagCatalog {
  const declared = new Set<string>();
  const dynamic = new Set<string>();
  for (const file of base.activeFiles.all) {
    const name = normalized(file.relativePath);
    if (!/^common\/country_tags\/[^/]+\.txt$/u.test(name) || name === WORLD_COUNTRY_TAG_FILE)
      continue;
    const entries = assignments(documentFor(file).root);
    const isDynamic = entries.some(
      (entry) =>
        entry.key.value === 'dynamic_tags' &&
        entry.value.type === 'scalar' &&
        entry.value.value === 'yes',
    );
    for (const entry of entries)
      if (/^[A-Z][A-Z0-9]{2}$/u.test(entry.key.value) && entry.value.type === 'scalar')
        (isDynamic ? dynamic : declared).add(entry.key.value);
  }
  return {
    static: [...declared].sort(compareCodeUnits),
    dynamic: [...dynamic].filter((tag) => !declared.has(tag)).sort(compareCodeUnits),
  };
}
