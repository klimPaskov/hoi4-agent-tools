import { z } from 'zod/v4';

export const workspaceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

const diagnosticCodeSchema = z.string().min(1).max(256);
const diagnosticMessageSchema = z.string().max(4096);
const sourceDisplayPathSchema = z.string().min(1).max(4096);
const sourceSymbolSchema = z.string().max(1024);

export const workspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\0'), 'Path contains a NUL byte')
  .refine((value) => !/^(?:[A-Za-z]:|[\\/])/u.test(value), 'Path must be workspace-relative')
  .refine(
    (value) => !value.replaceAll('\\', '/').split('/').includes('..'),
    'Parent path segments are forbidden',
  );

export const sourcePositionSchema = z
  .object({
    line: z.number().int().min(1),
    column: z.number().int().min(1),
    offset: z.number().int().min(0),
  })
  .strict();

export const sourceLocationSchema = z
  .object({
    path: sourceDisplayPathSchema,
    start: sourcePositionSchema,
    end: sourcePositionSchema,
    symbol: sourceSymbolSchema.optional(),
  })
  .strict();

export const diagnosticSchema = z
  .object({
    code: diagnosticCodeSchema,
    severity: z.enum(['info', 'warning', 'error', 'blocker']),
    category: z.enum([
      'syntax',
      'reference',
      'layout',
      'design',
      'rendering',
      'security',
      'validation',
      'map',
      'configuration',
    ]),
    message: diagnosticMessageSchema,
    location: sourceLocationSchema.optional(),
    related: z.array(sourceLocationSchema).max(100).optional(),
    operationId: z.string().max(256).optional(),
    details: z.record(z.string().max(256), z.unknown()).optional(),
  })
  .strict();
