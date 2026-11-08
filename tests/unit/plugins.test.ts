import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import type { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { loadPlugins, PluginError } from '../../src/hoi4_agent_tools/mcp/plugins.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const folder of cleanup.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  // The canonical path: a plugin path with a short 8.3 name would read as passing through a link.
  const made = await realpath(await mkdtemp(path.join(tmpdir(), 'hoi4-plugins-')));
  cleanup.push(made);
  return made;
}

/** A plugin whose factory returns tools with these names. */
async function plugin(directory: string, file: string, names: string[]): Promise<string> {
  const target = path.join(directory, file);
  await writeFile(
    target,
    `export default async function createPlugin(host) {
  const { z } = await host.dependency('zod');
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  return () => ${JSON.stringify(names)}.map((name) => ({
    definition: { name, title: name, description: name, inputSchema: z.object({}).strict(), annotations },
    call: async () => ({ content: [] }),
  }));
}
`,
  );
  return target;
}

const engine = {} as CoreEngine;

describe('plugin loading', () => {
  it('builds the tools of every listed plugin', async () => {
    const directory = await folder();
    const first = await plugin(directory, 'one.mjs', ['acme.one']);
    const second = await plugin(directory, 'two.mjs', ['acme.two', 'acme.three']);
    const factory = await loadPlugins([first, second], '0.0.0');
    expect(factory?.(engine, {}).map(({ definition }) => definition.name)).toEqual([
      'acme.one',
      'acme.two',
      'acme.three',
    ]);
  });

  it('loads nothing when no plugin is listed, and reports a listed file that is absent', async () => {
    expect(await loadPlugins([], '0.0.0')).toBeUndefined();
    const directory = await folder();
    const skipped: string[] = [];
    const factory = await loadPlugins([path.join(directory, 'absent.mjs')], '0.0.0', (file) =>
      skipped.push(path.basename(file)),
    );
    expect(factory).toBeUndefined();
    expect(skipped).toEqual(['absent.mjs']);
  });

  it('refuses a relative path, a wrong extension and a module without a factory', async () => {
    const directory = await folder();
    await expect(loadPlugins(['plugin.mjs'], '0.0.0')).rejects.toMatchObject({
      code: 'PLUGIN_PATH_INVALID',
    });
    const text = path.join(directory, 'plugin.txt');
    await writeFile(text, 'export default () => () => [];\n');
    await expect(loadPlugins([text], '0.0.0')).rejects.toBeInstanceOf(PluginError);
    const empty = path.join(directory, 'empty.mjs');
    await writeFile(empty, 'export const value = 1;\n');
    await expect(loadPlugins([empty], '0.0.0')).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('refuses a plugin reached through a link or inside a linked folder', async () => {
    const directory = await folder();
    const real = await plugin(directory, 'real.mjs', ['acme.real']);
    const link = path.join(directory, 'link.mjs');
    const linkedFolder = path.join(directory, 'linked');
    try {
      await symlink(real, link);
      await mkdir(path.join(directory, 'inner'));
      await symlink(path.join(directory, 'inner'), linkedFolder, 'junction');
    } catch {
      return; // The platform does not let this account create links.
    }
    await writeFile(
      path.join(directory, 'inner', 'plugin.mjs'),
      'export default () => () => [];\n',
    );
    await expect(loadPlugins([link], '0.0.0')).rejects.toMatchObject({
      code: 'PLUGIN_PATH_INVALID',
    });
    await expect(
      loadPlugins([path.join(linkedFolder, 'plugin.mjs')], '0.0.0'),
    ).rejects.toMatchObject({
      code: 'PLUGIN_PATH_INVALID',
    });
  });

  it('refuses reserved, malformed and duplicate tool names when the tools are built', async () => {
    const directory = await folder();
    for (const names of [['hoi4.echo'], ['plain'], ['Acme.echo'], ['acme.echo', 'acme.echo']]) {
      const file = await plugin(
        directory,
        `bad-${names.join('-').replaceAll('.', '_')}.mjs`,
        names,
      );
      const factory = await loadPlugins([file], '0.0.0');
      expect(() => factory?.(engine, {}), names.join(',')).toThrow(PluginError);
    }
  });

  it('keeps the host from importing anything outside the server modules', async () => {
    const directory = await folder();
    const file = path.join(directory, 'escape.mjs');
    await writeFile(
      file,
      `export default async function createPlugin(host) {
  await host.importServerModule('../../outside.js');
  return () => [];
}
`,
    );
    await expect(loadPlugins([file], '0.0.0')).rejects.toMatchObject({
      code: 'PLUGIN_IMPORT_REFUSED',
    });
  });

  it('accepts only absolute plugin paths in the configuration', () => {
    const base = { version: 1, workspaces: [] };
    expect(
      serverConfigurationSchema.safeParse({ ...base, plugins: ['relative/plugin.mjs'] }).success,
    ).toBe(false);
    expect(
      serverConfigurationSchema.safeParse({ ...base, plugins: [path.join(tmpdir(), 'p.mjs')] })
        .success,
    ).toBe(true);
    expect(serverConfigurationSchema.parse(base).plugins).toEqual([]);
  });
});
