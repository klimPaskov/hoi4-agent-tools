import type {
  QualityVerdictRules,
  CalibrationBucket,
  CalibrationTree,
  MetricLimits,
  MetricStatistics,
  QualityBucketId,
  QualityCalibration,
  QualityMetricId,
} from './types.js';
import { CONVERGENCE_MINIMUM_ROWS, MINIMUM_FOCUSES_FOR_SOFT_METRICS } from './metrics.js';

/** Bumped whenever a metric definition or the way a tree is measured changes. */
export const QUALITY_METRIC_DEFINITIONS_VERSION = 1;

export interface QualityMetricInfo {
  id: QualityMetricId;
  group: 'H' | 'S' | 'D';
  name: string;
  unit: string;
  /** `high`: larger is worse. `low`: smaller is worse (fill ratio). */
  direction: 'high' | 'low';
  /** Limits come from vanilla statistics. */
  calibrated: boolean;
  /** Connector metrics are computed under the orthogonal model and skip trees with unresolved offsets. */
  connectorModel: boolean;
}

/** Everything the rubric measures, in scorecard order. */
export const QUALITY_METRICS: readonly QualityMetricInfo[] = [
  {
    id: 'H1',
    group: 'H',
    name: 'duplicate coordinates',
    unit: 'focuses',
    direction: 'high',
    calibrated: false,
    connectorModel: false,
  },
  {
    id: 'H2',
    group: 'H',
    name: 'prerequisite not above',
    unit: 'links',
    direction: 'high',
    calibrated: false,
    connectorModel: false,
  },
  {
    id: 'H3',
    group: 'H',
    name: 'overlapping plaques',
    unit: 'pairs',
    direction: 'high',
    calibrated: false,
    connectorModel: false,
  },
  {
    id: 'H4',
    group: 'H',
    name: 'connector through a plaque',
    unit: 'per 100 links',
    direction: 'high',
    calibrated: true,
    connectorModel: true,
  },
  {
    id: 'H5',
    group: 'H',
    name: 'crossing connectors',
    unit: 'per 100 links',
    direction: 'high',
    calibrated: true,
    connectorModel: true,
  },
  {
    id: 'S1',
    group: 'S',
    name: 'largest empty rectangle',
    unit: 'fraction of the canvas',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S2',
    group: 'S',
    name: 'side balance',
    unit: 'fraction',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S3',
    group: 'S',
    name: 'mass skew',
    unit: 'fraction of half width',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S4',
    group: 'S',
    name: 'fill ratio',
    unit: 'fraction',
    direction: 'low',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S5',
    group: 'S',
    name: 'row-centroid wander',
    unit: 'fraction of width',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S6',
    group: 'S',
    name: 'sideways jogs in single-focus chains',
    unit: 'per 100 links',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S7',
    group: 'S',
    name: 'interleaved sibling subtrees',
    unit: 'fraction of pairs',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S8',
    group: 'S',
    name: 'fan-out off its parent',
    unit: 'columns',
    direction: 'high',
    calibrated: false,
    connectorModel: false,
  },
  {
    id: 'S9',
    group: 'S',
    name: 'merged connector bars',
    unit: 'per 100 links',
    direction: 'high',
    calibrated: true,
    connectorModel: true,
  },
  {
    id: 'S10',
    group: 'S',
    name: 'vertical slack',
    unit: 'rows',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'S11',
    group: 'S',
    name: 'sibling cohorts on mixed rows',
    unit: 'fraction of cohorts',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'D1',
    group: 'D',
    name: 'longest single-successor chain',
    unit: 'focuses',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'D2',
    group: 'D',
    name: 'leaf fraction',
    unit: 'fraction',
    direction: 'high',
    calibrated: true,
    connectorModel: false,
  },
  {
    id: 'D3',
    group: 'D',
    name: 'exclusive choices that fully reconverge',
    unit: 'sets',
    direction: 'high',
    calibrated: false,
    connectorModel: false,
  },
  {
    id: 'D4',
    group: 'D',
    name: 'tall narrow canvas',
    unit: 'rows per plaque column',
    direction: 'high',
    calibrated: false,
    connectorModel: false,
  },
];

const METRIC_BY_ID = new Map(QUALITY_METRICS.map((info) => [info.id, info]));

export function qualityMetricInfo(id: QualityMetricId): QualityMetricInfo {
  return METRIC_BY_ID.get(id)!;
}

/** Limits that come from the rubric itself, not from vanilla statistics. */
export const FIXED_QUALITY_LIMITS: Partial<Record<QualityMetricId, MetricLimits>> = {
  H1: { direction: 'high', review: 0, revise: 0 },
  H2: { direction: 'high', review: 0, revise: 0 },
  H3: { direction: 'high', review: 0, revise: 0 },
  S8: { direction: 'high', review: 2, revise: 3 },
  D3: { direction: 'high', review: 0, revise: 0 },
  D4: { direction: 'high', review: 2.5, revise: 2.5 },
};

export const QUALITY_BUCKET_BOUNDS: ReadonlyArray<{
  id: QualityBucketId;
  minimumFocuses: number;
  maximumFocuses: number;
}> = [
  { id: 'small', minimumFocuses: 0, maximumFocuses: 39 },
  { id: 'medium', minimumFocuses: 40, maximumFocuses: 120 },
  { id: 'large', minimumFocuses: 121, maximumFocuses: Number.MAX_SAFE_INTEGER },
];

export function bucketIdForFocusCount(focusCount: number): QualityBucketId {
  return QUALITY_BUCKET_BOUNDS.find(
    ({ minimumFocuses, maximumFocuses }) =>
      focusCount >= minimumFocuses && focusCount <= maximumFocuses,
  )!.id;
}

/** Linear interpolation between order statistics (the common "type 7" percentile). */
export function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** Derived numbers are stored with four decimals so a recomputation compares exactly. */
export function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

export function metricStatistics(values: readonly number[]): MetricStatistics | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: roundMetric(sorted[0]!),
    p10: roundMetric(quantile(sorted, 0.1)),
    p50: roundMetric(quantile(sorted, 0.5)),
    p90: roundMetric(quantile(sorted, 0.9)),
    max: roundMetric(sorted[sorted.length - 1]!),
  };
}

/**
 * The verdict rules measured to fit the vanilla corpus (leave-one-out over 65 trees of 40 or more
 * focuses: 82% pass, 15% review, 3% revise for an unseen vanilla-quality tree). Review starts at the
 * edge of the vanilla range; the 90th percentile as review limit put 72% of vanilla trees at review
 * and the vanilla maximum as revise limit put 26% at revise, because twelve metrics each cross a
 * limit by chance. The revise limit therefore carries a margin and a count of five is required.
 */
export const DEFAULT_VERDICT_RULES: QualityVerdictRules = {
  reviseMargin: 1,
  reviseCount: 5,
  advisoryMetrics: ['H4', 'H5', 'S9'],
  convergenceMinimumRows: CONVERGENCE_MINIMUM_ROWS,
};

/**
 * Review limit: the edge of the vanilla range (its maximum, or minimum for the fill ratio). Revise
 * limit: that edge plus a margin of the spread above the median (design proxies flag at the edge
 * itself). The margin has a floor so metrics that are zero in most vanilla trees leave some room.
 */
export function deriveLimits(
  id: QualityMetricId,
  statistics: MetricStatistics,
  rules: QualityVerdictRules = DEFAULT_VERDICT_RULES,
): MetricLimits | undefined {
  const fixed = FIXED_QUALITY_LIMITS[id];
  if (fixed !== undefined) return fixed;
  const info = qualityMetricInfo(id);
  if (!info.calibrated) return undefined;
  if (info.group === 'D')
    return { direction: 'high', review: statistics.max, revise: statistics.max };
  const floor = (extreme: number): number => 0.02 * Math.max(1, Math.abs(extreme));
  return info.direction === 'high'
    ? {
        direction: 'high',
        review: statistics.max,
        revise: roundMetric(
          statistics.max +
            rules.reviseMargin * Math.max(statistics.max - statistics.p50, floor(statistics.max)),
        ),
      }
    : {
        direction: 'low',
        review: statistics.min,
        revise: roundMetric(
          statistics.min -
            rules.reviseMargin * Math.max(statistics.p50 - statistics.min, floor(statistics.min)),
        ),
      };
}

const CALIBRATED_IDS: readonly QualityMetricId[] = QUALITY_METRICS.filter(
  ({ calibrated }) => calibrated,
).map(({ id }) => id);

export function buildCalibrationBuckets(
  trees: readonly CalibrationTree[],
  rules: QualityVerdictRules = DEFAULT_VERDICT_RULES,
): CalibrationBucket[] {
  return QUALITY_BUCKET_BOUNDS.map((bounds) => {
    const members = trees.filter(({ bucket }) => bucket === bounds.id);
    const statistics: CalibrationBucket['statistics'] = {};
    const limits: CalibrationBucket['limits'] = {};
    // Trees below 40 focuses are too few in vanilla to calibrate on; they borrow the medium limits.
    for (const id of bounds.id === 'small' ? [] : CALIBRATED_IDS) {
      const connectorModel = qualityMetricInfo(id).connectorModel;
      const values = members
        .filter(({ ambiguousPositions }) => !(connectorModel && ambiguousPositions))
        .flatMap(({ values: measured }) => {
          const value = measured[id];
          return value === undefined ? [] : [value];
        });
      const stats = metricStatistics(values);
      if (stats === undefined) continue;
      statistics[id] = stats;
      const derived = deriveLimits(id, stats, rules);
      if (derived !== undefined) limits[id] = derived;
    }
    return {
      id: bounds.id,
      minimumFocuses: bounds.minimumFocuses,
      maximumFocuses:
        bounds.maximumFocuses === Number.MAX_SAFE_INTEGER ? 100000 : bounds.maximumFocuses,
      treeCount: members.length,
      statistics,
      limits,
    };
  });
}

/** Weights of the 0 to 100 convenience score; the verdict never depends on them. */
export const DEFAULT_SCORE_WEIGHTS: Partial<Record<QualityMetricId, number>> = {
  H4: 1,
  H5: 1,
  S1: 1.5,
  S2: 1.5,
  S3: 1.5,
  S4: 1,
  S5: 1,
  S6: 1,
  S7: 1,
  S9: 0.5,
  S10: 0.5,
  S11: 0.5,
};

/** The statistics of the bucket a tree of this size is compared with. */
export function calibrationBucketFor(
  calibration: QualityCalibration,
  focusCount: number,
): CalibrationBucket {
  const id = bucketIdForFocusCount(focusCount);
  // Trees below 40 focuses are judged against the medium bucket's review limits only.
  const lookup = id === 'small' ? 'medium' : id;
  return calibration.buckets.find((bucket) => bucket.id === lookup)!;
}

export function limitsFor(
  bucket: CalibrationBucket,
  id: QualityMetricId,
): MetricLimits | undefined {
  return FIXED_QUALITY_LIMITS[id] ?? bucket.limits[id];
}

export type SoftMetricStatus = 'ok' | 'review' | 'revise';

/** True when a value lies beyond a limit, in the direction in which the metric gets worse. */
export function beyondLimit(direction: 'high' | 'low', value: number, limit: number): boolean {
  return direction === 'high' ? value > limit : value < limit;
}

/**
 * Where a calibrated soft metric stands against its limits. Limits are stored with four decimals,
 * so the value is compared at the same precision. A tree below 40 focuses and an advisory metric
 * (a connector metric under the unverified orthogonal model) reach `review` at most.
 */
export function softMetricStatus(
  id: QualityMetricId,
  value: number,
  limits: MetricLimits,
  bucketId: QualityBucketId,
  rules: QualityVerdictRules,
): SoftMetricStatus {
  const comparable = Number(value.toFixed(4));
  if (beyondLimit(limits.direction, comparable, limits.revise))
    return bucketId === 'small' || rules.advisoryMetrics.includes(id) ? 'review' : 'revise';
  return beyondLimit(limits.direction, comparable, limits.review) ? 'review' : 'ok';
}

/**
 * The verdict the calibrated soft metrics alone give: `revise` when one is beyond its revise limit
 * or enough of them (the advisory ones excluded) are beyond the vanilla range, `review` when any
 * is, otherwise `pass`. Hard defects and design flags are added by the caller.
 */
export function softVerdict(
  statuses: ReadonlyArray<{ id: QualityMetricId; status: SoftMetricStatus }>,
  bucketId: QualityBucketId,
  rules: QualityVerdictRules,
): 'pass' | 'review' | 'revise' {
  const beyond = statuses.filter(({ status }) => status !== 'ok');
  const counted = beyond.filter(({ id }) => !rules.advisoryMetrics.includes(id));
  if (
    statuses.some(({ status }) => status === 'revise') ||
    (bucketId !== 'small' && counted.length >= rules.reviseCount)
  )
    return 'revise';
  return beyond.length > 0 ? 'review' : 'pass';
}

/** True when a tree is large enough for the vanilla-calibrated soft metrics. */
export function supportsSoftMetrics(focusCount: number): boolean {
  return focusCount >= MINIMUM_FOCUSES_FOR_SOFT_METRICS;
}
