import {
  boundedSourceHashEvidence,
  publicArtifactLink,
  type ArtifactWrite,
} from '../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../core/canonical.js';
import type { CoreEngine } from '../core/engine.js';
import {
  autonomousResultArtifacts,
  type TransactionExecutionResult,
} from '../core/transaction-execution.js';
import { emptyServiceResult } from '../core/result.js';
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
} from './operations.js';
import { buildMapCatalog, lookupMapCoordinate, searchMapCatalog } from './catalog.js';
import { renderMap, type MapOverlay, type MapSemanticDiff } from './render.js';
import { exportProvinceGeometryRowRuns, type AgentNudger } from './service.js';
import type { MapValidationResult } from './validation.js';

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

function compactMapSemanticDiff(semantic: MapSemanticDiff) {
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
  return {
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
      }),
      filesScanned: planned.filesScanned,
      planBlockers: planned.plan.blockers
        .slice(0, 100)
        .map(({ code, message }) => ({ code, message })),
    }),
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

export async function inspectMap(
  engine: CoreEngine,
  nudger: AgentNudger,
  input: MapInspectToolRequest,
  context: MapOperationContext,
) {
  await context.progress(0, 3, 'Inspecting and validating the map');
  const { snapshot, validation } = await nudger.validate(
    context.workspaceId,
    context.principal,
    context.signal,
  );
  const sharedRevision = snapshot.revision;
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
        sourceHashes: sourceEvidence.complete,
      })}\n`,
      provenance: inspectionProvenance,
      description:
        'Complete searchable map catalog, inspection, validation, selected records, and allocation previews',
    },
  ];
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
  });
  result.code = 'MAP_INSPECTED';
  setInlineFilesScanned(
    result,
    snapshot.files.map(({ displayPath }) => displayPath),
  );
  result.diagnostics = validation.diagnostics.slice(0, 100);
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
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const result = emptyServiceResult(context.workspaceId, {
    revision: rendered.revision,
    width: rendered.bundle.width,
    height: rendered.bundle.height,
    hashes: rendered.bundle.hashes,
    offlineRepresentation: true as const,
  });
  result.code = 'MAP_RENDERED';
  setInlineFilesScanned(result, rendered.filesScanned);
  result.artifacts = rendered.artifacts.map(publicArtifactLink);
  await context.progress(3, 3, 'Map render complete');
  return result;
}
import { z } from 'zod/v4';
