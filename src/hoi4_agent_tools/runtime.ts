import path from 'node:path';
import { homedir } from 'node:os';
import { loadConfiguration } from './core/configuration.js';
import { CoreEngine } from './core/engine.js';
import { ServiceError } from './core/result.js';
import { WorkspaceResolver } from './core/workspace.js';

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

export async function createEngine(configPath = configurationPath()): Promise<CoreEngine> {
  const configuration = await loadConfiguration(configPath);
  const resolver = await WorkspaceResolver.create(configuration);
  const engine = new CoreEngine(resolver);
  await engine.initialize();
  return engine;
}
