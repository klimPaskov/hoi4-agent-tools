import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';

const tracking = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  reads: 0,
  onOpen: undefined as ((file: string) => Promise<void>) | undefined,
  onRead: undefined as ((file: string) => Promise<void>) | undefined,
  onStat: undefined as ((file: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = String(args[0]);
      if (file.endsWith('.txt') && tracking.onOpen !== undefined) {
        const hook = tracking.onOpen;
        tracking.onOpen = undefined;
        await hook(file);
      }
      const handle = await actual.open(...args);
      if (!file.endsWith('.txt')) return handle;
      tracking.active++;
      tracking.peak = Math.max(tracking.peak, tracking.active);
      let closed = false;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat')
            return async () => {
              const metadata = await target.stat();
              const hook = tracking.onStat;
              if (hook !== undefined) {
                tracking.onStat = undefined;
                await hook(file);
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
              return metadata;
            };
          if (property === 'read')
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null,
            ) => {
              tracking.reads++;
              const hook = tracking.onRead;
              if (hook !== undefined) {
                tracking.onRead = undefined;
                await hook(file);
              }
              return target.read(buffer, offset, length, position);
            };
          if (property === 'close')
            return async () => {
              try {
                await target.close();
              } finally {
                if (!closed) {
                  closed = true;
                  tracking.active--;
                }
              }
            };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const roots: string[] = [];
beforeEach(() => {
  tracking.active = 0;
  tracking.peak = 0;
  tracking.reads = 0;
  tracking.onOpen = undefined;
  tracking.onRead = undefined;
  tracking.onStat = undefined;
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(count: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-scan-batch-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(path.join(mod, `${index}.txt`), `value = ${index}`),
    ),
  );
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'test', name: 'Scanner batch', root: mod }],
    }),
  );
  return { root, mod, workspace: resolver.get('test') };
}

describe('bounded parallel source verification', () => {
  it('overlaps file I/O within a fixed handle ceiling and retains deterministic bytes', async () => {
    const { workspace } = await fixture(17);
    const scanner = new WorkspaceScanner();
    const result = await scanner.scan(workspace, { patterns: ['*.txt'] });
    expect(result).toHaveLength(17);
    expect(tracking.peak).toBeGreaterThan(1);
    expect(tracking.peak).toBeLessThanOrEqual(8);
    expect(tracking.active).toBe(0);
    expect(result.map(({ relativePath, bytes }) => [relativePath, bytes.toString()])).toEqual(
      [...result]
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
        .map(({ relativePath }) => [relativePath, `value = ${Number.parseInt(relativePath, 10)}`]),
    );
    const repeated = await scanner.scan(workspace, { patterns: ['*.txt'] });
    expect(repeated.map(({ sha256 }) => sha256)).toEqual(result.map(({ sha256 }) => sha256));
  });

  it('closes every prepared handle when the aggregate byte budget rejects a batch', async () => {
    const { workspace } = await fixture(8);
    await expect(
      new WorkspaceScanner(20, 10).scan(workspace, { patterns: ['*.txt'] }),
    ).rejects.toMatchObject({ code: 'SCAN_BYTE_LIMIT' });
    expect(tracking.active).toBe(0);
    expect(tracking.reads).toBe(0);
  });

  it('rejects a source that grows after admission without returning a partial snapshot', async () => {
    const { workspace } = await fixture(4);
    tracking.onRead = async (file) => {
      await writeFile(file, 'changed = yes\n'.repeat(20));
    };
    await expect(
      new WorkspaceScanner().scan(workspace, { patterns: ['*.txt'] }),
    ).rejects.toMatchObject({ code: 'SCAN_SOURCE_CHANGED' });
    expect(tracking.active).toBe(0);
  });

  it('rejects a root replacement before reading outside its authorized capability', async () => {
    const { root, mod, workspace } = await fixture(1);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, '0.txt'), 'private = yes');
    tracking.onOpen = async () => {
      await rename(mod, path.join(root, 'original-mod'));
      await symlink(outside, mod, process.platform === 'win32' ? 'junction' : 'dir');
    };
    await expect(
      new WorkspaceScanner().scan(workspace, { patterns: ['*.txt'] }),
    ).rejects.toMatchObject({ code: 'SCAN_ROOT_ESCAPE' });
    expect(tracking.active).toBe(0);
    expect(tracking.reads).toBe(0);
  });

  it('closes all prepared handles when cancellation arrives during a read', async () => {
    const { workspace } = await fixture(8);
    const controller = new AbortController();
    tracking.onRead = async () => {
      controller.abort();
    };
    await expect(
      new WorkspaceScanner().scan(workspace, { patterns: ['*.txt'], signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracking.active).toBe(0);
  });
});
