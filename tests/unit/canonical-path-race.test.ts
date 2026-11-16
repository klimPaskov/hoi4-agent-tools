import { mkdir, mkdtemp, rm, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';

// The workspace lock directory can be released by another rewrite between canonicalPath's
// existence check and its realpath call. Simulate that window: the first realpath of a marked
// path removes the directory and fails with ENOENT, as the real race does.
const vanishing = new Set<string>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    realpath: async (target: string) => {
      const key = path.resolve(target);
      if (vanishing.delete(key)) {
        await actual.rmdir(key);
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${key}'`), {
          code: 'ENOENT',
        });
      }
      return actual.realpath(target);
    },
  };
});

const { canonicalPath } = await import('../../src/hoi4_agent_tools/core/workspace.js');

const roots: string[] = [];
afterEach(async () => {
  vanishing.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('canonicalPath when the path vanishes during the walk', () => {
  it('resolves a lock directory released between the check and realpath through its parent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-canonical-race-'));
    roots.push(root);
    const locks = path.join(root, 'locks');
    const lock = path.join(locks, 'write.lock');
    await mkdir(lock, { recursive: true });
    vanishing.add(path.resolve(lock));
    const resolved = await canonicalPath(lock);
    expect(path.basename(resolved)).toBe('write.lock');
    expect(path.dirname(resolved)).toBe(await canonicalPath(locks));
  });

  it('still throws for a link whose target never exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hoi4-canonical-race-'));
    roots.push(root);
    const target = path.join(root, 'gone');
    await mkdir(target);
    const link = path.join(root, 'dangling');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await rmdir(target);
    await expect(canonicalPath(link)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
