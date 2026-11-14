import path from 'node:path';
import {
  planManagedOutputs,
  refreshManagedOutputs,
  type ManagedOutputPlan,
  type ManagedOutputRefresh,
} from '../core/managed-outputs.js';
import type { ScannedFile } from '../core/scanner.js';
import type { ProposedFileChange } from '../core/transactions.js';

export const WORLD_OUTPUT_MANIFEST = '.hoi4-agent-world.json';

export interface WorldOutputOptions {
  /** The workspace owns the countries: edited recorded country outputs pass to it (ADR 0069). */
  releaseCountryOutputs?: boolean;
}

/** Country outputs of a generated world: tags, country files, histories, units, flags, bookmark. */
export function isWorldCountryOutput(relativePath: string): boolean {
  const dir = path.posix.dirname(relativePath),
    file = path.posix.basename(relativePath);
  return (
    (['common/countries', 'history/countries'].includes(dir) &&
      /^[A-Z][A-Z0-9]{2} - [^/]+\.txt$/u.test(file)) ||
    (dir === 'history/units' && /^[A-Z][A-Z0-9]{2}_world\.txt$/u.test(file)) ||
    (['gfx/flags', 'gfx/flags/medium', 'gfx/flags/small'].includes(dir) &&
      /^[A-Z][A-Z0-9]{2}\.tga$/u.test(file)) ||
    [
      'common/countries/colors.txt',
      'common/country_tags/zz_world_countries.txt',
      'common/bookmarks/world.txt',
    ].includes(relativePath)
  );
}

export function reconcileWorldOutputs(
  sources: readonly ScannedFile[],
  proposed: readonly ProposedFileChange[],
  operationId: string,
  mapRoot: string,
  stateRoots: readonly string[],
  localisationRoots: readonly string[],
): ProposedFileChange[] {
  return planWorldOutputs(sources, proposed, operationId, mapRoot, stateRoots, localisationRoots)
    .changes;
}

/**
 * The world inventory brought up to date with the bytes a request leaves behind: every recorded
 * output the request writes gets its new hash, or with `adoptAll` every recorded output its
 * current bytes (`record_world_outputs`). Undefined when the workspace has no world inventory.
 */
export function refreshWorldOutputs(
  sources: readonly ScannedFile[],
  proposed: readonly ProposedFileChange[],
  roots: WorldOutputRoots,
  options: { adoptAll?: boolean; adoptUnrecorded?: boolean } = {},
): ManagedOutputRefresh | undefined {
  const permits = worldOutputPermits(roots);
  return refreshManagedOutputs({
    manifestPath: WORLD_OUTPUT_MANIFEST,
    sources,
    proposed,
    // New files join the record where the world keeps its map outputs; country files stay out,
    // since a workspace may own its countries (ADR 0069).
    addable: (name) => permits(name) && !isWorldCountryOutput(name),
    // States and strategic regions are in every map scan; bitmaps, colour maps and the world
    // scripts only in some, so only the first can be known to be gone.
    alwaysScanned: (name) => {
      const dir = path.posix.dirname(name);
      return roots.stateRoots.includes(dir) || dir === `${roots.mapRoot}/strategicregions`;
    },
    ...(options.adoptAll === true ? { adoptAll: true } : {}),
    ...(options.adoptUnrecorded === true ? { adoptUnrecorded: true } : {}),
  });
}

/** Where a world's outputs live: the map folder and the state and localisation roots. */
export interface WorldOutputRoots {
  mapRoot: string;
  stateRoots: readonly string[];
  localisationRoots: readonly string[];
}

const WORLD_MAP_FILES = new Set([
  'provinces.bmp',
  'definition.csv',
  'default.map',
  'continent.txt',
  'adjacencies.csv',
  'adjacency_rules.txt',
  'positions.txt',
  'ambient_object.txt',
  'heightmap.bmp',
  'terrain.bmp',
  'rivers.bmp',
  'trees.bmp',
  'cities.bmp',
  'world_normal.bmp',
  'buildings.txt',
  'unitstacks.txt',
  'weatherpositions.txt',
  'supply_nodes.txt',
  'railways.txt',
]);

/** The paths a generated world records as its outputs. */
export function worldOutputPermits({
  mapRoot,
  stateRoots,
  localisationRoots,
}: WorldOutputRoots): (name: string) => boolean {
  return (name: string): boolean => {
    const dir = path.posix.dirname(name),
      file = path.posix.basename(name);
    return (
      (dir === mapRoot && WORLD_MAP_FILES.has(file)) ||
      (dir === `${mapRoot}/terrain` && /^colormap_[a-z0-9_]+\.dds$/u.test(file)) ||
      (dir === `${mapRoot}/strategicregions` && /^\d+.*\.txt$/u.test(file)) ||
      (stateRoots.includes(dir) && /^\d+.*\.txt$/u.test(file)) ||
      isWorldCountryOutput(name) ||
      [
        'common/on_actions/world.txt',
        'common/ai_areas/world.txt',
        'common/ai_strategy_plans/world.txt',
      ].includes(name) ||
      localisationRoots.some(
        (root) =>
          name === `${root}/english/world_l_english.yml` ||
          name === `${root}/replace/world_l_english.yml`,
      )
    );
  };
}

export function planWorldOutputs(
  sources: readonly ScannedFile[],
  proposed: readonly ProposedFileChange[],
  operationId: string,
  mapRoot: string,
  stateRoots: readonly string[],
  localisationRoots: readonly string[],
  options: WorldOutputOptions = {},
): ManagedOutputPlan {
  const permitsPath = worldOutputPermits({ mapRoot, stateRoots, localisationRoots });
  return planManagedOutputs({
    manifestPath: WORLD_OUTPUT_MANIFEST,
    sources,
    proposed,
    operationId,
    permitsPath,
    ...(options.releaseCountryOutputs === true ? { releasable: isWorldCountryOutput } : {}),
  });
}
