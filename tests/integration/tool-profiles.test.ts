import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';
import {
  parseProfilesEnv,
  PROFILES_ENV,
  profilesOf,
} from '../../src/hoi4_agent_tools/mcp/server/tool-profiles.js';

/**
 * Maintainer decision R-1: the tool list a session pays for stays within about 8,000 tokens.
 * The token count is estimated at 3.5 bytes per token of the listed JSON, output schemas
 * included. The review that set the ceiling measured 84 KiB as about 20,000 tokens on this
 * list, 4.2 bytes per token, so the estimate errs on the high side.
 */
const TOKEN_CEILING = 8_000;
const BYTES_PER_TOKEN = 3.5;

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Newest first and one at a time: the client and server stop before their folder is removed.
  for (const callback of close.splice(0).reverse()) await callback();
});

async function connected(profiles?: Array<'core' | 'map' | 'advanced' | 'all'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-profiles-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(root, 'test'));
  const config = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: [{ id: 'test', name: 'test', root: path.join(root, 'test') }],
    ...(profiles === undefined ? {} : { profiles }),
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(config));
  const server = createMcpServer(engine, {});
  const client = new Client({ name: 'profiles-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  close.push(
    async () => client.close(),
    async () => server.close(),
  );
  return client;
}

describe('tool profiles', () => {
  it('keeps the core tool list within the R-1 ceiling', async () => {
    const client = await connected(['core']);
    const listed = await client.listTools();
    const names = listed.tools.map(({ name }) => name);
    expect(
      names.every((name) => profilesOf(name).includes('core')),
      names.join(', '),
    ).toBe(true);
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names.length).toBeLessThanOrEqual(14);
    const bytes = Buffer.byteLength(JSON.stringify(listed), 'utf8');
    expect(Math.ceil(bytes / BYTES_PER_TOKEN), `${bytes} bytes`).toBeLessThanOrEqual(TOKEN_CEILING);
  });

  it('lists each profile on request, and every tool with all of them', async () => {
    const all = (await (await connected(['all'])).listTools()).tools.map(({ name }) => name);
    const map = (await (await connected(['map'])).listTools()).tools.map(({ name }) => name);
    const advanced = (await (await connected(['advanced'])).listTools()).tools.map(
      ({ name }) => name,
    );
    expect(map).toEqual(expect.arrayContaining(['hoi4.map_inspect', 'hoi4.map_rewrite']));
    expect(map).toContain('hoi4.job_inspect');
    expect(advanced).toEqual(expect.arrayContaining(['hoi4.focus_render', 'hoi4.job_cancel']));
    expect(advanced).not.toContain('hoi4.reference_search');
    // A server built in code without a choice lists every tool.
    expect((await (await connected()).listTools()).tools.map(({ name }) => name)).toEqual(all);
  });

  it('still answers a tool that its profiles do not list', async () => {
    const client = await connected(['core']);
    const listed = (await client.listTools()).tools.map(({ name }) => name);
    expect(listed).not.toContain('hoi4.gui_inspect');
    const result = await client.callTool({ name: 'hoi4.gui_inspect', arguments: {} });
    expect(result.structuredContent).toMatchObject({ status: 'ok', workspaceId: 'test' });
  });

  it('tells the agent how to list the other profiles', async () => {
    const client = await connected(['core']);
    expect(client.getInstructions()).toContain(`${PROFILES_ENV}=core,map,advanced`);
    expect((await connected(['all'])).getInstructions()).not.toContain(PROFILES_ENV);
  });

  it('lists a plugin tool in every profile, because the configuration that loads it chose it', () => {
    expect([...profilesOf('acme.echo')].sort()).toEqual(['advanced', 'core', 'map']);
    expect(profilesOf('hoi4.focus_render')).toEqual(['advanced']);
  });

  it('reads the profiles a client registration asks for, and refuses unknown names', () => {
    expect(parseProfilesEnv(undefined)).toBeUndefined();
    expect(parseProfilesEnv(' core, Map ')).toEqual(['core', 'map']);
    expect(parseProfilesEnv('all')).toEqual(['all']);
    expect(() => parseProfilesEnv('core,maps')).toThrow(/unknown profiles: maps/u);
  });
});
