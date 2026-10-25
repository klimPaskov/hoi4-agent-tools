import path from 'node:path';
import { planManagedOutputs, type ManagedOutputPlan } from '../core/managed-outputs.js';
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

export function planWorldOutputs(
  sources: readonly ScannedFile[],
  proposed: readonly ProposedFileChange[],
  operationId: string,
  mapRoot: string,
  stateRoots: readonly string[],
  localisationRoots: readonly string[],
  options: WorldOutputOptions = {},
): ManagedOutputPlan {
  const mapFiles = new Set([
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
  const permitsPath = (name: string): boolean => {
    const dir = path.posix.dirname(name),
      file = path.posix.basename(name);
    return (
      (dir === mapRoot && mapFiles.has(file)) ||
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
  return planManagedOutputs({
    manifestPath: WORLD_OUTPUT_MANIFEST,
    sources,
    proposed,
    operationId,
    permitsPath,
    ...(options.releaseCountryOutputs === true ? { releasable: isWorldCountryOutput } : {}),
  });
}
