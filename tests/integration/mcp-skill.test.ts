import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import { SETUP_LOCK_PATH } from '../../src/hoi4_agent_tools/reference/skills.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(close.splice(0).map((callback) => callback())));

const SKILL = '---\nname: hoi4-events\ndescription: Use when writing events.\n---\n\n# Events\n';
const REVISION = 'c045d7e0000000000000000000000000000000aa';

async function connected() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-skill-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const modRoot = path.join(root, 'mod');
  const skillPath = '.agents/skills/hoi4-events/SKILL.md';
  await mkdir(path.join(modRoot, '.agents/skills/hoi4-events'), { recursive: true });
  await mkdir(path.join(modRoot, '.hoi4-mod-setup'));
  await writeFile(path.join(modRoot, skillPath), SKILL);
  await writeFile(
    path.join(modRoot, SETUP_LOCK_PATH),
    JSON.stringify({
      source: {
        repository: 'klimPaskov/Agentic-HOI4-Modding',
        revision: REVISION,
        release: null,
        manifest_sha256: 'a'.repeat(64),
      },
      files: [{ path: skillPath, installed_sha256: sha256Bytes(SKILL) }],
    }),
  );
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: [{ id: 'mod', name: 'mod', root: modRoot }],
  });
  const server = createMcpServer(new CoreEngine(await WorkspaceResolver.create(config)), {});
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.unshift(
    () => client.close(),
    () => server.close(),
  );
  return { client, modRoot, skillPath };
}

describe('skills over MCP', () => {
  it('serves the same pinned text through hoi4.skill and the skill resource', async () => {
    const { client } = await connected();
    const listed = await client.callTool({ name: 'hoi4.skill', arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      status: 'ok',
      code: 'SKILLS_LISTED',
      data: {
        kit: { revision: REVISION },
        skills: [{ name: 'hoi4-events', state: 'pinned' }],
        drifted: 0,
      },
    });
    const loaded = await client.callTool({
      name: 'hoi4.skill',
      arguments: { name: 'hoi4-events' },
    });
    expect(loaded.structuredContent).toMatchObject({
      code: 'SKILL_LOADED',
      validation: { passed: true },
      data: { skill: { text: SKILL, sha256: sha256Bytes(SKILL), state: 'pinned' } },
    });

    expect((await client.listResources()).resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: 'hoi4-agent://workspace/current/skill/hoi4-events' }),
      ]),
    );
    const resource = await client.readResource({
      uri: 'hoi4-agent://workspace/current/skill/hoi4-events',
    });
    expect(resource.contents[0]).toMatchObject({
      text: SKILL,
      mimeType: 'text/markdown',
      _meta: { sha256: sha256Bytes(SKILL), state: 'pinned', kitRevision: REVISION },
    });
  }, 120_000);

  it('refuses drifted text on both routes', async () => {
    const { client, modRoot, skillPath } = await connected();
    await writeFile(path.join(modRoot, skillPath), `${SKILL}\nA local edit.\n`);
    const loaded = await client.callTool({
      name: 'hoi4.skill',
      arguments: { name: 'hoi4-events' },
    });
    expect(loaded.isError).toBe(true);
    expect(JSON.stringify(loaded.structuredContent)).toContain('SKILL_TEXT_DRIFTED');
    await expect(
      client.readResource({ uri: 'hoi4-agent://workspace/mod/skill/hoi4-events' }),
    ).rejects.toThrow();
    const accepted = await client.callTool({
      name: 'hoi4.skill',
      arguments: { name: 'hoi4-events', acceptLocalEdits: true },
    });
    expect(accepted.structuredContent).toMatchObject({
      validation: { passed: false },
      data: { skill: { state: 'edited' }, drifted: 1 },
    });
  }, 120_000);
});
