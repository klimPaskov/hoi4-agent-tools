import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SharedRequestCapacity } from '../../src/hoi4_agent_tools/core/shared-request-capacity.js';

describe('shared task-process execution capacity', () => {
  it('handles repeated contention without exceeding capacity or losing a lease', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-capacity-contention-'));
    let active = 0;
    let peak = 0;
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 32 }, async (_, id) => {
          const capacity = new SharedRequestCapacity(root, 2);
          return capacity.run(new AbortController().signal, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
            active -= 1;
            return id;
          });
        }),
      );
      for (const result of results) expect(result.status, JSON.stringify(result)).toBe('fulfilled');
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('coordinates independent instances and cancels waits without disturbing the owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-shared-capacity-'));
    const first = new SharedRequestCapacity(root, 1);
    const second = new SharedRequestCapacity(root, 1);
    let release: () => void = () => undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = first.run(new AbortController().signal, () => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    try {
      await Promise.race([ready, running]);
      const controller = new AbortController();
      const cancelled = second.run(controller.signal, async () => {
        throw new Error('Must not start');
      });
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      let nextStarted = false;
      const next = second.run(new AbortController().signal, async () => {
        nextStarted = true;
        return 9;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 130));
      expect(nextStarted).toBe(false);
      release();
      await running;
      expect(await next).toBe(9);
      const slots = path.join(
        root,
        'request-capacity',
        sha256Bytes(hostname().toLowerCase()).slice(0, 16),
      );
      expect(await readdir(slots)).toEqual([]);
    } finally {
      release();
      await running.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares capacity through a configured filesystem alias without permitting descendant escape', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-capacity-alias-'));
    const root = path.join(temporary, 'state');
    const alias = path.join(temporary, 'alias');
    const outside = path.join(temporary, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    let active = 0;
    let peak = 0;
    try {
      await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const capacity = new SharedRequestCapacity(index % 2 === 0 ? root : alias, 1);
          return capacity.run(new AbortController().signal, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
            active -= 1;
          });
        }),
      );
      expect(peak).toBe(1);
      await rm(path.join(root, 'request-capacity'), { recursive: true });
      await symlink(
        outside,
        path.join(root, 'request-capacity'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        new SharedRequestCapacity(alias).run(new AbortController().signal, async () => 'escaped'),
      ).rejects.toMatchObject({ code: 'PATH_GENERATED_ROOT_ESCAPE' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('recovers a dead process lease without deleting any live owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-dead-capacity-'));
    try {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      const pid = child.pid!;
      await new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      });
      const slot = path.join(
        root,
        'request-capacity',
        sha256Bytes(hostname().toLowerCase()).slice(0, 16),
        '0',
      );
      await mkdir(slot, { recursive: true });
      await writeFile(path.join(slot, `${pid}-${randomUUID()}.lease`), '');
      const capacity = new SharedRequestCapacity(root, 1);
      await expect(
        capacity.run(new AbortController().signal, async () => 'recovered'),
      ).resolves.toBe('recovered');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases a lease when the operation throws', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-failed-capacity-'));
    try {
      const capacity = new SharedRequestCapacity(root, 1);
      await expect(
        capacity.run(new AbortController().signal, async () => {
          throw new Error('failed');
        }),
      ).rejects.toThrow('failed');
      await expect(capacity.run(new AbortController().signal, async () => 'next')).resolves.toBe(
        'next',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
