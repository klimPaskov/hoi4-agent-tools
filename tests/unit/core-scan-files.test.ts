import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

async function fixture(): Promise<{ root: string; engine: CoreEngine; source: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-scan-files-'));
  const workspaceRoot = path.join(root, 'workspace');
  const source = path.join(workspaceRoot, 'history', 'states', '1-alpha.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'state = {\n\tid = 1\n\tname = "STATE_1"\n}\n', 'utf8');
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'server-state'),
    storageRoots: [path.join(root, 'artifacts'), path.join(root, 'cache')],
    workspaces: [
      {
        id: 'scan_files',
        name: 'Project-owned scan fixture',
        root: workspaceRoot,
        artifactRoot: path.join(root, 'artifacts'),
        cacheRoot: path.join(root, 'cache'),
      },
    ],
  });
  return { root, engine: new CoreEngine(await WorkspaceResolver.create(configuration)), source };
}

describe('CoreEngine.scanFiles', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('returns the same files and revision as scan without building the symbol index', async () => {
    const { root, engine } = await fixture();
    roots.push(root);
    const options = { patterns: ['history/states/*.txt'] };
    const build = vi.spyOn(SymbolIndex, 'buildAsync');

    const files = await engine.scanFiles('scan_files', options);
    expect(build).not.toHaveBeenCalled();
    expect(files.files.map(({ relativePath }) => relativePath)).toEqual([
      'history/states/1-alpha.txt',
    ]);
    expect(files).not.toHaveProperty('index');

    const indexed = await engine.scan('scan_files', options);
    expect(build).toHaveBeenCalledTimes(1);
    expect(indexed.revision).toBe(files.revision);
    expect(indexed.files.map(({ sha256 }) => sha256)).toEqual(
      files.files.map(({ sha256 }) => sha256),
    );
    // An indexed scan never answers from a files-only cache entry.
    expect(indexed.index.find('state', '1')).toBeDefined();
  });

  it('caches an unchanged files-only scan and invalidates it with the workspace', async () => {
    const { root, engine, source } = await fixture();
    roots.push(root);
    const options = { patterns: ['history/states/*.txt'] };
    const first = await engine.scanFiles('scan_files', options);
    expect(await engine.scanFiles('scan_files', options)).toBe(first);

    await writeFile(source, 'state = {\n\tid = 1\n\tname = "STATE_ONE"\n}\n', 'utf8');
    engine.invalidate('scan_files');
    const changed = await engine.scanFiles('scan_files', options);
    expect(changed).not.toBe(first);
    expect(changed.revision).not.toBe(first.revision);
  });
});
