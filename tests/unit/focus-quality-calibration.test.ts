import { describe, expect, it } from 'vitest';
import {
  buildCalibrationBuckets,
  bucketIdForFocusCount,
  deriveLimits,
  metricStatistics,
  QUALITY_METRIC_DEFINITIONS_VERSION,
  quantile,
  STORED_QUALITY_CALIBRATION,
} from '../../src/hoi4_agent_tools/focus/quality/index.js';

const calibration = STORED_QUALITY_CALIBRATION;

describe('stored focus-quality calibration', () => {
  it('covers the 67 vanilla trees of eight or more focuses in three size buckets', () => {
    expect(calibration.schemaVersion).toBe(1);
    expect(calibration.metricDefinitionsVersion).toBe(QUALITY_METRIC_DEFINITIONS_VERSION);
    expect(calibration.game.revision).toMatch(/^[a-f0-9]{8,}$/u);
    expect(calibration.trees).toHaveLength(67);
    expect(calibration.buckets.map(({ id, treeCount }) => [id, treeCount])).toEqual([
      ['small', 2],
      ['medium', 26],
      ['large', 39],
    ]);
    const ids = calibration.trees.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const tree of calibration.trees) {
      expect(tree.focusCount).toBeGreaterThanOrEqual(calibration.minimumFocusesForSoftMetrics);
      expect(tree.bucket).toBe(bucketIdForFocusCount(tree.focusCount));
    }
  });

  it('derives every bucket and limit from the stored per-tree values', () => {
    expect(buildCalibrationBuckets(calibration.trees, calibration.verdictRules)).toEqual(
      calibration.buckets,
    );
  });

  it('keeps the statistics ordered and each review limit inside its revise limit', () => {
    for (const bucket of calibration.buckets) {
      for (const [id, stats] of Object.entries(bucket.statistics)) {
        expect(stats.min, `${bucket.id} ${id}`).toBeLessThanOrEqual(stats.p10);
        expect(stats.p10, `${bucket.id} ${id}`).toBeLessThanOrEqual(stats.p50);
        expect(stats.p50, `${bucket.id} ${id}`).toBeLessThanOrEqual(stats.p90);
        expect(stats.p90, `${bucket.id} ${id}`).toBeLessThanOrEqual(stats.max);
      }
      for (const [id, limits] of Object.entries(bucket.limits)) {
        if (limits.direction === 'high') {
          expect(limits.review, `${bucket.id} ${id}`).toBeLessThanOrEqual(limits.revise);
        } else {
          expect(limits.review, `${bucket.id} ${id}`).toBeGreaterThanOrEqual(limits.revise);
        }
      }
    }
  });

  it('records the vanilla source files it was computed from by hash', () => {
    expect(calibration.sources.length).toBeGreaterThanOrEqual(80);
    for (const source of calibration.sources) {
      expect(source.file).toMatch(/\.txt$/u);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    for (const tree of calibration.trees)
      expect(calibration.sources.some(({ file }) => file === tree.file)).toBe(true);
  });

  it('excludes trees with ambiguous positions from the connector statistics only', () => {
    const ambiguous = calibration.trees.filter(({ ambiguousPositions }) => ambiguousPositions);
    expect(ambiguous.length).toBeGreaterThan(0);
    const large = calibration.buckets.find(({ id }) => id === 'large')!;
    const connectorValues = calibration.trees
      .filter(({ bucket, ambiguousPositions }) => bucket === 'large' && !ambiguousPositions)
      .map(({ values }) => values.H4 ?? 0);
    expect(large.statistics.H4?.max).toBe(Math.max(...connectorValues));
    const allFill = calibration.trees
      .filter(({ bucket }) => bucket === 'large')
      .map(({ values }) => values.S4 ?? 0);
    expect(large.statistics.S4?.min).toBe(Math.min(...allFill));
  });

  it('holds no game text, only derived numbers and file names', () => {
    const text = JSON.stringify(calibration);
    expect(text.length).toBeLessThan(120_000);
    expect(text).not.toMatch(/focus_tree\s*=|completion_reward|prerequisite\s*=/u);
  });
});

describe('calibration arithmetic', () => {
  it('interpolates percentiles between order statistics', () => {
    const sorted = [0, 10, 20, 30, 40];
    expect(quantile(sorted, 0)).toBe(0);
    expect(quantile(sorted, 0.5)).toBe(20);
    expect(quantile(sorted, 0.9)).toBeCloseTo(36, 10);
    expect(quantile(sorted, 1)).toBe(40);
    expect(quantile([], 0.5)).toBe(0);
    expect(metricStatistics([])).toBeUndefined();
    expect(metricStatistics([3, 1, 2])).toEqual({ min: 1, p10: 1.2, p50: 2, p90: 2.8, max: 3 });
  });

  it('puts the review limit at the vanilla edge and the revise limit beyond it', () => {
    const stats = { min: 0.35, p10: 0.37, p50: 0.46, p90: 0.58, max: 0.6 };
    // High is bad: review at the maximum, revise a margin of (max - median) further.
    expect(deriveLimits('S1', stats)).toEqual({ direction: 'high', review: 0.6, revise: 0.74 });
    // Low is bad (fill ratio): review at the minimum, revise a margin of (median - min) lower.
    expect(deriveLimits('S4', stats)).toEqual({ direction: 'low', review: 0.35, revise: 0.24 });
    // Design proxies flag at the edge itself, and hard defects have no vanilla limit.
    expect(deriveLimits('D1', stats)).toEqual({ direction: 'high', review: 0.6, revise: 0.6 });
    expect(deriveLimits('H1', stats)).toEqual({ direction: 'high', review: 0, revise: 0 });
  });

  it('gives a metric that is zero in most trees some room above its maximum', () => {
    const zeroHeavy = { min: 0, p10: 0, p50: 0, p90: 0, max: 0.05 };
    const limits = deriveLimits('S7', zeroHeavy)!;
    expect(limits.review).toBe(0.05);
    expect(limits.revise).toBeCloseTo(0.1, 10);
    const allZero = { min: 0, p10: 0, p50: 0, p90: 0, max: 0 };
    expect(deriveLimits('S7', allZero)!.revise).toBeCloseTo(0.02, 10);
  });

  it('assigns buckets by focus count', () => {
    expect(bucketIdForFocusCount(8)).toBe('small');
    expect(bucketIdForFocusCount(39)).toBe('small');
    expect(bucketIdForFocusCount(40)).toBe('medium');
    expect(bucketIdForFocusCount(120)).toBe('medium');
    expect(bucketIdForFocusCount(121)).toBe('large');
    expect(bucketIdForFocusCount(448)).toBe('large');
  });
});
