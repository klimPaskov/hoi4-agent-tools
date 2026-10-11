import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TemporaryDirectoryLifetime,
  sweepTemporaryDirectories,
  TEMPORARY_MAX_BYTES,
  TEMPORARY_STALE_MS,
} from '../../src/hoi4_agent_tools/core/temporary-directories.js';

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'hoi4-temp-lifetime-test-'));
  const old = new Date(Date.now() - TEMPORARY_STALE_MS - 60_000);
  const scratch = async (suffix: string, bytes = 8) => {
    const directory = path.join(parent, `hoi4-reference-source-${suffix}`);
    await mkdir(directory);
    const file = path.join(directory, 'source.txt');
    await writeFile(file, Buffer.alloc(bytes));
    await utimes(file, old, old);
    await utimes(directory, old, old);
    return directory;
  };
  const lease = async (directory: string, pid: number) => {
    await writeFile(
      path.join(directory, '.hoi4-temp-owner.json'),
      JSON.stringify({
        version: 1,
        pid,
        host: hostname(),
        token: randomUUID(),
      }),
    );
  };
  return { parent, scratch, lease };
}

describe('temporary directory ownership and recovery', () => {
  it('removes owned fixtures on normal and idle-style shutdown, even after a failed operation', async () => {
    const { parent } = await fixture();
    for (const reason of ['normal', 'idle', 'failure']) {
      const directory = path.join(parent, reason);
      await mkdir(directory);
      const lifetime = new TemporaryDirectoryLifetime();
      try {
        await lifetime.own(directory);
        await writeFile(path.join(directory, 'partial'), 'partial data');
        if (reason === 'failure') throw new Error('interrupted fixture');
      } catch {
        // The operation failed; cleanup still owns the partially written directory.
      } finally {
        await lifetime.dispose();
      }
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each(['normal', 'idle'])(
    'cleans fixtures on %s process exit without a finally block',
    async (reason) => {
      const { parent } = await fixture();
      const directory = path.join(parent, 'child');
      await mkdir(directory);
      const moduleUrl = new URL(
        '../../src/hoi4_agent_tools/core/temporary-directories.ts',
        import.meta.url,
      ).href;
      const idleUrl = new URL(
        '../../src/hoi4_agent_tools/mcp/transports/stdio-lifetime.ts',
        import.meta.url,
      ).href;
      const code = `import { TemporaryDirectoryLifetime } from ${JSON.stringify(moduleUrl)};
      import { StdioLifetime } from ${JSON.stringify(idleUrl)};
      const lifetime = new TemporaryDirectoryLifetime();
      await lifetime.own(process.argv[1]);
      if (${JSON.stringify(reason)} === 'idle') {
        let now = 0;
        const idle = new StdioLifetime({ idleExitMinutes: 1, now: () => now,
          isAlive: () => true, onExit: () => process.exit(0) });
        now = 60001; idle.check(); process.exit(1);
      } else process.exit(0);`;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code, directory],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(stderr).toBe('');
      expect(exit).toBe(0);
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('sweeps stale legacy scratch but preserves fresh folders and dated benchmark evidence', async () => {
    const { parent, scratch } = await fixture();
    const stale = await scratch('old001');
    const fresh = await scratch('new001');
    const now = Date.now() + TEMPORARY_STALE_MS + 60_000;
    await utimes(fresh, new Date(now), new Date(now));
    const evidence = path.join(parent, 'hoi4-event-eval-2026-10-11');
    await mkdir(evidence);
    const result = await sweepTemporaryDirectories(parent, {
      now,
    });
    // birthtime is also checked: simulate an age past creation without allocating large files.
    expect(result.removed).toBe(1);
    await expect(readdir(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(evidence)).toEqual([]);
  });

  it('recovers a hard-killed process that could not run exit cleanup', async () => {
    const { parent, scratch } = await fixture();
    const directory = await scratch('crash1');
    const moduleUrl = new URL(
      '../../src/hoi4_agent_tools/core/temporary-directories.ts',
      import.meta.url,
    ).href;
    const code = `import { TemporaryDirectoryLifetime } from ${JSON.stringify(moduleUrl)};
      const lifetime = new TemporaryDirectoryLifetime();
      await lifetime.own(process.argv[1]); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code, directory],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', () => resolve());
        child.once('exit', () => reject(new Error('Child exited before acquiring ownership')));
      });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    expect(await readdir(directory)).toContain('.hoi4-temp-owner.json');
    expect((await sweepTemporaryDirectories(parent, { maxBytes: 0 })).removed).toBe(1);
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete live, foreign, malformed or locked owners, regardless of age and size', async () => {
    const { parent, scratch, lease } = await fixture();
    const live = await scratch('live01');
    await lease(live, process.pid);
    const locked = await scratch('lock01');
    await lease(locked, 1);
    await writeFile(path.join(locked, 'writer.lock'), 'locked');
    const malformed = await scratch('bad001');
    await writeFile(path.join(malformed, '.hoi4-temp-owner.json'), '{}');
    const foreign = await scratch('host01');
    await writeFile(
      path.join(foreign, '.hoi4-temp-owner.json'),
      JSON.stringify({
        version: 1,
        pid: 1,
        host: 'another-host',
        token: randomUUID(),
      }),
    );
    const result = await sweepTemporaryDirectories(parent, {
      now: Date.now() + 10 * TEMPORARY_STALE_MS,
      maxBytes: 0,
      isAlive: (pid) => pid === process.pid,
    });
    expect(result.removed).toBe(0);
    for (const directory of [live, locked, malformed, foreign])
      expect(await readdir(directory)).not.toEqual([]);
    expect(await readFile(path.join(locked, 'writer.lock'), 'utf8')).toBe('locked');
  });

  it('evicts dead owners oldest first to meet the cap, including recent crash leftovers', async () => {
    const { parent, scratch, lease } = await fixture();
    const first = await scratch('dead01', 16);
    const second = await scratch('dead02', 16);
    await lease(first, 1);
    await lease(second, 2);
    const result = await sweepTemporaryDirectories(parent, { maxBytes: 16, isAlive: () => false });
    expect(result).toEqual({ removed: 1, retainedBytes: 16 });
    expect(
      (await readdir(parent)).filter((name) => name.startsWith('hoi4-reference-source-')),
    ).toHaveLength(1);
  });

  it('rejects oversized allocation before growing a fixture file', async () => {
    const { parent } = await fixture();
    const file = path.join(parent, 'large.png');
    const handle = await open(file, 'w');
    try {
      await expect(handle.truncate(TEMPORARY_MAX_BYTES + 1)).rejects.toThrow('disk budget');
    } finally {
      await handle.close();
    }
    expect(await readFile(file)).toHaveLength(0);
  });

  it('reserves the aggregate budget before concurrent writes and frees it at teardown', async () => {
    const { parent } = await fixture();
    const directory = path.join(parent, 'budget');
    await mkdir(directory);
    const lifetime = new TemporaryDirectoryLifetime(16);
    await lifetime.own(directory);
    try {
      const reservations = await Promise.allSettled([
        Promise.resolve().then(() => lifetime.assertFileSize(path.join(directory, 'a'), 12)),
        Promise.resolve().then(() => lifetime.assertFileSize(path.join(directory, 'b'), 12)),
      ]);
      expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(reservations.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await lifetime.release(directory);
      await mkdir(directory);
      await lifetime.own(directory);
      expect(lifetime.assertFileSize(path.join(directory, 'c'), 16)).toBeUndefined();
    } finally {
      await lifetime.dispose();
    }
  });

  it('cannot adopt scratch while a sweep owns its exclusive lock', async () => {
    const { scratch } = await fixture();
    const directory = await scratch('race01');
    const lock = path.join(directory, '.hoi4-temp-sweep.lock');
    await writeFile(lock, 'sweeping');
    const lifetime = new TemporaryDirectoryLifetime();
    try {
      await expect(lifetime.own(directory)).rejects.toThrow('being swept');
      expect(await readFile(lock, 'utf8')).toBe('sweeping');
    } finally {
      await lifetime.dispose();
    }
  });

  it('recovers an interrupted sweep without breaking a live sweep lock', async () => {
    const { parent, scratch } = await fixture();
    const dead = await scratch('sweep1');
    const live = await scratch('sweep2');
    for (const [directory, pid] of [
      [dead, 1],
      [live, process.pid],
    ] as const)
      await writeFile(
        path.join(directory, '.hoi4-temp-sweep.lock'),
        JSON.stringify({
          version: 1,
          pid,
          host: hostname(),
          token: randomUUID(),
        }),
      );
    const result = await sweepTemporaryDirectories(parent, {
      now: Date.now() + 10 * TEMPORARY_STALE_MS,
      isAlive: (pid) => pid === process.pid,
    });
    expect(result.removed).toBe(1);
    await expect(readdir(dead)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(live)).toContain('.hoi4-temp-sweep.lock');
  });

  it('preserves configured workspaces and storage even when their scratch-named ancestor is stale', async () => {
    const { parent, scratch } = await fixture();
    const directory = await scratch('roots1');
    const workspace = path.join(directory, 'mod');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'descriptor.mod'), 'name = synthetic');
    const result = await sweepTemporaryDirectories(parent, {
      now: Date.now() + 10 * TEMPORARY_STALE_MS,
      maxBytes: 0,
      protectedRoots: [workspace],
    });
    expect(result.removed).toBe(0);
    expect(await readFile(path.join(workspace, 'descriptor.mod'), 'utf8')).toBe('name = synthetic');
    expect(
      (
        await sweepTemporaryDirectories(parent, {
          now: Date.now() + 10 * TEMPORARY_STALE_MS,
          protectedRoots: [path.parse(parent).root],
        })
      ).removed,
    ).toBe(0);
  });

  it('does not sweep scratch owned by another local user', async () => {
    const { parent, scratch } = await fixture();
    const directory = await scratch('users1');
    const uid = (await lstat(directory)).uid;
    expect(
      (
        await sweepTemporaryDirectories(parent, {
          now: Date.now() + 10 * TEMPORARY_STALE_MS,
          maxBytes: 0,
          currentUid: uid + 1,
        })
      ).removed,
    ).toBe(0);
    expect(await readFile(path.join(directory, 'source.txt'))).toHaveLength(8);
  });

  it('never follows a scratch junction or deletes a directory whose ownership changed', async () => {
    const { parent, scratch, lease } = await fixture();
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    await symlink(
      outside,
      path.join(parent, 'hoi4-reference-source-link01'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const directory = await scratch('owned1');
    const lifetime = new TemporaryDirectoryLifetime();
    await lifetime.own(directory);
    await lease(directory, process.pid);
    await lifetime.dispose();
    await sweepTemporaryDirectories(parent, { now: Date.now() + 10 * TEMPORARY_STALE_MS });
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
    expect(await readdir(directory)).not.toEqual([]);
    await rm(path.join(parent, 'hoi4-reference-source-link01'));
  });
});

describe('automatic fixture teardown', () => {
  let previous: string;
  it('allocates an isolated reference fixture without manual cleanup', async () => {
    previous = await mkdtemp(path.join(tmpdir(), 'hoi4-reference-source-'));
    await writeFile(path.join(previous, 'reference.txt'), 'synthetic reference');
    expect(await readdir(previous)).toContain('.hoi4-temp-owner.json');
  });
  it('has removed the preceding test fixture', async () => {
    await expect(readdir(previous)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
