import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { processAlive, ServerRegistry } from '../../src/hoi4_agent_tools/core/server-registry.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  ServerRegistry.active = undefined;
  for (const pid of pids.splice(0)) if (processAlive(pid)) process.kill(pid, 'SIGKILL');
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function resolver() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-server-registry-'));
  roots.push(root);
  await mkdir(path.join(root, 'mod'));
  const state = path.join(root, 'state');
  return {
    servers: path.join(state, 'servers'),
    resolver: await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: state,
        stdioIdleExitMinutes: 30,
        workspaces: [{ id: 'm', name: 'M', root: path.join(root, 'mod') }],
      }),
    ),
  };
}

const record = (pid: number) =>
  `${JSON.stringify({
    pid,
    version: '0.0.0',
    transport: 'stdio',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rssBytes: 1024,
    heapUsedBytes: 512,
  })}\n`;

describe('server registry', () => {
  it('lists live servers sharing the state root and removes records of exited processes', async () => {
    const { resolver: shared, servers } = await resolver();
    const registry = new ServerRegistry(shared, 'stdio', () => Date.parse('2026-10-06T00:00:00Z'));
    registry.start();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await readdir(servers).catch(() => [])).includes(`${process.pid}.json`)) break;
      await delay(50);
    }
    expect(await readdir(servers)).toContain(`${process.pid}.json`);

    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    pids.push(live.pid!);
    const exited = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => exited.once('exit', resolve));
    await writeFile(path.join(servers, `${live.pid}.json`), record(live.pid!));
    await writeFile(path.join(servers, `${exited.pid}.json`), record(exited.pid!));

    const status = await registry.status();
    expect(status.current).toMatchObject({
      pid: process.pid,
      transport: 'stdio',
      lastActivityAt: '2026-10-06T00:00:00.000Z',
    });
    expect(status.servers.map(({ pid }) => pid).sort()).toEqual([process.pid, live.pid!].sort());
    expect(status.removed).toBe(1);
    expect(status.limits).toMatchObject({ stdioIdleExitMinutes: 30, maxSharedTools: 4 });
    expect(await readdir(servers)).not.toContain(`${exited.pid}.json`);
  });
});
