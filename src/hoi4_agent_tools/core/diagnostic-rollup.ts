import { canonicalJson, compareCodeUnits } from './canonical.js';
import { sortDiagnostics, type Diagnostic, type SourceLocation } from './diagnostics.js';
import type { ArtifactLink } from './result.js';

const SAMPLE_LIMIT = 8;

/** Count source occurrences represented by an original diagnostic or a soft rollup. */
export function diagnosticOccurrenceCount(diagnostic: Diagnostic): number {
  const value = diagnostic.details?.occurrenceCount;
  return diagnostic.details?.rollup === 'repeated-soft-diagnostics.v1' &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : 1;
}

/** Include omission evidence emitted by bounded validators without counting their marker twice. */
export function diagnosticSeverityCounts(
  diagnostics: readonly Diagnostic[],
): Record<Diagnostic['severity'], number> {
  const counts = { info: 0, warning: 0, error: 0, blocker: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 'MAP_DIAGNOSTICS_TRUNCATED') {
      counts[diagnostic.severity] += diagnosticOccurrenceCount(diagnostic);
      continue;
    }
    const omissions = diagnostic.details?.omittedBySeverity;
    if (typeof omissions !== 'object' || omissions === null) continue;
    for (const severity of ['info', 'warning', 'error', 'blocker'] as const) {
      const value = (omissions as Record<string, unknown>)[severity];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        counts[severity] += value;
    }
  }
  return counts;
}

/** Keep every hard diagnostic; summarize repeated informational and warning codes only. */
export function rollupRepeatedSoftDiagnostics(
  diagnostics: readonly Diagnostic[],
  evidence?: ArtifactLink,
): Diagnostic[] {
  const hard: Diagnostic[] = [];
  const groups = new Map<string, Diagnostic[]>();
  const ordered = diagnostics
    .map((diagnostic) => ({ diagnostic, key: canonicalJson(diagnostic) }))
    .sort((left, right) => compareCodeUnits(left.key, right.key))
    .map(({ diagnostic }) => diagnostic);
  for (const diagnostic of ordered) {
    if (
      diagnostic.severity === 'error' ||
      diagnostic.severity === 'blocker' ||
      diagnostic.code === 'MAP_DIAGNOSTICS_TRUNCATED'
    ) {
      hard.push(diagnostic);
      continue;
    }
    const key = `${diagnostic.severity}:${diagnostic.code}`;
    const group = groups.get(key) ?? [];
    group.push(diagnostic);
    groups.set(key, group);
  }
  const soft = [...groups.values()].map((group): Diagnostic => {
    if (group.length === 1) return group[0]!;
    const first = group[0]!;
    const occurrences = group.reduce(
      (total, diagnostic) => total + diagnosticOccurrenceCount(diagnostic),
      0,
    );
    const locations = new Map<string, SourceLocation>();
    for (const diagnostic of group)
      for (const location of [diagnostic.location, ...(diagnostic.related ?? [])])
        if (location !== undefined) locations.set(canonicalJson(location), location);
    const samples = [...locations]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .slice(0, SAMPLE_LIMIT)
      .map(([, location]) => location);
    const operationIds = [
      ...new Set(
        group.flatMap(({ operationId }) => (operationId === undefined ? [] : [operationId])),
      ),
    ].sort(compareCodeUnits);
    return {
      code: first.code,
      severity: first.severity,
      category: first.category,
      message: `${occurrences} occurrences of ${first.code}; ${first.message}`.slice(0, 4096),
      ...(samples[0] === undefined ? {} : { location: samples[0] }),
      ...(samples.length < 2 ? {} : { related: samples.slice(1) }),
      ...(operationIds.length === 1 ? { operationId: operationIds[0]! } : {}),
      details: {
        rollup: 'repeated-soft-diagnostics.v1',
        occurrenceCount: occurrences,
        retainedSamples: Math.min(SAMPLE_LIMIT, group.length),
        samples: group.slice(0, SAMPLE_LIMIT),
        operationCount: operationIds.length,
        operationIds: operationIds.slice(0, SAMPLE_LIMIT),
        locationCount: locations.size,
        ...(evidence === undefined ? {} : { completeDiagnosticEvidence: evidence }),
      },
    };
  });
  return sortDiagnostics([...hard, ...soft]);
}
