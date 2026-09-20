import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod/v4';
import type { CoreEngine } from '../../core/engine.js';
import {
  mapInspectRequestSchema,
  mapRenderRequestSchema,
  mapRewriteRequestSchema,
} from '../../schemas/map-requests.js';
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
      queryMatchCount: nonNegativeIntegerSchema,
      coordinateMatchCount: nonNegativeIntegerSchema,
      overviewRendered: z.boolean(),
      provinceGeometryCount: nonNegativeIntegerSchema,
      provinceGeometryPixelCount: nonNegativeIntegerSchema,
      provinceGeometryRowRunCount: nonNegativeIntegerSchema,
      lookupOnly: z.boolean().optional(),
      unknownProvinceIds: z.array(nonNegativeIntegerSchema).max(512),
      missingGeometryProvinceIds: z.array(nonNegativeIntegerSchema).max(512),
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

export const mapTaskTools = [
  {
    name: 'hoi4.map_inspect',
    title: 'Inspect HOI4 map',
    description:
      'Validate and inspect the complete map, or use lookupOnly for bounded coordinate and entity lookups.',
    inputSchema: mapInspectRequestSchema,
    outputSchema: mapWorkspaceInspectOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.map_render',
    title: 'Render map inspection artifacts',
    description:
      'Render searchable full-map PNG, JSON, and HTML, or a reusable source-coordinate tile.',
    inputSchema: mapRenderRequestSchema,
    outputSchema: mapRenderOutputSchema,
    annotations: artifactProducing,
  },
  {
    name: 'hoi4.map_rewrite',
    title: 'Create or clean up map content',
    description: 'Apply map creation, edits, and ID swaps with visual and semantic evidence.',
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
