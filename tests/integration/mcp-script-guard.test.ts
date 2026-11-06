import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { ENGINE_BINARY_ENV } from '../../src/hoi4_agent_tools/core/engine-client.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const close: Array<() => Promise<void>> = [];
const savedEngine = process.env[ENGINE_BINARY_ENV];
afterEach(async () => {
  if (savedEngine === undefined) delete process.env[ENGINE_BINARY_ENV];
  else process.env[ENGINE_BINARY_ENV] = savedEngine;
  for (const action of close.splice(0).reverse()) await action();
});

/**
 * A stand-in for `hoi4-engine check`: it reports one invented effect in the file the test
 * writes, as the real engine reports `REF_UNKNOWN_EFFECT`, and refuses any other command.
 */
const FAKE_CHECK = `import process from 'node:process';
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.argv[2] !== 'check' || !process.argv.includes('--mod')) process.exit(64);
  process.stdout.write(JSON.stringify({
    schema: 'hoi4-engine-report/1',
    engine_version: '0.1.0',
    verdict: 'fail',
    inputs: { layers: [
      { kind: 'game', name: 'game', path: 'game', replace_paths: [] },
      { kind: 'mod', name: 'Guard mod', path: 'mod', replace_paths: [] },
    ] },
    summary: { errors: 1, warnings: 0, infos: 0, by_code: { REF_UNKNOWN_EFFECT: 1 } },
    stats: { elapsed_ms: 1 },
    overrides: [],
    findings: [{
      code: 'REF_UNKNOWN_EFFECT', severity: 'error',
      message: '\`add_politcal_power\` is neither a documented effect nor a scripted effect defined in any loaded file',
      path: 'events/guard.txt', layer: 'Guard mod', line: 4, column: 13, start: 0, end: 1,
      subject: 'add_politcal_power', context: 'event:guard.1', suggestion: 'add_political_power',
      fingerprint: 'x', status: 'new',
    }],
  }));
});
`;

async function connect(engine: 'fake' | 'none') {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-guard-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const mod = path.join(root, 'mod');
  await mkdir(path.join(mod, 'events'), { recursive: true });
  await writeFile(path.join(mod, 'descriptor.mod'), 'name="Guard mod"\n');
  await writeFile(
    path.join(mod, 'events', 'guard.txt'),
    'add_namespace = guard\ncountry_event = {\n  id = guard.1\n  immediate = { add_politcal_power = 10 }\n}\n',
  );
  if (engine === 'fake') {
    const fake = path.join(root, 'fake-engine.mjs');
    await writeFile(fake, FAKE_CHECK);
    process.env[ENGINE_BINARY_ENV] = fake;
  } else {
    process.env[ENGINE_BINARY_ENV] = path.join(root, 'no-engine-here.exe');
  }
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [{ id: 'guard', name: 'Guard mod', root: mod }],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const client = new Client({ name: 'guard-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('script guard through a client', () => {
  it('reports an invented effect in the file just written, with the real name', async () => {
    const client = await connect('fake');
    const result = await client.callTool({
      name: 'hoi4.script_guard',
      arguments: { workspaceId: 'guard' },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'SCRIPT_GUARD_CHECKED',
      validation: { passed: false },
      data: {
        verdict: 'invented',
        filesChecked: 1,
        invented: [
          {
            name: 'add_politcal_power',
            kind: 'effect',
            path: 'events/guard.txt',
            line: 4,
            suggestion: 'add_political_power',
          },
        ],
      },
    });
  });

  it('says so when the engine is not available', async () => {
    const client = await connect('none');
    const result = await client.callTool({
      name: 'hoi4.script_guard',
      arguments: { workspaceId: 'guard', paths: ['events/guard.txt'] },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('refuses a path outside the mod', async () => {
    const client = await connect('fake');
    const result = await client.callTool({
      name: 'hoi4.script_guard',
      arguments: { workspaceId: 'guard', paths: ['../elsewhere.txt'] },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'SCRIPT_GUARD_PATH_OUTSIDE_MOD' });
  });
});
