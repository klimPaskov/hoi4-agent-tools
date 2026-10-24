import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import type { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { resolveOperationWorkspaceForSource } from '../../src/hoi4_agent_tools/core/operation-context.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const FOCUS = 'common/national_focus/only_here.txt';

/** Two discovered mods and a folder outside both, like a session started in a tool repository. */
async function mods(options: Record<string, unknown> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-workspace-context-'));
  const modRoot = path.join(base, 'mods');
  const outside = path.join(base, 'tool-repository');
  await Promise.all(
    [path.join(modRoot, 'alpha', 'common'), path.join(modRoot, 'beta', 'common'), outside].map(
      (folder) => mkdir(folder, { recursive: true }),
    ),
  );
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(base, 'server-state'),
    modRoots: [modRoot],
    ...options,
  });
  return { base, modRoot, outside, configuration };
}

function engineFor(resolver: WorkspaceResolver): CoreEngine {
  return { resolver } as unknown as CoreEngine;
}

describe('implicit workspace resolution outside every mod', () => {
  it('names the candidate workspaces and the fixes when client roots match no mod', async () => {
    const { outside, configuration } = await mods();
    const resolver = await WorkspaceResolver.create(configuration);
    const ids = resolver.list().map(({ id }) => id);

    const failure = await resolver.resolveClientWorkspaceId([outside]).catch((error) => error);
    expect(failure).toMatchObject({
      code: 'WORKSPACE_CONTEXT_NOT_FOUND',
      details: { workspaceIds: ids, workspaceNames: ['alpha', 'beta'], workspaceCount: 2 },
    });
    expect(failure.message).toContain('Pass workspaceId');
    expect(failure.message).toContain('defaultWorkspace');
    expect(JSON.stringify(failure.details)).not.toContain(outside);
  });

  it('uses the configured default workspace for client roots and the working directory', async () => {
    const { outside, configuration } = await mods({ defaultWorkspace: 'beta' });
    const resolver = await WorkspaceResolver.create(configuration);
    const beta = resolver.get('beta').id;

    await expect(resolver.resolveClientWorkspaceId([outside])).resolves.toBe(beta);
    // The test runner's working directory lies in no fixture mod.
    expect(resolver.resolveCurrentWorkspaceId()).toBe(beta);
  });

  it('keeps the roots match ahead of the default', async () => {
    const { modRoot, configuration } = await mods({ defaultWorkspace: 'beta' });
    const resolver = await WorkspaceResolver.create(configuration);

    await expect(
      resolver.resolveClientWorkspaceId([path.join(modRoot, 'alpha', 'common')]),
    ).resolves.toBe(resolver.get('alpha').id);
  });

  it('uses the only mod when client roots match none', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-workspace-single-'));
    const modRoot = path.join(base, 'mods');
    await mkdir(path.join(modRoot, 'solo'), { recursive: true });
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'server-state'),
        modRoots: [modRoot],
      }),
    );

    await expect(resolver.resolveClientWorkspaceId([base])).resolves.toBe(resolver.get('solo').id);
  });

  it('refuses an unknown, ambiguous or reserved default workspace', async () => {
    const unknown = await mods({ defaultWorkspace: 'gamma' });
    await expect(WorkspaceResolver.create(unknown.configuration)).rejects.toMatchObject({
      code: 'WORKSPACE_DEFAULT_UNKNOWN',
    });

    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-workspace-default-twice-'));
    await Promise.all([
      mkdir(path.join(base, 'first', 'shared'), { recursive: true }),
      mkdir(path.join(base, 'second', 'shared'), { recursive: true }),
    ]);
    await expect(
      WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(base, 'server-state'),
          modRoots: [path.join(base, 'first'), path.join(base, 'second')],
          defaultWorkspace: 'shared',
        }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_AMBIGUOUS' });

    expect(
      serverConfigurationSchema.safeParse({ version: 1, defaultWorkspace: 'current' }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({ version: 1, defaultWorkspace: '../alpha' }).success,
    ).toBe(false);
  });

  it('never gives a principal a default workspace outside its grants', async () => {
    const { outside, configuration } = await mods({
      defaultWorkspace: 'beta',
      http: {
        principals: [
          { principal: 'granted', workspaceIds: [], allowDiscoveredMods: true },
          { principal: 'none', workspaceIds: [], allowDiscoveredMods: false },
        ],
      },
    });
    const resolver = await WorkspaceResolver.create(configuration);

    await expect(resolver.resolveClientWorkspaceId([outside], 'granted')).resolves.toBe(
      resolver.get('beta').id,
    );
    await expect(resolver.resolveClientWorkspaceId([outside], 'none')).rejects.toMatchObject({
      code: 'WORKSPACE_CONTEXT_NOT_FOUND',
      details: { workspaceIds: [], workspaceCount: 0 },
    });
  });
});

describe('source-path recovery outside every mod', () => {
  async function sourceFixture(copies: readonly string[]) {
    const fixture = await mods();
    for (const mod of copies) {
      const file = path.join(fixture.modRoot, mod, FOCUS);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'focus_tree = {}\n');
    }
    const resolver = await WorkspaceResolver.create(fixture.configuration);
    const context = {
      resolveCurrentWorkspaceId: async () => resolver.resolveClientWorkspaceId([fixture.outside]),
    };
    return { resolver, context };
  }

  it('selects the one mod that has the requested source', async () => {
    const { resolver, context } = await sourceFixture(['beta']);

    await expect(
      resolveOperationWorkspaceForSource(engineFor(resolver), context, 'current', FOCUS),
    ).resolves.toBe(resolver.get('beta').id);
  });

  it('stays ambiguous when several mods have the source', async () => {
    const { resolver, context } = await sourceFixture(['alpha', 'beta']);

    await expect(
      resolveOperationWorkspaceForSource(engineFor(resolver), context, 'current', FOCUS),
    ).rejects.toMatchObject({ code: 'WORKSPACE_SOURCE_AMBIGUOUS' });
  });

  it('keeps the actionable error when no mod has the source or no source is named', async () => {
    const { resolver, context } = await sourceFixture([]);

    await expect(
      resolveOperationWorkspaceForSource(engineFor(resolver), context, 'current', FOCUS),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_NOT_FOUND' });
    await expect(
      resolveOperationWorkspaceForSource(engineFor(resolver), context, 'current', undefined),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_NOT_FOUND' });
  });

  it('does not recover through a traversal path', async () => {
    const { resolver, context } = await sourceFixture(['beta']);

    await expect(
      resolveOperationWorkspaceForSource(
        engineFor(resolver),
        context,
        'current',
        `../beta/${FOCUS}`,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_NOT_FOUND' });
  });
});
