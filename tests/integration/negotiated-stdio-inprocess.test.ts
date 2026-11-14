import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import {
  isModernStdioOpening,
  serveNegotiatedStdio,
} from '../../src/hoi4_agent_tools/mcp/transports/negotiated-stdio.js';
import { PACKAGE_VERSION } from '../../src/hoi4_agent_tools/version.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture(): Promise<CoreEngine> {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-negotiated-stdio-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const workspace = path.join(root, 'mod');
  const source = path.join(workspace, 'common', 'national_focus', 'negotiated.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    'focus_tree = { id = negotiated focus = { id = negotiated_root x = 0 y = 0 cost = 1 } }\n',
  );
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: [{ id: 'fixture', name: 'Fixture', root: workspace }],
  });
  const engine = new CoreEngine(await WorkspaceResolver.create(configuration));
  return engine;
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
      }, 15_000);
      pending.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'in-process-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

describe('in-process negotiated stdio', () => {
  it('pins discovery and metadata to modern, but initialize to legacy', () => {
    const message = (method: string, params?: Record<string, unknown>): JSONRPCMessage =>
      ({
        jsonrpc: '2.0',
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }) as JSONRPCMessage;
    expect(isModernStdioOpening(message('server/discover'))).toBe(true);
    expect(isModernStdioOpening(message('initialize', { _meta: modernMeta }))).toBe(false);
    expect(isModernStdioOpening(message('tools/list', { _meta: modernMeta }))).toBe(true);
    expect(isModernStdioOpening(message('tools/list', { _meta: { progressToken: 'x' } }))).toBe(
      false,
    );
    expect(isModernStdioOpening(message('tools/list'))).toBe(false);
    expect(isModernStdioOpening({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
  });

  it('serves modern discovery and inspection on the bounded physical stream', async () => {
    const engine = await fixture();
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
    try {
      expect(await request(1, 'server/discover', { _meta: modernMeta })).toMatchObject({
        result: { supportedVersions: ['2026-07-28'] },
      });
      const tools = await request(2, 'tools/list', { _meta: modernMeta });
      expect((tools.result as { tools: unknown[] }).tools).toHaveLength(39);
      expect(
        await request(3, 'tools/call', {
          _meta: modernMeta,
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'fixture', treeId: 'negotiated' },
        }),
      ).toMatchObject({ result: { structuredContent: { status: 'ok' } } });
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await transport.close();
      input.end();
      output.end();
    }
  }, 60_000);

  it('keeps legacy initialization and tool listing on the same bounded stream', async () => {
    const engine = await fixture();
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
    try {
      expect(
        await request(1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'in-process-legacy', version: '1' },
        }),
      ).toMatchObject({
        result: { protocolVersion: '2025-11-25', serverInfo: { version: PACKAGE_VERSION } },
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const tools = await request(2, 'tools/list');
      expect((tools.result as { tools: unknown[] }).tools).toHaveLength(39);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await transport.close();
      input.end();
      output.end();
    }
  }, 60_000);

  function blockRecovery(engine: CoreEngine) {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recovered: string[] = [];
    engine.transactions.recover = async (workspaceId: string) => {
      await blocker;
      recovered.push(workspaceId);
      return [];
    };
    void engine.initialize();
    return { release, recovered };
  }

  const legacyInitialize = {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'in-process-recovery', version: '1' },
  };

  function heldCall(id: number): string {
    return `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'hoi4.focus_inspect', arguments: { workspaceId: 'fixture' } },
    })}\n`;
  }

  it('answers the handshake during startup recovery and holds tool calls until it ends', async () => {
    const engine = await fixture();
    const { release, recovered } = blockRecovery(engine);
    // Record whether any request resolved the workspace before its recovery ended.
    const resolvedBeforeRecovery: string[] = [];
    const get = engine.resolver.get.bind(engine.resolver);
    engine.resolver.get = (id, principal) => {
      if (recovered.length === 0) resolvedBeforeRecovery.push(id);
      return get(id, principal);
    };
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
    try {
      expect(await request(1, 'initialize', legacyInitialize)).toMatchObject({
        result: { serverInfo: { version: PACKAGE_VERSION } },
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      expect(await request(2, 'ping')).toMatchObject({ result: {} });
      const tools = await request(3, 'tools/list');
      expect((tools.result as { tools: unknown[] }).tools).toHaveLength(39);
      let answered = false;
      const call = request(4, 'tools/call', {
        name: 'hoi4.focus_inspect',
        arguments: { workspaceId: 'fixture', treeId: 'negotiated' },
      }).then((response) => {
        answered = true;
        return response;
      });
      // A ping sent after a held call keeps its place behind it.
      const laterPing = request(5, 'ping');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(answered).toBe(false);
      expect(recovered).toEqual([]);
      expect(resolvedBeforeRecovery).toEqual([]);
      release();
      expect(await call).toMatchObject({ result: { structuredContent: { status: 'ok' } } });
      expect(await laterPing).toMatchObject({ result: {} });
      expect(recovered).toEqual(['fixture']);
      expect(resolvedBeforeRecovery).toEqual([]);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      release();
      await transport.close();
      input.end();
      output.end();
    }
  }, 60_000);

  it('closes the connection when requests held during recovery exceed the bound', async () => {
    const engine = await fixture();
    const { release } = blockRecovery(engine);
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const transport = await serveNegotiatedStdio(engine, {
      stdin: input,
      stdout: output,
      onerror: (error) => errors.push(error),
      onFailure: () => undefined,
    });
    try {
      for (let id = 1; id <= 129; id += 1) input.write(heldCall(id));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(errors.map(({ message }) => message)).toContain(
        'Requests held during startup recovery exceeded their bounded limit',
      );
      release();
      await engine.recovered();
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The closed connection answers none of the held requests.
      expect(written.join('')).toBe('');
    } finally {
      release();
      await transport.close();
      input.end();
      output.end();
    }
  }, 60_000);

  it('answers no held request when startup recovery fails', async () => {
    const engine = await fixture();
    const failure = new Error('recovery could not run');
    engine.recovered = () => Promise.reject(failure);
    const input = new PassThrough();
    const output = new PassThrough();
    const failures: unknown[] = [];
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const transport = await serveNegotiatedStdio(engine, {
      stdin: input,
      stdout: output,
      onerror: () => undefined,
      onFailure: (error) => failures.push(error),
    });
    try {
      input.write(heldCall(1));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(failures).toEqual([failure]);
      expect(written.join('')).toBe('');
    } finally {
      await transport.close();
      input.end();
      output.end();
    }
  }, 60_000);
});
