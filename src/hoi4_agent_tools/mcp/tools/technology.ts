import { registerLegacyTaskTools } from '../server/legacy-task-tools.js';
import type { TaskToolDefinition } from '../server/task-tool-definition.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod/v4';
import {
  helperExpansionRequestSchema,
  helperExpansionSummarySchema,
} from '../../schemas/helper-expansion.js';
import {
  technologyAnalysisModeSchema,
  technologyCompareRequestSchema,
  technologyGraphReferenceSchema,
  technologyImpactSchema,
  technologyInspectRequestSchema,
  technologyProposedSourceSchema,
  technologyRenderRequestSchema,
  technologyRenderViewSchema,
  validateTechnologyCompareRequest,
  validateTechnologyInspectRequest,
} from '../../schemas/technology.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { strictOperationResultSchema } from '../server/result.js';

const inspectInputSchema = z
  .object({
    ...technologyInspectRequestSchema.shape,
    helperExpansion: compactValidatedInputSchema(
      helperExpansionRequestSchema,
      'Bounded helper paths; opaque continuationUri resumes the same source and roots. See docs/technology.md.',
    ).optional(),
    impact: compactValidatedInputSchema(
      technologyImpactSchema,
      'Rename or removal subject.',
    ).optional(),
  })
  .strict()
  .superRefine(validateTechnologyInspectRequest);

const renderInputSchema = z.object({ ...technologyRenderRequestSchema.shape }).strict();

const compareInputSchema = z
  .object({
    ...technologyCompareRequestSchema.shape,
    before: compactValidatedInputSchema(
      technologyGraphReferenceSchema,
      'Revision or graph resource.',
    ).optional(),
    after: compactValidatedInputSchema(
      technologyGraphReferenceSchema,
      'Revision or graph resource.',
    ).optional(),
    proposedSources: z
      .array(
        compactValidatedInputSchema(technologyProposedSourceSchema, 'In-memory source overlay.'),
      )
      .min(1)
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine(validateTechnologyCompareRequest);

const countsSchema = z
  .object({
    technologies: nonNegativeIntegerSchema,
    legacyDoctrines: nonNegativeIntegerSchema,
    folders: nonNegativeIntegerSchema,
    placements: nonNegativeIntegerSchema,
    edges: nonNegativeIntegerSchema,
    unlocks: nonNegativeIntegerSchema,
    references: nonNegativeIntegerSchema,
    issues: nonNegativeIntegerSchema,
    unresolved: nonNegativeIntegerSchema,
    artifacts: nonNegativeIntegerSchema,
  })
  .strict();

const analysisOutputSchema = strictOperationResultSchema(
  z
    .object({
      mode: technologyAnalysisModeSchema,
      revision: sha256Schema,
      graphHash: sha256Schema,
      counts: countsSchema,
      helperExpansion: helperExpansionSummarySchema.optional(),
    })
    .strict(),
);

const renderOutputSchema = strictOperationResultSchema(
  z
    .object({
      view: technologyRenderViewSchema,
      revision: sha256Schema,
      graphHash: sha256Schema,
      hashes: z
        .object({
          json: sha256Schema,
          svg: sha256Schema,
          png: sha256Schema,
          html: sha256Schema.optional(),
        })
        .strict(),
      selectedNodes: nonNegativeIntegerSchema,
      omittedNodes: nonNegativeIntegerSchema,
      focusedRenders: nonNegativeIntegerSchema,
      sourceAccurate: z.boolean(),
    })
    .strict(),
);

const compareOutputSchema = strictOperationResultSchema(
  z
    .object({
      beforeRevision: sha256Schema,
      afterRevision: sha256Schema,
      added: nonNegativeIntegerSchema,
      removed: nonNegativeIntegerSchema,
      renamed: nonNegativeIntegerSchema,
      moved: nonNegativeIntegerSchema,
      regressions: nonNegativeIntegerSchema,
      artifacts: nonNegativeIntegerSchema,
      renderHashes: z
        .object({ json: sha256Schema, svg: sha256Schema, png: sha256Schema })
        .strict()
        .optional(),
    })
    .strict(),
);

const readOnlyTechnologyTool = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const technologyTaskTools = [
  {
    name: 'hoi4.tech_inspect',
    title: 'Inspect technology trees',
    description:
      'Scan, discover folders, trace, explain, inspect unlocks or bonuses, lint, and assess impact.',
    inputSchema: inspectInputSchema,
    outputSchema: analysisOutputSchema,
    annotations: readOnlyTechnologyTool,
  },
  {
    name: 'hoi4.tech_render',
    title: 'Render technology trees',
    description: 'Render source-linked JSON, SVG, PNG, and optional HTML technology views.',
    inputSchema: renderInputSchema,
    outputSchema: renderOutputSchema,
    annotations: readOnlyTechnologyTool,
  },
  {
    name: 'hoi4.tech_compare',
    title: 'Compare technology trees',
    description:
      'Compare cached, resource-backed, current, or proposed source graphs without writes.',
    inputSchema: compareInputSchema,
    outputSchema: compareOutputSchema,
    annotations: readOnlyTechnologyTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerTechnologyTools(server: McpServer): void {
  registerLegacyTaskTools(server, technologyTaskTools);
}
