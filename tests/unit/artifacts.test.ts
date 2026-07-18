import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  boundedSourceHashEvidence,
  type ChunkedArtifactIndex,
} from '../../src/hoi4_agent_tools/core/artifacts.js';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-artifacts-'));
  const mod = path.join(base, 'mod');
  await mkdir(mod);
  const resolver = await WorkspaceResolver.create(
    serverConfigurationSchema.parse({
      version: 1,
      serverStateRoot: path.join(base, 'server-state'),
      workspaces: [{ id: 'test', name: 'Test', root: mod }],
    }),
  );
  return { store: new ArtifactStore(), workspace: resolver.get('test') };
}

describe('content-addressed artifacts', () => {
  it('bounds broad source-hash provenance while committing to the complete inventory', async () => {
    const complete = Object.fromEntries(
      Array.from({ length: 8_000 }, (_, index) => [
        `game:interface/generated/source-${String(index).padStart(5, '0')}-${'path'.repeat(24)}.gui`,
        sha256Bytes(`source-${index}`),
      ]),
    );
    const first = boundedSourceHashEvidence(complete);
    const reordered = boundedSourceHashEvidence(
      Object.fromEntries(Object.entries(complete).reverse()),
    );
    expect(first.inventory).toEqual(reordered.inventory);
    expect(first.sourceHashes).toEqual(reordered.sourceHashes);
    expect(first.inventory).toMatchObject({
      count: 8_000,
      retainedCount: 256,
      truncated: true,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Buffer.byteLength(JSON.stringify(first.sourceHashes), 'utf8')).toBeLessThanOrEqual(
      131_072,
    );

    const unicode = {
      'game:interface/e\u0301.gui': sha256Bytes('decomposed'),
      'game:interface/é.gui': sha256Bytes('composed'),
    };
    const unicodeFirst = boundedSourceHashEvidence(unicode);
    const unicodeReversed = boundedSourceHashEvidence(
      Object.fromEntries(Object.entries(unicode).reverse()),
    );
    expect(unicodeFirst).toEqual(unicodeReversed);

    const specialKeys = boundedSourceHashEvidence(
      Object.fromEntries([
        ['__proto__', sha256Bytes('prototype-key')],
        ['normal', sha256Bytes('normal-key')],
      ]),
    );
    expect(Object.hasOwn(specialKeys.sourceHashes, '__proto__')).toBe(true);
    expect(specialKeys.inventory).toMatchObject({
      count: 2,
      retainedCount: 2,
      truncated: false,
    });

    const { store, workspace } = await fixture();
    await expect(
      store.put(workspace, 'broad-provenance.json', 'application/json', '{}\n', {
        kind: 'broad-provenance-test',
        toolVersion: '0.1.0',
        schemaVersion: 'broad.v1',
        sourceHashes: first.sourceHashes,
        metadata: { sourceHashInventory: first.inventory },
      }),
    ).resolves.toMatchObject({ name: 'broad-provenance.json' });
  });

  it('rejects portable filenames that resolve to Windows device namespaces', async () => {
    const { store, workspace } = await fixture();
    await expect(
      store.put(workspace, 'CON.focus.svg', 'image/svg+xml', '<svg/>', {
        kind: 'portable-name-test',
        toolVersion: '0.1.0',
        schemaVersion: 'portable-name.v1',
        sourceHashes: {},
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NAME_INVALID' });
    const deviceUri = `hoi4-agent://workspace/test/artifact/${'a'.repeat(64)}/${'b'.repeat(64)}/AUX.json`;
    await expect(store.read(workspace, deviceUri)).rejects.toMatchObject({
      code: 'ARTIFACT_URI_INVALID',
    });
    await expect(
      store.put(workspace, 'bad-hash.json', 'application/json', '{}\n', {
        kind: 'invalid-provenance',
        toolVersion: '0.1.0',
        schemaVersion: 'invalid.v1',
        sourceHashes: { source: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PROVENANCE_INVALID' });
  });

  it('reserves the manifest namespace case-insensitively without breaking list or read', async () => {
    const { store, workspace } = await fixture();
    const provenance = {
      kind: 'manifest-name-test',
      toolVersion: '0.1.0',
      schemaVersion: 'manifest-name.v1',
      sourceHashes: {},
    };
    for (const name of ['payload.manifest.json', 'payload.MANIFEST.JSON']) {
      await expect(
        store.put(workspace, name, 'application/json', '{}\n', provenance),
      ).rejects.toMatchObject({ code: 'ARTIFACT_NAME_INVALID' });
    }

    const artifact = await store.put(
      workspace,
      'payload.json',
      'application/json',
      '{"safe":true}\n',
      provenance,
    );
    await expect(store.listPage(workspace, { limit: 100 })).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ uri: artifact.uri })],
      total: 1,
      afterFound: true,
      hasMore: false,
    });
    await expect(store.read(workspace, artifact.uri)).resolves.toMatchObject({
      bytes: Buffer.from('{"safe":true}\n'),
      mimeType: 'application/json',
    });
    for (const suffix of ['?offset=1', '#fragment']) {
      await expect(store.read(workspace, `${artifact.uri}${suffix}`)).rejects.toMatchObject({
        code: 'ARTIFACT_URI_INVALID',
      });
      await expect(store.describe(workspace, `${artifact.uri}${suffix}`)).rejects.toMatchObject({
        code: 'ARTIFACT_URI_INVALID',
      });
    }
  });

  it('is idempotent for identical provenance and preserves distinct provenance immutably', async () => {
    const { store, workspace } = await fixture();
    const provenance = {
      kind: 'test',
      toolVersion: '0.1.0',
      schemaVersion: 'test.v1',
      sourceHashes: { 'mod:source.txt': 'a'.repeat(64) },
    };
    const first = await store.put(
      workspace,
      'evidence.json',
      'application/json',
      '{}\n',
      provenance,
      'Immutable evidence',
    );
    const repeated = await store.put(
      workspace,
      'evidence.json',
      'application/json',
      '{}\n',
      provenance,
      'Immutable evidence',
    );
    expect(repeated.uri).toBe(first.uri);

    const distinct = await store.put(workspace, 'evidence.json', 'application/json', '{}\n', {
      ...provenance,
      sourceHashes: { 'mod:source.txt': 'b'.repeat(64) },
    });
    expect(distinct.uri).not.toBe(first.uri);
    expect(distinct.sha256).toBe(first.sha256);
    await expect(store.describe(workspace, first.uri)).resolves.toMatchObject({
      description: 'Immutable evidence',
      provenance,
    });
    await expect(store.describe(workspace, distinct.uri)).resolves.toMatchObject({
      provenance: { sourceHashes: { 'mod:source.txt': 'b'.repeat(64) } },
    });
    await expect(store.list(workspace)).resolves.toHaveLength(2);
  });

  it('rolls back only newly created batch artifacts when the commit callback fails', async () => {
    const { store, workspace } = await fixture();
    const provenance = {
      kind: 'batch-test',
      toolVersion: '0.1.0',
      schemaVersion: 'batch.v1',
      sourceHashes: {},
    };
    const retained = await store.put(
      workspace,
      'retained.json',
      'application/json',
      '{}\n',
      provenance,
    );
    let rejectedPath: string | undefined;

    await expect(
      store.withAtomicWrites(
        workspace,
        [
          {
            name: 'retained.json',
            mimeType: 'application/json',
            content: '{}\n',
            provenance,
          },
          {
            name: 'rejected.json',
            mimeType: 'application/json',
            content: '[]\n',
            provenance,
          },
        ],
        async (artifacts) => {
          rejectedPath = artifacts[1]?.path;
          throw new Error('journal admission rejected');
        },
      ),
    ).rejects.toThrow('journal admission rejected');
    if (rejectedPath === undefined) throw new Error('missing rejected artifact path');
    await expect(access(rejectedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.list(workspace)).resolves.toEqual([
      expect.objectContaining({ uri: retained.uri }),
    ]);
  });

  it('caps explicit ranges and rejects non-finite or unsafe range values', async () => {
    const { store, workspace } = await fixture();
    const bytes = Buffer.alloc(2_200_000, 7);
    const artifact = await store.put(workspace, 'large.bin', 'application/octet-stream', bytes, {
      kind: 'range-test',
      toolVersion: '0.1.0',
      schemaVersion: 'range.v1',
      sourceHashes: {},
    });
    await expect(
      store.read(workspace, artifact.uri, { offset: 100, length: 9_000_000 }),
    ).resolves.toMatchObject({ bytes: bytes.subarray(100, 100 + 1_048_576) });
    for (const range of [
      { offset: Number.NaN, length: 1 },
      { offset: -1, length: 1 },
      { offset: 0, length: Number.POSITIVE_INFINITY },
      { offset: 0, length: 0 },
    ]) {
      await expect(store.read(workspace, artifact.uri, range)).rejects.toMatchObject({
        code: 'ARTIFACT_RANGE_INVALID',
      });
    }
  });

  it('invalidates cached content verification when immutable file identity changes', async () => {
    const { store, workspace } = await fixture();
    const artifact = await store.put(
      workspace,
      'identity.bin',
      'application/octet-stream',
      Buffer.from('trusted-content'),
      {
        kind: 'identity-test',
        toolVersion: '0.1.0',
        schemaVersion: 'identity.v1',
        sourceHashes: {},
      },
    );
    await expect(
      store.read(workspace, artifact.uri, { offset: 0, length: 4 }),
    ).resolves.toMatchObject({
      bytes: Buffer.from('trus'),
    });
    const original = await stat(artifact.path);
    await writeFile(artifact.path, Buffer.from('hostile-content'));
    await utimes(artifact.path, original.atime, original.mtime);
    await expect(
      store.read(workspace, artifact.uri, { offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
  });

  it('enforces per-artifact and aggregate-byte budgets while expiring old entries atomically', async () => {
    const { workspace } = await fixture();
    const provenance = {
      kind: 'quota-test',
      toolVersion: '0.1.0',
      schemaVersion: 'quota.v1',
      sourceHashes: {},
    };
    await expect(
      new ArtifactStore(10_000, 10, 100).put(
        workspace,
        'oversized.bin',
        'application/octet-stream',
        Buffer.alloc(101),
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_SINGLE_LIMIT' });

    const byteRoot = await fixture();
    await expect(
      new ArtifactStore(300, 10, 10_000).put(
        byteRoot.workspace,
        'byte-budget.bin',
        'application/octet-stream',
        Buffer.alloc(200),
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_LIMIT' });

    const entryRoot = await fixture();
    const entryLimited = new ArtifactStore(100_000, 1, 10_000);
    const first = await entryLimited.put(
      entryRoot.workspace,
      'first.json',
      'application/json',
      '{}\n',
      provenance,
    );
    const second = await entryLimited.put(
      entryRoot.workspace,
      'second.json',
      'application/json',
      '[]\n',
      provenance,
    );
    await expect(entryLimited.list(entryRoot.workspace)).resolves.toHaveLength(1);
    await expect(entryLimited.read(entryRoot.workspace, first.uri)).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_FOUND',
    });
    await expect(entryLimited.read(entryRoot.workspace, second.uri)).resolves.toMatchObject({
      name: 'second.json',
    });
  });

  it('rejects a generated artifact shard that escapes through a symlink or junction', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-artifact-containment-'));
    const mod = path.join(base, 'mod');
    const outside = path.join(base, 'outside');
    await Promise.all([mkdir(mod), mkdir(outside)]);
    const resolver = await WorkspaceResolver.create(
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'server-state'),
        workspaces: [{ id: 'test', name: 'Test', root: mod }],
      }),
    );
    const workspace = resolver.get('test');
    const content = Buffer.from('must remain contained');
    const sha256 = sha256Bytes(content);
    try {
      await symlink(
        outside,
        path.join(workspace.artifactRoot, sha256.slice(0, 2)),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    await expect(
      new ArtifactStore().put(workspace, 'escape-proof.bin', 'application/octet-stream', content, {
        kind: 'containment-test',
        toolVersion: '0.1.0',
        schemaVersion: 'containment.v1',
        sourceHashes: {},
      }),
    ).rejects.toMatchObject({ code: 'PATH_GENERATED_ROOT_ESCAPE' });
    await expect(access(path.join(outside, sha256, 'escape-proof.bin'))).rejects.toThrow();
  });

  it('binds every artifact operation to the canonical workspace and shared configured owner', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hoi4-agent-artifact-binding-'));
    const firstMod = path.join(base, 'first-mod');
    const secondMod = path.join(base, 'second-mod');
    const storage = path.join(base, 'storage');
    const artifactRoot = path.join(storage, 'artifacts');
    const cacheRoot = path.join(storage, 'cache');
    await Promise.all([mkdir(firstMod), mkdir(secondMod)]);
    const configured = (root: string) =>
      serverConfigurationSchema.parse({
        version: 1,
        serverStateRoot: path.join(base, 'server-state'),
        storageRoots: [storage],
        workspaces: [
          {
            id: 'shared',
            name: 'Shared',
            root,
            artifactRoot,
            cacheRoot,
          },
        ],
        http: {
          principals: [
            { principal: 'alice', workspaceIds: ['shared'] },
            { principal: 'bob', workspaceIds: ['shared'] },
          ],
        },
      });
    const firstResolver = await WorkspaceResolver.create(configured(firstMod));
    const aliceWorkspace = firstResolver.get('shared', 'alice');
    const bobWorkspace = firstResolver.get('shared', 'bob');
    const store = new ArtifactStore();
    const artifact = await store.put(
      aliceWorkspace,
      'bound.json',
      'application/json',
      '{"private":true}\n',
      {
        kind: 'binding-test',
        toolVersion: '0.1.0',
        schemaVersion: 'binding.v1',
        sourceHashes: {},
      },
    );

    await expect(store.list(bobWorkspace)).resolves.toHaveLength(1);
    await expect(store.describe(bobWorkspace, artifact.uri)).resolves.toMatchObject({
      uri: artifact.uri,
    });
    await expect(store.read(bobWorkspace, artifact.uri)).resolves.toMatchObject({
      bytes: Buffer.from('{"private":true}\n'),
    });

    const reusedPhysicalStore = (await WorkspaceResolver.create(configured(secondMod))).get(
      'shared',
    );
    await expect(store.list(reusedPhysicalStore)).rejects.toMatchObject({
      code: 'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
    });
    await expect(store.describe(reusedPhysicalStore, artifact.uri)).rejects.toMatchObject({
      code: 'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
    });
    await expect(store.read(reusedPhysicalStore, artifact.uri)).rejects.toMatchObject({
      code: 'ARTIFACT_MANIFEST_INTEGRITY_FAILED',
    });
  });

  it('honors cancellation while enumerating and verifying artifacts', async () => {
    const { store, workspace } = await fixture();
    const artifact = await store.put(
      workspace,
      'cancel.bin',
      'application/octet-stream',
      Buffer.alloc(2_000_000, 1),
      {
        kind: 'cancellation-test',
        toolVersion: '0.1.0',
        schemaVersion: 'cancellation.v1',
        sourceHashes: {},
      },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(store.list(workspace, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(store.describe(workspace, artifact.uri, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      new ArtifactStore().read(workspace, artifact.uri, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels an in-flight artifact batch and removes every partial write', async () => {
    const { store, workspace } = await fixture();
    const controller = new AbortController();
    let commitCalled = false;
    const pending = store.withAtomicWrites(
      workspace,
      Array.from({ length: 200 }, (_, index) => ({
        name: `cancel-batch-${String(index).padStart(3, '0')}.bin`,
        mimeType: 'application/octet-stream',
        content: Buffer.alloc(32_768, index),
        provenance: {
          kind: 'mid-flight-cancellation-test',
          toolVersion: '0.1.0',
          schemaVersion: 'cancellation.v1',
          sourceHashes: {},
        },
      })),
      () => {
        commitCalled = true;
        return Promise.resolve();
      },
      controller.signal,
    );
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(commitCalled).toBe(false);
    await expect(store.list(workspace)).resolves.toEqual([]);
  });

  it('keeps an aborted waiter in the queue chain until the active commit settles', async () => {
    const { store, workspace } = await fixture();
    const provenance = {
      kind: 'queue-cancellation-test',
      toolVersion: '0.1.0',
      schemaVersion: 'queue.v1',
      sourceHashes: {},
    };
    let failFirst!: (error: Error) => void;
    const firstCommit = new Promise<Error>((resolve) => {
      failFirst = resolve;
    });
    const first = store.withAtomicWrites(
      workspace,
      [
        {
          name: 'queue-owner.json',
          mimeType: 'application/json',
          content: '{}\n',
          provenance,
        },
      ],
      async () => {
        throw await firstCommit;
      },
    );
    let firstError: unknown;
    const observedFirst = first.catch((error: unknown) => {
      firstError = error;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const controller = new AbortController();
    const queued = store.put(
      workspace,
      'queued.json',
      'application/json',
      '{}\n',
      provenance,
      undefined,
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });

    let thirdCommitted = false;
    const third = store.withAtomicWrites(
      workspace,
      [
        {
          name: 'queue-owner.json',
          mimeType: 'application/json',
          content: '{}\n',
          provenance,
        },
      ],
      ([artifact]) => {
        thirdCommitted = true;
        if (artifact === undefined) throw new Error('missing third artifact');
        return Promise.resolve(artifact);
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(thirdCommitted).toBe(false);

    failFirst(new Error('reject active commit'));
    await observedFirst;
    expect(firstError).toEqual(expect.objectContaining({ message: 'reject active commit' }));
    const artifact = await third;
    expect(thirdCommitted).toBe(true);
    await expect(store.read(workspace, artifact.uri)).resolves.toMatchObject({
      bytes: Buffer.from('{}\n'),
    });
    await expect(store.list(workspace)).resolves.toEqual([
      expect.objectContaining({ uri: artifact.uri, name: 'queue-owner.json' }),
    ]);
  });

  it('refuses an oversized planted artifact manifest before parsing it', async () => {
    const { store, workspace } = await fixture();
    const artifact = await store.put(workspace, 'bounded.json', 'application/json', '{}\n', {
      kind: 'manifest-limit-test',
      toolVersion: '0.1.0',
      schemaVersion: 'manifest-limit.v1',
      sourceHashes: {},
    });
    const manifestPath = path.join(
      path.dirname(artifact.path),
      `${artifact.name}.${artifact.provenanceHash}.manifest.json`,
    );
    const validManifest = await readFile(manifestPath);
    await writeFile(
      manifestPath,
      Buffer.concat([validManifest, Buffer.alloc(1_048_577 - validManifest.length, 0x20)]),
    );
    await expect(store.describe(workspace, artifact.uri)).rejects.toMatchObject({
      code: 'ARTIFACT_MANIFEST_LIMIT',
    });
  });

  it('streams stable artifact pages without retaining the complete inventory', async () => {
    const { store, workspace } = await fixture();
    const provenance = {
      kind: 'page-test',
      toolVersion: '0.1.0',
      schemaVersion: 'page.v1',
      sourceHashes: {},
    };
    await store.withAtomicWrites(
      workspace,
      Array.from({ length: 105 }, (_, index) => ({
        name: `page-${String(index).padStart(3, '0')}.json`,
        mimeType: 'application/json',
        content: '{}\n',
        provenance,
      })),
      () => Promise.resolve(),
    );
    const first = await store.listPage(workspace, { limit: 100 });
    expect(first).toMatchObject({ total: 105, afterFound: true, hasMore: true });
    expect(first.artifacts).toHaveLength(100);
    const afterUri = first.artifacts.at(-1)?.uri;
    if (afterUri === undefined) throw new Error('missing artifact cursor URI');
    const second = await store.listPage(workspace, { limit: 100, afterUri });
    expect(second).toMatchObject({
      total: 105,
      revision: first.revision,
      afterFound: true,
      hasMore: false,
    });
    expect(second.artifacts).toHaveLength(5);
    await expect(
      store.listPage(workspace, {
        limit: 100,
        afterUri: 'hoi4-agent://workspace/test/artifact/missing',
      }),
    ).resolves.toMatchObject({ afterFound: false, artifacts: [] });
    await expect(store.listPage(workspace, { limit: 101 })).rejects.toMatchObject({
      code: 'ARTIFACT_PAGE_INVALID',
    });
  });

  it('stores oversized logical content as a deterministic byte-exact chunk index', async () => {
    const { workspace } = await fixture();
    const store = new ArtifactStore(1_000_000, 100, 16_384);
    const bytes = Buffer.from('alpha🙂漢字omega\n'.repeat(4_000), 'utf8');
    const provenance = {
      kind: 'chunked-exactness-test',
      toolVersion: '0.1.0',
      schemaVersion: 'chunked.v1',
      sourceHashes: { source: sha256Bytes('source') },
    };

    const first = await store.putChunked(
      workspace,
      'large-source-graph.json',
      'application/json',
      bytes,
      provenance,
      'Complete source graph',
    );
    expect(first.name).toMatch(/^large-source-graph\.json\.[a-f0-9]{16}\.chunks\.json$/u);
    expect(first.mimeType).toBe('application/json');
    const indexRead = await store.read(workspace, first.uri);
    const index = JSON.parse(indexRead.bytes.toString('utf8')) as ChunkedArtifactIndex;
    expect(index).toMatchObject({
      schemaVersion: 1,
      type: 'hoi4-agent.chunked-artifact',
      original: {
        name: 'large-source-graph.json',
        mimeType: 'application/json',
        size: bytes.length,
        sha256: sha256Bytes(bytes),
        description: 'Complete source graph',
      },
    });
    expect(index.chunks.length).toBeGreaterThan(1);

    const reconstructed: Buffer[] = [];
    let expectedOffset = 0;
    for (const [chunkIndex, chunk] of index.chunks.entries()) {
      expect(chunk).toMatchObject({
        index: chunkIndex,
        offset: expectedOffset,
        length: chunk.size,
        mimeType: 'application/octet-stream',
      });
      const read = await store.read(workspace, chunk.uri);
      expect(read.bytes).toHaveLength(chunk.length);
      expect(sha256Bytes(read.bytes)).toBe(chunk.sha256);
      reconstructed.push(read.bytes);
      expectedOffset += chunk.length;
    }
    expect(expectedOffset).toBe(bytes.length);
    expect(Buffer.concat(reconstructed)).toEqual(bytes);

    const repeated = await store.putChunked(
      workspace,
      'large-source-graph.json',
      'application/json',
      bytes,
      provenance,
      'Complete source graph',
    );
    expect(repeated.uri).toBe(first.uri);
    await expect(store.list(workspace)).resolves.toHaveLength(index.chunks.length + 1);
  });

  it('rolls back every chunk and index when a logical batch commit fails or is cancelled', async () => {
    const { workspace } = await fixture();
    const store = new ArtifactStore(1_000_000, 100, 16_384);
    const write = {
      name: 'rollback-large.json',
      mimeType: 'application/json',
      content: Buffer.alloc(50_000, 0x61),
      provenance: {
        kind: 'chunked-rollback-test',
        toolVersion: '0.1.0',
        schemaVersion: 'chunked.v1',
        sourceHashes: {},
      },
    };
    const smallWrite = {
      ...write,
      name: 'rollback-small.json',
      content: '{}\n',
    };
    await expect(
      store.withAtomicChunkedWrites(workspace, [smallWrite, write], () =>
        Promise.reject(new Error('reject logical commit')),
      ),
    ).rejects.toThrow('reject logical commit');
    await expect(store.list(workspace)).resolves.toEqual([]);

    const controller = new AbortController();
    const cancellationStore = new ArtifactStore(50_000_000, 100, 8_000_000);
    let cancellationCommitCalled = false;
    const pending = cancellationStore.withAtomicChunkedWrites(
      workspace,
      [{ ...write, name: 'cancel-during-hash.json', content: Buffer.alloc(20_000_000, 0x63) }],
      () => {
        cancellationCommitCalled = true;
        return Promise.resolve();
      },
      controller.signal,
    );
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancellationCommitCalled).toBe(false);
    await expect(cancellationStore.list(workspace)).resolves.toEqual([]);
  });

  it('keeps aggregate, entry, single-object, and index ceilings fail-closed for chunked writes', async () => {
    const { workspace } = await fixture();
    const provenance = {
      kind: 'chunked-limit-test',
      toolVersion: '0.1.0',
      schemaVersion: 'chunked.v1',
      sourceHashes: {},
    };
    const content = Buffer.alloc(50_000, 0x62);

    await expect(
      new ArtifactStore(1_000_000_000, 100, 16_384).putChunked(
        workspace,
        'logical-batch.json',
        'application/json',
        { byteLength: 536_870_913 } as Uint8Array,
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_LOGICAL_BATCH_LIMIT' });

    await expect(
      new ArtifactStore(40_000, 100, 16_384).putChunked(
        workspace,
        'aggregate.json',
        'application/json',
        content,
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_LIMIT' });
    await expect(
      new ArtifactStore(1_000_000, 2, 16_384).putChunked(
        workspace,
        'entries.json',
        'application/json',
        content,
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_LIMIT' });
    await expect(
      new ArtifactStore(10_000, 100, 256).putChunked(
        workspace,
        'index.json',
        'application/json',
        Buffer.alloc(700, 0x63),
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CHUNK_INDEX_LIMIT' });
    await expect(
      new ArtifactStore(1_000_000, 100, 16_384).put(
        workspace,
        'direct.json',
        'application/json',
        content,
        provenance,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_SINGLE_LIMIT' });
  });

  it('admits complete batches before copying or hashing and yields during broad preflight', async () => {
    const { workspace } = await fixture();
    const provenance = {
      kind: 'batch-preflight-test',
      toolVersion: '0.1.0',
      schemaVersion: 'batch-preflight.v1',
      sourceHashes: {},
    };
    const poison = { byteLength: 300_000_000 } as Uint8Array;
    const oversizedWrites = ['first.json', 'second.json'].map((name) => ({
      name,
      mimeType: 'application/json',
      content: poison,
      provenance,
    }));
    const broadStore = new ArtifactStore(1_000_000_000, 100, 400_000_000);
    await expect(
      broadStore.withAtomicChunkedWrites(workspace, oversizedWrites, () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'ARTIFACT_LOGICAL_BATCH_LIMIT' });
    await expect(
      broadStore.withAtomicWrites(workspace, oversizedWrites, () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'ARTIFACT_LOGICAL_BATCH_LIMIT' });

    const entryStore = new ArtifactStore(1_000_000, 3, 16_384);
    await expect(
      entryStore.withAtomicChunkedWrites(
        workspace,
        ['one.json', 'two.json'].map((name) => ({
          name,
          mimeType: 'application/json',
          content: Buffer.alloc(20_000),
          provenance,
        })),
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_LIMIT' });

    const controller = new AbortController();
    let commitCalled = false;
    const preflightWrites = Array.from({ length: 1_024 }, (_, index) => ({
      name: `preflight-${String(index).padStart(4, '0')}.json`,
      mimeType: 'application/json',
      content: { byteLength: 1 } as Uint8Array,
      provenance,
    }));
    const pending = new ArtifactStore(10_000_000, 2_000, 1_000_000).withAtomicWrites(
      workspace,
      preflightWrites,
      () => {
        commitCalled = true;
        return Promise.resolve();
      },
      controller.signal,
    );
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(commitCalled).toBe(false);
  });
});
