import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import {
  WorkspaceResolver,
  descriptorReplacePaths,
} from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const sprite = (name: string) => `spriteTypes = { spriteType = { name = "${name}" } }\n`;

/** A synthetic game with two DLC folders that both replace one interface file. */
async function fixture(
  options: { includeGameDlc?: boolean; descriptor?: string; kind?: 'mod' | 'game' } = {},
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-source-layers-')));
  roots.push(root);
  const game = path.join(root, 'game');
  const mod = path.join(root, 'mod');
  await write(path.join(game, 'hoi4.exe'), '');
  await write(path.join(game, 'interface', 'shared.gfx'), sprite('GFX_base_version'));
  await write(path.join(game, 'gfx', 'loadingscreens', 'load_1.dds'), 'base');
  await write(path.join(game, 'integrated_dlc', 'dlc020_later', 'dlc020.dlc'), 'name = "Later"\n');
  await write(
    path.join(game, 'integrated_dlc', 'dlc020_later', 'interface', 'shared.gfx'),
    sprite('GFX_later_version'),
  );
  await write(path.join(game, 'dlc', 'dlc018_earlier', 'dlc018.dlc'), 'name = "Earlier"\n');
  await write(
    path.join(game, 'dlc', 'dlc018_earlier', 'interface', 'shared.gfx'),
    sprite('GFX_earlier_version'),
  );
  await write(
    path.join(game, 'dlc', 'dlc018_earlier', 'interface', 'earlier_only.gfx'),
    sprite('GFX_earlier_only'),
  );
  await write(path.join(game, 'dlc', 'dlc018_earlier', 'gfx', 'loadingscreens', 'dlc.dds'), 'dlc');
  // Neither a folder without a descriptor nor a stray file is a DLC layer.
  await write(path.join(game, 'dlc', 'not_a_dlc', 'interface', 'ignored.gfx'), sprite('GFX_x'));
  await write(path.join(game, 'dlc', 'readme.txt'), 'not a folder');
  await write(path.join(mod, 'descriptor.mod'), options.descriptor ?? 'name = "Layers"\n');
  await write(path.join(mod, 'interface', 'mod.gfx'), sprite('GFX_mod_sprite'));
  const workspace =
    options.kind === 'game'
      ? {
          id: 'layers',
          name: 'Game layers',
          root: game,
          kind: 'game' as const,
          artifactRoot: path.join(root, 'storage', 'artifacts'),
          cacheRoot: path.join(root, 'storage', 'cache'),
          ...(options.includeGameDlc === undefined
            ? {}
            : { includeGameDlc: options.includeGameDlc }),
        }
      : {
          id: 'layers',
          name: 'Layers',
          root: mod,
          gameRoot: game,
          ...(options.includeGameDlc === undefined
            ? {}
            : { includeGameDlc: options.includeGameDlc }),
        };
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaceStorageRoot: path.join(root, 'storage'),
      workspaces: [workspace],
    }),
  );
  const engine = new CoreEngine(resolver);
  // The persistent analysis cache initializes in server state; finish before cleanup.
  await engine.persistentAnalysisCache;
  return { root, game, mod, resolver, engine };
}

const sourceLayers = (resolver: WorkspaceResolver) =>
  resolver
    .get('layers')
    .roots.filter(({ kind }) => !['artifact', 'cache'].includes(kind))
    .sort((left, right) => left.loadOrder - right.loadOrder)
    .map(({ kind, loadOrder, label, replacePaths }) => ({
      kind,
      loadOrder,
      ...(label === undefined ? {} : { label }),
      replacePaths,
    }));

describe('installed DLC source layers', () => {
  it('layers DLC folders by internal ID between the base game and the mod', async () => {
    const { resolver, engine } = await fixture();
    expect(sourceLayers(resolver)).toEqual([
      { kind: 'game', loadOrder: 0, replacePaths: [] },
      { kind: 'dlc', loadOrder: 1, label: 'dlc018_earlier', replacePaths: [] },
      { kind: 'dlc', loadOrder: 2, label: 'dlc020_later', replacePaths: [] },
      { kind: 'mod', loadOrder: 3, replacePaths: [] },
    ]);
    expect(resolver.get('layers').dlcLayers.map(({ id, folder }) => [id, folder])).toEqual([
      [18, 'dlc018_earlier'],
      [20, 'dlc020_later'],
    ]);
    const snapshot = await engine.scan('layers', { patterns: ['interface/**/*.gfx'] });
    const files = snapshot.files.map(({ displayPath, rootKind, shadowedBy }) => ({
      displayPath,
      rootKind,
      ...(shadowedBy === undefined ? {} : { shadowedBy }),
    }));
    // The highest DLC ID wins a same-named file, as the engine loads it last.
    expect(files).toEqual(
      expect.arrayContaining([
        {
          displayPath: 'game:interface/shared.gfx',
          rootKind: 'game',
          shadowedBy: expect.any(String),
        },
        {
          displayPath: 'dlc018_earlier:interface/shared.gfx',
          rootKind: 'dlc',
          shadowedBy: expect.any(String),
        },
        { displayPath: 'dlc020_later:interface/shared.gfx', rootKind: 'dlc' },
        { displayPath: 'dlc018_earlier:interface/earlier_only.gfx', rootKind: 'dlc' },
        { displayPath: 'mod:interface/mod.gfx', rootKind: 'mod' },
      ]),
    );
    expect(files.some(({ displayPath }) => displayPath.includes('ignored.gfx'))).toBe(false);
  });

  it('omits DLC folders when the workspace opts out', async () => {
    const { resolver, engine } = await fixture({ includeGameDlc: false });
    expect(sourceLayers(resolver).map(({ kind }) => kind)).toEqual(['game', 'mod']);
    const snapshot = await engine.scan('layers', { patterns: ['interface/**/*.gfx'] });
    expect(snapshot.files.every(({ rootKind }) => rootKind !== 'dlc')).toBe(true);
  });

  it('loads a game workspace before its own DLC folders', async () => {
    const { resolver } = await fixture({ kind: 'game' });
    expect(sourceLayers(resolver).map(({ kind, loadOrder }) => [kind, loadOrder])).toEqual([
      ['game', 1],
      ['dlc', 2],
      ['dlc', 3],
    ]);
  });

  it('never follows a DLC folder link outside the game root', async (context) => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-outside-dlc-')));
    roots.push(outside);
    await write(path.join(outside, 'dlc099.dlc'), 'name = "Outside"\n');
    await write(path.join(outside, 'interface', 'escape.gfx'), sprite('GFX_escape'));
    const { game, root } = await fixture();
    try {
      await symlink(
        outside,
        path.join(game, 'dlc', 'dlc099_link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      context.skip();
    }
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state-link'),
        workspaceStorageRoot: path.join(root, 'storage-link'),
        workspaces: [
          { id: 'layers', name: 'Layers', root: path.join(root, 'mod'), gameRoot: game },
        ],
      }),
    );
    expect(resolver.get('layers').dlcLayers.map(({ folder }) => folder)).toEqual([
      'dlc018_earlier',
      'dlc020_later',
    ]);
  });
});

describe('descriptor replace_path', () => {
  it('unloads earlier game and DLC files under each declared path', async () => {
    const { resolver, engine } = await fixture({
      descriptor: [
        'name = "Layers"',
        'replace_path = "gfx/loadingscreens" # vanilla loading screens are replaced',
        'replace_path = "../outside"',
        'replace_path = "C:/absolute"',
        'replace_path = "gfx/*"',
        'replace_path = gfx/loadingscreens/',
        'tags = { "Gameplay" }',
        '',
      ].join('\n'),
    });
    expect(sourceLayers(resolver).at(-1)).toEqual({
      kind: 'mod',
      loadOrder: 3,
      replacePaths: ['gfx/loadingscreens'],
    });
    const snapshot = await engine.scan('layers', { patterns: ['gfx/loadingscreens/*.dds'] });
    expect(snapshot.files.map(({ displayPath }) => displayPath)).toEqual([]);
  });

  it('reads nothing from a missing, oversized, or non-file descriptor', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-descriptor-')));
    roots.push(root);
    expect(await descriptorReplacePaths(root)).toEqual([]);
    await mkdir(path.join(root, 'descriptor.mod'));
    expect(await descriptorReplacePaths(root)).toEqual([]);
    const large = path.join(root, 'large');
    await write(
      path.join(large, 'descriptor.mod'),
      `replace_path = "gfx"\n${'#'.repeat(70 * 1024)}\n`,
    );
    expect(await descriptorReplacePaths(large)).toEqual([]);
  });
});
