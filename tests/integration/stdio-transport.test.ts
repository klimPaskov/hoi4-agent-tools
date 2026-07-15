import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { MCP_PROTOCOL_VERSION } from '../../src/hoi4_agent_tools/version.js';
import { STDIO_MAX_FRAME_BYTES } from '../../src/hoi4_agent_tools/mcp/transports/bounded-stdio.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const stdioEntry = path.join(projectRoot, 'src', 'bin', 'stdio.ts');

function launch(config: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, stdioEntry], {
    cwd: projectRoot,
    env: { ...process.env, HOI4_AGENT_CONFIG: config },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitForMessage(
  child: ChildProcessWithoutNullStreams,
  id: number,
  lines: string[],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for JSON-RPC response ${id}`)),
      10_000,
    );
    let pending = '';
    const consume = (chunk: Buffer): void => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length === 0) continue;
        lines.push(line);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
          clearTimeout(timeout);
          child.stdout.off('data', consume);
          reject(error);
          return;
        }
        if (parsed.id === id) {
          clearTimeout(timeout);
          child.stdout.off('data', consume);
          resolve(parsed);
          return;
        }
      }
    };
    child.stdout.on('data', consume);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`stdio server exited before response ${id}: ${code}`));
    });
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for stdio server to refuse an invalid frame'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function overflowConfig(prefix: string): Promise<string> {
  const temporary = await mkdtemp(path.join(tmpdir(), prefix));
  const workspace = path.join(temporary, 'mod');
  await mkdir(workspace);
  const config = path.join(temporary, 'config.json');
  await writeFile(
    config,
    `${JSON.stringify({
      version: 1,
      serverStateRoot: path.join(temporary, 'server-state'),
      workspaces: [{ id: 'fixture', name: 'Fixture', root: workspace }],
    })}\n`,
  );
  return config;
}

describe('local stdio transport', () => {
  it('uses newline-delimited JSON-RPC on stdout with no log contamination', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-stdio-'));
    const workspace = path.join(temporary, 'mod');
    await mkdir(workspace);
    const config = path.join(temporary, 'config.json');
    await writeFile(
      config,
      `${JSON.stringify({
        version: 1,
        serverStateRoot: path.join(temporary, 'server-state'),
        workspaces: [{ id: 'fixture', name: 'Fixture', root: workspace }],
      })}\n`,
    );
    const child = launch(config);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const stdoutLines: string[] = [];
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      })}\n`,
    );
    const initialized = await waitForMessage(child, 1, stdoutLines);
    expect(initialized).toMatchObject({
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'hoi4-agent-tools', version: '2.0.0' },
      },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    const listed = await waitForMessage(child, 2, stdoutLines);
    expect(listed).toMatchObject({ jsonrpc: '2.0', result: { tools: expect.any(Array) } });
    expect(stdoutLines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
    expect(stdoutLines.join('\n')).not.toContain('startup_failed');
    expect(stderr).not.toContain('"jsonrpc"');
    await stop(child);
  }, 20_000);

  it('writes startup failures only to stderr', async () => {
    const child = launch(path.join(tmpdir(), `missing-${Date.now()}.json`));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('"event":"startup_failed"');
  }, 20_000);

  it('refuses a newline-terminated frame above the fixed byte ceiling', async () => {
    const child = launch(await overflowConfig('hoi4-agent-stdio-complete-overflow-'));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdin.on('error', () => undefined);
    const frame = Buffer.alloc(STDIO_MAX_FRAME_BYTES + 2, 0x20);
    frame[frame.length - 1] = 0x0a;
    child.stdin.write(frame);

    expect(await waitForExit(child)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('"event":"transport_error"');
    expect(stderr).toContain('"code":"STDIO_FRAME_TOO_LARGE"');
    expect(stderr).toContain(`${STDIO_MAX_FRAME_BYTES}-byte limit`);
  }, 30_000);

  it('refuses an oversized frame before a newline or end-of-input arrives', async () => {
    const child = launch(await overflowConfig('hoi4-agent-stdio-incomplete-overflow-'));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdin.on('error', () => undefined);
    child.stdin.write(Buffer.alloc(STDIO_MAX_FRAME_BYTES + 1, 0x20));

    expect(await waitForExit(child)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('"event":"transport_error"');
    expect(stderr).toContain('"code":"STDIO_FRAME_TOO_LARGE"');
  }, 30_000);

  it('fatally refuses malformed UTF-8 without replacement decoding or stdout output', async () => {
    const child = launch(await overflowConfig('hoi4-agent-stdio-invalid-utf8-'));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdin.on('error', () => undefined);

    const prefix = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"',
      'utf8',
    );
    const suffix = Buffer.from('","version":"1.0.0"}}}\n', 'utf8');
    const validFollowup = Buffer.from(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'must-not-run', version: '1.0.0' },
        },
      })}\n`,
      'utf8',
    );
    child.stdin.write(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix, validFollowup]));

    expect(await waitForExit(child)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('"event":"transport_error"');
    expect(stderr).toContain('"code":"STDIO_INVALID_UTF8"');
    expect(stderr).toContain('not valid UTF-8');
    expect(stderr).not.toContain('\ufffd');
  }, 20_000);

  it('redacts rejected JSON-RPC frame content from stable stderr diagnostics', async () => {
    const child = launch(await overflowConfig('hoi4-agent-stdio-invalid-message-'));
    const sentinel = `SECRET_STDIO_FRAME_${Date.now()}`;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const diagnostic = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for the redacted stdio diagnostic'));
      }, 10_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.includes('"code":"STDIO_INVALID_MESSAGE"')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: { sentinel },
        params: {},
      })}\n`,
    );
    await diagnostic;

    expect(stdout).toBe('');
    expect(stderr).toContain('"event":"transport_error"');
    expect(stderr).toContain('"message":"Stdio frame is not a valid JSON-RPC message"');
    expect(stderr).not.toContain(sentinel);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'post-rejection-test', version: '1.0.0' },
        },
      })}\n`,
    );
    const response = await waitForMessage(child, 2, []);
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
    await stop(child);
  }, 20_000);

  it('advertises only the production final revision for every non-current request', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-protocol-negotiation-'));
    const workspace = path.join(temporary, 'mod');
    await mkdir(workspace);
    const config = path.join(temporary, 'config.json');
    await writeFile(
      config,
      `${JSON.stringify({
        version: 1,
        serverStateRoot: path.join(temporary, 'server-state'),
        workspaces: [{ id: 'fixture', name: 'Fixture', root: workspace }],
      })}\n`,
    );
    for (const [index, requested] of [...SUPPORTED_PROTOCOL_VERSIONS, '1900-01-01'].entries()) {
      const child = launch(config);
      const id = index + 10;
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: requested,
            capabilities: {},
            clientInfo: { name: 'negotiation-test', version: '1.0.0' },
          },
        })}\n`,
      );
      const response = await waitForMessage(child, id, []);
      expect(response).toMatchObject({
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
      });
      await stop(child);
    }
  }, 30_000);
});
