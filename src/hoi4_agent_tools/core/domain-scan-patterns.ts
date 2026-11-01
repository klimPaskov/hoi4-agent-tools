import { compareCodeUnits } from './canonical.js';
import type { ResolvedWorkspace } from './workspace.js';
import { ServiceError } from './result.js';

function under(roots: readonly string[], glob: string): string[] {
  return roots.map((root) => `${root.replaceAll('\\', '/').replace(/\/$/u, '')}/${glob}`);
}

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)].sort(compareCodeUnits);
}

function englishLocalisationPatterns(roots: readonly string[]): string[] {
  return [...under(roots, 'english/**/*.{yml,yaml}'), ...under(roots, '*.{yml,yaml}')];
}

export function probabilitySharedDefinitionPatterns(): string[] {
  return uniquePatterns([
    'common/scripted_effects/**/*.txt',
    'common/scripted_triggers/**/*.txt',
    'common/script_constants/**/*.txt',
    'common/mtth/**/*.txt',
  ]);
}

/** Sources required to import, link, lint, render, and rewrite focus content. */
export function focusDomainScanPatterns(workspace: ResolvedWorkspace): string[] {
  const roots = workspace.registration.roots;
  return uniquePatterns([
    ...under(roots.focus, '**/*.txt'),
    ...under(roots.focus, '**/*.focus-plan.json'),
    'common/continuous_focus/**/*.txt',
    'common/decisions/**/*.txt',
    'common/ideas/**/*.txt',
    'common/characters/**/*.txt',
    'common/scripted_effects/**/*.txt',
    'common/scripted_triggers/**/*.txt',
    'common/script_constants/**/*.txt',
    'common/mtth/**/*.txt',
    'events/**/*.txt',
    ...under(roots.interface, '**/*.gfx'),
    ...under(roots.gfx, '**/*.gfx'),
    ...englishLocalisationPatterns(roots.localisation),
  ]);
}

/** Weighted source surfaces and shared definitions used by probability analysis. */
export function probabilityDomainScanPatterns(
  workspace: ResolvedWorkspace,
  sourcePaths: readonly string[] = [],
): string[] {
  const roots = workspace.registration.roots;
  const normalizedSourcePaths = sourcePaths.map((sourcePath) => {
    const normalized = sourcePath.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (
      normalized.startsWith('/') ||
      normalized.split('/').includes('..') ||
      /[:*?[\]{}!\0]/u.test(normalized)
    )
      throw new ServiceError(
        'PROBABILITY_SOURCE_PATH_INVALID',
        'Probability source paths must be exact workspace-relative files',
      );
    return normalized;
  });
  if (normalizedSourcePaths.length > 0)
    return uniquePatterns([...normalizedSourcePaths, ...probabilitySharedDefinitionPatterns()]);
  return uniquePatterns([
    ...under(roots.focus, '**/*.txt'),
    'common/decisions/**/*.txt',
    'common/technologies/**/*.txt',
    'common/doctrines/**/*.txt',
    'common/ai_strategy/**/*.txt',
    'common/ai_strategy_plans/**/*.txt',
    'common/ai_focuses/**/*.txt',
    'common/on_actions/**/*.txt',
    'common/scripted_effects/**/*.txt',
    'common/scripted_triggers/**/*.txt',
    'common/script_constants/**/*.txt',
    'common/mtth/**/*.txt',
    'events/**/*.txt',
  ]);
}

/** Text sources needed to discover country flags and leader portraits. */
export function countryAssetDiscoveryPatterns(workspace: ResolvedWorkspace): string[] {
  const roots = workspace.registration.roots;
  return uniquePatterns([
    'history/countries/**/*.txt',
    'common/characters/**/*.txt',
    'common/scripted_effects/**/*.txt',
    'events/**/*.txt',
    ...under(roots.interface, '**/*.gfx'),
    ...under(roots.gfx, '**/*.gfx'),
  ]);
}

/**
 * The changed files of a map rewrite plus the province definitions they refer to. A state file
 * lists provinces that `map/definition.csv` defines, usually in the base game, so a scan of the
 * changed files alone would report every listed province as unresolved.
 */
/** Bitmaps, textures and flags carry no script to parse; the map validation reads the ones it needs. */
const BINARY_EXTENSION = /\.(?:bmp|dds|tga|png|jpg|jpeg|gif|wav|ogg|mp3|ttf|otf)$/iu;

/**
 * What the check after a map write reads: the changed text files, without the large binary files of
 * a world (a 5120 x 2560 world is 150 MB of bitmaps and textures, 270 MB with the base game's files
 * of the same names, past the default scan limit). The map validation that follows reads the
 * bitmaps it needs itself.
 */
export function mapChangeScanPatterns(relativePaths: readonly string[]): string[] {
  return uniquePatterns([
    ...exactChangedFilePatterns(relativePaths.filter((path) => !BINARY_EXTENSION.test(path))),
    'map/default.map',
    'map/*.csv',
  ]);
}

export function exactChangedFilePatterns(relativePaths: readonly string[]): string[] {
  return uniquePatterns(
    relativePaths.map((relativePath) => relativePath.replaceAll('\\', '/').replace(/^\.\//u, '')),
  );
}
