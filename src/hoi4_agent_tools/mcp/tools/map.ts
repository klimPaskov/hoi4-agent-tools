import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  boundedSourceHashEvidence,
  publicArtifactLink,
  type ArtifactWrite,
} from '../../core/artifacts.js';
import { canonicalJson, hashCanonical } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import { emptyServiceResult } from '../../core/result.js';
import {
  AgentNudger,
  allocateMapIdentifiersAsync,
  exportProvinceGeometryRowRuns,
  MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT,
  type AllocationEvidence,
  type MapAllocationRequest,
  type MapOperation,
  type MapSemanticDiff,
  type MapValidationResult,
} from '../../map/index.js';
import { workspaceIdSchema } from '../../schemas/common.js';
import { mapAllocationRequestSchema, mapOperationSchema } from '../../schemas/map.js';
import { PACKAGE_VERSION } from '../../version.js';
import { requireServerScope, type ServerContext } from '../server/base-tools.js';
import {
  autonomousFailureContext,
  autonomousResultArtifacts,
  executePlannedTransaction,
} from '../server/transaction-execution.js';
import {
  allocationEvidenceSchema,
  bitmapRenderHashesSchema,
  nonNegativeIntegerSchema,
  operationBlockerDataSchema,
  sha256Schema,
} from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';

const changedBoundsSchema = z
  .object({
    minX: nonNegativeIntegerSchema,
    minY: nonNegativeIntegerSchema,
    maxX: nonNegativeIntegerSchema,
    maxY: nonNegativeIntegerSchema,
    count: nonNegativeIntegerSchema,
  })
  .strict();
const recordDiffSchema = z
  .object({
    key: z.string().max(256),
    before: z.string().max(512).nullable(),
    after: z.string().max(512).nullable(),
  })
  .strict();
const membershipDiffSchema = z
  .object({
    provinceId: nonNegativeIntegerSchema,
    before: z.array(nonNegativeIntegerSchema).max(32),
    after: z.array(nonNegativeIntegerSchema).max(32),
  })
  .strict();
const mapSemanticDiffSchema = z
  .object({
    definitions: z
      .array(
        z
          .object({
            id: nonNegativeIntegerSchema,
            before: z.string().max(512).nullable(),
            after: z.string().max(512).nullable(),
          })
          .strict(),
      )
      .max(20),
    stateMembership: z.array(membershipDiffSchema).max(20),
    regionMembership: z.array(membershipDiffSchema).max(20),
    states: z.array(recordDiffSchema).max(20),
    ports: z.array(recordDiffSchema).max(20),
    buildingPositions: z.array(recordDiffSchema).max(20),
    unitPositions: z.array(recordDiffSchema).max(20),
    weatherPositions: z.array(recordDiffSchema).max(20),
    entityLocators: z.array(recordDiffSchema).max(20),
    supplyNodes: z.array(recordDiffSchema).max(20),
    railways: z.array(recordDiffSchema).max(20),
    adjacencies: z.array(recordDiffSchema).max(20),
    normalAdjacencies: z.array(recordDiffSchema).max(20),
    supplyNodesChanged: z.boolean(),
    railwaysChanged: z.boolean(),
    adjacenciesChanged: z.boolean(),
    normalAdjacenciesChanged: z.boolean(),
  })
  .strict();
const mapWorkspaceInspectOutputSchema = strictOperationResultSchema(
  z
    .object({
      revision: sha256Schema,
      sharedRevision: sha256Schema,
      width: nonNegativeIntegerSchema.nullable(),
      height: nonNegativeIntegerSchema.nullable(),
      definitions: nonNegativeIntegerSchema,
      states: nonNegativeIntegerSchema,
      regions: nonNegativeIntegerSchema,
      ports: nonNegativeIntegerSchema,
      inspectedProvinceCount: nonNegativeIntegerSchema,
      inspectedStateCount: nonNegativeIntegerSchema,
      inspectedRegionCount: nonNegativeIntegerSchema,
      allocationCount: nonNegativeIntegerSchema,
      provinceGeometryCount: nonNegativeIntegerSchema,
      provinceGeometryPixelCount: nonNegativeIntegerSchema,
      provinceGeometryRowRunCount: nonNegativeIntegerSchema,
      unknownProvinceIds: z
        .array(nonNegativeIntegerSchema)
        .max(MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT),
      missingGeometryProvinceIds: z
        .array(nonNegativeIntegerSchema)
        .max(MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT),
    })
    .strict(),
);
const mapRenderOutputSchema = strictOperationResultSchema(
  z
    .object({
      revision: sha256Schema,
      width: nonNegativeIntegerSchema,
      height: nonNegativeIntegerSchema,
      hashes: bitmapRenderHashesSchema,
      offlineRepresentation: z.literal(true),
    })
    .strict(),
);
const mapPlanOutputSchema = strictOperationResultSchema(
  z
    .object({
      execution: z.enum(['applied', 'blocked', 'unchanged']),
      allocations: z.array(allocationEvidenceSchema).max(100),
      operationBlockers: z.array(operationBlockerDataSchema).max(100),
      expectedChangedBounds: changedBoundsSchema.nullable(),
      changedProvinceIds: z.array(nonNegativeIntegerSchema).max(256),
      changedProvinceCount: nonNegativeIntegerSchema,
      semanticDiff: mapSemanticDiffSchema,
      semanticDiffCounts: z.record(z.string().max(256), nonNegativeIntegerSchema),
      semanticDiffTruncated: z.boolean(),
      fileCount: nonNegativeIntegerSchema,
      artifactCount: nonNegativeIntegerSchema,
    })
    .strict(),
);

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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

function compactMapSemanticDiff(semantic: MapSemanticDiff): {
  semantic: MapSemanticDiff;
  counts: Record<string, number>;
  truncated: boolean;
} {
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

const mapLayerSchema = z.enum([
  'province',
  'state',
  'strategic-region',
  'terrain',
  'continent',
  'owner',
  'controller',
  'cores',
  'claims',
  'coast',
]);
const mapOverlaySchema = z.enum([
  'coastlines',
  'ports',
  'victory-points',
  'resources',
  'state-buildings',
  'province-buildings',
  'supply-nodes',
  'railways',
  'adjacencies',
  'building-positions',
  'unit-positions',
  'weather-positions',
]);

function validationSummary(validation: MapValidationResult): {
  passed: boolean;
  checks: MapValidationResult['checks'];
} {
  return { passed: validation.passed, checks: validation.checks };
}

function mapArtifactSourceEvidence(files: readonly { displayPath: string; sha256: string }[]): {
  complete: Record<string, string>;
  bounded: ReturnType<typeof boundedSourceHashEvidence>;
} {
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

export function registerMapTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const nudger = new AgentNudger(engine);

  server.registerTool(
    'hoi4.map_inspect',
    {
      title: 'Inspect HOI4 map',
      description:
        'Inspect map geometry and records for creation and cleanup, validate the complete map, return selected province/state/region details, preview requested free IDs and province colors, and export exact canonical province row runs when provinceIds are supplied.',
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          provinceIds: z
            .array(z.number().int().min(0))
            .max(MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT)
            .default([])
            .describe(
              `Optional exact-geometry selector; exports row runs for at most ${MAP_PROVINCE_GEOMETRY_SELECTOR_LIMIT} province IDs`,
            ),
          stateIds: z.array(z.number().int().positive()).max(1_000).default([]),
          regionIds: z.array(z.number().int().positive()).max(1_000).default([]),
          allocationRequests: z.array(mapAllocationRequestSchema).max(100).default([]),
        })
        .strict(),
      outputSchema: mapWorkspaceInspectOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, provinceIds, stateIds, regionIds, allocationRequests }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Inspecting and validating the map');
        const [shared, { snapshot, validation }] = await Promise.all([
          engine.scan(workspaceId, {}, context.principal, progress.signal),
          nudger.validate(workspaceId, context.principal, progress.signal),
        ]);
        const selected = selectedMapEntities(snapshot, provinceIds, stateIds, regionIds);
        const provinceGeometry =
          provinceIds.length === 0
            ? undefined
            : await exportProvinceGeometryRowRuns(snapshot.index, provinceIds, progress.signal);
        const allocationPreviews = [];
        for (const request of allocationRequests) {
          allocationPreviews.push({
            request,
            allocation: await allocateMapIdentifiersAsync(
              snapshot.index,
              request as MapAllocationRequest,
              progress.signal,
            ),
          });
        }
        const workspace = engine.resolver.get(workspaceId, context.principal);
        const sourceEvidence = mapArtifactSourceEvidence(snapshot.files);
        const inspectionProvenance = {
          kind: 'map-inspect',
          toolVersion: PACKAGE_VERSION,
          schemaVersion: 'map-inspect.v1',
          sourceHashes: sourceEvidence.bounded.sourceHashes,
          metadata: {
            sharedRevision: shared.revision,
            sourceHashInventory: sourceEvidence.bounded.inventory,
          },
        };
        const artifactWrites: ArtifactWrite[] = [
          {
            name: `map-inspect.${snapshot.revision.slice(0, 16)}.json`,
            mimeType: 'application/json',
            content: `${canonicalJson({
              schemaVersion: 1,
              revision: snapshot.revision,
              sharedRevision: shared.revision,
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
              selected,
              allocationPreviews,
              validation,
              sourceHashes: sourceEvidence.complete,
            })}\n`,
            provenance: inspectionProvenance,
            description:
              'Complete map inspection, validation, selected records, and allocation previews',
          },
        ];
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
              coordinateSystem: {
                origin: 'top-left',
                xDirection: 'right',
                yDirection: 'down',
              },
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
              metadata: {
                requestedProvinceIds,
                sourceHashInventory: sourceEvidence.bounded.inventory,
              },
            },
            description:
              'Exact canonical province row runs for deriving bounded split or create geometry',
          });
        }
        const artifacts = await engine.artifacts.withAtomicChunkedWrites(
          workspace,
          artifactWrites,
          (stored) => Promise.resolve([...stored]),
          progress.signal,
        );
        const result = emptyServiceResult(workspaceId, {
          revision: snapshot.revision,
          sharedRevision: shared.revision,
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
        await progress.report(3, 3, 'Map inspection complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.map_render',
    {
      title: 'Render map inspection artifacts',
      description:
        'Render deterministic PNG, JSON, and pan-and-zoom HTML artifacts for map creation and cleanup review, with one semantic layer and bounded overlays.',
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          layer: mapLayerSchema.optional(),
          overlays: z.array(mapOverlaySchema).max(12).optional(),
          scale: z.number().int().min(1).max(16).optional(),
        })
        .strict(),
      outputSchema: mapRenderOutputSchema,
      annotations: artifactProducing,
    },
    async ({ workspaceId, layer, overlays, scale }, extra) => {
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 3, 'Rendering offline map layer');
        const rendered = await nudger.renderAndStore(workspaceId, {
          ...(layer === undefined ? {} : { layer }),
          ...(overlays === undefined ? {} : { overlays }),
          ...(scale === undefined ? {} : { scale }),
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        });
        const result = emptyServiceResult(workspaceId, {
          revision: rendered.revision,
          width: rendered.bundle.width,
          height: rendered.bundle.height,
          hashes: rendered.bundle.hashes,
          offlineRepresentation: true,
        });
        result.code = 'MAP_RENDERED';
        setInlineFilesScanned(result, rendered.filesScanned);
        result.artifacts = rendered.artifacts.map(publicArtifactLink);
        await progress.report(3, 3, 'Map render complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.map_rewrite',
    {
      title: 'Create or clean up map content',
      description:
        'Create or clean up states, provinces, regions, adjacencies, networks, positions, locators, and localisation with exact declarative operations, apply them in one call, and return pixel and semantic review artifacts.',
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          operations: z.array(mapOperationSchema).min(1).max(100),
          diffScale: z.number().int().min(1).max(16).optional(),
        })
        .strict(),
      outputSchema: mapPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, operations, diffScale }, extra) => {
      try {
        requireServerScope(context, 'hoi4:write');
        const progress = progressReporter(extra);
        await progress.report(0, 5, 'Planning map operations and visual diff');
        const typedOperations = operations as MapOperation[];
        const planned = await nudger.planRewriteWithDiff({
          workspaceId,
          operations: typedOperations,
          ...(diffScale === undefined ? {} : { diffScale }),
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        });
        const diff = planned;
        await progress.report(3, 5, 'Preparing the map rewrite');
        await progress.report(4, 5, 'Applying and validating the map rewrite');
        const execution = await executePlannedTransaction(
          engine,
          planned.transaction,
          context.principal,
          progress.signal,
        );
        const transaction = execution.transaction;
        const compactSemantic = compactMapSemanticDiff(diff.bundle.semantic);
        const result = emptyServiceResult(workspaceId, {
          execution: execution.outcome,
          allocations: planned.plan.allocations.slice(0, 100).map(compactAllocationEvidence),
          operationBlockers: planned.plan.blockers
            .slice(0, 100)
            .map(({ code, message, operationId }) => ({ code, message, operationId })),
          expectedChangedBounds: planned.plan.expectedChangedBounds ?? null,
          changedProvinceIds: diff.bundle.changedProvinceIds.slice(0, 256),
          changedProvinceCount: diff.bundle.changedProvinceIds.length,
          semanticDiff: compactSemantic.semantic,
          semanticDiffCounts: compactSemantic.counts,
          semanticDiffTruncated: compactSemantic.truncated,
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
        setInlineFilesScanned(result, diff.filesScanned);
        result.proposedFiles = transaction.files
          .slice(0, 100)
          .map(({ relativePath }) => relativePath);
        result.changedFiles = transaction.appliedFiles.slice(0, 100);
        result.diagnostics = transaction.diagnostics.slice(0, 100);
        result.artifacts = autonomousResultArtifacts(execution);
        result.validation = transaction.validation;
        result.blockers = [
          ...planned.plan.blockers.map(({ code, message }) => ({
            code,
            message,
          })),
          ...transaction.diagnostics
            .filter(({ severity }) => severity === 'error' || severity === 'blocker')
            .map(({ code, message, details }) => ({
              code,
              message,
              ...(details === undefined ? {} : { details }),
            })),
        ].slice(0, 100);
        await progress.report(
          5,
          5,
          execution.outcome === 'applied'
            ? 'Map rewrite complete'
            : execution.outcome === 'unchanged'
              ? 'Map content already satisfied the operations'
              : 'Map rewrite blocked',
        );
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId, autonomousFailureContext(error));
      }
    },
  );
}
