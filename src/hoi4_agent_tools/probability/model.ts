import type { Diagnostic, SourceLocation } from '../core/diagnostics.js';
import type { ArtifactLink } from '../core/result.js';
import type { BlockNode, SourceDocument } from '../core/source/index.js';
import type { RationalJson } from './rational.js';

export const PROBABILITY_SCHEMA_VERSION = 1 as const;
export const PROBABILITY_ADAPTER_VERSION = 'hoi4-1.19.2.v1' as const;
export const VERIFIED_GAME_VERSION = 'Operation Postern 1.19.2.0 (d245)' as const;
export const VERIFIED_GAME_RAW_VERSION = '1.19.2.0' as const;
export const VERIFIED_GAME_CHECKSUM = 'd245' as const;

export type ProbabilityAdapterId =
  | 'event_mean_time_to_happen'
  | 'event_option_ai_chance'
  | 'decision_ai_will_do'
  | 'mission_ai_will_do'
  | 'national_focus_ai_will_do'
  | 'technology_ai_will_do'
  | 'doctrine_ai_will_do'
  | 'direct_random'
  | 'random_list'
  | 'ai_strategy_factor'
  | 'custom_weighted_pool';

export type SelectionRule =
  | 'proportional_categorical'
  | 'uniform_score_race'
  | 'independent_chance'
  | 'median_daily_hazard'
  | 'score_only'
  | 'custom_declared';

export type TriState = 'true' | 'false' | 'unresolved';
export type SupportLevel =
  'exact' | 'bounded' | 'sampled' | 'score_only' | 'external' | 'unsupported';

export type ProbabilityMetric =
  'conditional_probability' | 'raw_value' | 'cumulative_chance' | 'effective_mtth_days';

export interface ProbabilityAcceptanceBand {
  id: string;
  label?: string;
  scenarioId?: string;
  candidateId: string;
  metric: ProbabilityMetric;
  min?: number;
  max?: number;
}

export interface ProbabilityDiagnosticThresholds {
  dominantProbability?: number;
  dominantScenarioPrevalence?: number;
  starvedProbability?: number;
  negligibleCumulativeChance?: number;
  extremeGrowthRatio?: number;
  thresholdCliffDelta?: number;
  rareOutcomeMinimumObservations?: number;
}

export type ProbabilitySamplingMethod = 'latin_hypercube' | 'pseudo_random';

export interface AdapterCapabilities {
  eligibility: boolean;
  rawScore: boolean;
  normalizedProbability: boolean;
  timeDistribution: boolean;
  sequence: boolean;
}

export interface AdapterDescriptor {
  id: ProbabilityAdapterId;
  version: typeof PROBABILITY_ADAPTER_VERSION;
  gameVersion: typeof VERIFIED_GAME_VERSION;
  supportedGameVersions: string[];
  selectionRule: SelectionRule;
  capabilities: AdapterCapabilities;
  completePoolRequired: boolean;
  confidence: 'documented' | 'documented_with_runtime_boundary' | 'manifest_defined';
  sourceBlockTypes: string[];
  candidateDiscoveryRules: string[];
  eligibilityRules: string[];
  modifierOrder: string[];
  poolNormalizationRules: string[];
  evaluationCadence: string;
  timingConversion: string[];
  scopeExpectations: string[];
  supportedExpressions: string[];
  unsupportedConstructs: string[];
  evidence: string[];
  testFixtures: string[];
  limitations: string[];
}

export interface GameVersionVerification {
  status: 'workspace_verified' | 'adapter_target_only';
  adapterTarget: typeof VERIFIED_GAME_VERSION;
  sourcePath?: string;
  observedVersion?: string;
  observedRawVersion?: string;
  observedChecksum?: string;
}

export type ScenarioScalar = string | number | boolean | null;
export type ScenarioValue = ScenarioScalar | ScenarioScalar[];

export interface ProbabilityDistribution {
  kind: 'uniform' | 'triangular' | 'normal' | 'lognormal' | 'categorical' | 'empirical';
  min?: number;
  max?: number;
  mode?: number;
  mean?: number;
  stddev?: number;
  values?: ScenarioScalar[];
  probabilities?: number[];
}

export interface UncertainInput {
  path: string;
  range?: { min: number; max: number };
  alternatives?: ScenarioScalar[];
  distribution?: ProbabilityDistribution;
  unresolved?: boolean;
}

export interface ScenarioScheduleEntry {
  atDay: number;
  set: Record<string, ScenarioValue>;
  clearFlags?: string[];
  addFlags?: string[];
}

export interface ProbabilityScenario {
  id: string;
  label?: string;
  prevalence?: number;
  actor?: string;
  date?: string;
  state: Record<string, ScenarioValue>;
  flags?: string[];
  eventTargets?: Record<string, string>;
  candidateOverrides?: Record<string, boolean>;
  uncertainInputs?: UncertainInput[];
  correlations?: Array<{ left: string; right: string; coefficient: number }>;
  schedule?: ScenarioScheduleEntry[];
}

export interface ProbabilityScenarioSet {
  schemaVersion: '1.0';
  id: string;
  workspaceId?: string;
  description?: string;
  surfaceHint?: ProbabilityAdapterId;
  scenarios: ProbabilityScenario[];
}

export interface ProbabilitySourceInput {
  identifier?: string;
  path?: string;
  line?: number;
  inlineClausewitz?: string;
  virtualPatch?: string;
  expectedSourceHash?: string;
}

export interface ProbabilitySourceProvenance {
  path: string;
  rootKind: string;
  loadOrder: number;
  sourceHash: string;
  location?: SourceLocation;
  astPath?: string[];
  symbol?: string;
  helperChain?: string[];
}

export interface ValueTraceStep {
  operation: 'base' | 'add' | 'factor' | 'eligibility' | 'external_factor' | 'normalization';
  expression: string;
  applied: TriState;
  value?: RationalJson;
  before?: RationalJson;
  after?: RationalJson;
  provenance?: ProbabilitySourceProvenance;
  conditionExpression?: string;
  note?: string;
}

export interface ProbabilityUnresolved {
  code: string;
  message: string;
  path?: string;
  candidateId?: string;
  provenance?: ProbabilitySourceProvenance;
  details?: Record<string, unknown>;
}

export interface WeightedCandidate {
  id: string;
  adapterId: ProbabilityAdapterId;
  sourceKind: string;
  defaultValue: string;
  valueExpression?: string;
  weightBlock?: BlockNode;
  eligibilityBlock?: BlockNode;
  document?: SourceDocument;
  provenance: ProbabilitySourceProvenance[];
  metadata: Record<string, unknown>;
  parentRandomPools?: ParentRandomPool[];
}

export interface ParentRandomPool {
  id: string;
  selectedEntryIndex: number;
  candidates: WeightedCandidate[];
}

export interface WeightedSurface {
  id: string;
  adapter: AdapterDescriptor;
  candidates: WeightedCandidate[];
  poolComplete: boolean;
  sourceRevision: string;
  sourceHash: string;
  filesScanned: string[];
  unsupported: ProbabilityUnresolved[];
}

export interface CandidateAnalysis {
  id: string;
  eligibility: TriState;
  supportLevel: SupportLevel;
  rawValue?: RationalJson | null;
  rawInterval?: { min: number; max: number };
  conditionalProbability?: number | null;
  exactConditionalProbability?: RationalJson;
  pathProbability?: number | null;
  exactPathProbability?: RationalJson;
  pathProbabilityInterval?: { low: number; high: number };
  conditionalProbabilityInterval?: { low: number; high: number };
  confidenceInterval?: { low: number; high: number };
  sampledFrequency?: number;
  effectiveMtthDays?: number;
  timingModel?: string;
  timingQuantilesDays?: { p10: number; p50: number; p90: number; p95: number };
  timingQuantileIntervals?: {
    p10: { low: number; high: number };
    p50: { low: number; high: number };
    p90: { low: number; high: number };
    p95: { low: number; high: number };
  };
  timingSampleCount?: number;
  timingEvaluations?: number;
  timingReservoirCapacity?: number;
  timingMethod?: 'sampled_discrete_daily_hazard';
  timingConfidenceMethod?: 'normal_order_statistic';
  cumulativeChance?: number;
  cumulativeChanceInterval?: { low: number; high: number };
  rank?: number | null;
  trace: ValueTraceStep[];
  provenance: ProbabilitySourceProvenance[];
  unresolved: ProbabilityUnresolved[];
}

export interface ScenarioAnalysis {
  id: string;
  label?: string;
  prevalence?: number;
  poolComplete: boolean;
  supportLevel: SupportLevel;
  candidates: CandidateAnalysis[];
  poolTotal?: RationalJson;
  horizonDays?: number;
  survivalChance?: number;
  survivalChanceInterval?: { low: number; high: number };
  timingIntervals?: Array<{
    startDay: number;
    endDay: number;
    eligibility: TriState;
    effectiveMtthDays?: number;
    minimumHazardContribution: number;
    maximumHazardContribution: number;
  }>;
  summary: {
    topOutcomes: string[];
    bottomEligibleOutcomes: string[];
    impossibleOutcomes: string[];
    unresolvedOutcomes: string[];
    dominantFactors: string[];
    closestRankReversal?: {
      candidates: [string, string];
      gap: number;
      metric: 'probability' | 'raw_value';
    };
  };
  unresolved: ProbabilityUnresolved[];
}

export interface ProbabilityMetadata {
  workspaceId: string;
  workspaceIdentity: string;
  sourceRevision: string;
  sourceHash: string;
  scenarioHash: string;
  candidatePoolHash: string;
  gameVersion: string;
  gameVersionVerification: GameVersionVerification;
  adapterId: ProbabilityAdapterId;
  adapterVersion: string;
  requestedMetrics?: ProbabilityMetric[];
  seed?: number;
  samples?: number;
  numericalPrecision: string;
  cacheKey: string;
}

export interface SweepPoint {
  scenarioId: string;
  path: string;
  value: number;
  values?: Record<string, number>;
  candidates: Array<{
    id: string;
    rawValue?: number;
    conditionalProbability?: number;
    rank?: number;
  }>;
}

export interface RankReversal {
  scenarioId: string;
  path: string;
  between: [number, number];
  beforeLeader: string;
  afterLeader: string;
}

export interface LocalElasticity {
  scenarioId: string;
  path: string;
  candidateId: string;
  metric: 'conditional_probability' | 'raw_value';
  between: [number, number];
  slope: number;
  elasticity?: number;
}

export interface PairwiseInteraction {
  scenarioId: string;
  paths: [string, string];
  candidateId: string;
  metric: 'conditional_probability' | 'raw_value';
  cell: { left: [number, number]; right: [number, number] };
  mixedDifference: number;
  mixedDifferencePerUnit: number;
}

export interface SimulationSummary {
  scenarioId: string;
  samples: number;
  seed: number;
  samplingMethod: ProbabilitySamplingMethod;
  rng: 'mulberry32';
  stoppingRule: 'fixed_sample_budget';
  confidenceLevel: number;
  confidenceMethod: 'wilson_score';
  effectiveSampleSize: number;
  convergence: {
    firstHalfSamples: number;
    secondHalfSamples: number;
    maximumFrequencyDelta: number;
  };
  globalImportance: Array<{
    path: string;
    candidateId: string;
    metric: 'raw_value';
    score: number;
    method: 'absolute_pearson_correlation';
    observations: number;
  }>;
  candidates: Array<{
    id: string;
    frequency?: number;
    confidenceInterval?: { low: number; high: number };
    observedSelections?: number;
    rawMean?: number;
    eligibilityFrequency: number;
    timingQuantilesDays?: { p10: number; p50: number; p90: number; p95: number };
    timingQuantileIntervals?: {
      p10: { low: number; high: number };
      p50: { low: number; high: number };
      p90: { low: number; high: number };
      p95: { low: number; high: number };
    };
    timingSampleCount?: number;
    timingEvaluations?: number;
    timingReservoirCapacity?: number;
    timingMethod?: 'sampled_discrete_daily_hazard';
    timingConfidenceMethod?: 'normal_order_statistic';
  }>;
}

export interface SequenceSummary {
  scenarioId: string;
  method: 'exact_state_distribution' | 'bounded_beam' | 'seeded_monte_carlo';
  steps: number;
  samples?: number;
  seed?: number;
  rng?: 'mulberry32';
  stoppingRule?: 'fixed_sample_budget';
  confidenceLevel?: number;
  terminalProbability: number;
  stateCount: number;
  omittedProbability?: number;
  candidates: Array<{
    id: string;
    nextSelectionProbability: number;
    expectedSelections: number;
    everSelectedProbability: number;
    starvationProbability: number;
    expectedFirstSelectionDay?: number;
    countDistribution: Array<{ count: number; probability: number }>;
  }>;
  categories: Array<{
    id: string;
    nextSelectionProbability: number;
    expectedSelections: number;
    everSelectedProbability: number;
    starvationProbability: number;
    expectedFirstSelectionDay?: number;
  }>;
  topPaths: Array<{
    candidateIds: string[];
    probability: number;
    terminal: boolean;
    endDay: number;
  }>;
  timeline: Array<{
    step: number;
    day: number;
    leadingCandidate?: string;
    terminalProbability: number;
  }>;
}

export interface ComparisonSummary {
  beforeAnalysisId: string;
  afterAnalysisId: string;
  scenarioChanges: Array<{
    scenarioId: string;
    candidateId: string;
    rawDelta?: number;
    probabilityDelta?: number;
    timingDeltaDays?: number;
    cumulativeChanceDelta?: number;
    rankDelta?: number;
    eligibilityChange?: { before: TriState; after: TriState };
    unresolvedDelta: number;
    attribution: string[];
    changedAstPaths: Array<{
      change: 'added' | 'removed';
      path: string;
      astPath: string[];
    }>;
  }>;
  assumptionsChanged: boolean;
  adapterChanged: boolean;
  regressions: Array<{ code: string; message: string; scenarioId?: string; candidateId?: string }>;
}

export interface ProbabilityAnalysisResult {
  schemaVersion: '1.0';
  status: 'complete' | 'partial' | 'blocked' | 'cancelled' | 'stale';
  operation: 'inspect' | 'evaluate' | 'sweep' | 'simulate' | 'sequence' | 'compare' | 'render';
  analysisId: string;
  metadata: ProbabilityMetadata;
  adapter: AdapterDescriptor;
  scenarios: ScenarioAnalysis[];
  prevalenceAggregate?: {
    prevalenceTotal: number;
    candidates: Array<{
      id: string;
      eligibilityPrevalence: number;
      weightedConditionalProbability?: number;
    }>;
  };
  diagnostics: Diagnostic[];
  unresolved: ProbabilityUnresolved[];
  sweep?: {
    points: SweepPoint[];
    rankReversals: RankReversal[];
    breakpoints: SweepPoint[];
    localElasticities: LocalElasticity[];
    pairwiseInteractions: PairwiseInteraction[];
  };
  simulation?: SimulationSummary[];
  sequence?: SequenceSummary;
  comparison?: ComparisonSummary;
  resources: ArtifactLink[];
}

export interface CustomPoolCandidate {
  id: string;
  category?: string;
  weight: number | string;
  cap?: number | string;
  eligibleWhen?: string;
  oneTime?: boolean;
  cooldownDays?: number;
}

export interface CustomPoolAction {
  operation:
    | 'set'
    | 'add'
    | 'multiply'
    | 'cap'
    | 'remove'
    | 'cooldown'
    | 'reset_category'
    | 'compress_timer'
    | 'reset_timer'
    | 'terminate';
  target: string;
  value?: number | string | boolean | null;
}

export interface CustomWeightedPoolManifest {
  schemaVersion: '1.0';
  id: string;
  description?: string;
  selection: {
    mode: 'categorical_weighted' | 'independent_chances';
    cadence: 'daily' | 'weekly' | 'monthly' | 'timer';
    timerMinDays?: number;
    timerMaxDays?: number;
    rounding?: 'exact' | 'floor' | 'ceil' | 'nearest';
  };
  state?: Record<string, ScenarioScalar>;
  candidates: CustomPoolCandidate[];
  recovery?: Array<{
    cadence: 'daily' | 'weekly' | 'monthly';
    target: string;
    amount: number | string;
    cap?: number | string;
  }>;
  transitions: Array<{ when: string; actions: CustomPoolAction[] }>;
}
