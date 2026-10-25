import type { ImportReport } from './reference-import.js';
import {
  boundedSourceHashEvidence,
  publicArtifactLink,
  type ArtifactWrite,
} from '../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import { diagnosticSeverityCounts } from '../core/diagnostic-rollup.js';
import { sortDiagnostics, type Diagnostic } from '../core/diagnostics.js';
import type { CoreEngine } from '../core/engine.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import { emptyServiceResult, ServiceError } from '../core/result.js';
import { setInlineFilesScanned } from '../core/operation-result.js';
import type { TransactionManifest } from '../core/transactions.js';
import type {
  MapInspectToolRequest,
  MapRenderToolRequest,
  MapRewriteToolRequest,
} from '../schemas/map-requests.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  allocateMapIdentifiersAsync,
  type AllocationEvidence,
  type MapAllocationRequest,
  type MapOperation,
  type MapOperationPlan,
  WORLD_OUTPUT_PATH_SAMPLE,
} from './operations.js';
import { compactTerritoryReport } from './territory-operations.js';
import { borderQualityDiagnostics, type BorderQualityReport } from './border-quality.js';
import {
  measureIndexBorderNaturalness,
  summarizeBorderQuality,
  type BorderQualitySummary,
} from './border-quality-input.js';
import { buildMapCatalog, lookupMapCoordinate, searchMapCatalog } from './catalog.js';
import { GEOGRAPHY_FEATURE_KINDS } from './geography/model.js';
import { operationHasGeography, type PreparedGeography } from './geography/preparation.js';
import { unsupportedGeographyParts } from './relief/index.js';
import { renderMap, type MapOverlay, type MapSemanticDiff } from './render.js';
import { exportProvinceGeometryRowRuns, type AgentNudger } from './service.js';
import type { MapValidationResult } from './validation.js';
import { generatedWorldOperationIds } from './world-preview.js';

export interface MapOperationContext {
  workspaceId: string;
  principal?: string;
  signal?: AbortSignal;
  progress(completed: number, total: number, message: string): Promise<void>;
}

const jsonObject = z.record(z.string(), z.json());
const mapRewriteRecipeSchema = z
  .object({
    data: jsonObject,
    filesScanned: z.array(z.string().min(1).max(4096)),
    planBlockers: z
      .array(
        z
          .object({
            code: z.string().min(1).max(256),
            message: z.string().max(4096),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type MapRewriteRecipe = z.infer<typeof mapRewriteRecipeSchema>;

const mapInlineDiffLimit = 20;
const mapInlineMembershipIdLimit = 32;
const mapInlineTextLimit = 512;

function compactAllocationEvidence(evidence: AllocationEvidence): AllocationEvidence & {
  rootCount: number;
  rootsTruncated: boolean;
} {
  return {
    ...evidence,
    rootCount: evidence.roots.length,
    roots: evidence.roots.slice(0, 16),
    rootsTruncated: evidence.roots.length > 16,
  };
}

function compactNullableText(value: string | null): string | null {
  return value === null ? null : value.slice(0, mapInlineTextLimit);
}

function compactRecordDiffs(
  entries: readonly { key: string; before: string | null; after: string | null }[],
): Array<{ key: string; before: string | null; after: string | null }> {
  return entries.slice(0, mapInlineDiffLimit).map(({ key, before, after }) => ({
    key: key.slice(0, 256),
    before: compactNullableText(before),
    after: compactNullableText(after),
  }));
}

export function compactMapSemanticDiff(semantic: MapSemanticDiff) {
  const counts = {
    definitions: semantic.definitions.length,
    stateMembership: semantic.stateMembership.length,
    regionMembership: semantic.regionMembership.length,
    states: semantic.states.length,
    ports: semantic.ports.length,
    buildingPositions: semantic.buildingPositions.length,
    unitPositions: semantic.unitPositions.length,
    weatherPositions: semantic.weatherPositions.length,
    entityLocators: semantic.entityLocators.length,
    supplyNodes: semantic.supplyNodes.length,
    railways: semantic.railways.length,
    adjacencies: semantic.adjacencies.length,
    normalAdjacencies: semantic.normalAdjacencies.length,
  };
  const result = {
    semantic: {
      definitions: semantic.definitions
        .slice(0, mapInlineDiffLimit)
        .map(({ id, before, after }) => ({
          id,
          before: compactNullableText(before),
          after: compactNullableText(after),
        })),
      stateMembership: semantic.stateMembership.slice(0, mapInlineDiffLimit).map((entry) => ({
        ...entry,
        before: entry.before.slice(0, mapInlineMembershipIdLimit),
        after: entry.after.slice(0, mapInlineMembershipIdLimit),
      })),
      regionMembership: semantic.regionMembership.slice(0, mapInlineDiffLimit).map((entry) => ({
        ...entry,
        before: entry.before.slice(0, mapInlineMembershipIdLimit),
        after: entry.after.slice(0, mapInlineMembershipIdLimit),
      })),
      states: compactRecordDiffs(semantic.states),
      ports: compactRecordDiffs(semantic.ports),
      buildingPositions: compactRecordDiffs(semantic.buildingPositions),
      unitPositions: compactRecordDiffs(semantic.unitPositions),
      weatherPositions: compactRecordDiffs(semantic.weatherPositions),
      entityLocators: compactRecordDiffs(semantic.entityLocators),
      supplyNodes: compactRecordDiffs(semantic.supplyNodes),
      railways: compactRecordDiffs(semantic.railways),
      adjacencies: compactRecordDiffs(semantic.adjacencies),
      normalAdjacencies: compactRecordDiffs(semantic.normalAdjacencies),
      supplyNodesChanged: semantic.supplyNodesChanged,
      railwaysChanged: semantic.railwaysChanged,
      adjacenciesChanged: semantic.adjacenciesChanged,
      normalAdjacenciesChanged: semantic.normalAdjacenciesChanged,
    },
    counts,
    truncated:
      Object.values(counts).some((count) => count > mapInlineDiffLimit) ||
      [...semantic.stateMembership, ...semantic.regionMembership].some(
        ({ before, after }) =>
          before.length > mapInlineMembershipIdLimit || after.length > mapInlineMembershipIdLimit,
      ) ||
      semantic.definitions.some(
        ({ before, after }) =>
          (before?.length ?? 0) > mapInlineTextLimit || (after?.length ?? 0) > mapInlineTextLimit,
      ) ||
      [
        ...semantic.states,
        ...semantic.ports,
        ...semantic.buildingPositions,
        ...semantic.unitPositions,
        ...semantic.weatherPositions,
        ...semantic.entityLocators,
        ...semantic.supplyNodes,
        ...semantic.railways,
        ...semantic.adjacencies,
        ...semantic.normalAdjacencies,
      ].some(
        ({ key, before, after }) =>
          key.length > 256 ||
          (before?.length ?? 0) > mapInlineTextLimit ||
          (after?.length ?? 0) > mapInlineTextLimit,
      ),
  };
  // Bound the aggregate, not just each collection: a complete world replaces every category.
  // Full diffs remain in map-diff.json; leave enough wire space for preview image links.
  while (Buffer.byteLength(canonicalJson(result.semantic), 'utf8') > 8_192) {
    for (const value of Object.values(result.semantic))
      if (Array.isArray(value)) value.splice(Math.floor(value.length / 2));
    result.truncated = true;
  }
  return result;
}

function validationSummary(validation: MapValidationResult) {
  return { passed: validation.passed, checks: validation.checks };
}

function mapArtifactSourceEvidence(files: readonly { displayPath: string; sha256: string }[]) {
  const complete = Object.fromEntries(
    files.map(({ displayPath, sha256 }) => [displayPath, sha256]),
  );
  return { complete, bounded: boundedSourceHashEvidence(complete) };
}

function selectedMapEntities(
  snapshot: Awaited<ReturnType<AgentNudger['scan']>>,
  provinceIds: readonly number[],
  stateIds: readonly number[],
  regionIds: readonly number[],
) {
  const provinces = [...new Set(provinceIds)]
    .sort((a, b) => a - b)
    .map((id) => {
      const definition = snapshot.index.definitionsById.get(id);
      const geometry = snapshot.index.raster?.geometry.get(id);
      return {
        id,
        definition:
          definition === undefined
            ? null
            : {
                color: definition.color,
                type: definition.type,
                coastal: definition.coastal,
                terrain: definition.terrain,
                continent: definition.continent,
              },
        geometry: geometry ?? null,
        stateIds: snapshot.index.stateForProvince(id).map(({ id: state }) => state),
        regionIds: snapshot.index.regionForProvince(id).map(({ id: region }) => region),
        victoryPoints:
          snapshot.index.victoryPointsByProvince
            .get(id)
            ?.map(({ stateId: state, value }) => ({ stateId: state, value })) ?? [],
        provinceBuildings:
          snapshot.index.provinceBuildingsByProvince
            .get(id)
            ?.map(({ stateId: state, buildings }) => ({
              stateId: state,
              buildings: Object.fromEntries(buildings),
            })) ?? [],
        port: (() => {
          const port = snapshot.index.ports.find(({ provinceId }) => provinceId === id);
          return port === undefined
            ? null
            : {
                stateId: port.stateId,
                provinceId: port.provinceId,
                level: port.level,
                coastal: port.coastal,
                adjacentSeaProvinceIds: port.adjacentSeaProvinceIds,
                positions: port.positions.map(
                  ({ stateId, building, x, y, z, rotation, adjacentSeaProvince }) => ({
                    stateId,
                    building,
                    x,
                    y,
                    z,
                    rotation,
                    adjacentSeaProvince,
                  }),
                ),
              };
        })(),
      };
    });
  const states = [...new Set(stateIds)]
    .sort((a, b) => a - b)
    .map((id) => {
      const state = snapshot.index.statesById.get(id);
      return state === undefined
        ? { id, value: null }
        : {
            id,
            value: {
              name: state.name,
              capital: state.capital ?? null,
              manpower: state.manpower,
              category: state.category,
              provinces: state.provinces,
              resources: Object.fromEntries(state.resources),
              owner: state.owner ?? null,
              controller: state.controller ?? null,
              cores: state.cores,
              claims: state.claims,
              victoryPoints: state.victoryPoints.map(({ provinceId, value }) => ({
                provinceId,
                value,
              })),
              stateBuildings: Object.fromEntries(state.stateBuildings),
              provinceBuildings: Object.fromEntries(
                [...state.provinceBuildings].map(([provinceId, buildings]) => [
                  String(provinceId),
                  Object.fromEntries(buildings),
                ]),
              ),
            },
          };
    });
  const regions = [...new Set(regionIds)]
    .sort((a, b) => a - b)
    .map((id) => {
      const region = snapshot.index.regionsById.get(id);
      return region === undefined
        ? { id, value: null }
        : {
            id,
            value: {
              name: region.name,
              provinces: region.provinces,
              navalTerrain: region.navalTerrain ?? null,
            },
          };
    });
  return { provinces, states, regions };
}

export function normalizeMapInspectRequest(input: unknown): MapInspectToolRequest {
  return input as MapInspectToolRequest;
}

export function normalizeMapRenderRequest(input: unknown): MapRenderToolRequest {
  return input as MapRenderToolRequest;
}

export function normalizeMapRewriteRequest(input: unknown): MapRewriteToolRequest {
  return input as MapRewriteToolRequest;
}

/** The figures of an import report an agent needs inline; the full report is an artifact. */
function importSummary(report: ImportReport) {
  return {
    operationId: report.operationId,
    width: report.width,
    height: report.height,
    landPx: report.classes.landPx,
    seaPx: report.classes.seaPx,
    lakePx: report.classes.lakePx,
    ...(report.registration === undefined
      ? {}
      : {
          sheets: report.registration.sheets.length,
          hiddenSheets: report.registration.sheets
            .filter(({ pixels }) => pixels === 0)
            .map(({ id }) => id)
            .slice(0, 16),
          uncoveredPx: report.registration.uncoveredPx,
        }),
    ...(report.agreement === undefined
      ? {}
      : {
          landIou: report.agreement.landIou,
          drawingOnlyLandPx: report.agreement.drawingOnlyLandPx,
          modelOnlyLandPx: report.agreement.modelOnlyLandPx,
          misplacedFeatures: report.agreement.featureCount,
        }),
  };
}

export async function prepareMapRewrite(
  nudger: AgentNudger,
  input: MapRewriteToolRequest,
  context: MapOperationContext,
): Promise<{ transaction: TransactionManifest; recipe: MapRewriteRecipe }> {
  await context.progress(0, 5, 'Planning map operations and visual diff');
  const planned = await nudger.planRewriteWithDiff({
    workspaceId: context.workspaceId,
    operations: input.operations as MapOperation[],
    ...(input.diffScale === undefined ? {} : { diffScale: input.diffScale }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const compactSemantic = compactMapSemanticDiff(planned.bundle.semantic);
  await context.progress(3, 5, 'Map rewrite prepared for journaled application');
  return {
    transaction: planned.transaction,
    recipe: mapRewriteRecipeSchema.parse({
      data: jsonObject.parse({
        allocations: planned.plan.allocations.slice(0, 100).map(compactAllocationEvidence),
        operationBlockers: planned.plan.blockers
          .slice(0, 100)
          .map(({ code, message, operationId }) => ({ code, message, operationId })),
        expectedChangedBounds: planned.plan.expectedChangedBounds ?? null,
        changedProvinceIds: planned.bundle.changedProvinceIds.slice(0, 256),
        changedProvinceCount: planned.bundle.changedProvinceIds.length,
        semanticDiff: compactSemantic.semantic,
        semanticDiffCounts: compactSemantic.counts,
        semanticDiffTruncated: compactSemantic.truncated,
        ...(planned.plan.territory === undefined
          ? {}
          : { territory: planned.plan.territory.map(compactTerritoryReport) }),
        ...worldOutputsData(planned.plan),
      }),
      filesScanned: planned.filesScanned,
      planBlockers: planned.plan.blockers
        .slice(0, 100)
        .map(({ code, message }) => ({ code, message })),
    }),
  };
}

/** Counts and sorted samples of the managed outputs each generated world writes, retires and releases. */
function worldOutputsData(plan: MapOperationPlan) {
  if (plan.worldOutputs === undefined) return {};
  const sample = (paths: readonly string[]) => paths.slice(0, WORLD_OUTPUT_PATH_SAMPLE);
  const realms = plan.worldOutputs.flatMap(({ operationId, realms: placed }) =>
    placed === undefined
      ? []
      : [
          {
            operationId,
            countries: placed.countries.slice(0, 100).map((country) => ({
              tag: country.tag,
              capitalState: country.capitalState,
              capitalProvince: country.capitalProvince,
              states: country.states.length,
              provinces: country.provinces,
              landShare: country.landShare,
              targetShare: country.targetShare,
            })),
            countryCount: placed.countries.length,
            unownedStates: placed.unownedStates.slice(0, WORLD_OUTPUT_PATH_SAMPLE),
            unownedStateCount: placed.unownedStates.length,
          },
        ],
  );
  return {
    ...(realms.length === 0 ? {} : { realms: realms.slice(0, 16) }),
    outputs: plan.worldOutputs.slice(0, 16).map((world) => ({
      operationId: world.operationId,
      written: world.written.length,
      retired: world.retired.length,
      released: world.released.length,
      retiredFiles: sample(world.retired),
      releasedFiles: sample(world.released),
      truncated:
        world.retired.length > WORLD_OUTPUT_PATH_SAMPLE ||
        world.released.length > WORLD_OUTPUT_PATH_SAMPLE,
    })),
  };
}

export function completeMapRewrite(
  workspaceId: string,
  execution: TransactionExecutionResult,
  recipe: unknown,
) {
  const parsed = mapRewriteRecipeSchema.parse(recipe);
  const transaction = execution.transaction;
  const result = emptyServiceResult(workspaceId, {
    execution: execution.outcome,
    ...parsed.data,
    fileCount: transaction.files.length,
    artifactCount: transaction.artifacts.length,
  });
  result.status = transaction.validation.passed ? 'ok' : 'blocked';
  result.code =
    execution.outcome === 'applied'
      ? 'MAP_CHANGES_APPLIED'
      : execution.outcome === 'unchanged'
        ? 'MAP_CHANGES_UNCHANGED'
        : 'MAP_CHANGES_BLOCKED';
  setInlineFilesScanned(result, parsed.filesScanned);
  result.proposedFiles = transaction.files.slice(0, 100).map(({ relativePath }) => relativePath);
  result.changedFiles = transaction.appliedFiles.slice(0, 100);
  result.diagnostics = transaction.diagnostics.slice(0, 100);
  result.artifacts = autonomousResultArtifacts(execution);
  result.validation = transaction.validation;
  result.blockers = [
    ...parsed.planBlockers,
    ...transaction.diagnostics
      .filter(({ severity }) => severity === 'error' || severity === 'blocker')
      .map(({ code, message, details }) => ({
        code,
        message,
        ...(details === undefined ? {} : { details }),
      })),
  ].slice(0, 100);
  return result;
}

const EMPTY_SEMANTIC_DIFF: MapSemanticDiff = {
  definitions: [],
  stateMembership: [],
  regionMembership: [],
  states: [],
  ports: [],
  buildingPositions: [],
  unitPositions: [],
  weatherPositions: [],
  entityLocators: [],
  supplyNodes: [],
  railways: [],
  adjacencies: [],
  normalAdjacencies: [],
  supplyNodesChanged: false,
  railwaysChanged: false,
  adjacenciesChanged: false,
  normalAdjacenciesChanged: false,
};

function geographySummary(prepared: PreparedGeography) {
  const counts = Object.fromEntries(
    GEOGRAPHY_FEATURE_KINDS.map((kind) => [kind, prepared.geography.list(kind).length]),
  );
  const severities = diagnosticSeverityCounts(prepared.diagnostics);
  const unsupported = unsupportedGeographyParts(prepared.geography);
  return {
    operationId: prepared.operationId,
    modelHash: prepared.geography.hash,
    valid: prepared.valid,
    source: prepared.source.kind,
    sourceSha256: prepared.source.sha256,
    width: prepared.frame.width,
    height: prepared.frame.height,
    featureCount: prepared.geography.featureCount,
    pointCount: prepared.geography.pointCount,
    counts,
    errorCount: severities.error,
    warningCount: severities.warning,
    synthesis: unsupported.length === 0 ? ('available' as const) : ('unavailable' as const),
    unsupported,
  };
}

/**
 * Review the geography model of a `create_world` operation: validate it, resolve its ids and areas
 * and return an overlay and a report. No map is planned or generated and no file changes.
 */
async function previewGeographyRewrite(
  nudger: AgentNudger,
  input: MapRewriteToolRequest,
  context: MapOperationContext,
) {
  await context.progress(0, 3, 'Validating the geography model and drawing its overlay');
  const planned = await nudger.previewGeographyModels({
    workspaceId: context.workspaceId,
    operations: input.operations as MapOperation[],
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const compactSemantic = compactMapSemanticDiff(EMPTY_SEMANTIC_DIFF);
  const diagnostics = [
    ...planned.geography.flatMap(({ diagnostics: found }) => found),
    ...planned.importDiagnostics,
  ];
  const ignored = input.operations.filter(
    (operation) => operation.kind !== 'create_world' || !operationHasGeography(operation),
  ).length;
  const notes: Diagnostic[] = [
    {
      code: 'MAP_GEOGRAPHY_PREVIEW_MODEL_ONLY',
      severity: 'info',
      category: 'map',
      message:
        'This preview checks the geography model, and the registration and agreement of a reference picture beside it, only: no map was planned and nothing was synthesized. A request without preview builds relief, rivers and lakes from the model, and is blocked while the model declares biomes, climate, fertility or sea ice, which the climate stage does not synthesize yet.',
    },
    ...(ignored === 0
      ? []
      : [
          {
            code: 'MAP_GEOGRAPHY_PREVIEW_OTHER_OPERATIONS_SKIPPED',
            severity: 'info' as const,
            category: 'map' as const,
            message: `${ignored} other operation(s) in the request were not evaluated by this model preview`,
          },
        ]),
  ];
  const all = sortDiagnostics([...diagnostics, ...notes]);
  const valid =
    planned.geography.every(({ valid: ok }) => ok) &&
    !planned.importDiagnostics.some(
      ({ severity }) => severity === 'error' || severity === 'blocker',
    );
  const result = emptyServiceResult(context.workspaceId, {
    execution: 'preview' as const,
    allocations: [],
    operationBlockers: [],
    expectedChangedBounds: null,
    changedProvinceIds: [],
    changedProvinceCount: 0,
    semanticDiff: compactSemantic.semantic,
    semanticDiffCounts: compactSemantic.counts,
    semanticDiffTruncated: compactSemantic.truncated,
    fileCount: 0,
    artifactCount: planned.artifacts.length,
    geography: planned.geography.slice(0, 16).map(geographySummary),
    ...(planned.imports.length === 0
      ? {}
      : { import: planned.imports.slice(0, 16).map(importSummary) }),
  });
  result.status = valid ? 'ok' : 'blocked';
  result.code = valid ? 'MAP_GEOGRAPHY_PREVIEW_READY' : 'MAP_GEOGRAPHY_PREVIEW_BLOCKED';
  setInlineFilesScanned(result, planned.filesScanned);
  result.proposedFiles = [];
  result.diagnostics = all.slice(0, 100);
  result.artifacts = planned.artifacts.map(publicArtifactLink);
  result.validation = {
    passed: valid,
    checks: [
      {
        id: 'geography-model',
        passed: valid,
        message: valid
          ? 'The geography model resolves without errors'
          : 'The geography model has errors; see the MAP_GEOGRAPHY_* diagnostics and map-geography-report.json',
      },
    ],
  };
  result.blockers = all
    .filter(({ severity }) => severity === 'error' || severity === 'blocker')
    .slice(0, 100)
    .map(({ code, message }) => ({ code, message }));
  await context.progress(
    3,
    3,
    'Geography model preview complete; workspace files were not changed',
  );
  return result;
}

/**
 * `create_world.synthesisCheck`: run the model's relief and river synthesis only and report every
 * river that cannot reach its mouth, with its divide. No map is generated and nothing is written.
 */
async function previewSynthesisCheck(
  nudger: AgentNudger,
  input: MapRewriteToolRequest,
  context: MapOperationContext,
) {
  await context.progress(0, 2, 'Synthesising relief and rivers to check every river');
  const checked = await nudger.checkSynthesis({
    workspaceId: context.workspaceId,
    operations: input.operations as MapOperation[],
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const blocked = checked.diagnostics.filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  );
  const valid = blocked.length === 0 && checked.plan.blockers.length === 0;
  const rivers = checked.diagnostics.flatMap(({ code, details }) =>
    code === 'MAP_RIVER_UNREACHABLE_MOUTH' && Array.isArray(details?.rivers)
      ? (details.rivers as unknown[])
      : [],
  );
  // Drawn rivers are authoritative: crossings of relief they cut through are warnings (ADR 0071).
  const carved = checked.diagnostics.flatMap(({ code, details }) =>
    code === 'MAP_RIVER_CARVED_CROSSING' && details !== undefined ? [details] : [],
  );
  const compactSemantic = compactMapSemanticDiff(EMPTY_SEMANTIC_DIFF);
  const result = emptyServiceResult(context.workspaceId, {
    execution: 'preview' as const,
    allocations: [],
    operationBlockers: [],
    expectedChangedBounds: null,
    changedProvinceIds: [],
    changedProvinceCount: 0,
    semanticDiff: compactSemantic.semantic,
    semanticDiffCounts: compactSemantic.counts,
    semanticDiffTruncated: compactSemantic.truncated,
    fileCount: 0,
    artifactCount: checked.artifacts.length,
    geography: checked.geography.slice(0, 16).map(geographySummary),
    synthesisCheck: {
      passed: valid,
      unreachableRivers: rivers.length,
      rivers: rivers.slice(0, 200),
      carvedCrossings: carved.length,
      crossings: carved.slice(0, 200),
    },
  });
  result.status = valid ? 'ok' : 'blocked';
  result.code = valid ? 'MAP_SYNTHESIS_CHECK_READY' : 'MAP_SYNTHESIS_CHECK_BLOCKED';
  setInlineFilesScanned(result, checked.filesScanned);
  result.proposedFiles = [];
  result.diagnostics = checked.diagnostics.slice(0, 100);
  result.artifacts = checked.artifacts.map(publicArtifactLink);
  result.validation = {
    passed: valid,
    checks: [
      {
        id: 'river-synthesis',
        passed: valid,
        message: valid
          ? 'Every river of the model reaches its mouth'
          : `${rivers.length || blocked.length} river(s) or model parts block the synthesis; see MAP_RIVER_UNREACHABLE_MOUTH details.rivers`,
      },
    ],
  };
  result.blockers = [
    ...checked.plan.blockers.map(({ code, message, details }) => ({
      code,
      message,
      ...(details === undefined ? {} : { details }),
    })),
  ].slice(0, 100);
  await context.progress(2, 2, 'River check complete; nothing was written');
  return result;
}

/** Generate and validate the same proposed map without creating a write transaction. */
export async function previewMapRewrite(
  nudger: AgentNudger,
  input: MapRewriteToolRequest,
  context: MapOperationContext,
) {
  if (
    input.operations.some(
      (operation) => operation.kind === 'create_world' && operation.synthesisCheck === true,
    )
  )
    return previewSynthesisCheck(nudger, input, context);
  if (
    input.operations.some(
      (operation) => operation.kind === 'create_world' && operationHasGeography(operation),
    )
  )
    return previewGeographyRewrite(nudger, input, context);
  await context.progress(0, 5, 'Generating and validating an offline map preview');
  const planned = await nudger.previewRewriteWithDiff({
    workspaceId: context.workspaceId,
    operations: input.operations as MapOperation[],
    ...(input.diffScale === undefined ? {} : { diffScale: input.diffScale }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const compactSemantic = compactMapSemanticDiff(planned.bundle.semantic);
  const index = planned.plan.finalIndex;
  const result = emptyServiceResult(context.workspaceId, {
    execution: 'preview' as const,
    allocations: planned.plan.allocations.slice(0, 100).map(compactAllocationEvidence),
    operationBlockers: planned.plan.blockers
      .slice(0, 100)
      .map(({ code, message, operationId }) => ({ code, message, operationId })),
    expectedChangedBounds: planned.plan.expectedChangedBounds ?? null,
    changedProvinceIds: planned.bundle.changedProvinceIds.slice(0, 256),
    changedProvinceCount: planned.bundle.changedProvinceIds.length,
    semanticDiff: compactSemantic.semantic,
    semanticDiffCounts: compactSemantic.counts,
    semanticDiffTruncated: compactSemantic.truncated,
    ...(planned.plan.territory === undefined
      ? {}
      : { territory: planned.plan.territory.map(compactTerritoryReport) }),
    fileCount: planned.plan.changes.length,
    artifactCount: planned.artifacts.length,
    ...worldOutputsData(planned.plan),
    ...(input.operations.some(({ kind }) => kind === 'create_world') &&
    generatedWorldOperationIds(planned.plan).size === 0
      ? {}
      : {
          preview: {
            offlineRepresentation: true as const,
            width: index.raster?.width ?? 0,
            height: index.raster?.height ?? 0,
            provinces: index.definitions.filter(({ id }) => id !== 0).length,
            states: index.states.length,
            regions: index.regions.length,
            countries: new Set(
              index.states.flatMap(({ owner }) => (owner === undefined ? [] : [owner])),
            ).size,
            warningCount: diagnosticSeverityCounts(planned.diagnostics).warning,
          },
        }),
  });
  result.status = planned.validation.passed ? 'ok' : 'blocked';
  result.code = planned.validation.passed ? 'MAP_PREVIEW_READY' : 'MAP_PREVIEW_BLOCKED';
  setInlineFilesScanned(result, planned.filesScanned);
  result.proposedFiles = planned.plan.changes.slice(0, 100).map(({ relativePath }) => relativePath);
  result.diagnostics = planned.diagnostics.slice(0, 100);
  result.artifacts = planned.artifacts.map(publicArtifactLink);
  result.validation = validationSummary(planned.validation);
  result.blockers = [
    ...planned.plan.blockers.map(({ code, message }) => ({ code, message })),
    ...planned.diagnostics
      .filter(({ severity }) => severity === 'error' || severity === 'blocker')
      .map(({ code, message }) => ({ code, message })),
  ].slice(0, 100);
  await context.progress(5, 5, 'Offline map preview complete; workspace files were not changed');
  return result;
}

export async function inspectMap(
  engine: CoreEngine,
  nudger: AgentNudger,
  input: MapInspectToolRequest,
  context: MapOperationContext,
) {
  await context.progress(0, 3, 'Inspecting and validating the map');
  if (input.lookupOnly) {
    if (input.allocationRequests.length > 0)
      throw new ServiceError(
        'MAP_LOOKUP_ALLOCATION_UNSUPPORTED',
        'Use full map inspection for identifier allocation previews',
      );
    const snapshot = await nudger.scan(context.workspaceId, context.principal, context.signal);
    const catalog = input.query === undefined ? undefined : buildMapCatalog(snapshot.index);
    const queryMatches =
      catalog === undefined ? [] : searchMapCatalog(catalog, input.query!, input.queryLimit);
    const coordinateMatches = input.coordinates.map((coordinate) =>
      lookupMapCoordinate(snapshot.index, coordinate),
    );
    const selected = selectedMapEntities(
      snapshot,
      input.provinceIds,
      input.stateIds,
      input.regionIds,
    );
    const workspace = engine.resolver.get(context.workspaceId, context.principal);
    const sourceEvidence = mapArtifactSourceEvidence(snapshot.files);
    const selectorHash = hashCanonical({
      provinceIds: input.provinceIds,
      stateIds: input.stateIds,
      regionIds: input.regionIds,
      query: input.query,
      coordinates: input.coordinates,
    }).slice(0, 16);
    const artifact = await engine.artifacts.putChunked(
      workspace,
      `map-lookup.${snapshot.revision.slice(0, 16)}.${selectorHash}.json`,
      'application/json',
      `${canonicalJson({ schemaVersion: 1, revision: snapshot.revision, lookupOnly: true, queryMatches, coordinateMatches, selected, sourceHashes: sourceEvidence.complete })}\n`,
      {
        kind: 'map-lookup',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'map-lookup.v1',
        sourceHashes: sourceEvidence.bounded.sourceHashes,
        metadata: { sourceHashInventory: sourceEvidence.bounded.inventory },
      },
      'Bounded map coordinate, catalog, and entity lookup without full validation or overview rendering',
      context.signal,
    );
    const result = emptyServiceResult(context.workspaceId, {
      revision: snapshot.revision,
      sharedRevision: snapshot.revision,
      width: snapshot.index.raster?.width ?? null,
      height: snapshot.index.raster?.height ?? null,
      definitions: snapshot.index.definitions.length,
      states: snapshot.index.states.length,
      regions: snapshot.index.regions.length,
      ports: snapshot.index.ports.length,
      inspectedProvinceCount: selected.provinces.length,
      inspectedStateCount: selected.states.length,
      inspectedRegionCount: selected.regions.length,
      allocationCount: 0,
      queryMatchCount: queryMatches.length,
      coordinateMatchCount: coordinateMatches.length,
      overviewRendered: false,
      provinceGeometryCount: 0,
      provinceGeometryPixelCount: 0,
      provinceGeometryRowRunCount: 0,
      unknownProvinceIds: [],
      missingGeometryProvinceIds: [],
      lookupOnly: true,
    });
    result.code = 'MAP_LOOKUP_COMPLETED';
    result.validation = {
      passed: true,
      checks: [
        {
          id: 'lookup-only',
          passed: true,
          message: 'Lookup completed; full map validation was not requested',
        },
      ],
    };
    setInlineFilesScanned(
      result,
      snapshot.files.map(({ displayPath }) => displayPath),
    );
    result.artifacts = [publicArtifactLink(artifact)];
    await context.progress(3, 3, 'Map lookup complete');
    return result;
  }
  const { snapshot, validation, scriptReferences } = await nudger.validate(
    context.workspaceId,
    context.principal,
    context.signal,
    input.references,
    input.quality,
  );
  const sharedRevision = snapshot.revision;
  let borderQuality: { report: BorderQualityReport; summary: BorderQualitySummary } | undefined;
  const qualityDiagnostics: Diagnostic[] = [];
  if (input.quality) {
    await context.progress(1, 3, 'Measuring how natural the borders are');
    try {
      const measured = await measureIndexBorderNaturalness(
        snapshot.index,
        context.signal === undefined ? {} : { signal: context.signal },
      );
      borderQuality = {
        report: measured.report,
        summary: summarizeBorderQuality(measured.report, measured.skipped),
      };
      qualityDiagnostics.push(...borderQualityDiagnostics(measured.report));
    } catch (error) {
      if (!(error instanceof ServiceError) || !error.code.startsWith('MAP_BORDER_QUALITY_'))
        throw error;
      qualityDiagnostics.push({
        code: 'MAP_BORDER_QUALITY_UNAVAILABLE',
        severity: 'warning',
        category: 'map',
        message: `Border naturalness could not be measured: ${error.message}`,
        details: { reason: error.code, ...error.details },
      });
    }
  }
  const catalog = buildMapCatalog(snapshot.index);
  const queryMatches =
    input.query === undefined ? [] : searchMapCatalog(catalog, input.query, input.queryLimit);
  const coordinateMatches = input.coordinates.map((coordinate) =>
    lookupMapCoordinate(snapshot.index, coordinate),
  );
  const overviewRendered = input.includeOverview && snapshot.index.raster !== undefined;
  const selected = selectedMapEntities(
    snapshot,
    input.provinceIds,
    input.stateIds,
    input.regionIds,
  );
  const provinceGeometry =
    input.provinceIds.length === 0
      ? undefined
      : await exportProvinceGeometryRowRuns(snapshot.index, input.provinceIds, context.signal);
  const allocationPreviews = [];
  for (const request of input.allocationRequests) {
    allocationPreviews.push({
      request,
      allocation: await allocateMapIdentifiersAsync(
        snapshot.index,
        request as MapAllocationRequest,
        context.signal,
      ),
    });
  }
  const workspace = engine.resolver.get(context.workspaceId, context.principal);
  const sourceEvidence = mapArtifactSourceEvidence(snapshot.files);
  const inspectionProvenance = {
    kind: 'map-inspect',
    toolVersion: PACKAGE_VERSION,
    schemaVersion: 'map-inspect.v2',
    sourceHashes: sourceEvidence.bounded.sourceHashes,
    metadata: {
      sharedRevision,
      sourceHashInventory: sourceEvidence.bounded.inventory,
    },
  };
  const artifactWrites: ArtifactWrite[] = [
    {
      name: `map-inspect.${snapshot.revision.slice(0, 16)}.json`,
      mimeType: 'application/json',
      content: `${canonicalJson({
        schemaVersion: 2,
        revision: snapshot.revision,
        sharedRevision,
        dimensions:
          snapshot.index.raster === undefined
            ? null
            : {
                width: snapshot.index.raster.width,
                height: snapshot.index.raster.height,
                bitsPerPixel: snapshot.index.provinceBitmap?.bitsPerPixel,
                dibSize: snapshot.index.provinceBitmap?.dibSize,
              },
        counts: {
          definitions: snapshot.index.definitions.length,
          states: snapshot.index.states.length,
          regions: snapshot.index.regions.length,
          adjacencies: snapshot.index.adjacencies.length,
          supplyNodes: snapshot.index.supplyNodes.length,
          railways: snapshot.index.railways.length,
          ports: snapshot.index.ports.length,
          locators: snapshot.index.entityLocators.length,
        },
        catalog,
        query: input.query ?? null,
        queryMatches,
        coordinateMatches,
        selected,
        allocationPreviews,
        validation,
        ...(borderQuality === undefined ? {} : { borderQuality: borderQuality.report }),
        sourceHashes: sourceEvidence.complete,
      })}\n`,
      provenance: inspectionProvenance,
      description:
        'Complete searchable map catalog, inspection, validation, selected records, and allocation previews',
    },
  ];
  if (borderQuality !== undefined)
    artifactWrites.push({
      name: `map-border-quality.${snapshot.revision.slice(0, 16)}.json`,
      mimeType: 'application/json',
      content: `${canonicalJson({
        schemaVersion: 1,
        revision: snapshot.revision,
        report: borderQuality.report,
        skippedInputs: borderQuality.summary.skippedInputs,
        sourceHashes: sourceEvidence.complete,
      })}\n`,
      provenance: {
        kind: 'map-border-quality',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'map-border-quality.v1',
        sourceHashes: sourceEvidence.bounded.sourceHashes,
        metadata: { sharedRevision, sourceHashInventory: sourceEvidence.bounded.inventory },
      },
      description:
        'Border naturalness: alignment with rivers, slopes, lake shores and terrain changes, enrichment over chance, straightness and the worst artificial runs for each border layer',
    });
  if (overviewRendered) {
    const overviewLayer = 'state' as const;
    const overviewOverlays: MapOverlay[] = [
      'coastlines',
      'ports',
      'victory-points',
      'supply-nodes',
      'railways',
    ];
    const overview = await renderMap(snapshot.index, {
      layer: overviewLayer,
      overlays: overviewOverlays,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const overviewProvenance = {
      kind: 'map-inspect-overview',
      toolVersion: PACKAGE_VERSION,
      schemaVersion: 'map-inspect-overview.v1',
      sourceHashes: sourceEvidence.bounded.sourceHashes,
      renderProfile: {
        layer: overviewLayer,
        overlays: [...new Set(overviewOverlays)].sort(),
        scale: 1,
      },
      metadata: { sourceHashInventory: sourceEvidence.bounded.inventory },
    };
    artifactWrites.push(
      {
        name: `map-overview.${snapshot.revision.slice(0, 16)}.png`,
        mimeType: 'image/png',
        content: overview.png,
        provenance: overviewProvenance,
        description: 'Complete rendered map overview',
      },
      {
        name: `map-overview.${snapshot.revision.slice(0, 16)}.html`,
        mimeType: 'text/html',
        content: overview.html,
        provenance: overviewProvenance,
        description:
          'Searchable and clickable full-map navigator with exact IDs, names, coordinates, and linked records',
      },
    );
  }
  if (provinceGeometry !== undefined) {
    const {
      width,
      height,
      requestedProvinceIds,
      unknownProvinceIds,
      missingGeometryProvinceIds,
      pixelCount,
      rowRunCount,
      provinces,
    } = provinceGeometry;
    const selectorHash = hashCanonical(requestedProvinceIds).slice(0, 16);
    artifactWrites.push({
      name: `map-province-geometry.${snapshot.revision.slice(0, 16)}.${selectorHash}.json`,
      mimeType: 'application/json',
      content: `${canonicalJson({
        schemaVersion: 1,
        revision: snapshot.revision,
        dimensions: { width, height },
        coordinateSystem: { origin: 'top-left', xDirection: 'right', yDirection: 'down' },
        rowRunFormat: ['y', 'startX', 'endXExclusive'],
        requestedProvinceIds,
        unknownProvinceIds,
        missingGeometryProvinceIds,
        pixelCount,
        rowRunCount,
        provinces,
        sourceHashes: sourceEvidence.complete,
      })}\n`,
      provenance: {
        kind: 'map-province-geometry',
        toolVersion: PACKAGE_VERSION,
        schemaVersion: 'map-province-geometry.v1',
        sourceHashes: sourceEvidence.bounded.sourceHashes,
        metadata: { requestedProvinceIds, sourceHashInventory: sourceEvidence.bounded.inventory },
      },
      description:
        'Exact canonical province row runs for deriving bounded split or create geometry',
    });
  }
  const artifacts = await engine.artifacts.withAtomicChunkedWrites(
    workspace,
    artifactWrites,
    (stored) => Promise.resolve([...stored]),
    context.signal,
  );
  const result = emptyServiceResult(context.workspaceId, {
    revision: snapshot.revision,
    sharedRevision,
    width: snapshot.index.raster?.width ?? null,
    height: snapshot.index.raster?.height ?? null,
    definitions: snapshot.index.definitions.length,
    states: snapshot.index.states.length,
    regions: snapshot.index.regions.length,
    ports: snapshot.index.ports.length,
    inspectedProvinceCount: selected.provinces.length,
    inspectedStateCount: selected.states.length,
    inspectedRegionCount: selected.regions.length,
    allocationCount: allocationPreviews.length,
    queryMatchCount: queryMatches.length,
    coordinateMatchCount: coordinateMatches.length,
    overviewRendered,
    provinceGeometryCount: provinceGeometry?.provinces.length ?? 0,
    provinceGeometryPixelCount: provinceGeometry?.pixelCount ?? 0,
    provinceGeometryRowRunCount: provinceGeometry?.rowRunCount ?? 0,
    unknownProvinceIds: provinceGeometry?.unknownProvinceIds ?? [],
    missingGeometryProvinceIds: provinceGeometry?.missingGeometryProvinceIds ?? [],
    ...(scriptReferences === undefined ? {} : { scriptReferences }),
    ...(borderQuality === undefined ? {} : { quality: borderQuality.summary }),
  });
  result.code = 'MAP_INSPECTED';
  setInlineFilesScanned(
    result,
    snapshot.files.map(({ displayPath }) => displayPath),
  );
  result.diagnostics = (
    qualityDiagnostics.length === 0
      ? validation.diagnostics
      : sortDiagnostics([...validation.diagnostics, ...qualityDiagnostics])
  ).slice(0, 100);
  result.artifacts = artifacts.map(publicArtifactLink);
  result.validation = validationSummary(validation);
  await context.progress(3, 3, 'Map inspection complete');
  return result;
}

export async function renderMapView(
  nudger: AgentNudger,
  input: MapRenderToolRequest,
  context: MapOperationContext,
) {
  await context.progress(0, 3, 'Rendering offline map layer');
  const rendered = await nudger.renderAndStore(context.workspaceId, {
    ...(input.layer === undefined ? {} : { layer: input.layer }),
    ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
    ...(input.scale === undefined ? {} : { scale: input.scale }),
    ...(input.tile === undefined ? {} : { tile: input.tile }),
    ...(input.area === undefined ? {} : { area: input.area }),
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const result = emptyServiceResult(context.workspaceId, {
    revision: rendered.revision,
    width: rendered.bundle.width,
    height: rendered.bundle.height,
    hashes: rendered.bundle.hashes,
    offlineRepresentation: true as const,
    ...(rendered.bundle.tile === undefined ? {} : { tile: rendered.bundle.tile }),
  });
  result.code = 'MAP_RENDERED';
  setInlineFilesScanned(result, rendered.filesScanned);
  result.artifacts = rendered.artifacts.map(publicArtifactLink);
  await context.progress(3, 3, 'Map render complete');
  return result;
}
import { z } from 'zod/v4';
