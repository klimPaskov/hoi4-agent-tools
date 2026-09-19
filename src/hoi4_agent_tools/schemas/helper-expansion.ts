import { z } from 'zod/v4';

export const helperExpansionRequestSchema = z
  .object({
    rootIds: z.array(z.string().min(1).max(1_024)).min(1).max(2_000).optional(),
    maxDepth: z.number().int().min(1).max(256).optional(),
    maxRecords: z.number().int().min(1).max(5_000).optional(),
    maxWork: z.number().int().min(1).max(100_000).optional(),
    continuationUri: z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^hoi4-agent:\/\//u)
      .optional(),
  })
  .strict();
export type HelperExpansionRequest = z.infer<typeof helperExpansionRequestSchema>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const helperExpansionSummarySchema = z
  .object({
    complete: z.boolean(),
    finished: z.boolean(),
    sourceComplete: z.boolean(),
    maxDepth: count,
    records: count,
    totalRecords: count,
    work: count,
    totalWork: count,
    completedRoots: count,
    totalRoots: count,
    cycles: count,
    depthStops: count,
    continuationUri: z
      .string()
      .max(8_192)
      .regex(/^hoi4-agent:\/\//u)
      .optional(),
  })
  .strict();
export type HelperExpansionSummary = z.infer<typeof helperExpansionSummarySchema>;

/** A dedicated mode must not silently ignore filters belonging to other inspection modes. */
export function validateHelperExpansionMode(value: object, context: z.RefinementCtx): void {
  const fields = value as Record<string, unknown>;
  if (fields.mode !== 'helper_expansion') {
    if (fields.helperExpansion !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['helperExpansion'],
        message: 'helperExpansion requires helper_expansion mode',
      });
    return;
  }
  const allowed = new Set(['workspaceId', 'mode', 'helperExpansion', 'refresh']);
  for (const [field, content] of Object.entries(fields))
    if (content !== undefined && !allowed.has(field))
      context.addIssue({
        code: 'custom',
        path: [field],
        message: 'Use helperExpansion rootIds and bounds in helper_expansion mode',
      });
}
