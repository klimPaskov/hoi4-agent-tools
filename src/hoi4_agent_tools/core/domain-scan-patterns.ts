import { compareCodeUnits } from './canonical.js';
import type { ResolvedWorkspace } from './workspace.js';

function under(roots: readonly string[], glob: string): string[] {
  return roots.map((root) => `${root.replaceAll('\\', '/').replace(/\/$/u, '')}/${glob}`);
}

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)].sort(compareCodeUnits);
}

function englishLocalisationPatterns(roots: readonly string[]): string[] {
  return [...under(roots, 'english/**/*.{yml,yaml}'), ...under(roots, '*.{yml,yaml}')];
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
  const normalizedSourcePaths = sourcePaths.map((sourcePath) =>
    sourcePath.replace(/^.*?:/u, '').replaceAll('\\', '/').replace(/^\.\//u, ''),
  );
  return uniquePatterns([
    ...normalizedSourcePaths,
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

export function exactChangedFilePatterns(relativePaths: readonly string[]): string[] {
  return uniquePatterns(
    relativePaths.map((relativePath) => relativePath.replaceAll('\\', '/').replace(/^\.\//u, '')),
  );
}
