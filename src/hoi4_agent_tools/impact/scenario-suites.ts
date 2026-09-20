import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareCodeUnits, sha256Bytes } from '../core/canonical.js';
import type { ImpactGraphResult, ImpactSymbolSelector } from '../core/impact-graph.js';
import { ServiceError } from '../core/result.js';
import { canonicalPath, isWithin, type ResolvedWorkspace } from '../core/workspace.js';
import { impactScenarioSuiteReferenceSchema } from '../schemas/analysis.js';

export interface ImpactSuiteReferenceResult {
  matches: Array<{
    suitePath: string;
    suiteId: string;
    caseId: string;
    via: string[];
  }>;
  sourceHashes: Record<string, string>;
  unresolved: Array<{ path: string; reason: string }>;
  scannedSuites: number;
  scannedCases: number;
  omittedMatches: number;
  complete: boolean;
}

function selectorKey(selector: ImpactSymbolSelector): string {
  return `${selector.kind}:${selector.id}`;
}

/** Read bounded workspace-owned suite references without executing any case or assertion. */
export async function inspectImpactScenarioSuites(
  workspace: ResolvedWorkspace,
  paths: readonly string[],
  graph: ImpactGraphResult,
  selected: readonly ImpactSymbolSelector[],
  signal?: AbortSignal,
): Promise<ImpactSuiteReferenceResult> {
  const result: ImpactSuiteReferenceResult = {
    matches: [],
    sourceHashes: {},
    unresolved: [],
    scannedSuites: 0,
    scannedCases: 0,
    omittedMatches: 0,
    complete: true,
  };
  const relevantSymbols = new Set([
    ...selected.map(selectorKey),
    ...graph.directConsumers.map(({ source }) => selectorKey(source)),
    ...graph.transitiveConsumers.map(({ source }) => selectorKey(source)),
  ]);
  const relevantFiles = new Set(graph.affectedFiles);
  for (const relativePath of [...new Set(paths)].sort(compareCodeUnits)) {
    signal?.throwIfAborted();
    const candidate = await canonicalPath(path.join(workspace.modRoot, relativePath), signal);
    if (!isWithin(workspace.modRoot, candidate))
      throw new ServiceError(
        'IMPACT_SUITE_OUTSIDE_WORKSPACE',
        'Scenario suite resolves outside the authorized mod root',
        {
          relativePath,
        },
      );
    try {
      const details = await stat(candidate);
      if (!details.isFile() || details.size > 4 * 1024 * 1024)
        throw new RangeError('Suite must be a JSON file no larger than 4 MiB');
      const bytes = await readFile(candidate);
      if (bytes.length > 4 * 1024 * 1024) throw new RangeError('Suite file exceeds 4 MiB');
      const suite = impactScenarioSuiteReferenceSchema.parse(
        JSON.parse(bytes.toString('utf8')) as unknown,
      );
      result.sourceHashes[`suite:${relativePath}`] = sha256Bytes(bytes);
      result.scannedSuites += 1;
      result.scannedCases += suite.cases.length;
      for (const item of suite.cases) {
        const via = [
          ...item.sourceSelectors
            .map(selectorKey)
            .filter((key) => relevantSymbols.has(key))
            .map((key) => `symbol:${key}`),
          ...item.sourceFiles
            .filter((file) => relevantFiles.has(file))
            .map((file) => `file:${file}`),
        ].sort(compareCodeUnits);
        if (via.length === 0) continue;
        if (result.matches.length < 10_000)
          result.matches.push({ suitePath: relativePath, suiteId: suite.id, caseId: item.id, via });
        else result.omittedMatches += 1;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      result.unresolved.push({
        path: relativePath,
        reason:
          error instanceof Error ? error.message : 'Scenario suite could not be read or parsed',
      });
    }
  }
  result.complete = result.unresolved.length === 0 && result.omittedMatches === 0;
  return result;
}
