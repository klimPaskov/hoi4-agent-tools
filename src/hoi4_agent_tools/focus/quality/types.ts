/**
 * Shared types of the focus layout quality rubric. Everything under `focus/quality` is pure:
 * it reads resolved grid coordinates and prerequisite links and never touches source files.
 */

export type HardMetricId = 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
export type SoftMetricId =
  'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11';
export type DesignMetricId = 'D1' | 'D2' | 'D3' | 'D4';
export type QualityMetricId = HardMetricId | SoftMetricId | DesignMetricId;

export type QualityVerdict = 'blocked' | 'revise' | 'review' | 'pass';

export type QualityBucketId = 'small' | 'medium' | 'large';

export interface QualityNode {
  id: string;
  x: number;
  y: number;
}

/** One drawn prerequisite link. `or` marks a member of a multi-focus prerequisite block. */
export interface QualityEdge {
  parent: string;
  child: string;
  group: number;
  or: boolean;
}

export interface QualityGraph {
  /** Sorted by id. */
  nodes: QualityNode[];
  position: ReadonlyMap<string, { x: number; y: number }>;
  /** Only links whose two ends are both placed, sorted by child, group and parent. */
  edges: QualityEdge[];
  /** Unique neighbours, sorted. */
  parents: ReadonlyMap<string, readonly string[]>;
  children: ReadonlyMap<string, readonly string[]>;
  exclusions: ReadonlyArray<readonly [string, string]>;
  /** Focuses whose game position is shifted by an `offset` block the tool cannot evaluate. */
  offsetDependent: ReadonlySet<string>;
  /**
   * Focuses that are only visible when a condition holds (`allow_branch`, a non-normal visibility,
   * or a prerequisite that is). Branches that are never visible together may share a coordinate.
   */
  conditional: ReadonlySet<string>;
  /** Declared branch id, or a derived one (the first focus of a branch). Empty string: shared or trunk. */
  branchOf: ReadonlyMap<string, string>;
  branchesDeclared: boolean;
}

export interface QualityBundle {
  parents: string[];
  children: string[];
}

export interface QualityRegion {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

export interface QualityLocators {
  duplicateCoordinates: Array<{ x: number; y: number; focusIds: string[] }>;
  parentNotAbove: Array<{ parentId: string; childId: string }>;
  overlaps: Array<{ leftId: string; rightId: string; y: number; distance: number }>;
  stemsThroughPlaques: Array<{ parentId: string; childId: string; focusId: string }>;
  crossings: Array<{
    firstParentId: string;
    firstChildId: string;
    secondParentId: string;
    secondChildId: string;
  }>;
  mergedBars: Array<{
    firstParentId: string;
    firstChildId: string;
    secondParentId: string;
    secondChildId: string;
  }>;
  detours: Array<{ parentId: string; childId: string; dx: number }>;
  offCenterCohorts: Array<{ parentId: string; childIds: string[]; offset: number; centre: number }>;
  mixedRowCohorts: Array<{ parentId: string; childIds: string[] }>;
  interleavedPairs: Array<{ parentId: string; firstChildId: string; secondChildId: string }>;
  slackChildren: Array<{ childId: string; slack: number }>;
  emptyRectangle: QualityRegion | null;
  longestChain: string[];
  convergingChoices: Array<{ choiceIds: string[]; convergenceId: string; rows: number }>;
  rowCentroids: {
    minimumRow: number;
    maximumRow: number;
    minimumMean: number;
    maximumMean: number;
  } | null;
  sides: { left: number; right: number; centre: number };
  bundles: QualityBundle[];
}

/** Raw values of every metric; `null` means the metric is not defined for this graph. */
export interface QualityMeasurement {
  nodeCount: number;
  edgeCount: number;
  width: number;
  rows: number;
  /** Metric values in the units of the rubric. Missing keys were not evaluated. */
  values: Partial<Record<QualityMetricId, number>>;
  /** Hard defects counted as plain numbers (H1 to H3) and orthogonal-model totals (H4, H5). */
  counts: {
    duplicateCoordinates: number;
    parentNotAbove: number;
    overlaps: number;
    stemsThroughPlaques: number;
    crossings: number;
    mergedBars: number;
    detours: number;
    leaves: number;
    cohorts: number;
    bundleEdges: number;
    exclusiveSets: number;
  };
  locators: QualityLocators;
  /** Set when the graph was too large for an exact pair comparison. */
  notEvaluated: string[];
}

export interface MetricStatistics {
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

export interface MetricLimits {
  direction: 'high' | 'low';
  review: number;
  revise: number;
}

export interface CalibrationBucket {
  id: QualityBucketId;
  /** Inclusive bounds on the focus count that select this bucket. */
  minimumFocuses: number;
  maximumFocuses: number;
  treeCount: number;
  statistics: Partial<Record<QualityMetricId, MetricStatistics>>;
  limits: Partial<Record<QualityMetricId, MetricLimits>>;
}

export interface CalibrationTree {
  id: string;
  file: string;
  focusCount: number;
  bucket: QualityBucketId;
  /**
   * Positions depend on `offset` blocks or conditional branches the tool cannot evaluate, so
   * overlaps in this tree are not necessarily defects; connector statistics exclude it.
   */
  ambiguousPositions: boolean;
  values: Partial<Record<QualityMetricId, number>>;
}

/** Tunable verdict rules; they live in the calibration file so they can change without code. */
export interface QualityVerdictRules {
  /** The revise limit is the vanilla maximum plus this multiple of (maximum minus median). */
  reviseMargin: number;
  /** This many soft metrics beyond their review limit make the verdict `revise`. */
  reviseCount: number;
  /** Connector metrics under the unverified orthogonal model can raise a tree to `review` at most. */
  advisoryMetrics: QualityMetricId[];
  /** D3 only flags choices that rejoin at least this many rows below. */
  convergenceMinimumRows: number;
}

export interface QualityCalibration {
  schemaVersion: 1;
  /** Bumped whenever a metric definition changes, so a stale file is recognisable. */
  metricDefinitionsVersion: number;
  game: { versionLabel: string; revision: string };
  generatedBy: string;
  minimumFocusesForSoftMetrics: number;
  verdictRules: QualityVerdictRules;
  buckets: CalibrationBucket[];
  scoreWeights: Partial<Record<QualityMetricId, number>>;
  sources: Array<{ file: string; sha256: string }>;
  trees: CalibrationTree[];
}
