import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import { PersistentAnalysisCache } from '../../src/hoi4_agent_tools/core/persistent-analysis-cache.js';
import { ServerState } from '../../src/hoi4_agent_tools/core/server-state.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hoi4-persistent-analysis-'));
  roots.push(root);
  const mod = path.join(root, 'mod');
  const source = path.join(mod, 'common', 'national_focus', 'tree.txt');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    'focus_tree = { id = persistent_tree focus = { id = persistent_focus x = 0 y = 0 } }\n',
  );
  const configuration = serverConfigurationSchema.parse({
    version: 1,
    serverStateRoot: path.join(root, 'state'),
    workspaces: [{ id: 'test', name: 'Persistent analysis fixture', root: mod }],
    http: {
      tokens: [
        { principal: 'alice', tokenEnv: 'UNUSED_ALICE_TOKEN', workspaceIds: ['test'] },
        { principal: 'bob', tokenEnv: 'UNUSED_BOB_TOKEN', workspaceIds: ['test'] },
      ],
      principals: [],
    },
  });
  const resolver = () => WorkspaceResolver.create(configuration);
  return { root, source, resolver };
}

function snapshotEvidence(snapshot: Awaited<ReturnType<CoreEngine['scan']>>): string {
  return canonicalJson({
    revision: snapshot.revision,
    symbols: snapshot.index.symbols,
    references: snapshot.index.references,
    diagnostics: snapshot.diagnostics,
    complete: snapshot.complete,
  });
}

async function analysisFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(target);
    }
  };
  await visit(path.join(root, 'state', 'analysis-cache'));
  return files.sort();
}

describe('persistent content-addressed analysis cache', () => {
  it('reopens exact parsed and indexed facts across independent engines', async () => {
    const { resolver } = await fixture();
    const first = new CoreEngine(await resolver());
    const expected = await first.scan('test');
    expect(await first.persistentAnalysisCacheStatistics()).toMatchObject({
      writes: 2,
      retainedEntries: 2,
    });
    first.releaseScanCaches();

    const reopened = new CoreEngine(await resolver());
    const actual = await reopened.scan('test');
    expect(snapshotEvidence(actual)).toBe(snapshotEvidence(expected));
    expect(reopened.indexSegments.statistics()).toMatchObject({ hits: 1, misses: 0 });
    expect(await reopened.persistentAnalysisCacheStatistics()).toMatchObject({
      hits: 2,
      invalidEntries: 0,
      writes: 0,
    });
  });

  it('reuses authenticated parsed and indexed facts in another process', async () => {
    const { root, resolver } = await fixture();
    const first = new CoreEngine(await resolver());
    const expected = await first.scan('test');
    first.releaseScanCaches();
    const worker = fileURLToPath(new URL('../fixtures/analysis-cache-worker.ts', import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), worker, root],
      { cwd: process.cwd(), windowsHide: true },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      revision: expected.revision,
      focusIds: ['persistent_focus'],
      index: { hits: 1, misses: 0 },
      persistent: { hits: 2, invalidEntries: 0, writes: 0 },
    });
  });

  it('does not reuse persistent entries across principal scopes', async () => {
    const { resolver } = await fixture();
    const alice = new CoreEngine(await resolver());
    await alice.scan('test', {}, 'alice');
    alice.releaseScanCaches();

    const bob = new CoreEngine(await resolver());
    await bob.scan('test', {}, 'bob');
    expect(bob.indexSegments.statistics()).toMatchObject({ hits: 0, misses: 1 });
    expect(await bob.persistentAnalysisCacheStatistics()).toMatchObject({ hits: 0, writes: 2 });

    bob.releaseScanCaches();
    const aliceAgain = new CoreEngine(await resolver());
    await aliceAgain.scan('test', {}, 'alice');
    expect(aliceAgain.indexSegments.statistics()).toMatchObject({ hits: 1, misses: 0 });
    expect(await aliceAgain.persistentAnalysisCacheStatistics()).toMatchObject({ hits: 2 });
  });

  it('ignores a tampered entry and rebuilds the same analysis from source', async () => {
    const { root, resolver } = await fixture();
    const first = new CoreEngine(await resolver());
    const expected = await first.scan('test');
    first.releaseScanCaches();
    const files = await analysisFiles(root);
    expect(files).toHaveLength(2);
    const indexFile = files.find((file) => file.includes(`${path.sep}index-segment${path.sep}`))!;
    const envelope = JSON.parse(await readFile(indexFile, 'utf8')) as { payload: string };
    envelope.payload = Buffer.from('not an index segment').toString('base64');
    await writeFile(indexFile, JSON.stringify(envelope));

    const reopened = new CoreEngine(await resolver());
    const actual = await reopened.scan('test');
    expect(snapshotEvidence(actual)).toBe(snapshotEvidence(expected));
    expect(reopened.indexSegments.statistics()).toMatchObject({ hits: 0, misses: 1 });
    expect(await reopened.persistentAnalysisCacheStatistics()).toMatchObject({ writes: 1 });
    expect((await reopened.persistentAnalysisCacheStatistics())!.invalidEntries).toBeGreaterThan(0);
    reopened.releaseScanCaches();

    const healed = new CoreEngine(await resolver());
    expect(snapshotEvidence(await healed.scan('test'))).toBe(snapshotEvidence(expected));
    expect(healed.indexSegments.statistics()).toMatchObject({ hits: 1, misses: 0 });
    expect(await healed.persistentAnalysisCacheStatistics()).toMatchObject({
      hits: 2,
      invalidEntries: 0,
      writes: 0,
    });
  });

  it('enforces a global retained-entry budget', async () => {
    const { root, resolver } = await fixture();
    const state = await ServerState.create(path.join(root, 'state'));
    const cache = await PersistentAnalysisCache.create(state, {
      maxBytes: 10_000_000,
      maxEntries: 1,
      maxSingleBytes: 1_000_000,
    });
    const engine = new CoreEngine(await resolver(), { persistentAnalysisCache: cache });
    const snapshot = await engine.scan('test');
    expect(cache.statistics()).toMatchObject({
      writes: 2,
      retainedEntries: 1,
      evictions: 1,
    });
    expect(await analysisFiles(root)).toHaveLength(1);
    expect(snapshot.index.find('focus', 'persistent_focus')).toBeDefined();
  });
});
