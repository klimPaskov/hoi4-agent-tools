import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const BOM = '﻿';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

interface WriteData {
  applied: boolean;
  files: Array<{
    path: string;
    action: string;
    diff: string;
    changes: Array<{ kind: string; key?: string; line?: number }>;
  }>;
  skipped: Array<{ key: string; reason: string }>;
  unfixable: unknown[];
  counts: Record<string, number>;
}
interface Envelope {
  status: string;
  code: string;
  proposedFiles: string[];
  changedFiles: string[];
  data: WriteData;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-locw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string | Buffer) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Write test"\n');
  await put(
    mod,
    'localisation/english/m_l_english.yml',
    `${BOM}l_english:\r\n a: "A"\r\n c: "C"\r\n`,
  );
  await put(mod, 'localisation/english/legacy_l_english.yml', 'l_english:\n b: "B"\n');
  await put(game, 'localisation/english/v_l_english.yml', `${BOM}l_english:\n GAME_KEY: "Game"\n`);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(root, 'state'),
      workspaces: [
        { id: 'fixture', name: 'Fixture', root: mod, gameRoot: game, includeGameDlc: false },
      ],
    }),
  );
  const server = createMcpServer(new CoreEngine(resolver));
  const client = new Client({ name: 'localisation-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = (args: Record<string, unknown>) =>
    client.callTool({
      name: 'hoi4.localisation_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, game };
}

describe('hoi4.localisation_write through an MCP client', () => {
  it('previews a diff, applies it, and a second apply changes nothing', async () => {
    const { call, read } = await fixture();
    const before = await read('localisation/english/m_l_english.yml');
    const request = {
      mode: 'add',
      entries: [
        { key: 'new_key', text: 'New "quoted" text' },
        { key: 'GAME_KEY', text: 'Mod text' },
        { key: 'a', text: 'A' },
      ],
    };

    const preview = await call(request);
    expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
    const previewed = preview.structuredContent as unknown as Envelope;
    expect(previewed.code).toBe('LOCALISATION_PREVIEW');
    expect(previewed.data.applied).toBe(false);
    expect(previewed.proposedFiles).toEqual([
      'localisation/english/m_l_english.yml',
      'localisation/english/replace/my_mod_replace_l_english.yml',
    ]);
    expect(previewed.data.files[0]!.diff).toContain('+ new_key: "New \\"quoted\\" text"');
    expect(previewed.data.files[1]!).toMatchObject({ action: 'create' });
    expect(previewed.data.files[1]!.changes).toEqual([
      { kind: 'create_file' },
      { kind: 'override_key', key: 'GAME_KEY', line: 2 },
    ]);
    expect(previewed.data.skipped).toMatchObject([{ key: 'a' }]);
    expect(await read('localisation/english/m_l_english.yml')).toBe(before);
    await expect(
      read('localisation/english/replace/my_mod_replace_l_english.yml'),
    ).rejects.toThrow();

    const applied = await call({ ...request, apply: true });
    expect(applied.isError, JSON.stringify(applied.content)).not.toBe(true);
    const done = applied.structuredContent as unknown as Envelope;
    expect(done.code).toBe('LOCALISATION_CHANGES_APPLIED');
    expect(done.data.applied).toBe(true);
    expect(done.changedFiles.sort()).toEqual(previewed.proposedFiles);
    expect(done.data.files.map(({ diff }) => diff)).toEqual(
      previewed.data.files.map(({ diff }) => diff),
    );
    expect(await read('localisation/english/m_l_english.yml')).toBe(
      `${BOM}l_english:\r\n a: "A"\r\n c: "C"\r\n new_key: "New \\"quoted\\" text"\r\n`,
    );
    expect(await read('localisation/english/replace/my_mod_replace_l_english.yml')).toBe(
      `${BOM}l_english:\n GAME_KEY: "Mod text"\n`,
    );

    const again = await call({ ...request, apply: true });
    const repeated = again.structuredContent as unknown as Envelope;
    expect(repeated.code).toBe('LOCALISATION_CHANGES_UNCHANGED');
    expect(repeated.data.applied).toBe(false);
    expect(repeated.data.files).toEqual([]);
    expect(repeated.changedFiles).toEqual([]);
    expect(await read('localisation/english/m_l_english.yml')).toContain('new_key');
  });

  it('fixes a missing BOM only after apply', async () => {
    const { call, read } = await fixture();
    const preview = await call({ mode: 'fix', fixes: ['bom'] });
    const previewed = preview.structuredContent as unknown as Envelope;
    expect(previewed.data.counts).toMatchObject({ filesChanged: 1, bomsAdded: 1 });
    expect(previewed.data.files[0]!.diff).toContain('+[BOM]l_english:');
    expect(await read('localisation/english/legacy_l_english.yml')).toBe('l_english:\n b: "B"\n');
    await call({ mode: 'fix', fixes: ['bom'], apply: true });
    expect(await read('localisation/english/legacy_l_english.yml')).toBe(
      `${BOM}l_english:\n b: "B"\n`,
    );
    const again = await call({ mode: 'fix', fixes: ['bom'], apply: true });
    expect((again.structuredContent as unknown as Envelope).data.counts.filesChanged).toBe(0);
  });

  it('refuses paths outside the mod localisation folder and changes nothing', async () => {
    const { call, read, game } = await fixture();
    const before = await read('localisation/english/m_l_english.yml');
    const entries = [{ key: 'x', text: 'X' }];
    for (const file of [
      '../game/localisation/english/v_l_english.yml',
      'localisation/../descriptor_l_english.yml',
      '/etc/passwd',
      'events/x_l_english.yml',
      path.join(game, 'localisation', 'english', 'v_l_english.yml'),
    ]) {
      const result = await call({ mode: 'add', entries, file, apply: true });
      expect(result.isError, file).toBe(true);
    }
    const traversal = await call({ mode: 'fix', paths: ['localisation/../../x'], apply: true });
    expect(traversal.isError).toBe(true);
    expect(await read('localisation/english/m_l_english.yml')).toBe(before);
    expect(await readFile(path.join(game, 'localisation/english/v_l_english.yml'), 'utf8')).toBe(
      `${BOM}l_english:\n GAME_KEY: "Game"\n`,
    );
  });
});
