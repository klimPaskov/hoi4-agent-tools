import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';

const tracking = vi.hoisted(() => ({ readFiles: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = String(args[0]);
      const handle = await actual.open(...args);
      if (!file.endsWith('.txt')) return handle;
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-installed-reuse-'));
  roots.push(root);
  const modRoot = path.join(root, 'mod');
  const gameRoot = path.join(root, 'game');
  await mkdir(path.join(modRoot, 'common', 'ideas'), { recursive: true });
  await mkdir(path.join(gameRoot, 'common', 'ideas'), { recursive: true });
  await writeFile(path.join(gameRoot, 'hoi4.exe'), 'game marker\n', 'utf8');
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
  return { resolver, gameFile, modFile };
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
