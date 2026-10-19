import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod/v4';
import type { CoreEngine } from '../../core/engine.js';
import { mapInspectRequestSchema, mapRewriteRequestSchema } from '../../schemas/map-requests.js';
import type { ServerContext } from '../server/base-tools.js';
import {
  allocationEvidenceSchema,
  bitmapRenderHashesSchema,
  nonNegativeIntegerSchema,
  operationBlockerDataSchema,
  sha256Schema,
} from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

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
const mapWorkspaceInspectDataSchema = z
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
    queryMatchCount: nonNegativeIntegerSchema,
    coordinateMatchCount: nonNegativeIntegerSchema,
    overviewRendered: z.boolean(),
    provinceGeometryCount: nonNegativeIntegerSchema,
    provinceGeometryPixelCount: nonNegativeIntegerSchema,
    provinceGeometryRowRunCount: nonNegativeIntegerSchema,
    lookupOnly: z.boolean().optional(),
    unknownProvinceIds: z.array(nonNegativeIntegerSchema).max(512),
    missingGeometryProvinceIds: z.array(nonNegativeIntegerSchema).max(512),
    scriptReferences: z
      .object({ references: nonNegativeIntegerSchema, missing: nonNegativeIntegerSchema })
      .strict()
      .optional(),
  })
  .strict();
const mapRenderDataSchema = z
  .object({
    revision: sha256Schema,
    width: nonNegativeIntegerSchema,
    height: nonNegativeIntegerSchema,
    hashes: bitmapRenderHashesSchema,
    offlineRepresentation: z.literal(true),
    tile: z
      .object({
        x: nonNegativeIntegerSchema,
        y: nonNegativeIntegerSchema,
        width: nonNegativeIntegerSchema,
        height: nonNegativeIntegerSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const mapInspectOutputSchema = strictOperationResultSchema(
  z.union([mapWorkspaceInspectDataSchema, mapRenderDataSchema]),
);
const mapPlanOutputSchema = strictOperationResultSchema(
  z
    .object({
      execution: z.enum(['applied', 'blocked', 'unchanged', 'preview']),
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
      geography: z
        .array(
          z
            .object({
              operationId: z.string().min(1).max(256),
              modelHash: sha256Schema,
              valid: z.boolean(),
              source: z.enum(['inline', 'file']),
              sourceSha256: sha256Schema,
              width: nonNegativeIntegerSchema,
              height: nonNegativeIntegerSchema,
              featureCount: nonNegativeIntegerSchema,
              pointCount: nonNegativeIntegerSchema,
              counts: z.record(z.string().max(32), nonNegativeIntegerSchema),
              errorCount: nonNegativeIntegerSchema,
              warningCount: nonNegativeIntegerSchema,
              synthesis: z.literal('unavailable'),
            })
            .strict(),
        )
        .max(16)
        .optional(),
      preview: z
        .object({
          offlineRepresentation: z.literal(true),
          width: nonNegativeIntegerSchema,
          height: nonNegativeIntegerSchema,
          provinces: nonNegativeIntegerSchema,
          states: nonNegativeIntegerSchema,
          regions: nonNegativeIntegerSchema,
          countries: nonNegativeIntegerSchema,
          warningCount: nonNegativeIntegerSchema,
        })
        .strict()
        .optional(),
    })
    .strict(),
);

const artifactProducing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const mapTaskTools = [
  {
    name: 'hoi4.map_inspect',
    title: 'Explore and preview the map',
    description:
      'Explore and preview the map. Find provinces, states and regions by name, ID or coordinates, inspect map problems and script references, or render a layer, tile or area. Use lookupOnly for a quick lookup and references:true for script references. Example: {"query":"Brandenburg","lookupOnly":true}. Returns counts and matches inline; PNG, HTML and the catalog are artifacts.',
    inputSchema: mapInspectRequestSchema,
    outputSchema: mapInspectOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.map_rewrite',
    title: 'Build a world or edit the map',
    description:
      'Build a world from a local reference image or edit provinces, states, regions and supply. Example: {"preview":true,"operations":[{"kind":"create_world","reference":{"imagePath":"references/world.png"}}]}. Preview first to check coastlines, terrain and provisional countries; omit preview to write the generated map and starting scenario. Reviewed masks and labels refine ambiguous artwork. create_world also accepts a typed geography model (geography inline or geographyPath to a workspace .json): with preview:true it returns a model overlay PNG and map-geography-report.json; synthesis from the model is not yet available. Returns counts, diagnostics and linked PNGs. Offline validation does not prove game playability.',
    inputSchema: mapRewriteRequestSchema,
    outputSchema: mapPlanOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies readonly TaskToolDefinition[];

export function registerMapTools(
  server: McpServer,
  _engine: CoreEngine,
  _context: ServerContext,
): void {
  registerLegacyTaskTools(server, mapTaskTools);
}
