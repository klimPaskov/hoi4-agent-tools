import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOMAIN_TOOL_NAMES } from '../../src/hoi4_agent_tools/core/domain-tools.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  registerWorkerOperations,
  workerDomain,
} from '../../src/hoi4_agent_tools/core/job-operation-registration.js';

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
    ['hoi4.event_write', true],
    ['hoi4.focus_rewrite', true],
    ['hoi4.gui_rewrite', true],
    ['hoi4.map_rewrite', true],
    ['hoi4.probability_analyze', false],
    ['hoi4.tech_render', false],
    ['hoi4.scenario_test', false],
  ] as const)('retains the recorded write policy for %s', async (toolName, mutation) => {
    const operations = await registerWorkerOperations(await fixture(), toolName);
    expect(operations.get(toolName).mutation).toBe(mutation);
    expect(() =>
      operations.get(
        toolName.startsWith('hoi4.event_') ? 'hoi4.map_inspect' : 'hoi4.event_inspect',
      ),
    ).toThrow('No typed core operation');
  });

  it('serves every tool of a warm-worker domain from the one registration that domain gets', async () => {
    // A warm worker registers a domain once, from the first tool it sees, and reuses it for the
    // rest of that domain, so every tool in the group must be among that registration's operations.
    const engine = await fixture();
    const domains = new Map<string, string[]>();
    for (const name of DOMAIN_TOOL_NAMES)
      domains.set(workerDomain(name), [...(domains.get(workerDomain(name)) ?? []), name]);
    for (const names of domains.values())
      for (const first of names) {
        const operations = await registerWorkerOperations(engine, first);
        for (const name of names)
          expect(() => operations.get(name), `${first} then ${name}`).not.toThrow();
      }
  });

  it('keeps the event writer in its own domain, apart from the event tools that share its prefix', () => {
    expect(workerDomain('hoi4.event_write')).not.toBe(workerDomain('hoi4.event_inspect'));
    expect(workerDomain('hoi4.event_inspect')).toBe(workerDomain('hoi4.event_render'));
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
