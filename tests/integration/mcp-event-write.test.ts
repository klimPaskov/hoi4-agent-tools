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

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

interface Envelope {
  status: string;
  code: string;
  proposedFiles: string[];
  changedFiles: string[];
  diagnostics: Array<{ code: string; severity: string }>;
  blockers: Array<{ code: string }>;
  data: {
    operation: string;
    id: string;
    kind: string;
    path: string;
    applied: boolean;
    diff: string;
    untouchedDefinitions: number;
    namespaceAdded: boolean;
    missing: { localisation: string[]; picture: string[] };
  };
}

const EVENTS = [
  'add_namespace = tst',
  '',
  'country_event = {',
  '\tid = tst.1',
  '\ttitle = tst.1.t',
  '\tpicture = GFX_report_event_tst',
  '\tis_triggered_only = yes',
  '\toption = {',
  '\t\tname = tst.1.a',
  '\t}',
  '}',
  '',
].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-evw-mcp-'));
  close.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mod = path.join(root, 'my_mod');
  const game = path.join(root, 'game');
  const put = async (base: string, relative: string, content: string) => {
    const file = path.join(base, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(mod, 'descriptor.mod', 'name="Event write test"\n');
  await put(mod, 'events/tst_events.txt', EVENTS);
  await put(
    mod,
    'interface/my_events.gfx',
    'spriteTypes = {\n\tspriteType = { name = "GFX_report_event_tst" texturefile = "gfx/event_pictures/tst.dds" }\n}\n',
  );
  await put(
    mod,
    'localisation/english/my_l_english.yml',
    '﻿l_english:\n tst.1.t: "First"\n tst.1.a: "Fine"\n',
  );
  await put(
    game,
    'events/GER.txt',
    'add_namespace = ger\ncountry_event = {\n\tid = ger.1\n\ttitle = ger.1.t\n}\n',
  );
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
  const client = new Client({ name: 'event-write-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: 'hoi4.event_write',
      arguments: { workspaceId: 'fixture', ...args },
    });
    return result.structuredContent as unknown as Envelope;
  };
  const read = (relative: string) => readFile(path.join(mod, ...relative.split('/')), 'utf8');
  return { call, read, put: (relative: string, content: string) => put(mod, relative, content) };
}

describe('hoi4.event_write through an MCP client', () => {
  it('previews a diff, applies it, and the same apply again is refused', async () => {
    const { call, read } = await fixture();
    const request = {
      operation: 'add',
      id: 'tst.2',
      body: 'title = tst.1.t\npicture = GFX_report_event_tst\noption = { name = tst.1.a }',
    };
    const preview = await call(request);
    expect(preview.code).toBe('EVENT_WRITE_PREVIEW');
    expect(preview.data).toMatchObject({
      applied: false,
      id: 'tst.2',
      kind: 'country_event',
      path: 'events/tst_events.txt',
      untouchedDefinitions: 1,
      namespaceAdded: false,
    });
    expect(preview.data.diff).toContain('+\tid = tst.2');
    expect(await read('events/tst_events.txt')).toBe(EVENTS);

    const applied = await call({ ...request, apply: true });
    expect(applied).toMatchObject({
      status: 'ok',
      code: 'EVENT_WRITE_APPLIED',
      changedFiles: ['events/tst_events.txt'],
    });
    const written = await read('events/tst_events.txt');
    expect(written).toBe(
      `${EVENTS}\ncountry_event = {\n\tid = tst.2\n\ttitle = tst.1.t\n\tpicture = GFX_report_event_tst\n\toption = { name = tst.1.a }\n}\n`,
    );
    const again = await call({ ...request, apply: true });
    expect(again.status).toBe('error');
    expect(JSON.stringify(again)).toContain('EVENT_WRITE_DUPLICATE_ID');
    expect(await read('events/tst_events.txt')).toBe(written);
  });

  it('replaces and removes an event found by its id, and the round trip restores the file', async () => {
    const { call, read } = await fixture();
    const replaced = await call({
      operation: 'replace',
      id: 'tst.1',
      body: 'title = tst.1.t\nis_triggered_only = yes',
      apply: true,
    });
    expect(replaced.code).toBe('EVENT_WRITE_APPLIED');
    expect(await read('events/tst_events.txt')).toBe(
      'add_namespace = tst\n\ncountry_event = {\n\tid = tst.1\n\ttitle = tst.1.t\n\tis_triggered_only = yes\n}\n',
    );
    const removed = await call({ operation: 'remove', id: 'tst.1', apply: true });
    expect(removed.code).toBe('EVENT_WRITE_APPLIED');
    expect(await read('events/tst_events.txt')).toBe('add_namespace = tst\n');
  });

  it('warns about missing localisation keys and picture sprite, and still writes', async () => {
    const { call, read } = await fixture();
    const result = await call({
      operation: 'add',
      id: 'tst.5',
      body: 'title = tst.5.t\ndesc = tst.5.d\npicture = GFX_no_such_picture\noption = { name = tst.5.a }',
      apply: true,
    });
    expect(result.code).toBe('EVENT_WRITE_APPLIED');
    expect(result.data.missing).toEqual({
      localisation: ['tst.5.t', 'tst.5.d', 'tst.5.a'],
      picture: ['GFX_no_such_picture'],
    });
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      'EVENT_WRITE_LOCALISATION_MISSING',
      'EVENT_WRITE_LOCALISATION_MISSING',
      'EVENT_WRITE_LOCALISATION_MISSING',
      'EVENT_WRITE_PICTURE_UNDEFINED',
    ]);
    expect(await read('events/tst_events.txt')).toContain('id = tst.5');
  });

  it('refuses what it cannot place: a game event, a bad body, an undeclared namespace', async () => {
    const { call, read } = await fixture();
    const game = await call({ operation: 'remove', id: 'ger.1', apply: true });
    expect(game.status).toBe('error');
    expect(JSON.stringify(game)).toContain('EVENT_WRITE_NOT_IN_MOD');
    const body = await call({ operation: 'add', id: 'tst.7', body: 'a = { b = c' });
    expect(JSON.stringify(body)).toContain('EVENT_WRITE_BODY_INVALID');
    const namespace = await call({ operation: 'add', id: 'typo.1', body: 'title = x' });
    expect(JSON.stringify(namespace)).toContain('EVENT_WRITE_NAMESPACE_MISSING');
    expect(await read('events/tst_events.txt')).toBe(EVENTS);
  });

  it('plans from the file as it is now, keeping a hand edit made after a preview', async () => {
    const { call, put, read } = await fixture();
    const request = { operation: 'add', id: 'tst.8', body: 'title = tst.8.t' };
    expect((await call(request)).code).toBe('EVENT_WRITE_PREVIEW');
    await put('events/tst_events.txt', `${EVENTS}# edited by hand\n`);
    const applied = await call({ ...request, apply: true });
    expect(applied.code).toBe('EVENT_WRITE_APPLIED');
    const text = await read('events/tst_events.txt');
    expect(text).toContain('# edited by hand');
    expect(text).toContain('id = tst.8');
  });

  it('creates a namespace and a new file only when told to, and needs a file when the mod has two', async () => {
    const { call, put, read } = await fixture();
    const fresh = {
      operation: 'add',
      id: 'fresh.1',
      body: 'title = fresh.1.t',
      file: 'events/fresh_events.txt',
    };
    expect(JSON.stringify(await call({ ...fresh, apply: true }))).toContain(
      'EVENT_WRITE_FILE_NOT_FOUND',
    );
    expect(JSON.stringify(await call({ ...fresh, createFile: true }))).toContain(
      'EVENT_WRITE_NAMESPACE_MISSING',
    );
    const preview = await call({ ...fresh, createFile: true, createNamespace: true });
    expect(preview).toMatchObject({ code: 'EVENT_WRITE_PREVIEW', proposedFiles: [fresh.file] });
    expect(preview.data.namespaceAdded).toBe(true);
    const made = await call({ ...fresh, createFile: true, createNamespace: true, apply: true });
    expect(made).toMatchObject({ code: 'EVENT_WRITE_APPLIED', changedFiles: [fresh.file] });
    expect(await read(fresh.file)).toBe(
      'add_namespace = fresh\n\ncountry_event = {\n\tid = fresh.1\n\ttitle = fresh.1.t\n}\n',
    );
    expect(JSON.stringify(await call({ ...fresh, createFile: true, apply: true }))).toContain(
      'EVENT_WRITE_FILE_EXISTS',
    );
    // The namespace now lives in its own file, so a second event of it goes there.
    const second = await call({ operation: 'add', id: 'fresh.2', body: 'title = fresh.2.t' });
    expect(second.data.path).toBe(fresh.file);
    // A third mod file with no namespace in common leaves a new namespace with no single place.
    await put('events/other.txt', 'add_namespace = other\n');
    const ambiguous = await call({
      operation: 'add',
      id: 'newns.1',
      body: 'title = x',
      createNamespace: true,
    });
    expect(JSON.stringify(ambiguous)).toContain('EVENT_WRITE_FILE_REQUIRED');
    for (const bad of ['events/../../escape.txt', 'common/other/x.txt', 'events/x.yml']) {
      const refused = await call({ ...fresh, id: 'fresh.9', file: bad, createFile: true });
      expect(refused.status).toBe('error');
    }
  });
});
