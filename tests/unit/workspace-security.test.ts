import { lstat, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  serverConfigurationSchema,
  workspaceRegistrationSchema,
} from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import { canonicalPath, WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-workspace-'));
  const mod = path.join(base, 'mod');
  const game = path.join(base, 'game');
  const outside = path.join(base, 'outside');
  await Promise.all([mkdir(mod), mkdir(game), mkdir(outside)]);
  await writeFile(path.join(mod, 'inside.txt'), 'inside');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(base, 'server-state'),
    workspaces: [{ id: 'test', name: 'Test', root: mod, gameRoot: game }],
  });
  return { base, mod, game, outside, resolver: await WorkspaceResolver.create(config) };
}

describe('workspace path policy', () => {
  it('resolves relative paths in allowlisted roots', async () => {
    const { resolver, mod } = await fixture();
    await expect(resolver.resolvePath('test', 'inside.txt', 'read')).resolves.toMatchObject({
      path: await canonicalPath(path.join(mod, 'inside.txt')),
    });
  });

  it.each([
    '../outside/secret.txt',
    '..\\outside\\secret.txt',
    'file.txt:secret',
    'CON',
    'CONIN$',
    'CON.focus.txt',
    'COM¹.txt',
    'bad|name.txt',
    'folder/name. ',
  ])('rejects unsafe path %s', async (unsafe) => {
    const { resolver } = await fixture();
    await expect(resolver.resolvePath('test', unsafe, 'write', ['mod'])).rejects.toThrow();
  });

  it('reserves generated artifact, cache, and lock storage from source writes', async () => {
    const { resolver } = await fixture();
    for (const relativePath of [
      '.hoi4-agent/cache/locks/write.lock/evil.txt',
      './.hoi4-agent/cache/locks/write.lock/evil.txt',
      '.\\.hoi4-agent/cache/locks/write.lock/evil.txt',
      '.HOI4-AGENT/artifacts/evil.txt',
    ]) {
      await expect(
        resolver.resolvePath('test', relativePath, 'write', ['mod']),
      ).rejects.toMatchObject({ code: 'PATH_GENERATED_STORAGE_RESERVED' });
    }
  });

  it('rejects traversal and absolute configured source roots', () => {
    expect(() =>
      workspaceRegistrationSchema.parse({
        id: 'unsafe-roots',
        name: 'Unsafe roots',
        root: 'C:/workspace',
        roots: { focus: ['../outside'] },
      }),
    ).toThrow(/safe relative paths/iu);
    expect(() =>
      workspaceRegistrationSchema.parse({
        id: 'absolute-roots',
        name: 'Absolute roots',
        root: 'C:/workspace',
        roots: { gfx: ['C:/outside'] },
      }),
    ).toThrow(/safe relative paths/iu);
  });

  it('rejects an escaping symlink or junction', async () => {
    const { resolver, mod, outside } = await fixture();
    const link = path.join(mod, 'escape');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await expect(resolver.resolvePath('test', 'escape/secret.txt', 'read')).rejects.toThrow();
  });

  it('rejects default generated roots redirected outside the workspace', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-generated-root-'));
    const mod = path.join(base, 'mod');
    const outside = path.join(base, 'outside');
    await Promise.all([mkdir(mod), mkdir(outside)]);
    try {
      await symlink(
        outside,
        path.join(mod, '.hoi4-agent'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    const config = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    await expect(WorkspaceResolver.create(config)).rejects.toMatchObject({
      code: 'WORKSPACE_GENERATED_ROOT_ESCAPE',
    });
  });

  it('rejects server state that overlaps or aliases any workspace capability before writing a key', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-server-state-isolation-'));
    const mod = path.join(base, 'mod');
    const realState = path.join(base, 'real-state');
    const linkedState = path.join(base, 'linked-state');
    await Promise.all([mkdir(mod), mkdir(realState)]);
    const overlapping = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: mod,
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    await expect(WorkspaceResolver.create(overlapping)).rejects.toMatchObject({
      code: 'SERVER_STATE_ROOT_OVERLAP',
    });
    await expect(lstat(path.join(mod, 'journal-hmac.key'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    try {
      await symlink(realState, linkedState, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const aliased = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: linkedState,
    });
    await expect(WorkspaceResolver.create(aliased)).rejects.toMatchObject({
      code: expect.stringMatching(/^SERVER_STATE_/u),
    });
  });

  it('normalizes native server-state path spellings after rejecting linked components', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-server-state-native-path-'));
    const requestedRoot = path.join(base, 'server-state');
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: requestedRoot,
    });

    const resolver = await WorkspaceResolver.create(configuration);
    expect(resolver.serverState()?.root).toBe(await canonicalPath(requestedRoot));
  });

  it('keeps game and dependency roots read-only', async () => {
    const { resolver } = await fixture();
    await expect(resolver.resolvePath('test', 'new.txt', 'write', ['game'])).rejects.toThrow();
  });

  it('discovers immediate real mod directories with autonomous writes and global roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-mod-discovery-'));
    const modRoot = path.join(base, 'mods');
    const alpha = path.join(modRoot, 'Alpha Mod');
    const beta = path.join(modRoot, 'beta');
    const hidden = path.join(modRoot, '.hidden');
    const nested = path.join(alpha, 'nested-mod');
    const outside = path.join(base, 'outside');
    const explicit = path.join(base, 'explicit');
    const linked = path.join(modRoot, 'linked-outside');
    const game = path.join(base, 'game');
    const storage = path.join(base, 'workspace-storage');
    await Promise.all(
      [alpha, beta, hidden, nested, outside, explicit, game].map((root) =>
        mkdir(root, { recursive: true }),
      ),
    );
    try {
      await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Symlink creation can be unavailable on locked-down Windows runners.
    }
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      modRoots: [modRoot],
      gameRoot: game,
      workspaceStorageRoot: storage,
      workspaces: [{ id: 'explicit', name: 'Explicit', root: explicit }],
      http: {
        principals: [
          { principal: 'root-granted', workspaceIds: [], allowDiscoveredMods: true },
          { principal: 'not-granted', workspaceIds: [], allowDiscoveredMods: false },
        ],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const all = resolver.list();
    const discovered = all.filter(({ id }) => id.startsWith('mod_'));
    expect(all).toHaveLength(3);
    expect(discovered).toHaveLength(2);
    expect(discovered.map(({ name }) => name)).toEqual(['Alpha Mod', 'beta']);
    for (const workspace of discovered) {
      expect(workspace).toMatchObject({
        id: expect.stringMatching(/^mod_[a-z0-9_]+_[a-f0-9]{12}$/u),
        writeEnabled: true,
        gameRoot: await canonicalPath(game),
      });
      expect(workspace.artifactRoot).toBe(
        await canonicalPath(path.join(storage, workspace.id, 'artifacts')),
      );
      expect(workspace.cacheRoot).toBe(
        await canonicalPath(path.join(storage, workspace.id, 'cache')),
      );
    }
    expect(resolver.list('root-granted')).toEqual(discovered);
    expect(resolver.list('root-granted').some(({ id }) => id === 'explicit')).toBe(false);
    expect(resolver.list('not-granted')).toEqual([]);
    expect(discovered.some(({ modRoot }) => modRoot === path.resolve(nested))).toBe(false);
    expect(discovered.some(({ modRoot }) => modRoot === path.resolve(hidden))).toBe(false);
    expect(discovered.some(({ modRoot }) => modRoot === path.resolve(linked))).toBe(false);
  });

  it('rejects linked, overlapping, or storage-aliased automatic mod roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-mod-root-policy-'));
    const realRoot = path.join(base, 'real-mods');
    const nestedRoot = path.join(realRoot, 'nested');
    const linkedRoot = path.join(base, 'linked-mods');
    await mkdir(nestedRoot, { recursive: true });
    const baseConfiguration = {
      version: 1 as const,
      serverStateRoot: path.join(base, 'server-state'),
    };
    await expect(
      WorkspaceResolver.create(
        serverConfigurationSchema.parse({ ...baseConfiguration, modRoots: [realRoot, nestedRoot] }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MOD_ROOT_OVERLAP' });
    await expect(
      WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          ...baseConfiguration,
          modRoots: [realRoot],
          workspaceStorageRoot: path.join(realRoot, 'storage'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_STORAGE_ROOT_OVERLAP' });
    try {
      await symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await expect(
      WorkspaceResolver.create(
        serverConfigurationSchema.parse({ ...baseConfiguration, modRoots: [linkedRoot] }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MOD_ROOT_UNSAFE' });
  });

  it('lets an explicit advanced workspace override its discovered directory', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-mod-override-'));
    const modRoot = path.join(base, 'mods');
    const advanced = path.join(modRoot, 'advanced');
    const automatic = path.join(modRoot, 'automatic');
    const game = path.join(base, 'game');
    const storage = path.join(base, 'storage');
    await Promise.all([advanced, automatic, game].map((root) => mkdir(root, { recursive: true })));
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'server-state'),
        modRoots: [modRoot],
        gameRoot: game,
        workspaceStorageRoot: storage,
        workspaces: [
          {
            id: 'advanced_override',
            name: 'Advanced override',
            root: advanced,
            roots: { focus: ['custom/focus'] },
          },
        ],
      }),
    );
    expect(resolver.list()).toHaveLength(2);
    expect(resolver.get('advanced_override')).toMatchObject({
      modRoot: await canonicalPath(advanced),
      gameRoot: await canonicalPath(game),
      writeEnabled: true,
      registration: { roots: { focus: ['custom/focus'] } },
    });
    expect(resolver.get('advanced_override').artifactRoot).toBe(
      await canonicalPath(path.join(storage, 'advanced_override', 'artifacts')),
    );
  });

  it('keeps read-only game workspaces free of generated files', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-game-workspace-'));
    const game = path.join(base, 'game');
    const storage = path.join(base, 'storage');
    const artifacts = path.join(storage, 'artifacts');
    const cache = path.join(storage, 'cache');
    await mkdir(game, { recursive: true });
    const missingStorage = serverConfigurationSchema.parse({
      version: 1,
      workspaces: [{ id: 'game', name: 'Game', root: game, kind: 'game' }],
    });
    await expect(WorkspaceResolver.create(missingStorage)).rejects.toMatchObject({
      code: 'WORKSPACE_GENERATED_ROOT_REQUIRED',
    });

    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [storage],
      workspaces: [
        {
          id: 'game',
          name: 'Game',
          root: game,
          kind: 'game',
          artifactRoot: artifacts,
          cacheRoot: cache,
        },
      ],
    });
    const resolver = await WorkspaceResolver.create(configuration);
    expect(resolver.get('game')).toMatchObject({ writeEnabled: false });
    await expect(lstat(path.join(game, '.hoi4-agent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires explicit generated storage to stay inside configured storage roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-storage-capability-'));
    const mod = path.join(base, 'mod');
    const outside = path.join(base, 'outside');
    await Promise.all([mkdir(mod), mkdir(outside)]);
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        {
          id: 'mod',
          name: 'Mod',
          root: mod,
          artifactRoot: path.join(outside, 'artifacts'),
        },
      ],
    });
    await expect(WorkspaceResolver.create(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_GENERATED_ROOT_ESCAPE',
    });
  });

  it('rejects generated-storage aliases across explicit workspaces', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-generated-overlap-'));
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    const storage = path.join(base, 'storage');
    const sharedArtifacts = path.join(storage, 'shared-artifacts');
    await Promise.all([mkdir(first), mkdir(second), mkdir(storage)]);
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      storageRoots: [storage],
      workspaces: [
        {
          id: 'first',
          name: 'First',
          root: first,
          artifactRoot: sharedArtifacts,
          cacheRoot: path.join(storage, 'first-cache'),
        },
        {
          id: 'second',
          name: 'Second',
          root: second,
          artifactRoot: sharedArtifacts,
          cacheRoot: path.join(storage, 'second-cache'),
        },
      ],
    });
    await expect(WorkspaceResolver.create(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_GENERATED_ROOT_OVERLAP',
    });
  });

  it('rejects configured workspace aliases while permitting shared read-only roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-configured-overlap-'));
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    const sharedGame = path.join(base, 'shared-game');
    await Promise.all([first, second, sharedGame].map((root) => mkdir(root, { recursive: true })));

    const duplicateRoot = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        { id: 'first', name: 'First', root: first },
        { id: 'alias', name: 'Alias', root: first },
      ],
    });
    await expect(WorkspaceResolver.create(duplicateRoot)).rejects.toMatchObject({
      code: 'WORKSPACE_ROOT_OVERLAP',
    });

    const sourceTakeover = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        { id: 'first', name: 'First', root: first },
        { id: 'second', name: 'Second', root: second, gameRoot: first },
      ],
    });
    await expect(WorkspaceResolver.create(sourceTakeover)).rejects.toMatchObject({
      code: 'WORKSPACE_SOURCE_OVERLAP',
    });

    const sharedReadOnly = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        { id: 'first', name: 'First', root: first, gameRoot: sharedGame },
        { id: 'second', name: 'Second', root: second, gameRoot: sharedGame },
      ],
    });
    await expect(WorkspaceResolver.create(sharedReadOnly)).resolves.toBeInstanceOf(
      WorkspaceResolver,
    );
  });

  it('honors cancellation during a real workspace scan', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-cancel-scan-'));
    const mod = path.join(base, 'mod');
    const source = path.join(mod, 'common', 'scripted_effects');
    await mkdir(source, { recursive: true });
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(
          path.join(source, `${String(index).padStart(4, '0')}.txt`),
          `effect_${index} = { }\n`,
        ),
      ),
    );
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'cancel', name: 'Cancel', root: mod }],
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    await expect(
      new WorkspaceScanner().scan(resolver.get('cancel'), {
        patterns: ['common/**/*.txt'],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('streams directory enumeration and enforces actual server scan ceilings', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-scan-limits-'));
    const mod = path.join(base, 'mod');
    await mkdir(mod, { recursive: true });
    await Promise.all(
      ['one.txt', 'two.txt', 'three.txt'].map((name) => writeFile(path.join(mod, name), '123456')),
    );
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'bounded', name: 'Bounded', root: mod }],
    });
    const workspace = (await WorkspaceResolver.create(configuration)).get('bounded');
    await expect(
      new WorkspaceScanner(2, 1_000).scan(workspace, { patterns: ['**/*.txt'] }),
    ).rejects.toMatchObject({ code: 'SCAN_FILE_LIMIT' });
    await expect(
      new WorkspaceScanner(2, 1_000).scan(workspace, {
        patterns: ['**/*.txt'],
        maxFiles: 3,
      }),
    ).rejects.toMatchObject({ code: 'SCAN_LIMIT_EXCEEDS_POLICY' });
    await expect(
      new WorkspaceScanner(10, 5).scan(workspace, { patterns: ['one.txt'] }),
    ).rejects.toMatchObject({ code: 'SCAN_BYTE_LIMIT' });
  });

  it('can scope a scan to selected workspace root kinds', async () => {
    const { resolver, game } = await fixture();
    await writeFile(path.join(game, 'inside.txt'), 'game');
    const files = await new WorkspaceScanner().scan(resolver.get('test'), {
      patterns: ['inside.txt'],
      rootKinds: ['mod'],
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ rootKind: 'mod', relativePath: 'inside.txt' });
  });

  it('admits a vanilla-sized 5632 by 2048 24-bit province bitmap below the file ceiling', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-vanilla-bmp-scan-'));
    const mod = path.join(base, 'mod');
    const map = path.join(mod, 'map');
    await mkdir(map, { recursive: true });
    const width = 5_632;
    const height = 2_048;
    const rowStride = Math.ceil((width * 3) / 4) * 4;
    const bitmapBytes = 54 + rowStride * height;
    await writeFile(path.join(map, 'provinces.bmp'), Buffer.alloc(bitmapBytes));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'vanilla-bmp', name: 'Vanilla BMP', root: mod }],
    });
    const workspace = (await WorkspaceResolver.create(configuration)).get('vanilla-bmp');
    const files = await new WorkspaceScanner().scan(workspace, {
      patterns: ['map/provinces.bmp'],
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ size: bitmapBytes, relativePath: 'map/provinces.bmp' });
    expect(bitmapBytes).toBeLessThan(67_108_864);
  });

  it('uses configured relative source roots in the shared engine scan', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-custom-roots-'));
    const mod = path.join(base, 'mod');
    const customFocus = path.join(mod, 'sources', 'focuses');
    await mkdir(customFocus, { recursive: true });
    await writeFile(
      path.join(customFocus, 'custom.txt'),
      'focus_tree = { id = custom_root_tree focus = { id = custom_root_focus x = 0 y = 0 } }\n',
    );
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [
        {
          id: 'custom',
          name: 'Custom roots',
          root: mod,
          roots: { focus: ['sources/focuses'] },
        },
      ],
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const snapshot = await engine.scan('custom');
    expect(snapshot.files.map(({ relativePath }) => relativePath)).toContain(
      'sources/focuses/custom.txt',
    );
    expect(snapshot.index.find('focus_tree', 'custom_root_tree')).toBeDefined();
  });
});
