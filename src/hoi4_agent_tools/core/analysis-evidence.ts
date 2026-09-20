import { boundedSourceHashEvidence } from './artifacts.js';
import type { ScanSnapshot } from './engine.js';

/** Bind a linked analysis report to every source in both compared revisions. */
export function analysisSourceEvidence(
  before: ScanSnapshot,
  after?: ScanSnapshot,
  additionalSources: Record<string, string> = {},
) {
  return boundedSourceHashEvidence(
    Object.fromEntries([
      ...before.files.map((file) => [`before:${file.displayPath}`, file.sha256] as const),
      ...(after?.files.map((file) => [`after:${file.displayPath}`, file.sha256] as const) ?? []),
      ...Object.entries(additionalSources),
    ]),
  );
}
