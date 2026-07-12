#!/usr/bin/env node
import { access, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { compareCodeUnits, canonicalJson } from '../hoi4_agent_tools/core/canonical.js';
import { loadConfiguration } from '../hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../hoi4_agent_tools/core/engine.js';
import { WorkspaceResolver } from '../hoi4_agent_tools/core/workspace.js';
import { configurationPath } from '../hoi4_agent_tools/runtime.js';
import { PACKAGE_VERSION } from '../hoi4_agent_tools/version.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage(): string {
  return `HOI4 Agent Tools setup utility

Usage:
  hoi4-agent-tools-setup --init-config PATH [--workspace ROOT] [--workspace-id ID] [--workspace-name NAME] [--game ROOT] [--autonomous-writes --server-state ROOT]
  hoi4-agent-tools-setup --init-config PATH [--workspace ROOT] [--reviewed-writes --server-state ROOT]
  hoi4-agent-tools-setup --discover
  hoi4-agent-tools-setup --diagnose [--config PATH]
  hoi4-agent-tools-setup --print-client-config [--config PATH]

The legacy --enable-writes flag is an alias for --reviewed-writes.
This utility writes only the explicitly requested server config. It never edits an MCP client's settings.`;
}

async function discover(): Promise<void> {
  const home = homedir();
  const candidates = new Set<string>([
    ...(process.env.HOI4_GAME_ROOT === undefined ? [] : [process.env.HOI4_GAME_ROOT]),
    ...(process.env.HOI4_MOD_ROOTS ?? '').split(path.delimiter).filter(Boolean),
    path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Steam',
      'steamapps',
      'common',
      'Hearts of Iron IV',
    ),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Hearts of Iron IV'),
    path.join(home, '.steam', 'steam', 'steamapps', 'common', 'Hearts of Iron IV'),
    path.join(
      home,
      'Library',
      'Application Support',
      'Steam',
      'steamapps',
      'common',
      'Hearts of Iron IV',
    ),
  ]);
  const existing = new Set<string>();
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isDirectory()) continue;
      existing.add(await realpath(candidate));
    } catch {
      // Discovery reports only verified paths and never creates or edits them.
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'ok',
        candidates: [...existing].sort((left, right) => compareCodeUnits(left, right)),
        note: 'Review a candidate and pass it explicitly to --game or --workspace; discovery changes nothing.',
      },
      null,
      2,
    )}\n`,
  );
}

async function initializeConfig(target: string): Promise<void> {
  const workspaceRoot = argument('--workspace');
  const gameRoot = argument('--game');
  const requestedWorkspaceId = argument('--workspace-id');
  const requestedWorkspaceName = argument('--workspace-name');
  const autonomousWrites = process.argv.includes('--autonomous-writes');
  const reviewedWrites =
    process.argv.includes('--reviewed-writes') || process.argv.includes('--enable-writes');
  if (autonomousWrites && reviewedWrites) {
    throw new Error(
      '--autonomous-writes and --reviewed-writes/--enable-writes are mutually exclusive',
    );
  }
  const writeEnabled = autonomousWrites || reviewedWrites;
  const requestedServerStateRoot = argument('--server-state');
  if (
    process.argv.includes('--server-state') &&
    (requestedServerStateRoot === undefined || requestedServerStateRoot.startsWith('--'))
  ) {
    throw new Error('--server-state requires a directory path');
  }
  if (writeEnabled && requestedServerStateRoot === undefined) {
    throw new Error('Write-enabled setup requires an explicit --server-state ROOT');
  }
  for (const [flag, value] of [
    ['--workspace-id', requestedWorkspaceId],
    ['--workspace-name', requestedWorkspaceName],
  ] as const) {
    if (process.argv.includes(flag) && (value === undefined || value.startsWith('--'))) {
      throw new Error(`${flag} requires a value`);
    }
  }
  if (
    workspaceRoot === undefined &&
    (requestedWorkspaceId !== undefined || requestedWorkspaceName !== undefined)
  ) {
    throw new Error('--workspace-id and --workspace-name require --workspace ROOT');
  }
  const workspaceId = requestedWorkspaceId ?? 'mod';
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(workspaceId)) {
    throw new Error('--workspace-id must match [a-z][a-z0-9_-]{0,63}');
  }
  const workspaceName =
    requestedWorkspaceName ?? (workspaceRoot === undefined ? '' : path.basename(workspaceRoot));
  if (workspaceRoot !== undefined && (workspaceName.length < 1 || workspaceName.length > 200)) {
    throw new Error('--workspace-name must contain 1 through 200 characters');
  }
  const registrationRoots =
    workspaceRoot === undefined ? [] : [path.dirname(path.resolve(workspaceRoot))];
  const workspaces =
    workspaceRoot === undefined
      ? []
      : [
          {
            id: workspaceId,
            name: workspaceName,
            root: path.resolve(workspaceRoot),
            ...(gameRoot === undefined ? {} : { gameRoot: path.resolve(gameRoot) }),
            writeEnabled,
          },
        ];
  const config = {
    version: 1,
    writePolicy: autonomousWrites ? 'autonomous' : reviewedWrites ? 'transactions' : 'read-only',
    ...(requestedServerStateRoot === undefined
      ? {}
      : { serverStateRoot: path.resolve(requestedServerStateRoot) }),
    registrationRoots,
    writableRegistrationRoots: [],
    workspaces,
    http: {
      host: '127.0.0.1',
      port: 3210,
      allowedOrigins: [],
      tokens: [],
      principals: [],
    },
  };
  const absolute = path.resolve(target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${absolute}\n`);
}

async function diagnose(configPath: string): Promise<void> {
  const configuration = await loadConfiguration(configPath);
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  const serverState = resolver.serverState();
  if (serverState !== undefined) {
    await access(serverState.root, constants.R_OK | constants.W_OK);
  }
  const rendering = await sharp({
    create: { width: 1, height: 1, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer();
  const workspaces = [];
  for (const workspace of resolver.list()) {
    const permissions = [];
    for (const root of workspace.roots) {
      const requiresWrite =
        root.kind === 'artifact' ||
        root.kind === 'cache' ||
        (root.kind === 'mod' && workspace.writeEnabled);
      await access(root.path, constants.R_OK | (requiresWrite ? constants.W_OK : 0));
      permissions.push({ rootKind: root.kind, readable: true, writable: requiresWrite });
    }
    workspaces.push({ ...engine.status(workspace.id), permissions });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'ok',
        version: PACKAGE_VERSION,
        node: process.version,
        sharp: sharp.versions,
        renderingProbeBytes: rendering.length,
        config: path.resolve(configPath),
        ...(serverState === undefined
          ? {}
          : { serverState: { root: serverState.root, readable: true, writable: true } }),
        workspaces,
      },
      null,
      2,
    )}\n`,
  );
}

function printClientConfig(configPath: string): void {
  const absolute = path.resolve(configPath);
  const windows = process.platform === 'win32';
  const command = windows ? 'npx.cmd' : 'npx';
  const common = {
    command,
    args: ['-y', `hoi4-agent-tools@${PACKAGE_VERSION}`],
    env: { HOI4_AGENT_CONFIG: absolute },
  };
  const installedCommand = windows ? 'hoi4-agent-tools.cmd' : 'hoi4-agent-tools';
  const installed = {
    command: installedCommand,
    args: [],
    env: { HOI4_AGENT_CONFIG: absolute },
  };
  process.stdout.write(
    `${JSON.stringify(
      {
        note: 'Review and paste one example into your MCP client; this utility does not edit client settings.',
        generic: { mcpServers: { hoi4_agent_tools: common } },
        globalInstall: { mcpServers: { hoi4_agent_tools: installed } },
        codexToml: `[mcp_servers.hoi4_agent_tools]\ncommand = "${command}"\nargs = ["-y", "hoi4-agent-tools@${PACKAGE_VERSION}"]\nenv = { HOI4_AGENT_CONFIG = ${JSON.stringify(absolute)} }`,
        codexTomlGlobal: `[mcp_servers.hoi4_agent_tools]\ncommand = "${installedCommand}"\nenv = { HOI4_AGENT_CONFIG = ${JSON.stringify(absolute)} }`,
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.length <= 2) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const init = argument('--init-config');
  if (init !== undefined) {
    await initializeConfig(init);
    return;
  }
  if (process.argv.includes('--discover')) {
    await discover();
    return;
  }
  const config = configurationPath(process.argv.slice(2));
  if (process.argv.includes('--diagnose')) {
    await diagnose(config);
    return;
  }
  if (process.argv.includes('--print-client-config')) {
    printClientConfig(config);
    return;
  }
  throw new Error('Unknown setup operation. Use --help.');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${canonicalJson({
      level: 'error',
      event: 'setup_failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
