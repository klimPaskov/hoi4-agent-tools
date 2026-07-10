import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore, type ArtifactPage } from '../../src/hoi4_agent_tools/core/artifacts.js';
import { compareCodeUnits, sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { serverConfigurationSchema } from '../../src/hoi4_agent_tools/core/configuration.js';
import { CoreEngine } from '../../src/hoi4_agent_tools/core/engine.js';
import type { ArtifactLink } from '../../src/hoi4_agent_tools/core/result.js';
import type { ResolvedWorkspace } from '../../src/hoi4_agent_tools/core/workspace.js';
import { WorkspaceResolver } from '../../src/hoi4_agent_tools/core/workspace.js';
import { createMcpServer } from '../../src/hoi4_agent_tools/mcp/server/create.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).map((callback) => callback())));

class SyntheticInventoryStore extends ArtifactStore {
  readonly inventory: ArtifactLink[];

  constructor(count: number) {
    super();
    const contentHash = sha256Bytes('synthetic-artifact-content');
    this.inventory = Array.from({ length: count }, (_, index) => {
      const name = `artifact-${String(index).padStart(5, '0')}.json`;
      const provenanceHash = sha256Bytes(`provenance-${index}`);
      return {
        uri: `hoi4-agent://workspace/pagination/artifact/${contentHash}/${provenanceHash}/${name}`,
        name,
        mimeType: 'application/json',
        size: 64,
        sha256: contentHash,
      };
    }).sort((left, right) => compareCodeUnits(left.uri, right.uri));
  }

  override list(_workspace: ResolvedWorkspace, signal?: AbortSignal): Promise<ArtifactLink[]> {
    signal?.throwIfAborted();
    return Promise.resolve([...this.inventory]);
  }

  override listPage(
    _workspace: ResolvedWorkspace,
    options: { limit: number; afterUri?: string },
    signal?: AbortSignal,
  ): Promise<ArtifactPage> {
    signal?.throwIfAborted();
    const revision = createHash('sha256');
    for (const { uri } of this.inventory) {
      revision.update(String(Buffer.byteLength(uri, 'utf8')));
      revision.update(':');
      revision.update(uri, 'utf8');
    }
    const position =
      options.afterUri === undefined
        ? -1
        : this.inventory.findIndex(({ uri }) => uri === options.afterUri);
    const afterFound = options.afterUri === undefined || position >= 0;
    const start = afterFound ? position + 1 : this.inventory.length;
    const artifacts = this.inventory.slice(start, start + options.limit);
    return Promise.resolve({
      artifacts,
      total: this.inventory.length,
      revision: revision.digest('hex'),
      afterFound,
      hasMore: start + artifacts.length < this.inventory.length,
    });
  }
}

describe('MCP artifact inventory pagination', () => {
  it('keeps 5,001-artifact responses bounded and rejects stale cursors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hoi4-agent-pagination-'));
    const mod = path.join(root, 'mod');
    await mkdir(mod);
    const configuration = serverConfigurationSchema.parse({
      version: 1,
      workspaces: [{ id: 'pagination', name: 'Pagination', root: mod }],
    });
    const store = new SyntheticInventoryStore(5_001);
    const engine = new CoreEngine(await WorkspaceResolver.create(configuration), {
      artifacts: store,
    });
    const server = createMcpServer(engine);
    const client = new Client({ name: 'pagination-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    cleanup.push(
      async () => client.close(),
      async () => server.close(),
      async () => rm(root, { recursive: true, force: true }),
    );

    const first = await client.callTool({
      name: 'hoi4.artifact_list',
      arguments: { workspaceId: 'pagination' },
    });
    const firstResult = first.structuredContent as {
      status: string;
      artifacts: ArtifactLink[];
      data: { count: number; returned: number; nextCursor?: string };
    };
    expect(firstResult).toMatchObject({
      status: 'ok',
      data: { count: 5_001, returned: 100, nextCursor: expect.any(String) },
    });
    expect(firstResult.artifacts).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(firstResult), 'utf8')).toBeLessThan(100_000);

    const second = await client.callTool({
      name: 'hoi4.artifact_list',
      arguments: {
        workspaceId: 'pagination',
        limit: 100,
        cursor: firstResult.data.nextCursor,
      },
    });
    const secondResult = second.structuredContent as {
      status: string;
      artifacts: ArtifactLink[];
      data: { count: number; returned: number; nextCursor?: string };
    };
    expect(secondResult).toMatchObject({
      status: 'ok',
      data: { count: 5_001, returned: 100, nextCursor: expect.any(String) },
    });
    expect(
      new Set([...firstResult.artifacts, ...secondResult.artifacts].map(({ uri }) => uri)).size,
    ).toBe(200);

    store.inventory.push({
      uri: `hoi4-agent://workspace/pagination/artifact/${sha256Bytes('new')}/${sha256Bytes('new-provenance')}/new.json`,
      name: 'new.json',
      mimeType: 'application/json',
      size: 1,
      sha256: sha256Bytes('new'),
    });
    store.inventory.sort((left, right) => compareCodeUnits(left.uri, right.uri));
    const stale = await client.callTool({
      name: 'hoi4.artifact_list',
      arguments: {
        workspaceId: 'pagination',
        cursor: firstResult.data.nextCursor,
      },
    });
    expect(stale.structuredContent).toMatchObject({
      status: 'error',
      code: 'ARTIFACT_CURSOR_STALE',
    });
  });
});
