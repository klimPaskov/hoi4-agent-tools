import { z } from 'zod';

export const ScenarioScalarSchema = z.union([
  z.string().max(16_384),
  z.number(),
  z.boolean(),
  z.null(),
]);
export const ScenarioValueSchema = z.union([
  ScenarioScalarSchema,
  z.array(ScenarioScalarSchema).max(10_000),
]);
export const ConditionScopeBindingSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z
      .enum([
        'country',
        'state',
        'character',
        'unit_leader',
        'operative',
        'strategic_region',
        'province',
        'unknown',
      ])
      .optional(),
    actor: z.string().max(256).optional(),
    state: z.record(z.string(), ScenarioValueSchema).default({}),
    flags: z.array(z.string().max(256)).max(10_000).optional(),
    eventTargets: z.record(z.string(), z.string().max(256)).optional(),
    weight: z.union([z.number(), z.string().max(256)]).optional(),
  })
  .strict();

export const ConditionResultSchema = z
  .object({
    token: z.string(),
    sourcePath: z.string(),
    state: z.enum(['true', 'false', 'unresolved']),
    localisationKey: z.string().optional(),
    unresolved: z.array(z.string()),
  })
  .strict();
