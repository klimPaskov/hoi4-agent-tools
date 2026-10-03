import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeFileGlob,
  globFiles,
  iterateFiles,
} from '../../src/hoi4_agent_tools/core/file-glob.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-glob-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'nested'), { recursive: true });
  await Promise.all(
    ['first.txt', 'second.gui', 'UPPER.MD', 'literal[a]{b,c}.txt', '.hidden.txt'].map((name) =>
      writeFile(path.join(mod, name), name),
    ),
  );
  await writeFile(path.join(mod, 'nested', 'child.txt'), 'child');
  return { root, mod };
}

describe('scoped streaming file globs', () => {
  it('supports brace patterns and deduplicates overlapping matches', async () => {
    const { mod } = await fixture();
    const files = await globFiles(['**/*.{txt,gui}', '**/*.txt'], { cwd: mod });
    expect(new Set(files).size).toBe(files.length);
    expect(files.sort()).toEqual([
      'first.txt',
      'literal[a]{b,c}.txt',
      'nested/child.txt',
      'second.gui',
    ]);
  });

  it('matches escaped literal brackets and braces without broadening selection', async () => {
    const { mod } = await fixture();
    expect(await globFiles([escapeFileGlob('literal[a]{b,c}.txt')], { cwd: mod })).toEqual([
      'literal[a]{b,c}.txt',
    ]);
  });

  it('admits large bounded exact-path sets without permitting excess wildcard fan-out', async () => {
    const { mod } = await fixture();
    expect(
      await globFiles(
        Array.from({ length: 1024 }, () => 'first.txt'),
        { cwd: mod },
      ),
    ).toEqual(['first.txt']);
    await expect(
      globFiles(
        Array.from({ length: 513 }, () => '**/*.txt'),
        { cwd: mod },
      ),
    ).rejects.toMatchObject({ code: 'SCAN_PATTERN_LIMIT' });
    await expect(
      globFiles(
        Array.from({ length: 8193 }, () => 'first.txt'),
        { cwd: mod },
      ),
    ).rejects.toMatchObject({ code: 'SCAN_PATTERN_LIMIT' });
  });

  it('applies ignore and authority case rules', async () => {
    const { mod } = await fixture();
    expect(await globFiles(['**/*.md'], { cwd: mod })).toEqual([]);
    expect(await globFiles(['**/*.md'], { cwd: mod, caseSensitive: false })).toEqual(['UPPER.MD']);
    const files = await globFiles(['**/*.txt'], { cwd: mod, ignore: ['nested/**'] });
    expect(files).not.toContain('nested/child.txt');
    expect(files).not.toContain('.hidden.txt');
    expect(await globFiles(['nested/child.txt'], { cwd: mod, ignore: ['nested/**'] })).toEqual([]);
  });

  it('does not traverse directory links during wildcard or explicit-prefix enumeration', async () => {
    const { root, mod } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(
      outside,
      path.join(mod, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await globFiles(['**/*.txt'], { cwd: mod })).some((name) => name.startsWith('linked/')),
    ).toBe(false);
    expect(await globFiles(['linked/**/*.txt'], { cwd: mod })).toEqual([]);
  });

  it('rejects escaping and excessive patterns before walking files', async () => {
    const { mod } = await fixture();
    for (const pattern of ['../*.txt', '/tmp/*.txt', 'C:/private/*.txt', '\\./\\.\\./*.txt'])
      await expect(globFiles([pattern], { cwd: mod })).rejects.toMatchObject({
        code: 'SCAN_PATTERN_ESCAPE',
      });
    await expect(
      globFiles(['{'.repeat(9) + 'x' + '}'.repeat(9)], { cwd: mod }),
    ).rejects.toMatchObject({ code: 'SCAN_PATTERN_LIMIT' });
    await expect(globFiles(['{a,b}'.repeat(8)], { cwd: mod })).rejects.toMatchObject({
      code: 'SCAN_PATTERN_LIMIT',
    });
    await expect(globFiles(['{1..100000000}.txt'], { cwd: mod })).rejects.toMatchObject({
      code: 'SCAN_PATTERN_LIMIT',
    });
    await expect(
      globFiles(['**/*.txt'], { cwd: mod, ignore: ['{1..100000000}.txt'] }),
    ).rejects.toMatchObject({ code: 'SCAN_PATTERN_LIMIT' });
  });

  it('honors an aborted iterator without returning matches', async () => {
    const { mod } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const iterator = iterateFiles(['**/*.txt'], { cwd: mod, signal: controller.signal });
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
