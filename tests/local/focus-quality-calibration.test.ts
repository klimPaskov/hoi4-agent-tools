import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import { STORED_QUALITY_CALIBRATION } from '../../src/hoi4_agent_tools/focus/quality/index.js';
import {
  computeCalibration,
  findGameRoot,
} from '../../scripts/testing/focus-quality-calibration.js';

// Opt in with HOI4_GAME_ROOT (or a default Steam library). Without the game the test is skipped:
// the calibration cannot be recomputed, and the reason is the skip itself.
const gameRoot = findGameRoot();

describe.skipIf(gameRoot === undefined)(
  'focus-quality calibration against the installed game',
  () => {
    it('matches the stored calibration, which fails when the game or a metric changes', () => {
      const recomputed = computeCalibration(
        gameRoot!,
        STORED_QUALITY_CALIBRATION.game.versionLabel,
      );
      // A drifted file names the vanilla tree files whose hash differs, then the whole-file diff.
      const changedSources = recomputed.sources
        .filter(
          ({ file, sha256 }) =>
            STORED_QUALITY_CALIBRATION.sources.find((stored) => stored.file === file)?.sha256 !==
            sha256,
        )
        .map(({ file }) => file);
      expect(changedSources, 'vanilla focus files that differ from the calibration').toEqual([]);
      expect(recomputed.game.revision).toBe(STORED_QUALITY_CALIBRATION.game.revision);
      expect(JSON.parse(canonicalJson(recomputed))).toEqual(
        JSON.parse(canonicalJson(STORED_QUALITY_CALIBRATION)),
      );
    });
  },
);
