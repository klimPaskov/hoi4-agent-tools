import { z } from 'zod/v4';
import { workspaceIdSchema } from './common.js';
import { errorLogCategorySchema } from './mod-tools.js';

const count = z.number().int().min(0);
const line = z.number().int().min(1);
const logLine = z.string().trim().min(3).max(4000);

export const explainErrorRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** One error.log line, as the game writes it or as hoi4.error_log returns it. */
    line: logLine.optional(),
    /** Up to 10 lines explained in one call. */
    lines: z.array(logLine).min(1).max(10).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.line === undefined) === (value.lines === undefined))
      context.addIssue({
        code: 'custom',
        path: ['line'],
        message: 'Provide either line or lines',
      });
  });

const sourceLayerSchema = z.enum(['mod', 'dependency', 'game', 'unknown']);

export const errorExplanationSchema = z
  .object({
    /** The message explained; a wrapped parser error yields one explanation per message. */
    message: z.string().max(600),
    category: errorLogCategorySchema,
    /** `catalogue`: a reviewed explanation; `known_mistake`: a reviewed rule; `category`: only the category's advice. */
    matched: z.enum(['catalogue', 'known_mistake', 'category']),
    id: z.string().max(64).optional(),
    /** What the game requires. */
    rule: z.string().max(600),
    fix: z.string().max(600),
    /** The command, key, tag or name the message is about. */
    subject: z.string().max(256).optional(),
    /** The kinds of command the game's documentation lists the subject as. */
    documentedAs: z
      .array(z.enum(['effect', 'trigger', 'modifier']))
      .max(3)
      .optional(),
    /** The scripted helpers a loaded file defines with the subject's name. */
    definedBy: z
      .array(z.enum(['scripted_effect', 'scripted_trigger']))
      .max(2)
      .optional(),
    /** Documented or defined names close to the subject. */
    suggestions: z.array(z.string().max(256)).max(3).optional(),
    source: z
      .object({
        relativePath: z.string().max(1024),
        line: line.optional(),
        layer: sourceLayerSchema,
        /** Up to 5 lines around the named line, from the layer that has the file. */
        excerpt: z
          .array(z.object({ line, text: z.string().max(200) }).strict())
          .max(5)
          .optional(),
      })
      .strict()
      .optional(),
    /** What the documentation and the loaded files say about the subject. */
    note: z.string().max(400).optional(),
    /** The tool call that narrows it down. */
    next: z
      .object({
        tool: z.string().max(64),
        arguments: z.record(z.string().max(64), z.union([z.string().max(1024), z.number()])),
      })
      .strict()
      .optional(),
  })
  .strict();

export const explainErrorDataSchema = z
  .object({
    explanations: z.array(errorExplanationSchema).max(20),
    /** Explanations from the reviewed catalogue or a reviewed rule, not only a category. */
    explained: count,
    /** Reviewed explanations the catalogue holds. */
    catalogue: count,
  })
  .strict();

export const healthCheckSchema = z.enum([
  'error_log',
  'engine_check',
  'script',
  'localisation',
  'assets',
]);

export const modHealthRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** The audits to run; all five by default. */
    checks: z.array(healthCheckSchema).min(1).max(5).optional(),
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict();

const nextCallSchema = z
  .object({
    tool: z.string().max(64),
    arguments: z.record(
      z.string().max(64),
      z.union([z.string().max(1024), z.number(), z.boolean()]),
    ),
  })
  .strict();

export const modHealthDataSchema = z
  .object({
    /** `healthy`: every audit ran and found nothing; `incomplete`: nothing found, but an audit could not run. */
    verdict: z.enum(['healthy', 'problems', 'incomplete']),
    problems: z
      .array(
        z
          .object({
            rank: line,
            check: healthCheckSchema,
            severity: z.enum(['error', 'warning']),
            code: z.string().max(128),
            title: z.string().max(300),
            /** Findings of this kind in the mod. */
            count: count,
            examples: z
              .array(
                z
                  .object({
                    message: z.string().max(300),
                    path: z.string().max(1024).optional(),
                    line: line.optional(),
                  })
                  .strict(),
              )
              .max(2),
            fix: z.string().max(400),
            next: nextCallSchema.optional(),
          })
          .strict(),
      )
      .max(10),
    totals: z
      .object({
        problems: count,
        findings: count,
        errors: count,
        warnings: count,
        omitted: count,
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            check: healthCheckSchema,
            status: z.enum(['ran', 'partial', 'unavailable', 'skipped']),
            ms: count,
            findings: count,
            note: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(5),
    checksRun: count,
  })
  .strict();
