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
  await engine.persistentAnalysisCache;
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
      expect((tools.result as { tools: unknown[] }).tools).toHaveLength(27);
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
      expect((tools.result as { tools: unknown[] }).tools).toHaveLength(27);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await transport.close();
      input.end();
      output.end();
    }
  }, 60_000);
});
