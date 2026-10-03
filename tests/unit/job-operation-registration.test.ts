import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { registerWorkerOperations } from '../../src/hoi4_agent_tools/core/job-operation-registration.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-worker-domain-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  await mkdir(mod);
  const engine = new CoreEngine(
    await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(root, 'state'),
        workspaces: [{ id: 'test', name: 'Worker domain fixture', root: mod }],
      }),
    ),
  );
  await engine.initialize();
  return engine;
}

describe('trusted worker domain admission', () => {
  it.each([
    ['hoi4.event_inspect', false],
    ['hoi4.focus_rewrite', true],
    ['hoi4.gui_rewrite', true],
    ['hoi4.map_rewrite', true],
    ['hoi4.probability_evaluate', false],
    ['hoi4.tech_render', false],
    ['hoi4.scenario_test', false],
  ] as const)('retains the recorded write policy for %s', async (toolName, mutation) => {
    const operations = await registerWorkerOperations(await fixture(), toolName);
    expect(operations.get(toolName).mutation).toBe(mutation);
    expect(() =>
      operations.get(toolName.startsWith('hoi4.event_') ? 'hoi4.map_render' : 'hoi4.event_inspect'),
    ).toThrow('No typed core operation');
  });

  it('refuses unknown suffixes and executable or module selectors', async () => {
    const engine = await fixture();
    for (const name of [
      'hoi4.event_arbitrary',
      '../event/job-operations.js',
      'node.exe',
      'hoi4.script_validate',
    ])
      await expect(registerWorkerOperations(engine, name)).rejects.toMatchObject({
        code: 'JOB_OPERATION_UNAVAILABLE',
      });
  });
});
