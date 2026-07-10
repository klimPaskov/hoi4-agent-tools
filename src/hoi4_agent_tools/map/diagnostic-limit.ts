import type { Diagnostic } from '../core/diagnostics.js';

export const MAP_DIAGNOSTIC_LIMIT = 2_000;

export function addMapDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
  if (diagnostics.at(-1)?.code === 'MAP_DIAGNOSTICS_TRUNCATED') return;
  if (diagnostics.length < MAP_DIAGNOSTIC_LIMIT) {
    diagnostics.push(diagnostic);
    return;
  }
  diagnostics[MAP_DIAGNOSTIC_LIMIT - 1] = {
    code: 'MAP_DIAGNOSTICS_TRUNCATED',
    severity: 'blocker',
    category: 'map',
    message: 'Map diagnostics exceeded the configured output limit',
    details: { limit: MAP_DIAGNOSTIC_LIMIT, retained: MAP_DIAGNOSTIC_LIMIT - 1 },
  };
}

export function addMapDiagnostics(
  diagnostics: Diagnostic[],
  additions: readonly Diagnostic[],
): void {
  for (const diagnostic of additions) addMapDiagnostic(diagnostics, diagnostic);
}
