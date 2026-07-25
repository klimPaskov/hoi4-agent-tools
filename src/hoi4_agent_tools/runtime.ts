import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  loadConfiguration,
  serverConfigurationSchema,
  type ServerConfiguration,
} from './core/configuration.js';
import { CoreEngine } from './core/engine.js';
import { ServiceError } from './core/result.js';
import { WorkspaceResolver } from './core/workspace.js';
import { CONFIG_VERSION } from './version.js';

export function defaultConfigurationPath(): string {
  const configRoot =
    process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(configRoot, 'hoi4-agent-tools', 'config.json');
}

export function configurationPath(arguments_: readonly string[] = process.argv.slice(2)): string {
  const index = arguments_.indexOf('--config');
  if (index >= 0) {
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ServiceError('CONFIG_ARGUMENT_MISSING', '--config requires a file path');
    }
    return path.resolve(value);
  }
  if (process.env.HOI4_AGENT_CONFIG !== undefined)
    return path.resolve(process.env.HOI4_AGENT_CONFIG);
  return defaultConfigurationPath();
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Standard content directories that can be the only content in a valid local
 * mod. Keep this list limited to HOI4 roots so an arbitrary project directory
 * is not mistaken for a mod just because it contains a generic `common`
 * folder.
 */
const MOD_CONTENT_DIRECTORIES = [
  'events',
  'gfx',
  'history',
  'interface',
  'localisation',
  'localisation_synced',
  'map',
  'music',
  'portraits',
  'sound',
] as const;

const MOD_CONTENT_EXTENSIONS: Readonly<
  Record<(typeof MOD_CONTENT_DIRECTORIES)[number], readonly string[]>
> = {
  events: ['.txt'],
  gfx: ['.dds', '.gfx', '.png', '.tga'],
  history: ['.txt'],
  interface: ['.gfx', '.gui', '.txt'],
  localisation: ['.yml', '.yaml'],
  localisation_synced: ['.yml', '.yaml'],
  map: ['.bmp', '.csv', '.map', '.txt'],
  music: ['.asset', '.ogg', '.txt', '.wav'],
  portraits: ['.dds', '.jpg', '.jpeg', '.png', '.tga'],
  sound: ['.asset', '.ogg', '.txt', '.wav'],
};

const MOD_COMMON_DIRECTORIES = [
  'abilities',
  'ai_focuses',
  'ai_strategy',
  'ai_strategy_plans',
  'bop',
  'buildings',
  'characters',
  'continuous_focus',
  'decisions',
  'doctrines',
  'ideas',
  'mtth',
  'national_focus',
  'on_actions',
  'operations',
  'raids',
  'resistance_compliance_modifiers',
  'script_constants',
  'scripted_effects',
  'scripted_guis',
  'scripted_triggers',
  'special_projects',
  'technology_sharing',
  'technologies',
  'technology_tags',
  'units',
  'unit_tags',
] as const;

async function hasEntries(candidate: string, extensions?: readonly string[]): Promise<boolean> {
  try {
    const entries = await readdir(candidate, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isFile() &&
        (extensions === undefined ||
          extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))),
    );
  } catch {
    return false;
  }
}

async function isRealDirectory(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isLikelyGameRoot(candidate: string): Promise<boolean> {
  // Vanilla installations have an executable or launcher marker that a mod
  // root should never contain. The marker check also protects a nested cwd
  // such as `<game>/common` when the server is started from there.
  return (
    (await isFile(path.join(candidate, 'hoi4.exe'))) ||
    (await isFile(path.join(candidate, 'run_hoi4'))) ||
    (await isFile(path.join(candidate, 'steam_appid.txt')))
  );
}

async function isLikelyModRoot(candidate: string): Promise<boolean> {
  if (await isFile(path.join(candidate, 'descriptor.mod'))) return true;
  if (await isLikelyGameRoot(candidate)) return false;
  for (const directory of MOD_COMMON_DIRECTORIES) {
    if (await isRealDirectory(path.join(candidate, 'common', directory))) return true;
  }
  if (await isFile(path.join(candidate, 'common', 'combat_tactics.txt'))) return true;
  for (const directory of MOD_CONTENT_DIRECTORIES) {
    if (
      (await isRealDirectory(path.join(candidate, directory))) &&
      (await hasEntries(path.join(candidate, directory), MOD_CONTENT_EXTENSIONS[directory]))
    )
      return true;
  }
  return false;
}

async function findCurrentModRoot(start = process.cwd()): Promise<string> {
  for (let cursor = path.resolve(start); ;) {
    if (await isLikelyGameRoot(cursor)) break;
    if (await isLikelyModRoot(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new ServiceError(
    'AUTO_MOD_ROOT_NOT_FOUND',
    'Start the MCP from inside a Hearts of Iron IV mod or configure a server workspace',
    { currentDirectory: path.resolve(start) },
  );
}

async function firstExistingDirectory(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

function automaticGameRootCandidates(): string[] {
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

function automaticStorageRoots(): { serverStateRoot: string; workspaceStorageRoot: string } {
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

function automaticWorkspaceId(modRoot: string): string {
  const slug = path
    .basename(modRoot)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 48);
  return `auto_${slug.length === 0 ? 'mod' : slug}`;
}

/** Build an in-memory configuration when a local agent starts inside a mod. */
export async function automaticConfiguration(start = process.cwd()): Promise<ServerConfiguration> {
  const modRoot = await findCurrentModRoot(start);
  const gameRoot = await firstExistingDirectory(automaticGameRootCandidates());
  const storage = automaticStorageRoots();
  return serverConfigurationSchema.parse({
    version: CONFIG_VERSION,
    serverStateRoot: storage.serverStateRoot,
    workspaceStorageRoot: storage.workspaceStorageRoot,
    ...(gameRoot === undefined ? {} : { gameRoot }),
    workspaces: [
      {
        id: automaticWorkspaceId(modRoot),
        name: path.basename(modRoot),
        root: modRoot,
      },
    ],
  });
}

async function configurationExists(configPath: string): Promise<boolean> {
  try {
    return (await stat(configPath)).isFile();
  } catch {
    return false;
  }
}

export async function createEngine(configPath = configurationPath()): Promise<CoreEngine> {
  let configuration: ServerConfiguration;
  try {
    configuration = await loadConfiguration(configPath);
  } catch (error) {
    const useAutomaticConfiguration =
      configPath === defaultConfigurationPath() &&
      process.env.HOI4_AGENT_CONFIG === undefined &&
      error instanceof ServiceError &&
      error.code === 'CONFIG_READ_FAILED' &&
      !(await configurationExists(configPath));
    if (!useAutomaticConfiguration) throw error;
    configuration = await automaticConfiguration();
  }
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  await engine.initialize();
  return engine;
}
