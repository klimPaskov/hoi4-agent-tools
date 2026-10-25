import type { Diagnostic } from '../core/diagnostics.js';
import { ServiceError } from '../core/result.js';
import {
  borderQualityDiagnostics,
  borderTargetsForLayer,
  checkBorderTargets,
  measureBorderNaturalness,
  type BorderLayerReport,
  type BorderQualityReport,
  type BorderTargetCheck,
  type BorderTargets,
} from './border-quality.js';
import { borderQualityInputFromIndex } from './border-quality-input.js';
import type { MapOperationBlocker, MapOperationPlan } from './operations.js';
import type {
  BorderQualityMode,
  BorderTargetsInput,
  TerritoryReport,
} from './territory-operations.js';

/**
 * Border quality of the proposed map for the operations that ask for it (ADR 0060, ADR 0059): the
 * `assign_territory` and `repartition_states` borders, and the borders of a new world. The metric
 * runs on the final index, after every operation of the request, so it measures what would be
 * written. `report` adds diagnostics; `enforce` also blocks the write when a layer misses its
 * targets.
 */

export interface LayerVerdict {
  layer: string;
  mode: BorderQualityMode;
  targets: BorderTargets;
  check: BorderTargetCheck;
  report: BorderLayerReport;
}

export interface OperationQuality {
  operationId: string;
  kind: string;
  layers: LayerVerdict[];
}

export interface TerritoryQuality {
  diagnostics: Diagnostic[];
  blockers: MapOperationBlocker[];
  operations: OperationQuality[];
  /** The layers measured, in full, for the artifact. */
  report?: BorderQualityReport;
  skippedInputs: { input: string; reason: string }[];
}

interface Request {
  operationId: string;
  kind: string;
  mode: BorderQualityMode;
  layers: readonly string[];
  overrides: BorderTargetsInput | undefined;
  /** The layers that must pass in `enforce`. */
  enforced: readonly string[];
}

function targetsFor(layer: string, overrides: BorderTargetsInput | undefined): BorderTargets {
  const targets: BorderTargets = { ...borderTargetsForLayer(layer) };
  if (overrides?.minEnrichment !== undefined) targets.minEnrichment = overrides.minEnrichment;
  if (overrides?.maxStraightness !== undefined) targets.maxStraightness = overrides.maxStraightness;
  if (overrides?.minNaturalShare !== undefined) targets.minNaturalShare = overrides.minNaturalShare;
  return targets;
}

function requests(plan: MapOperationPlan): Request[] {
  const result: Request[] = [];
  for (const report of plan.territory ?? []) {
    const { mode, layer, targets } = report.borderQuality;
    if (mode === 'off') continue;
    result.push({
      operationId: report.operationId,
      kind: report.kind,
      mode,
      layers: layer === 'country' ? ['country', 'state'] : ['state'],
      overrides: targets,
      enforced: [layer],
    });
  }
  const failed = new Set(plan.blockers.map(({ operationId }) => operationId));
  for (const operation of plan.operations) {
    if (operation.kind !== 'create_world' || failed.has(operation.id)) continue;
    const mode = operation.data.borderQuality;
    if (mode !== 'report' && mode !== 'enforce') continue;
    result.push({
      operationId: operation.id,
      kind: 'create_world',
      mode,
      layers: ['province', 'state', 'region', 'country'],
      overrides: operation.data.borderTargets as BorderTargetsInput | undefined,
      enforced: ['province', 'state', 'region', 'country'],
    });
  }
  return result;
}

function describeFailures(check: BorderTargetCheck, layer: string): string {
  return `The ${layer} borders look artificial: ${check.failures
    .map(({ metric, value, target }) =>
      metric === 'enrichment'
        ? `enrichment ${String(value)} is below ${String(target)}`
        : metric === 'straightness'
          ? `${String(value)} of samples are locally straight (limit ${String(target)})`
          : `natural share ${String(value)} is below ${String(target)}`,
    )
    .join('; ')}`;
}

/** Measure the final index for the operations that asked for border quality. */
export async function evaluateTerritoryQuality(
  plan: MapOperationPlan,
  signal?: AbortSignal,
): Promise<TerritoryQuality | undefined> {
  const asked = requests(plan);
  if (asked.length === 0) return undefined;
  const wanted = new Set(asked.flatMap(({ layers }) => layers));
  let measured: Awaited<ReturnType<typeof measureBorderNaturalness>>;
  let skipped: { input: string; reason: string }[];
  try {
    const { input, skipped: missing } = borderQualityInputFromIndex(plan.finalIndex);
    skipped = missing;
    measured = await measureBorderNaturalness(
      { ...input, layers: input.layers.filter(({ name }) => wanted.has(name)) },
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    const reason = error instanceof ServiceError ? error.code : 'MAP_BORDER_QUALITY_UNAVAILABLE';
    const message = error instanceof Error ? error.message : String(error);
    const blockers: MapOperationBlocker[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const request of asked) {
      const text = `Border quality could not be measured (${reason}): ${message}`;
      if (request.mode === 'enforce')
        blockers.push({
          code: 'MAP_BORDER_QUALITY_UNAVAILABLE',
          message: text,
          operationId: request.operationId,
        });
      diagnostics.push({
        code: 'MAP_BORDER_QUALITY_UNAVAILABLE',
        severity: request.mode === 'enforce' ? 'blocker' : 'warning',
        category: 'map',
        message: text,
        operationId: request.operationId,
      });
    }
    return { diagnostics, blockers, operations: [], skippedInputs: [] };
  }
  const diagnostics: Diagnostic[] = [];
  const blockers: MapOperationBlocker[] = [];
  const operations: OperationQuality[] = [];
  const layerReports = new Map(measured.report.layers.map((layer) => [layer.layer, layer]));
  const inputsMissing = borderQualityDiagnostics({ ...measured.report, layers: [] }).filter(
    ({ code }) => code === 'MAP_BORDER_INPUT_MISSING',
  );
  for (const request of asked) {
    const verdicts: LayerVerdict[] = [];
    for (const layer of request.layers) {
      const report = layerReports.get(layer);
      if (report === undefined) continue;
      const targets = targetsFor(layer, request.overrides);
      const check = checkBorderTargets(report, targets);
      verdicts.push({ layer, mode: request.mode, targets, check, report });
      const judged = report.status === 'ok';
      const enforcedHere = request.mode === 'enforce' && request.enforced.includes(layer);
      if (enforcedHere && judged && !check.passed) {
        const message = `${describeFailures(check, layer)}. Natural share ${String(report.natural.share)}; ${report.worstRuns[0] === undefined ? 'no long artificial run' : `the longest artificial run is ${report.worstRuns[0].edges} pixels between ${report.worstRuns[0].sides[0]} and ${report.worstRuns[0].sides[1]} near (${report.worstRuns[0].from.x}, ${report.worstRuns[0].from.y})`}. Move seeds or blocked/forced land, or lower the targets with borderTargets, or use borderQuality "report".`;
        const code =
          request.kind === 'create_world'
            ? 'MAP_WORLD_BORDER_ARTIFICIAL'
            : 'MAP_TERRITORY_BORDER_ARTIFICIAL';
        blockers.push({
          code,
          message,
          operationId: request.operationId,
          details: { layer, failures: check.failures, worstRun: report.worstRuns[0] ?? null },
        });
        diagnostics.push({
          code,
          severity: 'blocker',
          category: 'map',
          message,
          operationId: request.operationId,
          details: { layer, failures: check.failures, worstRun: report.worstRuns[0] ?? null },
        });
        continue;
      }
      if (!judged) {
        diagnostics.push({
          code:
            report.status === 'not-meaningful'
              ? 'MAP_BORDER_NOT_MEANINGFUL'
              : 'MAP_BORDER_NOT_JUDGED',
          severity: 'info',
          category: 'map',
          operationId: request.operationId,
          message: `The ${layer} border naturalness was not judged (${report.status}): ${
            report.status === 'not-meaningful'
              ? 'the map has too few rivers, slopes or shores to align to'
              : 'there are too few borders'
          }`,
          details: { layer, status: report.status, baseRate: report.barrier.baseRate },
        });
        continue;
      }
      diagnostics.push(
        ...borderQualityDiagnostics(
          { ...measured.report, layers: [report], targets: { [layer]: targets } },
          targets,
        )
          .filter(({ code }) => code === 'MAP_BORDER_ARTIFICIAL_REVIEW')
          .map((diagnostic) => ({ ...diagnostic, operationId: request.operationId })),
      );
    }
    operations.push({ operationId: request.operationId, kind: request.kind, layers: verdicts });
    diagnostics.push({
      code: 'MAP_BORDER_QUALITY_MEASURED',
      severity: 'info',
      category: 'map',
      operationId: request.operationId,
      message: `Border naturalness of the proposed map: ${verdicts
        .map(
          ({ layer, report, check }) =>
            `${layer} enrichment ${report.barrier.enrichment ?? 'n/a'}, natural share ${report.natural.share ?? 'n/a'}${report.straightness.fraction === null ? '' : `, straight ${report.straightness.fraction}`} (${check.passed ? 'meets' : 'misses'} the targets)`,
        )
        .join('; ')}`,
      details: {
        layers: verdicts.map(({ layer, report, check, targets }) => ({
          layer,
          status: report.status,
          enrichment: report.barrier.enrichment,
          alignment: report.barrier.alignment,
          baseRate: report.barrier.baseRate,
          naturalShare: report.natural.share,
          straightFraction: report.straightness.fraction,
          passed: check.passed,
          targets,
        })),
      },
    });
  }
  diagnostics.push(...inputsMissing.slice(0, 1));
  return { diagnostics, blockers, operations, report: measured.report, skippedInputs: skipped };
}

export interface TerritoryArtifactContent {
  schemaVersion: 1;
  reports: Array<TerritoryReport & { quality?: OperationQuality }>;
  borderQuality?: BorderQualityReport;
  skippedInputs: { input: string; reason: string }[];
}

/** The complete territory report written as `map-territory-report.json`. */
export function territoryArtifactContent(
  reports: readonly TerritoryReport[],
  quality: TerritoryQuality | undefined,
): TerritoryArtifactContent {
  const byOperation = new Map(
    (quality?.operations ?? []).map((entry) => [entry.operationId, entry]),
  );
  return {
    schemaVersion: 1,
    reports: reports.map((report) => {
      const found = byOperation.get(report.operationId);
      return found === undefined ? report : { ...report, quality: found };
    }),
    ...(quality?.report === undefined ? {} : { borderQuality: quality.report }),
    skippedInputs: quality?.skippedInputs ?? [],
  };
}
