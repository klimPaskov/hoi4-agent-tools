import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  locateEngineBinary,
  packagedEngineBinaryPath,
  runFocusLayoutEngine,
  type FocusLayoutEngineRequest,
} from '../../src/hoi4_agent_tools/core/engine-client.js';
import { writeFakeEngine } from '../helpers/fake-engine.js';

let fakeEngine = '';
let missingRoot = '';
let removeFakeEngine: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const written = await writeFakeEngine();
  fakeEngine = written.path;
  missingRoot = path.join(written.directory, 'no-package-root');
  removeFakeEngine = written.cleanup;
});

afterAll(async () => {
  await removeFakeEngine?.();
});

const request: FocusLayoutEngineRequest = {
  schema: 'hoi4-focus-layout-request/1',
  operation: 'layout',
  treeId: 'tree',
  focuses: [{ id: 'a' }, { id: 'b', prerequisites: [['a']] }],
};

/** Each test gets its own environment object; process.env is never changed. */
function fakeEnv(mode: string): NodeJS.ProcessEnv {
  return { ...process.env, HOI4_ENGINE: fakeEngine, FAKE_ENGINE_MODE: mode };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe('engine client', () => {
  it('returns a validated response from the engine', async () => {
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('valid'),
      packageRoot: missingRoot,
    });
    expect(result.outcome).toBe('response');
    if (result.outcome !== 'response') return;
    expect(result.available).toBe(true);
    expect(result.binary).toEqual({ path: fakeEngine, source: 'environment' });
    expect(result.response.status).toBe('ok');
    expect(result.response.treeId).toBe('tree');
    expect(result.response.nodes.map(({ id, x }) => [id, x])).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
  });

  it('reports output that is not JSON as unavailable', async () => {
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('invalid-json'),
      packageRoot: missingRoot,
    });
    expect(result).toMatchObject({
      available: false,
      outcome: 'unavailable',
      reason: 'invalid_output',
    });
  });

  it('reports JSON that does not match the response schema as unavailable', async () => {
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('wrong-shape'),
      packageRoot: missingRoot,
    });
    expect(result).toMatchObject({ available: false, reason: 'invalid_output' });
    if (result.available) return;
    expect(result.message).toContain('does not match its schema');
  });

  it('returns the engine error for an invalid request', async () => {
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('invalid-request'),
      packageRoot: missingRoot,
    });
    expect(result).toMatchObject({
      available: true,
      outcome: 'invalid_request',
      error: { code: 'FOCUS_ENGINE_DUPLICATE_FOCUS', message: 'duplicate focus a' },
    });
  });

  it('reports a non-zero exit as unavailable with the exit code and stderr', async () => {
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('crash'),
      packageRoot: missingRoot,
    });
    expect(result).toMatchObject({ available: false, reason: 'exit_status' });
    if (result.available) return;
    expect(result.message).toContain('code 101');
    expect(result.message).toContain('panicked');
  });

  it('stops an engine that runs past the timeout', async () => {
    const started = Date.now();
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('hang'),
      packageRoot: missingRoot,
      timeoutMs: 500,
    });
    expect(result).toMatchObject({ available: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops an engine whose output exceeds the bound', async () => {
    const result = await runFocusLayoutEngine(request, {
      env: fakeEnv('flood'),
      packageRoot: missingRoot,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({ available: false, reason: 'output_too_large' });
  });

  it('rejects when the caller cancels', async () => {
    const controller = new AbortController();
    const pending = runFocusLayoutEngine(request, {
      env: fakeEnv('hang'),
      packageRoot: missingRoot,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 200);
    await expect(pending).rejects.toThrow('cancelled by test');
  });

  it('reports a missing binary without falling back', async () => {
    const env = { ...process.env };
    delete env.HOI4_ENGINE;
    const result = await runFocusLayoutEngine(request, { env, packageRoot: missingRoot });
    expect(result).toMatchObject({
      available: false,
      outcome: 'unavailable',
      reason: 'binary_not_found',
    });
    if (result.available) return;
    expect(result.message).toContain('HOI4_ENGINE');
  });

  it('does not fall back to the bundled binary when HOI4_ENGINE is unusable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-engine-client-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bundled = packagedEngineBinaryPath(root);
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, '');
    expect(locateEngineBinary({ env: {}, packageRoot: root })).toEqual({
      path: bundled,
      source: 'package',
    });
    expect(
      locateEngineBinary({ env: { HOI4_ENGINE: path.join(root, 'missing') }, packageRoot: root }),
    ).toMatchObject({ reason: 'binary_not_found' });
    expect(
      locateEngineBinary({ env: { HOI4_ENGINE: 'relative/hoi4-engine' }, packageRoot: root }),
    ).toMatchObject({ reason: 'binary_path_invalid' });
  });

  it('names the platform directory and executable suffix', () => {
    expect(packagedEngineBinaryPath('/pkg', 'win32', 'x64')).toBe(
      path.join('/pkg', 'engine', 'bin', 'win32-x64', 'hoi4-engine.exe'),
    );
    expect(packagedEngineBinaryPath('/pkg', 'darwin', 'arm64')).toBe(
      path.join('/pkg', 'engine', 'bin', 'darwin-arm64', 'hoi4-engine'),
    );
  });
});
