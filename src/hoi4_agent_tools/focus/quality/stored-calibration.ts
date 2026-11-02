import calibrationFile from './focus-quality-calibration.json' with { type: 'json' };
import type { QualityCalibration } from './types.js';

/**
 * Statistics of the vanilla focus trees, computed by `npm run focus:calibrate` from the installed
 * game. Only derived numbers are stored, never game files. A test recomputes it whenever the game
 * is installed and fails when this file drifts.
 */
export const STORED_QUALITY_CALIBRATION = calibrationFile as unknown as QualityCalibration;
