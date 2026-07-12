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
import { configurationPath, defaultConfigurationPath } from '../hoi4_agent_tools/runtime.js';
import { PACKAGE_VERSION } from '../hoi4_agent_tools/version.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function argumentsFor(name: string): string[] {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a path`);
    values.push(value);
    index += 1;
  }
  return values;
}

function assertKnownArguments(flags: readonly string[], valueFlags: readonly string[]): void {
  const known = new Set([...flags, ...valueFlags]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index]!;
    if (!known.has(value)) throw new Error(`Unknown setup option: ${value}`);
    if (valueFlags.includes(value)) {
      const argumentValue = process.argv[index + 1];
      if (argumentValue === undefined || argumentValue.startsWith('--')) {
        throw new Error(`${value} requires a path`);
      }
      index += 1;
    }
  }
}

function persistentRoots(): { serverStateRoot: string; workspaceStorageRoot: string } {
  const home = homedir();
  const dataRoot =
    process.env.XDG_DATA_HOME ?? process.env.LOCALAPPDATA ?? path.join(home, '.local', 'share');
  const stateRoot =
    process.env.XDG_STATE_HOME ?? process.env.LOCALAPPDATA ?? path.join(home, '.local', 'state');
  return {
    serverStateRoot: path.join(stateRoot, 'hoi4-agent-tools', 'state'),
    workspaceStorageRoot: path.join(dataRoot, 'hoi4-agent-tools', 'workspaces'),
  };
}

function standardModRootCandidates(): string[] {
  const home = homedir();
  const oneDriveRoots = [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    path.join(home, 'OneDrive'),
  ].filter((value): value is string => value !== undefined);
  return [
    ...(process.env.HOI4_MOD_ROOTS ?? '').split(path.delimiter).filter(Boolean),
    ...oneDriveRoots.map((root) =>
      path.join(root, 'Documents', 'Paradox Interactive', 'Hearts of Iron IV', 'mod'),
    ),
    path.join(home, 'Documents', 'Paradox Interactive', 'Hearts of Iron IV', 'mod'),
    path.join(home, '.local', 'share', 'Paradox Interactive', 'Hearts of Iron IV', 'mod'),
  ];
}

function standardGameRootCandidates(): string[] {
  const home = homedir();
  return [
    ...(process.env.HOI4_GAME_ROOT === undefined ? [] : [process.env.HOI4_GAME_ROOT]),
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
  ];
}

async function existingDirectories(candidates: readonly string[]): Promise<string[]> {
  const existing = new Set<string>();
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isDirectory()) continue;
      existing.add(await realpath(candidate));
    } catch {
      // Setup discovery is read-only and reports only verified directories.
    }
  }
  return [...existing].sort((left, right) => compareCodeUnits(left, right));
}

async function firstExistingDirectory(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isDirectory()) continue;
      return await realpath(candidate);
    } catch {
      // Continue through the ordered setup candidates.
    }
  }
  return undefined;
}

function usage(): string {
  return `HOI4 Agent Tools setup utility

Usage:
  hoi4-agent-tools-setup --init [--config PATH] [--mod-root PATH ...] [--game-root PATH] [--workspace-storage-root PATH]
  hoi4-agent-tools-setup --discover
  hoi4-agent-tools-setup --diagnose [--config PATH]
  hoi4-agent-tools-setup --print-client-config [--config PATH]

This utility writes only the explicitly requested server config. It never edits an MCP client's settings.`;
}

async function discover(): Promise<void> {
  const [modRoots, gameRoots] = await Promise.all([
    existingDirectories(standardModRootCandidates()),
    existingDirectories(standardGameRootCandidates()),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'ok',
        modRoots,
        gameRoots,
      },
      null,
      2,
    )}\n`,
  );
}

async function initializeConfig(target: string): Promise<void> {
  const absolute = path.resolve(target);
  try {
    await stat(absolute);
    throw new Error(`Configuration already exists: ${absolute}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const explicitModRoots = argumentsFor('--mod-root');
  const modRoots =
    explicitModRoots.length === 0
      ? await existingDirectories(standardModRootCandidates())
      : await existingDirectories(explicitModRoots.map((root) => path.resolve(root)));
  if (
    modRoots.length === 0 ||
    (modRoots.length !== explicitModRoots.length && explicitModRoots.length > 0)
  ) {
    throw new Error('Setup requires at least one existing mod-root directory');
  }
  const requestedGameRoot = argument('--game-root');
  if (
    process.argv.includes('--game-root') &&
    (requestedGameRoot === undefined || requestedGameRoot.startsWith('--'))
  ) {
    throw new Error('--game-root requires a path');
  }
  const gameRoot = await firstExistingDirectory(
    requestedGameRoot === undefined
      ? standardGameRootCandidates()
      : [path.resolve(requestedGameRoot)],
  );
  if (requestedGameRoot !== undefined && gameRoot === undefined) {
    throw new Error('--game-root must be an existing directory');
  }
  const persistent = persistentRoots();
  const requestedStorageRoot = argument('--workspace-storage-root');
  const storageRoot = path.resolve(requestedStorageRoot ?? persistent.workspaceStorageRoot);
  await mkdir(storageRoot, { recursive: true });
  const workspaceStorageRoot = await realpath(storageRoot);
  const config = {
    version: 1,
    serverStateRoot: persistent.serverStateRoot,
    modRoots,
    ...(gameRoot === undefined ? {} : { gameRoot }),
    workspaceStorageRoot,
  };
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
  const useDefaultConfiguration = absolute === path.resolve(defaultConfigurationPath());
  const windows = process.platform === 'win32';
  const command = windows ? 'npx.cmd' : 'npx';
  const common = {
    command,
    args: ['-y', `hoi4-agent-tools@${PACKAGE_VERSION}`],
    ...(useDefaultConfiguration ? {} : { env: { HOI4_AGENT_CONFIG: absolute } }),
  };
  const installedCommand = windows ? 'hoi4-agent-tools.cmd' : 'hoi4-agent-tools';
  const installed = {
    command: installedCommand,
    args: [],
    ...(useDefaultConfiguration ? {} : { env: { HOI4_AGENT_CONFIG: absolute } }),
  };
  const npxToml = `[mcp_servers.hoi4_agent_tools]\ncommand = "${command}"\nargs = ["-y", "hoi4-agent-tools@${PACKAGE_VERSION}"]${
    useDefaultConfiguration ? '' : `\nenv = { HOI4_AGENT_CONFIG = ${JSON.stringify(absolute)} }`
  }`;
  const globalToml = `[mcp_servers.hoi4_agent_tools]\ncommand = "${installedCommand}"${
    useDefaultConfiguration ? '' : `\nenv = { HOI4_AGENT_CONFIG = ${JSON.stringify(absolute)} }`
  }`;
  process.stdout.write(
    `${JSON.stringify(
      {
        note: 'Review and paste one example into your MCP client; this utility does not edit client settings.',
        generic: { mcpServers: { hoi4_agent_tools: common } },
        globalInstall: { mcpServers: { hoi4_agent_tools: installed } },
        codexToml: npxToml,
        codexTomlGlobal: globalToml,
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
  if (process.argv.includes('--init')) {
    assertKnownArguments(
      ['--init'],
      ['--config', '--mod-root', '--game-root', '--workspace-storage-root'],
    );
    const target = argument('--config') ?? defaultConfigurationPath();
    await initializeConfig(target);
    return;
  }
  if (process.argv.includes('--discover')) {
    assertKnownArguments(['--discover'], []);
    await discover();
    return;
  }
  const config = configurationPath(process.argv.slice(2));
  if (process.argv.includes('--diagnose')) {
    assertKnownArguments(['--diagnose'], ['--config']);
    await diagnose(config);
    return;
  }
  if (process.argv.includes('--print-client-config')) {
    assertKnownArguments(['--print-client-config'], ['--config']);
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
