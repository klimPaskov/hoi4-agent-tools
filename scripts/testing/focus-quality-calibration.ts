import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseClausewitz } from '../../src/hoi4_agent_tools/core/source/index.js';
import {
  buildCalibrationBuckets,
  bucketIdForFocusCount,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_VERDICT_RULES,
  QUALITY_METRIC_DEFINITIONS_VERSION,
  roundMetric,
} from '../../src/hoi4_agent_tools/focus/quality/calibration.js';
import { buildQualityGraph } from '../../src/hoi4_agent_tools/focus/quality/graph.js';
import {
  MINIMUM_FOCUSES_FOR_SOFT_METRICS,
  measureLayoutQuality,
} from '../../src/hoi4_agent_tools/focus/quality/metrics.js';
import { resolveStaticPositions } from '../../src/hoi4_agent_tools/focus/quality/positions.js';
import type {
  CalibrationTree,
  QualityCalibration,
  QualityMetricId,
} from '../../src/hoi4_agent_tools/focus/quality/types.js';
import { importFocusTrees } from '../../src/hoi4_agent_tools/focus/importer.js';
import { layoutFocusTree } from '../../src/hoi4_agent_tools/focus/layout.js';
import type { FocusTreePlan } from '../../src/hoi4_agent_tools/focus/model.js';

// Project validation harness only; this file is not a packaged product command. It reads the
// installed game and writes derived numbers, never game files.

const STEAM_DEFAULTS = [
  'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV',
  'C:/Program Files/Steam/steamapps/common/Hearts of Iron IV',
  `${process.env.HOME ?? ''}/Library/Application Support/Steam/steamapps/common/Hearts of Iron IV`,
  `${process.env.HOME ?? ''}/.steam/steam/steamapps/common/Hearts of Iron IV`,
  `${process.env.HOME ?? ''}/.local/share/Steam/steamapps/common/Hearts of Iron IV`,
];

/** The installed game folder: HOI4_GAME_ROOT, else a default Steam library, else undefined. */
export function findGameRoot(): string | undefined {
  const candidates = [process.env.HOI4_GAME_ROOT, ...STEAM_DEFAULTS];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined &&
      candidate !== '' &&
      existsSync(path.join(candidate, 'common', 'national_focus')),
  );
}

const CALIBRATED_VALUE_IDS: readonly QualityMetricId[] = [
  'H4',
  'H5',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S9',
  'S10',
  'S11',
  'D1',
  'D2',
];

function positionsFor(plan: FocusTreePlan) {
  return (
    resolveStaticPositions(plan) ??
    layoutFocusTree(plan).nodes.map(({ id, x, y }) => ({ id, x, y }))
  );
}

export interface MeasuredVanillaTree {
  tree: CalibrationTree;
  /** Hard-defect counts with unresolved `offset` blocks ignored, for reporting only. */
  rawHardDefects: { duplicates: number; overlaps: number; parentNotAbove: number };
}

export function measureVanillaTrees(root: string): {
  trees: MeasuredVanillaTree[];
  sources: Array<{ file: string; sha256: string }>;
} {
  const directory = path.join(root, 'common', 'national_focus');
  const trees: MeasuredVanillaTree[] = [];
  const sources: Array<{ file: string; sha256: string }> = [];
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith('.txt'))
    .sort()) {
    const bytes = readFileSync(path.join(directory, name));
    sources.push({ file: name, sha256: createHash('sha256').update(bytes).digest('hex') });
    const document = parseClausewitz(new Uint8Array(bytes), name);
    for (const plan of importFocusTrees(document).plans) {
      if (plan.focuses.length < MINIMUM_FOCUSES_FOR_SOFT_METRICS) continue;
      const positions = positionsFor(plan);
      const graph = buildQualityGraph(plan, positions);
      const measurement = measureLayoutQuality(graph);
      // An offset block shifts the real position; if ignoring it creates a collision, the
      // tree's connector statistics are artefacts and stay out of the connector calibration.
      const ignoringOffsets = measureLayoutQuality({
        ...graph,
        offsetDependent: new Set(),
        conditional: new Set(),
      });
      const ambiguousPositions =
        (graph.offsetDependent.size > 0 || graph.conditional.size > 0) &&
        ((ignoringOffsets.values.H1 ?? 0) > 0 || (ignoringOffsets.values.H3 ?? 0) > 0);
      const values: CalibrationTree['values'] = {};
      for (const id of CALIBRATED_VALUE_IDS) {
        const value = measurement.values[id];
        if (value !== undefined) values[id] = roundMetric(value);
      }
      trees.push({
        tree: {
          id: plan.id,
          file: name,
          focusCount: plan.focuses.length,
          bucket: bucketIdForFocusCount(plan.focuses.length),
          ambiguousPositions,
          values,
        },
        rawHardDefects: {
          duplicates: ignoringOffsets.counts.duplicateCoordinates,
          overlaps: ignoringOffsets.counts.overlaps,
          parentNotAbove: ignoringOffsets.counts.parentNotAbove,
        },
      });
    }
  }
  trees.sort((left, right) =>
    left.tree.id < right.tree.id ? -1 : left.tree.id > right.tree.id ? 1 : 0,
  );
  return { trees, sources };
}

export function gameRevision(root: string): string {
  const file = path.join(root, 'hoi4_rev.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : 'unknown';
}

export function computeCalibration(root: string, versionLabel: string): QualityCalibration {
  const { trees, sources } = measureVanillaTrees(root);
  const calibrationTrees = trees.map(({ tree }) => tree);
  return {
    schemaVersion: 1,
    metricDefinitionsVersion: QUALITY_METRIC_DEFINITIONS_VERSION,
    game: { versionLabel, revision: gameRevision(root) },
    generatedBy: 'scripts/focus-quality-calibration.ts',
    minimumFocusesForSoftMetrics: MINIMUM_FOCUSES_FOR_SOFT_METRICS,
    verdictRules: DEFAULT_VERDICT_RULES,
    buckets: buildCalibrationBuckets(calibrationTrees, DEFAULT_VERDICT_RULES),
    scoreWeights: DEFAULT_SCORE_WEIGHTS,
    sources,
    trees: calibrationTrees,
  };
}
