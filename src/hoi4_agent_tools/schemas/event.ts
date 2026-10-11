import { z } from 'zod/v4';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { workspaceIdSchema, workspaceRelativePathSchema } from './common.js';
import { helperExpansionRequestSchema, validateHelperExpansionMode } from './helper-expansion.js';

const eventIdSchema = z.string().min(1).max(256);
const eventSourcePathSchema = z.string().min(1).max(1024);
const eventNodeIdSchema = z.string().min(1).max(1024);
const eventSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const eventInspectModeSchema = z.enum([
  'scan',
  'roots',
  'trace',
  'explain_path',
  'state_flow',
  'lint',
  'impact',
  'helper_expansion',
]);

export const eventDirectionSchema = z.enum(['upstream', 'downstream', 'both']);

export const eventRenderViewSchema = z.enum([
  'overview',
  'neighborhood',
  'options',
  'entries',
  'reachability',
  'timing',
  'state',
  'targets',
  'scope',
  'terminals',
  'unresolved',
]);

export const eventFeatureManifestSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    eventIds: z.array(eventIdSchema).max(2_000).optional(),
    namespaces: z.array(z.string().min(1).max(256)).max(500).optional(),
    sourcePaths: z.array(eventSourcePathSchema).max(2_000).optional(),
    nodeIds: z.array(eventNodeIdSchema).max(5_000).optional(),
  })
  .strict();

export const eventSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), eventId: eventIdSchema }).strict(),
  z.object({ kind: z.literal('namespace'), namespace: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('file'), sourcePath: eventSourcePathSchema }).strict(),
  z
    .object({
      kind: z.literal('source'),
      sourcePath: eventSourcePathSchema,
      line: z.number().int().positive(),
      column: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('node'), nodeId: eventNodeIdSchema }).strict(),
  z.object({ kind: z.literal('manifest'), manifest: eventFeatureManifestSchema }).strict(),
]);

export const eventStateSubjectSchema = z
  .object({
    kind: z.enum([
      'country_flag',
      'global_flag',
      'state_flag',
      'variable',
      'global_variable',
      'array',
      'event_target',
      'global_event_target',
      'saved_scope',
    ]),
    name: z.string().min(1).max(512),
  })
  .strict();

export const eventImpactSubjectSchema = z
  .object({
    kind: z.enum(['event', 'helper', 'flag', 'variable', 'array', 'event_target', 'saved_scope']),
    name: z.string().min(1).max(512),
  })
  .strict();

export const eventGraphReferenceSchema = z
  .object({
    revision: eventSha256Schema.optional(),
    artifactUri: z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^hoi4-agent:\/\//u)
      .optional(),
  })
  .strict()
  .refine(
    ({ revision, artifactUri }) =>
      Number(revision !== undefined) + Number(artifactUri !== undefined) === 1,
    'Provide exactly one event graph revision or artifact URI',
  );

export const eventProposedSourceSchema = z
  .object({
    relativePath: workspaceRelativePathSchema,
    source: z.string().max(SOURCE_MAX_BYTES).nullable(),
    expectedSourceHash: eventSha256Schema.optional(),
  })
  .strict();

export function validateEventInspectRequest(
  value: {
    mode: string;
    selector?: unknown;
    from?: unknown;
    to?: unknown;
    impactSubject?: unknown;
  },
  context: z.RefinementCtx,
): void {
  validateHelperExpansionMode(value, context);
  if (value.mode === 'trace' && value.selector === undefined)
    context.addIssue({ code: 'custom', path: ['selector'], message: 'Trace requires selector' });
  if (value.mode === 'explain_path' && (value.from === undefined || value.to === undefined))
    context.addIssue({
      code: 'custom',
      path: value.from === undefined ? ['from'] : ['to'],
      message: 'Path explanation requires from and to',
    });
  if (value.mode === 'impact' && value.impactSubject === undefined)
    context.addIssue({
      code: 'custom',
      path: ['impactSubject'],
      message: 'Impact analysis requires impactSubject',
    });
}

export const eventRenderRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    view: eventRenderViewSchema,
    selector: eventSelectorSchema.optional(),
    direction: eventDirectionSchema.optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    maxNodes: z.number().int().min(1).max(240).optional(),
    expandHelpers: z.boolean().optional(),
    includeHtml: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export function validateEventCompareRequest(
  value: {
    after?: unknown;
    proposedSources?: unknown;
    selector?: unknown;
    maxChainNodes?: unknown;
  },
  context: z.RefinementCtx,
): void {
  if (value.after !== undefined && value.proposedSources !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['after'],
      message: 'after and proposedSources are mutually exclusive',
    });
  if (value.maxChainNodes !== undefined && value.selector === undefined)
    context.addIssue({
      code: 'custom',
      path: ['maxChainNodes'],
      message: 'maxChainNodes requires selector',
    });
}

export const eventCompareRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    before: eventGraphReferenceSchema.optional(),
    after: eventGraphReferenceSchema.optional(),
    proposedSources: z.array(eventProposedSourceSchema).min(1).max(64).optional(),
    selector: eventSelectorSchema.optional(),
    maxChainNodes: z.number().int().min(1).max(5_000).optional(),
    render: z.boolean().optional(),
    maxRenderNodes: z.number().int().min(1).max(240).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine(validateEventCompareRequest);

export const eventInspectToolModeSchema = z.enum([...eventInspectModeSchema.options, 'compare']);

const compareOnlyFields = [
  'before',
  'after',
  'proposedSources',
  'maxChainNodes',
  'render',
  'maxRenderNodes',
] as const;
const inspectOnlyFields = [
  'from',
  'to',
  'direction',
  'maxDepth',
  'maxNodes',
  'maxEdges',
  'expandHelpers',
  'stateSubject',
  'impactSubject',
  'helperExpansion',
] as const;

/**
 * Inspection and comparison share one tool: mode compare diffs a cached, artifact or proposed
 * event graph against another, every other mode analyzes the current graph.
 */
export const eventInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    mode: eventInspectToolModeSchema,
    selector: eventSelectorSchema.optional(),
    from: eventSelectorSchema.optional(),
    to: eventSelectorSchema.optional(),
    direction: eventDirectionSchema.optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    maxNodes: z.number().int().min(1).max(5_000).optional(),
    maxEdges: z.number().int().min(1).max(20_000).optional(),
    expandHelpers: z.boolean().optional(),
    stateSubject: eventStateSubjectSchema.optional(),
    impactSubject: eventImpactSubjectSchema.optional(),
    helperExpansion: helperExpansionRequestSchema.optional(),
    before: eventGraphReferenceSchema.optional(),
    after: eventGraphReferenceSchema.optional(),
    proposedSources: z.array(eventProposedSourceSchema).min(1).max(64).optional(),
    maxChainNodes: z.number().int().min(1).max(5_000).optional(),
    render: z.boolean().optional(),
    maxRenderNodes: z.number().int().min(1).max(240).optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine(validateEventInspectToolRequest);

export function validateEventInspectToolRequest(
  value: Record<string, unknown> & { mode: string },
  context: z.RefinementCtx,
): void {
  const compare = value.mode === 'compare';
  for (const field of compare ? inspectOnlyFields : compareOnlyFields)
    if (value[field] !== undefined)
      context.addIssue({
        code: 'custom',
        path: [field],
        message: compare
          ? `${field} is not used by mode compare`
          : `${field} is used only by mode compare`,
      });
  if (compare)
    validateEventCompareRequest(
      value as Parameters<typeof validateEventCompareRequest>[0],
      context,
    );
  else validateEventInspectRequest(value, context);
}

/** Split an inspect request into a comparison or an analysis of the current graph. */
export function splitEventInspectRequest(
  input: z.infer<typeof eventInspectRequestSchema>,
):
  | { compare: true; request: z.infer<typeof eventCompareRequestSchema> }
  | { compare: false; request: Record<string, unknown> } {
  const { mode, ...rest } = input;
  if (mode === 'compare') {
    const request: Record<string, unknown> = { workspaceId: rest.workspaceId };
    for (const field of [...compareOnlyFields, 'selector', 'refresh'] as const)
      if (rest[field] !== undefined) request[field] = rest[field];
    return { compare: true, request: eventCompareRequestSchema.parse(request) };
  }
  return { compare: false, request: { ...rest, mode } };
}
