import { z } from 'zod/v4';
import { diagnosticSchema, sourceLocationSchema, workspaceIdSchema } from './common.js';
import { artifactLinkSchema } from './transaction.js';

export const probabilityAdapterIdSchema = z.enum([
  'event_mean_time_to_happen',
  'event_option_ai_chance',
  'decision_ai_will_do',
  'mission_ai_will_do',
  'national_focus_ai_will_do',
  'technology_ai_will_do',
  'doctrine_ai_will_do',
  'direct_random',
  'random_list',
  'ai_strategy_factor',
  'custom_weighted_pool',
]);

const scalarSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const scenarioValueSchema = z.union([scalarSchema, z.array(scalarSchema).max(100_000)]);
const workspaceReferenceSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

const distributionSchema = z
  .object({
    kind: z.enum(['uniform', 'triangular', 'normal', 'lognormal', 'categorical', 'empirical']),
    min: z.number().optional(),
    max: z.number().optional(),
    mode: z.number().optional(),
    mean: z.number().optional(),
    stddev: z.number().positive().optional(),
    values: z.array(scalarSchema).min(1).max(100_000).optional(),
    probabilities: z.array(z.number().min(0).max(1)).min(1).max(100_000).optional(),
  })
  .strict()
  .superRefine((distribution, context) => {
    if (
      (distribution.kind === 'uniform' || distribution.kind === 'triangular') &&
      (distribution.min === undefined ||
        distribution.max === undefined ||
        distribution.min > distribution.max)
    )
      context.addIssue({ code: 'custom', message: `${distribution.kind} requires min <= max` });
    if (
      distribution.kind === 'triangular' &&
      (distribution.mode === undefined ||
        distribution.min === undefined ||
        distribution.max === undefined ||
        distribution.mode < distribution.min ||
        distribution.mode > distribution.max)
    )
      context.addIssue({ code: 'custom', message: 'triangular mode must be inside min and max' });
    if (
      (distribution.kind === 'normal' || distribution.kind === 'lognormal') &&
      (distribution.mean === undefined || distribution.stddev === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: `${distribution.kind} requires mean and stddev`,
      });
    if (
      (distribution.kind === 'categorical' || distribution.kind === 'empirical') &&
      distribution.values === undefined
    )
      context.addIssue({ code: 'custom', message: `${distribution.kind} requires values` });
    if (
      distribution.probabilities !== undefined &&
      distribution.values !== undefined &&
      distribution.probabilities.length !== distribution.values.length
    )
      context.addIssue({ code: 'custom', message: 'probabilities must match values length' });
    if (
      distribution.probabilities !== undefined &&
      Math.abs(distribution.probabilities.reduce((sum, value) => sum + value, 0) - 1) > 1e-9
    )
      context.addIssue({ code: 'custom', message: 'probabilities must sum to one' });
  });

const uncertainInputSchema = z
  .object({
    path: z.string().min(1).max(1024),
    range: z.object({ min: z.number(), max: z.number() }).strict().optional(),
    alternatives: z.array(scalarSchema).min(1).max(100_000).optional(),
    distribution: distributionSchema.optional(),
    unresolved: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const variants = [value.range, value.alternatives, value.distribution, value.unresolved].filter(
      (entry) => entry !== undefined,
    );
    if (variants.length !== 1)
      context.addIssue({
        code: 'custom',
        message:
          'Each uncertain input requires exactly one range, alternatives, distribution, or unresolved marker',
      });
    if (value.range !== undefined && value.range.min > value.range.max)
      context.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'Range min must not exceed max',
      });
  });

export const probabilityScenarioSchema = z
  .object({
    id: z.string().min(1).max(512),
    label: z.string().max(4096).optional(),
    prevalence: z.number().min(0).max(1).optional(),
    actor: z.string().max(256).optional(),
    date: z.string().max(64).optional(),
    state: z.record(z.string().min(1).max(1024), scenarioValueSchema),
    flags: z.array(z.string().min(1).max(512)).max(100_000).optional(),
    eventTargets: z.record(z.string().max(512), z.string().max(512)).optional(),
    candidateOverrides: z.record(z.string().max(512), z.boolean()).optional(),
    uncertainInputs: z.array(uncertainInputSchema).max(10_000).optional(),
    correlations: z
      .array(
        z
          .object({
            left: z.string().min(1).max(1024),
            right: z.string().min(1).max(1024),
            coefficient: z.number().min(-1).max(1),
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
    schedule: z
      .array(
        z
          .object({
            atDay: z.number().min(0),
            set: z.record(z.string().max(1024), scenarioValueSchema),
            clearFlags: z.array(z.string().max(512)).max(100_000).optional(),
            addFlags: z.array(z.string().max(512)).max(100_000).optional(),
          })
          .strict(),
      )
      .max(100_000)
      .optional(),
  })
  .strict()
  .superRefine((scenario, context) => {
    const paths = scenario.uncertainInputs?.map(({ path }) => path) ?? [];
    if (new Set(paths).size !== paths.length)
      context.addIssue({
        code: 'custom',
        path: ['uncertainInputs'],
        message: 'Uncertain input paths must be unique within a scenario',
      });
    for (const [index, correlation] of (scenario.correlations ?? []).entries()) {
      if (!paths.includes(correlation.left) || !paths.includes(correlation.right))
        context.addIssue({
          code: 'custom',
          path: ['correlations', index],
          message: 'Correlation endpoints must name uncertain inputs in this scenario',
        });
      if (correlation.left === correlation.right)
        context.addIssue({
          code: 'custom',
          path: ['correlations', index],
          message: 'Self-correlation is implicit and must not be declared',
        });
    }
  });

export const probabilityScenarioSetSchema = z
  .object({
    schemaVersion: z.literal('1.0').default('1.0'),
    id: z.string().min(1).max(512),
    workspaceId: workspaceReferenceSchema.optional(),
    description: z.string().max(8192).optional(),
    surfaceHint: probabilityAdapterIdSchema.optional(),
    scenarios: z.array(probabilityScenarioSchema).min(1).max(10_000),
  })
  .strict();

export const probabilityMetricSchema = z.enum([
  'conditional_probability',
  'raw_value',
  'cumulative_chance',
  'effective_mtth_days',
]);

export const probabilityAcceptanceBandSchema = z
  .object({
    id: z.string().min(1).max(512),
    label: z.string().max(4096).optional(),
    scenarioId: z.string().min(1).max(512).optional(),
    candidateId: z.string().min(1).max(512),
    metric: probabilityMetricSchema,
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
  .superRefine((band, context) => {
    if (band.min === undefined && band.max === undefined)
      context.addIssue({ code: 'custom', message: 'Acceptance band requires min, max, or both' });
    if (band.min !== undefined && band.max !== undefined && band.min > band.max)
      context.addIssue({ code: 'custom', message: 'Acceptance band min must not exceed max' });
    if (
      (band.metric === 'conditional_probability' || band.metric === 'cumulative_chance') &&
      ((band.min !== undefined && (band.min < 0 || band.min > 1)) ||
        (band.max !== undefined && (band.max < 0 || band.max > 1)))
    )
      context.addIssue({
        code: 'custom',
        message: `${band.metric} acceptance bounds must be between zero and one`,
      });
  });

export const probabilityDiagnosticThresholdsSchema = z
  .object({
    dominantProbability: z.number().min(0).max(1).optional(),
    dominantScenarioPrevalence: z.number().min(0).max(1).optional(),
    starvedProbability: z.number().min(0).max(1).optional(),
    negligibleCumulativeChance: z.number().min(0).max(1).optional(),
    extremeGrowthRatio: z.number().positive().optional(),
    thresholdCliffDelta: z.number().positive().optional(),
    rareOutcomeMinimumObservations: z.number().int().positive().optional(),
  })
  .strict();

export const probabilitySamplingMethodSchema = z.enum(['latin_hypercube', 'pseudo_random']);

export const probabilitySourceSchema = z
  .object({
    identifier: z.string().min(1).max(1024).optional(),
    path: z.string().min(1).max(1024).optional(),
    line: z.number().int().min(1).optional(),
    inlineClausewitz: z.string().max(16_777_216).optional(),
    virtualPatch: z.string().max(16_777_216).optional(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.identifier !== undefined ||
      value.path !== undefined ||
      value.inlineClausewitz !== undefined ||
      value.virtualPatch !== undefined,
    'Source requires an identifier, path, inline Clausewitz source, or virtual patch',
  );

const customPoolCandidateSchema = z
  .object({
    id: z.string().min(1).max(512),
    category: z.string().max(512).optional(),
    weight: z.union([z.number(), z.string().max(1024)]),
    cap: z.union([z.number(), z.string().max(1024)]).optional(),
    eligibleWhen: z.string().max(4096).optional(),
    oneTime: z.boolean().optional(),
    cooldownDays: z.number().min(0).optional(),
  })
  .strict();

const customPoolActionSchema = z
  .object({
    operation: z.enum([
      'set',
      'add',
      'multiply',
      'cap',
      'remove',
      'cooldown',
      'reset_category',
      'compress_timer',
      'reset_timer',
      'terminate',
    ]),
    target: z.string().min(1).max(1024),
    value: scalarSchema.optional(),
  })
  .strict();

export const customWeightedPoolManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0').default('1.0'),
    id: z.string().min(1).max(512),
    description: z.string().max(8192).optional(),
    selection: z
      .object({
        mode: z.enum(['categorical_weighted', 'independent_chances']),
        cadence: z.enum(['daily', 'weekly', 'monthly', 'timer']),
        timerMinDays: z.number().min(0).optional(),
        timerMaxDays: z.number().min(0).optional(),
        rounding: z.enum(['exact', 'floor', 'ceil', 'nearest']).optional(),
      })
      .strict(),
    state: z.record(z.string().max(1024), scalarSchema).optional(),
    candidates: z.array(customPoolCandidateSchema).min(1).max(100_000),
    recovery: z
      .array(
        z
          .object({
            cadence: z.enum(['daily', 'weekly', 'monthly']),
            target: z.string().min(1).max(1024),
            amount: z.union([z.number(), z.string().max(1024)]),
            cap: z.union([z.number(), z.string().max(1024)]).optional(),
          })
          .strict(),
      )
      .max(100_000)
      .optional(),
    transitions: z
      .array(
        z
          .object({
            when: z.string().max(4096),
            actions: z.array(customPoolActionSchema).max(100_000),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    const candidateIds = new Set(manifest.candidates.map(({ id }) => id));
    if (candidateIds.size !== manifest.candidates.length)
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Candidate IDs must be unique',
      });
    if (
      manifest.selection.timerMinDays !== undefined &&
      manifest.selection.timerMaxDays !== undefined &&
      manifest.selection.timerMinDays > manifest.selection.timerMaxDays
    )
      context.addIssue({
        code: 'custom',
        path: ['selection'],
        message: 'timerMinDays must not exceed timerMaxDays',
      });
    const categories = new Set(
      manifest.candidates.flatMap(({ category }) => (category === undefined ? [] : [category])),
    );
    const validateTarget = (target: string, path: Array<string | number>): void => {
      if (target === 'selected.candidate' || target === 'selection') return;
      if (target.startsWith('state.')) {
        if (!Object.hasOwn(manifest.state ?? {}, target.slice('state.'.length)))
          context.addIssue({
            code: 'custom',
            path,
            message: `Transition target ${target} is not declared in state`,
          });
        return;
      }
      if (target.startsWith('candidate.')) {
        const id = target.split('.')[1];
        if (id === undefined || !candidateIds.has(id))
          context.addIssue({
            code: 'custom',
            path,
            message: `Transition target ${target} names an unknown candidate`,
          });
        return;
      }
      if (target.startsWith('category.')) {
        const id = target.slice('category.'.length);
        if (!categories.has(id))
          context.addIssue({
            code: 'custom',
            path,
            message: `Transition target ${target} names an unknown category`,
          });
        return;
      }
      if (target.startsWith('selection.')) return;
      context.addIssue({
        code: 'custom',
        path,
        message: `Transition target ${target} is outside declared pool state`,
      });
    };
    for (const [index, recovery] of (manifest.recovery ?? []).entries())
      validateTarget(recovery.target, ['recovery', index, 'target']);
    for (const [transitionIndex, transition] of manifest.transitions.entries())
      for (const [actionIndex, action] of transition.actions.entries())
        validateTarget(action.target, [
          'transitions',
          transitionIndex,
          'actions',
          actionIndex,
          'target',
        ]);
  });

export const probabilityOutputSchema = z.enum([
  'json',
  'ranking',
  'matrix',
  'waterfall',
  'timing',
  'sensitivity',
  'threshold',
  'sequence',
  'comparison',
  'unresolved',
]);

export const probabilityRenderFilterSchema = z
  .object({
    scenarioIds: z.array(z.string().min(1).max(512)).max(10_000).optional(),
    candidateIds: z.array(z.string().min(1).max(512)).max(100_000).optional(),
    diagnosticSeverities: z
      .array(z.enum(['info', 'warning', 'error', 'blocker']))
      .max(4)
      .optional(),
    sourcePaths: z.array(z.string().min(1).max(4096)).max(10_000).optional(),
    metrics: z.array(probabilityMetricSchema).max(4).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100_000).default(10_000),
  })
  .strict();

export const probabilityCommonInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema,
    source: probabilitySourceSchema,
    scenarioSet: probabilityScenarioSetSchema,
    candidatePool: z.array(z.string().min(1).max(512)).max(100_000).optional(),
    horizonDays: z.number().positive().max(1_000_000).optional(),
    metrics: z.array(probabilityMetricSchema).min(1).max(4).optional(),
    acceptanceBands: z.array(probabilityAcceptanceBandSchema).max(100_000).optional(),
    diagnosticThresholds: probabilityDiagnosticThresholdsSchema.optional(),
    outputs: z.array(probabilityOutputSchema).max(10).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export const probabilityInspectInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema.optional(),
    source: probabilitySourceSchema.optional(),
    candidatePool: z.array(z.string().min(1).max(512)).max(100_000).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export const probabilityEvaluateInputSchema = probabilityCommonInputSchema;

export const probabilitySweepInputSchema = probabilityCommonInputSchema
  .extend({
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

export const probabilitySimulateInputSchema = probabilityCommonInputSchema
  .extend({
    samples: z.number().int().min(100).max(10_000_000).default(100_000),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(1),
    confidenceLevel: z.number().min(0.5).max(0.9999).default(0.95),
    samplingMethod: probabilitySamplingMethodSchema.default('latin_hypercube'),
  })
  .strict();

export const probabilitySequenceInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    scenarioSet: probabilityScenarioSetSchema,
    customPoolManifest: customWeightedPoolManifestSchema,
    horizonDays: z.number().positive().max(1_000_000),
    maxSteps: z.number().int().min(1).max(100_000).default(1_000),
    samples: z.number().int().min(100).max(10_000_000).default(100_000),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(1),
    confidenceLevel: z.number().min(0.5).max(0.9999).default(0.95),
    acceptanceBands: z.array(probabilityAcceptanceBandSchema).max(100_000).optional(),
    diagnosticThresholds: probabilityDiagnosticThresholdsSchema.optional(),
    outputs: z.array(probabilityOutputSchema).max(10).optional(),
  })
  .strict();

export const probabilityCompareInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    adapter: probabilityAdapterIdSchema,
    before: probabilitySourceSchema,
    after: probabilitySourceSchema,
    scenarioSet: probabilityScenarioSetSchema,
    candidatePool: z.array(z.string().min(1).max(512)).max(100_000).optional(),
    horizonDays: z.number().positive().max(1_000_000).optional(),
    acceptanceBands: z.array(probabilityAcceptanceBandSchema).max(100_000).optional(),
    diagnosticThresholds: probabilityDiagnosticThresholdsSchema.optional(),
    outputs: z.array(probabilityOutputSchema).max(10).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export const probabilityRenderInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    analysisId: z.string().min(1).max(256),
    expectedScenarioHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    outputs: z.array(probabilityOutputSchema).min(1).max(10),
    includeHtml: z.boolean().default(false),
    filter: probabilityRenderFilterSchema.optional(),
  })
  .strict();

const rationalJsonSchema = z
  .object({
    numerator: z.string().regex(/^-?\d+$/u),
    denominator: z.string().regex(/^\d+$/u),
    decimal: z.string(),
    value: z.number(),
  })
  .strict();

const probabilityProvenanceSchema = z
  .object({
    path: z.string(),
    rootKind: z.string(),
    loadOrder: z.number().int(),
    sourceHash: z.string(),
    location: sourceLocationSchema.optional(),
    astPath: z.array(z.string()).optional(),
    symbol: z.string().optional(),
    helperChain: z.array(z.string()).optional(),
  })
  .strict();

const probabilityUnresolvedSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
    candidateId: z.string().optional(),
    provenance: probabilityProvenanceSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const valueTraceSchema = z
  .object({
    operation: z.enum(['base', 'add', 'factor', 'eligibility', 'external_factor', 'normalization']),
    expression: z.string(),
    applied: z.enum(['true', 'false', 'unresolved']),
    value: rationalJsonSchema.optional(),
    before: rationalJsonSchema.optional(),
    after: rationalJsonSchema.optional(),
    provenance: probabilityProvenanceSchema.optional(),
    conditionExpression: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const adapterDescriptorSchema = z
  .object({
    id: probabilityAdapterIdSchema,
    version: z.string(),
    gameVersion: z.string(),
    supportedGameVersions: z.array(z.string()),
    selectionRule: z.enum([
      'proportional_categorical',
      'uniform_score_race',
      'independent_chance',
      'median_daily_hazard',
      'score_only',
      'custom_declared',
    ]),
    capabilities: z
      .object({
        eligibility: z.boolean(),
        rawScore: z.boolean(),
        normalizedProbability: z.boolean(),
        timeDistribution: z.boolean(),
        sequence: z.boolean(),
      })
      .strict(),
    completePoolRequired: z.boolean(),
    confidence: z.enum(['documented', 'documented_with_runtime_boundary', 'manifest_defined']),
    sourceBlockTypes: z.array(z.string()),
    candidateDiscoveryRules: z.array(z.string()),
    eligibilityRules: z.array(z.string()),
    modifierOrder: z.array(z.string()),
    poolNormalizationRules: z.array(z.string()),
    evaluationCadence: z.string(),
    timingConversion: z.array(z.string()),
    scopeExpectations: z.array(z.string()),
    supportedExpressions: z.array(z.string()),
    unsupportedConstructs: z.array(z.string()),
    evidence: z.array(z.string()),
    testFixtures: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();

const candidateAnalysisSchema = z
  .object({
    id: z.string(),
    eligibility: z.enum(['true', 'false', 'unresolved']),
    supportLevel: z.enum(['exact', 'bounded', 'sampled', 'score_only', 'external', 'unsupported']),
    rawValue: rationalJsonSchema.nullable().optional(),
    rawInterval: z.object({ min: z.number(), max: z.number() }).strict().optional(),
    conditionalProbability: z.number().min(0).max(1).nullable().optional(),
    exactConditionalProbability: rationalJsonSchema.optional(),
    pathProbability: z.number().min(0).max(1).nullable().optional(),
    exactPathProbability: rationalJsonSchema.optional(),
    pathProbabilityInterval: z
      .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
      .strict()
      .optional(),
    conditionalProbabilityInterval: z
      .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
      .strict()
      .optional(),
    confidenceInterval: z
      .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
      .strict()
      .optional(),
    sampledFrequency: z.number().min(0).max(1).optional(),
    effectiveMtthDays: z.number().nonnegative().optional(),
    timingModel: z.string().optional(),
    timingQuantilesDays: z
      .object({ p10: z.number(), p50: z.number(), p90: z.number(), p95: z.number() })
      .strict()
      .optional(),
    timingQuantileIntervals: z
      .object({
        p10: z.object({ low: z.number(), high: z.number() }).strict(),
        p50: z.object({ low: z.number(), high: z.number() }).strict(),
        p90: z.object({ low: z.number(), high: z.number() }).strict(),
        p95: z.object({ low: z.number(), high: z.number() }).strict(),
      })
      .strict()
      .optional(),
    timingSampleCount: z.number().int().nonnegative().optional(),
    timingEvaluations: z.number().int().nonnegative().optional(),
    timingReservoirCapacity: z.number().int().positive().optional(),
    timingMethod: z.literal('sampled_discrete_daily_hazard').optional(),
    timingConfidenceMethod: z.literal('normal_order_statistic').optional(),
    cumulativeChance: z.number().min(0).max(1).optional(),
    cumulativeChanceInterval: z
      .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
      .strict()
      .optional(),
    rank: z.number().int().min(1).nullable().optional(),
    trace: z.array(valueTraceSchema),
    provenance: z.array(probabilityProvenanceSchema),
    unresolved: z.array(probabilityUnresolvedSchema),
  })
  .strict();

const scenarioAnalysisSchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    prevalence: z.number().min(0).max(1).optional(),
    poolComplete: z.boolean(),
    supportLevel: z.enum(['exact', 'bounded', 'sampled', 'score_only', 'external', 'unsupported']),
    candidates: z.array(candidateAnalysisSchema),
    poolTotal: rationalJsonSchema.optional(),
    horizonDays: z.number().positive().optional(),
    survivalChance: z.number().min(0).max(1).optional(),
    survivalChanceInterval: z
      .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
      .strict()
      .optional(),
    timingIntervals: z
      .array(
        z
          .object({
            startDay: z.number().nonnegative(),
            endDay: z.number().nonnegative(),
            eligibility: z.enum(['true', 'false', 'unresolved']),
            effectiveMtthDays: z.number().nonnegative().optional(),
            minimumHazardContribution: z.number().nonnegative(),
            maximumHazardContribution: z.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    summary: z
      .object({
        topOutcomes: z.array(z.string()),
        bottomEligibleOutcomes: z.array(z.string()),
        impossibleOutcomes: z.array(z.string()),
        unresolvedOutcomes: z.array(z.string()),
        dominantFactors: z.array(z.string()),
        closestRankReversal: z
          .object({
            candidates: z.tuple([z.string(), z.string()]),
            gap: z.number().nonnegative(),
            metric: z.enum(['probability', 'raw_value']),
          })
          .strict()
          .optional(),
      })
      .strict(),
    unresolved: z.array(probabilityUnresolvedSchema),
  })
  .strict();

const probabilityMetadataSchema = z
  .object({
    workspaceId: z.string(),
    workspaceIdentity: z.string(),
    sourceRevision: z.string(),
    sourceHash: z.string(),
    scenarioHash: z.string(),
    candidatePoolHash: z.string(),
    gameVersion: z.string(),
    gameVersionVerification: z
      .object({
        status: z.enum(['workspace_verified', 'adapter_target_only']),
        adapterTarget: z.string(),
        sourcePath: z.string().optional(),
        observedVersion: z.string().optional(),
        observedRawVersion: z.string().optional(),
        observedChecksum: z.string().optional(),
      })
      .strict(),
    adapterId: probabilityAdapterIdSchema,
    adapterVersion: z.string(),
    requestedMetrics: z.array(probabilityMetricSchema).min(1).max(4).optional(),
    seed: z.number().int().optional(),
    samples: z.number().int().nonnegative().optional(),
    numericalPrecision: z.string(),
    cacheKey: z.string(),
  })
  .strict();

const sweepPointSchema = z
  .object({
    scenarioId: z.string(),
    path: z.string(),
    value: z.number(),
    values: z.record(z.string(), z.number()).optional(),
    candidates: z.array(
      z
        .object({
          id: z.string(),
          rawValue: z.number().optional(),
          conditionalProbability: z.number().optional(),
          rank: z.number().int().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const localElasticitySchema = z
  .object({
    scenarioId: z.string(),
    path: z.string(),
    candidateId: z.string(),
    metric: z.enum(['conditional_probability', 'raw_value']),
    between: z.tuple([z.number(), z.number()]),
    slope: z.number(),
    elasticity: z.number().optional(),
  })
  .strict();

const pairwiseInteractionSchema = z
  .object({
    scenarioId: z.string(),
    paths: z.tuple([z.string(), z.string()]),
    candidateId: z.string(),
    metric: z.enum(['conditional_probability', 'raw_value']),
    cell: z
      .object({ left: z.tuple([z.number(), z.number()]), right: z.tuple([z.number(), z.number()]) })
      .strict(),
    mixedDifference: z.number(),
    mixedDifferencePerUnit: z.number(),
  })
  .strict();

const simulationSummarySchema = z
  .object({
    scenarioId: z.string(),
    samples: z.number().int().positive(),
    seed: z.number().int(),
    samplingMethod: probabilitySamplingMethodSchema,
    rng: z.literal('mulberry32'),
    stoppingRule: z.literal('fixed_sample_budget'),
    confidenceLevel: z.number().min(0.5).max(0.9999),
    confidenceMethod: z.literal('wilson_score'),
    effectiveSampleSize: z.number().int().nonnegative(),
    globalImportance: z.array(
      z
        .object({
          path: z.string(),
          candidateId: z.string(),
          metric: z.literal('raw_value'),
          score: z.number().min(0).max(1),
          method: z.literal('absolute_pearson_correlation'),
          observations: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    convergence: z
      .object({
        firstHalfSamples: z.number().int().nonnegative(),
        secondHalfSamples: z.number().int().nonnegative(),
        maximumFrequencyDelta: z.number().min(0).max(1),
      })
      .strict(),
    candidates: z.array(
      z
        .object({
          id: z.string(),
          frequency: z.number().min(0).max(1).optional(),
          confidenceInterval: z
            .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
            .strict()
            .optional(),
          observedSelections: z.number().int().nonnegative().optional(),
          rawMean: z.number().optional(),
          eligibilityFrequency: z.number().min(0).max(1),
          timingQuantilesDays: z
            .object({ p10: z.number(), p50: z.number(), p90: z.number(), p95: z.number() })
            .strict()
            .optional(),
          timingQuantileIntervals: z
            .object({
              p10: z.object({ low: z.number(), high: z.number() }).strict(),
              p50: z.object({ low: z.number(), high: z.number() }).strict(),
              p90: z.object({ low: z.number(), high: z.number() }).strict(),
              p95: z.object({ low: z.number(), high: z.number() }).strict(),
            })
            .strict()
            .optional(),
          timingSampleCount: z.number().int().nonnegative().optional(),
          timingEvaluations: z.number().int().nonnegative().optional(),
          timingReservoirCapacity: z.number().int().positive().optional(),
          timingMethod: z.literal('sampled_discrete_daily_hazard').optional(),
          timingConfidenceMethod: z.literal('normal_order_statistic').optional(),
        })
        .strict(),
    ),
  })
  .strict();

const sequenceSummarySchema = z
  .object({
    scenarioId: z.string(),
    method: z.enum(['exact_state_distribution', 'bounded_beam', 'seeded_monte_carlo']),
    steps: z.number().int().nonnegative(),
    samples: z.number().int().positive().optional(),
    seed: z.number().int().optional(),
    rng: z.literal('mulberry32').optional(),
    stoppingRule: z.literal('fixed_sample_budget').optional(),
    confidenceLevel: z.number().min(0.5).max(0.9999).optional(),
    terminalProbability: z.number().min(0).max(1),
    stateCount: z.number().int().nonnegative(),
    omittedProbability: z.number().min(0).max(1).optional(),
    candidates: z.array(
      z
        .object({
          id: z.string(),
          nextSelectionProbability: z.number().min(0).max(1),
          expectedSelections: z.number().nonnegative(),
          everSelectedProbability: z.number().min(0).max(1),
          starvationProbability: z.number().min(0).max(1),
          expectedFirstSelectionDay: z.number().nonnegative().optional(),
          countDistribution: z.array(
            z
              .object({
                count: z.number().int().nonnegative(),
                probability: z.number().min(0).max(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    categories: z.array(
      z
        .object({
          id: z.string(),
          nextSelectionProbability: z.number().min(0).max(1),
          expectedSelections: z.number().nonnegative(),
          everSelectedProbability: z.number().min(0).max(1),
          starvationProbability: z.number().min(0).max(1),
          expectedFirstSelectionDay: z.number().nonnegative().optional(),
        })
        .strict(),
    ),
    topPaths: z.array(
      z
        .object({
          candidateIds: z.array(z.string()),
          probability: z.number().min(0).max(1),
          terminal: z.boolean(),
          endDay: z.number().nonnegative(),
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          step: z.number().int().nonnegative(),
          day: z.number().nonnegative(),
          leadingCandidate: z.string().optional(),
          terminalProbability: z.number().min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict();

const comparisonSummarySchema = z
  .object({
    beforeAnalysisId: z.string(),
    afterAnalysisId: z.string(),
    scenarioChanges: z.array(
      z
        .object({
          scenarioId: z.string(),
          candidateId: z.string(),
          rawDelta: z.number().optional(),
          probabilityDelta: z.number().optional(),
          timingDeltaDays: z.number().optional(),
          cumulativeChanceDelta: z.number().optional(),
          rankDelta: z.number().int().optional(),
          eligibilityChange: z
            .object({
              before: z.enum(['true', 'false', 'unresolved']),
              after: z.enum(['true', 'false', 'unresolved']),
            })
            .strict()
            .optional(),
          unresolvedDelta: z.number().int(),
          attribution: z.array(z.string()),
          changedAstPaths: z.array(
            z
              .object({
                change: z.enum(['added', 'removed']),
                path: z.string(),
                astPath: z.array(z.string()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    assumptionsChanged: z.boolean(),
    adapterChanged: z.boolean(),
    regressions: z.array(
      z
        .object({
          code: z.string(),
          message: z.string(),
          scenarioId: z.string().optional(),
          candidateId: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const probabilityAnalysisResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    status: z.enum(['complete', 'partial', 'blocked', 'cancelled', 'stale']),
    operation: z.enum([
      'inspect',
      'evaluate',
      'sweep',
      'simulate',
      'sequence',
      'compare',
      'render',
    ]),
    analysisId: z.string(),
    metadata: probabilityMetadataSchema,
    adapter: adapterDescriptorSchema,
    scenarios: z.array(scenarioAnalysisSchema),
    prevalenceAggregate: z
      .object({
        prevalenceTotal: z.number().nonnegative(),
        candidates: z.array(
          z
            .object({
              id: z.string(),
              eligibilityPrevalence: z.number().min(0).max(1),
              weightedConditionalProbability: z.number().min(0).max(1).optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    diagnostics: z.array(diagnosticSchema),
    unresolved: z.array(probabilityUnresolvedSchema),
    sweep: z
      .object({
        points: z.array(sweepPointSchema),
        rankReversals: z.array(
          z
            .object({
              scenarioId: z.string(),
              path: z.string(),
              between: z.tuple([z.number(), z.number()]),
              beforeLeader: z.string(),
              afterLeader: z.string(),
            })
            .strict(),
        ),
        breakpoints: z.array(sweepPointSchema),
        localElasticities: z.array(localElasticitySchema),
        pairwiseInteractions: z.array(pairwiseInteractionSchema),
      })
      .strict()
      .optional(),
    simulation: z.array(simulationSummarySchema).optional(),
    sequence: sequenceSummarySchema.optional(),
    comparison: comparisonSummarySchema.optional(),
    resources: z.array(artifactLinkSchema),
  })
  .strict();
