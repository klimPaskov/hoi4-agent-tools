import { z } from 'zod/v4';
import {
  customWeightedPoolManifestSchema,
  probabilityAcceptanceBandSchema,
  probabilityAdapterIdSchema,
  probabilityDiagnosticThresholdsSchema,
  probabilityMetricSchema,
  probabilityOutputSchema,
  probabilityRenderFilterSchema,
  probabilityScenarioSetSchema,
  probabilitySamplingMethodSchema,
  probabilitySourceSchema,
} from './probability.js';
import { workspaceIdSchema } from './common.js';

function compact<T extends z.ZodType>(schema: T, description: string): z.ZodPipe<z.ZodUnknown, T> {
  return z.unknown().describe(description).pipe(schema);
}

const nestedSource = compact(probabilitySourceSchema, 'Source selector or proposed source.');
const nestedScenarios = compact(probabilityScenarioSetSchema, 'Explicit world-state scenarios.');
const nestedManifest = compact(
  customWeightedPoolManifestSchema,
  'Declared custom weighted pool and state transitions.',
);
const nestedRenderFilter = compact(
  probabilityRenderFilterSchema,
  'Optional scenario, candidate, metric, diagnostic, source, and page filter.',
);
const nestedAcceptanceBands = compact(
  z.array(probabilityAcceptanceBandSchema).max(100_000),
  'Optional named metric acceptance bands.',
);
const nestedDiagnosticThresholds = compact(
  probabilityDiagnosticThresholdsSchema,
  'Optional diagnostic thresholds.',
);
const candidatePool = z.array(z.string().min(1).max(512)).max(100_000).optional();
const outputs = z.array(probabilityOutputSchema).max(10).optional();
const commonShape = {
  workspaceId: workspaceIdSchema,
  adapter: probabilityAdapterIdSchema.optional(),
  scenarioSet: nestedScenarios,
  candidatePool,
  horizonDays: z.number().positive().max(1_000_000).optional(),
  metrics: z.array(probabilityMetricSchema).min(1).max(4).optional(),
  acceptanceBands: nestedAcceptanceBands.optional(),
  diagnosticThresholds: nestedDiagnosticThresholds.optional(),
  outputs,
  refresh: z.boolean().optional(),
} as const;

export const probabilityInspectRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema.optional(),
    source: nestedSource.optional(),
    customPoolManifest: nestedManifest.optional(),
    candidatePool,
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source !== undefined && value.customPoolManifest !== undefined)
      context.addIssue({ code: 'custom', message: 'Provide either source or customPoolManifest' });
    if (
      value.adapter !== undefined &&
      value.source === undefined &&
      value.customPoolManifest === undefined
    )
      context.addIssue({
        code: 'custom',
        message:
          'An adapter requires a source; provide a source alone to discover compatible adapters',
      });
    if (
      value.customPoolManifest !== undefined &&
      value.adapter !== undefined &&
      value.adapter !== 'custom_weighted_pool'
    )
      context.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: 'customPoolManifest requires adapter custom_weighted_pool',
      });
  });

export const probabilityEvaluateRequestSchema = z
  .object({
    ...commonShape,
    source: nestedSource.optional(),
    customPoolManifest: nestedManifest.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.source === undefined) === (value.customPoolManifest === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one source or customPoolManifest',
      });
    if (
      value.customPoolManifest !== undefined &&
      value.adapter !== undefined &&
      value.adapter !== 'custom_weighted_pool'
    )
      context.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: 'customPoolManifest requires adapter custom_weighted_pool',
      });
  });

export const probabilitySweepRequestSchema = z
  .object({
    ...commonShape,
    source: nestedSource,
    sweep: z
      .object({
        paths: z.array(z.string().min(1).max(1024)).min(1).max(32),
        steps: z.number().int().min(2).max(10_000).default(25),
        pairwise: z.boolean().default(false),
        findRankReversals: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();

export const probabilitySimulateRequestSchema = z
  .object({
    ...commonShape,
    source: nestedSource,
    samples: z.number().int().min(100).max(10_000_000).default(100_000),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(1),
    confidenceLevel: z.number().min(0.5).max(0.9999).default(0.95),
    samplingMethod: probabilitySamplingMethodSchema.default('latin_hypercube'),
  })
  .strict();

export const probabilitySequenceRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    scenarioSet: nestedScenarios,
    customPoolManifest: nestedManifest,
    horizonDays: z.number().positive().max(1_000_000),
    maxSteps: z.number().int().min(1).max(100_000).default(1_000),
    samples: z.number().int().min(100).max(10_000_000).default(100_000),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(1),
    confidenceLevel: z.number().min(0.5).max(0.9999).default(0.95),
    acceptanceBands: nestedAcceptanceBands.optional(),
    diagnosticThresholds: nestedDiagnosticThresholds.optional(),
    outputs,
  })
  .strict();

export const probabilityCompareRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema.optional(),
    before: nestedSource.optional(),
    after: nestedSource.optional(),
    beforeManifest: nestedManifest.optional(),
    afterManifest: nestedManifest.optional(),
    scenarioSet: nestedScenarios,
    candidatePool,
    horizonDays: z.number().positive().max(1_000_000).optional(),
    acceptanceBands: nestedAcceptanceBands.optional(),
    diagnosticThresholds: nestedDiagnosticThresholds.optional(),
    outputs,
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const sourceMode = value.before !== undefined || value.after !== undefined;
    const manifestMode = value.beforeManifest !== undefined || value.afterManifest !== undefined;
    if (sourceMode === manifestMode)
      context.addIssue({
        code: 'custom',
        message: 'Compare either before/after sources or beforeManifest/afterManifest',
      });
    if (sourceMode && (value.before === undefined || value.after === undefined))
      context.addIssue({ code: 'custom', message: 'Source comparison requires before and after' });
    if (manifestMode && (value.beforeManifest === undefined || value.afterManifest === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Custom-pool comparison requires beforeManifest and afterManifest',
      });
    if (manifestMode && value.adapter !== undefined && value.adapter !== 'custom_weighted_pool')
      context.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: 'Manifest comparison requires adapter custom_weighted_pool',
      });
  });

export const probabilityRenderRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    analysisId: z.string().min(1).max(256),
    expectedScenarioHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    outputs: z.array(probabilityOutputSchema).min(1).max(10),
    includeHtml: z.boolean().default(false),
    filter: nestedRenderFilter.optional(),
  })
  .strict();

export type ProbabilityInspectToolRequest = z.infer<typeof probabilityInspectRequestSchema>;
export type ProbabilityEvaluateToolRequest = z.infer<typeof probabilityEvaluateRequestSchema>;
export type ProbabilitySweepToolRequest = z.infer<typeof probabilitySweepRequestSchema>;
export type ProbabilitySimulateToolRequest = z.infer<typeof probabilitySimulateRequestSchema>;
export type ProbabilitySequenceToolRequest = z.infer<typeof probabilitySequenceRequestSchema>;
export type ProbabilityCompareToolRequest = z.infer<typeof probabilityCompareRequestSchema>;
export type ProbabilityRenderToolRequest = z.infer<typeof probabilityRenderRequestSchema>;
