import {
  PROBABILITY_ADAPTER_VERSION,
  VERIFIED_GAME_VERSION,
  type AdapterDescriptor,
  type ProbabilityAdapterId,
} from './model.js';

const evidenceRoot = 'docs/research/probability-adapter-evidence.md';

type AdapterSource = Omit<
  AdapterDescriptor,
  | 'supportedGameVersions'
  | 'candidateDiscoveryRules'
  | 'eligibilityRules'
  | 'modifierOrder'
  | 'poolNormalizationRules'
  | 'timingConversion'
  | 'unsupportedConstructs'
  | 'testFixtures'
>;

const sources: Record<ProbabilityAdapterId, AdapterSource> = {
  event_mean_time_to_happen: {
    id: 'event_mean_time_to_happen',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'median_daily_hazard',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: false,
      timeDistribution: true,
      sequence: false,
    },
    completePoolRequired: false,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['event mean_time_to_happen'],
    evaluationCadence: 'daily while active; inactive triggers are polled every 20 days',
    scopeExpectations: ['event root scope declared by the scenario'],
    supportedExpressions: [
      'base/add/factor',
      'days/months/years',
      'modifiers',
      'script constants',
      'MTTH variables',
    ],
    evidence: [evidenceRoot],
    limitations: [
      'The adapter models the verified daily median-hazard check only while the event trigger remains true.',
      'The inactive-trigger 20-day polling cadence is reported separately and is not invented from missing scheduled state.',
    ],
  },
  event_option_ai_chance: {
    id: 'event_option_ai_chance',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'proportional_categorical',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: true,
    confidence: 'documented',
    sourceBlockTypes: ['event option ai_chance'],
    evaluationCadence: 'when the event option pool is selected',
    scopeExpectations: ['event option root scope declared by the scenario'],
    supportedExpressions: ['base/add/factor', 'modifiers', 'script constants', 'scripted triggers'],
    evidence: [evidenceRoot],
    limitations: [
      'Runtime selection uses the engine d100 path; sub-one-percent outcomes are flagged.',
    ],
  },
  decision_ai_will_do: {
    id: 'decision_ai_will_do',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'score_only',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: false,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: false,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['decision ai_will_do'],
    evaluationCadence: 'decision AI evaluation cadence; selection probability is not modeled',
    scopeExpectations: ['country and target scopes declared by the scenario'],
    supportedExpressions: ['base/add/factor', 'modifiers', 'script constants', 'scripted triggers'],
    evidence: [evidenceRoot],
    limitations: [
      'Decision scores are not normalized without a documented complete selection rule.',
    ],
  },
  mission_ai_will_do: {
    id: 'mission_ai_will_do',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'score_only',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: false,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: false,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['mission ai_will_do'],
    evaluationCadence: 'mission AI evaluation cadence; selection probability is not modeled',
    scopeExpectations: ['country and target scopes declared by the scenario'],
    supportedExpressions: ['base/add/factor', 'modifiers', 'script constants', 'scripted triggers'],
    evidence: [evidenceRoot],
    limitations: [
      'Mission scores are not normalized without a documented complete selection rule.',
    ],
  },
  national_focus_ai_will_do: {
    id: 'national_focus_ai_will_do',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'uniform_score_race',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: true,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['national focus ai_will_do'],
    evaluationCadence: 'next-focus selection',
    scopeExpectations: ['country scope and complete available-focus pool declared by the scenario'],
    supportedExpressions: [
      'base/add/factor',
      'modifiers',
      'script constants',
      'scripted triggers',
      'declared focus strategy factors',
    ],
    evidence: [evidenceRoot],
    limitations: [
      'Ordered AI strategy plans can override weighted focus selection.',
      'The prerequisite-completion multiplier and external focus factors require declared scenario inputs.',
    ],
  },
  technology_ai_will_do: {
    id: 'technology_ai_will_do',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'uniform_score_race',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: true,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['technology ai_will_do'],
    evaluationCadence: 'research-slot technology selection',
    scopeExpectations: [
      'country scope and complete eligible technology pool declared by the scenario',
    ],
    supportedExpressions: [
      'base/add/factor',
      'modifiers',
      'script constants',
      'scripted triggers',
      'declared research strategy factors',
    ],
    evidence: [evidenceRoot],
    limitations: [
      'Exact selection probability requires the complete eligible technology pool and every external research factor.',
      'Research duration is distinct from selection score.',
    ],
  },
  doctrine_ai_will_do: {
    id: 'doctrine_ai_will_do',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'uniform_score_race',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: true,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['doctrine ai_will_do'],
    evaluationCadence: 'research-slot doctrine selection',
    scopeExpectations: [
      'country scope and complete eligible doctrine pool declared by the scenario',
    ],
    supportedExpressions: [
      'base/add/factor',
      'modifiers',
      'script constants',
      'scripted triggers',
      'declared research strategy factors',
    ],
    evidence: [evidenceRoot],
    limitations: [
      'Exact probability requires a declared complete eligible doctrine candidate pool.',
    ],
  },
  direct_random: {
    id: 'direct_random',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'independent_chance',
    capabilities: {
      eligibility: false,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: false,
    confidence: 'documented',
    sourceBlockTypes: ['random chance'],
    evaluationCadence: 'when the enclosing random effect executes',
    scopeExpectations: [
      'enclosing effect scope declared by the scenario when conditions require it',
    ],
    supportedExpressions: ['numeric chance', 'script constants', 'declared variables'],
    evidence: [evidenceRoot],
    limitations: [
      'The chance is an independent percentage and is never normalized against nearby blocks.',
    ],
  },
  random_list: {
    id: 'random_list',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'proportional_categorical',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: true,
    confidence: 'documented',
    sourceBlockTypes: ['random_list entry'],
    evaluationCadence: 'when the enclosing random_list executes',
    scopeExpectations: ['enclosing effect scope declared by the scenario'],
    supportedExpressions: [
      'entry weights',
      'weight modifiers',
      'script constants',
      'scripted triggers',
    ],
    evidence: [evidenceRoot],
    limitations: [
      'Dynamic entry keys and effect-derived weights remain unresolved unless declared.',
    ],
  },
  ai_strategy_factor: {
    id: 'ai_strategy_factor',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'score_only',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: false,
      timeDistribution: false,
      sequence: false,
    },
    completePoolRequired: false,
    confidence: 'documented_with_runtime_boundary',
    sourceBlockTypes: ['ai_strategy factor'],
    evaluationCadence: 'when the downstream AI selection surface reads the strategy',
    scopeExpectations: ['strategy target and owning country declared by the source or scenario'],
    supportedExpressions: ['numeric strategy value', 'script constants', 'declared variables'],
    evidence: [evidenceRoot],
    limitations: [
      'Supported strategy factors modify a target score; a strategy definition is not itself a categorical pool.',
    ],
  },
  custom_weighted_pool: {
    id: 'custom_weighted_pool',
    version: PROBABILITY_ADAPTER_VERSION,
    gameVersion: VERIFIED_GAME_VERSION,
    selectionRule: 'custom_declared',
    capabilities: {
      eligibility: true,
      rawScore: true,
      normalizedProbability: true,
      timeDistribution: true,
      sequence: true,
    },
    completePoolRequired: true,
    confidence: 'manifest_defined',
    sourceBlockTypes: ['custom weighted-pool manifest'],
    evaluationCadence: 'manifest-declared cadence',
    scopeExpectations: ['manifest state only'],
    supportedExpressions: ['declared arithmetic', 'declared conditions', 'declared transitions'],
    evidence: [evidenceRoot],
    limitations: [
      'Only state and transitions explicitly declared by the manifest are modeled.',
      'No gameplay effects are executed or inferred.',
    ],
  },
};

function normalizationRule(selectionRule: AdapterDescriptor['selectionRule']): string[] {
  switch (selectionRule) {
    case 'proportional_categorical':
      return [
        'Normalize non-negative eligible values only when the local candidate pool is complete.',
      ];
    case 'uniform_score_race':
      return ['Use the independent-uniform maximum-score race only for a complete eligible pool.'];
    case 'independent_chance':
      return ['Clamp the resolved percentage to [0,100] and never normalize against neighbors.'];
    case 'median_daily_hazard':
      return ['Do not normalize; convert timing only through the verified median-hazard model.'];
    case 'score_only':
      return ['Return scores and ranks without inventing a categorical denominator.'];
    case 'custom_declared':
      return ['Use only the normalization event and selection mode declared by the manifest.'];
  }
}

const descriptors = Object.fromEntries(
  Object.entries(sources).map(([id, source]) => [
    id,
    {
      ...source,
      supportedGameVersions: [VERIFIED_GAME_VERSION],
      candidateDiscoveryRules: source.sourceBlockTypes.map(
        (blockType) =>
          `Discover active, unshadowed ${blockType} definitions through the shared index.`,
      ),
      eligibilityRules: source.capabilities.eligibility
        ? ['Evaluate source eligibility and declared candidate overrides with three-valued logic.']
        : ['The surface is independently evaluated and has no candidate-pool eligibility step.'],
      modifierOrder: [
        'Evaluate the base expression, then source add/factor operations and modifiers in source order.',
        'Apply declared external factors only after source-local operations.',
      ],
      poolNormalizationRules: normalizationRule(source.selectionRule),
      timingConversion:
        source.selectionRule === 'median_daily_hazard'
          ? [
              'Treat the effective duration as the median of verified daily checks while active.',
              'Bound activation through the verified 20-day inactive polling phase when its phase is undeclared.',
            ]
          : ['No time-distribution conversion is claimed for this adapter.'],
      unsupportedConstructs: [...source.limitations],
      testFixtures: ['fixtures/probability', evidenceRoot],
    },
  ]),
) as Record<ProbabilityAdapterId, AdapterDescriptor>;

export function probabilityAdapter(id: ProbabilityAdapterId): AdapterDescriptor {
  return descriptors[id];
}

export function probabilityAdapters(): AdapterDescriptor[] {
  return Object.values(descriptors);
}
