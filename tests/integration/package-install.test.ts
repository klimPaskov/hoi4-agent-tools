import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  GENERATED_SCHEMA_FILES,
  PACKAGE_BIN_TARGETS,
  buildPackAndInstall,
  packagedWorkspaceLeaks,
  runCommand,
  type InstalledPackageFixture,
} from '../../scripts/distribution/package-fixture.js';
import { qualifyInstalledHttpBinary } from '../../scripts/distribution/installed-http-qualification.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const expectedToolNames = [
  'hoi4.project_register',
  'hoi4.project_scan',
  'hoi4.project_status',
  'hoi4.focus_scan',
  'hoi4.gui_scan',
  'hoi4.transaction_apply',
  'hoi4.artifact_list',
];
const expectedPromptNames = [
  'hoi4.safe-focus-workflow',
  'hoi4.safe-gui-workflow',
  'hoi4.safe-map-workflow',
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
  it('installs only the public payload with generated schemas and synchronized metadata', async () => {
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

    for (const fileName of GENERATED_SCHEMA_FILES) {
      const schema = JSON.parse(
        await readFile(path.join(fixture.installedPackageRoot, 'schemas', fileName), 'utf8'),
      ) as { $id: string };
      expect(schema.$id).toContain(`/v${sourcePackage.version}/schemas/${fileName}`);
    }
  });

  it('resolves the public module and schema exports from the isolated consumer', async () => {
    const probePath = path.join(fixture.consumerRoot, 'export-probe.mjs');
    await writeFile(
      probePath,
      `import { readFile } from 'node:fs/promises';
import { PACKAGE_NAME, PACKAGE_VERSION } from 'hoi4-agent-tools';
const schemaSpecifiers = ${JSON.stringify(
        GENERATED_SCHEMA_FILES.map((name) => `hoi4-agent-tools/schemas/${name}`),
      )};
const schemaIds = [];
for (const specifier of schemaSpecifiers) {
  const schema = JSON.parse(await readFile(new URL(import.meta.resolve(specifier)), 'utf8'));
  schemaIds.push(schema.$id);
}
process.stdout.write(JSON.stringify({ PACKAGE_NAME, PACKAGE_VERSION, schemaIds }));
`,
    );
    const probe = await runCommand(process.execPath, [probePath], {
      cwd: fixture.consumerRoot,
      env: isolatedEnvironment(),
    });
    const result = JSON.parse(probe.stdout) as {
      PACKAGE_NAME: string;
      PACKAGE_VERSION: string;
      schemaIds: string[];
    };
    expect(result.PACKAGE_NAME).toBe(fixture.pack.name);
    expect(result.PACKAGE_VERSION).toBe(fixture.pack.version);
    expect(result.schemaIds).toHaveLength(GENERATED_SCHEMA_FILES.length);
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
    const discoveryResult = JSON.parse(discovery.stdout) as { candidates: string[] };
    expect(discoveryResult.candidates).toEqual(
      [...discoveryResult.candidates].sort(compareCodeUnits),
    );
    expect(new Set(discoveryResult.candidates).size).toBe(discoveryResult.candidates.length);
    expect(discoveryResult.candidates).toEqual(
      expect.arrayContaining(
        await Promise.all([realpath(discoveredGame), realpath(discoveredMod)]),
      ),
    );
    expect(discoveryResult.candidates).not.toContain(await realpath(nonDirectory));
    expect(await readFile(nonDirectory, 'utf8')).toBe('unchanged\n');

    const setupWorkspace = path.join(temporaryRoot, 'setup-workspace');
    const setupConfig = path.join(temporaryRoot, 'setup-config.json');
    await mkdir(setupWorkspace);
    await runCommand(
      process.execPath,
      [
        fixture.binEntries['hoi4-agent-tools-setup'],
        '--init-config',
        setupConfig,
        '--workspace',
        setupWorkspace,
      ],
      { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
    );
    const generatedConfig = JSON.parse(await readFile(setupConfig, 'utf8')) as {
      writePolicy: string;
      workspaces: { root: string; writeEnabled: boolean }[];
    };
    expect(generatedConfig).toMatchObject({
      writePolicy: 'read-only',
      workspaces: [{ root: path.resolve(setupWorkspace), writeEnabled: false }],
    });
    await expect(
      runCommand(
        process.execPath,
        [
          fixture.binEntries['hoi4-agent-tools-setup'],
          '--init-config',
          setupConfig,
          '--workspace',
          setupWorkspace,
        ],
        { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
      ),
    ).rejects.toThrow();
    const diagnosis = await runCommand(
      process.execPath,
      [fixture.binEntries['hoi4-agent-tools-setup'], '--diagnose', '--config', setupConfig],
      { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
    );
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: 'ok',
      version: fixture.pack.version,
      workspaces: [
        {
          permissions: expect.arrayContaining([
            { rootKind: 'mod', readable: true, writable: false },
            { rootKind: 'artifact', readable: true, writable: true },
            { rootKind: 'cache', readable: true, writable: true },
          ]),
        },
      ],
    });

    const writeSetupConfig = path.join(temporaryRoot, 'setup-write-config.json');
    setupServerStateRoot = path.join(
      tmpdir(),
      `hoi4-package-state-${path.basename(temporaryRoot)}`,
    );
    await runCommand(
      process.execPath,
      [
        fixture.binEntries['hoi4-agent-tools-setup'],
        '--init-config',
        writeSetupConfig,
        '--workspace',
        setupWorkspace,
        '--enable-writes',
        '--server-state',
        setupServerStateRoot,
      ],
      { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
    );
    expect(JSON.parse(await readFile(writeSetupConfig, 'utf8'))).toMatchObject({
      writePolicy: 'transactions',
      serverStateRoot: path.resolve(setupServerStateRoot),
      workspaces: [{ writeEnabled: true }],
    });
    const writeDiagnosis = await runCommand(
      process.execPath,
      [fixture.binEntries['hoi4-agent-tools-setup'], '--diagnose', '--config', writeSetupConfig],
      { cwd: fixture.consumerRoot, env: isolatedEnvironment() },
    );
    expect(JSON.parse(writeDiagnosis.stdout)).toMatchObject({
      status: 'ok',
      serverState: {
        root: await realpath(setupServerStateRoot),
        readable: true,
        writable: true,
      },
    });
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
    });
  });

  it('qualifies authenticated Streamable HTTP through the installed package binary', async () => {
    const workspace = path.join(temporaryRoot, 'http-workspace');
    await mkdir(workspace);
    const configPath = path.join(temporaryRoot, 'http-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 1,
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
      expectedPromptNames,
      expectedResourceUri: 'hoi4-agent://schema/focus-plan',
      expectedServerName: fixture.pack.name,
      expectedServerVersion: fixture.pack.version,
      expectedToolNames,
      origin: httpOrigin,
      token: httpToken,
      workspaceId: 'fixture',
    });

    expect(qualified.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(qualified.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(qualified.toolNames).toEqual(expect.arrayContaining(expectedToolNames));
    expect(qualified.resourceUris).toContain('hoi4-agent://schema/focus-plan');
    expect(qualified.resourceMimeType).toBe('application/schema+json');
    expect(qualified.promptNames).toEqual(expect.arrayContaining(expectedPromptNames));
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
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    const listed = await waitForJsonRpcResponse(child, 2, stdoutLines, () => stderr);
    const tools = (listed.result as { tools: { name: string }[] }).tools.map(({ name }) => name);
    expect(tools).toEqual(expect.arrayContaining(expectedToolNames));
    expect(
      stdoutLines.every((line) => (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === '2.0'),
    ).toBe(true);
    expect(stderr).not.toContain('"jsonrpc"');
    await stop(child);
  });
});
