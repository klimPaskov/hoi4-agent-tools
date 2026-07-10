import type { Diagnostic } from '../diagnostics.js';

export const SOURCE_DIAGNOSTIC_LIMIT = 100;
export const SOURCE_MAX_NESTING = 256;
export const SOURCE_MAX_BYTES = 8_388_608;
export const SOURCE_TOKEN_LIMIT = 250_000;
export const SOURCE_ENTRY_LIMIT = 100_000;
export const SOURCE_LINE_LIMIT = 250_000;

/**
 * Parser ceilings that intentionally return no document or a structurally partial document.
 * Broad inventories may skip these sources, but targeted reads and rewrites must continue to
 * surface the original blocker diagnostics.
 */
export const SOURCE_PARTIAL_LIMIT_CODES = [
  'SOURCE_FILE_SIZE_LIMIT',
  'SOURCE_LINE_LIMIT',
  'SOURCE_TOKEN_LIMIT',
  'SOURCE_ENTRY_LIMIT',
  'SOURCE_NESTING_LIMIT',
  'SOURCE_DIAGNOSTICS_TRUNCATED',
] as const;

export type SourcePartialLimitCode = (typeof SOURCE_PARTIAL_LIMIT_CODES)[number];

const sourcePartialLimitCodes = new Set<string>(SOURCE_PARTIAL_LIMIT_CODES);

export function sourcePartialLimitDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(({ code }) => sourcePartialLimitCodes.has(code));
}

export class SourceDiagnosticCollector {
  readonly diagnostics: Diagnostic[] = [];
  #truncated = false;

  add(factory: () => Diagnostic): void {
    if (this.#truncated) return;
    if (this.diagnostics.length < SOURCE_DIAGNOSTIC_LIMIT) {
      this.diagnostics.push(factory());
      return;
    }

    const firstOmitted = this.diagnostics[SOURCE_DIAGNOSTIC_LIMIT - 1]!;
    this.diagnostics[SOURCE_DIAGNOSTIC_LIMIT - 1] = {
      code: 'SOURCE_DIAGNOSTICS_TRUNCATED',
      severity: 'blocker',
      category: 'syntax',
      message: `Source diagnostics exceeded the per-file limit of ${SOURCE_DIAGNOSTIC_LIMIT}; remaining diagnostics were omitted`,
      ...(firstOmitted.location === undefined ? {} : { location: firstOmitted.location }),
      details: {
        limit: SOURCE_DIAGNOSTIC_LIMIT,
        retained: SOURCE_DIAGNOSTIC_LIMIT - 1,
      },
    };
    this.#truncated = true;
  }
}
