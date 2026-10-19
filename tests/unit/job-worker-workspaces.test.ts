import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { workerWorkspaces } from '../../src/hoi4_agent_tools/core/job-worker-host.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function discoveredMods() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-workspaces-'));
  roots.push(root);
  const modRoot = path.join(root, 'mod');
  for (const name of ['kept_mod', 'removed_mod']) {
    await mkdir(path.join(modRoot, name, 'events'), { recursive: true });
    await writeFile(path.join(modRoot, name, 'descriptor.mod'), `name="${name}"\n`, 'utf8');
  }
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    modRoots: [modRoot],
  });
  const resolver = await WorkspaceResolver.create(configuration);
  const workspace = (name: string) =>
    resolver.list().find(({ modRoot: candidate }) => path.basename(candidate) === name)!;
  return { resolver, configuration, modRoot, workspace };
}

describe('job worker workspace hand-off', () => {
  it('omits a discovered mod removed after discovery so other jobs still resolve', async () => {
    const { resolver, configuration, modRoot, workspace } = await discoveredMods();
    const kept = workspace('kept_mod');
    expect(workspace('removed_mod')).toBeDefined();
    await rm(path.join(modRoot, 'removed_mod'), { recursive: true, force: true });

    const handed = await workerWorkspaces(resolver.list(), kept.id);

    expect(handed.map(({ id }) => id)).toEqual([kept.id]);
    const worker = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        ...configuration,
        modRoots: [],
        workspaces: handed.map(({ registration }) => registration),
      }),
    );
    expect(worker.list().map(({ id }) => id)).toEqual([kept.id]);
  });

  it('keeps the requested workspace even when its root is gone so the job fails explicitly', async () => {
    const { resolver, configuration, modRoot, workspace } = await discoveredMods();
    const removed = workspace('removed_mod');
    await rm(path.join(modRoot, 'removed_mod'), { recursive: true, force: true });

    const handed = await workerWorkspaces(resolver.list(), removed.id);

    expect(handed.map(({ id }) => id)).toContain(removed.id);
    await expect(
      WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          ...configuration,
          modRoots: [],
          workspaces: handed.map(({ registration }) => registration),
        }),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ROOT_MISSING' });
  });
});
