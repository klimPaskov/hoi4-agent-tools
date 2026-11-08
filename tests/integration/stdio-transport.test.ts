import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { MCP_PROTOCOL_VERSION, PACKAGE_VERSION } from '../../src/hoi4_agent_tools/version.js';
import { STDIO_MAX_FRAME_BYTES } from '../../src/hoi4_agent_tools/mcp/transports/bounded-stdio.js';
import { TASKS_EXTENSION } from '../../src/hoi4_agent_tools/mcp/server/modern-tasks.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const stdioEntry = path.join(projectRoot, 'src', 'bin', 'stdio.ts');

function launch(
  config: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, stdioEntry], {
    cwd: projectRoot,
    env: { ...process.env, HOI4_AGENT_CONFIG: config, ...extraEnvironment },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function launchAutomatic(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, stdioEntry], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitForMessage(
  child: ChildProcessWithoutNullStreams,
  id: number,
  lines: string[],
  progressToken?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', consume);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`stdio server exited before response ${id}: ${code}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
    }, 60_000);
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
          cleanup();
          reject(error);
          return;
        }
        if (
          progressToken !== undefined &&
          parsed.method === 'notifications/progress' &&
          (parsed.params as { progressToken?: unknown } | undefined)?.progressToken ===
            progressToken
        )
          timeout.refresh();
        if (parsed.id === id) {
          cleanup();
          resolve(parsed);
          return;
        }
      }
    };
    child.stdout.on('data', consume);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function listedToolNames(message: Record<string, unknown>): string[] {
  const result = message.result as { tools?: Array<{ name?: unknown }> } | undefined;
  return (result?.tools ?? [])
    .map(({ name }) => name)
    .filter((name): name is string => typeof name === 'string');
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill(), 2_000);
    const hardTimeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
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

async function overflowConfig(
  prefix: string,
  plugins?: (temporary: string) => Promise<string[]>,
): Promise<string> {
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
      ...(plugins === undefined ? {} : { plugins: await plugins(temporary) }),
    })}\n`,
  );
  return config;
}

/** A synthetic plugin with one tool, written as a .mjs file in the test's own folder. */
async function writeEchoPlugin(folder: string, toolName = 'acme.echo'): Promise<string> {
  const file = path.join(folder, 'acme-plugin.mjs');
  await writeFile(
    file,
    `export default async function createPlugin(host) {
  const { z } = await host.dependency('zod');
  const { emptyServiceResult } = await host.importServerModule('core/result.js');
  const { toolResult } = await host.importServerModule('core/operation-result.js');
  const input = z.object({ word: z.string().max(64) }).strict();
  return () => [
    {
      definition: {
        name: ${JSON.stringify(toolName)},
        title: 'Echo a word',
        description: 'Synthetic test plugin tool.',
        inputSchema: input,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      call: async (value) => {
        const result = emptyServiceResult('fixture', { echoed: value.word, serverVersion: host.serverVersion });
        result.code = 'ACME_ECHOED';
        return toolResult(result);
      },
    },
  ];
}
`,
  );
  return file;
}

describe('local stdio transport', () => {
  it('negotiates modern discovery and operations through the same bounded production entry', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-stdio-modern-'));
    const workspace = path.join(temporary, 'mod');
    const focusPath = path.join(workspace, 'common', 'national_focus', 'modern.txt');
    await mkdir(path.dirname(focusPath), { recursive: true });
    await writeFile(
      focusPath,
      'focus_tree = { id = modern focus = { id = modern_root x = 0 y = 0 cost = 1 } }\n',
    );
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
    const lines: string[] = [];
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'modern-stdio-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`;
    try {
      child.stdin.write(request(1, 'server/discover'));
      expect(await waitForMessage(child, 1, lines)).toMatchObject({
        result: { supportedVersions: ['2026-07-28'] },
      });
      child.stdin.write(request(2, 'tools/list'));
      expect(listedToolNames(await waitForMessage(child, 2, lines))).toHaveLength(34);
      child.stdin.write(
        request(3, 'tools/call', {
          name: 'hoi4.focus_inspect',
          arguments: { workspaceId: 'fixture', treeId: 'modern' },
        }),
      );
      expect(await waitForMessage(child, 3, lines)).toMatchObject({
        result: { structuredContent: { status: 'ok' } },
      });
      const taskMeta = {
        ...meta,
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TASKS_EXTENSION]: {} },
        },
      };
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'hoi4.focus_inspect',
            arguments: { workspaceId: 'fixture', treeId: 'modern' },
            _meta: taskMeta,
          },
        })}\n`,
      );
      const created = await waitForMessage(child, 4, lines);
      expect(created).toMatchObject({ result: { resultType: 'task' } });
      const taskId = (created.result as { taskId: string }).taskId;
      let completed: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = 5 + attempt;
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tasks/get',
            params: { taskId, _meta: taskMeta },
          })}\n`,
        );
        completed = await waitForMessage(child, id, lines);
        if ((completed.result as { status?: string } | undefined)?.status === 'completed') break;
        await delay(150);
      }
      expect(completed).toMatchObject({
        result: {
          status: 'completed',
          result: { structuredContent: { status: 'ok' } },
        },
      });
      expect(lines.some((line) => line.includes('"method":"initialize"'))).toBe(false);
    } finally {
      await stop(child);
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('exits cleanly when the coding-agent client closes stdin', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-stdio-close-'));
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
    try {
      const stdoutLines: string[] = [];
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'close-test', version: '1.0.0' },
          },
        })}\n`,
      );
      await waitForMessage(child, 1, stdoutLines);
      const exited = new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('stdio server remained alive after its client closed stdin'));
        }, 5_000);
        child.once('exit', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      child.stdin.end();
      await expect(exited).resolves.toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('starts from a sparse descriptor-less mod and resolves the current workspace', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-stdio-any-mod-'));
    const workspace = path.join(temporary, 'sparse-mod');
    const focusPath = path.join(workspace, 'common', 'national_focus', 'sparse.txt');
    await mkdir(path.dirname(focusPath), { recursive: true });
    await writeFile(
      focusPath,
      'focus_tree = { id = sparse focus = { id = sparse_root x = 0 y = 0 cost = 1 } }\n',
      'utf8',
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: path.join(temporary, 'appdata'),
      LOCALAPPDATA: path.join(temporary, 'localappdata'),
      'ProgramFiles(x86)': path.join(temporary, 'missing-game'),
    };
    delete environment.HOI4_AGENT_CONFIG;
    delete environment.HOI4_GAME_ROOT;
    const child = launchAutomatic(workspace, environment);
    const stdoutLines: string[] = [];
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'any-mod-stdio-test', version: '1.0.0' },
          },
        })}\n`,
      );
      await waitForMessage(child, 1, stdoutLines);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'hoi4.focus_inspect',
            _meta: { progressToken: 'sparse-focus-inspect' },
            arguments: { relativePath: 'common/national_focus/sparse.txt' },
          },
        })}\n`,
      );
      const inspected = await waitForMessage(child, 2, stdoutLines, 'sparse-focus-inspect');
      expect(inspected).toMatchObject({
        jsonrpc: '2.0',
        result: { structuredContent: { status: 'ok', code: 'FOCUS_INSPECTED' } },
      });
      expect(stdoutLines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
    } finally {
      await stop(child);
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // Two RPC waits plus process teardown must fit inside the outer test budget.
    // Matching progress keeps the tool's idle wait alive; this overall deadline stays finite.
  }, 150_000);

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
        serverInfo: { name: 'hoi4-agent-tools', version: PACKAGE_VERSION },
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
    expect(listedToolNames(listed).filter((name) => !name.startsWith('hoi4.'))).toEqual([]);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'hoi4.tech_inspect', arguments: { mode: 'scan' } },
      })}\n`,
    );
    const technology = await waitForMessage(child, 3, stdoutLines);
    expect(technology).toMatchObject({
      jsonrpc: '2.0',
      result: { structuredContent: { status: 'ok', code: 'TECH_INSPECTED' } },
    });
    expect(stdoutLines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
    expect(stdoutLines.join('\n')).not.toContain('startup_failed');
    expect(stderr).not.toContain('"jsonrpc"');
    await stop(child);
  }, 60_000);

  it('lists the tools of a configured plugin on the legacy era, and runs them', async () => {
    const config = await overflowConfig('hoi4-agent-stdio-plugin-', async (folder) => [
      await writeEchoPlugin(folder),
    ]);
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
          clientInfo: { name: 'plugin-stdio-test', version: '1.0.0' },
        },
      })}\n`,
    );
    await waitForMessage(child, 1, stdoutLines);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    expect(listedToolNames(await waitForMessage(child, 2, stdoutLines))).toContain('acme.echo');
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'acme.echo', arguments: { word: 'hello' } },
      })}\n`,
    );
    expect(await waitForMessage(child, 3, stdoutLines)).toMatchObject({
      result: {
        structuredContent: { status: 'ok', code: 'ACME_ECHOED', data: { echoed: 'hello' } },
      },
    });
    await stop(child);
    expect(stderr).not.toContain('"event":"startup_failed"');
  }, 30_000);

  it('lists and runs the tools of a configured plugin on the modern stdio era', async () => {
    const config = await overflowConfig('hoi4-agent-stdio-modern-plugin-', async (folder) => [
      await writeEchoPlugin(folder),
    ]);
    const child = launch(config);
    const lines: string[] = [];
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'plugin-modern-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`;
    try {
      child.stdin.write(request(1, 'server/discover'));
      await waitForMessage(child, 1, lines);
      child.stdin.write(request(2, 'tools/list'));
      expect(listedToolNames(await waitForMessage(child, 2, lines))).toContain('acme.echo');
      child.stdin.write(
        request(3, 'tools/call', { name: 'acme.echo', arguments: { word: 'modern' } }),
      );
      expect(await waitForMessage(child, 3, lines)).toMatchObject({
        result: {
          resultType: 'complete',
          structuredContent: { status: 'ok', code: 'ACME_ECHOED', data: { echoed: 'modern' } },
        },
      });
      child.stdin.write(request(4, 'tools/call', { name: 'acme.echo', arguments: { word: 3 } }));
      expect(await waitForMessage(child, 4, lines)).toMatchObject({ result: { isError: true } });
    } finally {
      await stop(child);
    }
  }, 60_000);

  it('skips a listed plugin that does not exist and refuses one that is not a plain module', async () => {
    const missing = await overflowConfig('hoi4-agent-stdio-plugin-missing-', async (folder) => [
      path.join(folder, 'absent-plugin.mjs'),
    ]);
    const child = launch(missing);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const lines: string[] = [];
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'plugin-missing-test', version: '1.0.0' },
        },
      })}\n`,
    );
    await waitForMessage(child, 1, lines);
    await stop(child);
    expect(stderr).toContain('"event":"plugin_skipped"');
    expect(stderr).not.toContain('startup_failed');

    // A path with a wrong extension never loads, and the server says why at startup.
    const wrong = await overflowConfig('hoi4-agent-stdio-plugin-wrong-', async (folder) => {
      const file = path.join(folder, 'plugin.txt');
      await writeFile(file, 'export default () => () => [];\n');
      return [file];
    });
    const refused = launch(wrong);
    let refusedStderr = '';
    refused.stderr.on('data', (chunk: Buffer) => (refusedStderr += chunk.toString('utf8')));
    expect(await new Promise<number | null>((resolve) => refused.once('exit', resolve))).toBe(1);
    expect(refusedStderr).toContain('PLUGIN_PATH_INVALID');
  }, 60_000);

  it('refuses a plugin tool that takes a reserved name', async () => {
    const config = await overflowConfig('hoi4-agent-stdio-plugin-reserved-', async (folder) => [
      await writeEchoPlugin(folder, 'hoi4.echo'),
    ]);
    const child = launch(config);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'plugin-reserved-test', version: '1.0.0' },
        },
      })}\n`,
    );
    const lines: string[] = [];
    // The legacy server builds the plugin tools at its first message; the name check throws there.
    await Promise.race([
      waitForMessage(child, 1, lines).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    await stop(child);
    expect(stderr).toContain('must be named');
  }, 60_000);

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
  }, 60_000);

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

  it('keeps the session usable after a domain request returns an error', async () => {
    const child = launch(await overflowConfig('hoi4-agent-stdio-request-error-'));
    const stdoutLines: string[] = [];
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'post-request-error-test', version: '1.0.0' },
        },
      })}\n`,
    );
    await waitForMessage(child, 1, stdoutLines);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'hoi4.tech_inspect', arguments: { mode: 'trace' } },
      })}\n`,
    );
    const failure = await waitForMessage(child, 2, stdoutLines);
    expect(failure).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { isError: true, content: expect.any(Array) },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`,
    );
    const followup = await waitForMessage(child, 3, stdoutLines);
    expect(followup).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: { tools: expect.any(Array) },
    });
    await stop(child);
  }, 20_000);

  it('negotiates SDK-supported revisions and falls back to the latest for unknown ones', async () => {
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
      const expected = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      expect(response).toMatchObject({
        result: {
          protocolVersion: expected,
        },
      });
      await stop(child);
    }
  }, 120_000);
});
