import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  serverConfigurationSchema,
  workspaceRegistrationSchema,
} from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceScanner } from '../../src/hoi4_agent_tools/core/scanner.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

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
    writePolicy: 'transactions',
    serverStateRoot: path.join(base, 'server-state'),
    workspaces: [{ id: 'test', name: 'Test', root: mod, gameRoot: game, writeEnabled: true }],
  });
  return { base, mod, game, outside, resolver: await WorkspaceResolver.create(config) };
}

describe('workspace path policy', () => {
  it('resolves relative paths in allowlisted roots', async () => {
    const { resolver, mod } = await fixture();
    await expect(resolver.resolvePath('test', 'inside.txt', 'read')).resolves.toMatchObject({
      path: path.join(mod, 'inside.txt'),
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
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    });
    await expect(WorkspaceResolver.create(config)).rejects.toMatchObject({
      code: 'WORKSPACE_GENERATED_ROOT_ESCAPE',
    });
  });

  it('rejects server state that overlaps or aliases any workspace capability before writing a key', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-server-state-isolation-'));
    const mod = path.join(base, 'mod');
    const allowed = path.join(base, 'allowed');
    const realState = path.join(base, 'real-state');
    const linkedState = path.join(base, 'linked-state');
    await Promise.all([mkdir(mod), mkdir(allowed), mkdir(realState)]);
    const overlapping = serverConfigurationSchema.parse({
      version: 1,
      writePolicy: 'transactions',
      serverStateRoot: mod,
      workspaces: [{ id: 'test', name: 'Test', root: mod, writeEnabled: true }],
    });
    await expect(WorkspaceResolver.create(overlapping)).rejects.toMatchObject({
      code: 'SERVER_STATE_ROOT_OVERLAP',
    });
    await expect(lstat(path.join(mod, 'journal-hmac.key'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const capabilityOverlap = serverConfigurationSchema.parse({
      version: 1,
      writePolicy: 'transactions',
      serverStateRoot: path.join(allowed, 'state'),
      registrationRoots: [allowed],
    });
    await expect(WorkspaceResolver.create(capabilityOverlap)).rejects.toMatchObject({
      code: 'SERVER_STATE_ROOT_OVERLAP',
    });

    try {
      await symlink(realState, linkedState, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const aliased = serverConfigurationSchema.parse({
      version: 1,
      writePolicy: 'transactions',
      serverStateRoot: linkedState,
    });
    await expect(WorkspaceResolver.create(aliased)).rejects.toMatchObject({
      code: expect.stringMatching(/^SERVER_STATE_/u),
    });
  });

  it('keeps game and dependency roots read-only', async () => {
    const { resolver } = await fixture();
    await expect(resolver.resolvePath('test', 'new.txt', 'write', ['game'])).rejects.toThrow();
  });

  it('constrains every runtime source and generated root, not only the mod root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-registration-roots-'));
    const allowed = path.join(base, 'allowed');
    const mod = path.join(allowed, 'mod');
    const allowedGame = path.join(allowed, 'game');
    const outside = path.join(base, 'outside');
    const outsideGame = path.join(outside, 'game');
    await Promise.all([
      mkdir(mod, { recursive: true }),
      mkdir(allowedGame, { recursive: true }),
      mkdir(outsideGame, { recursive: true }),
    ]);
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      workspaces: [],
    });
    const resolver = await WorkspaceResolver.create(configuration);

    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'outside-source',
          name: 'Outside source',
          root: mod,
          gameRoot: outsideGame,
        }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_SOURCE_ROOT_FORBIDDEN' });
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'outside-cache',
          name: 'Outside cache',
          root: mod,
          gameRoot: allowedGame,
          cacheRoot: path.join(outside, 'cache'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN' });
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'source-artifacts',
          name: 'Source artifacts',
          root: mod,
          artifactRoot: path.join(mod, 'gfx', 'evidence'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_GENERATED_ROOT_FORBIDDEN' });
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'safe-runtime',
          name: 'Safe runtime registration',
          root: mod,
          gameRoot: allowedGame,
        }),
      ),
    ).resolves.toMatchObject({ id: 'safe-runtime', modRoot: mod, gameRoot: allowedGame });
  });

  it('does not let runtime callers relabel a read-only source root as a mod', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-runtime-capabilities-'));
    const allowed = path.join(base, 'allowed');
    const writable = path.join(allowed, 'mods');
    const game = path.join(allowed, 'game');
    const mod = path.join(writable, 'safe-mod');
    await Promise.all([game, mod].map((root) => mkdir(root, { recursive: true })));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      writePolicy: 'transactions',
      serverStateRoot: path.join(base, 'server-state'),
      registrationRoots: [allowed],
      writableRegistrationRoots: [writable],
      http: {
        principals: [{ principal: 'runtime-user', workspaceIds: [], allowRegistration: true }],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);

    for (const writeEnabled of [false, true]) {
      await expect(
        resolver.register(
          workspaceRegistrationSchema.parse({
            id: `relabelled-game-${writeEnabled}`,
            name: 'Relabelled game',
            root: game,
            kind: 'mod',
            writeEnabled,
          }),
          'runtime-user',
        ),
      ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN' });
    }
    await expect(lstat(path.join(game, '.hoi4-agent'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'safe-mod',
          name: 'Safe mod',
          root: mod,
          kind: 'mod',
          writeEnabled: false,
        }),
        'runtime-user',
      ),
    ).resolves.toMatchObject({ id: 'safe-mod', writeEnabled: false });
  });

  it('requires writable registration roots to remain inside read registration roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-writable-root-capability-'));
    const allowed = path.join(base, 'allowed');
    const outside = path.join(base, 'outside');
    await Promise.all([allowed, outside].map((root) => mkdir(root, { recursive: true })));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [outside],
    });
    await expect(WorkspaceResolver.create(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_WRITABLE_REGISTRATION_ROOT_FORBIDDEN',
    });
  });

  it('rejects writable registration roots whose canonical target escapes the read roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-writable-root-link-'));
    const allowed = path.join(base, 'allowed');
    const outside = path.join(base, 'outside');
    const link = path.join(allowed, 'linked-mods');
    await Promise.all([allowed, outside].map((root) => mkdir(root, { recursive: true })));
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [link],
    });
    await expect(WorkspaceResolver.create(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_WRITABLE_REGISTRATION_ROOT_FORBIDDEN',
    });
  });

  it('rejects lexically external runtime paths before canonical filesystem access', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-lexical-registration-'));
    const allowed = path.join(base, 'allowed');
    await mkdir(allowed, { recursive: true });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [{ principal: 'runtime-user', workspaceIds: [], allowRegistration: true }],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const unc = '\\\\untrusted.invalid\\share\\workspace';
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({ id: 'unc', name: 'UNC', root: unc }),
        'runtime-user',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_ROOT_FORBIDDEN' });
  });

  it('keeps read-only game workspaces free of generated files', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-game-workspace-'));
    const game = path.join(base, 'game');
    const artifacts = path.join(base, 'storage', 'artifacts');
    const cache = path.join(base, 'storage', 'cache');
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
      writePolicy: 'transactions',
      serverStateRoot: path.join(base, 'server-state'),
      storageRoots: [artifacts, cache],
      workspaces: [
        {
          id: 'game',
          name: 'Game',
          root: game,
          kind: 'game',
          artifactRoot: artifacts,
          cacheRoot: cache,
          writeEnabled: true,
        },
      ],
    });
    const resolver = await WorkspaceResolver.create(configuration);
    expect(resolver.get('game')).toMatchObject({ writeEnabled: false });
    expect(resolver.get('game').roots[0]).toMatchObject({ kind: 'game', writable: false });
    await expect(lstat(path.join(game, '.hoi4-agent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports runtime read-only sources with isolated operator-owned storage', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-runtime-game-'));
    const allowed = path.join(base, 'allowed');
    const game = path.join(allowed, 'game');
    const artifacts = path.join(base, 'storage', 'artifacts');
    const cache = path.join(base, 'storage', 'cache');
    await mkdir(game, { recursive: true });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      writePolicy: 'transactions',
      serverStateRoot: path.join(base, 'server-state'),
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      storageRoots: [artifacts, cache],
      http: {
        principals: [{ principal: 'runtime-user', workspaceIds: [], allowRegistration: true }],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'runtime-game',
          name: 'Runtime game',
          root: game,
          kind: 'game',
          artifactRoot: artifacts,
          cacheRoot: cache,
          writeEnabled: true,
        }),
        'runtime-user',
      ),
    ).resolves.toMatchObject({ writeEnabled: false, artifactRoot: artifacts, cacheRoot: cache });
    await expect(lstat(path.join(game, '.hoi4-agent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects artifact or cache aliases across otherwise isolated workspaces', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-storage-alias-'));
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    const sharedArtifacts = path.join(base, 'storage', 'shared-artifacts');
    const firstCache = path.join(base, 'storage', 'first-cache');
    const secondCache = path.join(base, 'storage', 'second-cache');
    await Promise.all([first, second].map((root) => mkdir(root, { recursive: true })));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      storageRoots: [sharedArtifacts, firstCache, secondCache],
      workspaces: [
        {
          id: 'first',
          name: 'First',
          root: first,
          artifactRoot: sharedArtifacts,
          cacheRoot: firstCache,
        },
        {
          id: 'second',
          name: 'Second',
          root: second,
          artifactRoot: sharedArtifacts,
          cacheRoot: secondCache,
        },
      ],
    });
    await expect(WorkspaceResolver.create(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_GENERATED_ROOT_OVERLAP',
    });
  });

  it('prevents runtime registration from claiming workspace-owned roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-registration-overlap-'));
    const allowed = path.join(base, 'allowed');
    const victim = path.join(allowed, 'victim');
    const attacker = path.join(allowed, 'attacker');
    const safe = path.join(allowed, 'safe');
    const sharedGame = path.join(allowed, 'shared-game');
    await Promise.all(
      [victim, attacker, safe, sharedGame].map((root) => mkdir(root, { recursive: true })),
    );
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      workspaces: [{ id: 'victim', name: 'Victim', root: victim, gameRoot: sharedGame }],
      http: {
        principals: [{ principal: 'runtime-user', workspaceIds: [], allowRegistration: true }],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);

    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({ id: 'takeover', name: 'Takeover', root: victim }),
        'runtime-user',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'read-takeover',
          name: 'Read takeover',
          root: attacker,
          gameRoot: victim,
        }),
        'runtime-user',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'shared-game-safe',
          name: 'Shared game safe',
          root: safe,
          gameRoot: sharedGame,
        }),
        'runtime-user',
      ),
    ).resolves.toMatchObject({ id: 'shared-game-safe', gameRoot: sharedGame });
  });

  it('rejects generated-root overlap before creating directories in another workspace', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-generated-preflight-'));
    const allowed = path.join(base, 'allowed');
    const victim = path.join(allowed, 'victim');
    const attacker = path.join(allowed, 'attacker');
    const victimArtifacts = path.join(victim, '.hoi4-agent', 'artifacts');
    const injected = path.join(victimArtifacts, 'untrusted-empty-directory');
    await Promise.all([victim, attacker].map((root) => mkdir(root, { recursive: true })));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      storageRoots: [victimArtifacts],
      workspaces: [{ id: 'victim', name: 'Victim', root: victim }],
      http: {
        principals: [{ principal: 'registrar', workspaceIds: [], allowRegistration: true }],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    await expect(
      resolver.register(
        workspaceRegistrationSchema.parse({
          id: 'attacker',
          name: 'Attacker',
          root: attacker,
          artifactRoot: injected,
        }),
        'registrar',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });
    await expect(lstat(injected)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(attacker, '.hoi4-agent'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes concurrent runtime registration ownership checks', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-registration-race-'));
    const allowed = path.join(base, 'allowed');
    const shared = path.join(allowed, 'shared');
    const first = path.join(allowed, 'first');
    const second = path.join(allowed, 'second');
    await Promise.all([shared, first, second].map((root) => mkdir(root, { recursive: true })));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [
          { principal: 'alice', workspaceIds: [], allowRegistration: true },
          { principal: 'bob', workspaceIds: [], allowRegistration: true },
        ],
      },
    });

    const rootResolver = await WorkspaceResolver.create(configuration);
    const rootRace = await Promise.allSettled([
      rootResolver.register(
        workspaceRegistrationSchema.parse({ id: 'alice-root', name: 'Alice', root: shared }),
        'alice',
      ),
      rootResolver.register(
        workspaceRegistrationSchema.parse({ id: 'bob-root', name: 'Bob', root: shared }),
        'bob',
      ),
    ]);
    expect(rootRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(rootRace.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(rootResolver.list()).toHaveLength(1);

    const idResolver = await WorkspaceResolver.create(configuration);
    const idRace = await Promise.allSettled([
      idResolver.register(
        workspaceRegistrationSchema.parse({ id: 'contested', name: 'Alice', root: first }),
        'alice',
      ),
      idResolver.register(
        workspaceRegistrationSchema.parse({ id: 'contested', name: 'Bob', root: second }),
        'bob',
      ),
    ]);
    expect(idRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(idRace.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const winner = idRace[0]!.status === 'fulfilled' ? 'alice' : 'bob';
    const loser = winner === 'alice' ? 'bob' : 'alice';
    expect(idResolver.get('contested', winner)).toMatchObject({ id: 'contested' });
    expect(() => idResolver.get('contested', loser)).toThrow(/unavailable/iu);
  });

  it('restores runtime ownership across restart without persisting principals or paths', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-registration-persistence-'));
    const allowed = path.join(base, 'allowed');
    const mod = path.join(allowed, 'mod');
    await mkdir(mod, { recursive: true });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [
          { principal: 'alice', workspaceIds: [], allowRegistration: true },
          { principal: 'bob', workspaceIds: [], allowRegistration: true },
        ],
      },
    });
    const registration = workspaceRegistrationSchema.parse({
      id: 'runtime',
      name: 'Runtime',
      root: mod,
    });
    const first = await WorkspaceResolver.create(configuration);
    const owned = await first.register(registration, 'alice');
    const claimPath = path.join(owned.artifactRoot, '.runtime-registration-owner.json');
    const claimText = await readFile(claimPath, 'utf8');
    expect(claimText).not.toContain('alice');
    expect(claimText).not.toContain(mod);
    expect(JSON.parse(claimText)).toEqual({
      version: 1,
      workspaceIdentity: owned.workspaceIdentity,
      ownerIdentity: owned.ownerIdentity,
      claimHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const sameOwnerRestart = await WorkspaceResolver.create(configuration);
    await expect(sameOwnerRestart.register(registration, 'alice')).resolves.toMatchObject({
      workspaceIdentity: owned.workspaceIdentity,
      ownerIdentity: owned.ownerIdentity,
    });
    const otherPrincipalRestart = await WorkspaceResolver.create(configuration);
    await expect(otherPrincipalRestart.register(registration, 'bob')).rejects.toMatchObject({
      code: 'WORKSPACE_REGISTRATION_CONFLICT',
    });
    const otherWorkspaceRestart = await WorkspaceResolver.create(configuration);
    await expect(
      otherWorkspaceRestart.register({ ...registration, id: 'other-runtime' }, 'alice'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });
  });

  it('cancels runtime registration after dispatch without publishing ownership', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-registration-cancellation-'));
    const allowed = path.join(base, 'allowed');
    const mod = path.join(allowed, 'mod');
    await mkdir(mod, { recursive: true });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [{ principal: 'alice', workspaceIds: [], allowRegistration: true }],
      },
    });
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
    const registration = workspaceRegistrationSchema.parse({
      id: 'cancelled',
      name: 'Cancelled',
      root: mod,
    });
    const controller = new AbortController();
    const pending = engine.register(registration, 'alice', controller.signal);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.resolver.list('alice')).toEqual([]);
    await expect(
      lstat(path.join(mod, '.hoi4-agent', 'artifacts', '.runtime-registration-owner.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(engine.register(registration, 'alice')).resolves.toMatchObject({
      id: 'cancelled',
    });
  });

  it('arbitrates cross-process-style claim races with an atomic no-replace claim', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-persistent-claim-race-'));
    const allowed = path.join(base, 'allowed');
    const mod = path.join(allowed, 'mod');
    await mkdir(mod, { recursive: true });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [
          { principal: 'alice', workspaceIds: [], allowRegistration: true },
          { principal: 'bob', workspaceIds: [], allowRegistration: true },
        ],
      },
    });
    const registration = workspaceRegistrationSchema.parse({
      id: 'runtime',
      name: 'Runtime',
      root: mod,
    });
    const [aliceResolver, bobResolver] = await Promise.all([
      WorkspaceResolver.create(configuration),
      WorkspaceResolver.create(configuration),
    ]);
    const outcomes = await Promise.allSettled([
      aliceResolver.register(registration, 'alice'),
      bobResolver.register(registration, 'bob'),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'WORKSPACE_REGISTRATION_CONFLICT' },
    });
  });

  it('fails closed on malformed or linked ownership claims', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-claim-integrity-'));
    const allowed = path.join(base, 'allowed');
    const malformedMod = path.join(allowed, 'malformed');
    const linkedMod = path.join(allowed, 'linked');
    const malformedArtifacts = path.join(malformedMod, '.hoi4-agent', 'artifacts');
    const linkedArtifacts = path.join(linkedMod, '.hoi4-agent', 'artifacts');
    await Promise.all([
      mkdir(malformedArtifacts, { recursive: true }),
      mkdir(linkedArtifacts, { recursive: true }),
    ]);
    await writeFile(path.join(malformedArtifacts, '.runtime-registration-owner.json'), '{}\n');
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [{ principal: 'alice', workspaceIds: [], allowRegistration: true }],
      },
    });
    await expect(
      (await WorkspaceResolver.create(configuration)).register(
        workspaceRegistrationSchema.parse({
          id: 'malformed',
          name: 'Malformed',
          root: malformedMod,
        }),
        'alice',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });

    const outsideClaim = path.join(base, 'outside-claim.json');
    await writeFile(outsideClaim, '{}\n');
    try {
      await symlink(
        outsideClaim,
        path.join(linkedArtifacts, '.runtime-registration-owner.json'),
        'file',
      );
    } catch {
      return;
    }
    await expect(
      (await WorkspaceResolver.create(configuration)).register(
        workspaceRegistrationSchema.parse({ id: 'linked', name: 'Linked', root: linkedMod }),
        'alice',
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });
  });

  it('canonicalizes generated-root aliases before enforcing a runtime claim', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-claim-alias-'));
    const allowed = path.join(base, 'allowed');
    const mod = path.join(allowed, 'mod');
    const storage = path.join(base, 'storage');
    const artifacts = path.join(storage, 'artifacts');
    const artifactAlias = path.join(storage, 'artifact-alias');
    const cache = path.join(storage, 'cache');
    await Promise.all([mkdir(mod, { recursive: true }), mkdir(artifacts, { recursive: true })]);
    try {
      await symlink(artifacts, artifactAlias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      storageRoots: [storage],
      http: {
        principals: [
          { principal: 'alice', workspaceIds: [], allowRegistration: true },
          { principal: 'bob', workspaceIds: [], allowRegistration: true },
        ],
      },
    });
    const registration = workspaceRegistrationSchema.parse({
      id: 'runtime',
      name: 'Runtime',
      root: mod,
      artifactRoot: artifacts,
      cacheRoot: cache,
    });
    await (await WorkspaceResolver.create(configuration)).register(registration, 'alice');
    const aliased = { ...registration, artifactRoot: artifactAlias };
    await expect(
      (await WorkspaceResolver.create(configuration)).register(aliased, 'alice'),
    ).resolves.toMatchObject({ artifactRoot: artifacts });
    await expect(
      (await WorkspaceResolver.create(configuration)).register(aliased, 'bob'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REGISTRATION_CONFLICT' });
  });

  it('does not reveal existing workspace IDs or roots through runtime registration errors', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-registration-oracle-'));
    const allowed = path.join(base, 'allowed');
    const victim = path.join(allowed, 'victim');
    const safe = path.join(allowed, 'safe');
    await Promise.all([victim, safe].map((root) => mkdir(root, { recursive: true })));
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      workspaces: [{ id: 'victim', name: 'Victim', root: victim }],
      http: {
        principals: [
          { principal: 'registrar', workspaceIds: [], allowRegistration: true },
          { principal: 'reader', workspaceIds: [], allowRegistration: false },
        ],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    const capture = async (
      id: string,
      root: string,
      principal: string,
    ): Promise<{ code?: string; message?: string }> => {
      try {
        await resolver.register(
          workspaceRegistrationSchema.parse({ id, name: 'Probe', root }),
          principal,
        );
        return {};
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    };
    expect(await capture('victim', safe, 'reader')).toEqual(
      await capture('unknown', safe, 'reader'),
    );
    expect(await capture('victim', safe, 'registrar')).toEqual(
      await capture('unknown', victim, 'registrar'),
    );
    expect(await capture('victim', safe, 'registrar')).toMatchObject({
      code: 'WORKSPACE_REGISTRATION_CONFLICT',
    });
  });

  it('binds runtime unregistration to the principal that registered the workspace', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-unregister-owner-'));
    const allowed = path.join(base, 'allowed');
    const runtime = path.join(allowed, 'runtime');
    await mkdir(runtime, { recursive: true });
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      registrationRoots: [allowed],
      writableRegistrationRoots: [allowed],
      http: {
        principals: [
          { principal: 'alice', workspaceIds: [], allowRegistration: true },
          { principal: 'bob', workspaceIds: [], allowRegistration: true },
        ],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);
    await resolver.register(
      workspaceRegistrationSchema.parse({ id: 'runtime', name: 'Runtime', root: runtime }),
      'alice',
    );
    expect(() => resolver.unregisterRuntime('runtime', 'bob')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_INACCESSIBLE' }),
    );
    expect(resolver.get('runtime', 'alice')).toMatchObject({ id: 'runtime' });
    resolver.unregisterRuntime('runtime', 'alice');
    expect(() => resolver.get('runtime', 'alice')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_INACCESSIBLE' }),
    );
  });

  it('rejects configured workspace aliases while permitting shared read-only roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-configured-overlap-'));
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    const sharedGame = path.join(base, 'shared-game');
    await Promise.all([first, second, sharedGame].map((root) => mkdir(root, { recursive: true })));

    const duplicateRoot = serverConfigurationSchema.parse({
      version: 1,
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
