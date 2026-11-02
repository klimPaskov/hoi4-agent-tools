import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  RESIDENT_ENGINE_MAX_RESTARTS,
  ResidentEngine,
} from '../../src/hoi4_agent_tools/core/resident-engine.js';
import { decodeTextureWithEngine } from '../../src/hoi4_agent_tools/gui/engine-textures.js';
import { writeFakeResidentEngine } from '../helpers/fake-resident-engine.js';

let fakeEngine = '';
let missingRoot = '';
let removeFakeEngine: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const written = await writeFakeResidentEngine();
  fakeEngine = written.path;
  missingRoot = path.join(written.directory, 'no-package-root');
  removeFakeEngine = written.cleanup;
});

afterAll(async () => {
  await removeFakeEngine?.();
});

const engines: ResidentEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.close();
});

function engineIn(mode: string, extra: NodeJS.ProcessEnv = {}): ResidentEngine {
  const engine = new ResidentEngine({
    env: { ...process.env, HOI4_ENGINE: fakeEngine, FAKE_ENGINE_MODE: mode, ...extra },
    packageRoot: missingRoot,
  });
  engines.push(engine);
  return engine;
}

describe('resident engine', () => {
  it('sends a payload and reads the payload of the answer', async () => {
    const engine = engineIn('valid');
    const outcome = await engine.request(
      'texture.decode',
      { extension: 'dds' },
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
    expect(outcome).toMatchObject({
      ok: true,
      response: { result: { width: 2, height: 1, format: 'BC7_UNORM' } },
    });
    if (!outcome.ok) return;
    expect([...outcome.response.payload]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(engine.location).toEqual({ path: fakeEngine, source: 'environment' });
  });

  it('matches answers to requests by id when they come back out of order', async () => {
    const engine = engineIn('valid');
    const [first, second] = await Promise.all([
      engine.request('texture.decode', {}, Buffer.from([1, 1, 1, 1, 1, 1, 1, 1])),
      engine.request('texture.decode', {}, Buffer.from([2, 2, 2, 2, 2, 2, 2, 2])),
    ]);
    expect(first.ok && [...first.response.payload]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(second.ok && [...second.response.payload]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('reuses one process for many requests', async () => {
    const engine = engineIn('valid');
    for (let index = 0; index < 5; index += 1) {
      const outcome = await engine.request('hello');
      expect(outcome).toMatchObject({ ok: true, response: { result: { protocol: 1 } } });
    }
  });

  it('passes an engine error through with its details', async () => {
    const outcome = await engineIn('error').request('texture.decode', {}, Buffer.from([0]));
    expect(outcome).toEqual({
      ok: false,
      kind: 'error',
      code: 'unsupported',
      message: 'no',
      details: { format: 'BC6H_UF16' },
    });
  });

  it('reports a crash, restarts, and gives up after repeated crashes', async () => {
    const engine = engineIn('crash');
    for (let attempt = 0; attempt < RESIDENT_ENGINE_MAX_RESTARTS; attempt += 1) {
      const outcome = await engine.request('hello');
      expect(outcome).toMatchObject({ ok: false, kind: 'unavailable', reason: 'exit_status' });
      if (!outcome.ok && outcome.kind === 'unavailable')
        expect(outcome.message).toContain('fake engine crashed');
    }
    const last = await engine.request('hello');
    expect(last).toMatchObject({ ok: false, kind: 'unavailable', reason: 'exit_status' });
    if (!last.ok && last.kind === 'unavailable') expect(last.message).toContain('times in a row');
  });

  it('stops a process that prints something other than frames', async () => {
    const outcome = await engineIn('garbage').request('hello');
    expect(outcome).toMatchObject({ ok: false, kind: 'unavailable', reason: 'exit_status' });
  });

  it('times out a request the engine never answers', async () => {
    const outcome = await engineIn('silent').request('hello', {}, undefined, { timeoutMs: 200 });
    expect(outcome).toMatchObject({ ok: false, kind: 'unavailable', reason: 'timeout' });
  });

  it('rejects a cancelled request', async () => {
    const controller = new AbortController();
    const pending = engineIn('silent').request('hello', {}, undefined, {
      signal: controller.signal,
    });
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('reports a missing binary without starting anything', async () => {
    const engine = new ResidentEngine({
      env: { ...process.env, HOI4_ENGINE: '' },
      packageRoot: missingRoot,
    });
    engines.push(engine);
    expect(engine.available()).toBe(false);
    expect(await engine.request('hello')).toMatchObject({
      ok: false,
      kind: 'unavailable',
      reason: 'binary_not_found',
    });
  });
});

describe('engine texture decoding', () => {
  it('returns decoded pixels and the format', async () => {
    const outcome = await decodeTextureWithEngine(Buffer.alloc(16, 9), 'dds', 1024, {
      engine: engineIn('valid'),
    });
    expect(outcome).toEqual({
      decoded: { width: 2, height: 1, format: 'BC7_UNORM', data: Buffer.alloc(8, 9) },
    });
  });

  it('refuses an answer over the pixel limit', async () => {
    const outcome = await decodeTextureWithEngine(Buffer.alloc(16), 'dds', 1, {
      engine: engineIn('valid'),
    });
    expect(outcome).toMatchObject({ unsupported: true, engineAvailable: true });
  });

  it('names the format the engine could not decode', async () => {
    const outcome = await decodeTextureWithEngine(Buffer.alloc(16), 'dds', 1024, {
      engine: engineIn('error'),
    });
    expect(outcome).toEqual({
      unsupported: true,
      format: 'BC6H_UF16',
      reason: 'BC6H_UF16: no',
      engineAvailable: true,
    });
  });

  it('says how to get the engine when it is missing', async () => {
    const engine = new ResidentEngine({
      env: { ...process.env, HOI4_ENGINE: '' },
      packageRoot: missingRoot,
    });
    engines.push(engine);
    const outcome = await decodeTextureWithEngine(Buffer.alloc(16), 'dds', 1024, { engine });
    expect(outcome).toMatchObject({ unsupported: true, engineAvailable: false });
    if ('unsupported' in outcome) expect(outcome.reason).toContain('HOI4_ENGINE');
  });
});
