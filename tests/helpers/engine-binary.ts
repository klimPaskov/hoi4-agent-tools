import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/**
 * Tools on the shared Rust engine (ADR 0074, 0080) answer only with a `hoi4-engine` binary. The
 * npm package bundles one; a checkout has none, so the tests use a cargo build of `engine/`
 * (`cargo build -p hoi4-engine-cli`, in `CARGO_TARGET_DIR` or `engine/target`, release before
 * debug) unless `HOI4_ENGINE` already names one. Tests that check an unavailable engine set
 * `HOI4_ENGINE` themselves. Child processes, such as a spawned stdio server, inherit it.
 */
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Files that need the process to start without an engine. `mcp-focus-engine.test.ts` sets its
 * own `HOI4_ENGINE` and checks the game view without the engine by changing `HOI4_ENGINE` after a
 * job worker has started; a worker keeps the environment it started with, so an engine set here
 * would still draw the game view.
 */
const WITHOUT_ENGINE = new Set(['tests/integration/mcp-focus-engine.test.ts']);

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Set when this setup chose the binary, so a later file in the same process can undo it. */
const FROM_SETUP = 'HOI4_ENGINE_FROM_TEST_SETUP';
const testPath = expect.getState().testPath;
const relativeTestPath =
  testPath === undefined ? '' : path.relative(repositoryRoot, testPath).replaceAll(path.sep, '/');

if (WITHOUT_ENGINE.has(relativeTestPath)) {
  if (process.env[FROM_SETUP] !== undefined) {
    Reflect.deleteProperty(process.env, 'HOI4_ENGINE');
    Reflect.deleteProperty(process.env, FROM_SETUP);
  }
} else if (process.env.HOI4_ENGINE === undefined || process.env.HOI4_ENGINE === '') {
  const executable = process.platform === 'win32' ? 'hoi4-engine.exe' : 'hoi4-engine';
  const built = [process.env.CARGO_TARGET_DIR, path.join(repositoryRoot, 'engine', 'target')]
    .filter((entry): entry is string => entry !== undefined && entry !== '')
    .flatMap((target) => [
      path.resolve(target, 'release', executable),
      path.resolve(target, 'debug', executable),
    ])
    .find(isFile);
  if (built !== undefined) {
    process.env.HOI4_ENGINE = built;
    process.env[FROM_SETUP] = '1';
  }
}
