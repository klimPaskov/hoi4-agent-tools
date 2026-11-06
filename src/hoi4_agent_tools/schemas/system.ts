import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';
import { fieldSchema, placeSchema, problemSchema, textSchema } from './ideas.js';

/** The systems `hoi4.system_inspect` reads, one engine kind each. */
export const systemKinds = [
  'on_actions',
  'mio',
  'balance_of_power',
  'special_project',
  'operation',
  'raid',
] as const;

/** `hoi4.system_inspect`, answered by `hoi4-engine system`. */
export const systemInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** on_actions: a hook. mio: an organization or policy. special_project: a project, prototype reward, specialization or tag. operation: an operation, phase or token. raid: a raid or raid category. */
    kind: z.enum(systemKinds),
    /** The definition (or on_actions hook) to inspect. Leave it out with audit. */
    id: z.string().min(1).max(256).optional(),
    /** Check every definition of this system the mod makes instead of one. */
    audit: z.boolean().default(false),
    /** One: mentions listed. Audit: examples kept per problem code. */
    limit: z.number().int().min(1).max(50).default(5),
  })
  .strict()
  .refine((input) => input.audit || input.id !== undefined, {
    message: 'pass an id, or audit: true',
    path: ['id'],
  });

/** The kinds `hoi4.unit_inspect` reads, answered by `hoi4-engine units`. */
export const unitKinds = ['oob', 'sub_unit', 'equipment', 'variant'] as const;

/** One definition, as the engine answers it. */
const engineInspectionShape = (kinds: readonly [string, ...string[]]) =>
  z
    .object({
      kind: z.enum(kinds),
      id: z.string().max(256),
      found: z.boolean(),
      definitions: z.array(placeSchema.extend({ what: z.string().max(64) })).max(512),
      fields: z.array(fieldSchema).max(32),
      parts: z
        .array(
          z
            .object({ what: z.string().max(64), id: z.string().max(256), line: z.number().int() })
            .strict(),
        )
        .max(100),
      partsTruncated: z.boolean(),
      references: z
        .array(
          z
            .object({
              field: z.string().max(128),
              target: z.string().max(64),
              value: z.string().max(512),
              known: z.boolean(),
              line: z.number().int(),
            })
            .strict(),
        )
        .max(100),
      referencesTruncated: z.boolean(),
      texts: z
        .array(z.object({ key: z.string().max(512), texts: z.array(textSchema).max(64) }).strict())
        .max(8),
      mentions: z
        .array(
          z
            .object({ path: z.string().max(1024), line: z.number().int(), layer: z.string() })
            .strict(),
        )
        .max(100),
      mentionsTruncated: z.boolean(),
      problems: z.array(problemSchema).max(1000),
      suggestions: z.array(z.string().max(256)).max(3).optional(),
    })
    .strict();

export const systemEngineInspectionSchema = engineInspectionShape(systemKinds);

/** Every definition of the system the mod makes, as the engine answers an audit. */
const engineAuditShape = (kinds: readonly [string, ...string[]]) =>
  z
    .object({
      kind: z.enum(kinds),
      checked: z.number().int().min(0),
      counts: z.record(z.string(), z.number().int().min(0)),
      problems: z
        .array(
          z
            .object({
              code: z.string().max(64),
              severity: z.enum(['warning', 'info']),
              id: z.string().max(256),
              path: z.string().max(1024),
              line: z.number().int().min(0),
              message: z.string().max(1200),
            })
            .strict(),
        )
        .max(5000),
      truncated: z.boolean(),
    })
    .strict();

export const systemEngineAuditSchema = engineAuditShape(systemKinds);

export const systemInspectDataSchema = z
  .object({
    inspection: systemEngineInspectionSchema.optional(),
    audit: systemEngineAuditSchema.optional(),
    durationMs: z.number().int().min(0),
  })
  .strict();

/** `hoi4.unit_inspect`, answered by `hoi4-engine units`. */
export const unitInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** oob: a history/units file name without .txt. sub_unit, equipment (or module): its id. variant: its name. */
    kind: z.enum(unitKinds),
    /** The definition to inspect. Leave it out with audit. */
    id: z.string().min(1).max(256).optional(),
    /** Check every definition of this kind the mod makes instead of one. */
    audit: z.boolean().default(false),
    /** One: mentions listed. Audit: examples kept per problem code. */
    limit: z.number().int().min(1).max(50).default(5),
  })
  .strict()
  .refine((input) => input.audit || input.id !== undefined, {
    message: 'pass an id, or audit: true',
    path: ['id'],
  });

export const unitEngineInspectionSchema = engineInspectionShape(unitKinds);
export const unitEngineAuditSchema = engineAuditShape(unitKinds);

export const unitInspectDataSchema = z
  .object({
    inspection: unitEngineInspectionSchema.optional(),
    audit: unitEngineAuditSchema.optional(),
    durationMs: z.number().int().min(0),
  })
  .strict();
