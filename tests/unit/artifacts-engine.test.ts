import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactsAvailable,
  commitArtifacts,
  describeArtifact,
  listArtifacts,
  putArtifacts,
  readArtifact,
  readLogicalArtifact,
  releaseArtifacts,
  unifiedTextDiffOnEngine,
  type EngineArtifactWrite,
  type EngineStoreWorkspace,
} from '../../src/hoi4_agent_tools/core/artifacts-engine.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import {
  ResidentEngine,
  replaceSharedResidentEngine,
} from '../../src/hoi4_agent_tools/core/resident-engine.js';

// ADR 0091, packet P3: the typed adapter of the engine's artifact operations, run against the real
// engine (`HOI4_ENGINE`, which CI builds) the way txn-engine.test.ts runs the rewrite journal.
const engineAvailable = process.env.HOI4_ENGINE !== undefined;

const roots: string[] = [];
afterEach(async () => {
  replaceSharedResidentEngine(undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<EngineStoreWorkspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-artifacts-engine-'));
  roots.push(base);
  const artifactRoot = path.join(base, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  return {
    id: 'adapter',
    artifactRoot,
    workspaceIdentity: sha256Bytes('adapter-workspace'),
    ownerIdentity: sha256Bytes('adapter-owner'),
  };
}

function write(name: string, text: string): EngineArtifactWrite {
  return {
    name,
    mimeType: 'text/plain',
    content: Buffer.from(text),
    provenance: { kind: 'test', toolVersion: '1', schemaVersion: '1', sourceHashes: {} },
  };
}

async function errorCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe.skipIf(!engineAvailable)('the artifact adapter against the engine', () => {
  it('stores, reads, lists, describes, checks, commits and releases', async () => {
    const ws = await workspace();
    const put = await putArtifacts(ws, [write('a.txt', 'hello world'), write('b.txt', 'second')]);
    expect(put.artifacts.map((artifact) => artifact.name)).toEqual(['a.txt', 'b.txt']);
    expect(put.created.batch).toEqual(expect.any(String));
    const first = put.artifacts[0]!;
    expect(first.sha256).toBe(sha256Bytes('hello world'));
    const whole = await readArtifact(ws, first.uri);
    expect(whole.bytes.toString()).toBe('hello world');
    expect(whole.totalSize).toBe(11);
    expect((await readArtifact(ws, first.uri, { offset: 6, length: 5 })).bytes.toString()).toBe(
      'world',
    );
    expect((await listArtifacts(ws)).map((link) => link.name).sort()).toEqual(['a.txt', 'b.txt']);
    expect((await describeArtifact(ws, first.uri)).provenanceHash).toBe(first.provenanceHash);
    expect(await artifactsAvailable(ws, [first.uri, put.artifacts[1]!.uri])).toBe(true);

    // A caller that commits keeps its artifacts; one whose commit failed takes them back.
    await commitArtifacts(ws, put.created);
    expect(await artifactsAvailable(ws, [first.uri])).toBe(true);
    const doomed = await putArtifacts(ws, [write('c.txt', 'rolled back')]);
    await releaseArtifacts(ws, doomed.created);
    expect(await errorCode(readArtifact(ws, doomed.artifacts[0]!.uri))).toBe('ARTIFACT_NOT_FOUND');
    expect(await artifactsAvailable(ws, [first.uri])).toBe(true);
  });

  it('keeps a file another put reused when the first put is released', async () => {
    const ws = await workspace();
    const first = await putArtifacts(ws, [write('shared.txt', 'same bytes')]);
    const second = await putArtifacts(ws, [write('shared.txt', 'same bytes')]);
    expect(second.created.targets).toEqual([]);
    await releaseArtifacts(ws, first.created);
    expect((await readArtifact(ws, second.artifacts[0]!.uri)).bytes.toString()).toBe('same bytes');
    await commitArtifacts(ws, second.created);
  });

  it('refuses a replaced file with the same size and modification time', async () => {
    const ws = await workspace();
    const put = await putArtifacts(ws, [write('a.txt', 'hello')]);
    const artifact = put.artifacts[0]!;
    expect((await readArtifact(ws, artifact.uri)).bytes.toString()).toBe('hello');
    const modified = (await stat(artifact.path)).mtime;
    const replacement = `${artifact.path}.replacement`;
    await writeFile(replacement, 'HELLO');
    await utimes(replacement, modified, modified);
    await rename(replacement, artifact.path);
    expect(await errorCode(readArtifact(ws, artifact.uri))).toBe('ARTIFACT_INTEGRITY_FAILED');
  });

  it('asks again for the pins when a commit changed them meanwhile', async () => {
    const ws = await workspace();
    const limits = { maxEntries: 2 };
    const old = await putArtifacts(ws, [write('old', '1')], { limits });
    await commitArtifacts(ws, old.created, limits);
    const pending = await putArtifacts(ws, [write('pending', '2')], { limits });
    let reads = 0;
    const put = await putArtifacts(ws, [write('new-a', '3'), write('new-b', '4')], {
      limits,
      retention: async () => {
        reads += 1;
        // The caller's own commit lands while it reads its pins: the first list is already stale.
        if (reads === 1) await commitArtifacts(ws, pending.created, limits);
        return [];
      },
    });
    expect(reads).toBe(2);
    expect(put.artifacts).toHaveLength(2);
  });

  it('holds an uncommitted put against eviction', async () => {
    const ws = await workspace();
    const limits = { maxEntries: 2 };
    const held = await putArtifacts(ws, [write('held', '1')], { limits });
    expect(
      await errorCode(
        putArtifacts(ws, [write('x', '2'), write('y', '3')], { limits, retention: async () => [] }),
      ),
    ).toBe('ARTIFACT_STORAGE_LIMIT');
    expect(await artifactsAvailable(ws, [held.artifacts[0]!.uri], limits)).toBe(true);
  });

  it('chunks and reads back a logical artifact', async () => {
    const ws = await workspace();
    const limits = { maxSingleBytes: 2000, maxBytes: 1_000_000 };
    const content = Buffer.alloc(5000, 7);
    const put = await putArtifacts(
      ws,
      [{ ...write('big.json', ''), mimeType: 'application/json', content }],
      { chunked: true, limits },
    );
    expect(put.physical).toHaveLength(4);
    const logical = await readLogicalArtifact(
      ws,
      put.artifacts[0]!.uri,
      { mimeType: 'application/json', maxBytes: 10_000, maxChunks: 10 },
      limits,
    );
    expect(logical.bytes.equals(content)).toBe(true);
  });

  it('carries a diff larger than a response header in the payload', async () => {
    const lines = Array.from({ length: 60_000 }, (_, index) => `line number ${index}`);
    const before = `${lines.join('\n')}\n`;
    const after = before.replace('line number 30000\n', 'changed\n');
    const diff = await unifiedTextDiffOnEngine(before, after, 'a/file', 'b/file');
    expect(Buffer.byteLength(diff)).toBeGreaterThan(1_048_576);
    expect(diff).toContain('-line number 30000');
    expect(diff).toContain('+changed');
  });
});

describe('a missing engine', () => {
  it('answers ENGINE_UNAVAILABLE instead of falling back', async () => {
    const missing = path.join(tmpdir(), 'hoi4-no-such-engine', 'hoi4-engine');
    replaceSharedResidentEngine(
      new ResidentEngine({ env: { ...process.env, HOI4_ENGINE: missing } }),
    );
    const ws = await workspace();
    expect(await errorCode(putArtifacts(ws, [write('a.txt', 'x')]))).toBe('ENGINE_UNAVAILABLE');
    expect(await errorCode(listArtifacts(ws))).toBe('ENGINE_UNAVAILABLE');
    expect(await errorCode(unifiedTextDiffOnEngine('a\n', 'b\n', 'a', 'b'))).toBe(
      'ENGINE_UNAVAILABLE',
    );
  });
});
