import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

describe('CoreEngine scan cache', () => {
  it('ignores metadata-only changes and invalidates on same-metadata content changes', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-core-cache-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const sourcePath = path.join(workspaceRoot, 'common', 'national_focus', 'cache.txt');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      const original = [
        'focus_tree = {',
        '\tid = cache_alpha',
        '\tcountry = { factor = 0 }',
        '\tfocus = { id = cache_focus x = 0 y = 0 cost = 1 }',
        '}',
        '',
      ].join('\n');
      const changed = original.replace('cache_alpha', 'cache_omega');
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
      await writeFile(sourcePath, original, 'utf8');

      const firstTime = new Date('2020-01-01T00:00:00.000Z');
      const secondTime = new Date('2021-01-01T00:00:00.000Z');
      await utimes(sourcePath, firstTime, firstTime);
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        writePolicy: 'read-only',
        storageRoots: [path.join(temporaryRoot, 'artifacts'), path.join(temporaryRoot, 'cache')],
        workspaces: [
          {
            id: 'cache_test',
            name: 'Project-owned cache test fixture',
            root: workspaceRoot,
            artifactRoot: path.join(temporaryRoot, 'artifacts'),
            cacheRoot: path.join(temporaryRoot, 'cache'),
            writeEnabled: false,
          },
        ],
      });
      const resolver = await WorkspaceResolver.create(configuration);
      const engine = new CoreEngine(resolver);

      const first = await engine.scan('cache_test');
      await utimes(sourcePath, secondTime, secondTime);
      const metadataOnly = await engine.scan('cache_test');
      expect(metadataOnly).toBe(first);
      expect(metadataOnly.revision).toBe(first.revision);

      const metadataBefore = await stat(sourcePath);
      await writeFile(sourcePath, changed, 'utf8');
      await utimes(sourcePath, secondTime, secondTime);
      const metadataAfter = await stat(sourcePath);
      expect(metadataAfter.size).toBe(metadataBefore.size);
      expect(metadataAfter.mtimeMs).toBe(metadataBefore.mtimeMs);

      const contentChanged = await engine.scan('cache_test');
      expect(contentChanged).not.toBe(metadataOnly);
      expect(contentChanged.revision).not.toBe(metadataOnly.revision);
      expect(contentChanged.files[0]?.sha256).not.toBe(metadataOnly.files[0]?.sha256);

      const boundedOptions = {
        patterns: ['common/**/*.txt'],
        ignore: ['**/ignored/**'],
        maxFiles: 10,
        maxBytes: 1024 * 1024,
      };
      const bounded = await engine.scan('cache_test', boundedOptions);
      engine.invalidate('other-workspace');
      expect(await engine.scan('cache_test', boundedOptions)).toBe(bounded);
      engine.invalidate('cache_test');
      expect(await engine.scan('cache_test', boundedOptions)).not.toBe(bounded);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('single-flights identical scans without sharing caller cancellation authority', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-core-flight-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const sourcePath = path.join(workspaceRoot, 'common', 'national_focus', 'flight.txt');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, 'focus_tree = { id = flight_tree }\n');
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        workspaces: [{ id: 'flight', name: 'Flight', root: workspaceRoot }],
      });
      const resolver = await WorkspaceResolver.create(configuration);
      const scanner = new WorkspaceScanner();
      const original = scanner.scan.bind(scanner);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scan = vi.spyOn(scanner, 'scan').mockImplementation(async (...arguments_) => {
        await gate;
        return original(...arguments_);
      });
      const engine = new CoreEngine(resolver, { scanner });
      const cancelled = new AbortController();
      const first = engine.scan('flight', {}, undefined, cancelled.signal);
      const second = engine.scan('flight');
      cancelled.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      release();
      await expect(second).resolves.toMatchObject({ workspaceId: 'flight' });
      expect(scan).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('invalidates and aborts an older in-flight generation before post-write scans', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-core-generation-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const sourcePath = path.join(workspaceRoot, 'common', 'national_focus', 'generation.txt');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, 'focus_tree = { id = before_generation }\n');
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        workspaces: [{ id: 'generation', name: 'Generation', root: workspaceRoot }],
      });
      const resolver = await WorkspaceResolver.create(configuration);
      const scanner = new WorkspaceScanner();
      const original = scanner.scan.bind(scanner);
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scanned = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const scan = vi.spyOn(scanner, 'scan').mockImplementationOnce(async (...arguments_) => {
        const files = await original(...arguments_);
        ready();
        await gate;
        return files;
      });
      const engine = new CoreEngine(resolver, { scanner });
      const oldFlight = engine.scan('generation');
      const oldFlightRejected = expect(oldFlight).rejects.toMatchObject({ name: 'AbortError' });
      await scanned;
      await writeFile(sourcePath, 'focus_tree = { id = after_generation }\n');
      engine.invalidate('generation');
      const fresh = await engine.scan('generation');
      await oldFlightRejected;
      expect(scan).toHaveBeenCalledTimes(2);

      // The stale scanner is still physically pending here. Its eventual
      // completion must neither replace the fresh cache entry nor disturb the
      // current generation's flight bookkeeping.
      release();
      expect(fresh.index.find('focus_tree', 'after_generation')).toBeDefined();
      expect(fresh.index.find('focus_tree', 'before_generation')).toBeUndefined();
      const cached = await engine.scan('generation');
      expect(cached).toBe(fresh);
      expect(scan).toHaveBeenCalledTimes(3);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('bounds ignored-abort replacements to two physical scanner calls', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hoi4-core-admission-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const sourcePath = path.join(workspaceRoot, 'common', 'national_focus', 'admission.txt');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, 'focus_tree = { id = admission_tree }\n');
      const configuration = serverConfigurationSchema.parse({
        version: 1,
        workspaces: [{ id: 'admission', name: 'Admission', root: workspaceRoot }],
      });
      const resolver = await WorkspaceResolver.create(configuration);
      const scanner = new WorkspaceScanner();
      const original = scanner.scan.bind(scanner);
      const releases: Array<() => void> = [];
      const ready: Array<Promise<void>> = [];
      const markReady: Array<() => void> = [];
      for (let index = 0; index < 3; index += 1) {
        ready.push(
          new Promise<void>((resolve) => {
            markReady.push(resolve);
          }),
        );
      }
      const gates = Array.from(
        { length: 3 },
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
      let calls = 0;
      let active = 0;
      let maximumActive = 0;
      const scan = vi.spyOn(scanner, 'scan').mockImplementation(async (...arguments_) => {
        const call = calls;
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          // Finish the real filesystem work before blocking so each invocation
          // deliberately ignores a later AbortSignal while still occupying
          // physical scanner capacity.
          const files = await original(...arguments_);
          markReady[call]?.();
          await gates[call];
          return files;
        } finally {
          active -= 1;
        }
      });
      const engine = new CoreEngine(resolver, { scanner });

      const first = engine.scan('admission');
      const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await ready[0];

      const serializedController = new AbortController();
      const serialized = engine.scan(
        'admission',
        { patterns: ['common/national_focus/**/*.txt'] },
        undefined,
        serializedController.signal,
      );
      const serializedRejected = expect(serialized).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(scan).toHaveBeenCalledTimes(1);
      serializedController.abort();
      await serializedRejected;

      engine.invalidate('admission');
      await firstRejected;

      const second = engine.scan('admission');
      const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
      await ready[1];
      expect(scan).toHaveBeenCalledTimes(2);
      expect(maximumActive).toBe(2);
      engine.invalidate('admission');
      await secondRejected;

      const third = engine.scan('admission');
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(scan).toHaveBeenCalledTimes(2);

      releases[0]?.();
      await ready[2];
      expect(scan).toHaveBeenCalledTimes(3);
      expect(maximumActive).toBe(2);

      releases[1]?.();
      releases[2]?.();
      await expect(third).resolves.toMatchObject({ workspaceId: 'admission' });
      expect(maximumActive).toBe(2);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
