import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  PACKAGE_BIN_TARGETS,
  buildPackAndInstall,
  packagedWorkspaceLeaks,
  runCommand,
  type InstalledPackageFixture,
} from '../../scripts/distribution/package-fixture.js';
import { qualifyInstalledHttpBinary } from '../../scripts/distribution/installed-http-qualification.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const expectedToolNames = [
  'hoi4.focus_inspect',
  'hoi4.focus_render',
  'hoi4.focus_raster',
  'hoi4.focus_rewrite',
  'hoi4.gui_inspect',
  'hoi4.gui_render',
  'hoi4.gui_rewrite',
  'hoi4.map_inspect',
  'hoi4.map_render',
  'hoi4.map_rewrite',
  'hoi4.event_inspect',
  'hoi4.event_render',
  'hoi4.event_compare',
];
const httpOrigin = 'https://package-install.example.test';
const httpToken = 'package-install-http-token-that-is-longer-than-thirty-two-characters';

let fixture: InstalledPackageFixture;
let temporaryRoot = '';
let setupServerStateRoot = '';

function isolatedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...extra };
  delete environment.NODE_PATH;
  return environment;
}

async function waitForJsonRpcResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  stdoutLines: string[],
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let pending = '';
    const timeout = setTimeout(() => {
      child.stdout.off('data', consume);
      reject(new Error(`Timed out waiting for installed stdio response ${id}`));
    }, 15_000);
    const consume = (chunk: Buffer): void => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length === 0) continue;
        stdoutLines.push(line);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
          clearTimeout(timeout);
          child.stdout.off('data', consume);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (message.id === id) {
          clearTimeout(timeout);
          child.stdout.off('data', consume);
          resolve(message);
          return;
        }
      }
    };
    child.stdout.on('data', consume);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      child.stdout.off('data', consume);
      reject(
        new Error(`Installed stdio server exited before response ${id}: ${code}\n${stderr()}`),
      );
    });
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hoi4-package-install-'));
  fixture = await buildPackAndInstall(projectRoot, temporaryRoot);
}, 180_000);

afterAll(async () => {
  if (temporaryRoot !== '') await rm(temporaryRoot, { recursive: true, force: true });
  if (setupServerStateRoot !== '') {
    await rm(setupServerStateRoot, { recursive: true, force: true });
  }
});

describe('clean npm-pack installation', () => {
  it('installs only the executable public payload with synchronized metadata', async () => {
    const sourcePackage = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    const installedPackage = JSON.parse(
      await readFile(path.join(fixture.installedPackageRoot, 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    const installedServer = JSON.parse(
      await readFile(path.join(fixture.installedPackageRoot, 'server.json'), 'utf8'),
    ) as { packages: { version: string }[]; version: string };

    expect(fixture.pack.name).toBe(sourcePackage.name);
    expect(fixture.pack.version).toBe(sourcePackage.version);
    expect(installedPackage).toMatchObject(sourcePackage);
    expect(installedServer.version).toBe(sourcePackage.version);
    expect(installedServer.packages).toContainEqual(
      expect.objectContaining({ version: sourcePackage.version }),
    );
    expect(await packagedWorkspaceLeaks(fixture.installedPackageRoot, projectRoot)).toEqual([]);

    expect(fixture.pack.files.some(({ path: filePath }) => filePath.startsWith('schemas/'))).toBe(
      false,
    );
  });

  it('does not expose an SDK or generated schema subpath outside the MCP bins', async () => {
    const installedPackage = JSON.parse(
      await readFile(path.join(fixture.installedPackageRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(installedPackage).not.toHaveProperty('exports');
    expect(fixture.pack.files.map(({ path: filePath }) => filePath)).not.toContain('dist/index.js');
  });

  it('ships runnable setup and HTTP bins plus all npm bin shims', async () => {
    expect(Object.keys(fixture.binEntries).sort()).toEqual(Object.keys(PACKAGE_BIN_TARGETS).sort());
    const setup = await runCommand(
      process.execPath,
      [fixture.binEntries['hoi4-agent-tools-setup'], '--help'],
      { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
    );
    expect(setup.stdout).toContain('HOI4 Agent Tools setup utility');

    const discoveredGame = path.join(temporaryRoot, 'discovered-game');
    const discoveredMod = path.join(temporaryRoot, 'discovered-mod');
    const nonDirectory = path.join(temporaryRoot, 'not-a-workspace.txt');
    await Promise.all([
      mkdir(discoveredGame),
      mkdir(discoveredMod),
      writeFile(nonDirectory, 'unchanged\n', 'utf8'),
    ]);
    const discovery = await runCommand(
      process.execPath,
      [fixture.binEntries['hoi4-agent-tools-setup'], '--discover'],
      {
        cwd: fixture.consumerRoot,
        env: isolatedEnvironment({
          HOI4_GAME_ROOT: discoveredGame,
          HOI4_MOD_ROOTS: [discoveredMod, discoveredGame, nonDirectory].join(path.delimiter),
          'ProgramFiles(x86)': path.join(temporaryRoot, 'missing-program-files'),
        }),
      },
    );
    const discoveryResult = JSON.parse(discovery.stdout) as {
      gameRoots: string[];
      modRoots: string[];
    };
    expect(discoveryResult.gameRoots).toEqual(
      [...discoveryResult.gameRoots].sort(compareCodeUnits),
    );
    expect(discoveryResult.modRoots).toEqual([...discoveryResult.modRoots].sort(compareCodeUnits));
    expect(discoveryResult.gameRoots).toContain(await realpath(discoveredGame));
    expect(discoveryResult.modRoots).toContain(await realpath(discoveredMod));
    expect(discoveryResult.modRoots).not.toContain(await realpath(nonDirectory));
    expect(await readFile(nonDirectory, 'utf8')).toBe('unchanged\n');

    const setupModRoot = path.join(temporaryRoot, 'setup-mods');
    const setupWorkspace = path.join(setupModRoot, 'setup-workspace');
    const secondWorkspace = path.join(setupModRoot, 'second-workspace');
    const setupLocalAppData = path.join(temporaryRoot, 'setup-local-app-data');
    const setupStorageRoot = path.join(setupLocalAppData, 'hoi4-agent-tools', 'workspaces');
    const setupConfig = path.join(temporaryRoot, 'setup-config.json');
    setupServerStateRoot = path.join(setupLocalAppData, 'hoi4-agent-tools', 'state');
    const setupEnvironment = isolatedEnvironment({
      LOCALAPPDATA: setupLocalAppData,
    });
    delete setupEnvironment.XDG_CONFIG_HOME;
    delete setupEnvironment.XDG_DATA_HOME;
    delete setupEnvironment.XDG_STATE_HOME;
    await Promise.all([
      mkdir(setupWorkspace, { recursive: true }),
      mkdir(secondWorkspace, { recursive: true }),
    ]);
    await runCommand(
      process.execPath,
      [
        fixture.binEntries['hoi4-agent-tools-setup'],
        '--init',
        '--config',
        setupConfig,
        '--mod-root',
        setupModRoot,
        '--game-root',
        discoveredGame,
      ],
      { cwd: fixture.consumerRoot, env: setupEnvironment },
    );
    const generatedConfig = JSON.parse(await readFile(setupConfig, 'utf8')) as {
      gameRoot: string;
      modRoots: string[];
      serverStateRoot: string;
      workspaceStorageRoot: string;
    };
    expect(generatedConfig).toMatchObject({
      serverStateRoot: setupServerStateRoot,
      modRoots: [await realpath(setupModRoot)],
      gameRoot: await realpath(discoveredGame),
      workspaceStorageRoot: await realpath(setupStorageRoot),
    });
    expect(await realpath(path.dirname(generatedConfig.serverStateRoot))).toBe(
      await realpath(path.dirname(generatedConfig.workspaceStorageRoot)),
    );
    expect(generatedConfig).not.toHaveProperty('writePolicy');
    expect(generatedConfig).not.toHaveProperty('workspaces');
    await expect(
      runCommand(
        process.execPath,
        [
          fixture.binEntries['hoi4-agent-tools-setup'],
          '--init',
          '--config',
          setupConfig,
          '--mod-root',
          setupModRoot,
        ],
        { cwd: fixture.consumerRoot, env: setupEnvironment },
      ),
    ).rejects.toThrow();
    const diagnosis = await runCommand(
      process.execPath,
      [fixture.binEntries['hoi4-agent-tools-setup'], '--diagnose', '--config', setupConfig],
      { cwd: fixture.consumerRoot, env: setupEnvironment },
    );
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: 'ok',
      version: fixture.pack.version,
      serverState: { root: await realpath(setupServerStateRoot) },
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          permissions: expect.arrayContaining([
            { rootKind: 'mod', readable: true, writable: true },
            { rootKind: 'artifact', readable: true, writable: true },
            { rootKind: 'cache', readable: true, writable: true },
          ]),
        }),
      ]),
    });
    await expect(
      runCommand(
        process.execPath,
        [fixture.binEntries['hoi4-agent-tools-setup'], '--init-config', setupConfig],
        { cwd: fixture.consumerRoot, env: setupEnvironment },
      ),
    ).rejects.toThrow();
    const clientConfig = await runCommand(
      process.execPath,
      [
        fixture.binEntries['hoi4-agent-tools-setup'],
        '--print-client-config',
        '--config',
        setupConfig,
      ],
      { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
    );
    expect(JSON.parse(clientConfig.stdout)).toMatchObject({
      generic: { mcpServers: { hoi4_agent_tools: { env: { HOI4_AGENT_CONFIG: setupConfig } } } },
      globalInstall: {
        mcpServers: { hoi4_agent_tools: { env: { HOI4_AGENT_CONFIG: setupConfig } } },
      },
    });
    const defaultClientConfig = await runCommand(
      process.execPath,
      [fixture.binEntries['hoi4-agent-tools-setup'], '--print-client-config'],
      {
        cwd: fixture.consumerRoot,
        env: isolatedEnvironment({ APPDATA: path.join(temporaryRoot, 'default-config-root') }),
      },
    );
    const defaultClient = JSON.parse(defaultClientConfig.stdout) as {
      codexToml: string;
      generic: { mcpServers: { hoi4_agent_tools: Record<string, unknown> } };
    };
    expect(defaultClient.generic.mcpServers.hoi4_agent_tools).not.toHaveProperty('env');
    expect(defaultClient.codexToml).not.toContain('HOI4_AGENT_CONFIG');
  });

  it('qualifies authenticated Streamable HTTP through the installed package binary', async () => {
    const workspace = path.join(temporaryRoot, 'http-workspace');
    const focusRelativePath = 'common/national_focus/http_fixture.txt';
    await mkdir(path.join(workspace, 'common', 'national_focus'), { recursive: true });
    await writeFile(
      path.join(workspace, focusRelativePath),
      'focus_tree = { id = http_fixture focus = { id = http_root x = 0 y = 0 cost = 10 } }\n',
    );
    const configPath = path.join(temporaryRoot, 'http-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 1,
        serverStateRoot: path.join(temporaryRoot, 'http-state'),
        workspaces: [{ id: 'fixture', name: 'Fixture', root: workspace }],
        http: {
          host: '127.0.0.1',
          port: 0,
          allowedOrigins: [httpOrigin],
          tokens: [
            {
              principal: 'package-test',
              tokenEnv: 'PACKAGE_ACCEPTANCE_TOKEN',
              workspaceIds: ['fixture'],
            },
          ],
        },
      })}\n`,
    );

    const qualified = await qualifyInstalledHttpBinary({
      cwd: fixture.consumerRoot,
      entryPath: fixture.binEntries['hoi4-agent-tools-http'],
      environment: isolatedEnvironment({
        HOI4_AGENT_CONFIG: configPath,
        PACKAGE_ACCEPTANCE_TOKEN: httpToken,
      }),
      expectedServerName: fixture.pack.name,
      expectedServerVersion: fixture.pack.version,
      focusRelativePath,
      origin: httpOrigin,
      token: httpToken,
      workspaceId: 'fixture',
    });

    expect(qualified.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(qualified.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(qualified.toolNames).toEqual(expectedToolNames);
    expect(qualified.resourceUris).toEqual([]);
    expect(qualified.resourceTemplateUris).toEqual([
      'hoi4-agent://workspace/{workspaceId}/artifact/{sha256}/{provenanceHash}/{name}',
    ]);
    expect(qualified.resourceMimeType).toBe('application/json');
    expect(qualified.boundedArtifactBytes).toBe(64);
    expect(qualified.promptNames).toEqual([]);
    expect(qualified.progress).toEqual([0, 2, 3]);
    expect(qualified.cancellationObserved).toBe(true);
    expect(qualified.initializedStatus).toBe(202);
    expect(qualified.deleteStatus).toBe(200);
  });

  it('answers MCP initialize and tools/list over the installed stdio bin', async () => {
    const workspace = path.join(temporaryRoot, 'stdio-workspace');
    await mkdir(workspace);
    const configPath = path.join(temporaryRoot, 'stdio-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 1,
        serverStateRoot: path.join(temporaryRoot, 'stdio-state'),
        workspaces: [{ id: 'fixture', name: 'Fixture', root: workspace }],
      })}\n`,
    );
    const child = spawn(process.execPath, [fixture.binEntries['hoi4-agent-tools']], {
      cwd: fixture.consumerRoot,
      env: isolatedEnvironment({ HOI4_AGENT_CONFIG: configPath }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
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
          clientInfo: { name: 'package-install-test', version: '1.0.0' },
        },
      })}\n`,
    );
    const initialized = await waitForJsonRpcResponse(child, 1, stdoutLines, () => stderr);
    expect(initialized).toMatchObject({
      jsonrpc: '2.0',
      result: {
        serverInfo: { name: fixture.pack.name, version: fixture.pack.version },
      },
    });
    const instructions = (initialized.result as { instructions?: string }).instructions ?? '';
    expect(instructions).toContain('hoi4.event_inspect');
    expect(instructions).toContain('Event tools are read-only');
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    const listed = await waitForJsonRpcResponse(child, 2, stdoutLines, () => stderr);
    const tools = (listed.result as { tools: { name: string }[] }).tools.map(({ name }) => name);
    expect(tools).toEqual(expectedToolNames);
    expect(
      stdoutLines.every((line) => (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === '2.0'),
    ).toBe(true);
    expect(stderr).not.toContain('"jsonrpc"');
    await stop(child);
  });
});
