import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
    let release!: () => void;
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
      await ready;
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
      await running;
      await rm(root, { recursive: true, force: true });
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
