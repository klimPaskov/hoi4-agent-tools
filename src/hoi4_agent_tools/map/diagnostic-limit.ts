import type { Diagnostic } from '../core/diagnostics.js';

export const MAP_DIAGNOSTIC_LIMIT = 2_000;

type DiagnosticSeverity = Diagnostic['severity'];

interface MapDiagnosticTruncationDetails extends Record<string, unknown> {
  limit: number;
  retained: number;
  omitted: number;
  omittedBySeverity: Partial<Record<DiagnosticSeverity, number>>;
  omittedByCode: Record<string, number>;
}

function isHardDiagnostic(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === 'error' || diagnostic.severity === 'blocker';
}

function isWorkspacePath(path: string): boolean {
  return path.startsWith('mod:') || path.startsWith('fixture:');
}

function isBaselineOnlyDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.location === undefined || isWorkspacePath(diagnostic.location.path)) return false;
  return !(diagnostic.related ?? []).some(({ path }) => isWorkspacePath(path));
}

function addOmittedDiagnostic(
  details: MapDiagnosticTruncationDetails,
  diagnostic: Diagnostic,
): void {
  details.omitted += 1;
  details.omittedBySeverity[diagnostic.severity] =
    (details.omittedBySeverity[diagnostic.severity] ?? 0) + 1;
  details.omittedByCode[diagnostic.code] = (details.omittedByCode[diagnostic.code] ?? 0) + 1;
}

function truncationDiagnostic(
  omitted: readonly Diagnostic[],
  limit: number,
): Diagnostic & { details: MapDiagnosticTruncationDetails } {
  const details: MapDiagnosticTruncationDetails = {
    limit,
    retained: limit - 1,
    omitted: 0,
    omittedBySeverity: {},
    omittedByCode: {},
  };
  for (const diagnostic of omitted) addOmittedDiagnostic(details, diagnostic);
  const hardOmitted = omitted.some(isHardDiagnostic);
  return {
    code: 'MAP_DIAGNOSTICS_TRUNCATED',
    severity: hardOmitted ? 'blocker' : 'info',
    category: 'map',
    message: hardOmitted
      ? 'Map diagnostic detail exceeded the result ceiling and omitted an error or blocker'
      : 'Map diagnostic detail exceeded the result ceiling; deterministic samples and omission counts were retained',
    details,
  };
}

function existingTruncationDiagnostic(
  diagnostics: Diagnostic[],
): (Diagnostic & { details: MapDiagnosticTruncationDetails }) | undefined {
  const marker = diagnostics.at(-1);
  return marker?.code === 'MAP_DIAGNOSTICS_TRUNCATED'
    ? (marker as Diagnostic & { details: MapDiagnosticTruncationDetails })
    : undefined;
}

function addBoundedDiagnostic(
  diagnostics: Diagnostic[],
  diagnostic: Diagnostic,
  includeBaseline: boolean,
  limit: number,
): void {
  if (!includeBaseline && isBaselineOnlyDiagnostic(diagnostic)) return;
  const marker = existingTruncationDiagnostic(diagnostics);
  if (marker !== undefined) {
    if (isHardDiagnostic(diagnostic)) {
      const replaceIndex = diagnostics
        .slice(0, -1)
        .findLastIndex((retained) => !isHardDiagnostic(retained));
      if (replaceIndex >= 0) {
        const replaced = diagnostics[replaceIndex]!;
        diagnostics[replaceIndex] = diagnostic;
        addOmittedDiagnostic(marker.details, replaced);
        return;
      }
      marker.severity = 'blocker';
      marker.message =
        'Map diagnostic detail exceeded the result ceiling and omitted an error or blocker';
    }
    addOmittedDiagnostic(marker.details, diagnostic);
    return;
  }
  if (diagnostics.length < limit) {
    diagnostics.push(diagnostic);
    return;
  }

  const candidates = [...diagnostics, diagnostic];
  const hard = candidates.filter(isHardDiagnostic);
  const soft = candidates.filter((candidate) => !isHardDiagnostic(candidate));
  const retained =
    hard.length >= limit - 1
      ? hard.slice(0, limit - 1)
      : [...hard, ...soft.slice(0, limit - 1 - hard.length)];
  const retainedCounts = new Map<Diagnostic, number>();
  for (const item of retained) retainedCounts.set(item, (retainedCounts.get(item) ?? 0) + 1);
  const omitted = candidates.filter((candidate) => {
    const count = retainedCounts.get(candidate) ?? 0;
    if (count === 0) return true;
    retainedCounts.set(candidate, count - 1);
    return false;
  });
  diagnostics.splice(0, diagnostics.length, ...retained, truncationDiagnostic(omitted, limit));
}

/** Add a finding, keeping at most `limit` (default {@link MAP_DIAGNOSTIC_LIMIT}) with omission counts. */
export function addMapDiagnostic(
  diagnostics: Diagnostic[],
  diagnostic: Diagnostic,
  limit = MAP_DIAGNOSTIC_LIMIT,
): void {
  addBoundedDiagnostic(diagnostics, diagnostic, false, limit);
}

/** Active topology validation must report failures in whichever source wins
 * precedence, including inherited game and dependency files. */
export function addActiveMapDiagnostic(
  diagnostics: Diagnostic[],
  diagnostic: Diagnostic,
  limit = MAP_DIAGNOSTIC_LIMIT,
): void {
  addBoundedDiagnostic(diagnostics, diagnostic, true, limit);
}

export function addMapDiagnostics(
  diagnostics: Diagnostic[],
  additions: readonly Diagnostic[],
): void {
  for (const diagnostic of additions) addMapDiagnostic(diagnostics, diagnostic);
}
