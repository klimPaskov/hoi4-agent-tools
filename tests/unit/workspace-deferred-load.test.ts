import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function modRoot(): Promise<{ root: string; modRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-resolver-deferred-'));
  roots.push(root);
  const mods = path.join(root, 'mods');
  for (const name of ['alpha', 'beta']) {
    await mkdir(path.join(mods, name, 'common'), { recursive: true });
    await writeFile(path.join(mods, name, 'descriptor.mod'), `name="${name}"\n`);
  }
  return { root, modRoot: mods };
}

describe('WorkspaceResolver prepare and populate', () => {
  it('answers configuration and server state at once, and loads the workspaces on populate', async () => {
    const { root, modRoot: mods } = await modRoot();
    const resolver = await WorkspaceResolver.prepare(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        modRoots: [mods],
      }),
    );
    expect(resolver.serverState()).toBeDefined();
    expect(resolver.config().modRoots).toEqual([mods]);
    // No workspace lookup answers before the workspaces are loaded.
    expect(() => resolver.list()).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_STARTUP_PENDING' }) as Error,
    );
    expect(() => resolver.get('alpha')).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_STARTUP_PENDING' }) as Error,
    );
    const first = resolver.populate();
    // A second call joins the first.
    expect(resolver.populate()).toBe(first);
    await first;
    expect(resolver.list().map(({ name }) => name)).toEqual(['alpha', 'beta']);
    expect(resolver.startupError()).toBeUndefined();
  });

  it('create is prepare followed by populate', async () => {
    const { root, modRoot: mods } = await modRoot();
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      modRoots: [mods],
    });
    const resolver = await WorkspaceResolver.create(configuration);
    expect(resolver.list()).toHaveLength(2);
  });

  it('rejects populate with the workspace error and fails every lookup with it', async () => {
    const { root, modRoot: mods } = await modRoot();
    const resolver = await WorkspaceResolver.prepare(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        modRoots: [mods],
        defaultWorkspace: 'no_such_mod',
      }),
    );
    await expect(resolver.populate()).rejects.toMatchObject({ code: 'WORKSPACE_DEFAULT_UNKNOWN' });
    await expect(resolver.populate()).rejects.toMatchObject({ code: 'WORKSPACE_DEFAULT_UNKNOWN' });
    expect(resolver.startupError()).toMatchObject({ code: 'WORKSPACE_DEFAULT_UNKNOWN' });
    for (const lookup of [
      () => resolver.list(),
      () => resolver.get('alpha'),
      () => resolver.resolveWorkspaceId('alpha'),
      () => resolver.resolveCurrentWorkspaceId(),
    ])
      expect(lookup).toThrowError(
        expect.objectContaining({ code: 'WORKSPACE_DEFAULT_UNKNOWN' }) as Error,
      );
    await expect(resolver.resolveClientWorkspaceId([])).rejects.toMatchObject({
      code: 'WORKSPACE_DEFAULT_UNKNOWN',
    });
  });

  it('fails every lookup with an error set by the caller before the workspaces load', async () => {
    const { root, modRoot: mods } = await modRoot();
    const resolver = await WorkspaceResolver.prepare(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        modRoots: [mods],
      }),
    );
    resolver.failStartup(new ServiceError('CONFIG_INVALID', 'Configuration failed'));
    // The first error stays.
    resolver.failStartup(new ServiceError('OTHER', 'later'));
    await expect(resolver.populate()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(() => resolver.list()).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error,
    );
  });

  it('refuses unsafe mod roots in prepare, with the same code create gave', async () => {
    const { root } = await modRoot();
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      modRoots: [path.join(root, 'missing')],
    });
    await expect(WorkspaceResolver.prepare(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_MOD_ROOT_UNSAFE',
    });
    await expect(WorkspaceResolver.create(configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_MOD_ROOT_UNSAFE',
    });
  });
});
