import { z } from 'zod/v4';
import { SOURCE_MAX_BYTES } from '../core/source/index.js';
import { workspaceRelativePathSchema } from './common.js';

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
