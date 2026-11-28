import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../src/hoi4_agent_tools/core/result.js';
import { TransactionManager } from '../../src/hoi4_agent_tools/core/transactions.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createEngine } from '../../src/hoi4_agent_tools/runtime.js';
import { serveNegotiatedStdio } from '../../src/hoi4_agent_tools/mcp/transports/negotiated-stdio.js';
import { PACKAGE_VERSION } from '../../src/hoi4_agent_tools/version.js';

/**
 * The stdio entry answers `initialize` and `tools/list` before the workspaces are loaded (issue
 * 292): `createEngine` with `workspaces: 'background'` returns after the configuration is read,
 * and the transport holds every request that needs a workspace until the loading ends.
 */

const cleanup: Array<() => Promise<void>> = [];
const originalConfigVariable = process.env.HOI4_AGENT_CONFIG;
const originalProfilesVariable = process.env.HOI4_AGENT_TOOLS_PROFILES;

beforeEach(() => {
  delete process.env.HOI4_AGENT_TOOLS_PROFILES;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalConfigVariable === undefined) delete process.env.HOI4_AGENT_CONFIG;
  else process.env.HOI4_AGENT_CONFIG = originalConfigVariable;
  if (originalProfilesVariable === undefined) delete process.env.HOI4_AGENT_TOOLS_PROFILES;
  else process.env.HOI4_AGENT_TOOLS_PROFILES = originalProfilesVariable;
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-deferred-startup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return root;
}

async function writeConfiguration(root: string, extra: Record<string, unknown>): Promise<string> {
  const file = path.join(root, 'config.json');
  await writeFile(
    file,
    JSON.stringify({ version: 1, serverStateRoot: path.join(root, 'state'), ...extra }),
  );
  return file;
}

/** A mod root that holds several mods, each with a focus tree, as the real configuration does. */
async function modRootWithMods(root: string, count = 4): Promise<string> {
  const modRoot = path.join(root, 'mods');
  for (let index = 0; index < count; index += 1) {
    const mod = path.join(modRoot, `mod_${index}`);
    await mkdir(path.join(mod, 'common', 'national_focus'), { recursive: true });
    await writeFile(path.join(mod, 'descriptor.mod'), `name="Mod ${index}"\n`);
    await writeFile(
      path.join(mod, 'common', 'national_focus', 'tree.txt'),
      `focus_tree = { id = tree_${index} focus = { id = root_${index} x = 0 y = 0 cost = 1 } }\n`,
    );
  }
  return modRoot;
}

/** One mod registered by id, so a call can name it while discovery of the others is held. */
function fixtureWorkspace(modRoot: string, index = 1) {
  return { id: 'fixture', name: 'Fixture', root: path.join(modRoot, `mod_${index}`) };
}

function wire(input: PassThrough, output: PassThrough) {
  const pending = new Map<number, (response: Record<string, unknown>) => void>();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    for (;;) {
      const newline = text.indexOf('\n');
      if (newline < 0) break;
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id !== 'number') continue;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 90_000);
      pending.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

const legacyInitialize = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'deferred-startup', version: '1' },
};

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'deferred-startup', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function serve(engine: Awaited<ReturnType<typeof createEngine>>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors: Error[] = [];
  const failures: unknown[] = [];
  const request = wire(input, output);
  const transport = await serveNegotiatedStdio(engine, {
    stdin: input,
    stdout: output,
    onerror: (error) => errors.push(error),
    onFailure: (error) => failures.push(error),
  });
  cleanup.push(async () => {
    await transport.close();
    input.end();
    output.end();
  });
  return { input, request, errors, failures };
}

/** Hold `discoverModWorkspaces`, the slow step of loading, until `release` is called. */
function holdDiscovery() {
  const prototype = WorkspaceResolver.prototype as unknown as {
    discoverModWorkspaces: (this: unknown) => Promise<void>;
  };
  const original = prototype.discoverModWorkspaces;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  vi.spyOn(prototype, 'discoverModWorkspaces').mockImplementation(async function (this: unknown) {
    started = true;
    await gate;
    return original.call(this);
  });
  return { release, started: () => started };
}

function stderrEvents(): { events: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return {
    events: () =>
      lines
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const focusCall = {
  name: 'hoi4.focus_inspect',
  arguments: { workspaceId: 'fixture', treeId: 'tree_1' },
};

describe('stdio startup does not wait for the workspaces', () => {
  it('answers initialize and tools/list while discovery is held, and the call once it ends', async () => {
    const root = await temporaryRoot();
    const modRoot = await modRootWithMods(root);
    const configPath = await writeConfiguration(root, {
      modRoots: [modRoot],
      workspaces: [fixtureWorkspace(modRoot)],
    });
    const hold = holdDiscovery();
    const engine = await createEngine(configPath, { workspaces: 'background' });
    const { input, request, errors, failures } = await serve(engine);

    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({
      result: { serverInfo: { version: PACKAGE_VERSION } },
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await request(2, 'tools/list');
    expect((tools.result as { tools: unknown[] }).tools).toHaveLength(45);
    // The handshake and the list started no discovery.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hold.started()).toBe(false);

    let answered = false;
    const call = request(3, 'tools/call', focusCall).then((response) => {
      answered = true;
      return response;
    });
    // The first call that needs a workspace starts discovery, which is held.
    await vi.waitFor(() => expect(hold.started()).toBe(true), { timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(answered).toBe(false);

    hold.release();
    expect(await call).toMatchObject({ result: { structuredContent: { status: 'ok' } } });
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);

  it('answers modern discovery and tools/list while discovery is held', async () => {
    const root = await temporaryRoot();
    const modRoot = await modRootWithMods(root);
    const configPath = await writeConfiguration(root, {
      modRoots: [modRoot],
      workspaces: [fixtureWorkspace(modRoot)],
    });
    const hold = holdDiscovery();
    const engine = await createEngine(configPath, { workspaces: 'background' });
    const { request, errors, failures } = await serve(engine);

    expect(await request(1, 'server/discover', { _meta: modernMeta })).toMatchObject({
      result: { supportedVersions: ['2026-07-28'] },
    });
    const tools = await request(2, 'tools/list', { _meta: modernMeta });
    expect((tools.result as { tools: unknown[] }).tools).toHaveLength(45);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hold.started()).toBe(false);
    let answered = false;
    const call = request(3, 'tools/call', { _meta: modernMeta, ...focusCall }).then((response) => {
      answered = true;
      return response;
    });
    await vi.waitFor(() => expect(hold.started()).toBe(true), { timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(answered).toBe(false);
    hold.release();
    expect(await call).toMatchObject({ result: { structuredContent: { status: 'ok' } } });
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);

  it('lists the profiles of the configuration before the workspaces are loaded', async () => {
    const root = await temporaryRoot();
    const modRoot = await modRootWithMods(root, 1);
    const configPath = await writeConfiguration(root, {
      modRoots: [modRoot],
      workspaces: [fixtureWorkspace(modRoot, 0)],
      profiles: ['core'],
    });
    const hold = holdDiscovery();
    const engine = await createEngine(configPath, { workspaces: 'background' });
    const { request } = await serve(engine);
    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({ result: {} });
    const tools = (await request(2, 'tools/list')).result as { tools: Array<{ name: string }> };
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.tools.length).toBeLessThan(45);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hold.started()).toBe(false);
    hold.release();
    await engine.recovered();
  }, 60_000);

  it('serves the workspaces after loading, as a foreground start does', async () => {
    const root = await temporaryRoot();
    const modRoot = await modRootWithMods(root);
    const configPath = await writeConfiguration(root, {
      modRoots: [modRoot],
      workspaces: [fixtureWorkspace(modRoot)],
    });
    const background = await createEngine(configPath, { workspaces: 'background' });
    await background.recovered();
    const foreground = await createEngine(configPath);
    expect(background.list().map(({ id }) => id)).toEqual(foreground.list().map(({ id }) => id));
    expect(background.list()).toHaveLength(4);
  }, 60_000);
});

describe('a startup error is reported on the first call that needs a workspace', () => {
  async function toolCode(
    request: ReturnType<typeof wire>,
    id: number,
  ): Promise<{ code: unknown; isError: unknown; text: string }> {
    const response = await request(id, 'tools/call', focusCall);
    const result = response.result as {
      isError?: unknown;
      structuredContent?: { code?: unknown };
      content?: Array<{ text?: string }>;
    };
    return {
      code: result.structuredContent?.code,
      isError: result.isError,
      text: result.content?.map(({ text }) => text ?? '').join('') ?? '',
    };
  }

  it('reports a missing configuration file named by HOI4_AGENT_CONFIG', async () => {
    const root = await temporaryRoot();
    process.env.HOI4_AGENT_CONFIG = path.join(root, 'missing-config.json');
    const stderr = stderrEvents();
    // A foreground start still stops with this code.
    await expect(createEngine()).rejects.toMatchObject({ code: 'CONFIG_READ_FAILED' });

    const engine = await createEngine(undefined, { workspaces: 'background' });
    const { request, errors, failures } = await serve(engine);
    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({
      result: { serverInfo: { version: PACKAGE_VERSION } },
    });
    expect((await request(2, 'tools/list')).result as { tools: unknown[] }).toMatchObject({
      tools: expect.any(Array) as unknown,
    });
    for (const id of [3, 4]) {
      expect(await toolCode(request, id)).toMatchObject({
        isError: true,
        code: 'CONFIG_READ_FAILED',
      });
    }
    // The server keeps answering after the failed calls.
    expect(await request(5, 'ping')).toMatchObject({ result: {} });
    expect(stderr.events()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        event: 'startup_failed',
        code: 'CONFIG_READ_FAILED',
      }),
    );
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);

  it('reports an invalid configuration file', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'config.json');
    await writeFile(file, JSON.stringify({ version: 1, scanMaxFiles: 'many' }));
    process.env.HOI4_AGENT_CONFIG = file;
    stderrEvents();
    await expect(createEngine()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const engine = await createEngine(undefined, { workspaces: 'background' });
    const { request } = await serve(engine);
    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({ result: {} });
    expect(await toolCode(request, 2)).toMatchObject({ isError: true, code: 'CONFIG_INVALID' });
  }, 60_000);

  it('reports a mod root that is not a real directory', async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfiguration(root, {
      modRoots: [path.join(root, 'no-such-mods')],
    });
    const stderr = stderrEvents();
    await expect(createEngine(configPath)).rejects.toMatchObject({
      code: 'WORKSPACE_MOD_ROOT_UNSAFE',
    });
    const engine = await createEngine(configPath, { workspaces: 'background' });
    const { request, errors, failures } = await serve(engine);
    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({ result: {} });
    expect(await toolCode(request, 2)).toMatchObject({
      isError: true,
      code: 'WORKSPACE_MOD_ROOT_UNSAFE',
    });
    expect(stderr.events()).toContainEqual(
      expect.objectContaining({ event: 'startup_failed', code: 'WORKSPACE_MOD_ROOT_UNSAFE' }),
    );
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);

  it('reports a workspace error found while the workspaces load', async () => {
    const root = await temporaryRoot();
    const modRoot = await modRootWithMods(root, 2);
    const configPath = await writeConfiguration(root, {
      modRoots: [modRoot],
      workspaces: [fixtureWorkspace(modRoot, 0)],
      defaultWorkspace: 'no_such_mod',
    });
    const stderr = stderrEvents();
    await expect(createEngine(configPath)).rejects.toMatchObject({
      code: 'WORKSPACE_DEFAULT_UNKNOWN',
    });
    const engine = await createEngine(configPath, { workspaces: 'background' });
    const { request, errors, failures } = await serve(engine);
    // The handshake and the list answer first; the call waits for the loading and then fails.
    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({ result: {} });
    expect((await request(2, 'tools/list')).result as { tools: unknown[] }).toMatchObject({
      tools: expect.any(Array) as unknown,
    });
    expect(await toolCode(request, 3)).toMatchObject({
      isError: true,
      code: 'WORKSPACE_DEFAULT_UNKNOWN',
    });
    expect(await toolCode(request, 4)).toMatchObject({
      isError: true,
      code: 'WORKSPACE_DEFAULT_UNKNOWN',
    });
    expect(await request(5, 'ping')).toMatchObject({ result: {} });
    expect(stderr.events()).toContainEqual(
      expect.objectContaining({ event: 'startup_failed', code: 'WORKSPACE_DEFAULT_UNKNOWN' }),
    );
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);

  it('reports the configuration error on a reference call as well', async () => {
    const root = await temporaryRoot();
    process.env.HOI4_AGENT_CONFIG = path.join(root, 'missing-config.json');
    stderrEvents();
    const engine = await createEngine(undefined, { workspaces: 'background' });
    const { request } = await serve(engine);
    expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({ result: {} });
    const response = await request(2, 'tools/call', {
      name: 'hoi4.reference_search',
      arguments: { query: 'add_political_power' },
    });
    expect(response).toMatchObject({
      result: { isError: true, structuredContent: { code: 'CONFIG_READ_FAILED' } },
    });
  }, 60_000);
});

describe('an idle server loads and recovers nothing', () => {
  /** Watch discovery and recovery without changing them. */
  function watch() {
    const prototype = WorkspaceResolver.prototype as unknown as {
      discoverModWorkspaces: (this: unknown) => Promise<void>;
    };
    const discover = vi.spyOn(prototype, 'discoverModWorkspaces');
    const recover = vi.spyOn(TransactionManager.prototype, 'recover');
    return { discover, recover, recovered: () => recover.mock.calls.map(([id]) => id) };
  }

  async function startedServer() {
    const root = await temporaryRoot();
    const modRoot = await modRootWithMods(root);
    const configPath = await writeConfiguration(root, {
      modRoots: [modRoot],
      workspaces: [fixtureWorkspace(modRoot)],
    });
    return createEngine(configPath, { workspaces: 'background' });
  }

  it('triggers no discovery or recovery on the handshake, and recovers only the workspace a call uses', async () => {
    const watched = watch();
    const engine = await startedServer();
    const { input, request, errors, failures } = await serve(engine);

    await request(1, 'initialize', legacyInitialize);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await request(2, 'tools/list');
    await request(3, 'prompts/list');
    await request(4, 'ping');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(watched.discover).not.toHaveBeenCalled();
    expect(watched.recover).not.toHaveBeenCalled();

    expect(await request(5, 'tools/call', focusCall)).toMatchObject({
      result: { structuredContent: { status: 'ok' } },
    });
    expect(watched.discover).toHaveBeenCalledTimes(1);
    // Four mods are loaded; only the one the call named recovered, and only once.
    expect(engine.resolver.list()).toHaveLength(4);
    expect(watched.recovered()).toEqual(['fixture']);
    expect(await request(6, 'tools/call', focusCall)).toMatchObject({
      result: { structuredContent: { status: 'ok' } },
    });
    expect(watched.recovered()).toEqual(['fixture']);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 120_000);

  it('recovers a workspace before its first rewrite is planned', async () => {
    const watched = watch();
    const engine = await startedServer();
    await engine.recovered();
    expect(watched.recover).not.toHaveBeenCalled();
    // The rewrite is refused for its own reasons; the point is that recovery ran first.
    await engine.transactions
      .plan({ workspaceId: 'fixture', changes: [], operations: [] } as never)
      .catch(() => undefined);
    expect(watched.recovered()).toEqual(['fixture']);
  }, 120_000);

  it('reports a failed recovery on the first rewrite with the code it had at startup', async () => {
    const stderr = stderrEvents();
    vi.spyOn(TransactionManager.prototype, 'recover').mockRejectedValue(
      new ServiceError('TRANSACTION_ROOT_CHANGED', 'Workspace root configuration changed'),
    );
    const engine = await startedServer();
    const { request, errors, failures } = await serve(engine);
    await request(1, 'initialize', legacyInitialize);
    // A read still answers: only rewrites of that workspace wait for the recovery.
    expect(await request(2, 'tools/call', focusCall)).toMatchObject({
      result: { structuredContent: { status: 'ok' } },
    });
    expect(stderr.events()).toContainEqual(
      expect.objectContaining({
        event: 'transaction_recovery_blocked',
        workspaceId: 'fixture',
        code: 'TRANSACTION_ROOT_CHANGED',
      }),
    );
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        engine.transactions.plan({ workspaceId: 'fixture', changes: [], operations: [] } as never),
      ).rejects.toMatchObject({ code: 'TRANSACTION_RECOVERY_REQUIRED' });
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  }, 120_000);
});
