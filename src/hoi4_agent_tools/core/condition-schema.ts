import { z } from 'zod';

export const ConditionControlMapSchema = z
  .record(z.string().regex(/^[1-9][0-9]{0,8}$/u), z.string().regex(/^[A-Z0-9]{3}$/u))
  .refine((value) => Object.keys(value).length <= 2_048, 'Too many declared state controllers');

export const GuiScenarioDateSchema = z
  .string()
  .max(16)
  .refine((value) => {
    const match = /^(\d{1,4})[.-](\d{1,2})[.-](\d{1,2})$/u.exec(value);
    if (match === null) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
  }, 'Use a valid YYYY.M.D or YYYY-MM-DD date')
  .transform((value) => value.split(/[.-]/u).map(Number).join('.'));

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
