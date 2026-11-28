import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import {
  JobOperations,
  type JobExecutionContext,
} from '../../src/hoi4_agent_tools/core/job-executor.js';
import {
  DEFAULT_IDLE_CACHE_RELEASE_MS,
  idleCacheLifetime,
} from '../../src/hoi4_agent_tools/core/idle-cache-lifetime.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { registerFocusJobs } from '../../src/hoi4_agent_tools/focus/job-operations.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function engineWith(extra: Record<string, unknown>): Promise<CoreEngine> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-idle-cache-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const mod = path.join(root, 'mod');
  const source = path.join(mod, 'common', 'national_focus', 'idle.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    'focus_tree = { id = idle_tree focus = { id = idle_root x = 0 y = 0 cost = 1 } }\n',
  );
  return new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [{ id: 'fixture', name: 'Fixture', root: mod }],
        ...extra,
      }),
    ),
  );
}

async function inspect(engine: CoreEngine, operations: JobOperations) {
  const context: JobExecutionContext = {
    engine,
    workspaceId: 'fixture',
    principal: undefined,
    signal: new AbortController().signal,
    checkpoint: undefined,
    progress: async () => undefined,
    saveCheckpoint: async () => undefined,
    stageResult: async () => undefined,
  };
  const operation = operations.get('hoi4.focus_inspect');
  if (operation.mutation) throw new Error('hoi4.focus_inspect is a read operation');
  return operation.run(
    {
      workspaceId: 'fixture',
      relativePath: 'common/national_focus/idle.txt',
      treeId: 'idle_tree',
    },
    context,
  );
}

describe('idle cache release', () => {
  it('defaults to 30 seconds, accepts 0 to 3600, and refuses more', () => {
    const base = { version: 1 };
    expect(serverConfigurationSchema.parse(base).idleCacheReleaseSeconds).toBe(30);
    expect(DEFAULT_IDLE_CACHE_RELEASE_MS).toBe(30_000);
    expect(
      serverConfigurationSchema.parse({ ...base, idleCacheReleaseSeconds: 0 })
        .idleCacheReleaseSeconds,
    ).toBe(0);
    expect(
      serverConfigurationSchema.parse({ ...base, idleCacheReleaseSeconds: 3_600 })
        .idleCacheReleaseSeconds,
    ).toBe(3_600);
    for (const bad of [-1, 3_601, 1.5, '30'])
      expect(() =>
        serverConfigurationSchema.parse({ ...base, idleCacheReleaseSeconds: bad }),
      ).toThrow();
  });

  it('releases the caches after the configured idle time and not before', async () => {
    const engine = await engineWith({ idleCacheReleaseSeconds: 45 });
    const release = vi.fn();
    vi.useFakeTimers();
    const lifetime = idleCacheLifetime(engine, release);
    await lifetime.run(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(44_999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a call at once when set to 0', async () => {
    const engine = await engineWith({ idleCacheReleaseSeconds: 0 });
    const release = vi.fn();
    vi.useFakeTimers();
    await idleCacheLifetime(engine, release).run(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the scan caches after a tool call and rebuilds them on the next one', async () => {
    const engine = await engineWith({ idleCacheReleaseSeconds: 1 });
    const operations = new JobOperations();
    registerFocusJobs(operations, engine);
    const release = vi.spyOn(engine, 'releaseScanCaches');
    const build = vi.spyOn(SymbolIndex, 'buildAsync');

    expect(await inspect(engine, operations)).toMatchObject({
      structuredContent: { status: 'ok' },
    });
    const builtFirst = build.mock.calls.length;
    expect(builtFirst).toBeGreaterThan(0);
    // A second call at once reuses the caches: nothing is released or built again.
    expect(await inspect(engine, operations)).toMatchObject({
      structuredContent: { status: 'ok' },
    });
    expect(release).not.toHaveBeenCalled();
    expect(build.mock.calls.length).toBe(builtFirst);

    // After the idle time the caches are released, and the next call rebuilds the index.
    await vi.waitFor(() => expect(release).toHaveBeenCalled(), { timeout: 15_000 });
    expect(await inspect(engine, operations)).toMatchObject({
      structuredContent: { status: 'ok' },
    });
    expect(build.mock.calls.length).toBeGreaterThan(builtFirst);
  }, 120_000);
});
