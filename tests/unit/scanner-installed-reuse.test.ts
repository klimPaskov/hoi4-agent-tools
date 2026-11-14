import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';

const tracking = vi.hoisted(() => ({ readFiles: [] as string[], openedFiles: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = String(args[0]);
      const handle = await actual.open(...args);
      if (!file.endsWith('.txt')) return handle;
      tracking.openedFiles.push(path.basename(file));
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read')
            return (...readArguments: Parameters<typeof target.read>) => {
              tracking.readFiles.push(path.basename(file));
              return target.read(...readArguments);
            };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  tracking.readFiles.length = 0;
  tracking.openedFiles.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { gameVersion?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-installed-reuse-'));
  roots.push(root);
  const modRoot = path.join(root, 'mod');
  const gameRoot = path.join(root, 'game');
  await mkdir(path.join(modRoot, 'common', 'ideas'), { recursive: true });
  await mkdir(path.join(gameRoot, 'common', 'ideas'), { recursive: true });
  await writeFile(path.join(gameRoot, 'hoi4.exe'), 'game marker\n', 'utf8');
  if (options.gameVersion === true)
    await writeFile(path.join(gameRoot, 'hoi4_rev.txt'), 'aaaaaaaa', 'utf8');
  const gameFile = path.join(gameRoot, 'common', 'ideas', 'game_ideas.txt');
  const modFile = path.join(modRoot, 'common', 'ideas', 'mod_ideas.txt');
  await writeFile(gameFile, 'ideas = { game_idea_aaaa = { } }\n', 'utf8');
  await writeFile(modFile, 'ideas = { mod_idea_aaaaa = { } }\n', 'utf8');
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'reuse', name: 'Reuse', root: modRoot, gameRoot }],
    }),
  );
  return { resolver, gameFile, modFile, gameRoot };
}

const scan = (scanner: WorkspaceScanner, resolver: WorkspaceResolver) =>
  scanner.scan(resolver.get('reuse'), { patterns: ['common/ideas/*.txt'] });

describe('scanning the installed game again', () => {
  it('reads a mod file every time but an unchanged game file once', async () => {
    const { resolver } = await fixture();
    const scanner = new WorkspaceScanner();
    const first = await scan(scanner, resolver);
    expect([...new Set(tracking.readFiles)].sort()).toEqual(['game_ideas.txt', 'mod_ideas.txt']);

    tracking.readFiles.length = 0;
    const second = await scan(scanner, resolver);
    expect([...new Set(tracking.readFiles)]).toEqual(['mod_ideas.txt']);
    expect(second.map(({ sha256 }) => sha256)).toEqual(first.map(({ sha256 }) => sha256));
    expect(second.map(({ bytes }) => bytes.toString('utf8'))).toEqual(
      first.map(({ bytes }) => bytes.toString('utf8')),
    );
  });

  it('does not trust a retained game file that a caller wrote into', async () => {
    const { resolver } = await fixture();
    const scanner = new WorkspaceScanner();
    const first = await scan(scanner, resolver);
    const game = first.find(({ relativePath }) => relativePath.endsWith('game_ideas.txt'))!;
    const original = game.bytes.toString('utf8');
    game.bytes.fill(0);
    tracking.readFiles.length = 0;

    const second = await scan(scanner, resolver);
    expect(tracking.readFiles).toContain('game_ideas.txt');
    expect(
      second
        .find(({ relativePath }) => relativePath.endsWith('game_ideas.txt'))!
        .bytes.toString('utf8'),
    ).toBe(original);
  });

  it('reads a game file again after a write that keeps its size and nearly its mtime', async () => {
    const { resolver, gameFile } = await fixture();
    const scanner = new WorkspaceScanner();
    const first = await scan(scanner, resolver);
    const before = await stat(gameFile);
    tracking.readFiles.length = 0;

    await writeFile(gameFile, 'ideas = { game_idea_bbbb = { } }\n', 'utf8');
    await utimes(gameFile, before.atimeMs / 1000, before.mtimeMs / 1000);
    const after = await stat(gameFile);
    expect(after.size).toBe(before.size);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(2);

    const second = await scan(scanner, resolver);
    expect(tracking.readFiles).toContain('game_ideas.txt');
    const changed = second.find(({ relativePath }) => relativePath.endsWith('game_ideas.txt'))!;
    const original = first.find(({ relativePath }) => relativePath.endsWith('game_ideas.txt'))!;
    expect(changed.bytes.toString('utf8')).toContain('game_idea_bbbb');
    expect(changed.sha256).not.toBe(original.sha256);
  });
});

describe('scanning an installed game that names its version', () => {
  it('takes the inventory of an unchanged game without opening its files again', async () => {
    const { resolver } = await fixture({ gameVersion: true });
    const scanner = new WorkspaceScanner();
    const first = await scan(scanner, resolver);
    expect([...new Set(tracking.openedFiles)].sort()).toEqual(['game_ideas.txt', 'mod_ideas.txt']);

    tracking.openedFiles.length = 0;
    const second = await scan(scanner, resolver);
    // Only the mod is walked. The game's files are not opened, read or hashed.
    expect([...new Set(tracking.openedFiles)]).toEqual(['mod_ideas.txt']);
    expect(second.map(({ sha256 }) => sha256)).toEqual(first.map(({ sha256 }) => sha256));
    expect(second.map(({ relativePath }) => relativePath)).toEqual(
      first.map(({ relativePath }) => relativePath),
    );
    // A later scan is its own result: shadowing is worked out again, not carried over.
    expect(second.every(({ shadowedBy }) => shadowedBy === undefined)).toBe(true);
  });

  it('walks the game again when its version file changes or the shortcut is switched off', async () => {
    const { resolver, gameRoot, gameFile } = await fixture({ gameVersion: true });
    const scanner = new WorkspaceScanner();
    await scan(scanner, resolver);

    await writeFile(gameFile, 'ideas = { game_idea_bbbb = { } }\n', 'utf8');
    await writeFile(path.join(gameRoot, 'hoi4_rev.txt'), 'bbbbbbbbbbbb', 'utf8');
    tracking.openedFiles.length = 0;
    const patched = await scan(scanner, resolver);
    expect(tracking.openedFiles).toContain('game_ideas.txt');
    expect(
      patched.find(({ relativePath }) => relativePath.endsWith('game_ideas.txt'))!.bytes.toString(),
    ).toContain('game_idea_bbbb');

    tracking.openedFiles.length = 0;
    vi.stubEnv('HOI4_AGENT_FULL_GAME_SCAN', '1');
    try {
      await scan(scanner, resolver);
      expect(tracking.openedFiles).toContain('game_ideas.txt');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('always walks a game folder that does not name its version', async () => {
    const { resolver } = await fixture();
    const scanner = new WorkspaceScanner();
    await scan(scanner, resolver);
    tracking.openedFiles.length = 0;
    await scan(scanner, resolver);
    expect(tracking.openedFiles).toContain('game_ideas.txt');
  });
});
