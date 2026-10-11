import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import {
  WorkspaceResolver,
  resolvedWorkspaceIdentity,
} from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe('descriptor changes while a server runs', () => {
  it('hides the folders a rewritten descriptor replaces from the next scan', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-descriptor-refresh-'));
    roots.push(base);
    const mod = path.join(base, 'mod');
    const game = path.join(base, 'game');
    await write(path.join(mod, 'descriptor.mod'), 'name="Before"\n');
    await write(path.join(mod, 'history', 'states', '1-NEW.txt'), 'state = { id = 1 }\n');
    await write(path.join(game, 'history', 'states', '1-OLD.txt'), 'state = { id = 1 }\n');
    const engine = new CoreEngine(
      await WorkspaceResolver.create(
        serverConfigurationSchema.parse({
          version: 1,
          serverStateRoot: path.join(base, 'state'),
          workspaces: [
            {
              id: 'test',
              name: 'Descriptor refresh',
              root: mod,
              gameRoot: game,
              includeGameDlc: false,
            },
          ],
        }),
      ),
    );
    const identity = resolvedWorkspaceIdentity(engine.resolver.get('test'));
    const states = async (): Promise<string[]> =>
      (await engine.scan('test', { patterns: ['history/states/*.txt'] })).files
        .filter(({ shadowedBy }) => shadowedBy === undefined)
        .map(({ displayPath }) => displayPath)
        .sort();

    expect(await states()).toEqual([
      'game:history/states/1-OLD.txt',
      'mod:history/states/1-NEW.txt',
    ]);

    // A world rewrite adds the replace path to the descriptor of a server that is already running.
    await writeFile(
      path.join(mod, 'descriptor.mod'),
      'name="After, a longer descriptor"\nreplace_path="history/states"\n',
    );
    expect(await states()).toEqual(['mod:history/states/1-NEW.txt']);
    // Jobs and transactions started before the rewrite still belong to the same workspace.
    expect(resolvedWorkspaceIdentity(engine.resolver.get('test'))).toBe(identity);
  });
});
