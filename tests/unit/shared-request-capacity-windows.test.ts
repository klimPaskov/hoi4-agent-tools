import { mkdtemp, rm } from 'node:fs/promises';
import type * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SharedRequestCapacity } from '../../src/hoi4_agent_tools/core/shared-request-capacity.js';

const injected = vi.hoisted(() => ({ remaining: 0, failures: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fileSystem>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (
        path.basename(String(args[0])) === '0' &&
        args[1] === undefined &&
        injected.remaining > 0
      ) {
        injected.remaining -= 1;
        injected.failures += 1;
        throw Object.assign(new Error('injected delete-pending directory'), { code: 'EPERM' });
      }
      return actual.mkdir(...args);
    },
  };
});

describe.runIf(process.platform === 'win32')('Windows delete-pending capacity slots', () => {
  it('retries temporary mkdir failures without executing work twice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-capacity-delete-pending-'));
    injected.remaining = 3;
    injected.failures = 0;
    let executed = 0;
    try {
      expect(
        await new SharedRequestCapacity(root, 1).run(
          new AbortController().signal,
          async () => ++executed,
        ),
      ).toBe(1);
      expect(executed).toBe(1);
      expect(injected.failures).toBe(3);
    } finally {
      injected.remaining = 0;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps persistent permission failures bounded and never starts the action', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-capacity-permission-failure-'));
    injected.remaining = 100;
    injected.failures = 0;
    let executed = false;
    try {
      await expect(
        new SharedRequestCapacity(root, 1).run(new AbortController().signal, async () => {
          executed = true;
        }),
      ).rejects.toMatchObject({ code: 'EPERM' });
      expect(executed).toBe(false);
      expect(injected.failures).toBe(50);
    } finally {
      injected.remaining = 0;
      await rm(root, { recursive: true, force: true });
    }
  });
});
