import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../src/hoi4_agent_tools/core/canonical.js';
import {
  buildCalibrationBuckets,
  calibrationBucketFor,
  limitsFor,
  QUALITY_METRICS,
  softMetricStatus,
  softVerdict,
  type SoftMetricStatus,
} from '../src/hoi4_agent_tools/focus/quality/calibration.js';
import type {
  CalibrationTree,
  QualityCalibration,
  QualityMetricId,
} from '../src/hoi4_agent_tools/focus/quality/types.js';
import { computeCalibration, findGameRoot } from './testing/focus-quality-calibration.js';

// Project validation harness only; this file is not a packaged product command.
//
//   npm run focus:calibrate -- --write      recompute from the installed game and store
//   npm run focus:calibrate -- --check      fail when the stored file differs from the game
//   npm run focus:calibrate -- --report     verdict rates of unseen vanilla-quality trees
//   npm run focus:calibrate                 print the recomputed file
//
// Options: --game <folder> (default HOI4_GAME_ROOT or a Steam library), --label <version label>.

const stored = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'hoi4_agent_tools',
  'focus',
  'quality',
  'focus-quality-calibration.json',
);
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const root = option('--game') ?? findGameRoot();
if (root === undefined) {
  process.stderr.write('Hearts of Iron IV was not found; pass --game or set HOI4_GAME_ROOT.\n');
  process.exit(2);
}
let label = option('--label');
if (label === undefined) {
  try {
    label = (JSON.parse(readFileSync(stored, 'utf8')) as { game: { versionLabel: string } }).game
      .versionLabel;
  } catch {
    label = 'unknown';
  }
}
const calibration = computeCalibration(root, label);

/**
 * The soft-metric verdict of one tree against limits fitted on other trees: the rate at which an
 * unseen vanilla-quality tree would be flagged.
 */
function unseenVerdict(
  tree: CalibrationTree,
  fitted: QualityCalibration,
): 'pass' | 'review' | 'revise' {
  const bucket = calibrationBucketFor(fitted, tree.focusCount);
  const statuses: Array<{ id: QualityMetricId; status: SoftMetricStatus }> = [];
  for (const info of QUALITY_METRICS) {
    const value = tree.values[info.id];
    const limits = limitsFor(bucket, info.id);
    if (value === undefined || limits === undefined || !info.calibrated || info.group === 'D')
      continue;
    if (info.connectorModel && tree.ambiguousPositions) continue;
    statuses.push({
      id: info.id,
      status: softMetricStatus(info.id, value, limits, tree.bucket, fitted.verdictRules),
    });
  }
  return softVerdict(statuses, tree.bucket, fitted.verdictRules);
}

function report(full: QualityCalibration): string {
  const evaluated = full.trees.filter(({ bucket }) => bucket !== 'small');
  const tally = (verdicts: string[]): string => {
    const share = (name: string): string =>
      `${((100 * verdicts.filter((verdict) => verdict === name).length) / verdicts.length).toFixed(1)}%`;
    return `pass ${share('pass')}, review ${share('review')}, revise ${share('revise')} of ${String(verdicts.length)}`;
  };
  const lines = [
    `In sample (limits fitted on all trees of 40 or more focuses): ${tally(evaluated.map((tree) => unseenVerdict(tree, full)))}`,
  ];
  lines.push(
    `Leave one out (limits fitted without the tree): ${tally(
      evaluated.map((tree) =>
        unseenVerdict(tree, {
          ...full,
          buckets: buildCalibrationBuckets(
            full.trees.filter((other) => other !== tree),
            full.verdictRules,
          ),
        }),
      ),
    )}`,
  );
  const halves = [0, 1].map((half) => full.trees.filter((_unused, index) => index % 2 === half));
  const heldOut = halves.flatMap((fitted, half) => {
    const limits = { ...full, buckets: buildCalibrationBuckets(fitted, full.verdictRules) };
    return halves[1 - half]!.filter(({ bucket }) => bucket !== 'small').map((tree) =>
      unseenVerdict(tree, limits),
    );
  });
  lines.push(`Two halves (fit on one, test on the other): ${tally(heldOut)}`);
  return lines.join('\n');
}
const text = `${JSON.stringify(JSON.parse(canonicalJson(calibration)), null, 2)}\n`;
if (args.includes('--report')) {
  process.stdout.write(`${report(calibration)}\n`);
} else if (args.includes('--write')) {
  writeFileSync(stored, text, 'utf8');
  process.stdout.write(`Wrote ${calibration.trees.length} trees to ${stored}\n`);
} else if (args.includes('--check')) {
  const current = readFileSync(stored, 'utf8');
  if (current !== text) {
    process.stderr.write(
      'The stored focus-quality calibration differs from the installed game. Run `npm run focus:calibrate -- --write` and review the diff.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `Calibration matches the installed game (${calibration.trees.length} trees).\n`,
  );
} else process.stdout.write(text);
