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
  technologyGraphReferenceSchema,
  technologyImpactSchema,
  technologyInspectRequestSchema,
  technologyProposedSourceSchema,
  technologyRenderRequestSchema,
  validateTechnologyRenderRequest,
  technologyRenderViewSchema,
  validateTechnologyInspectToolRequest,
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
    before: compactValidatedInputSchema(
      technologyGraphReferenceSchema,
      'Mode compare: revision or graph resource.',
    ).optional(),
    after: compactValidatedInputSchema(
      technologyGraphReferenceSchema,
      'Mode compare: revision or graph resource.',
    ).optional(),
    proposedSources: z
      .array(
        compactValidatedInputSchema(
          technologyProposedSourceSchema,
          'Mode compare: in-memory source overlay.',
        ),
      )
      .min(1)
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine(validateTechnologyInspectToolRequest);

const renderInputSchema = z
  .object({ ...technologyRenderRequestSchema.shape })
  .strict()
  .superRefine(validateTechnologyRenderRequest);

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

const analysisDataSchema = z
  .object({
    mode: technologyAnalysisModeSchema,
    revision: sha256Schema,
    graphHash: sha256Schema,
    counts: countsSchema,
    helperExpansion: helperExpansionSummarySchema.optional(),
    /** Mode explain: the technology, its direct neighbours and unlocks (20 names each at most). */
    technology: z
      .object({
        id: z.string(),
        path: z.string(),
        line: z.number().int().min(0),
        name: z.string().optional(),
        startYear: z.string().optional(),
        researchCost: z.string().optional(),
        folders: z.array(z.string()),
        categories: z.array(z.string()),
        prerequisites: z.array(z.string()).max(20),
        leadsTo: z.array(z.string()).max(20),
        exclusiveWith: z.array(z.string()).max(20),
        unlocks: z.array(z.object({ kind: z.string(), targetId: z.string() }).strict()).max(20),
        allPrerequisites: nonNegativeIntegerSchema,
        allDescendants: nonNegativeIntegerSchema,
        unlockCount: nonNegativeIntegerSchema,
        grantedBy: nonNegativeIntegerSchema,
        issues: nonNegativeIntegerSchema,
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

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

const compareDataSchema = z
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
  .strict();

const analysisOutputSchema = strictOperationResultSchema(
  z.union([analysisDataSchema, compareDataSchema]),
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
      'Explain technology and doctrine paths, unlocks, bonuses and dependencies. Find layout or reference problems and compare revisions with mode compare. Example: {"mode":"explain","technologyId":"my_tech"}. Returns counts inline, and for explain the prerequisites, what it leads to and its unlocks; the full report is a linked resource.',
    inputSchema: inspectInputSchema,
    outputSchema: analysisOutputSchema,
    annotations: readOnlyTechnologyTool,
  },
  {
    name: 'hoi4.tech_render',
    title: 'Preview technology trees',
    description:
      'Preview technology folders and doctrines with their icons, item sizes and year guides. Show dependencies, bonuses, grants, unlocks or unresolved references as JSON, SVG and PNG. Example: {"view":"folder","folderId":"my_folder"}. Images are linked artifacts.',
    inputSchema: renderInputSchema,
    outputSchema: renderOutputSchema,
    annotations: readOnlyTechnologyTool,
  },
] satisfies readonly TaskToolDefinition[];

export function registerTechnologyTools(server: McpServer): void {
  registerLegacyTaskTools(server, technologyTaskTools);
}
