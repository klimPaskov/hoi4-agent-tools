import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CoreEngine } from '../core/engine.js';
import type { toolResult } from '../core/operation-result.js';
import type { OperationContext } from '../core/operation-context.js';
import type { ToolDefinition } from './server/task-tool-definition.js';
import type { ProgressReporter } from './server/progress.js';

/**
 * Plugins (maintainer decision M-14): a private extension adds its own tools to the stdio server.
 * The server loads a plugin only from a path its configuration lists, never from a mod folder or
 * from the environment, so a mod cannot make the server run its code. A tool name never starts
 * with `hoi4.`, which stays reserved for this package.
 */

export type PluginToolResult = Awaited<ReturnType<typeof toolResult>>;

export interface PluginTool {
  definition: ToolDefinition;
  /** The input has already passed `definition.inputSchema`. */
  call(input: unknown, progress: ProgressReporter): Promise<PluginToolResult>;
}

/** Builds the plugin's tools for one engine and request context. */
export type PluginToolFactory = (
  engine: CoreEngine,
  context: OperationContext,
) => readonly PluginTool[];

/** What the server gives a plugin when it loads it. */
export interface PluginHost {
  /** The package version of the server that loaded the plugin. */
  serverVersion: string;
  /**
   * Import a module of this package by its path under `hoi4_agent_tools/`, for example
   * `core/engine.js`. The plugin ships without a copy of the server and borrows its modules.
   */
  importServerModule(relativePath: string): Promise<Record<string, unknown>>;
  /**
   * A dependency of the server that tool schemas and images must share with it: `zod` (the
   * `zod/v4` module) or `sharp`.
   */
  dependency(name: 'zod' | 'sharp'): Promise<Record<string, unknown>>;
}

/** The default export of a plugin module. */
export type PluginModuleFactory = (
  host: PluginHost,
) => PluginToolFactory | Promise<PluginToolFactory>;

const PLUGIN_TOOL_NAME = /^(?!hoi4\.)[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,63}$/u;
const MAX_PLUGIN_TOOLS = 16;
const SERVER_MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export class PluginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

function sameFile(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}

function createHost(serverVersion: string): PluginHost {
  return {
    serverVersion,
    importServerModule: async (relativePath) => {
      const target = path.resolve(SERVER_MODULE_ROOT, relativePath);
      if (
        !target.startsWith(SERVER_MODULE_ROOT) ||
        !/\.(?:js|ts)$/u.test(target) ||
        relativePath.includes('..')
      )
        throw new PluginError('PLUGIN_IMPORT_REFUSED', `Not a server module: ${relativePath}`);
      return (await import(pathToFileURL(target).href)) as Record<string, unknown>;
    },
    dependency: async (name): Promise<Record<string, unknown>> =>
      name === 'zod' ? await import('zod/v4') : await import('sharp'),
  };
}

/**
 * Load every configured plugin. A listed file that does not exist is skipped, because a private
 * plugin lives on one machine and the shared configuration may list it on others; `onSkipped`
 * reports it. A file that exists and is not a plain `.mjs` or `.js` file, or that does not export
 * a factory, is an error.
 */
export async function loadPlugins(
  paths: readonly string[],
  serverVersion: string,
  onSkipped: (file: string, reason: string) => void = () => undefined,
): Promise<PluginToolFactory | undefined> {
  const factories: PluginToolFactory[] = [];
  for (const file of paths) {
    if (!path.isAbsolute(file) || !/\.(?:mjs|js)$/u.test(file))
      throw new PluginError(
        'PLUGIN_PATH_INVALID',
        'A plugin path is absolute and names a .mjs or .js file',
      );
    const info = await lstat(file).catch(() => undefined);
    if (info === undefined) {
      onSkipped(file, 'file not found');
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new PluginError('PLUGIN_PATH_INVALID', 'A plugin is a plain file, not a link');
    if (!sameFile(await realpath(file), file))
      throw new PluginError(
        'PLUGIN_PATH_INVALID',
        'A plugin path passes through a link or a short 8.3 name; list its full canonical path',
      );
    const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (typeof loaded.default !== 'function')
      throw new PluginError('PLUGIN_INVALID', 'A plugin exports a factory function as default');
    factories.push(await (loaded.default as PluginModuleFactory)(createHost(serverVersion)));
  }
  if (factories.length === 0) return undefined;
  return (engine, context) => {
    const tools = factories.flatMap((factory) => factory(engine, context));
    const seen = new Set<string>();
    if (tools.length > MAX_PLUGIN_TOOLS)
      throw new PluginError('PLUGIN_INVALID', `Plugins add at most ${MAX_PLUGIN_TOOLS} tools`);
    for (const { definition } of tools) {
      if (!PLUGIN_TOOL_NAME.test(definition.name))
        throw new PluginError(
          'PLUGIN_INVALID',
          `Plugin tool "${definition.name}" must be named <plugin>.<tool> and not start with hoi4.`,
        );
      if (seen.has(definition.name))
        throw new PluginError('PLUGIN_INVALID', `Two plugin tools are named ${definition.name}`);
      seen.add(definition.name);
    }
    return tools;
  };
}
