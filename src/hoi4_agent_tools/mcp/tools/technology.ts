import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { publicArtifactLink } from '../../core/artifacts.js';
import { compareCodeUnits, hashCanonical } from '../../core/canonical.js';
import type { CoreEngine } from '../../core/engine.js';
import { emptyServiceResult } from '../../core/result.js';
import { workspaceIdSchema } from '../../schemas/common.js';
import {
  technologyDefectClassSchema,
  technologyDirectionSchema,
  technologyGraphReferenceSchema,
  technologyIdSchema,
  technologyImpactSchema,
  technologyProposedSourceSchema,
  technologyRenderViewSchema,
  technologyUnlockKindSchema,
} from '../../schemas/technology.js';
import type { TechnologyGraphSnapshot } from '../../technology/model.js';
import {
  TechnologyTreeViewer,
  technologyDiagnostics,
  type TechnologyAnalysisInput,
  type TechnologyCompareInput,
  type TechnologyRenderServiceInput,
} from '../../technology/service.js';
import { compactValidatedInputSchema } from '../server/context-schemas.js';
import { nonNegativeIntegerSchema, sha256Schema } from '../server/output-schemas.js';
import { progressReporter } from '../server/progress.js';
import {
  errorResult,
  setInlineFilesScanned,
  strictOperationResultSchema,
  toolResult,
} from '../server/result.js';
import type { ServerContext } from '../server/base-tools.js';

const technologyMode = z.enum([
  'scan',
  'folders',
  'trace',
  'explain',
  'unlocks',
  'bonus_coverage',
  'lint',
  'impact',
]);
const inspectInput = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: technologyMode,
    folderId: technologyIdSchema.optional(),
    technologyId: technologyIdSchema.optional(),
    categoryId: technologyIdSchema.optional(),
    targetKind: technologyUnlockKindSchema.optional(),
    targetId: technologyIdSchema.optional(),
    direction: technologyDirectionSchema.optional(),
    maxDepth: z.number().int().min(1).max(256).optional(),
    maxNodes: z.number().int().min(1).max(25_000).optional(),
    includeSubTechnologies: z.boolean().optional(),
    classifications: z.array(technologyDefectClassSchema).max(4).optional(),
    codes: z.array(z.string().min(1).max(256)).max(100).optional(),
    impact: compactValidatedInputSchema(
      technologyImpactSchema,
      'Rename or removal subject.',
    ).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.mode === 'trace' || value.mode === 'explain') && value.technologyId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['technologyId'],
        message: `${value.mode} requires technologyId`,
      });
    if (value.mode === 'impact' && value.impact === undefined)
      context.addIssue({
        code: 'custom',
        path: ['impact'],
        message: 'Impact mode requires impact',
      });
  });
const renderInput = z
  .object({
    workspaceId: workspaceIdSchema,
    view: technologyRenderViewSchema.exclude(['comparison']),
    folderId: technologyIdSchema.optional(),
    technologyId: technologyIdSchema.optional(),
    categoryId: technologyIdSchema.optional(),
    targetId: technologyIdSchema.optional(),
    maxNodes: z.number().int().min(1).max(2_000).optional(),
    includeHtml: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.view === 'folder' && value.folderId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['folderId'],
        message: 'Folder view requires folderId',
      });
  });
const compareInput = z
  .object({
    workspaceId: workspaceIdSchema,
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
    render: z.boolean().optional(),
    maxRenderNodes: z.number().int().min(1).max(2_000).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.after !== undefined && value.proposedSources !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['after'],
        message: 'after conflicts with proposedSources',
      });
  });

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
const analysisOutput = strictOperationResultSchema(
  z
    .object({
      mode: technologyMode,
      revision: sha256Schema,
      graphHash: sha256Schema,
      counts: countsSchema,
    })
    .strict(),
);
const renderOutput = strictOperationResultSchema(
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
const compareOutput = strictOperationResultSchema(
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
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function graphHash(graph: TechnologyGraphSnapshot): string {
  return hashCanonical({
    schemaVersion: graph.schemaVersion,
    workspaceIdentity: graph.workspaceIdentity,
    revision: graph.revision,
    statistics: graph.statistics,
    sourceHashes: graph.sourceHashes,
  });
}

function counts(graph: TechnologyGraphSnapshot, artifacts: number) {
  return {
    technologies: graph.statistics.technologyCount,
    legacyDoctrines: graph.statistics.legacyDoctrineCount,
    folders: graph.statistics.folderCount,
    placements: graph.statistics.placementCount,
    edges: graph.edges.length,
    unlocks: graph.statistics.unlockCount,
    references: graph.statistics.externalReferenceCount,
    issues: graph.statistics.issueCount,
    unresolved: graph.statistics.unresolvedCount,
    artifacts,
  };
}

function validation(graph: TechnologyGraphSnapshot) {
  const blocking = technologyDiagnostics(graph).filter(
    ({ severity }) => severity === 'error' || severity === 'blocker',
  ).length;
  return {
    passed: graph.complete && blocking === 0,
    checks: [
      {
        id: 'technology-analysis',
        passed: graph.complete && blocking === 0,
        message: graph.complete
          ? `${blocking} blocking technology diagnostics; full evidence is linked`
          : `${graph.skippedSourceCount} source(s) were skipped; full evidence is linked`,
      },
    ],
  };
}

type AnalysisValues = {
  [Key in keyof Omit<TechnologyAnalysisInput, 'workspaceId' | 'mode' | 'principal' | 'signal'>]?:
    Omit<TechnologyAnalysisInput, 'workspaceId' | 'mode' | 'principal' | 'signal'>[Key] | undefined;
};

function analysisRequest(
  input: z.infer<typeof inspectInput>,
  workspaceId: string,
  context: ServerContext,
  signal: AbortSignal,
): TechnologyAnalysisInput {
  const impact =
    input.impact === undefined
      ? undefined
      : {
          kind: input.impact.kind,
          id: input.impact.id,
          operation: input.impact.operation,
          ...(input.impact.replacementId === undefined
            ? {}
            : { replacementId: input.impact.replacementId }),
        };
  const values: AnalysisValues = {
    folderId: input.folderId,
    technologyId: input.technologyId,
    categoryId: input.categoryId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    direction: input.direction,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    includeSubTechnologies: input.includeSubTechnologies,
    classifications: input.classifications,
    codes: input.codes,
    impact,
    refresh: input.refresh,
  };
  const compact = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Omit<TechnologyAnalysisInput, 'workspaceId' | 'mode' | 'principal' | 'signal'>;
  return {
    workspaceId,
    mode: input.mode,
    ...compact,
    ...(context.principal === undefined ? {} : { principal: context.principal }),
    signal,
  };
}

export function registerTechnologyTools(
  server: McpServer,
  engine: CoreEngine,
  context: ServerContext,
): void {
  const viewer = new TechnologyTreeViewer(engine);
  server.registerTool(
    'hoi4.tech_inspect',
    {
      title: 'Inspect technology trees',
      description:
        'Scan, discover folders, trace, explain, inspect unlocks or bonuses, lint, and assess impact.',
      inputSchema: inspectInput,
      outputSchema: analysisOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const workspaceId = engine.resolver.resolveWorkspaceId(input.workspaceId, context.principal);
      try {
        const progress = progressReporter(extra);
        await progress.report(0, 2, 'Analyzing technologies');
        const output = await viewer.analyze(
          analysisRequest(input, workspaceId, context, progress.signal),
        );
        const result = emptyServiceResult(workspaceId, {
          mode: input.mode,
          revision: output.graph.revision,
          graphHash: graphHash(output.graph),
          counts: counts(output.graph, output.artifacts.length),
        });
        result.code = output.graph.complete ? 'TECH_INSPECTED' : 'TECH_INSPECTED_PARTIAL';
        setInlineFilesScanned(result, output.graph.filesScanned);
        result.artifacts = output.artifacts.map(publicArtifactLink);
        result.validation = validation(output.graph);
        await progress.report(2, 2, 'Technology analysis complete');
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.tech_render',
    {
      title: 'Render technology trees',
      description: 'Render source-linked JSON, SVG, PNG, and optional HTML technology views.',
      inputSchema: renderInput,
      outputSchema: renderOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const workspaceId = engine.resolver.resolveWorkspaceId(input.workspaceId, context.principal);
      try {
        const progress = progressReporter(extra);
        const request: TechnologyRenderServiceInput = {
          workspaceId,
          view: input.view,
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          ...(input.technologyId === undefined ? {} : { technologyId: input.technologyId }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
          ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
          ...(input.includeHtml === undefined ? {} : { includeHtml: input.includeHtml }),
          ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        };
        const output = await viewer.renderAndStore(request);
        const result = emptyServiceResult(workspaceId, {
          view: output.render.view,
          revision: output.graph.revision,
          graphHash: graphHash(output.graph),
          hashes: output.render.hashes,
          selectedNodes: output.render.selectedIds.length,
          omittedNodes: output.render.omittedNodeCount,
          focusedRenders: output.focused.length,
          sourceAccurate: output.render.sourceAccurate,
        });
        result.code = output.graph.complete ? 'TECH_RENDERED' : 'TECH_RENDERED_PARTIAL';
        setInlineFilesScanned(result, output.graph.filesScanned);
        result.artifacts = output.artifacts.map(publicArtifactLink);
        result.validation = validation(output.graph);
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );

  server.registerTool(
    'hoi4.tech_compare',
    {
      title: 'Compare technology trees',
      description:
        'Compare cached, resource-backed, current, or proposed source graphs without writes.',
      inputSchema: compareInput,
      outputSchema: compareOutput,
      annotations: readOnly,
    },
    async (input, extra) => {
      const workspaceId = engine.resolver.resolveWorkspaceId(input.workspaceId, context.principal);
      try {
        const progress = progressReporter(extra);
        const request: TechnologyCompareInput = {
          workspaceId,
          ...(input.before === undefined
            ? {}
            : { before: input.before as NonNullable<TechnologyCompareInput['before']> }),
          ...(input.after === undefined
            ? {}
            : { after: input.after as NonNullable<TechnologyCompareInput['after']> }),
          ...(input.proposedSources === undefined
            ? {}
            : {
                proposedSources: input.proposedSources as NonNullable<
                  TechnologyCompareInput['proposedSources']
                >,
              }),
          ...(input.render === undefined ? {} : { render: input.render }),
          ...(input.maxRenderNodes === undefined ? {} : { maxRenderNodes: input.maxRenderNodes }),
          ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
          ...(context.principal === undefined ? {} : { principal: context.principal }),
          signal: progress.signal,
        };
        const output = await viewer.compareAndStore(request);
        const comparison = output.comparison;
        const result = emptyServiceResult(workspaceId, {
          beforeRevision: comparison.beforeRevision,
          afterRevision: comparison.afterRevision,
          added: comparison.technologies.added.length,
          removed: comparison.technologies.removed.length,
          renamed: comparison.technologies.renamed.length,
          moved: comparison.technologies.moved.length,
          regressions: comparison.regressions.length,
          artifacts: output.artifacts.length,
          ...(output.render === undefined ? {} : { renderHashes: output.render.hashes }),
        });
        result.code =
          output.before.complete && output.after.complete
            ? 'TECH_COMPARED'
            : 'TECH_COMPARED_PARTIAL';
        setInlineFilesScanned(
          result,
          [...new Set([...output.before.filesScanned, ...output.after.filesScanned])].sort(
            compareCodeUnits,
          ),
        );
        result.artifacts = output.artifacts.map(publicArtifactLink);
        result.validation = {
          passed: validation(output.before).passed && validation(output.after).passed,
          checks: [...validation(output.before).checks, ...validation(output.after).checks],
        };
        return toolResult(result);
      } catch (error) {
        return errorResult(error, workspaceId);
      }
    },
  );
}
